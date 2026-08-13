#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const targetUrl = process.env.FF_BROWSER_SMOKE_URL;
const timeoutMs = Number(process.env.FF_BROWSER_SMOKE_TIMEOUT || 30000);
const userDataDir = process.env.FF_BROWSER_SMOKE_USER_DATA;
const viewportWidth = Number(process.env.FF_BROWSER_SMOKE_WIDTH || 1440);
const viewportHeight = Number(process.env.FF_BROWSER_SMOKE_HEIGHT || 1000);
const headerOnly = process.env.FF_BROWSER_SMOKE_HEADER_ONLY === '1';

if (!targetUrl) {
  throw new Error('FF_BROWSER_SMOKE_URL is required');
}

if (userDataDir) {
  fs.mkdirSync(userDataDir, { recursive: true });
  app.setPath('userData', userDataDir);
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-sandbox');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function evaluate(windowRef, expression) {
  return windowRef.webContents.executeJavaScript(expression, true);
}

async function waitFor(windowRef, expression, description, localTimeoutMs = timeoutMs) {
  const startedAt = Date.now();
  let lastError = null;

  while ((Date.now() - startedAt) < localTimeoutMs) {
    try {
      const result = await evaluate(
        windowRef,
        `(() => {
          try {
            return (${expression});
          } catch (error) {
            return false;
          }
        })();`,
      );
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }

  throw new Error(`Timed out waiting for ${description}${lastError ? ` (${lastError.message})` : ''}`);
}

async function click(windowRef, expression, description) {
  const clicked = await evaluate(
    windowRef,
    `(() => {
      const element = ${expression};
      if (!element) return false;
      element.click();
      return true;
    })();`,
  );
  assert.equal(clicked, true, `Expected to click ${description}`);
}

async function installClipboardProbe(windowRef) {
  const installed = await evaluate(windowRef, `(() => {
    window.__ffClipboardWrites = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => { window.__ffClipboardWrites.push(String(text)); },
      },
    });
    return typeof navigator.clipboard?.writeText === 'function';
  })();`);
  assert.equal(installed, true, 'browser smoke should install an isolated clipboard probe');
}

async function setInputValue(windowRef, inputId, value) {
  const updated = await evaluate(
    windowRef,
    `(() => {
      const input = document.getElementById(${JSON.stringify(inputId)});
      if (!input) return false;
      input.focus();
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })();`,
  );
  assert.equal(updated, true, `Expected to update input ${inputId}`);
}

async function seedSimbriefFixture(windowRef) {
  const fixturePlan = {
    username: 'fixture-dispatch',
    fetchedAt: Date.parse('2026-06-16T18:27:00.000Z'),
    origin: 'CYHZ',
    originName: 'Halifax Stanfield Intl',
    destination: 'KBOS',
    destinationName: 'Boston Logan Intl',
    alternate: 'KJFK',
    aircraft: 'B77W',
    aircraftName: 'B777-300ER',
    callsign: 'UPL20260616A',
    flightNumber: '20260616A',
    route: 'DCT SENVI DCT VIGMA DCT ALLEX DCT AJJAY OOSHN5',
    cruiseAltFl: 'FL380',
    cruiseMach: '0.84',
    eteSeconds: 4440,
    fuelLbs: 20034,
    costIndex: null,
  };

  await evaluate(
    windowRef,
    `(() => {
      localStorage.setItem('ff_simbriefUsername', 'fixture-dispatch');
      localStorage.setItem('ff_flightPlan', ${JSON.stringify(JSON.stringify(fixturePlan))});
      return true;
    })();`,
  );
}

async function assertUsableLayout(windowRef, label, selectors) {
  const result = await evaluate(
    windowRef,
    `(() => {
      const selectors = ${JSON.stringify(selectors)};
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const pageWidth = Math.max(
        document.documentElement.scrollWidth || 0,
        document.body?.scrollWidth || 0,
      );
      const rows = selectors.map((selector) => {
        const element = document.querySelector(selector);
        if (!element) return { selector, missing: true };
        const rect = element.getBoundingClientRect();
        return {
          selector,
          width: rect.width,
          height: rect.height,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
        };
      });
      return { viewportWidth, viewportHeight, pageWidth, rows };
    })();`,
  );

  const missing = result.rows.filter((row) => row.missing).map((row) => row.selector);
  assert.deepEqual(missing, [], `${label} layout is missing expected elements`);

  const broken = result.rows.filter((row) => (
    row.width < 240
    || row.height < 40
    || row.left < -24
    || row.right > result.viewportWidth + 24
    || row.bottom < 0
    || row.top > result.viewportHeight + 600
  ));
  assert.deepEqual(broken, [], `${label} layout has collapsed or overflowing elements`);
  assert.ok(
    result.pageWidth <= result.viewportWidth + 32,
    `${label} layout should not create page-level horizontal overflow`,
  );
}

async function assertSimbriefLayout(windowRef) {
  await waitFor(
    windowRef,
    "document.querySelector('.desktop-tab[data-tab=\"dispatch\"]')",
    'desktop SimBrief tab button',
  );
  await click(windowRef, "document.querySelector('.desktop-tab[data-tab=\"dispatch\"]')", 'SimBrief tab for layout');
  await waitFor(
    windowRef,
    "document.getElementById('tab-dispatch')?.classList.contains('active') && document.getElementById('sb-result-panel') && !document.getElementById('sb-result-panel').classList.contains('hidden')",
    'SimBrief active OFP layout targets',
  );

  await assertUsableLayout(windowRef, 'SimBrief tab', [
    '#tab-dispatch.active',
    '#tab-dispatch .simbrief-fetch-row',
    '#tab-dispatch .simbrief-route-hero',
    '#tab-dispatch .simbrief-kpi-grid',
    '#tab-dispatch .simbrief-route-block',
  ]);

  const result = await evaluate(
    windowRef,
    `(() => {
      const kpiGrids = Array.from(document.querySelectorAll('#tab-dispatch .simbrief-kpi-grid'));
      const routeTitle = document.querySelector('#tab-dispatch .simbrief-route-title');
      const kpiCells = Array.from(document.querySelectorAll('#tab-dispatch .simbrief-kpi-cell')).map((element) => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
      const routeTitleRect = routeTitle?.getBoundingClientRect();
      return {
        kpiColumns: kpiGrids.map((grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').length),
        kpiCells,
        routeTitleHeight: routeTitleRect?.height || 0,
        routeTitleWidth: routeTitleRect?.width || 0,
        viewportWidth: window.innerWidth,
      };
    })();`,
  );

  assert.deepEqual(result.kpiColumns.length, 2, 'SimBrief OFP should render primary and secondary KPI strips');
  assert.equal(result.kpiCells.length, 10, 'SimBrief OFP should render ten KPI cells across both strips');
  if (result.viewportWidth >= 1024) {
    assert.deepEqual(result.kpiColumns, [5, 5], 'Desktop SimBrief KPI strips should each use five columns');
    assert.deepEqual(
      result.kpiCells.filter((cell) => cell.height > 120),
      [],
      'Desktop SimBrief KPI cells should stay compact',
    );
    assert.ok(result.routeTitleHeight < 70, 'Desktop SimBrief route title should read as a single structured row');
  }

  await click(windowRef, "document.getElementById('sb-copy-route-btn')", 'SimBrief Copy route button');
  await waitFor(
    windowRef,
    "document.getElementById('sb-copy-route-label')?.textContent === 'Copied!'",
    'SimBrief copied-route button feedback',
  );
  const clipboardWrites = await evaluate(windowRef, 'window.__ffClipboardWrites.slice()');
  assert.deepEqual(
    clipboardWrites,
    ['DCT SENVI DCT VIGMA DCT ALLEX DCT AJJAY OOSHN5'],
    'SimBrief Copy route should write the displayed route exactly once',
  );
}

async function assertCompactFlightLayout(windowRef) {
  await waitFor(
    windowRef,
    "document.querySelector('.desktop-tab[data-tab=\"flight\"]')",
    'desktop flight tab button',
  );
  await click(windowRef, "document.querySelector('.desktop-tab[data-tab=\"flight\"]')", 'Flight tab for compact layout');
  await waitFor(
    windowRef,
    "document.getElementById('tab-flight')?.classList.contains('active') && document.getElementById('flight-primary-grid')",
    'Flight tab compact layout targets',
  );

  const result = await evaluate(
    windowRef,
    `(() => {
      const cards = Array.from(document.querySelectorAll('#flight-primary-grid .flight-metric-card, #flight-secondary-grid .flight-metric-card'))
        .filter((element) => getComputedStyle(element).display !== 'none')
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return { id: element.id, width: rect.width, height: rect.height };
        });
      const primaryGrid = document.getElementById('flight-primary-grid');
      const primaryColumns = primaryGrid ? getComputedStyle(primaryGrid).gridTemplateColumns.split(' ').length : 0;
      return { cards, primaryColumns, viewportWidth: window.innerWidth };
    })();`,
  );

  assert.ok(result.cards.length >= 6, 'Flight layout should render visible telemetry cards');
  assert.deepEqual(
    result.cards.filter((card) => card.height > 150),
    [],
    'Flight telemetry cards should keep a compact default height',
  );
  if (result.viewportWidth >= 1024) {
    assert.ok(result.primaryColumns >= 4, 'Desktop flight layout should use compact primary columns');
    assert.deepEqual(
      result.cards.filter((card) => card.width > 360),
      [],
      'Desktop flight telemetry cards should not stretch into billboard tiles',
    );
  }
}

async function assertHeaderLayout(windowRef) {
  await waitFor(
    windowRef,
    "document.getElementById('app-header') && document.getElementById('flight-time') && document.getElementById('aircraft-name')",
    'app header layout targets',
  );
  await waitFor(
    windowRef,
    "document.querySelectorAll('#aircraft-profile-correction-select option').length >= 3",
    'authorized bundled aircraft profile selector',
  );

  const profileOptions = await evaluate(
    windowRef,
    `Array.from(document.querySelectorAll('#aircraft-profile-correction-select option')).map((option) => ({
      value: option.value,
      label: option.textContent.trim(),
    }))`,
  );
  assert.deepEqual(profileOptions, [
    { value: 'auto', label: 'Automatic detection (recommended)' },
    { value: 'bundled/msfs/asobo-a320neo', label: 'Asobo A320neo' },
    { value: 'bundled/msfs/pmdg-777', label: 'PMDG 777' },
  ], 'authorized selector should expose exactly automatic detection and bundled profile choices');

  await setInputValue(
    windowRef,
    'aircraft-profile-correction-select',
    'bundled/msfs/pmdg-777',
  );
  await waitFor(
    windowRef,
    "document.getElementById('aircraft-profile-name')?.textContent.includes('Manual override')",
    'bundled aircraft profile selection acknowledgement',
  );

  const result = await evaluate(
    windowRef,
    `(() => {
      const selectors = [
        '#app-header',
        '.app-header-row',
        '.app-brand-block',
        '.header-controls',
        '.header-activity-controls',
        '.header-flight-meta',
        '#dest-progress-wrap',
      ];
      const rows = selectors.map((selector) => {
        const element = document.querySelector(selector);
        if (!element) return { selector, missing: true };
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const visible = style.display !== 'none' && rect.width > 0 && rect.height > 0;
        return {
          selector,
          visible,
          width: rect.width,
          height: rect.height,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
        };
      });
      const pageWidth = Math.max(
        document.documentElement.scrollWidth || 0,
        document.body?.scrollWidth || 0,
      );
      return {
        viewportWidth: window.innerWidth,
        pageWidth,
        rows,
        hasPaIndicator: Boolean(document.getElementById('pa-indicator')),
      };
    })();`,
  );

  assert.equal(result.hasPaIndicator, false, 'Header should not render a PA indicator');
  assert.deepEqual(
    result.rows.filter((row) => row.missing).map((row) => row.selector),
    [],
    'Header layout should render expected sections',
  );
  assert.ok(
    result.pageWidth <= result.viewportWidth + 32,
    'Header layout should not create page-level horizontal overflow',
  );
  assert.deepEqual(
    result.rows.filter((row) => row.visible && (row.width < 80 || row.right > result.viewportWidth + 24 || row.left < -24)),
    [],
    'Header sections should stay within the viewport',
  );
}

async function assertTimelineEventLayout(windowRef) {
  const result = await evaluate(
    windowRef,
    `(() => {
      const rows = Array.from(document.querySelectorAll('#timeline-event-list .timeline-event')).slice(0, 6);
      return rows.map((row, index) => {
        const time = row.querySelector('.timeline-event-time');
        const dot = row.querySelector('.timeline-event-dot');
        const body = row.querySelector('.timeline-event-body');
        const rowRect = row.getBoundingClientRect();
        const timeRect = time?.getBoundingClientRect();
        const dotRect = dot?.getBoundingClientRect();
        const bodyRect = body?.getBoundingClientRect();
        const dotStyle = dot ? getComputedStyle(dot) : null;
        return {
          index,
          hasTime: Boolean(time),
          hasDot: Boolean(dot),
          hasBody: Boolean(body),
          rowWidth: rowRect.width,
          rowHeight: rowRect.height,
          timeRight: timeRect?.right || 0,
          dotLeft: dotRect?.left || 0,
          dotRight: dotRect?.right || 0,
          dotWidth: dotRect?.width || 0,
          dotHeight: dotRect?.height || 0,
          bodyLeft: bodyRect?.left || 0,
          dotBackground: dotStyle?.backgroundColor || '',
        };
      });
    })();`,
  );

  assert.ok(result.length >= 4, 'Timeline should render multiple event rows for layout checks');
  assert.deepEqual(
    result.filter((row) => !row.hasTime || !row.hasDot || !row.hasBody),
    [],
    'Timeline event rows should render separate time, dot, and content lanes',
  );
  assert.deepEqual(
    result.filter((row) => row.dotWidth < 8 || row.dotHeight < 8 || row.dotBackground === 'rgba(0, 0, 0, 0)'),
    [],
    'Timeline event dots should be visible and large enough to read',
  );
  assert.deepEqual(
    result.filter((row) => row.timeRight > row.dotLeft - 3 || row.dotRight > row.bodyLeft - 3),
    [],
    'Timeline event dots should not overlap timestamps or event content',
  );
}

async function assertRoundedContainer(windowRef, selector, label) {
  const result = await evaluate(
    windowRef,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return { missing: true };
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        missing: false,
        width: rect.width,
        height: rect.height,
        borderTopLeftRadius: Number.parseFloat(style.borderTopLeftRadius) || 0,
        borderTopRightRadius: Number.parseFloat(style.borderTopRightRadius) || 0,
        borderBottomRightRadius: Number.parseFloat(style.borderBottomRightRadius) || 0,
        borderBottomLeftRadius: Number.parseFloat(style.borderBottomLeftRadius) || 0,
      };
    })();`,
  );

  assert.equal(result.missing, false, `${label} container should exist`);
  assert.ok(result.width > 240 && result.height > 80, `${label} container should be visibly sized`);
  assert.deepEqual(
    [
      result.borderTopLeftRadius,
      result.borderTopRightRadius,
      result.borderBottomRightRadius,
      result.borderBottomLeftRadius,
    ].filter((radius) => radius < 7),
    [],
    `${label} container should use app card rounding`,
  );
}

async function runSettingsSmoke(windowRef) {
  await waitFor(
    windowRef,
    "document.querySelector('.desktop-tab[data-tab=\"settings\"]')",
    'desktop settings tab button',
  );
  await waitFor(
    windowRef,
    "document.getElementById('vue-settings-action-bar-root')",
    'Vue settings action mount root',
  );

  await click(windowRef, "document.querySelector('.desktop-tab[data-tab=\"settings\"]')", 'Settings tab');
  await waitFor(
    windowRef,
    "document.getElementById('tab-settings')?.classList.contains('active')",
    'Settings tab activation',
  );
  await waitFor(
    windowRef,
    "document.getElementById('setting-cabin-announcements-enabled')?.checked === true",
    'initial settings payload',
  );
  await waitFor(
    windowRef,
    "document.getElementById('settings-save-btn')?.disabled === true",
    'clean settings form state',
  );
  await assertUsableLayout(windowRef, 'Settings tab', [
    '#tab-settings.active',
    '#tab-settings .page-stack',
    '#tab-settings .settings-panel-grid',
  ]);
  await assertRoundedContainer(windowRef, '#tab-settings .settings-about-card', 'Settings about');

  await evaluate(
    windowRef,
    'window.__confirmCalls = 0; window.confirm = () => { window.__confirmCalls += 1; return true; }; true;',
  );
  await click(windowRef, "document.querySelector('.desktop-tab[data-tab=\"livemap\"]')", 'Live tab from clean Settings');
  await waitFor(
    windowRef,
    "document.getElementById('tab-livemap')?.classList.contains('active')",
    'Live tab activation',
  );
  const cleanLeaveConfirmCalls = await evaluate(windowRef, 'window.__confirmCalls');
  assert.equal(cleanLeaveConfirmCalls, 0, 'Leaving untouched Settings should not trigger a confirmation dialog');

  await click(windowRef, "document.querySelector('.desktop-tab[data-tab=\"settings\"]')", 'Settings tab again');
  await waitFor(
    windowRef,
    "document.getElementById('tab-settings')?.classList.contains('active')",
    'Settings tab re-activation',
  );
  await setInputValue(windowRef, 'setting-cabin-announcements-style', 'concise');
  await waitFor(
    windowRef,
    "document.getElementById('settings-save-btn')?.disabled === false",
    'dirty Settings save button enabled state',
  );
  await waitFor(
    windowRef,
    "!document.getElementById('settings-pending-bar')?.classList.contains('hidden')",
    'visible Settings pending bar',
  );
  await click(windowRef, "document.getElementById('settings-save-btn')", 'Settings save button');
  await waitFor(
    windowRef,
    "(() => { const text = document.getElementById('settings-status')?.textContent || ''; return text.includes('applied immediately') || text === 'Saved to settings file.'; })()",
    'successful Settings save status',
  );
  await waitFor(
    windowRef,
    "document.getElementById('settings-pending-bar')?.classList.contains('hidden')",
    'hidden Settings pending bar after save',
  );
}

async function runAircraftSearchSmoke(windowRef) {
  await waitFor(
    windowRef,
    "document.querySelector('.desktop-tab[data-tab=\"autopilot\"]')",
    'desktop Aircraft tab button',
  );
  await click(windowRef, "document.querySelector('.desktop-tab[data-tab=\"autopilot\"]')", 'Aircraft tab');
  await waitFor(
    windowRef,
    "document.getElementById('tab-autopilot')?.classList.contains('active')",
    'Aircraft tab activation',
  );
  await waitFor(
    windowRef,
    "document.getElementById('aircraft-find-input')",
    'Aircraft page search input',
  );

  const shortcutFocusedSearch = await evaluate(windowRef, `(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'f',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }));
    return document.activeElement?.id === 'aircraft-find-input';
  })();`);
  assert.equal(shortcutFocusedSearch, true, 'Ctrl+F should focus Aircraft search while the Aircraft tab is active');

  await setInputValue(windowRef, 'aircraft-find-input', 'gear');
  await waitFor(
    windowRef,
    "document.getElementById('aircraft-find-status')?.textContent.includes(' of ')",
    'Aircraft search match count',
  );
  await waitFor(
    windowRef,
    "document.querySelectorAll('[data-aircraft-find-match=\"true\"]').length >= 2 && document.querySelectorAll('[data-aircraft-find-current=\"true\"]').length === 1",
    'Aircraft search match highlighting',
  );

  const navigationAdvanced = await evaluate(windowRef, `(() => {
    const before = document.querySelector('[data-aircraft-find-current="true"]');
    document.querySelector('[aria-label="Next match"]')?.click();
    return before !== document.querySelector('[data-aircraft-find-current="true"]');
  })();`);
  assert.equal(navigationAdvanced, true, 'Aircraft search Next should advance to a different match');

  await setInputValue(windowRef, 'aircraft-find-input', 'heading');
  await waitFor(
    windowRef,
    "document.getElementById('aircraft-find-status')?.textContent.includes(' of ')",
    'Aircraft search common abbreviation matching',
  );
  assert.ok(
    await evaluate(windowRef, "document.querySelector('[data-aircraft-find-current=\"true\"]')?.textContent.includes('HDG')"),
    'Aircraft search should find the cockpit HDG label from the plain-language heading query',
  );

  await setInputValue(windowRef, 'aircraft-find-input', 'landing light');
  await waitFor(
    windowRef,
    "document.querySelector('[data-aircraft-find-current=\"true\"]')?.textContent.includes('LANDING')",
    'generic landing-light control search match',
  );

  windowRef.setContentSize(390, 844);
  await wait(150);
  const mobileSearch = await evaluate(windowRef, `(() => {
    const bar = document.querySelector('.aircraft-find');
    const field = document.querySelector('.aircraft-find__field');
    const buttons = [...document.querySelectorAll('.aircraft-find__navigation button')];
    const genericLightButtons = [...document.querySelectorAll('.generic-light-command')];
    if (!bar || !field || buttons.length !== 2) return { missing: true };
    const barRect = bar.getBoundingClientRect();
    const fieldRect = field.getBoundingClientRect();
    return {
      missing: false,
      viewportWidth: window.innerWidth,
      pageWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
      barLeft: barRect.left,
      barRight: barRect.right,
      fieldHeight: fieldRect.height,
      buttonSizes: buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
      genericLightButtonCount: genericLightButtons.length,
      undersizedGenericLightButtons: genericLightButtons.filter((button) => {
        const rect = button.getBoundingClientRect();
        return rect.width < 44 || rect.height < 44;
      }).length,
      position: getComputedStyle(bar).position,
    };
  })();`);
  assert.equal(mobileSearch.missing, false, 'mobile Aircraft search controls should render');
  assert.equal(mobileSearch.position, 'sticky', 'Aircraft search should remain reachable while scrolling on a phone');
  assert.ok(mobileSearch.fieldHeight >= 44, 'mobile Aircraft search field should meet the 44px touch target');
  assert.deepEqual(
    mobileSearch.buttonSizes.filter((size) => size.width < 44 || size.height < 44),
    [],
    'mobile Aircraft result navigation should use 44px touch targets',
  );
  assert.equal(mobileSearch.genericLightButtonCount, 10, 'generic Aircraft page should render explicit OFF/ON controls for five exterior lights');
  assert.equal(mobileSearch.undersizedGenericLightButtons, 0, 'generic exterior-light controls should keep 44px phone touch targets');
  assert.ok(mobileSearch.barLeft >= -2 && mobileSearch.barRight <= mobileSearch.viewportWidth + 2, 'mobile Aircraft search should fit the viewport');
  assert.ok(mobileSearch.pageWidth <= mobileSearch.viewportWidth + 2, 'mobile Aircraft search should not introduce horizontal overflow');
  windowRef.setContentSize(viewportWidth, viewportHeight);
  await wait(150);

  await click(windowRef, "document.querySelector('[aria-label=\"Clear Aircraft search\"]')", 'Aircraft search clear button');
  await waitFor(
    windowRef,
    "document.getElementById('aircraft-find-input')?.value === '' && !document.querySelector('[data-aircraft-find-match]')",
    'cleared Aircraft search state',
  );
}

async function runLiveMapSmoke(windowRef) {
  await waitFor(
    windowRef,
    "document.querySelector('#vue-status-root .text-sm')?.textContent.includes('WS Ready')",
    'ready websocket before Live Map route actions',
  );
  await click(windowRef, "document.querySelector('.desktop-tab[data-tab=\"livemap\"]')", 'Live Map tab');
  await waitFor(
    windowRef,
    "document.getElementById('tab-livemap')?.classList.contains('active')",
    'Live Map tab activation',
  );
  await waitFor(
    windowRef,
    "document.getElementById('live-map-meta')?.textContent.includes('Lat 39.87440')",
    'initial live-map telemetry metadata',
  );
  await waitFor(
    windowRef,
    "document.getElementById('live-map-follow-status')?.textContent.includes('Following')",
    'Live Map follow state',
  );
  await assertUsableLayout(windowRef, 'Live Map tab', [
    '#tab-livemap.active',
    '#tab-livemap .live-map-card-shell',
    '#tab-livemap .live-map-wrap',
    '#live-map',
  ]);
  await assertRoundedContainer(windowRef, '#tab-livemap .live-map-card-shell', 'Live Map');

  await waitFor(
    windowRef,
    "document.getElementById('live-map-route-inputs') && !document.getElementById('live-map-route-inputs')?.classList.contains('hidden')",
    'Live Map route inputs visibility',
  );

  await setInputValue(windowRef, 'live-map-target-icao', 'KBOS');
  await click(windowRef, "document.getElementById('live-map-target-set-btn')", 'Live Map Set Target button');
  await waitFor(
    windowRef,
    "document.getElementById('live-map-target-status')?.textContent.includes('Target set: KBOS')",
    'Live Map target status',
  );
  await waitFor(
    windowRef,
    "document.getElementById('live-map-target-primary')?.textContent.includes('KBOS')",
    'Live Map target overlay',
  );
  await waitFor(
    windowRef,
    "!document.getElementById('dest-progress-wrap')?.classList.contains('hidden') && document.getElementById('dest-progress-label')?.textContent.includes('To KBOS')",
    'Live Map destination progress bar',
  );

  await setInputValue(windowRef, 'live-map-origin-icao', 'KPHL');
  await click(windowRef, "document.getElementById('live-map-origin-set-btn')", 'Live Map Set From button');
  await waitFor(
    windowRef,
    "document.getElementById('live-map-origin-status')?.textContent.includes('From set: KPHL')",
    'Live Map origin status',
  );
  await waitFor(
    windowRef,
    "document.getElementById('dest-progress-label')?.textContent.includes('From KPHL -> To KBOS')",
    'Live Map route progress label',
  );

  await click(windowRef, "document.getElementById('live-map-target-clear-btn')", 'Live Map Clear Target button');
  await waitFor(
    windowRef,
    "document.getElementById('live-map-target-status')?.textContent.includes('No target airport set')",
    'Live Map cleared target status',
  );
  await waitFor(
    windowRef,
    "document.getElementById('live-map-target-overlay')?.style.display === 'none' && document.getElementById('dest-progress-wrap')?.classList.contains('hidden')",
    'Live Map cleared target overlay and progress',
  );
}

async function runTimelineSmoke(windowRef) {
  await click(windowRef, "document.querySelector('.desktop-tab[data-tab=\"timeline\"]')", 'Timeline tab');
  await waitFor(
    windowRef,
    "document.getElementById('tab-timeline')?.classList.contains('active')",
    'Timeline tab activation',
  );
  await waitFor(
    windowRef,
    "document.querySelector('#tab-timeline .cursor-pointer') && document.querySelector('#tab-timeline .cursor-pointer').textContent.includes('KPHL -> KBOS')",
    'Timeline flights list content',
  );

  await click(windowRef, "document.querySelector('#tab-timeline .cursor-pointer')", 'first Timeline flight');
  await waitFor(
    windowRef,
    "document.querySelector('#vue-timeline-summary-root dl')?.textContent.includes('Violations')",
    'Timeline summary bar',
  );
  await waitFor(
    windowRef,
    "document.getElementById('timeline-flight-id')?.textContent.includes('KPHL -> KBOS')",
    'loaded Timeline header route',
  );
  await waitFor(
    windowRef,
    "document.querySelectorAll('#timeline-event-list .timeline-event').length >= 4",
    'loaded Timeline events',
  );
  await waitFor(
    windowRef,
    "(() => { const row = Array.from(document.querySelectorAll('#timeline-event-list .timeline-event')).find((element) => element.textContent.includes('Landing at')); return row?.textContent.includes('TD RATE PERFECT') && row.textContent.includes('APP MARGINAL') && row.textContent.includes('BNC 1x'); })()",
    'Timeline landing row shows scoped touchdown-rate grade, failed approach, and bounce',
  );
  await assertTimelineEventLayout(windowRef);
  const eventListHeightBeforeOverlays = await evaluate(
    windowRef,
    "document.getElementById('timeline-events')?.getBoundingClientRect().height || 0",
  );
  await click(windowRef, "document.getElementById('timeline-open-analysis-rescore-btn')", 'Timeline scoring review button');
  await waitFor(
    windowRef,
    "document.getElementById('timeline-analysis-rescore-modal')?.getAttribute('role') === 'dialog'",
    'Timeline scoring review modal',
  );
  await assertUsableLayout(windowRef, 'Timeline scoring review modal', [
    '#timeline-analysis-rescore-modal',
    '#timeline-analysis-rescore-modal .timeline-analysis-modal-shell',
    '#timeline-analysis-rescore-content',
  ]);
  await click(windowRef, "document.getElementById('timeline-analysis-rescore-close')", 'Timeline scoring review close button');
  await waitFor(
    windowRef,
    "!document.getElementById('timeline-analysis-rescore-modal')",
    'closed Timeline scoring review modal',
  );
  await click(windowRef, "Array.from(document.querySelectorAll('#timeline-event-list .timeline-event')).find((element) => element.textContent.includes('Landing at'))", 'Timeline landing event row');
  await waitFor(
    windowRef,
    "document.getElementById('timeline-detail') && document.getElementById('timeline-detail-title')?.textContent.includes('Landing at KBOS 27')",
    'Timeline landing detail drawer',
  );
  const overlayLayout = await evaluate(
    windowRef,
    `(() => {
      const events = document.getElementById('timeline-events')?.getBoundingClientRect();
      const card = document.getElementById('timeline-card')?.getBoundingClientRect();
      const drawer = document.getElementById('timeline-detail')?.getBoundingClientRect();
      return {
        eventListHeight: events?.height || 0,
        cardRight: card?.right || 0,
        drawerLeft: drawer?.left || 0,
      };
    })();`,
  );
  assert.ok(
    overlayLayout.eventListHeight >= eventListHeightBeforeOverlays - 2,
    'Timeline overlays must not steal vertical space from the event list',
  );
  assert.ok(
    overlayLayout.drawerLeft >= overlayLayout.cardRight - 2,
    'Timeline event details should overlay the replay side instead of the event-list column',
  );
  await assertUsableLayout(windowRef, 'Timeline tab', [
    '#tab-timeline.active',
    '#tab-timeline .timeline-split',
    '#timeline-card',
    '#timeline-map-card',
    '#timeline-detail',
  ]);
  await waitFor(
    windowRef,
    "(() => { const detail = document.getElementById('timeline-detail'); const text = document.getElementById('timeline-detail-metrics')?.textContent || ''; return text.includes('Touchdown Rate Grade') && text.includes('PERFECT') && text.includes('TDZ') && text.includes('MARGINAL') && text.includes('Bounce') && !text.toLowerCase().includes('touchdown zone analysis') && !detail?.querySelector('#timeline-approach-profile, #timeline-topdown-profile') && document.getElementById('timeline-open-landing-btn'); })()",
    'Timeline landing detail metrics and action',
  );
  await click(windowRef, "document.getElementById('timeline-open-landing-btn')", 'Timeline Open Landing Debrief button');
  await waitFor(
    windowRef,
    "document.getElementById('landing-modal')?.getAttribute('role') === 'dialog' && document.getElementById('tab-timeline')?.classList.contains('active')",
    'Open Landing Debrief opens modal without replacing Timeline tab',
  );
  await waitFor(
    windowRef,
    "document.querySelector('#landing-modal #landing-card') && document.querySelector('#landing-modal #landing-airport')?.textContent.includes('KBOS') && document.querySelector('#landing-modal #landing-grade')?.textContent.includes('PERFECT') && document.querySelector('#landing-modal #landing-summary-approach')?.textContent.includes('MARGINAL') && document.querySelector('#landing-modal #landing-summary-bounce')?.textContent.includes('1x')",
    'Open Landing Debrief renders selected landing card',
  );
  await assertUsableLayout(windowRef, 'Landing debrief modal', [
    '#landing-modal',
    '#landing-modal .landing-modal-shell',
    '#landing-modal #landing-card',
  ]);
}

async function runReconnectSmoke(windowRef) {
  await waitFor(
    windowRef,
    "document.querySelector('#vue-status-root .text-sm')?.textContent.includes('WS Ready')",
    'initial ready websocket status',
  );

  console.log('[smoke-control] disconnect-now');

  await waitFor(
    windowRef,
    "document.querySelector('#vue-status-root .text-sm')?.textContent.includes('Disconnected')",
    'disconnected websocket status',
    timeoutMs + 3000,
  );
  await waitFor(
    windowRef,
    "!document.getElementById('aircraft-profile-correction')",
    'profile selector fail-closed disconnect state',
    timeoutMs + 3000,
  );
  await waitFor(
    windowRef,
    "document.getElementById('flight-state-title')?.textContent.includes('Telemetry disconnected')",
    'flight-state disconnect panel',
    timeoutMs + 3000,
  );
  await waitFor(
    windowRef,
    "(() => { const text = document.querySelector('#vue-status-root .text-sm')?.textContent || ''; return text.includes('Connecting...') || text.includes('WS Ready'); })()",
    'reconnecting websocket status transition',
    timeoutMs + 5000,
  );
  await waitFor(
    windowRef,
    "document.querySelector('#vue-status-root .text-sm')?.textContent.includes('WS Ready')",
    'recovered websocket status',
    timeoutMs + 8000,
  );
  await waitFor(
    windowRef,
    "document.getElementById('aircraft-profile-correction-select')?.value === 'bundled/msfs/pmdg-777'",
    'bundled aircraft profile selection after reconnect',
    timeoutMs + 5000,
  );

  await click(windowRef, "document.querySelector('.desktop-tab[data-tab=\"livemap\"]')", 'Live Map tab after reconnect');
  await waitFor(
    windowRef,
    "document.getElementById('tab-livemap')?.classList.contains('active')",
    'Live Map tab activation after reconnect',
  );
  await waitFor(
    windowRef,
    "(() => { const text = document.getElementById('live-map-origin-status')?.textContent || ''; return text.includes('From synced: KPHL') || text.includes('From set: KPHL'); })()",
    'Live Map origin retained after reconnect',
    timeoutMs + 5000,
  );
  await waitFor(
    windowRef,
    "document.getElementById('live-map-target-status')?.textContent.includes('No target airport set')",
    'Live Map destination clear state after reconnect',
  );
  await waitFor(
    windowRef,
    "document.getElementById('live-map-meta')?.textContent.includes('Lat 39.87440')",
    'Live Map telemetry metadata after reconnect',
  );
}

async function runSmoke(windowRef) {
  await assertHeaderLayout(windowRef);
  if (headerOnly) return;

  await assertCompactFlightLayout(windowRef);
  await assertSimbriefLayout(windowRef);
  await runSettingsSmoke(windowRef);
  await runAircraftSearchSmoke(windowRef);
  await runLiveMapSmoke(windowRef);
  await runTimelineSmoke(windowRef);
  await runReconnectSmoke(windowRef);
}

async function main() {
  await app.whenReady();

  const windowRef = new BrowserWindow({
    show: false,
    width: viewportWidth,
    height: viewportHeight,
    backgroundColor: '#0b1220',
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });

  windowRef.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[browser:${level}] ${message}${sourceId ? ` @ ${sourceId}:${line}` : ''}`);
  });

  await windowRef.loadURL(targetUrl);
  await seedSimbriefFixture(windowRef);
  await windowRef.loadURL(targetUrl);
  await installClipboardProbe(windowRef);
  await runSmoke(windowRef);
  await windowRef.close();
  await app.quit();
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
  app.exit(1);
});
