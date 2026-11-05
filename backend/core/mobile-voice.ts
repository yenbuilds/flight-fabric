import https from 'node:https';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { loadMobileVoiceIdentity } from './mobile-voice-identity';
import { parseCookieHeader } from './device-pairing';
import { isPrivateOrLoopbackRemoteAddress } from './ws-bootstrap';
const WS = require('ws');

type Socket = {
  readyState: number; bufferedAmount: number;
  send: (data: string | Buffer) => void;
  close: (code?: number, reason?: string) => void;
  terminate: () => void;
  on: (event: string, fn: (...args: any[]) => void) => void;
};
type Session = {
  id: string; socket: Socket; paired: () => boolean; sequence: number;
  frames: number; rate: number; finished: boolean; dispatched: boolean;
  deadline: ReturnType<typeof setTimeout>; idle: ReturnType<typeof setTimeout>;
};
const LIMIT = 128 * 1024;
const text = (value: unknown, max = 400) => typeof value === 'string'
  ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : '';
function send(socket: Socket | null, message: unknown): boolean {
  if (!socket || socket.readyState !== 1 || socket.bufferedAmount > LIMIT) return false;
  try { socket.send(Buffer.isBuffer(message) ? message : JSON.stringify(message)); return true; } catch { return false; }
}
function localRequest(req: IncomingMessage): boolean {
  const host = new URL(`http://${req.headers.host || 'invalid'}`).hostname;
  const remote = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host) || !['127.0.0.1', '::1'].includes(remote)) return false;
  if (!req.headers.origin) return true;
  try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(req.headers.origin).hostname); } catch { return false; }
}

// A separate transport owns remote audio, pairing revalidation, bounds and
// the HTTPS listener. It never interprets speech or invokes a simulator recipe.
export function createMobileVoiceService({ httpServer, port, ips, directory, token, pairing, upgradeTelemetry,
  identityLoader = loadMobileVoiceIdentity,
  initiallyEnabled = false, saveEnabled = () => {},
}: {
  httpServer: Server; port: number; ips: string[]; directory: string; token: string;
  pairing: { hasApprovedSession: (id: unknown, address: string | null) => boolean } | null;
  upgradeTelemetry: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  identityLoader?: typeof loadMobileVoiceIdentity;
  initiallyEnabled?: boolean;
  saveEnabled?: (enabled: boolean) => void;
}) {
  let server: https.Server | null = null;
  let identity: Awaited<ReturnType<typeof loadMobileVoiceIdentity>> | null = null;
  let host: Socket | null = null, active: Session | null = null;
  let enabled = false, preparing: Promise<void> | null = null, revision = 0, disposed = false;
  let startupError = '';
  let boundPort = port;
  const connections = new Map<https.Server, Set<import('node:net').Socket>>();
  const sockets = new Set<Socket>();
  const wss = new WS.Server({ noServer: true, maxPayload: 44 + 8192 * 4, perMessageDeflate: false });
  const status = () => ({ enabled, preparing: Boolean(preparing), error: startupError, available: enabled && host?.readyState === 1,
    port: enabled ? boundPort : null, fingerprint: identity?.fingerprint || '',
    urls: enabled ? ips.map(ip => `https://${ip}:${boundPort}/phone`) : [] });
  function retire(reason = 'Recording cancelled. Please try again.') {
    const old = active;
    active = null;
    if (!old) return;
    clearTimeout(old.deadline); clearTimeout(old.idle);
    send(host, { kind: 'cancel', id: old.id });
    send(old.socket, { kind: 'error', message: reason });
    old.socket.close(1000, 'Session ended');
  }
  function armIdle(session: Session) {
    clearTimeout(session.idle);
    session.idle = setTimeout(() => { if (active === session) retire('The phone stopped sending audio. Please try again.'); }, 3000);
  }
  function hostMessage(socket: Socket, bytes: Buffer, binary: boolean) {
    if (socket !== host || binary || bytes.length > 2048) return socket.close(1008);
    let msg;
    try { msg = JSON.parse(bytes.toString()); } catch { return socket.close(1008); }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return socket.close(1008);
    const session = active;
    if (!session || msg.id !== session.id) return;
    if (!session.paired()) return retire('Phone access expired. Pair this device again.');
    if (msg.kind === 'ready') {
      if (!send(session.socket, { kind: 'ready', id: session.id })) retire();
    } else if (msg.kind === 'status') {
      if (!send(session.socket, { kind: 'status', status: text(msg.status, 32), message: text(msg.message),
        transcript: text(msg.transcript), command: text(msg.command, 240), done: msg.done === true })) return retire();
      if (msg.done === true) {
        active = null;
        clearTimeout(session.deadline); clearTimeout(session.idle);
        session.socket.close(1000, 'Complete');
      }
    } else if (msg.kind === 'error') retire(text(msg.message) || 'PC voice control is unavailable.');
    else socket.close(1008);
  }
  function phoneMessage(session: Session, bytes: Buffer, binary: boolean) {
    if (active !== session) return;
    if (!session.paired() || !host || !enabled) return retire('Phone access expired. Pair this device again.');
    try {
      if (binary) {
        if (session.finished || bytes.length < 48 || bytes.length > 44 + 8192 * 4
          || (bytes.length - 44) % 4 || bytes.toString('ascii', 0, 32) !== session.id) throw new Error();
        const sequence = bytes.readUInt32LE(32), rate = bytes.readUInt32LE(36), frames = bytes.readUInt32LE(40);
        if (sequence !== session.sequence || ![16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000].includes(rate)
          || frames !== (bytes.length - 44) / 4 || (session.rate && session.rate !== rate)
          || session.frames + frames > rate * 10) throw new Error();
        for (let offset = 44; offset < bytes.length; offset += 4) {
          const value = bytes.readFloatLE(offset);
          if (!Number.isFinite(value) || Math.abs(value) > 1) throw new Error();
        }
        session.rate = rate; session.frames += frames; session.sequence++;
        armIdle(session);
        if (!send(host, bytes)) throw new Error();
        return;
      }
      if (bytes.length > 512) throw new Error();
      const msg = JSON.parse(bytes.toString());
      if (msg.kind === 'cancel') return retire();
      if (msg.kind === 'capturing' && !session.finished && !session.frames) {
        armIdle(session);
        if (!send(host, { kind: 'capturing', id: session.id })) throw new Error();
      } else if (msg.kind === 'finish' && !session.finished && session.frames > 0 && msg.chunks === session.sequence) {
        session.finished = true;
        clearTimeout(session.idle);
        if (!send(host, { kind: 'finish', id: session.id })) throw new Error();
      } else throw new Error();
    } catch { retire('The recording was incomplete. Please try again.'); }
  }
  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    let url: URL;
    try { url = new URL(req.url || '/', `http://${req.headers.host}`); } catch { socket.destroy(); return; }
    const isHost = url.pathname === '/mobile-voice/host';
    const secure = (req.socket as import('node:tls').TLSSocket).encrypted === true;
    if (url.pathname === '/ws' && secure && enabled) return upgradeTelemetry(req, socket, head);
    let approved = false;
    const pairedId = parseCookieHeader(req.headers.cookie)['__Secure-ff_voice_pair'] || '';
    const paired = () => pairing?.hasApprovedSession(pairedId, req.socket.remoteAddress || null) === true;
    try {
      approved = enabled && (isHost
        ? localRequest(req) && Boolean(token) && url.searchParams.get('token') === token && !host
        : url.pathname === '/mobile-voice/audio' && secure
          && req.headers.origin === `https://${req.headers.host}`
          && isPrivateOrLoopbackRemoteAddress(req.socket.remoteAddress) && paired());
    } catch {}
    if (!approved) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, (ws: Socket) => {
      sockets.add(ws);
      ws.on('error', () => {});
      ws.on('close', () => {
        sockets.delete(ws);
        if (host === ws) { host = null; retire('FlightFabric voice control disconnected. Please reconnect.'); }
        else if (active?.socket === ws) retire();
      });
      if (isHost) {
        host = ws;
        ws.on('message', (bytes: Buffer, binary: boolean) => hostMessage(ws, bytes, binary));
      } else {
        // The second check closes a simultaneous connection race.
        if (active || !host) {
          send(ws, { kind: 'error', message: active
            ? 'Voice control is busy. Finish the current command, then try again.'
            : 'Open FlightFabric and enable voice control on your PC, then try again.' });
          ws.close(1000); return;
        }
        const session = { id: randomBytes(16).toString('hex'), socket: ws, paired, sequence: 0, frames: 0,
          rate: 0, finished: false, dispatched: false,
          deadline: setTimeout(() => { if (active === session) retire('Voice recording timed out. Please try again.'); }, 20000),
          idle: setTimeout(() => { if (active === session) retire('Microphone setup timed out. Please try again.'); }, 10000),
        };
        active = session;
        ws.on('message', (bytes: Buffer, binary: boolean) => phoneMessage(session, bytes, binary));
        if (!send(host, { kind: 'start', id: session.id })) retire();
      }
    });
  }
  function upgradeLocal(req: IncomingMessage, socket: Duplex, head: Buffer) {
    if (String(req.url || '').split('?')[0] === '/mobile-voice/host') upgrade(req, socket, head);
    else if (httpServer.listenerCount('upgrade') === 1) socket.destroy();
  }
  httpServer.on('upgrade', upgradeLocal);
  async function closeListener(listener: https.Server) {
    for (const socket of connections.get(listener) || []) socket.destroy();
    connections.delete(listener);
    listener.closeAllConnections();
    await new Promise<void>(resolve => listener.close(() => resolve()));
  }
  async function disable() {
    revision++; enabled = false; retire('Phone microphone access was switched off.');
    // Retire preparation immediately; a fresh enable owns its own promise.
    preparing = null;
    identity = null;
    for (const socket of sockets) socket.terminate();
    sockets.clear(); host = null;
    const old = server; server = null;
    if (old) await closeListener(old);
  }
  async function enable(remember = true) {
    if (disposed) throw new Error('FlightFabric is shutting down.');
    if (enabled) return;
    if (preparing) return preparing;
    if (!pairing || !ips.length) throw new Error('Enable phone access and paired aircraft controls first.');
    const owner = ++revision;
    startupError = '';
    const work = (async () => {
      const next = await identityLoader(directory, ips);
      if (disposed || owner !== revision) return;
      const listener = https.createServer({ key: next.key, cert: next.cert, minVersion: 'TLSv1.2' }, (req, res) => {
        httpServer.emit('request', req, res);
      });
      server = listener;
      const clients = new Set<import('node:net').Socket>(); connections.set(listener, clients);
      listener.on('connection', socket => { clients.add(socket); socket.once('close', () => clients.delete(socket)); });
      listener.on('upgrade', upgrade);
      listener.on('tlsClientError', () => {});
      try {
        await new Promise<void>((resolve, reject) => {
          listener.once('error', reject);
          listener.listen(port, '0.0.0.0', () => { listener.removeListener('error', reject); resolve(); });
        });
      } catch (error) {
        if (server === listener) server = null;
        await closeListener(listener);
        throw error;
      }
      listener.on('error', () => { if (server === listener) void disable(); });
      if (disposed || owner !== revision) { if (server === listener) server = null; await closeListener(listener); return; }
      try {
        // Commit only after the listener is ready and this attempt still owns it.
        // A failed write rolls back access rather than claiming it was remembered.
        if (remember) saveEnabled(true);
      } catch (error) {
        if (server === listener) server = null;
        await closeListener(listener);
        throw error;
      }
      boundPort = (listener.address() as import('node:net').AddressInfo).port;
      identity = next; enabled = true;
    })();
    preparing = work;
    try { await work; } finally { if (preparing === work) preparing = null; }
  }
  function handleHttp(req: IncomingMessage, res: ServerResponse): boolean {
    const route = String(req.url || '').split('?')[0];
    if (!['/api/mobile-voice', '/mobile-voice/ca.cer'].includes(route)) return false;
    res.setHeader('Cache-Control', 'no-store');
    if (route === '/mobile-voice/ca.cer' && req.method === 'GET' && enabled && identity) {
      res.setHeader('Content-Type', 'application/x-x509-ca-cert');
      res.setHeader('Content-Disposition', 'attachment; filename="FlightFabric-PC.cer"');
      res.end(identity.certificate); return true;
    }
    let privileged = false;
    try { privileged = localRequest(req) && Boolean(token) && req.headers['x-flightfabric-token'] === token; } catch {}
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && route === '/api/mobile-voice') {
      // Public connection metadata lets the phone guide its own setup. The
      // fingerprint identifies the already-public CA, never its private key.
      res.end(JSON.stringify(privileged ? status() : { enabled, preparing: Boolean(preparing), available: enabled && Boolean(host),
        port: enabled ? boundPort : null, fingerprint: enabled ? identity?.fingerprint || '' : '' }));
      return true;
    }
    if (!privileged || route !== '/api/mobile-voice' || req.method !== 'POST') {
      res.statusCode = 403; res.end(JSON.stringify({ error: 'Phone setup must be changed on the PC.' })); return true;
    }
    // No arbitrary JSON/settings surface: two exact, bounded action bodies.
    let body = '', ended = false;
    const timer = setTimeout(() => req.destroy(), 5000);
    req.on('close', () => clearTimeout(timer));
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); if (body.length > 16) req.destroy(); });
    req.on('end', () => {
      clearTimeout(timer);
      if (ended) return; ended = true;
      const action = body === 'enable' ? () => enable() : body === 'disable' ? async () => {
        if (disposed) throw new Error('FlightFabric is shutting down.');
        // Save first so a failed write cannot silently re-enable access next launch.
        saveEnabled(false); startupError = '';
        await disable();
      } : null;
      if (!action) { res.statusCode = 400; res.end('{}'); return; }
      void action().then(() => res.end(JSON.stringify(status()))).catch(() => {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: 'Phone microphone access could not be saved or updated. Please try again.' }));
      });
    });
    return true;
  }
  // Restore independently of renderer/Settings navigation. Failure leaves the
  // remembered choice intact and ordinary HTTP controls available for recovery.
  const restoration = initiallyEnabled ? enable(false) : Promise.resolve();
  const restorationRevision = revision;
  const ready = restoration.catch(() => {
    if (!disposed && revision === restorationRevision) startupError = 'Phone microphone access could not start. Try enabling it again below.';
  });
  return {
    handleHttp, status, ready,
    authorizeDispatch(id: unknown): boolean {
      const session = active;
      if (!session || session.id !== id || !session.finished || session.dispatched || !session.paired() || !enabled || !host) return false;
      session.dispatched = true;
      return true;
    },
    async dispose() {
      disposed = true; httpServer.removeListener('upgrade', upgradeLocal);
      await disable(); void preparing?.catch(() => {}); wss.close();
    },
  };
}
