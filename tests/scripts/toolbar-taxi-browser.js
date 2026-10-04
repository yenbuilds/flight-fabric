'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function ({ win, page, root, click, key, press, until, width }) {
  await click('#tab-button-taxi');
  assert.match(await page(`return document.querySelector('#tab-button-taxi').textContent;`), /Pushback & taxi/);
  assert.deepEqual(await page(`return [...document.querySelectorAll('.tab-button:not([hidden])')].filter(button => {
    const range = document.createRange(); range.selectNodeContents(button.querySelector('span'));
    const label = range.getBoundingClientRect(), bounds = button.getBoundingClientRect();
    return label.left < bounds.left - 1 || label.right > bounds.right + 1 || label.bottom > bounds.bottom + 1;
  }).map(button => button.textContent);`), [], 'toolbar navigation labels fit their targets at ' + width);
  const type = text => { for (const c of text) { key('keyDown', c); key('char', c); key('keyUp', c); } };
  const fill = async (id, text) => { await click(id); key('keyDown', 'A', ['control']); key('keyUp', 'A', ['control']); type(text); };
  const assertSimpleMap = async () => {
    const map = await page(`const svg = document.querySelector('.taxi-figure svg');
      const route = svg.querySelector('.taxi-simple-route');
      return { mode: svg.getAttribute('data-taxi-map'), route: route && route.tagName.toLowerCase(),
        fill: route && getComputedStyle(route).fill, paths: svg.querySelectorAll('path').length,
        nodes: svg.querySelectorAll('*').length, aircraftLines: svg.querySelectorAll('.taxi-simple-aircraft line').length };`);
    assert.equal(map.mode, '2d');
    assert.equal(map.route, 'polyline');
    assert.equal(map.fill, 'none');
    assert.equal(map.paths, 0, 'the toolbar taxi map has no filled or compound SVG paths');
    assert.equal(map.aircraftLines, 3, 'the live aircraft is a small line marker');
    assert.ok(map.nodes <= 16, 'the route diagram has a bounded number of SVG nodes');
  };
  const markerVisible = `const marker = document.querySelector('.taxi-simple-aircraft');
    return !!marker && getComputedStyle(marker).display !== 'none' && getComputedStyle(marker).visibility !== 'hidden';`;
  await page(`await fetch('/fixture/taxi?position=live&pushback=false&phase=preview&departing=false');`);
  await click('#taxi-mode'); press('Home'); press('Enter');
  await fill('#taxi-airport', 'YSSY'); await fill('#taxi-runway', '16R');
  await until(page, `return !document.querySelector('#taxi-show-route').disabled;`);
  await click('#taxi-show-route');
  // Holding Enter on the just-disabled button cannot submit duplicate routes.
  key('keyDown', 'Enter'); key('keyDown', 'Enter'); key('keyUp', 'Enter');
  await until(page, `return !document.querySelector('.taxi-figure').hidden;`);
  await wait(550);
  assert.match(await page(`return document.querySelector('.taxi-caption').textContent;`), /m to holding point before runway 16R/);
  await assertSimpleMap();
  assert.equal(await page(`return document.querySelector('#taxi-view').hidden;`), true, 'a standalone taxi route needs no view toggle');
  await page(`window.taxiRouteNode = document.querySelector('.taxi-simple-route');
    window.taxiRoutePoints = window.taxiRouteNode.getAttribute('points');
    window.taxiMapNodeCount = document.querySelector('.taxi-figure svg').querySelectorAll('*').length;`);
  assert.equal(await root('return keyboardClaimed;'), true, 'Taxi buttons retain capture through pending state');
  await click('#taxi-airport');
  await page(`window.taxiInput = document.activeElement; document.activeElement.setSelectionRange(1, 3);`);
  await wait(1100);
  assert.deepEqual(await page(`return [document.activeElement === window.taxiInput, document.activeElement.selectionStart, document.activeElement.selectionEnd];`), [true, 1, 3]);
  assert.equal(await page(`return document.querySelector('.taxi-simple-route') === window.taxiRouteNode;`), true,
    'status polling retains the existing route geometry');
  const output = path.resolve(__dirname, '../../.tmp/toolbar-taxi'); fs.mkdirSync(output, { recursive: true });
  await page(`document.querySelector('.taxi-figure').scrollIntoView({block:'center'});`); await wait(80);
  fs.writeFileSync(path.join(output, 'taxi-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
  if (width === 320) {
    await page(`document.documentElement.setAttribute('data-theme', 'light');`); await wait(100);
    fs.writeFileSync(path.join(output, 'taxi-320-light.png'), (await win.webContents.capturePage()).toPNG());
    await page(`document.documentElement.setAttribute('data-theme', 'dark');`);
  }
  assert.equal(await page(`return document.documentElement.scrollWidth > innerWidth;`), false, 'Taxi fits ' + width);
  assert.equal(await page(markerVisible), true);
  await page(`await fetch('/fixture/taxi?position=stale');`);
  await until(page, `return document.querySelector('.taxi-caption').textContent.includes('Reference only');`);
  assert.equal(await page(markerVisible), false, 'stale route does not show a live aircraft marker');
  await page(`await fetch('/fixture/taxi?position=off');`);
  await until(page, `return document.querySelector('.taxi-caption').textContent.includes('Off route');`);
  await assertSimpleMap();
  assert.deepEqual(await page(`return [document.querySelector('.taxi-simple-route') === window.taxiRouteNode,
    document.querySelector('.taxi-simple-route').getAttribute('points') === window.taxiRoutePoints,
    document.querySelector('.taxi-figure svg').querySelectorAll('*').length === window.taxiMapNodeCount];`), [true, true, true],
    'stale and changed aircraft positions preserve fixed route geometry without growing the map');
  await page(`await fetch('/fixture/taxi?position=live');`);
  await until(page, `return document.querySelector('.taxi-caption').textContent.includes('m to holding point');`);
  assert.equal(await page(markerVisible), true, 'fresh telemetry restores the aircraft marker');
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
  assert.match(await page(`return document.querySelector('#taxi-intro').textContent;`), /automatically pushes.*turns.*stops/);
  assert.match(await page(`return document.querySelector('#taxi-pushback-help').textContent;`), /Start pushback to move the aircraft/);
  await page(`document.querySelector('#toolbar-taxi').scrollIntoView({block:'start'});`); await wait(100);
  fs.writeFileSync(path.join(output, 'pushback-setup-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
  assert.equal(await page(`return document.querySelectorAll('.taxi-figure').length;`), 1);
  assert.equal(await page(`return !!document.querySelector('[data-pushback-final-heading]') && !!document.querySelector('[data-taxi-onward]');`), true);
  assert.match(await page(`return document.querySelector('.taxi-caption').textContent;`), /Pushback preview/);
  await page(`await fetch('/fixture/pushback?brake=true');`);
  await until(page, `return document.querySelector('#taxi-pushback-action').disabled;`);
  await until(page, `return document.querySelector('#taxi-pushback-reason').textContent.includes('parking brake');`);
  await page(`document.querySelector('.taxi-figure').scrollIntoView({block:'center'});`); await wait(180);
  fs.writeFileSync(path.join(output, 'pushback-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
  assert.equal(await page(`return document.querySelector('#taxi-view').textContent;`), 'Taxi map');
  assert.equal(await page(`return document.querySelector('#taxi-view').hidden;`), false);
  await click('#taxi-view');
  assert.equal(await page(`return !!document.querySelector('[data-pushback-map]');`), false);
  assert.equal(await page(`return document.querySelector('#taxi-view').getAttribute('aria-pressed');`), 'true');
  await assertSimpleMap();
  await page(`window.departureRouteNode = document.querySelector('.taxi-simple-route');
    window.departureMapNodeCount = document.querySelector('.taxi-figure svg').querySelectorAll('*').length;`);
  const departureReplies = await page(`return (await (await fetch('/fixture/taxi')).json()).filter(r => r.pushback && r.operation === 'status').length;`);
  await until(page, `return (await (await fetch('/fixture/taxi')).json()).filter(r => r.pushback && r.operation === 'status').length >= ${departureReplies + 2};`);
  assert.deepEqual(await page(`return [document.querySelector('.taxi-simple-route') === window.departureRouteNode,
    document.querySelector('.taxi-figure svg').querySelectorAll('*').length === window.departureMapNodeCount];`), [true, true],
    'freshly deserialized departure replies retain route nodes and keep the map size bounded');
  await click('#taxi-pushback-view'); press('Enter');
  await until(page, `return !!document.querySelector('[data-pushback-map]');`);
  assert.equal(await page(`return document.querySelector('#taxi-view').getAttribute('aria-pressed');`), 'false');
  await click('#taxi-view');
  await assertSimpleMap();
  assert.equal(await page(`return !!document.querySelector('[data-pushback-aircraft]');`), false, 'taxi map reentry removes pushback geometry');
  await click('#taxi-pushback-view');
  await until(page, `return !!document.querySelector('[data-pushback-path]');`);
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
  await assertSimpleMap();
  await until(page, `return document.querySelector('#taxi-pushback-reason').textContent.includes('Pushback complete');`);
  assert.ok((await page(`return await (await fetch('/fixture/taxi')).json();`)).every(r => ['status', 'preview', 'parkings'].includes(r.operation)));
  assert.equal(await page(`return document.documentElement.scrollWidth > innerWidth;`), false);
  // Explicit Stop and closing the tab each end a toolbar-owned manoeuvre.
  await page(`await fetch('/fixture/taxi?phase=preview');`);
  await until(page, `return !document.querySelector('#taxi-pushback-action').hidden && !document.querySelector('#taxi-pushback-action').disabled;`);
  await click('#taxi-pushback-action');
  await until(page, `return document.querySelector('#taxi-pushback-action').textContent === 'Stop pushback';`);
  await click('#taxi-pushback-action');
  await until(page, `return document.querySelector('#taxi-pushback-action').textContent === 'Start pushback' && !document.querySelector('#taxi-pushback-action').disabled;`);
  if (width === 1200) {
    await click('#taxi-view');
    await assertSimpleMap();
    await page(`window.departingRoute = document.querySelector('.taxi-simple-route');
      window.departingPoints = window.departingRoute.getAttribute('points');
      window.departingMarker = document.querySelector('.taxi-simple-aircraft');
      window.departingPose = window.departingMarker.getAttribute('transform');
      window.departingNodes = [...document.querySelector('.taxi-figure svg').querySelectorAll('*')];`);
    const previewCount = await page(`return (await (await fetch('/fixture/taxi')).json()).filter(r => r.pushback && r.operation === 'preview').length;`);
    const controlCount = await page(`return (await (await fetch('/fixture/pushback')).json()).filter(r => r.operation !== 'status').length;`);
    await page(`await fetch('/fixture/taxi?departing=true');`);
    for (let sample = 0; sample < 3; sample++) {
      await until(page, `const marker = document.querySelector('.taxi-simple-aircraft');
        return marker === window.departingMarker && getComputedStyle(marker).display !== 'none'
          && marker.getAttribute('transform') !== window.departingPose;`);
      const pose = await page(`window.departingPose = window.departingMarker.getAttribute('transform');
        const box = window.departingMarker.getBoundingClientRect();
        return { transform: window.departingPose, width: box.width, height: box.height };`);
      assert.ok(pose.width > 0 && pose.height > 0, 'the retained aircraft marker has a visible browser layout');
    }
    const retainedMap = `return document.querySelector('.taxi-simple-route') === window.departingRoute
      && window.departingRoute.getAttribute('points') === window.departingPoints
      && [...document.querySelector('.taxi-figure svg').querySelectorAll('*')].every((node, i) => node === window.departingNodes[i])
      && document.querySelector('.taxi-figure svg').querySelectorAll('*').length === window.departingNodes.length;`;
    assert.equal(await page(retainedMap), true, 'moving status retains every route/marker node without map growth');
    assert.equal(await page(`return document.querySelector('#taxi-pushback-action').disabled;`), true, 'the invalid moving plan cannot start pushback');
    await page(`await fetch('/fixture/taxi?position=stale');`);
    await until(page, markerVisible, false);
    await page(`await fetch('/fixture/taxi?position=live');`);
    await until(page, markerVisible);
    assert.equal(await page(retainedMap), true, 'stale recovery keeps the same map and restores its marker');
    assert.equal(await page(`return (await (await fetch('/fixture/taxi')).json()).filter(r => r.pushback && r.operation === 'preview').length;`), previewCount,
      'moving and stale positions keep status polling instead of attempting pushback recapture');
    assert.equal(await page(`return (await (await fetch('/fixture/pushback')).json()).filter(r => r.operation !== 'status').length;`), controlCount,
      'live map updates issue no new Start or Stop command');
    await page(`await fetch('/fixture/taxi?departing=false');`);
    await until(page, `return !document.querySelector('#taxi-pushback-action').disabled;`);
  }
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
    await until(page, `return document.querySelector('#taxi-pushback-action').textContent === 'Start pushback' && !document.querySelector('#taxi-pushback-action').disabled;`);
    await wait(1100);
    assert.equal(await page(`return (await (await fetch('/fixture/pushback')).json()).filter(r => r.operation === 'start').length;`), beforeHide.filter(r => r.operation === 'start').length,
      'reopening the native panel never restarts pushback');
    await click('#tab-button-flight');
  }
};
