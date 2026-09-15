const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createDevicePairingManager,
  parseCookieHeader,
} = require('./device-pairing') as typeof import('./device-pairing');

test('device pairing requires a matching local approval before issuing an IP-bound session', () => {
  let currentTime = 1_000;
  const pairing = createDevicePairingManager({ now: () => currentTime });
  const created = pairing.createRequest('::ffff:192.168.1.44');
  assert.equal(created.ok, true);
  if (!created.ok) return;

  assert.equal(pairing.claimApprovedRequest(created.request.id, '192.168.1.44'), null);
  assert.deepEqual(pairing.getRequestStatus(created.request.id, '192.168.1.44'), {
    status: 'pending',
    expiresAt: created.request.expiresAt,
  });
  assert.deepEqual(pairing.getRequestStatus(created.request.id, '192.168.1.45'), { status: 'expired' });
  assert.equal(pairing.approveRequest(created.request.id, 'wrong-code'), false);
  assert.equal(pairing.approveRequest(created.request.id, created.request.confirmationCode), true);
  assert.deepEqual(pairing.getRequestStatus(created.request.id, '192.168.1.44'), {
    status: 'approved',
    expiresAt: created.request.expiresAt,
  });

  const sessionId = pairing.claimApprovedRequest(created.request.id, '192.168.1.44');
  assert.ok(sessionId);
  assert.equal(pairing.hasApprovedSession(sessionId, '192.168.1.44'), true);
  assert.equal(pairing.hasApprovedSession(sessionId, '192.168.1.45'), false);

  currentTime += 12 * 60 * 60 * 1000;
  assert.equal(pairing.hasApprovedSession(sessionId, '192.168.1.44'), false);
});

test('device pairing expires unapproved requests and bounds pending requests per device', () => {
  let currentTime = 1_000;
  const pairing = createDevicePairingManager({ now: () => currentTime });
  const first = pairing.createRequest('192.168.1.44');
  const second = pairing.createRequest('192.168.1.44');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(pairing.createRequest('192.168.1.44'), { ok: false, error: 'too_many_requests' });

  currentTime += 2 * 60 * 1000;
  assert.equal(pairing.listPendingRequests().length, 0);
  if (first.ok) assert.deepEqual(pairing.getRequestStatus(first.request.id, '192.168.1.44'), { status: 'expired' });
  assert.equal(pairing.createRequest('192.168.1.44').ok, true);
});

test('cookie parsing is bounded to the first well-formed cookie value', () => {
  assert.deepEqual(parseCookieHeader('ff_aircraft_pair=first; ignored=value; ff_aircraft_pair=second'), {
    ff_aircraft_pair: 'first',
    ignored: 'value',
  });
});
