'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { streamUtf8Records } = require('./bounded-utf8-record-reader') as {
  streamUtf8Records: (_options: {
    expectedStat: import('node:fs').BigIntStats;
    filePath: string;
    label: string;
    maxBytes: number;
    maxRecordChars: number;
    mode: 'csv' | 'line';
    onRecord: (_record: string, _metadata: { recordNumber: number; terminated: boolean }) => void;
  }) => Promise<{ fileSizeBytes: number; recordCount: number; sha256: string }>;
};

function createFixture(name: string, data: string | Buffer): {
  dir: string;
  filePath: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-bounded-reader-'));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, data);
  return { dir, filePath };
}

test('streams quoted CSV records across chunk boundaries and hashes raw bytes', async (t) => {
  const longValue = `before-${'x'.repeat(96 * 1024)}\nafter`;
  const content = `a,b\n1,"${longValue}"\n2,done`;
  const fixture = createFixture('telemetry.csv', content);
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  const records: Array<{ record: string; terminated: boolean }> = [];

  const result = await streamUtf8Records({
    expectedStat: await fs.promises.lstat(fixture.filePath, { bigint: true }),
    filePath: fixture.filePath,
    label: 'CSV',
    maxBytes: 2 * 1024 * 1024,
    maxRecordChars: 256 * 1024,
    mode: 'csv',
    onRecord(record, metadata) {
      records.push({ record, terminated: metadata.terminated });
    },
  });

  assert.equal(records.length, 3);
  assert.equal(records[1].record, `1,"${longValue}"`);
  assert.equal(records[1].terminated, true);
  assert.equal(records[2].terminated, false);
  assert.equal(result.fileSizeBytes, Buffer.byteLength(content));
  assert.equal(result.sha256, crypto.createHash('sha256').update(content).digest('hex'));
});

test('does not use FileHandle.readFile', async (t) => {
  const fixture = createFixture('rows.jsonl', '{"a":1}\n{"a":2}\n');
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  const originalOpen = fs.promises.open;
  (fs.promises as any).open = async (...args: any[]) => {
    const handle = await (originalOpen as any).apply(fs.promises, args);
    handle.readFile = async () => {
      throw new Error('whole-file read must not be used');
    };
    return handle;
  };
  t.after(() => {
    (fs.promises as any).open = originalOpen;
  });

  const records: string[] = [];
  await streamUtf8Records({
    expectedStat: await fs.promises.lstat(fixture.filePath, { bigint: true }),
    filePath: fixture.filePath,
    label: 'JSONL',
    maxBytes: 1024,
    maxRecordChars: 1024,
    mode: 'line',
    onRecord(record) {
      records.push(record);
    },
  });
  assert.deepEqual(records, ['{"a":1}', '{"a":2}']);
});

test('fails closed on invalid UTF-8 and oversized individual records', async (t) => {
  const invalid = createFixture('invalid.jsonl', Buffer.from([0x7b, 0xff, 0x7d, 0x0a]));
  const oversized = createFixture('oversized.jsonl', `${'x'.repeat(33)}\n`);
  t.after(() => {
    fs.rmSync(invalid.dir, { recursive: true, force: true });
    fs.rmSync(oversized.dir, { recursive: true, force: true });
  });

  await assert.rejects(
    streamUtf8Records({
      expectedStat: await fs.promises.lstat(invalid.filePath, { bigint: true }),
      filePath: invalid.filePath,
      label: 'JSONL',
      maxBytes: 1024,
      maxRecordChars: 1024,
      mode: 'line',
      onRecord() {},
    }),
    (error: NodeJS.ErrnoException) => error.code === 'FF_INVALID_UTF8',
  );
  await assert.rejects(
    streamUtf8Records({
      expectedStat: await fs.promises.lstat(oversized.filePath, { bigint: true }),
      filePath: oversized.filePath,
      label: 'JSONL',
      maxBytes: 1024,
      maxRecordChars: 32,
      mode: 'line',
      onRecord() {},
    }),
    (error: NodeJS.ErrnoException) => error.code === 'FF_RECORD_TOO_LARGE',
  );
});

export {};
