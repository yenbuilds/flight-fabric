#!/usr/bin/env node

'use strict';

const { splitCsvLines, parseCsvLine } = require('./csv');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

function assertDeepEqual(actual, expected, msg) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  assert(actualJson === expectedJson, `${msg || 'values differ'}: expected ${expectedJson}, got ${actualJson}`);
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

console.log('\nCSV Utilities');

test('parseCsvLine parses basic comma-separated values', () => {
  assertDeepEqual(parseCsvLine('a,b,c'), ['a', 'b', 'c'], 'simple CSV');
  assertDeepEqual(parseCsvLine('hello'), ['hello'], 'single field');
  assertDeepEqual(parseCsvLine(''), [''], 'empty input');
});

test('parseCsvLine preserves empty fields and trailing commas', () => {
  assertDeepEqual(parseCsvLine('a,,c'), ['a', '', 'c'], 'empty middle field');
  assertDeepEqual(parseCsvLine('a,b,'), ['a', 'b', ''], 'trailing comma');
});

test('parseCsvLine parses quoted fields, commas, and escaped quotes', () => {
  assertDeepEqual(parseCsvLine('"hello","world"'), ['hello', 'world'], 'quoted fields');
  assertDeepEqual(parseCsvLine('"hello, world",foo'), ['hello, world', 'foo'], 'quoted comma');
  assertDeepEqual(parseCsvLine('"say ""hello""",world'), ['say "hello"', 'world'], 'escaped quote');
  assertDeepEqual(parseCsvLine('plain,"quoted",plain2'), ['plain', 'quoted', 'plain2'], 'mixed quoted/plain fields');
});

test('parseCsvLine optionally trims values', () => {
  assertDeepEqual(parseCsvLine(' a , b '), [' a ', ' b '], 'default whitespace preservation');
  assertDeepEqual(parseCsvLine(' a , b ', { trimValues: true }), ['a', 'b'], 'trimValues=true');
  assertDeepEqual(parseCsvLine('  ,  ', { trimValues: true }), ['', ''], 'trimmed empty fields');
});

test('splitCsvLines keeps quoted multiline rows intact', () => {
  const content = [
    'record_type,escalation_reason',
    'SAMPLE,"alpha, ""beta""\r\ngamma"',
    'LANDING,done',
    '',
  ].join('\n');

  const lines = splitCsvLines(content, { trimAndDropEmpty: true });
  assert(lines.length === 3, `expected 3 logical lines, got ${lines.length}`);
  assert(lines[1] === 'SAMPLE,"alpha, ""beta""\r\ngamma"', `unexpected logical row: ${JSON.stringify(lines[1])}`);
});

test('splitCsvLines handles basic rows and empty input', () => {
  assertDeepEqual(splitCsvLines('a,b\nc,d\ne,f'), ['a,b', 'c,d', 'e,f'], 'basic newline splitting');
  assertDeepEqual(splitCsvLines('a,b\n\nc,d'), ['a,b', 'c,d'], 'default empty-line filtering');
  assertDeepEqual(splitCsvLines('a,b\n   \nc,d', { trimAndDropEmpty: true }), ['a,b', 'c,d'], 'drop whitespace-only lines');
  assertDeepEqual(splitCsvLines(''), [], 'empty content');
});

test('splitCsvLines handles CRLF row endings outside quoted fields', () => {
  const content = 'a,b\r\nc,d\r\n';
  const lines = splitCsvLines(content, { trimAndDropEmpty: true });
  assert(lines.length === 2, `expected 2 lines, got ${lines.length}`);
  assert(lines[0] === 'a,b', `unexpected first line: ${JSON.stringify(lines[0])}`);
  assert(lines[1] === 'c,d', `unexpected second line: ${JSON.stringify(lines[1])}`);
});

test('splitCsvLines preserves line endings inside quoted fields', () => {
  const content = 'id,notes\r1,"first\nsecond"\r\n2,"third\r\nfourth"\n3,done';
  assertDeepEqual(splitCsvLines(content), [
    'id,notes',
    '1,"first\nsecond"',
    '2,"third\r\nfourth"',
    '3,done',
  ], 'mixed record and embedded line endings');
});

test('splitCsvLines handles escaped quotes adjacent to record boundaries', () => {
  const content = 'id,notes\n1,"say ""hello"""\n2,done\n';
  assertDeepEqual(splitCsvLines(content), [
    'id,notes',
    '1,"say ""hello"""',
    '2,done',
  ], 'escaped quotes should not leave the scanner inside a quoted field');
});

test('splitCsvLines keeps default whitespace-only rows but drops empty rows', () => {
  assertDeepEqual(splitCsvLines('a\n   \n\nb'), ['a', '   ', 'b'], 'default filtering');
  assertDeepEqual(
    splitCsvLines('a\n   \n\nb', { trimAndDropEmpty: true }),
    ['a', 'b'],
    'trimmed filtering',
  );
});

test('parseCsvLine round-trips commas, quotes, and embedded CRLF', () => {
  const values = parseCsvLine('SAMPLE,"alpha, ""beta""\r\ngamma",ok');
  assert(values.length === 3, `expected 3 values, got ${values.length}`);
  assert(values[0] === 'SAMPLE', `unexpected record_type: ${values[0]}`);
  assert(values[1] === 'alpha, "beta"\r\ngamma', `unexpected quoted field: ${JSON.stringify(values[1])}`);
  assert(values[2] === 'ok', `unexpected tail field: ${values[2]}`);
});

test('parseCsvLine preserves legacy permissive quote handling', () => {
  assertDeepEqual(parseCsvLine('a"b"c,d'), ['abc', 'd'], 'quotes embedded in an unquoted value');
  assertDeepEqual(parseCsvLine('"unterminated,value'), ['unterminated,value'], 'unterminated quoted value');
  assertDeepEqual(parseCsvLine('"",tail'), ['', 'tail'], 'empty quoted value');
});

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) process.exit(1);

export {};
