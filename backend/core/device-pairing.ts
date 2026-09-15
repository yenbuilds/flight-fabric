const crypto = require('crypto') as typeof import('crypto');
const timeSource = require('./time-source.js') as { now: () => number };

const REQUEST_TTL_MS = 2 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_PENDING_REQUESTS = 8;
const MAX_PENDING_REQUESTS_PER_ADDRESS = 2;

type PairingRequest = {
  confirmationCode: string;
  createdAt: number;
  expiresAt: number;
  id: string;
  remoteAddress: string;
  status: 'pending' | 'approved';
};

type PairingSession = {
  expiresAt: number;
  remoteAddress: string;
};

function normalizeAddress(value: string | null | undefined): string {
  let normalized = String(value || '').trim().toLowerCase();
  const zoneIndex = normalized.indexOf('%');
  if (zoneIndex >= 0) normalized = normalized.slice(0, zoneIndex);
  if (normalized.startsWith('::ffff:')) normalized = normalized.slice('::ffff:'.length);
  return normalized || 'unknown';
}

function createConfirmationCode(): string {
  const value = crypto.randomInt(0, 1_000_000);
  return String(value).padStart(6, '0');
}

function createOpaqueId(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export function parseCookieHeader(value: string | string[] | undefined): Record<string, string> {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || raw.length === 0) return {};
  const parsed: Record<string, string> = {};
  for (const segment of raw.split(';')) {
    const separator = segment.indexOf('=');
    if (separator <= 0) continue;
    const key = segment.slice(0, separator).trim();
    const encodedValue = segment.slice(separator + 1).trim();
    if (!key || !encodedValue || Object.hasOwn(parsed, key)) continue;
    try {
      parsed[key] = decodeURIComponent(encodedValue);
    } catch {}
  }
  return parsed;
}

export function createDevicePairingManager({
  now = () => timeSource.now(),
  requestTtlMs = REQUEST_TTL_MS,
  sessionTtlMs = SESSION_TTL_MS,
}: {
  now?: () => number;
  requestTtlMs?: number;
  sessionTtlMs?: number;
} = {}) {
  const requests = new Map<string, PairingRequest>();
  const sessions = new Map<string, PairingSession>();

  function purgeExpired(): void {
    const current = now();
    for (const [id, request] of requests) {
      if (request.expiresAt <= current) requests.delete(id);
    }
    for (const [id, session] of sessions) {
      if (session.expiresAt <= current) sessions.delete(id);
    }
  }

  function createRequest(remoteAddress: string | null | undefined):
    | { ok: true; request: PairingRequest }
    | { ok: false; error: 'too_many_requests' } {
    purgeExpired();
    const normalizedAddress = normalizeAddress(remoteAddress);
    const pendingForAddress = [...requests.values()].filter((request) => (
      request.status === 'pending' && request.remoteAddress === normalizedAddress
    )).length;
    const pendingCount = [...requests.values()].filter((request) => request.status === 'pending').length;
    if (pendingForAddress >= MAX_PENDING_REQUESTS_PER_ADDRESS || pendingCount >= MAX_PENDING_REQUESTS) {
      return { ok: false, error: 'too_many_requests' };
    }

    const activeCodes = new Set([...requests.values()].map((request) => request.confirmationCode));
    let confirmationCode = createConfirmationCode();
    while (activeCodes.has(confirmationCode)) confirmationCode = createConfirmationCode();

    const createdAt = now();
    const request: PairingRequest = {
      confirmationCode,
      createdAt,
      expiresAt: createdAt + requestTtlMs,
      id: createOpaqueId(),
      remoteAddress: normalizedAddress,
      status: 'pending',
    };
    requests.set(request.id, request);
    return { ok: true, request };
  }

  function listPendingRequests(): Array<Pick<PairingRequest, 'confirmationCode' | 'createdAt' | 'expiresAt' | 'id' | 'remoteAddress'>> {
    purgeExpired();
    return [...requests.values()]
      .filter((request) => request.status === 'pending')
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ confirmationCode, createdAt, expiresAt, id, remoteAddress }) => ({
        confirmationCode,
        createdAt,
        expiresAt,
        id,
        remoteAddress,
      }));
  }

  function approveRequest(id: unknown, confirmationCode: unknown): boolean {
    purgeExpired();
    const request = typeof id === 'string' ? requests.get(id) : null;
    if (
      !request
      || request.status !== 'pending'
      || typeof confirmationCode !== 'string'
      || confirmationCode !== request.confirmationCode
    ) {
      return false;
    }
    request.status = 'approved';
    return true;
  }

  function getRequestStatus(id: unknown, remoteAddress: string | null | undefined):
    | { status: 'pending'; expiresAt: number }
    | { status: 'approved'; expiresAt: number }
    | { status: 'expired' } {
    purgeExpired();
    const request = typeof id === 'string' ? requests.get(id) : null;
    if (!request || request.remoteAddress !== normalizeAddress(remoteAddress)) {
      return { status: 'expired' };
    }
    return { status: request.status, expiresAt: request.expiresAt };
  }

  function claimApprovedRequest(id: unknown, remoteAddress: string | null | undefined): string | null {
    purgeExpired();
    const request = typeof id === 'string' ? requests.get(id) : null;
    if (!request || request.status !== 'approved' || request.remoteAddress !== normalizeAddress(remoteAddress)) {
      return null;
    }

    requests.delete(request.id);
    const sessionId = createOpaqueId();
    sessions.set(sessionId, {
      expiresAt: now() + sessionTtlMs,
      remoteAddress: request.remoteAddress,
    });
    return sessionId;
  }

  function hasApprovedSession(sessionId: unknown, remoteAddress: string | null | undefined): boolean {
    purgeExpired();
    const session = typeof sessionId === 'string' ? sessions.get(sessionId) : null;
    return Boolean(session && session.remoteAddress === normalizeAddress(remoteAddress));
  }

  return {
    approveRequest,
    claimApprovedRequest,
    createRequest,
    getRequestStatus,
    hasApprovedSession,
    listPendingRequests,
  };
}
