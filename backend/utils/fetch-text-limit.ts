'use strict';

type LimitedTextResult = {
  ok: boolean;
  text?: string;
  error?: string;
};

function formatByteLimit(byteLength: number): string {
  const mb = byteLength / (1024 * 1024);
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.round(byteLength / 1024)} KB`;
}

function buildLimitError(label: string, maxBytes: number): LimitedTextResult {
  return { ok: false, error: `${label} exceeded ${formatByteLimit(maxBytes)}.` };
}

async function readFetchTextWithLimit(response: any, maxBytes: number, label = 'Response'): Promise<LimitedTextResult> {
  const safeMaxBytes = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0
    ? Number(maxBytes)
    : 1024 * 1024;
  const contentLength = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > safeMaxBytes) {
    return buildLimitError(label, safeMaxBytes);
  }

  const body = response?.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text();
    return Buffer.byteLength(text, 'utf8') > safeMaxBytes
      ? buildLimitError(label, safeMaxBytes)
      : { ok: true, text };
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;

      const buffer = Buffer.from(value);
      totalBytes += buffer.byteLength;
      if (totalBytes > safeMaxBytes) {
        try { await reader.cancel(); } catch {}
        return buildLimitError(label, safeMaxBytes);
      }
      chunks.push(buffer);
    }
  } finally {
    if (typeof reader.releaseLock === 'function') {
      try { reader.releaseLock(); } catch {}
    }
  }

  return { ok: true, text: Buffer.concat(chunks, totalBytes).toString('utf8') };
}

module.exports = {
  readFetchTextWithLimit,
};

export {};
