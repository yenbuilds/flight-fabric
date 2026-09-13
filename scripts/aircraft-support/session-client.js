'use strict';

async function requestSession({ operation, id, input, url = 'http://127.0.0.1:8100' }) {
  const base = new URL(url);
  if (base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
    || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('Use a local Flight Fabric HTTP URL without credentials or a path.');
  }
  const operations = {
    list: { resource: 'sessions' },
    show: { resource: `sessions/${id}` },
    create: { resource: 'sessions', body: input },
    result: { resource: `sessions/${id}/results`, body: input },
    capture: { resource: `sessions/${id}/capture`, body: input },
    stop: { resource: `sessions/${id}/capture/stop`, body: {} },
    marker: { resource: `sessions/${id}/capture/marker`, body: input },
  };
  const spec = operations[operation];
  if (!spec) throw new Error('Choose list, show, create, result, capture, marker, or stop.');
  if (!['list', 'create'].includes(operation) && !/^[a-f0-9-]{36}$/.test(id || '')) throw new Error('--id must be a session ID.');
  if (['create', 'result', 'capture', 'marker'].includes(operation) && (!input || typeof input !== 'object' || Array.isArray(input))) {
    throw new Error('--input must name a JSON object file.');
  }
  const bootstrap = await fetch(new URL('/api/bootstrap', base), { redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!bootstrap.ok) throw new Error('Could not connect to the local Flight Fabric backend.');
  const token = (await bootstrap.json()).wsAuthToken;
  if (typeof token !== 'string' || !token) throw new Error('The local backend did not grant workbench access.');
  const response = await fetch(new URL(`/api/aircraft-support/${spec.resource}`, base), {
    method: spec.body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${token}`, ...(spec.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Workbench returned ${response.status}.`);
  return result;
}

module.exports = { requestSession };
