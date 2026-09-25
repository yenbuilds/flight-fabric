'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createIsolatedTestEnvironment } = require('../run-test-suite');

const SCRATCH = path.resolve(__dirname, '../../.tmp/repo-hygiene-links');
function fixture(t) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const root = fs.mkdtempSync(path.join(SCRATCH, 'fixture-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), SCRATCH);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const env = createIsolatedTestEnvironment();
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', windowsHide: true });
    assert.ifError(result.error);
    return result;
  };
  const git = (...args) => { const result = run('git', args); assert.equal(result.status, 0, result.stderr); };
  const write = (name, text) => {
    const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
  };
  git('init', '--quiet');
  write('tests/scripts/test-repo-hygiene.js', fs.readFileSync(__dirname + '/test-repo-hygiene.js'));
  return { write, git, check: () => run(process.execPath, ['tests/scripts/test-repo-hygiene.js']) };
}

test('local-only reports fail link hygiene even when present on the maintainer computer', t => {
  for (const report of ['.tmp/report.txt', 'local/report.txt']) {
    const h = fixture(t);
    h.write('.gitignore', '.tmp/\n');
    h.write('README.md', `[Evidence](${report})\n`);
    h.write(report, 'Machine-local evidence');
    h.git('add', '.gitignore', 'README.md');
    const result = h.check();
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /untracked local link target/);
  }
});

test('tracked files, directories and repository-root links pass without local artifacts', t => {
  const h = fixture(t);
  h.write('README.md', '[File](docs/report.txt) [Directory](docs/) [Root](/)\n');
  h.write('docs/report.txt', 'Tracked evidence');
  h.git('add', 'README.md', 'docs/report.txt');
  const result = h.check();
  assert.equal(result.status, 0, result.stderr);
});

test('a link to the exact repository parent is rejected', t => {
  const h = fixture(t);
  h.write('README.md', '[Parent](..)\n');
  h.git('add', 'README.md');
  const result = h.check();
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /links outside the repository/);
});
