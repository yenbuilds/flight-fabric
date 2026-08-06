'use strict';

const assert = require('assert') as typeof import('assert');
const fs = require('fs') as typeof import('fs');
const os = require('os') as typeof import('os');
const path = require('path') as typeof import('path');
const {
  safeReplaceTextFileSync,
  safeUnlinkSync,
} = require('./safe-fs.js') as {
  safeReplaceTextFileSync: (_options: {
    allowedExtensions?: string[];
    data: string;
    operation: string;
    rootDir: string;
    targetPath: string;
  }) => string;
  safeUnlinkSync: (_options: {
    allowedExtensions?: string[];
    operation: string;
    rootDir: string;
    targetPath: string;
  }) => boolean;
};

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
    passed += 1;
  } catch (error) {
    failed += 1;
    const err = error as Error;
    console.error(`FAIL ${name}: ${err.message}`);
  }
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-safe-fs-test-'));
const ownedRoot = path.join(tempRoot, 'owned');
const outsideRoot = path.join(tempRoot, 'outside');
fs.mkdirSync(ownedRoot, { recursive: true });
fs.mkdirSync(outsideRoot, { recursive: true });

try {
  test('safeReplaceTextFileSync writes inside an allowed root', () => {
    const target = path.join(ownedRoot, 'state.json');
    safeReplaceTextFileSync({
      allowedExtensions: ['.json'],
      data: '{"ok":true}',
      operation: 'testWrite',
      rootDir: ownedRoot,
      targetPath: target,
    });
    assert.equal(fs.readFileSync(target, 'utf8'), '{"ok":true}');
  });

  test('safeReplaceTextFileSync does not share a predictable temporary path', () => {
    const target = path.join(ownedRoot, 'exclusive.json');
    const legacyTemp = `${target}.tmp`;
    fs.writeFileSync(legacyTemp, 'unrelated', 'utf8');
    safeReplaceTextFileSync({
      allowedExtensions: ['.json'],
      data: '{"exclusive":true}',
      operation: 'testExclusiveTemp',
      rootDir: ownedRoot,
      targetPath: target,
    });
    assert.equal(fs.readFileSync(target, 'utf8'), '{"exclusive":true}');
    assert.equal(fs.readFileSync(legacyTemp, 'utf8'), 'unrelated');
    assert.deepEqual(
      fs.readdirSync(ownedRoot).filter((name) => (
        name !== path.basename(legacyTemp)
        && name.startsWith('exclusive.json.')
        && name.endsWith('.tmp')
      )),
      [],
    );
  });

  test('safeReplaceTextFileSync refuses traversal outside the root', () => {
    assert.throws(() => safeReplaceTextFileSync({
      allowedExtensions: ['.json'],
      data: '{}',
      operation: 'testTraversalWrite',
      rootDir: ownedRoot,
      targetPath: path.join(ownedRoot, '..', 'outside', 'state.json'),
    }), /outside the allowed root/);
  });

  test('safeUnlinkSync refuses wrong extensions', () => {
    const target = path.join(ownedRoot, 'notes.txt');
    fs.writeFileSync(target, 'do not delete', 'utf8');
    assert.throws(() => safeUnlinkSync({
      allowedExtensions: ['.json'],
      operation: 'testDeleteWrongExtension',
      rootDir: ownedRoot,
      targetPath: target,
    }), /extension is not allowlisted/);
    assert.equal(fs.existsSync(target), true);
  });

  test('safeUnlinkSync deletes an allowed file inside the root', () => {
    const target = path.join(ownedRoot, 'old.json');
    fs.writeFileSync(target, '{}', 'utf8');
    assert.equal(safeUnlinkSync({
      allowedExtensions: ['.json'],
      operation: 'testDelete',
      rootDir: ownedRoot,
      targetPath: target,
    }), true);
    assert.equal(fs.existsSync(target), false);
  });

  test('safeUnlinkSync refuses symbolic links', () => {
    const realTarget = path.join(outsideRoot, 'real.json');
    const symlinkPath = path.join(ownedRoot, 'linked.json');
    fs.writeFileSync(realTarget, '{"outside":true}', 'utf8');
    try {
      fs.symlinkSync(realTarget, symlinkPath);
    } catch {
      console.log('SKIP safeUnlinkSync refuses symbolic links: symlink creation unavailable');
      return;
    }

    assert.throws(() => safeUnlinkSync({
      allowedExtensions: ['.json'],
      operation: 'testDeleteSymlink',
      rootDir: ownedRoot,
      targetPath: symlinkPath,
    }), /symbolic link/);
    assert.equal(fs.existsSync(realTarget), true);
  });

  test('safeReplaceTextFileSync refuses symlinked parent directories', () => {
    const linkDir = path.join(ownedRoot, 'linked-dir');
    const outsideTarget = path.join(outsideRoot, 'escaped.json');
    try {
      fs.symlinkSync(outsideRoot, linkDir, 'junction');
    } catch {
      console.log('SKIP safeReplaceTextFileSync refuses symlinked parent directories: symlink creation unavailable');
      return;
    }

    assert.throws(() => safeReplaceTextFileSync({
      allowedExtensions: ['.json'],
      data: '{"escaped":true}',
      operation: 'testWriteThroughSymlinkParent',
      rootDir: ownedRoot,
      targetPath: path.join(linkDir, 'escaped.json'),
    }), /symbolic link|escapes the allowed root/);
    assert.equal(fs.existsSync(outsideTarget), false);
  });
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`safe-fs tests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`safe-fs tests: ${passed} passed, 0 failed`);
