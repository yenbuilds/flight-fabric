const assert = require('node:assert/strict');

module.exports = async function checkTaxiGuidanceRegressions({ evaluate, wait }) {
  const failures = [];
  const check = (actual, message) => { if (!actual) failures.push(message); };
  const figureText = () => evaluate(`return document.querySelector('#aircraft-page-autotaxi figure')?.textContent || '';`);
  const commandsBefore = await evaluate(`return layoutTest.taxiSent.filter(message => ['start', 'stop', 'release'].includes(message.operation)).length;`);

  // Projecting onto the last route segment is not proof of being at its end.
  await evaluate(`layoutTest.moveAircraft({ x: 110, z: 120, headingDeg: 90, speedKts: 0 });`);
  await wait(400);
  check(!/Holding point reached/.test(await figureText()), '20 m beside the endpoint must not count as arrival');
  check(/20 m/.test(await figureText()), 'remaining distance must include the offset from the route');
  await evaluate(`layoutTest.moveAircraft({ x: 110, z: 100 });`);
  await wait(400);
  check(/Holding point reached/.test(await figureText()), 'the actual route endpoint should announce arrival');

  // A socket can stay open while responses stop, including a stalled backend.
  await evaluate(`layoutTest.muteTaxiStatus(true);`);
  await wait(2500);
  check(/Live position unavailable/.test(await figureText()), 'a silent status stream must expire the live marker');
  check(await evaluate(`return document.querySelector('[data-taxi-show-route]').disabled && document.querySelector('[data-taxi-start]').disabled;`),
    'silent status must disable planning and automatic start');
  check(!/Holding point reached/.test(await figureText()), 'stale position must not keep announcing arrival');
  await evaluate(`layoutTest.muteTaxiStatus(false); layoutTest.moveAircraft({ x: 0.4, z: 12, headingDeg: 3, speedKts: 2.4 });`);
  await wait(400);
  check(!/Live position unavailable/.test(await figureText()), 'fresh status should restore guidance without starting automation');

  // The backend retains the controller route after handover. A destination
  // edit must invalidate its display, including on later status polls.
  await evaluate(`const previous = layoutTest.taxiReplies.findLast(reply => reply.preview);
    layoutTest.setTaxiState({ status: 'stopped', active: true, handedOver: true, route: previous.preview, remainingM: 0 });
    await layoutTest.settle(); document.querySelector('[data-taxi-destination]').open = true;
    const input = document.querySelector('input[placeholder="YMML"]'); input.value = 'EGCC'; input.dispatchEvent(new Event('input', { bubbles: true }));
    await layoutTest.settle();`);
  check(await evaluate(`return !document.querySelector('#aircraft-page-autotaxi figure');`), 'editing a handed-over destination must remove the old route');
  await wait(450);
  check(await evaluate(`return !document.querySelector('#aircraft-page-autotaxi figure');`), 'polling must not restore the previous destination route');
  await evaluate(`layoutTest.taxiReply(layoutTest.taxiReplies.findLast(reply => reply.preview)); await layoutTest.settle();`);
  check(await evaluate(`return !document.querySelector('#aircraft-page-autotaxi figure');`), 'a late completed preview must not undo the destination edit');
  check(await evaluate(`return layoutTest.taxiSent.filter(message => ['start', 'stop', 'release'].includes(message.operation)).length;`) === commandsBefore,
    'manual guidance, expiry and editing must not send control commands');

  await evaluate(`layoutTest.setTaxiState({ status: 'idle', active: false, handedOver: false, route: null, remainingM: null, canGuide: true, canStart: true });
    const input = document.querySelector('input[placeholder="YMML"]'); input.value = 'YMML'; input.dispatchEvent(new Event('input', { bubbles: true }));
    await layoutTest.settle(); document.querySelector('[data-taxi-show-route]').click(); await layoutTest.settle();`);
  assert.deepEqual(failures, [], 'Taxi assistant guidance regressions');
};
