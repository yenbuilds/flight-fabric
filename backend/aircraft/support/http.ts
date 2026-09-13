import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto = require('node:crypto');
import { WorkbenchError } from './sessions';
import type { createWorkbenchService } from './service';

export async function handleWorkbenchRequest(req: IncomingMessage, res: ServerResponse, options: {
  token: string; local: boolean; service: () => ReturnType<typeof createWorkbenchService>;
}) {
  const send = (status: number, payload: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
  };
  const actual = Buffer.from(String(req.headers.authorization || ''));
  const expected = Buffer.from(`Bearer ${options.token}`);
  if (!options.local || !options.token || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    send(403, { error: 'Aircraft workbench requires the local Flight Fabric desktop connection.' });
    return;
  }
  try {
    if (!['GET', 'POST'].includes(req.method || '')) throw new WorkbenchError('Method not allowed.', 405);
    let input = {};
    if (req.method === 'POST') {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new WorkbenchError('Expected JSON.', 415);
      const chunks: Buffer[] = [];
      let bytes = 0;
      req.setTimeout(10000, () => req.destroy());
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 16 * 1024) throw new WorkbenchError('Request is too large.', 413);
        chunks.push(chunk);
      }
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new WorkbenchError('Invalid JSON.'); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new WorkbenchError('Expected a JSON object.');
    }
    const url = new URL(req.url!, 'http://localhost');
    const parts = url.pathname.slice('/api/aircraft-support/'.length).split('/').map(decodeURIComponent);
    send(200, await options.service().handle(req.method!, parts, url.searchParams, input));
  } catch (error) {
    if (!res.destroyed) send(error instanceof WorkbenchError ? error.status : 500,
      { error: error instanceof WorkbenchError ? error.message : 'Workbench could not complete the request. Check the backend log.' });
    if (!(error instanceof WorkbenchError)) console.error('[aircraft-support]', error);
  }
}
