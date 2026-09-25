#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const ROOT = path.resolve(__dirname, '../..');
const SITE = path.join(ROOT, 'site/flightfabric');
const OUTPUT = path.join(ROOT, '.tmp/update-signup/browser');
const { releaseInfo, releaseUpdatesInfo, renderDownloadPage } = require('../../scripts/sync-downloads.js');
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function browser() {
  const { app, BrowserWindow, session } = require('electron');
  fs.mkdirSync(OUTPUT, { recursive: true });
  app.setPath('userData', path.join(OUTPUT, `profile-${process.pid}`));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  const release = releaseInfo(JSON.parse(fs.readFileSync(path.join(ROOT, 'published-release.json'), 'utf8')));
  // This enabled configuration exists only in memory; production stays disabled.
  const updates = releaseUpdatesInfo({ enabled: true, action: 'https://blog.flightfabric.com/wp-admin/admin-ajax.php?action=tnp&na=s', privacyUrl: 'https://blog.flightfabric.com/fixture-privacy/' });
  let enabled = true;
  const server = http.createServer((req, res) => {
    if (req.url === '/download/windows/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderDownloadPage(release, enabled ? updates : null));
      return;
    }
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const files = { '/styles.css': 'styles.css', '/download/windows/updates.css': 'download/windows/updates.css' };
    if (!Object.hasOwn(files, pathname)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/css' });
    fs.createReadStream(path.join(SITE, files[pathname])).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await app.whenReady();
  const testSession = session.fromPartition(`release-updates-${process.pid}`);
  const submissions = [];
  let downloads = 0;
  testSession.on('will-download', event => { event.preventDefault(); downloads++; });
  // Every external HTTPS request is intercepted. Neither installer nor email is sent.
  await testSession.protocol.handle('https', async request => {
    const url = new URL(request.url);
    if (url.hostname === 'github.com') {
      return new Response('fixture installer', { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="fixture.exe"' } });
    }
    if (request.url === updates.action && request.method === 'POST') {
      submissions.push(new URLSearchParams(await request.text()));
      return new Response('<!doctype html><title>Fixture confirmation</title><h1>Check your email to confirm</h1>', { headers: { 'Content-Type': 'text/html' } });
    }
    throw new Error(`Unexpected external request: ${url.origin}${url.pathname}`);
  });
  const win = new BrowserWindow({ show: false, width: 1440, height: 1400, useContentSize: true,
    webPreferences: { session: testSession, contextIsolation: true, nodeIntegration: false, sandbox: false } });
  const evaluate = code => win.webContents.executeJavaScript(`(async () => { ${code} })()`, true);
  const load = async () => { await win.loadURL(`${origin}/download/windows/`); await wait(150); };
  try {
    await load();
    assert.ok(downloads >= 1, 'automatic installer download still starts before optional signup');
    for (const width of [1440, 390, 320]) {
      win.setContentSize(width, width > 600 ? 1250 : 1500);
      await wait(100);
      const geometry = await evaluate(`return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        emailHeight: document.querySelector('input[type=email]').getBoundingClientRect().height,
        consentHeight: document.querySelector('.release-updates__consent').getBoundingClientRect().height,
        buttonHeight: document.querySelector('button').getBoundingClientRect().height,
        labels: [...document.querySelectorAll('input:not([type=hidden])')].every(input => input.labels.length > 0),
        scripts: document.scripts.length,
        valid: document.querySelector('form').checkValidity()
      };`);
      assert.equal(geometry.overflow, false, `${width}px horizontal overflow`);
      assert.ok(geometry.emailHeight >= 44 && geometry.consentHeight >= 44 && geometry.buttonHeight >= 44, `${width}px touch targets`);
      assert.equal(geometry.labels, true);
      assert.equal(geometry.scripts, 0, 'signup has no script dependency');
      assert.equal(geometry.valid, false, 'empty form cannot submit');
      fs.writeFileSync(path.join(OUTPUT, `release-updates-${width}.png`), (await win.webContents.capturePage()).toPNG());
      console.log(`PASS release-update layout, labels and touch targets at ${width}px`);
    }
    await evaluate(`document.querySelector('input[type=email]').value = 'tester@example.invalid'; document.querySelector('form').requestSubmit();`);
    await wait(100);
    assert.equal(submissions.length, 0, 'email alone does not give consent');
    await evaluate(`document.querySelector('input[type=checkbox]').checked = true; document.querySelector('input[type=email]').value = 'invalid-address'; document.querySelector('form').requestSubmit();`);
    await wait(100);
    assert.equal(submissions.length, 0, 'invalid email cannot submit');
    await evaluate(`document.querySelector('input[type=email]').value = 'tester@example.invalid'; document.querySelector('form').requestSubmit();`);
    for (let count = 0; count < 100 && win.webContents.getTitle() !== 'Fixture confirmation'; count++) await wait(30);
    assert.equal(win.webContents.getTitle(), 'Fixture confirmation', 'server response controls the next page');
    assert.equal(submissions.length, 1);
    assert.deepEqual([...submissions[0]], [['nlang', ''], ['ne', 'tester@example.invalid'], ['ny', 'on']], 'native POST matches the observed Newsletter contract exactly');
    console.log('PASS consent, email validation and native POST to in-memory handler; no real mail sent');
    enabled = false;
    await load();
    assert.equal(await evaluate('return document.querySelectorAll("form, input[type=email]").length;'), 0, 'disabled signup collects no address');
    assert.ok(downloads >= 2, 'disabled signup preserves automatic installer download');
    console.log('PASS disabled signup leaves downloading independent');
  } finally {
    win.destroy();
    server.close();
  }
}

if (process.versions.electron) {
  browser().then(() => require('electron').app.exit(0), error => { console.error(error); require('electron').app.exit(1); });
} else {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('../../electron/node_modules/electron'), [__filename], { cwd: ROOT, env, windowsHide: true, stdio: 'inherit' });
  const timeout = setTimeout(() => child.kill(), 60000);
  child.on('exit', code => { clearTimeout(timeout); process.exitCode = code ?? 1; });
}
