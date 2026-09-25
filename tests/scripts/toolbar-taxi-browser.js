'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function ({ win, page, root, click, key, press, until, width }) {
  await click('#tab-button-taxi');
  const type = text => { for (const c of text) { key('keyDown', c); key('char', c); key('keyUp', c); } };
  const fill = async (id, text) => { await click(id); key('keyDown', 'A', ['control']); key('keyUp', 'A', ['control']); type(text); };
  await page(`await fetch('/fixture/taxi?position=live&pushback=false&phase=preview');`);
  await click('#taxi-mode'); press('Home'); press('Enter');
  await fill('#taxi-airport', 'YSSY'); await fill('#taxi-runway', '16R');
  await until(page, `return !document.querySelector('#taxi-show-route').disabled;`);
  await click('#taxi-show-route');
  // Holding Enter on the just-disabled button cannot submit duplicate routes.
  key('keyDown', 'Enter'); key('keyDown', 'Enter'); key('keyUp', 'Enter');
  await until(page, `return !document.querySelector('.taxi-figure').hidden;`);
  await wait(550);
  if (await page(`return document.querySelector('#taxi-view').textContent === 'Follow aircraft';`)) await click('#taxi-view');
  assert.match(await page(`return document.querySelector('.taxi-caption').textContent;`), /m to holding point before runway 16R/);
  assert.ok(await page(`return document.querySelectorAll('.taxi-figure svg path').length > 20;`));
  assert.equal(await root('return keyboardClaimed;'), true, 'Taxi buttons retain capture through pending state');
  await click('#taxi-airport');
  await page(`window.taxiInput = document.activeElement; document.activeElement.setSelectionRange(1, 3);`);
  await wait(1100);
  assert.deepEqual(await page(`return [document.activeElement === window.taxiInput, document.activeElement.selectionStart, document.activeElement.selectionEnd];`), [true, 1, 3]);
  const output = path.resolve(__dirname, '../../.tmp/toolbar-taxi'); fs.mkdirSync(output, { recursive: true });
  await page(`document.querySelector('.taxi-figure').scrollIntoView({block:'center'});`); await wait(80);
  fs.writeFileSync(path.join(output, 'taxi-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
  if (width === 320) {
    await page(`document.documentElement.setAttribute('data-theme', 'light');`); await wait(100);
    fs.writeFileSync(path.join(output, 'taxi-320-light.png'), (await win.webContents.capturePage()).toPNG());
    await page(`document.documentElement.setAttribute('data-theme', 'dark');`);
  }
  assert.equal(await page(`return document.documentElement.scrollWidth > innerWidth;`), false, 'Taxi fits ' + width);
  await click('#taxi-view');
  assert.equal(await page(`return document.querySelector('#taxi-view').textContent;`), 'Follow aircraft');
  assert.ok(await page(`return !!document.querySelector('.taxi-marker');`));
  await page(`await fetch('/fixture/taxi?position=stale');`);
  await until(page, `return document.querySelector('.taxi-caption').textContent.includes('Reference only');`);
  assert.equal(await page(`return !!document.querySelector('.taxi-marker');`), false, 'stale route has no live aircraft marker');
  await page(`await fetch('/fixture/taxi?position=off');`);
  await until(page, `return document.querySelector('.taxi-caption').textContent.includes('Off route');`);
  await page(`await fetch('/fixture/taxi?position=live');`);
  await click('#taxi-hide-route');
  assert.equal(await page(`return document.querySelector('.taxi-figure').hidden;`), true);
  // Native select keyboard events must remain captured, just like text fields.
  await click('#taxi-mode'); press('End'); press('Enter');
  await until(page, `return document.querySelector('#taxi-mode').value;`, 'stand');
  await click('#taxi-load-stands');
  await until(page, `return document.querySelector('#taxi-stand').options.length;`, 3);
  await click('#taxi-stand'); press('Home'); press('Down'); press('Enter');
  await until(page, `return document.querySelector('#taxi-stand').value;`, 'Gate A 12');
  await until(page, `return !document.querySelector('#taxi-show-route').disabled;`);
  await click('#taxi-show-route');
  await until(page, `return !document.querySelector('.taxi-figure').hidden;`);
  await until(page, `return document.querySelector('.taxi-caption').textContent.includes('Gate A 12');`);
  const requests = await page(`return await (await fetch('/fixture/taxi')).json();`);
  assert.ok(requests.every(r => ['status', 'preview', 'parkings'].includes(r.operation)));
  assert.equal(requests.filter(r => r.operation === 'preview' && !r.pushback).length, (width === 1200 ? 1 : width === 375 ? 2 : 3) * 2, 'one request per explicit Show route click');
  // The same departure diagram appears automatically, with no control command.
  await page(`await fetch('/fixture/taxi?pushback=true');`);
  await click('#taxi-mode'); press('Home'); press('Enter');
  await until(page, `return !!document.querySelector('[data-pushback-path]');`);
  assert.equal(await page(`return document.querySelectorAll('.taxi-figure').length;`), 1);
  assert.equal(await page(`return !!document.querySelector('[data-pushback-final-heading]') && !!document.querySelector('[data-taxi-onward]');`), true);
  assert.match(await page(`return document.querySelector('.taxi-caption').textContent;`), /Pushback preview/);
  await page(`await fetch('/fixture/pushback?brake=true');`);
  await until(page, `return document.querySelector('#taxi-pushback-action').disabled;`);
  await until(page, `return document.querySelector('#taxi-pushback-reason').textContent.includes('parking brake');`);
  await page(`document.querySelector('.taxi-figure').scrollIntoView({block:'center'});`); await wait(180);
  fs.writeFileSync(path.join(output, 'pushback-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
  await click('#taxi-view');
  assert.equal(await page(`return !!document.querySelector('[data-pushback-map]');`), false);
  await click('#taxi-pushback-view'); press('Enter');
  assert.equal(await root('return keyboardClaimed;'), true, 'preview view buttons preserve keyboard capture');
  await page(`await fetch('/fixture/pushback?brake=false');`);
  await until(page, `return !document.querySelector('#taxi-pushback-action').disabled;`);
  const beforePush = await page(`return (await (await fetch('/fixture/pushback')).json()).filter(r => r.operation === 'start').length;`);
  await page(`document.querySelector('#taxi-pushback-action').focus(); window.pushbackButton = document.activeElement;`);
  const parentBeforePush = await root('return parentInputs.slice();');
  key('keyDown', 'Enter'); key('char', '\r');
  await until(page, `return document.querySelector('#taxi-pushback-action').textContent === 'Stop pushback';`);
  key('keyDown', 'Enter', ['isautorepeat']); key('char', '\r', ['isautorepeat']); key('keyUp', 'Enter');
  await wait(400);
  assert.equal(await page(`return document.activeElement === window.pushbackButton && window.pushbackButton.textContent === 'Stop pushback';`), true,
    'the same focused button becomes Stop; held Enter does not stop the new manoeuvre');
  assert.equal(await page(`return (await (await fetch('/fixture/pushback')).json()).filter(r => r.operation === 'start').length;`), beforePush + 1);
  assert.equal(await root('return keyboardClaimed;'), true);
  assert.deepEqual(await root('return parentInputs;'), parentBeforePush, 'pushback keyboard events stay inside the toolbar iframe');
  assert.equal(await page(`return document.querySelector('#taxi-airport').disabled && document.querySelector('#taxi-runway').disabled;`), true);
  await until(page, `return document.querySelector('.taxi-caption').textContent.includes('48 m remaining');`);
  await wait(100); // Capture the painted live state, not the preceding preview frame.
  fs.writeFileSync(path.join(output, 'pushback-active-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
  await page(`window.pushbackMarker = document.querySelector('[data-pushback-aircraft]');`);
  await wait(550);
  assert.equal(await page(`return window.pushbackMarker === document.querySelector('[data-pushback-aircraft]');`), true,
    'toolbar live updates retain the animated marker');
  assert.equal(await page(`return document.querySelector('[data-pushback-progress]').getAttribute('data-pushback-progress');`), '38');
  await page(`await fetch('/fixture/taxi?position=stale');`);
  await until(page, `return document.querySelector('.taxi-caption').textContent.includes('Reference only');`);
  assert.equal(await page(`return !!document.querySelector('[data-pushback-aircraft]');`), false);
  await page(`await fetch('/fixture/taxi?position=live&phase=complete');`);
  await until(page, `return !document.querySelector('[data-pushback-map]');`);
  await until(page, `return document.querySelector('#taxi-pushback-reason').textContent.includes('Pushback complete');`);
  assert.ok((await page(`return await (await fetch('/fixture/taxi')).json();`)).every(r => ['status', 'preview', 'parkings'].includes(r.operation)));
  assert.equal(await page(`return document.documentElement.scrollWidth > innerWidth;`), false);
  // Explicit Stop and closing the tab each end a toolbar-owned manoeuvre.
  await page(`await fetch('/fixture/taxi?phase=preview');`);
  await until(page, `return !document.querySelector('#taxi-pushback-action').hidden && !document.querySelector('#taxi-pushback-action').disabled;`);
  await click('#taxi-pushback-action');
  await until(page, `return document.querySelector('#taxi-pushback-action').textContent === 'Stop pushback';`);
  await click('#taxi-pushback-action');
  await until(page, `return document.querySelector('#taxi-pushback-action').textContent === 'Push back' && !document.querySelector('#taxi-pushback-action').disabled;`);
  await click('#taxi-pushback-action');
  await until(page, `return document.querySelector('#taxi-pushback-action').textContent === 'Stop pushback';`);
  const stops = await page(`return (await (await fetch('/fixture/pushback')).json()).filter(r => r.operation === 'stop').length;`);
  await click('#tab-button-flight');
  await until(page, `return (await (await fetch('/fixture/pushback')).json()).filter(r => r.operation === 'stop').length;`, stops + 1);
  const before = (await page(`return await (await fetch('/fixture/taxi')).json();`)).length;
  await wait(1100);
  assert.equal((await page(`return await (await fetch('/fixture/taxi')).json();`)).length, before, 'inactive Taxi tab stops polling');
  if (width === 1200) {
    await click('#tab-button-taxi');
    await until(page, `return !document.querySelector('#taxi-pushback-action').disabled;`);
    await click('#taxi-pushback-action');
    await until(page, `return document.querySelector('#taxi-pushback-action').textContent === 'Stop pushback';`);
    const beforeHide = await page(`return await (await fetch('/fixture/pushback')).json();`);
    await root(`host.classList.add('panelInvisible');`);
    await until(page, `return (await (await fetch('/fixture/pushback')).json()).filter(r => r.operation === 'stop').length;`, beforeHide.filter(r => r.operation === 'stop').length + 1);
    await until(root, 'return keyboardClaimed;', false);
    await root(`host.classList.remove('panelInvisible');`);
    await until(root, `return document.querySelector('flightfabric-panel').panelActive;`);
    await until(page, `return document.querySelector('#taxi-pushback-action').textContent === 'Push back' && !document.querySelector('#taxi-pushback-action').disabled;`);
    await wait(1100);
    assert.equal(await page(`return (await (await fetch('/fixture/pushback')).json()).filter(r => r.operation === 'start').length;`), beforeHide.filter(r => r.operation === 'start').length,
      'reopening the native panel never restarts pushback');
    await click('#tab-button-flight');
  }
};
