const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http') as typeof import('node:http');
const https = require('node:https') as typeof import('node:https');
const { EventEmitter, once } = require('node:events') as typeof import('node:events');
const timeSource = require('./time-source') as typeof import('./time-source');

const {
  createSimbriefRequestLimiter,
  startHttpServer,
} = require('./http-server') as typeof import('./http-server');

class FakeOutgoingRequest extends EventEmitter {
  destroyed = false;

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

class FakeIncomingResponse extends EventEmitter {
  complete = false;
  statusCode: number;

  constructor(statusCode: number) {
    super();
    this.statusCode = statusCode;
  }
}

type PendingUpstream = {
  request: FakeOutgoingRequest;
  url: string;
  options: { timeout?: number };
  openResponse: (statusCode?: number) => FakeIncomingResponse;
  respondJson: (statusCode: number, payload: unknown) => void;
};

function installFakeHttps(): {
  pending: PendingUpstream[];
  restore: () => void;
} {
  const pending: PendingUpstream[] = [];
  const originalGet = https.get;

  (https as any).get = (
    url: string,
    options: { timeout?: number },
    callback: (response: FakeIncomingResponse) => void,
  ) => {
    const request = new FakeOutgoingRequest();
    let responseOpened = false;
    const openResponse = (statusCode = 200): FakeIncomingResponse => {
      assert.equal(responseOpened, false, 'fixture response should be opened only once');
      responseOpened = true;
      const response = new FakeIncomingResponse(statusCode);
      callback(response);
      return response;
    };
    pending.push({
      request,
      url: String(url),
      options,
      openResponse,
      respondJson(statusCode, payload) {
        const response = openResponse(statusCode);
        response.emit('data', Buffer.from(JSON.stringify(payload)));
        response.complete = true;
        response.emit('end');
        response.emit('close');
      },
    });
    return request;
  };

  return {
    pending,
    restore() {
      (https as any).get = originalGet;
    },
  };
}

function requireLease(result: ReturnType<ReturnType<typeof createSimbriefRequestLimiter>['acquire']>) {
  assert.equal(result.allowed, true);
  if (result.allowed === false) throw new Error(result.error);
  return result;
}

function requireRejection(result: ReturnType<ReturnType<typeof createSimbriefRequestLimiter>['acquire']>) {
  assert.equal(result.allowed, false);
  if (result.allowed === true) throw new Error('expected limiter rejection');
  return result;
}

function requestText(port: number, pathname: string): Promise<{
  statusCode: number | undefined;
  headers: import('node:http').IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: 'GET',
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.once('end', () => {
        resolve({ statusCode: response.statusCode, headers: response.headers, body });
      });
    });
    request.once('error', reject);
    request.end();
  });
}

function openAbortableRequest(port: number, pathname: string): {
  request: import('node:http').ClientRequest;
  settled: Promise<void>;
} {
  let request: import('node:http').ClientRequest;
  const settled = new Promise<void>((resolve) => {
    request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: 'GET',
    }, (response) => {
      response.resume();
      response.once('end', resolve);
      response.once('error', resolve);
    });
    request.once('error', () => resolve());
    request.end();
  });
  return { request: request!, settled };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = timeSource.now() + 2_000;
  while (!predicate()) {
    if (timeSource.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function startTestServer(): Promise<{
  server: import('node:http').Server;
  port: number;
}> {
  const { httpServer: server } = startHttpServer({
    wsPort: 9199,
    httpPort: 0,
    remoteAccessEnable: false,
    Debug: { log() {} },
  });
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test HTTP server did not bind a TCP port');
  return { server, port: address.port };
}

async function closeServer(server: import('node:http').Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

test('SimBrief limiter reserves usernames before I/O and cooldowns failed attempts', () => {
  let now = 1_000;
  const limiter = createSimbriefRequestLimiter({
    now: () => now,
    cooldownMs: 30_000,
    retentionMs: 60_000,
    maxKeys: 20,
    maxInFlight: 8,
    maxInFlightPerClient: 2,
  });

  const first = requireLease(limiter.acquire('pilot', '127.0.0.1'));
  const duplicate = requireRejection(limiter.acquire('pilot', '127.0.0.1'));
  assert.equal(duplicate.statusCode, 429);
  assert.match(duplicate.error, /already in progress/i);

  first.release();
  first.release();
  const afterFailure = requireRejection(limiter.acquire('pilot', '127.0.0.1'));
  assert.equal(afterFailure.statusCode, 429);
  assert.equal(afterFailure.retryAfterSeconds, 30);

  now += 30_000;
  const afterCooldown = requireLease(limiter.acquire('pilot', '127.0.0.1'));
  afterCooldown.release();
});

test('SimBrief limiter enforces normalized per-client and global concurrency caps', () => {
  const perClientLimiter = createSimbriefRequestLimiter({
    now: () => 1_000,
    maxInFlight: 8,
    maxInFlightPerClient: 2,
  });
  const first = requireLease(perClientLimiter.acquire('one', '127.0.0.1'));
  const second = requireLease(perClientLimiter.acquire('two', '::ffff:127.0.0.1'));
  const third = requireRejection(perClientLimiter.acquire('three', '127.0.0.1'));
  assert.equal(third.statusCode, 429);
  assert.match(third.error, /from this client/i);

  first.release();
  first.release();
  const afterRelease = requireLease(perClientLimiter.acquire('three', '127.0.0.1'));
  second.release();
  afterRelease.release();

  const globalLimiter = createSimbriefRequestLimiter({
    now: () => 1_000,
    maxInFlight: 3,
    maxInFlightPerClient: 3,
  });
  const leases = [
    requireLease(globalLimiter.acquire('a', '10.0.0.1')),
    requireLease(globalLimiter.acquire('b', '10.0.0.2')),
    requireLease(globalLimiter.acquire('c', '10.0.0.3')),
  ];
  const busy = requireRejection(globalLimiter.acquire('d', '10.0.0.4'));
  assert.equal(busy.statusCode, 503);
  leases[0].release();
  requireLease(globalLimiter.acquire('d', '10.0.0.4')).release();
  leases.slice(1).forEach((lease) => lease.release());
});

test('SimBrief limiter bounds accepted upstream attempts over time', () => {
  let now = 1_000;
  const limiter = createSimbriefRequestLimiter({
    now: () => now,
    cooldownMs: 30_000,
    maxInFlight: 8,
    maxInFlightPerClient: 8,
    attemptWindowMs: 60_000,
    maxAttemptsPerWindow: 3,
    maxAttemptsPerClientWindow: 2,
  });

  requireLease(limiter.acquire('one', '10.0.0.1')).release();
  requireLease(limiter.acquire('two', '10.0.0.1')).release();
  const perClientRate = requireRejection(limiter.acquire('three', '10.0.0.1'));
  assert.equal(perClientRate.statusCode, 429);
  assert.equal(perClientRate.retryAfterSeconds, 60);

  requireLease(limiter.acquire('three', '10.0.0.2')).release();
  const globalRate = requireRejection(limiter.acquire('four', '10.0.0.3'));
  assert.equal(globalRate.statusCode, 429);

  now += 60_000;
  requireLease(limiter.acquire('four', '10.0.0.3')).release();
});

test('SimBrief HTTP proxy releases capacity across failures and disconnects', { timeout: 10_000 }, async () => {
  const fakeHttps = installFakeHttps();
  const { server, port } = await startTestServer();

  try {
    const alicePromise = requestText(port, '/api/simbrief?username=Alice');
    await waitFor(() => fakeHttps.pending.length === 1, 'first SimBrief request did not reach HTTPS');
    assert.match(fakeHttps.pending[0].url, /username=alice/);
    assert.equal(fakeHttps.pending[0].options.timeout, 15_000);

    const duplicate = await requestText(port, '/api/simbrief?username=ALICE');
    assert.equal(duplicate.statusCode, 429);
    assert.equal(fakeHttps.pending.length, 1, 'same username must not start a second HTTPS request');

    const bobPromise = requestText(port, '/api/simbrief?username=bob');
    await waitFor(() => fakeHttps.pending.length === 2, 'second per-client request did not reach HTTPS');
    const capacityRejected = await requestText(port, '/api/simbrief?username=charlie');
    assert.equal(capacityRejected.statusCode, 429);
    assert.match(capacityRejected.body, /from this client/i);
    assert.equal(fakeHttps.pending.length, 2);

    fakeHttps.pending[0].request.emit('error', new Error('fixture connection failure'));
    assert.equal((await alicePromise).statusCode, 502);
    const failedUsernameCooldown = await requestText(port, '/api/simbrief?username=alice');
    assert.equal(failedUsernameCooldown.statusCode, 429);

    const charliePromise = requestText(port, '/api/simbrief?username=charlie');
    await waitFor(() => fakeHttps.pending.length === 3, 'capacity rejection incorrectly consumed username cooldown');

    fakeHttps.pending[1].request.emit('timeout');
    const bobResult = await bobPromise;
    assert.equal(bobResult.statusCode, 504);
    assert.equal(fakeHttps.pending[1].request.destroyed, true);

    const deltaPromise = requestText(port, '/api/simbrief?username=delta');
    await waitFor(() => fakeHttps.pending.length === 4, 'timeout did not release per-client capacity');
    fakeHttps.pending[2].respondJson(200, { fetch: { status: 'Success' }, id: 'charlie' });
    fakeHttps.pending[3].respondJson(200, { fetch: { status: 'Success' }, id: 'delta' });
    assert.equal((await charliePromise).statusCode, 200);
    assert.equal((await deltaPromise).statusCode, 200);

    const echoPromise = requestText(port, '/api/simbrief?username=echo');
    await waitFor(() => fakeHttps.pending.length === 5, 'upstream abort fixture did not start');
    const abortedResponse = fakeHttps.pending[4].openResponse(200);
    abortedResponse.emit('aborted');
    abortedResponse.emit('close');
    assert.equal((await echoPromise).statusCode, 502);
    assert.equal(fakeHttps.pending[4].request.destroyed, true);

    const disconnecting = openAbortableRequest(port, '/api/simbrief?username=foxtrot');
    await waitFor(() => fakeHttps.pending.length === 6, 'client disconnect fixture did not start');
    disconnecting.request.destroy();
    await disconnecting.settled;
    await waitFor(() => fakeHttps.pending[5].request.destroyed, 'client disconnect did not destroy upstream request');

    const golfPromise = requestText(port, '/api/simbrief?username=golf');
    const hotelPromise = requestText(port, '/api/simbrief?username=hotel');
    await waitFor(() => fakeHttps.pending.length === 8, 'client disconnect did not release per-client capacity');
    const finalCapacityRejection = await requestText(port, '/api/simbrief?username=india');
    assert.equal(finalCapacityRejection.statusCode, 429);
    fakeHttps.pending[6].respondJson(200, { fetch: { status: 'Success' }, id: 'golf' });
    fakeHttps.pending[7].respondJson(200, { fetch: { status: 'Success' }, id: 'hotel' });
    assert.equal((await golfPromise).statusCode, 200);
    assert.equal((await hotelPromise).statusCode, 200);
  } finally {
    fakeHttps.restore();
    await closeServer(server);
  }
});
