'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function checkPushbackE2E({ win, evaluate, ready, settled, wait, output }) {
  const diagnostics = () => evaluate(`return (await fetch('/pushback-e2e')).json();`);
  const fixture = body => evaluate(`return (await fetch('/pushback-e2e', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(${JSON.stringify(body)})})).json();`);
  const capture = async name => {
    await evaluate(`document.querySelector('#aircraft-page-autotaxi').scrollIntoView({block:'start',behavior:'instant'});`);
    await evaluate(`if (innerWidth < 900) scrollBy(0, -80);`);
    await win.webContents.capturePage();
    await wait(100);
    assert.equal(await evaluate(`return document.documentElement.scrollWidth > innerWidth;`), false, `${name}: horizontal overflow`);
    fs.writeFileSync(path.join(output, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  await evaluate(`layoutTest.setDeparture('TEST', '09'); await layoutTest.settle(); document.querySelector('#aircraft-page-autotaxi > summary').click();`);
  await ready('[data-pushback-path]');
  assert.equal(await evaluate(`return document.querySelector('[data-pushback-start]').disabled;`), true, 'brake blocks Start but not preview');
  assert.match(await evaluate(`return document.querySelector('[data-taxi-pushback]').textContent;`), /Release the parking brake/);
  assert.equal((await diagnostics()).writes.length, 0, 'automatic planning is read only');
  await capture('departure-ready-desktop');
  win.setContentSize(320, 1000); await capture('departure-ready-phone');
  await fixture({ fixture: 'brake', parked: false });
  assert.equal(await settled(`return document.querySelector('[data-pushback-start]')?.disabled;`, v => v === false), false);
  const shown = (await diagnostics()).shownId;
  await evaluate(`window.startButton = document.querySelector('[data-pushback-start]'); startButton.focus();`);
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  assert.equal(await settled(`return Boolean(document.querySelector('[data-pushback-stop]'));`, Boolean), true,
    JSON.stringify({ ...(await diagnostics()), ui: await evaluate(`return document.querySelector('[data-taxi-pushback]').textContent;`) }));
  assert.equal(await evaluate(`return document.activeElement === startButton && startButton === document.querySelector('[data-pushback-stop]');`), true,
    'keyboard focus stays on the Stop action');
  assert.equal(await evaluate(`return startButton.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', repeat:true, bubbles:true, cancelable:true}));`), true,
    'held navigation keys retain their normal behaviour');
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', autoRepeat: true });
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await wait(350);
  let data = await diagnostics();
  assert.equal(data.requests.filter(m => m.type === 'pushback' && m.operation === 'stop').length, 0, 'held Enter does not stop the new pushback');
  assert.equal(data.requests.find(m => m.type === 'pushback' && m.operation === 'start').previewId, shown, 'controller executes the displayed plan');
  assert.equal(data.state.status, 'connecting');
  await settled(`return (await (await fetch('/pushback-e2e')).json()).state.status;`, status => status === 'pushing');
  data = await diagnostics();
  await evaluate(`window.livePushbackMarker = document.querySelector('[data-pushback-aircraft]');`);
  const remaining = data.state.remainingM;
  const observer = await fixture({ fixture: 'observer' });
  assert.equal(observer.pushbackPreview.id, shown, 'toolbar observer gets the exact active plan');
  assert.equal(observer.pushbackPreview.phase, 'pushing');
  assert.equal(await evaluate(`return document.querySelector('input[placeholder="YMML"]').disabled;`), true);
  await capture('departure-pushing-phone');
  await wait(500);
  assert.ok((await diagnostics()).state.remainingM < remaining, 'feedback advances along the actual plan');
  assert.equal(await evaluate(`return livePushbackMarker === document.querySelector('[data-pushback-aircraft]');`), true,
    'live telemetry retains the marker so its movement can interpolate');
  assert.ok(await evaluate(`return parseFloat(getComputedStyle(livePushbackMarker).transitionDuration) <= 0.001;`), 'reduced motion stays immediate');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{name:'prefers-reduced-motion',value:'no-preference'}] });
  assert.equal(await evaluate(`return getComputedStyle(livePushbackMarker).transitionDuration;`), '0.25s', 'normal live movement interpolates between samples');
  assert.equal(await settled(`return livePushbackMarker.getAnimations().some(animation => animation.transitionProperty === 'transform');`, Boolean), true,
    'the browser actually interpolates live marker movement');
  assert.ok(await evaluate(`return Number(document.querySelector('[data-pushback-progress]').getAttribute('data-pushback-progress')) > 0;`));
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{name:'prefers-reduced-motion',value:'reduce'}] });
  const result = await settled(`return (await (await fetch('/pushback-e2e')).json()).state;`, s => !s.active, 25000);
  fs.writeFileSync(path.join(output, 'departure-trace.json'), JSON.stringify(await diagnostics(), null, 2));
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.equal(await settled(`return layoutTest.taxiSent.filter(m => m.operation === 'preview').length;`, n => n === 1), 1,
    'one automatic handover to manual guidance');
  assert.equal(await settled(`return document.querySelector('.taxi-map')?.dataset.taxiView;`, v => v === '3d'), '3d');
  assert.equal(await evaluate(`return Boolean(document.querySelector('[data-pushback-start]'));`), false);
  assert.equal(await evaluate(`return document.querySelector('[data-taxi-show-route]').textContent;`), 'Refresh route');
  assert.match(await evaluate(`return document.querySelector('#aircraft-page-autotaxi figcaption').textContent;`), /runway 09/);
  data = await diagnostics();
  assert.equal(data.pose.speedKts, 0);
  assert.ok(Math.abs(data.pose.headingDeg - 90) < 12, 'ends facing the onward taxi direction');
  assert.deepEqual(data.writes.slice(-1), [{ name: 'TUG_DISABLE', value: 0 }]);
  assert.equal(data.writes.filter(write => write.name === 'TOGGLE_PUSHBACK').length, 1);
  assert.equal(data.writes.some(write => /TUG_SPEED/.test(write.name)), false);
  assert.equal(data.requests.some(m => m.type === 'autotaxi' && m.operation === 'start'), false, 'completion never starts Autotaxi');
  const completedObserver = await fixture({ fixture: 'observer' });
  assert.equal(completedObserver.pushbackPreview.phase, 'complete', 'toolbar observer retains completed guidance');
  assert.equal(await settled(`return document.querySelector('#aircraft-page-autotaxi > div > p').textContent;`,
    text => text === 'Follow the ribbon to the runway holding point.'), 'Follow the ribbon to the runway holding point.',
    'the next preview poll settles all completion copy');
  await capture('departure-complete-phone');
  win.setContentSize(1440, 1000); await capture('departure-complete-desktop');
  fs.writeFileSync(path.join(output, 'departure-trace.json'), JSON.stringify(data, null, 2));
  console.log('Real-controller departure: read-only preview, brake guard, keyboard start/focus/repeat, live progress, read-only observer, alignment, stop and automatic taxi handover passed.');
};
