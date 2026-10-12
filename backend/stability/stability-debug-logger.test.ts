import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

type Logger = {
  isEnabled: () => boolean;
  writeLog: (category: string, message: string, data?: Record<string, unknown>) => void;
};

function loadLogger() {
  const config = { stability: { debugLog: false } };
  const io: string[] = [];
  const lines: string[] = [];
  const errors: string[] = [];
  let now = 10_000;
  let streamCount = 0;
  let sizeBytes = 0;
  const filesystem = {
    existsSync: (directory: string) => {
      io.push(`exists:${directory}`);
      return false;
    },
    mkdirSync: (directory: string) => { io.push(`mkdir:${directory}`); },
    statSync: (file: string) => {
      io.push(`stat:${file}`);
      return { size: sizeBytes };
    },
    renameSync: (from: string, to: string) => { io.push(`rename:${from}:${to}`); },
    createWriteStream: (file: string, options: { flags: string }) => {
      assert.equal(options.flags, 'a');
      const streamId = ++streamCount;
      io.push(`open:${file}`);
      return {
        on: (event: string) => { assert.equal(event, 'error'); },
        write: (line: string) => { lines.push(line); },
        end: () => { io.push(`end:${streamId}`); },
      };
    },
  };
  const module = { exports: {} as Logger };
  runInNewContext(readFileSync(path.join(__dirname, 'stability-debug-logger.js'), 'utf8'), {
    __dirname,
    module,
    exports: module.exports,
    console: { error: (...args: unknown[]) => { errors.push(args.join(' ')); } },
    require: (id: string) => {
      if (id === 'fs') return filesystem;
      if (id === 'path') return path;
      if (id === '../core/config.js') return config;
      if (id === '../core/time-source.js') return { now: () => now };
      throw new Error(`Unexpected logger dependency: ${id}`);
    },
  });
  return {
    logger: module.exports,
    config,
    io,
    lines,
    errors,
    advance: (milliseconds: number) => { now += milliseconds; },
    setSize: (bytes: number) => { sizeBytes = bytes; },
  };
}

test('stability logging follows its enable setting and performs no disabled writes', () => {
  const { logger, config, io, lines, errors } = loadLogger();
  assert.equal(logger.isEnabled(), false);
  logger.writeLog('RAW_INPUT', 'disabled sample');
  assert.deepEqual(io, []);
  assert.deepEqual(lines, []);

  config.stability.debugLog = true;
  assert.equal(logger.isEnabled(), true);
  logger.writeLog('RAW_INPUT', 'enabled sample');
  assert.equal(lines.length, 1);
  assert.equal(io.filter((operation) => operation.startsWith('mkdir:')).length, 1);
  assert.equal(io.filter((operation) => operation.startsWith('open:')).length, 1);

  config.stability.debugLog = false;
  logger.writeLog('SCORE', 'disabled again');
  assert.equal(lines.length, 1);
  assert.deepEqual(errors, []);
});

test('stability logger preserves structured values and throttles repeated raw samples', () => {
  const { logger, config, advance, lines, errors } = loadLogger();
  config.stability.debugLog = true;
  logger.writeLog('RAW_INPUT', 'Approach sample', {
    ias: 142,
    gearDown: true,
    unavailable: null,
    absent: undefined,
    details: { flaps: 30 },
  });
  assert.match(lines[0], /\[RAW_INPUT\] Approach sample \| ias=142\.00, gearDown=true, unavailable=null, absent=undefined, details=\{"flaps":30\}\n$/);
  advance(999);
  logger.writeLog('RAW_INPUT', 'suppressed sample');
  logger.writeLog('SCORE', 'Score computed', { overall: 95.5 });
  assert.equal(lines.length, 2, 'scoring details are independent of the raw-sample throttle');
  advance(1);
  logger.writeLog('RAW_INPUT', 'next sample');
  assert.equal(lines.length, 3);
  assert.match(lines[2], /\[RAW_INPUT\] next sample\n$/);
  assert.deepEqual(errors, []);
});

test('stability log rotation closes the previous stream and preserves the triggering entry', () => {
  const { logger, config, io, lines, setSize, errors } = loadLogger();
  config.stability.debugLog = true;
  setSize(10 * 1024 * 1024);
  for (let index = 0; index < 49; index += 1) logger.writeLog('SCORE', `score ${index}`);
  assert.equal(io.some((operation) => operation.startsWith('stat:')), false);
  logger.writeLog('SCORE', 'rotation entry');
  assert.equal(lines.length, 50);
  assert.match(lines[49], /\[SCORE\] rotation entry\n$/);
  assert.equal(io.filter((operation) => operation.startsWith('open:')).length, 2);
  assert.equal(io.filter((operation) => operation.startsWith('rename:')).length, 1);
  const closeIndex = io.indexOf('end:1');
  const renameIndex = io.findIndex((operation) => operation.startsWith('rename:'));
  assert.ok(closeIndex >= 0 && closeIndex < renameIndex);
  assert.deepEqual(errors, []);
});
