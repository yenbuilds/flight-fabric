const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function checkPushback({ win, evaluate, ready, settled, wait, output }) {
  await evaluate(`layoutTest.setDeparture('YMML', '16'); await layoutTest.settle();
    document.querySelector('#aircraft-page-autotaxi > summary').click(); await layoutTest.settle();`);
  assert.equal(await settled(`return document.querySelector('[data-pushback-start]')?.disabled;`, v => v === false), false);
  assert.equal(await evaluate(`return document.querySelectorAll('#aircraft-page-autotaxi figure').length;`), 1, 'one shared guidance map');
  assert.deepEqual(await evaluate(`return ['[data-pushback-map]', '[data-pushback-path]', '[data-pushback-final-heading]', '[data-taxi-onward]'].map(s => !!document.querySelector(s));`), [true, true, true, true]);
  assert.deepEqual(await evaluate(`return [...document.querySelectorAll('[data-taxi-destination] input:not([type="radio"])')].map(el => el.value);`), ['YMML', '16'], 'departure comes from the loaded plan');
  await evaluate(`layoutTest.setTaxiPreviewError('No taxiway within 150 m that the aircraft can turn onto.');
    document.querySelector('[data-taxi-show-route]').click(); await layoutTest.settle();`);
  assert.match(await evaluate(`return document.querySelector('#aircraft-page-autotaxi [role="alert"]')?.textContent;`), /No taxiway within/,
    'failed direct taxi planning explains the failure in its own view');
  await evaluate(`document.querySelector('input[name="autotaxi-view"][value="pushback"]').click(); await layoutTest.settle();`);
  assert.equal(await evaluate(`return document.querySelector('#aircraft-page-autotaxi [role="alert"]')?.textContent || '';`), '',
    'valid pushback preview does not show an unrelated taxi planning error');
  await evaluate(`layoutTest.setTaxiState({ error: 'Could not release the aircraft controls.' }); await layoutTest.settle();`);
  assert.match(await evaluate(`return document.querySelector('#aircraft-page-autotaxi [role="alert"]')?.textContent;`), /Could not release/,
    'control faults remain visible even while viewing a pushback preview');
  await evaluate(`layoutTest.setTaxiState({ error: null }); layoutTest.setTaxiPreviewError(null); await layoutTest.settle();`);
  for (const width of [1440, 390, 320]) {
    win.setContentSize(width, 1000);
    await evaluate(`document.querySelector('[data-taxi-pushback]').scrollIntoView({ block: 'center', behavior: 'instant' });`);
    await wait(100);
    assert.equal(await evaluate(`return document.documentElement.scrollWidth > innerWidth;`), false, `${width}px overflow`);
    fs.writeFileSync(path.join(output, `pushback-ready-${width}.png`), (await win.webContents.capturePage()).toPNG());
    const size = await evaluate(`const button = document.querySelector('[data-pushback-start]'); return { height: button.getBoundingClientRect().height,
      open: document.querySelector('#aircraft-page-autotaxi').open, css: getComputedStyle(button).minHeight };`);
    assert.ok(size.height >= 48, `${width}px touch target: ${JSON.stringify(size)}`);
  }
  await evaluate(`document.querySelector('[data-pushback-start]').click(); await layoutTest.settle();`);
  await ready('[data-pushback-stop]');
  const starts = await evaluate(`return layoutTest.pushbackSent.filter(m => m.operation === 'start');`);
  assert.equal(starts.length, 1); assert.equal(starts[0].icao, 'YMML'); assert.equal(starts[0].runway, '16');
  assert.equal(starts[0].previewId, 'shown-16', 'Start binds to the path shown');
  assert.equal(await evaluate(`return document.querySelector('input[placeholder="YMML"]').disabled;`), true, 'destination locked during pushback');
  assert.equal(await evaluate(`return document.querySelector('[data-taxi-start]').disabled;`), true, 'Autotaxi cannot start during pushback');
  assert.equal(await evaluate(`return Boolean(document.querySelector('[data-taxi-stop]'));`), false, 'one stop control, no unrelated Autotaxi stop');
  assert.equal(await evaluate(`return layoutTest.taxiSent.some(m => m.operation === 'start');`), false, 'pushback never starts Autotaxi');
  await evaluate(`document.querySelector('[data-pushback-stop]').scrollIntoView({ block: 'center', behavior: 'instant' });`);
  await wait(180);
  fs.writeFileSync(path.join(output, 'pushback-running-320.png'), (await win.webContents.capturePage()).toPNG());
  const beforePreview = await evaluate(`return layoutTest.taxiSent.filter(m => m.operation === 'preview').length;`);
  await evaluate(`layoutTest.setPushbackState({ status: 'complete', active: false, canStart: true, reason: 'Pushback complete. Ready to taxi.' });`);
  assert.equal(await settled(`return layoutTest.taxiSent.filter(m => m.operation === 'preview').length;`, n => n > beforePreview), beforePreview + 1, 'completion automatically displays manual taxi guidance');
  await ready('#aircraft-page-autotaxi figure');
  assert.equal(await settled(`return document.querySelector('.taxi-map').dataset.taxiView;`, v => v !== 'pushback'), '3d', 'completion returns to taxi guidance');
  assert.equal(await settled(`return Boolean(document.querySelector('[data-pushback-start]'));`, v => v === false), false,
    'completed pushback offers guidance instead of a disabled repeat action');
  assert.match(await evaluate(`return document.querySelector('[data-taxi-pushback]').textContent;`), /Follow the taxi guidance/);
  assert.equal(await evaluate(`return [...document.querySelectorAll('#aircraft-page-autotaxi button')].some(b => b.textContent === 'Back to pushback');`), true,
    'the route button describes its return to the departure map');
  await evaluate(`document.querySelector('[data-taxi-pushback]').scrollIntoView({block:'center',behavior:'instant'});`);
  await wait(180);
  fs.writeFileSync(path.join(output, 'pushback-complete-320.png'), (await win.webContents.capturePage()).toPNG());
  // A new parked departure can start another pushback; completion itself must not offer a repeat.
  await evaluate(`layoutTest.setPushbackState({ status: 'idle', active: false, canStart: true });`);
  assert.equal(await settled(`return document.querySelector('[data-pushback-start]')?.disabled;`, v => v === false), false);

  // Explicit Stop, delayed duplicate replies, and an unresponsive status stream.
  await evaluate(`document.querySelector('[data-pushback-start]').click(); await layoutTest.settle(); document.querySelector('[data-pushback-stop]').click(); await layoutTest.settle();
    layoutTest.taxiReply(layoutTest.pushbackReplies.find(reply => reply.active)); await layoutTest.settle();`);
  assert.equal(await evaluate(`return Boolean(document.querySelector('[data-pushback-stop]'));`), false, 'late completed start cannot resurrect an old pushback');
  assert.equal(await settled(`return document.querySelector('[data-pushback-start]')?.disabled;`, v => v === false), false);
  await evaluate(`document.querySelector('[data-pushback-start]').click(); await layoutTest.settle(); layoutTest.mutePushbackStatus(true);`);
  const stops = await evaluate(`return layoutTest.pushbackSent.filter(m => m.operation === 'stop').length;`);
  assert.equal(await settled(`return layoutTest.pushbackSent.filter(m => m.operation === 'stop').length;`, n => n > stops, 3500), stops + 1, 'silence sends Stop even with an open socket');
  await evaluate(`layoutTest.mutePushbackStatus(false);`);
  assert.equal(await settled(`return document.querySelector('[data-pushback-start]')?.disabled;`, v => v === false), false);
  await evaluate(`document.querySelector('[data-pushback-start]').click(); await layoutTest.settle(); layoutTest.taxiDisconnect(); await layoutTest.settle();`);
  const disconnectStarts = await evaluate(`return layoutTest.pushbackSent.filter(m => m.operation === 'start').length;`);
  await evaluate(`layoutTest.setPushbackState({ status: 'stopped', active: false, canStart: true }); layoutTest.taxiReconnect(); await layoutTest.settle();`);
  await wait(350);
  assert.equal(await evaluate(`return layoutTest.pushbackSent.filter(m => m.operation === 'start').length;`), disconnectStarts, 'reconnect never resumes pushback');

  // A pilot's runway override survives a later plan refresh.
  await evaluate(`document.querySelector('[data-taxi-destination]').open = true;
    const runway = document.querySelector('input[placeholder="16"]'); runway.focus(); runway.value = '27'; runway.dispatchEvent(new Event('input', { bubbles: true }));
    await layoutTest.settle(); layoutTest.setDeparture('YMML', '34'); await layoutTest.settle();`);
  assert.equal(await evaluate(`return document.querySelector('input[placeholder="16"]').value;`), '27');
  assert.equal(await settled(`return document.querySelector('[data-pushback-start]')?.disabled;`, v => v === false), false,
    await evaluate(`return document.querySelector('[data-taxi-pushback]').textContent;`));
  assert.equal(await evaluate(`return document.querySelector('[data-taxi-destination]').open && document.activeElement === document.querySelector('input[placeholder="16"]');`), true,
    'automatic preview keeps the destination open while the pilot is typing');
  await evaluate(`document.querySelector('[data-pushback-start]').click(); await layoutTest.settle();`);
  await ready('[data-pushback-stop]');
  await evaluate(`await layoutTest.remount();`);
  assert.equal(await evaluate(`return layoutTest.pushbackSent.filter(m => m.operation !== 'status').at(-1).operation;`), 'stop', 'leaving the panel stops pushback');
  // The active Autotaxi map takes priority, even if a departure preview existed.
  await evaluate(`layoutTest.setPushbackState({ status: 'idle', active: false, canStart: true });
    layoutTest.setTaxiState({ status: 'taxiing', active: true, handedOver: false, sceneKey: 99,
      route: { points: [{x:0,z:0},{x:0,z:100}], holdShort: {x:0,z:130}, runway:'27' },
      aircraft: {x:0,z:0,headingDeg:0,speedKts:2} }); await layoutTest.settle();`);
  await wait(800);
  assert.equal(await evaluate(`return !!document.querySelector('[data-pushback-map]');`), false, 'pushback does not replace active Autotaxi guidance');
  console.log('Pushback: plan defaults, one click, automatic handover, stop, silence, reconnect and unmount pass at desktop/390/320px.');
};
