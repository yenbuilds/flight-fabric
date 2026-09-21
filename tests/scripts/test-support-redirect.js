'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { SUPPORT_URL, supportDestination, syncSupportLink } = require('../../scripts/sync-support-link');
const { resolveAllowedExternalUrl } = require('../../electron/external-url-policy');
const ROOT = path.resolve(__dirname, '../..');

test('published support redirects are current and the app opens the stable URL', async () => {
  assert.deepEqual(syncSupportLink({ check: true }), []);
  const appLinks = await import('../../frontend/src/support/links.js');
  assert.equal(appLinks.SUPPORT_URL, SUPPORT_URL);
  assert.equal(resolveAllowedExternalUrl(SUPPORT_URL), SUPPORT_URL);
  for (const url of [
    `${SUPPORT_URL}?url=https://attacker.example`, `${SUPPORT_URL}?src=app`, `${SUPPORT_URL}#top`,
    'https://www.flightfabric.com/elsewhere/', 'https://www.flightfabric.com.attacker.example/support/',
    'https://ko-fi.com/yenbuilds',
  ]) assert.equal(resolveAllowedExternalUrl(url), null, url);
});

test('support destination validation refuses executable schemes, config injection and loops', () => {
  for (const destination of [undefined, '', 'http://example.com', 'javascript:alert(1)',
    'https://user:password@example.com/', 'https://example.com:8080/',
    'https://example.com/$request_uri', 'https://example.com/";return 301 https://bad.example;',
    'https://example.com/\n', 'https://example.com/\\escape',
    'https://flightfabric.com/support', SUPPORT_URL, `${SUPPORT_URL}index.html`,
  ]) assert.throws(() => supportDestination({ destination }), undefined, String(destination));
});

test('one destination edit updates both temporary server redirect and no-script fallback', () => {
  const scratch = path.join(ROOT, '.tmp');
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'support-redirect-test-'));
  try {
    fs.mkdirSync(path.join(root, 'site'));
    const config = path.join(root, 'site/support-link.json');
    fs.writeFileSync(config, JSON.stringify({ destination: 'https://example.com/support?a=1&b=2' }));
    assert.throws(() => syncSupportLink({ root, check: true }), /stale support redirects/);
    assert.equal(fs.existsSync(path.join(root, 'site/flightfabric')), false, '--check does not write files');
    assert.equal(syncSupportLink({ root }).length, 2);
    assert.deepEqual(syncSupportLink({ root, check: true }), []);
    const html = fs.readFileSync(path.join(root, 'site/flightfabric/support/index.html'), 'utf8');
    const nginx = fs.readFileSync(path.join(root, 'site/nginx/flightfabric-support.conf'), 'utf8');
    assert.match(html, /http-equiv="refresh" content="0; url=https:\/\/example.com\/support\?a=1&amp;b=2"/);
    assert.match(html, /id="support-destination"[^>]*href="https:\/\/example.com\/support\?a=1&amp;b=2"/);
    assert.doesNotMatch(html, /<script|location\.search|document\.referrer/, 'redirect requires neither scripts nor caller data');
    for (const route of ['/support', '/support/', '/support/index.html']) assert(nginx.includes(`location = ${route} {`));
    assert.equal((nginx.match(/return 302 "https:\/\/example.com\/support\?a=1&b=2";/g) || []).length, 3);
    assert.equal((nginx.match(/Cache-Control "no-store" always;/g) || []).length, 3);
    assert.doesNotMatch(nginx, /\$|return 30[178]/, 'no request-controlled target or permanent redirect');
    fs.writeFileSync(config, JSON.stringify({ destination: 'https://example.org/new-provider' }));
    assert.throws(() => syncSupportLink({ root, check: true }), /stale support redirects/);
    assert.equal(syncSupportLink({ root }).length, 2);
    assert(fs.readFileSync(path.join(root, 'site/flightfabric/support/index.html'), 'utf8').includes('https://example.org/new-provider'));
    assert(fs.readFileSync(path.join(root, 'site/nginx/flightfabric-support.conf'), 'utf8').includes('https://example.org/new-provider'));
  } finally {
    assert(path.resolve(root).startsWith(`${path.resolve(scratch)}${path.sep}`));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
