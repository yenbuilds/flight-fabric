'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function checkAircraftSections({ win, evaluate, settled, wait, output }) {
  const initialSize = win.getContentSize();

  async function checkNativeRibbonInput(id, labels) {
    const chooser = 'nav[aria-label$="page sections"] [aria-haspopup="dialog"]';
    const nextArrow = 'nav[aria-label$="page sections"] button[aria-label^="Open next section:"]';
    const menuState = `
      const launcher = document.querySelector(${JSON.stringify(chooser)});
      const menu = document.getElementById(launcher.getAttribute('aria-controls'));
      const buttons = [...(menu?.querySelectorAll('button:not(:disabled)') || [])];
      return {
        firstChoice: document.activeElement === menu?.querySelector('[data-aircraft-section-choice], [data-pmdg-section-choice]'),
        first: buttons.length > 0 && document.activeElement === buttons[0],
        last: buttons.length > 0 && document.activeElement === buttons.at(-1),
        restored: !menu && document.activeElement === launcher && launcher.getAttribute('aria-expanded') === 'false',
      };
    `;
    async function expectFocus(key, message) {
      const state = await settled(menuState, value => value[key] === true);
      assert.equal(state[key], true, `${id}/390: ${message}: ${JSON.stringify(state)}`);
    }
    function keypress(keyCode, modifiers = []) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    }
    async function mouse(type, point, buttons = 0) {
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type, ...point, buttons, button: type === 'mouseMoved' ? 'none' : 'left',
        clickCount: type === 'mouseMoved' ? 0 : 1,
      });
    }
    async function click(selector) {
      const point = await evaluate(`
        const target = document.querySelector(${JSON.stringify(selector)}), rect = target.getBoundingClientRect();
        const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
        return { x, y, reachable: target.contains(document.elementFromPoint(x, y)) && !target.disabled };
      `);
      assert.equal(point.reachable, true, `${id}/390: native pointer reaches ${selector}`);
      const location = { x: point.x, y: point.y };
      await mouse('mouseMoved', location);
      await mouse('mousePressed', location, 1);
      await mouse('mouseReleased', location);
    }

    await click(chooser);
    await expectFocus('firstChoice', 'opening the menu focuses its first section choice');
    keypress('Tab', ['shift']);
    await expectFocus('first', 'Shift-Tab reaches the close button');
    keypress('Tab', ['shift']);
    await expectFocus('last', 'Shift-Tab wraps from the first to the last menu button');
    keypress('Tab');
    await expectFocus('first', 'Tab wraps from the last to the first menu button');
    keypress('Escape');
    await expectFocus('restored', 'Escape closes the menu and restores chooser focus');

    // Keep both endpoints inside the chooser: Chromium delivers a real click
    // after this horizontal pointer gesture, which the ribbon must suppress.
    const swipe = await evaluate(`
      const launcher = document.querySelector(${JSON.stringify(chooser)}), rect = launcher.getBoundingClientRect();
      launcher.addEventListener('click', event => { launcher.dataset.nativeSwipeClick = event.isTrusted ? 'trusted' : 'synthetic'; }, { once: true });
      return { start: { x: rect.left + rect.width * 0.7, y: rect.top + rect.height / 2 }, end: { x: rect.left + rect.width * 0.3, y: rect.top + rect.height / 2 } };
    `);
    await mouse('mouseMoved', swipe.start);
    await mouse('mousePressed', swipe.start, 1);
    for (let step = 1; step <= 4; step += 1) {
      await mouse('mouseMoved', { x: swipe.start.x + (swipe.end.x - swipe.start.x) * step / 4, y: swipe.start.y }, 1);
    }
    await mouse('mouseReleased', swipe.end);
    const swipeState = await evaluate(`
      await layoutTest.settle();
      const launcher = document.querySelector(${JSON.stringify(chooser)});
      const state = { click: launcher.dataset.nativeSwipeClick, expanded: launcher.getAttribute('aria-expanded'), selected: document.querySelector('.aircraft-desktop-section-choices [aria-current="location"]')?.textContent.trim() };
      delete launcher.dataset.nativeSwipeClick;
      return state;
    `);
    assert.deepEqual(swipeState, { click: 'trusted', expanded: 'false', selected: labels[2] }, `${id}/390: native swipe advances once and suppresses its follow-up menu click`);
    await click(nextArrow);
    await win.webContents.capturePage(); await wait(100);
    assert.equal(await evaluate(`return document.querySelector('.aircraft-desktop-section-choices [aria-current="location"]')?.textContent.trim();`),
      labels[3], `${id}/390: the next native arrow tap advances exactly one more section`);
  }
  // Exercise both navigator implementations, with the same independently
  // scrolling main region used by the app shell.
  await evaluate(`
    const main = document.createElement('main');
    main.id = 'vue-main-root';
    main.style.cssText = 'height:calc(100vh - 32px);overflow:auto;position:relative';
    const app = document.getElementById('app');
    app.before(main); main.append(app);
    await layoutTest.remountCockpit();
  `);
  try {
    for (const id of ['pmdg-737', 'pmdg-777', 'fenix-a320', 'fbw-a32nx', 'fbw-a380x']) {
      await evaluate(`sessionStorage.clear(); await layoutTest.cockpitScenario(${JSON.stringify(id)});`);
      const expectedTemplate = id === 'fenix-a320' ? 'fenix-a32x' : id;
      const mountedTemplate = await settled(`return document.querySelector('[data-aircraft-template]')?.getAttribute('data-aircraft-template');`,
        value => value === expectedTemplate);
      assert.equal(mountedTemplate, expectedTemplate, `${id}: requested aircraft template is mounted before reading section choices`);
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
          if (!state.atEnd) assert(state.targetTop >= state.navBottom - 1, `${id}/${width}: ${labels[index]} clears both view and section navigation: ${JSON.stringify(state)}`);
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
        if (width === 390 && ['pmdg-737', 'pmdg-777'].includes(id)) {
          await checkNativeRibbonInput(id, labels);
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
    console.log('PASS Aircraft section selection: five families at 1440/390/320px, all menu destinations, manual scrolling, and native keyboard/swipe controls.');
  } finally {
    win.setContentSize(...initialSize);
    await evaluate(`
      const main = document.getElementById('vue-main-root');
      main.before(document.getElementById('app')); main.remove();
      sessionStorage.clear(); await layoutTest.cockpitScenario('pmdg-737'); await layoutTest.remountCockpit();
      window.scrollTo({ top: 0, behavior: 'instant' });
    `);
  }
};
