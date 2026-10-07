'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function checkAircraftSections({ win, evaluate, settled, wait, output }) {
  const initialSize = win.getContentSize();
  // Exercise both navigator implementations, with the same independently
  // scrolling main region used by the app shell.
  await evaluate(`
    const main = document.createElement('main');
    main.id = 'vue-main-root';
    main.style.cssText = 'height:calc(100vh - 32px);overflow:auto;position:relative';
    const app = document.getElementById('app');
    app.before(main); main.append(app);
    await layoutTest.remount();
  `);
  try {
    for (const id of ['pmdg-737', 'pmdg-777', 'fenix-a320', 'fbw-a32nx', 'fbw-a380x']) {
      await evaluate(`sessionStorage.clear(); await layoutTest.scenario(${JSON.stringify(id)});`);
      for (const width of [1440, 390, 320]) {
        win.setContentSize(width, 900);
        await wait(100);
        const labels = await evaluate(`return [...document.querySelectorAll('.aircraft-desktop-section-choices button')].map(b => b.textContent.trim());`);
        assert(labels.length > 2, `${id}: section choices available`);
        const destinations = [];
        for (const index of labels.map((_, i) => i)) {
          const destination = await evaluate(`
            const index = ${index};
            if (innerWidth > 760) document.querySelectorAll('.aircraft-desktop-section-choices button')[index].click();
            else {
              document.querySelector('nav[aria-label$="page sections"] [aria-haspopup="dialog"]').click();
              await layoutTest.settle();
              document.querySelectorAll('[data-aircraft-section-choice], [data-pmdg-section-choice]')[index].click();
            }
            await layoutTest.settle();
            return document.activeElement.id;
          `);
          assert(destination, `${id}/${width}: selection focuses a section`);
          destinations.push(destination);
          // Observe the scroll event and its deferred active-section update,
          // rather than only the synchronous highlight set by the click.
          await win.webContents.capturePage();
          await wait(100);
          const state = await evaluate(`
            const target = document.getElementById(${JSON.stringify(destination)});
            const nav = document.querySelector('nav[aria-label$="page sections"]');
            const main = document.getElementById('vue-main-root');
            return {
              selected: document.querySelector('.aircraft-desktop-section-choices [aria-current="location"]')?.textContent.trim(),
              targetTop: target.getBoundingClientRect().top,
              navBottom: nav.getBoundingClientRect().bottom,
              margin: getComputedStyle(target).scrollMarginTop,
              atEnd: main.scrollTop + main.clientHeight >= main.scrollHeight - 24,
              overflow: document.documentElement.scrollWidth > innerWidth,
            };
          `);
          // The existing end-of-page policy selects the final section when
          // there is insufficient remaining content to align a destination.
          const expected = state.atEnd ? labels.at(-1) : labels[index];
          assert.equal(state.selected, expected, `${id}/${width}: ${labels[index]} tracks its scroll destination: ${JSON.stringify(state)}`);
          assert.equal(state.overflow, false, `${id}/${width}: section navigation fits`);
          if (labels[index] === 'Pushback & taxi') {
            fs.writeFileSync(path.join(output, `sections-${id}-${width}.png`), (await win.webContents.capturePage()).toPNG());
          }
        }
        // Manual scrolling must still update the selection in both directions.
        for (const index of [1, 2, 1]) {
          await evaluate(`document.getElementById(${JSON.stringify(destinations[index])}).scrollIntoView({ behavior: 'instant', block: 'start' });`);
          await win.webContents.capturePage(); await wait(100);
          assert.equal(await evaluate(`return document.querySelector('.aircraft-desktop-section-choices [aria-current="location"]')?.textContent.trim();`),
            labels[index], `${id}/${width}: scrolling back restores ${labels[index]}`);
        }
        if (id === 'pmdg-777' && width === 1440) {
          await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
          for (const index of [2, 1]) {
            await evaluate(`document.querySelectorAll('.aircraft-desktop-section-choices button')[${index}].click();`);
            const arrived = await settled(`
              const target = document.getElementById(${JSON.stringify(destinations[index])});
              const main = document.getElementById('vue-main-root');
              return Math.abs(target.getBoundingClientRect().top - main.getBoundingClientRect().top - parseFloat(getComputedStyle(target).scrollMarginTop)) < 1;
            `, value => value === true);
            assert.equal(arrived, true, 'smooth navigation reaches its destination');
            await wait(100);
            assert.equal(await evaluate(`return document.querySelector('.aircraft-desktop-section-choices [aria-current="location"]')?.textContent.trim();`), labels[index], 'smooth navigation keeps the destination selected');
          }
          await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        }
      }
    }
    console.log('PASS Aircraft section selection: five families at 1440/390/320px, all menu destinations and manual scrolling.');
  } finally {
    win.setContentSize(...initialSize);
    await evaluate(`
      const main = document.getElementById('vue-main-root');
      main.before(document.getElementById('app')); main.remove();
      sessionStorage.clear(); await layoutTest.scenario('pmdg-737'); await layoutTest.remount();
      window.scrollTo({ top: 0, behavior: 'instant' });
    `);
  }
};
