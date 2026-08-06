'use strict';

const assert = require('assert') as typeof import('assert');
const { readFetchTextWithLimit } = require('./fetch-text-limit.js') as {
  readFetchTextWithLimit: (response: any, maxBytes: number, label?: string) => Promise<Record<string, any>>;
};

function createHeaders(headers: Record<string, string> = {}) {
  return {
    get(name: string) {
      return headers[name.toLowerCase()] || null;
    },
  };
}

function createStreamResponse(chunks: string[], headers: Record<string, string> = {}) {
  return {
    headers: createHeaders(headers),
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(Buffer.from(chunk, 'utf8'));
        }
        controller.close();
      },
    }),
    async text() {
      return chunks.join('');
    },
  };
}

async function run() {
  const accepted = await readFetchTextWithLimit(createStreamResponse(['ab', 'cd']), 4, 'Fixture');
  assert.equal(accepted.ok, true, 'payload at the byte limit should be accepted');
  assert.equal(accepted.text, 'abcd', 'accepted payload should preserve text');

  const rejectedByHeader = await readFetchTextWithLimit(
    createStreamResponse(['small'], { 'content-length': '5' }),
    4,
    'Fixture',
  );
  assert.equal(rejectedByHeader.ok, false, 'oversized content-length should reject before reading');
  assert.match(rejectedByHeader.error, /Fixture exceeded/, 'content-length rejection should name the response');

  const rejectedByStream = await readFetchTextWithLimit(createStreamResponse(['ab', 'cde']), 4, 'Fixture');
  assert.equal(rejectedByStream.ok, false, 'streamed payload over the byte limit should reject while reading');
  assert.match(rejectedByStream.error, /Fixture exceeded/, 'stream rejection should name the response');

  console.log('✅ fetch text limit tests passed');
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

export {};
