'use strict';

const assert = require('assert') as typeof import('assert');
const fs = require('fs') as typeof import('fs');
const os = require('os') as typeof import('os');
const path = require('path') as typeof import('path');
const {
  assertSafeRecordingFilePath,
  createSafeRecordingWriteStream,
} = require('./recording-path-guard.js') as {
  assertSafeRecordingFilePath: (_options: {
    extension: string;
    operation: string;
    outputDir: string;
    requiredSuffix?: string;
    targetPath: string;
  }) => string;
  createSafeRecordingWriteStream: (_options: {
    extension: string;
    flags?: string;
    operation: string;
    outputDir: string;
    requiredSuffix?: string;
    targetPath: string;
  }) => import('fs').WriteStream;
};

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`PASS ${name}`);
      passed += 1;
    })
    .catch((error) => {
      failed += 1;
      const err = error as Error;
      console.error(`FAIL ${name}: ${err.message}`);
    });
}

async function main(): Promise<void> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-recording-path-guard-test-'));
  const outputDir = path.join(tempRoot, 'Flight Logs');

  try {
    await test('assertSafeRecordingFilePath accepts direct CSV children', () => {
      const target = path.join(outputDir, 'flight.csv');
      const resolved = assertSafeRecordingFilePath({
        extension: '.csv',
        operation: 'testCsvPath',
        outputDir,
        targetPath: target,
      });
      assert.equal(resolved, path.resolve(target));
      assert.equal(fs.existsSync(outputDir), true);
    });

    await test('assertSafeRecordingFilePath rejects nested recording paths', () => {
      assert.throws(() => assertSafeRecordingFilePath({
        extension: '.csv',
        operation: 'testNestedCsvPath',
        outputDir,
        targetPath: path.join(outputDir, 'nested', 'flight.csv'),
      }), /direct children/);
    });

    await test('assertSafeRecordingFilePath rejects wrong extensions', () => {
      assert.throws(() => assertSafeRecordingFilePath({
        extension: '.csv',
        operation: 'testWrongExtension',
        outputDir,
        targetPath: path.join(outputDir, 'flight.txt'),
      }), /extension is not allowlisted/);
    });

    await test('assertSafeRecordingFilePath enforces automation JSONL suffix', () => {
      const target = path.join(outputDir, 'flight.automation.jsonl');
      assert.equal(assertSafeRecordingFilePath({
        extension: '.jsonl',
        operation: 'testAutomationJsonl',
        outputDir,
        requiredSuffix: '.automation.jsonl',
        targetPath: target,
      }), path.resolve(target));

      assert.throws(() => assertSafeRecordingFilePath({
        extension: '.jsonl',
        operation: 'testAutomationJsonlSuffix',
        outputDir,
        requiredSuffix: '.automation.jsonl',
        targetPath: path.join(outputDir, 'flight.jsonl'),
      }), /expected suffix/);
    });

    await test('assertSafeRecordingFilePath enforces aircraft-specific JSONL suffix', () => {
      const target = path.join(outputDir, 'flight.aircraft-specific.jsonl');
      assert.equal(assertSafeRecordingFilePath({
        extension: '.jsonl',
        operation: 'testAircraftSpecificJsonl',
        outputDir,
        requiredSuffix: '.aircraft-specific.jsonl',
        targetPath: target,
      }), path.resolve(target));

      assert.throws(() => assertSafeRecordingFilePath({
        extension: '.jsonl',
        operation: 'testAircraftSpecificJsonlSuffix',
        outputDir,
        requiredSuffix: '.aircraft-specific.jsonl',
        targetPath: path.join(outputDir, 'flight.automation.jsonl'),
      }), /expected suffix/);
    });

    await test('createSafeRecordingWriteStream writes only after guard approval', async () => {
      const target = path.join(outputDir, 'stream.csv');
      const stream = createSafeRecordingWriteStream({
        extension: '.csv',
        flags: 'a',
        operation: 'testCreateStream',
        outputDir,
        targetPath: target,
      });
      await new Promise<void>((resolve, reject) => {
        stream.once('error', reject);
        stream.end('record_type\n', () => resolve());
      });
      assert.equal(fs.readFileSync(target, 'utf8'), 'record_type\n');
    });

    await test('assertSafeRecordingFilePath rejects symlinked recording directories', () => {
      const linkDir = path.join(tempRoot, 'linked-logs');
      try {
        fs.symlinkSync(outputDir, linkDir, 'junction');
      } catch {
        console.log('SKIP assertSafeRecordingFilePath rejects symlinked recording directories: symlink creation unavailable');
        return;
      }

      assert.throws(() => assertSafeRecordingFilePath({
        extension: '.csv',
        operation: 'testSymlinkOutputDir',
        outputDir: linkDir,
        targetPath: path.join(linkDir, 'flight.csv'),
      }), /symbolic link/);
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  if (failed > 0) {
    console.error(`recording-path-guard tests: ${passed} passed, ${failed} failed`);
    process.exit(1);
  }

  console.log(`recording-path-guard tests: ${passed} passed, 0 failed`);
}

main().catch((error) => {
  const err = error as Error;
  console.error(`recording-path-guard tests failed: ${err.message}`);
  process.exit(1);
});

export {};
