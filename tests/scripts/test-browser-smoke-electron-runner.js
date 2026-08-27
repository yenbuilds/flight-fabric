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

async function setContentSizeAndWait(windowRef, width, height, description) {
  windowRef.setContentSize(width, height);
  await waitFor(
    windowRef,
    `Math.abs(window.innerWidth - ${width}) <= 2 && Math.abs(window.innerHeight - ${height}) <= 2`,
    `${description} viewport resize`,
  );
  await wait(50);
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

async function assertMapLibreWorkerRuntime(windowRef) {
  const result = await evaluate(windowRef, `new Promise((resolve) => {
    let settled = false;
    let worker = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { worker?.terminate(); } catch {}
      resolve(value);
    };

    try {
      worker = new Worker('/maplibre-gl-worker.mjs', { type: 'module' });
      worker.addEventListener('error', (event) => {
        finish({ ok: false, message: event.message || 'MapLibre module worker failed to load' });
      }, { once: true });
      setTimeout(() => finish({ ok: true, message: '' }), 750);
    } catch (error) {
      finish({ ok: false, message: error?.message || String(error) });
    }
  })`);

  assert.equal(result?.ok, true, `MapLibre module worker should load in Electron: ${result?.message || 'unknown error'}`);
}

async function assertMobileShellLayout(windowRef) {
  for (const [width, height, label] of [
    [390, 844, 'phone'],
    [700, 900, 'compact tablet'],
  ]) {
    await setContentSizeAndWait(windowRef, width, height, label);

    const result = await evaluate(windowRef, `(() => {
      const mobileBar = document.querySelector('.mobile-tab-bar');
      const desktopBar = document.querySelector('.desktop-tab-stage');
      const header = document.getElementById('app-header');
      const desktopHeaderStatus = document.querySelector('.header-desktop-status');
      const phoneSetupButton = document.getElementById('header-mobile-access-btn');
      const main = document.querySelector('main');
      const barRect = mobileBar?.getBoundingClientRect();
      const headerRect = header?.getBoundingClientRect();
      const buttons = [...document.querySelectorAll('.mobile-tab-bar .mobile-tab')];
      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        bodyHeight: document.body?.getBoundingClientRect().height || 0,
        pageWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
        bodyOverflow: getComputedStyle(document.body).overflow,
        mainScrollable: Boolean(main && main.scrollHeight > main.clientHeight),
        mobileDisplay: mobileBar ? getComputedStyle(mobileBar).display : 'missing',
        desktopDisplay: desktopBar ? getComputedStyle(desktopBar).display : 'missing',
        headerHeight: headerRect?.height || 0,
        desktopHeaderStatusVisible: Boolean(desktopHeaderStatus && desktopHeaderStatus.getClientRects().length > 0),
        phoneSetupVisible: Boolean(phoneSetupButton && phoneSetupButton.getClientRects().length > 0),
        barRect: barRect ? { left: barRect.left, right: barRect.right, top: barRect.top, bottom: barRect.bottom } : null,
        buttonSizes: buttons.map((button) => {
          const rect = button.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        }),
      };
    })();`);

    assert.equal(result.mobileDisplay, 'grid', `${label} should use the mobile bottom navigation`);
    assert.equal(result.desktopDisplay, 'none', `${label} should hide the desktop tab strip`);
    assert.ok(result.headerHeight > 0 && result.headerHeight <= 112, `${label} header should remain compact`);
    assert.equal(result.desktopHeaderStatusVisible, false, `${label} should hide the desktop-only header status row`);
    assert.equal(result.phoneSetupVisible, false, `${label} should hide the desktop-only Phone setup shortcut`);
    assert.equal(result.bodyOverflow, 'hidden', `${label} should keep scrolling inside the app main region`);
    assert.ok(Math.abs(result.bodyHeight - result.viewportHeight) <= 2, `${label} shell should match the dynamic viewport height`);
    assert.ok(result.pageWidth <= result.viewportWidth + 2, `${label} shell should not overflow horizontally`);
    assert.ok(result.mainScrollable, `${label} should preserve a scrollable content region`);
    assert.ok(result.barRect && result.barRect.left >= 0 && result.barRect.right <= result.viewportWidth, `${label} navigation should fit the viewport`);
    assert.ok(result.barRect && result.barRect.top >= 0 && result.barRect.bottom <= result.viewportHeight, `${label} navigation should remain visible`);
    assert.equal(result.buttonSizes.length, 5, `${label} should render five primary mobile navigation targets`);
    assert.deepEqual(
      result.buttonSizes.filter((size) => size.width < 44 || size.height < 44),
      [],
      `${label} navigation should keep 44px touch targets`,
    );

    await click(windowRef, "document.getElementById('mobile-more-btn')", `${label} More navigation`);
    await waitFor(
      windowRef,
      "getComputedStyle(document.getElementById('mobile-more-sheet')).display !== 'none'",
      `${label} More sheet`,
    );
    const moreSheet = await evaluate(windowRef, `(() => {
      const sheet = document.getElementById('mobile-more-sheet');
      const panel = sheet?.querySelector('.mobile-more-panel');
      const panelRect = panel?.getBoundingClientRect();
      const items = [...document.querySelectorAll('.mobile-more-item')];
      return {
        panelBottom: panelRect?.bottom || 0,
        panelTop: panelRect?.top || 0,
        itemHeights: items.map((item) => item.getBoundingClientRect().height),
      };
    })();`);
    assert.ok(moreSheet.panelTop >= 0 && moreSheet.panelBottom <= result.viewportHeight + 2, `${label} More sheet should fit the visible viewport`);
    assert.deepEqual(moreSheet.itemHeights.filter((heightValue) => heightValue < 44), [], `${label} More items should keep 44px touch targets`);
    await click(windowRef, "document.querySelector('.mobile-more-close')", `${label} More close button`);
  }

  await setContentSizeAndWait(windowRef, viewportWidth, viewportHeight, 'desktop restore');
}

async function assertHeaderLayout(windowRef) {
  const headerTestWidth = Math.min(viewportWidth, 1366);
  if (headerTestWidth !== viewportWidth) {
    await setContentSizeAndWait(windowRef, headerTestWidth, viewportHeight, 'narrow desktop header');
  }
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
    { value: 'bundled/msfs/fenix-a320', label: 'Fenix A320' },
    { value: 'bundled/msfs/fbw-a32nx', label: 'FlyByWire A32NX' },
    { value: 'bundled/msfs/fbw-a380x', label: 'FlyByWire A380X' },
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
      const phoneSetupButton = document.getElementById('header-mobile-access-btn');
      const phoneSetupRect = phoneSetupButton?.getBoundingClientRect();
      const profileCorrection = document.getElementById('aircraft-profile-correction-btn');
      const profileCorrectionRect = profileCorrection?.getBoundingClientRect();
      const profileSummary = document.getElementById('aircraft-profile-name');
      const profileSummaryRect = profileSummary?.getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        pageWidth,
        rows,
        hasPaIndicator: Boolean(document.getElementById('pa-indicator')),
        phoneSetup: {
          visible: Boolean(phoneSetupButton && phoneSetupButton.getClientRects().length > 0),
          left: phoneSetupRect?.left || 0,
          right: phoneSetupRect?.right || 0,
          top: phoneSetupRect?.top || 0,
          bottom: phoneSetupRect?.bottom || 0,
        },
        profileCorrection: {
          visible: Boolean(profileCorrection && profileCorrection.getClientRects().length > 0),
          left: profileCorrectionRect?.left || 0,
          right: profileCorrectionRect?.right || 0,
        },
        profileSummary: {
          left: profileSummaryRect?.left || 0,
          right: profileSummaryRect?.right || 0,
          width: profileSummaryRect?.width || 0,
        },
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
  assert.equal(result.phoneSetup.visible, true, 'desktop header should keep the Phone setup action visible');
  assert.ok(
    result.phoneSetup.left >= 0 && result.phoneSetup.right <= result.viewportWidth,
    'desktop Phone setup action should fit horizontally in the viewport',
  );
  assert.ok(
    result.phoneSetup.top >= 0 && result.phoneSetup.bottom > result.phoneSetup.top,
    'desktop Phone setup action should remain in the visible header',
  );
  assert.equal(result.profileCorrection.visible, true, 'desktop header should keep aircraft correction reachable');
  assert.ok(
    result.profileCorrection.left >= 0 && result.profileCorrection.right <= result.viewportWidth,
    'desktop aircraft correction action should fit horizontally in the viewport',
  );
  assert.ok(result.profileSummary.width >= 64, 'desktop aircraft profile summary should retain meaningful readable width');
  assert.ok(
    result.profileSummary.right <= result.profileCorrection.left + 1,
    'desktop aircraft summary and correction action should not overlap',
  );
  assert.deepEqual(
    result.rows.filter((row) => row.visible && (row.width < 80 || row.right > result.viewportWidth + 24 || row.left < -24)),
    [],
    'Header sections should stay within the viewport',
  );

  if (headerTestWidth !== viewportWidth) {
    await setContentSizeAndWait(windowRef, viewportWidth, viewportHeight, 'desktop header restore');
  }
}

async function runSecondScreenSetupSmoke(windowRef) {
  await waitFor(
    windowRef,
    "document.getElementById('header-mobile-access-btn')",
    'desktop Phone setup action',
  );
  await click(windowRef, "document.getElementById('header-mobile-access-btn')", 'desktop Phone setup action');
  await waitFor(
    windowRef,
    "document.getElementById('tab-system')?.classList.contains('active') && document.getElementById('system-mobile-qr')",
    'single phone QR',
  );

  const setup = await evaluate(windowRef, `(() => ({
    phoneUrl: document.getElementById('system-remote-url')?.textContent.trim() || '',
    instructions: document.getElementById('system-mobile-pairing-note')?.textContent || '',
    qrLabel: document.querySelector('#system-mobile-qr svg')?.getAttribute('aria-label') || '',
    qrCount: document.querySelectorAll('#system-mobile-access [role="img"]').length,
  }))();`);
  assert.ok(setup.phoneUrl.includes('/remote?wsPort='), 'Phone setup should render the phone URL');
  assert.ok(setup.phoneUrl.includes('aircraftControlToken=browser-smoke-aircraft-control'), 'phone URL should carry only the current test-session token');
  assert.equal(setup.qrCount, 1, 'Phone setup should offer exactly one QR choice');
  assert.ok(setup.instructions.includes('Starting a new flight does not require another scan'), 'Phone setup should distinguish new flights from backend restarts');
  assert.ok(setup.instructions.includes('scan again only after the Flight Fabric backend restarts'), 'Phone setup should explain when the single QR must be scanned again');
  assert.ok(setup.qrLabel.includes(setup.phoneUrl), 'phone QR should encode the current-session phone URL');

  await click(windowRef, "document.getElementById('system-mobile-copy-btn')", 'Copy phone link button');
  await waitFor(
    windowRef,
    "document.getElementById('system-mobile-copy-btn')?.textContent.includes('Copied') && window.__ffClipboardWrites?.length === 1",
    'phone link clipboard confirmation',
  );
  const copied = await evaluate(windowRef, 'window.__ffClipboardWrites[0]');
  assert.equal(copied, setup.phoneUrl, 'Copy phone link should copy the same URL encoded by the QR');
  await evaluate(windowRef, 'window.__ffClipboardWrites = []; true;');

  await assertUsableLayout(windowRef, 'Phone setup', [
    '#tab-system.active',
    '#system-mobile-access',
  ]);
}

async function assertRemoteSecondScreenGuideLayout(windowRef) {
  const remoteUrl = new URL(targetUrl);
  remoteUrl.pathname = '/remote';
  await windowRef.loadURL(remoteUrl.toString());
  await setContentSizeAndWait(windowRef, 390, 844, 'remote phone');

  await waitFor(
    windowRef,
    "document.getElementById('second-screen-guide') && document.getElementById('second-screen-guide-dismiss')",
    'phone second-screen guidance on the remote route',
  );

  const result = await evaluate(windowRef, `(() => {
    const guide = document.getElementById('second-screen-guide');
    const dismiss = document.getElementById('second-screen-guide-dismiss');
    const guideRect = guide?.getBoundingClientRect();
    const dismissRect = dismiss?.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      pageWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
      guideLeft: guideRect?.left || 0,
      guideRight: guideRect?.right || 0,
      guideHeight: guideRect?.height || 0,
      dismissWidth: dismissRect?.width || 0,
      dismissHeight: dismissRect?.height || 0,
      text: guide?.textContent || '',
    };
  })();`);

  assert.ok(result.guideHeight >= 100, 'second-screen guide should remain visibly sized on a phone');
  assert.ok(result.guideLeft >= 0 && result.guideRight <= result.viewportWidth, 'second-screen guide should fit the phone viewport');
  assert.ok(result.pageWidth <= result.viewportWidth + 2, 'second-screen guide should not introduce horizontal overflow');
  assert.ok(result.dismissWidth >= 44 && result.dismissHeight >= 44, 'second-screen guide dismissal should keep a 44px touch target');
  assert.ok(result.text.includes('New flights appear automatically'), 'phone guidance should explain that a new flight needs no scan');
  assert.ok(result.text.includes('backend restarts'), 'phone guidance should explain the control-pairing lifetime');

  await click(windowRef, "document.getElementById('second-screen-guide-dismiss')", 'second-screen guide dismissal');
  await waitFor(windowRef, "!document.getElementById('second-screen-guide')", 'dismissed second-screen guide');
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
    "document.querySelector('[data-aircraft-template=\"pmdg-777\"]') && document.getElementById('aircraft-find-input')",
    'PMDG 777 page and Aircraft search input',
  );

  const collapsedSearch = await evaluate(windowRef, `(() => {
    const bar = document.querySelector('.aircraft-find');
    const launcher = document.querySelector('.aircraft-find__launcher');
    const panel = document.getElementById('aircraft-find-panel');
    const content = document.querySelector('.aircraft-tab-search-content');
    const guide = document.querySelector('[data-aircraft-integration-guide-trigger]');
    const voice = document.querySelector('[data-aircraft-voice-control-trigger]');
    if (!bar || !launcher || !panel || !content || !guide || !voice) return { missing: true };
    const barRect = bar.getBoundingClientRect();
    const launcherRect = launcher.getBoundingClientRect();
    const guideRect = guide.getBoundingClientRect();
    const voiceRect = voice.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    return {
      missing: false,
      barHeight: barRect.height,
      launcherDisplay: getComputedStyle(launcher).display,
      panelDisplay: getComputedStyle(panel).display,
      verticalOffset: Math.abs(contentRect.top - barRect.top),
      launcherCenter: launcherRect.top + (launcherRect.height / 2),
      guideCenter: guideRect.top + (guideRect.height / 2),
      voiceCenter: voiceRect.top + (voiceRect.height / 2),
    };
  })();`);
  assert.equal(collapsedSearch.missing, false, 'collapsed Aircraft search should render');
  assert.ok(collapsedSearch.barHeight >= 44, 'collapsed Aircraft search should provide a clear touch-sized toolbar action');
  assert.equal(collapsedSearch.panelDisplay, 'none', 'Aircraft search panel should start collapsed');
  assert.notEqual(collapsedSearch.launcherDisplay, 'none', 'Aircraft search launcher should remain discoverable');
  assert.ok(collapsedSearch.verticalOffset <= 8, 'Aircraft search should remain within the centered page-tools row');
  assert.ok(Math.abs(collapsedSearch.guideCenter - collapsedSearch.launcherCenter) <= 2, 'collapsed Integration guide and search should be vertically centered together');
  assert.ok(Math.abs(collapsedSearch.voiceCenter - collapsedSearch.launcherCenter) <= 2, 'collapsed voice and search controls should be vertically centered together');

  await click(
    windowRef,
    "document.querySelector('[data-aircraft-integration-guide-trigger]')",
    'Aircraft integration guide before search shortcut check',
  );
  await waitFor(
    windowRef,
    "document.querySelector('[data-aircraft-integration-cheatsheet-modal] [role=\"dialog\"][aria-modal=\"true\"]')",
    'Aircraft integration modal before search shortcut check',
  );
  const modalShortcut = await evaluate(windowRef, `(() => {
    const dialog = document.querySelector('[data-aircraft-integration-cheatsheet-modal] [role="dialog"]');
    const input = dialog?.querySelector('input[type="search"]');
    if (!dialog || !input) return { missing: true };
    input.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'f',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    return { missing: false, defaultPrevented: event.defaultPrevented };
  })();`);
  await wait(25);
  const modalShortcutOutcome = await evaluate(windowRef, `(() => ({
    searchExpanded: Boolean(document.querySelector('.aircraft-find--expanded')),
    focusStayedInDialog: Boolean(document.activeElement?.closest?.('[role="dialog"][aria-modal="true"]')),
  }))();`);
  assert.equal(modalShortcut.missing, false, 'integration modal should expose its own search input');
  assert.equal(modalShortcut.defaultPrevented, false, 'Aircraft page search should not claim Ctrl+F from an open modal');
  assert.equal(modalShortcutOutcome.searchExpanded, false, 'Ctrl+F in a modal should not expand the background Aircraft search');
  assert.equal(modalShortcutOutcome.focusStayedInDialog, true, 'Ctrl+F in a modal should preserve modal focus containment');
  await click(
    windowRef,
    "document.querySelector('[aria-label=\"Close aircraft integration cheatsheet\"]')",
    'close Aircraft integration guide after search shortcut check',
  );
  await waitFor(
    windowRef,
    "!document.querySelector('[data-aircraft-integration-cheatsheet-modal]')",
    'closed Aircraft integration modal after search shortcut check',
  );

  await evaluate(windowRef, `(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'f',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }));
    return true;
  })();`);
  await waitFor(
    windowRef,
    "document.activeElement?.id === 'aircraft-find-input'",
    'Ctrl+F Aircraft search focus after the collapsed panel renders',
  );

  await waitFor(
    windowRef,
    "document.querySelector('[data-aircraft-quick-actions]') && document.querySelector('[data-aircraft-preset]')",
    'Aircraft preset fixture beside expanded search',
  );
  const expandedToolsLayout = await evaluate(windowRef, `(() => {
    const tools = document.querySelector('.aircraft-page-tools');
    const actions = document.querySelector('.aircraft-page-tool-actions');
    const search = document.querySelector('.aircraft-find--expanded');
    const preset = document.querySelector('[data-aircraft-quick-actions]');
    const cards = [...document.querySelectorAll('[data-aircraft-preset]')];
    if (!tools || !actions || !search || !preset || cards.length === 0) return { missing: true };
    const rect = (element) => {
      const value = element.getBoundingClientRect();
      return {
        width: value.width,
        height: value.height,
        left: value.left,
        right: value.right,
        top: value.top,
        bottom: value.bottom,
      };
    };
    return {
      missing: false,
      viewportWidth: window.innerWidth,
      pageWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
      tools: rect(tools),
      actions: rect(actions),
      search: rect(search),
      preset: rect(preset),
      parameterizedPresetVisible: Boolean(document.querySelector('[data-aircraft-preset="configuration.lighting.cockpit"]')),
      cards: cards.map((card) => ({
        card: rect(card),
        copy: rect(card.firstElementChild),
        action: rect(card.querySelector('button')),
      })),
    };
  })();`);
  assert.equal(expandedToolsLayout.missing, false, 'expanded Aircraft tools should render every layout region');
  assert.ok(
    expandedToolsLayout.preset.width >= expandedToolsLayout.tools.width * 0.98,
    'Aircraft presets should own a full row instead of collapsing beside expanded search',
  );
  assert.ok(
    expandedToolsLayout.preset.top >= expandedToolsLayout.actions.bottom + 6,
    'Aircraft presets should render below the utility toolbar',
  );
  assert.ok(expandedToolsLayout.search.width >= 360, 'expanded desktop Aircraft search should retain useful input width');
  assert.equal(expandedToolsLayout.parameterizedPresetVisible, false, 'parameterized presets should stay out of the one-tap quick-action surface');
  assert.equal(expandedToolsLayout.cards.length, 2, 'desktop fixture should exercise a realistic multi-preset grid');
  assert.deepEqual(
    expandedToolsLayout.cards.filter(({ card, copy }) => copy.width < card.width * 0.55),
    [],
    'desktop preset copy should not collapse into a word-by-word column',
  );
  assert.deepEqual(
    expandedToolsLayout.cards.filter(({ card, copy, action }) => card.height >= 180 || action.left < copy.right - 2),
    [],
    'every desktop preset should use a compact horizontal card layout',
  );
  assert.ok(
    expandedToolsLayout.pageWidth <= expandedToolsLayout.viewportWidth + 2,
    'expanded desktop Aircraft tools should not create horizontal overflow',
  );

  await setInputValue(windowRef, 'aircraft-find-input', 'light');
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
    "/HDG|HEADING/i.test(document.querySelector('[data-aircraft-find-current=\"true\"]')?.textContent || '')",
    'Aircraft search common abbreviation matching after the query refreshes',
  );

  await setInputValue(windowRef, 'aircraft-find-input', 'hyd eng pump l');
  await waitFor(
    windowRef,
    "(() => { const current = document.querySelector('[data-aircraft-find-current=\"true\"]'); return /HYD ENG PUMP L/i.test(current?.textContent || '') && current?.closest('details')?.open === true; })()",
    'PMDG 777 search result inside an initially collapsed system group',
  );

  await setInputValue(windowRef, 'aircraft-find-input', 'landing');
  await waitFor(
    windowRef,
    "document.querySelector('[data-aircraft-find-current=\"true\"]')?.textContent.includes('LANDING')",
    'PMDG 777 landing-light control search match',
  );

  await setContentSizeAndWait(windowRef, 390, 844, 'Aircraft phone');
  await waitFor(
    windowRef,
    "document.getElementById('aircraft-find-input')?.value === '' && !document.querySelector('.aircraft-find--expanded') && !document.querySelector('[data-aircraft-find-match]')",
    'mobile ribbon search state cleanup',
  );
  const mobileNavigation = await evaluate(windowRef, `(() => {
    const bar = document.querySelector('.aircraft-find');
    const ribbon = document.querySelector('.aircraft-section-ribbon');
    const buttons = [...(ribbon?.querySelectorAll('button') || [])];
    const header = document.getElementById('app-header');
    const footer = document.querySelector('.ff-app-footer');
    const destinationProgress = document.getElementById('vue-destination-progress-root');
    if (!bar || !ribbon || buttons.length !== 3) return { missing: true };
    const ribbonRect = ribbon.getBoundingClientRect();
    const headerRect = header?.getBoundingClientRect();
    const shortcutEvent = new KeyboardEvent('keydown', {
      key: 'f',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(shortcutEvent);
    return {
      missing: false,
      viewportWidth: window.innerWidth,
      pageWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
      searchDisplay: getComputedStyle(bar).display,
      ribbonDisplay: getComputedStyle(ribbon).display,
      ribbonLeft: ribbonRect.left,
      ribbonRight: ribbonRect.right,
      ribbonPosition: getComputedStyle(ribbon.parentElement).position,
      buttonSizes: buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
      destinationCount: document.querySelectorAll('[id^="pmdg-777-section-"]:not([id$="menu"]):not([id$="menu-title"])').length,
      currentLabel: ribbon.querySelector('.aircraft-section-ribbon__current strong')?.textContent.trim() || '',
      headerHeight: headerRect?.height || 0,
      footerDisplay: footer ? getComputedStyle(footer).display : 'missing',
      destinationProgressDisplay: destinationProgress ? getComputedStyle(destinationProgress).display : 'missing',
      searchQuery: document.getElementById('aircraft-find-input')?.value || '',
      searchMatchCount: document.querySelectorAll('[data-aircraft-find-match]').length,
      searchStillFocused: document.activeElement?.id === 'aircraft-find-input',
      focusMovedToRibbon: document.activeElement === ribbon.querySelector('.aircraft-section-ribbon__current'),
      hiddenShortcutPrevented: shortcutEvent.defaultPrevented,
    };
  })();`);
  assert.equal(mobileNavigation.missing, false, 'PMDG 777 mobile section navigation should render');
  assert.equal(mobileNavigation.searchDisplay, 'none', 'PMDG 777 search should yield to section navigation on mobile');
  assert.equal(mobileNavigation.searchQuery, '', 'mobile ribbon transition should clear the hidden search query');
  assert.equal(mobileNavigation.searchMatchCount, 0, 'mobile ribbon transition should clear hidden search highlighting');
  assert.equal(mobileNavigation.searchStillFocused, false, 'mobile ribbon transition should release focus from the hidden search');
  assert.equal(mobileNavigation.focusMovedToRibbon, true, 'mobile ribbon transition should move hidden search focus to visible section navigation');
  assert.equal(mobileNavigation.hiddenShortcutPrevented, false, 'mobile ribbon pages should not intercept Ctrl+F for a hidden search');
  assert.equal(mobileNavigation.ribbonDisplay, 'grid', 'PMDG 777 section ribbon should be visible on mobile');
  assert.equal(mobileNavigation.ribbonPosition, 'sticky', 'PMDG 777 section ribbon should remain reachable while scrolling');
  assert.equal(mobileNavigation.destinationCount, 10, 'PMDG 777 ribbon should map to ten stable destinations');
  assert.equal(mobileNavigation.currentLabel, 'MCP', 'PMDG 777 ribbon should initialize at the first permanent section');
  assert.ok(mobileNavigation.headerHeight > 0 && mobileNavigation.headerHeight <= 112, 'phone header should remain compact');
  assert.equal(mobileNavigation.footerDisplay, 'none', 'desktop status footer should not consume phone viewport space');
  assert.equal(mobileNavigation.destinationProgressDisplay, 'none', 'phone header should omit the tall destination progress row');
  assert.deepEqual(
    mobileNavigation.buttonSizes.filter((size) => size.width < 44 || size.height < 44),
    [],
    'PMDG 777 ribbon controls should use 44px touch targets',
  );
  assert.ok(mobileNavigation.ribbonLeft >= -2 && mobileNavigation.ribbonRight <= mobileNavigation.viewportWidth + 2, 'PMDG 777 ribbon should fit the viewport');
  assert.ok(mobileNavigation.pageWidth <= mobileNavigation.viewportWidth + 2, 'PMDG 777 navigation should not introduce horizontal overflow');

  await setContentSizeAndWait(windowRef, viewportWidth, viewportHeight, 'Aircraft blurred-search focus desktop');
  await waitFor(windowRef, "getComputedStyle(document.querySelector('.aircraft-find')).display !== 'none'", 'visible collapsed Aircraft search before blur cleanup');
  const collapsedLauncherBlurred = await evaluate(windowRef, `(() => {
    const guide = document.querySelector('[data-aircraft-integration-guide-trigger]');
    const launcher = document.querySelector('.aircraft-find__launcher');
    guide?.focus({ preventScroll: true });
    launcher?.focus({ preventScroll: true });
    launcher?.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget: guide }));
    launcher?.blur();
    launcher?.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }));
    return document.activeElement === document.body;
  })();`);
  assert.equal(collapsedLauncherBlurred, true, 'collapsed Aircraft search should release focus before stale-focus cleanup');
  await wait(225);
  await setContentSizeAndWait(windowRef, 390, 844, 'Aircraft blurred-search focus phone');
  await evaluate(windowRef, `(() => {
    window.dispatchEvent(new Event('resize'));
    return true;
  })();`);
  await wait(150);
  const blurredSearchFocusTransfer = await evaluate(
    windowRef,
    "document.activeElement?.classList.contains('aircraft-section-ribbon__current') === true",
  );
  assert.equal(blurredSearchFocusTransfer, false, 'a previously blurred search must not steal focus during a later mobile resize');

  await setContentSizeAndWait(windowRef, viewportWidth, viewportHeight, 'Aircraft collapsed-search focus desktop');
  await waitFor(windowRef, "getComputedStyle(document.querySelector('.aircraft-find')).display !== 'none'", 'visible collapsed Aircraft search before focus transfer');
  const collapsedLauncherFocused = await evaluate(windowRef, `(() => {
    document.querySelector('[data-aircraft-integration-guide-trigger]')?.focus({ preventScroll: true });
    const launcher = document.querySelector('.aircraft-find__launcher');
    launcher?.focus({ preventScroll: true });
    launcher?.dispatchEvent(new FocusEvent('focusin', {
      bubbles: true,
      relatedTarget: document.querySelector('[data-aircraft-integration-guide-trigger]'),
    }));
    return document.activeElement?.classList.contains('aircraft-find__launcher') === true;
  })();`);
  assert.equal(collapsedLauncherFocused, true, 'collapsed desktop Aircraft search launcher should accept focus');
  await setContentSizeAndWait(windowRef, 390, 844, 'Aircraft collapsed-search focus phone');
  await evaluate(windowRef, `(() => {
    window.dispatchEvent(new Event('resize'));
    return true;
  })();`);
  await wait(150);
  const collapsedSearchFocusTransfer = await evaluate(windowRef, `(() => ({
    focusedRibbon: document.activeElement?.classList.contains('aircraft-section-ribbon__current') === true,
    activeTag: document.activeElement?.tagName || '',
    activeClass: document.activeElement?.className || '',
    searchDisplay: getComputedStyle(document.querySelector('.aircraft-find')).display,
    ribbonDisplay: getComputedStyle(document.querySelector('.aircraft-section-ribbon')).display,
  }))();`);
  assert.equal(
    collapsedSearchFocusTransfer.focusedRibbon,
    true,
    `focused collapsed search should hand focus to the visible ribbon: ${JSON.stringify(collapsedSearchFocusTransfer)}`,
  );

  await click(windowRef, "document.querySelector('.aircraft-section-ribbon__current')", 'PMDG 777 section chooser');
  await waitFor(windowRef, "document.querySelector('[data-aircraft-section-menu]')", 'PMDG 777 section chooser dialog');
  const mobileChooser = await evaluate(windowRef, `(() => {
    const dialog = document.querySelector('[data-aircraft-section-menu] [role="dialog"]');
    const choices = [...document.querySelectorAll('[data-aircraft-section-choice]')];
    const rect = dialog?.getBoundingClientRect();
    return {
      choiceCount: choices.length,
      top: rect?.top || 0,
      bottom: rect?.bottom || 0,
      undersizedChoices: choices.filter((choice) => choice.getBoundingClientRect().height < 44).length,
    };
  })();`);
  assert.equal(mobileChooser.choiceCount, 10, 'PMDG 777 chooser should expose every ribbon destination');
  assert.equal(mobileChooser.undersizedChoices, 0, 'PMDG 777 chooser rows should remain touch friendly');
  assert.ok(mobileChooser.top >= -2 && mobileChooser.bottom <= 846, 'PMDG 777 chooser should fit the phone viewport');
  await click(
    windowRef,
    "[...document.querySelectorAll('[data-aircraft-section-choice]')].find((button) => button.textContent.includes('Gear, Brakes'))",
    'PMDG 777 Gear section choice',
  );
  await waitFor(
    windowRef,
    "!document.querySelector('[data-aircraft-section-menu]') && document.querySelector('.aircraft-section-ribbon__current strong')?.textContent.trim() === 'Gear' && document.getElementById('pmdg-777-section-gear-high-lift')?.open === true",
    'PMDG 777 chooser navigation to Gear',
  );
  await waitFor(
    windowRef,
    "sessionStorage.getItem('flight-fabric:aircraft-section:v1:bundled%2Fmsfs%2Fpmdg-777') === 'gear-high-lift'",
    'PMDG 777 session-scoped section memory',
  );
  const airbusRibbonCases = [
    {
      profileKey: 'bundled/msfs/fenix-a320',
      templateId: 'fenix-a32x',
      sectionPrefix: 'fenix-section-',
      sectionCount: 14,
    },
    {
      profileKey: 'bundled/msfs/fbw-a32nx',
      templateId: 'fbw-a32nx',
      sectionPrefix: 'fbw-a32nx-section-',
      sectionCount: 12,
    },
    {
      profileKey: 'bundled/msfs/fbw-a380x',
      templateId: 'fbw-a380x',
      sectionPrefix: 'fbw-a380x-section-',
      sectionCount: 5,
    },
  ];

  for (const fixture of airbusRibbonCases) {
    await setInputValue(windowRef, 'aircraft-profile-correction-select', fixture.profileKey);
    await waitFor(
      windowRef,
      `document.querySelector('[data-aircraft-template="${fixture.templateId}"]') && document.querySelector('.aircraft-find--mobile-hidden') && document.querySelector('[data-mobile-aircraft-navigation="section-ribbon"]')`,
      `${fixture.templateId} Aircraft page and shared mobile navigation state`,
    );
    const mobileAirbus = await evaluate(windowRef, `(() => {
      const search = document.querySelector('.aircraft-find');
      const ribbon = document.querySelector('.aircraft-section-ribbon');
      const buttons = [...(ribbon?.querySelectorAll('button') || [])];
      const rect = ribbon?.getBoundingClientRect();
      return {
        searchClass: search?.className || '',
        searchDisplay: search ? getComputedStyle(search).display : 'missing',
        ribbonDisplay: ribbon ? getComputedStyle(ribbon).display : 'missing',
        mobileMediaMatches: window.matchMedia('(max-width: 760px)').matches,
        buttonSizes: buttons.map((button) => {
          const buttonRect = button.getBoundingClientRect();
          return { width: buttonRect.width, height: buttonRect.height };
        }),
        destinationCount: document.querySelectorAll('[id^="${fixture.sectionPrefix}"]').length,
        left: rect?.left || 0,
        right: rect?.right || 0,
        viewportWidth: window.innerWidth,
        pageWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
      };
    })();`);
    assert.ok(mobileAirbus.viewportWidth <= 760 && mobileAirbus.mobileMediaMatches, `${fixture.templateId} browser fixture should be at the mobile breakpoint: ${JSON.stringify(mobileAirbus)}`);
    assert.equal(mobileAirbus.searchDisplay, 'none', `${fixture.templateId} should hide Aircraft search on mobile`);
    assert.equal(mobileAirbus.ribbonDisplay, 'grid', `${fixture.templateId} should show the shared section ribbon on mobile`);
    assert.equal(mobileAirbus.destinationCount, fixture.sectionCount, `${fixture.templateId} should expose every mapped section destination`);
    assert.deepEqual(
      mobileAirbus.buttonSizes.filter((size) => size.width < 44 || size.height < 44),
      [],
      `${fixture.templateId} ribbon controls should retain 44px touch targets`,
    );
    assert.ok(mobileAirbus.left >= -2 && mobileAirbus.right <= mobileAirbus.viewportWidth + 2, `${fixture.templateId} ribbon should fit the phone viewport`);
    assert.ok(mobileAirbus.pageWidth <= mobileAirbus.viewportWidth + 2, `${fixture.templateId} should not introduce horizontal overflow`);

    await click(windowRef, "document.querySelector('.aircraft-section-ribbon__current')", `${fixture.templateId} section chooser`);
    await waitFor(
      windowRef,
      `document.querySelectorAll('[data-aircraft-section-choice]').length === ${fixture.sectionCount}`,
      `${fixture.templateId} complete section chooser`,
    );
    await click(windowRef, "document.querySelector('.aircraft-section-menu__close')", `${fixture.templateId} section chooser close`);
    await waitFor(windowRef, "!document.querySelector('[data-aircraft-section-menu]')", `${fixture.templateId} closed section chooser`);

  }

  await setInputValue(windowRef, 'aircraft-profile-correction-select', 'auto');
  await waitFor(
    windowRef,
    "document.querySelector('[data-aircraft-page-mode=\"generic\"]') && document.querySelector('[data-aircraft-quick-actions]') && getComputedStyle(document.querySelector('.aircraft-find')).display !== 'none'",
    'generic Aircraft mobile tools fixture',
  );
  await click(windowRef, "document.getElementById('aircraft-profile-correction-btn')", 'mobile aircraft profile correction');
  await waitFor(
    windowRef,
    "document.getElementById('aircraft-profile-correction')?.open === true",
    'open mobile aircraft profile correction panel',
  );
  const mobileProfileCorrection = await evaluate(windowRef, `(() => {
    const trigger = document.getElementById('aircraft-profile-correction-btn');
    const panel = document.getElementById('aircraft-profile-correction-panel');
    const select = document.getElementById('aircraft-profile-correction-select');
    const triggerRect = trigger?.getBoundingClientRect();
    const panelRect = panel?.getBoundingClientRect();
    const selectRect = select?.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      triggerHeight: triggerRect?.height || 0,
      panelLeft: panelRect?.left || 0,
      panelRight: panelRect?.right || 0,
      panelWidth: panelRect?.width || 0,
      selectHeight: selectRect?.height || 0,
      pageWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
    };
  })();`);
  assert.ok(mobileProfileCorrection.triggerHeight >= 44, 'mobile aircraft correction should keep a 44px touch target');
  assert.ok(mobileProfileCorrection.selectHeight >= 44, 'mobile aircraft profile selector should keep a 44px touch target');
  assert.ok(mobileProfileCorrection.panelWidth > 0, 'mobile aircraft correction panel should open');
  assert.ok(
    mobileProfileCorrection.panelLeft >= 0 && mobileProfileCorrection.panelRight <= mobileProfileCorrection.viewportWidth,
    'mobile aircraft correction panel should stay within the viewport',
  );
  assert.ok(
    mobileProfileCorrection.pageWidth <= mobileProfileCorrection.viewportWidth + 2,
    'open mobile aircraft correction panel should not create horizontal overflow',
  );
  await click(windowRef, "document.getElementById('aircraft-profile-correction-btn')", 'close mobile aircraft profile correction');
  await waitFor(
    windowRef,
    "document.getElementById('aircraft-profile-correction')?.open === false",
    'closed mobile aircraft profile correction panel',
  );
  await evaluate(windowRef, `(() => {
    document.querySelector('.aircraft-page-tools')?.scrollIntoView({ block: 'start', behavior: 'auto' });
    return true;
  })();`);
  const mobileToolsCollapsed = await evaluate(windowRef, `(() => {
    const tools = document.querySelector('.aircraft-page-tools');
    const guide = document.querySelector('[data-aircraft-integration-guide-trigger]');
    const voice = document.querySelector('[data-aircraft-voice-control-trigger]');
    const launcher = document.querySelector('.aircraft-find__launcher');
    const preset = document.querySelector('[data-aircraft-quick-actions]');
    const cards = [...document.querySelectorAll('[data-aircraft-preset]')];
    if (!tools || !guide || !voice || !launcher || !preset || cards.length === 0) return { missing: true };
    const rect = (element) => {
      const value = element.getBoundingClientRect();
      return { width: value.width, height: value.height, left: value.left, right: value.right, top: value.top, bottom: value.bottom };
    };
    return {
      missing: false,
      viewportWidth: window.innerWidth,
      pageWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
      voiceDisplay: getComputedStyle(voice).display,
      tools: rect(tools),
      guide: rect(guide),
      launcher: rect(launcher),
      preset: rect(preset),
      cards: cards.map((card) => ({
        card: rect(card),
        apply: rect(card.querySelector('button')),
      })),
    };
  })();`);
  assert.equal(mobileToolsCollapsed.missing, false, 'generic Aircraft mobile tools should render');
  assert.equal(mobileToolsCollapsed.voiceDisplay, 'none', 'voice control should stay out of the mobile toolbar');
  assert.ok(mobileToolsCollapsed.guide.width >= 44 && mobileToolsCollapsed.guide.height >= 44, 'mobile integration guide should remain touch sized');
  assert.ok(mobileToolsCollapsed.launcher.width >= 44 && mobileToolsCollapsed.launcher.height >= 44, 'mobile Aircraft search launcher should remain touch sized');
  assert.ok(mobileToolsCollapsed.preset.width >= mobileToolsCollapsed.tools.width * 0.98, 'mobile Aircraft preset should own a full row');
  assert.equal(mobileToolsCollapsed.cards.length, 2, 'mobile fixture should retain both one-tap presets');
  assert.deepEqual(
    mobileToolsCollapsed.cards.filter(({ card, apply }) => apply.width < card.width - 26),
    [],
    'every mobile preset action should span its card width',
  );
  assert.ok(mobileToolsCollapsed.pageWidth <= mobileToolsCollapsed.viewportWidth + 2, 'collapsed mobile Aircraft tools should not overflow horizontally');

  await click(windowRef, "document.querySelector('.aircraft-find__launcher')", 'generic mobile Aircraft search launcher');
  await waitFor(windowRef, "document.activeElement?.id === 'aircraft-find-input'", 'generic mobile Aircraft search focus');
  const mobileToolsExpanded = await evaluate(windowRef, `(() => {
    const tools = document.querySelector('.aircraft-page-tools');
    const actions = document.querySelector('.aircraft-page-tool-actions');
    const search = document.querySelector('.aircraft-find--expanded');
    const panel = document.getElementById('aircraft-find-panel');
    const guide = document.querySelector('[data-aircraft-integration-guide-trigger]');
    const preset = document.querySelector('[data-aircraft-quick-actions]');
    if (!tools || !actions || !search || !panel || !guide || !preset) return { missing: true };
    const rect = (element) => {
      const value = element.getBoundingClientRect();
      return { width: value.width, height: value.height, left: value.left, right: value.right, top: value.top, bottom: value.bottom };
    };
    return {
      missing: false,
      viewportWidth: window.innerWidth,
      pageWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
      guideDisplay: getComputedStyle(guide).display,
      tools: rect(tools),
      actions: rect(actions),
      search: rect(search),
      panel: rect(panel),
      preset: rect(preset),
    };
  })();`);
  assert.equal(mobileToolsExpanded.missing, false, 'expanded generic Aircraft mobile search should render');
  assert.equal(mobileToolsExpanded.guideDisplay, 'none', 'expanded mobile search should temporarily own the toolbar row');
  assert.ok(mobileToolsExpanded.search.width >= mobileToolsExpanded.tools.width - 6, 'expanded mobile search should use the full tools width');
  assert.ok(mobileToolsExpanded.panel.width >= mobileToolsExpanded.search.width - 2, 'expanded mobile search panel should fill its search region');
  assert.ok(mobileToolsExpanded.preset.top >= mobileToolsExpanded.actions.bottom + 6, 'mobile preset should remain below expanded search');
  assert.ok(mobileToolsExpanded.pageWidth <= mobileToolsExpanded.viewportWidth + 2, 'expanded mobile Aircraft tools should not overflow horizontally');
  await setInputValue(windowRef, 'aircraft-find-input', 'light');
  await waitFor(windowRef, "document.querySelector('.aircraft-find__clear')", 'generic mobile Aircraft clear action');
  const queriedMobileSearch = await evaluate(windowRef, `(() => {
    const field = document.querySelector('.aircraft-find__field');
    const input = document.getElementById('aircraft-find-input');
    const navigation = document.querySelector('.aircraft-find__navigation');
    if (!field || !input || !navigation) return { missing: true };
    const fieldRect = field.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    const navigationRect = navigation.getBoundingClientRect();
    const colorParts = (value) => (String(value).match(/[0-9.]+/g) || []).slice(0, 3).map(Number);
    const placeholderColor = colorParts(getComputedStyle(input, '::placeholder').color);
    const mutedForeground = getComputedStyle(document.documentElement)
      .getPropertyValue('--muted-foreground')
      .trim()
      .split(' ')
      .filter(Boolean)
      .slice(0, 3)
      .map(Number);
    return {
      missing: false,
      inputWidth: inputRect.width,
      inputHeight: inputRect.height,
      inputFontSize: Number.parseFloat(getComputedStyle(input).fontSize),
      navigationBelowField: navigationRect.top >= fieldRect.bottom + 6,
      placeholderColor,
      mutedForeground,
      placeholderUsesMutedForeground: placeholderColor.length === 3
        && placeholderColor.every((value, index) => Math.abs(value - mutedForeground[index]) < 1),
    };
  })();`);
  assert.equal(queriedMobileSearch.missing, false, 'queried 390px Aircraft search should render its field and navigation');
  assert.ok(queriedMobileSearch.inputWidth >= 180, 'queried 390px Aircraft search should retain useful typing width');
  assert.ok(queriedMobileSearch.inputHeight >= 44, 'mobile Aircraft search input should itself be a touch-sized target');
  assert.ok(queriedMobileSearch.inputFontSize >= 16, 'mobile Aircraft search should avoid iOS focus zoom');
  assert.equal(queriedMobileSearch.navigationBelowField, true, '390px Aircraft search navigation should move below the typing field');
  assert.equal(
    queriedMobileSearch.placeholderUsesMutedForeground,
    true,
    `Aircraft search placeholder should retain its accessible muted-foreground color: ${JSON.stringify({
      placeholderColor: queriedMobileSearch.placeholderColor,
      mutedForeground: queriedMobileSearch.mutedForeground,
    })}`,
  );
  await setContentSizeAndWait(windowRef, 320, 700, 'narrow Aircraft phone');
  const narrowMobileSearch = await evaluate(windowRef, `(() => {
    const panel = document.getElementById('aircraft-find-panel');
    const field = document.querySelector('.aircraft-find__field');
    const input = document.getElementById('aircraft-find-input');
    const clear = document.querySelector('.aircraft-find__clear');
    const navigation = document.querySelector('.aircraft-find__navigation');
    const collapse = document.querySelector('.aircraft-find__collapse');
    if (!panel || !field || !input || !clear || !navigation || !collapse) return { missing: true };
    const rect = (element) => {
      const value = element.getBoundingClientRect();
      return { width: value.width, height: value.height, left: value.left, right: value.right, top: value.top, bottom: value.bottom };
    };
    return {
      missing: false,
      viewportWidth: window.innerWidth,
      pageWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
      panel: rect(panel),
      field: rect(field),
      input: rect(input),
      clear: rect(clear),
      navigation: rect(navigation),
      collapse: rect(collapse),
    };
  })();`);
  assert.equal(narrowMobileSearch.missing, false, '320px Aircraft search should render every interactive region');
  assert.ok(narrowMobileSearch.input.width >= 140, '320px Aircraft search should retain useful typing width');
  assert.ok(narrowMobileSearch.clear.width >= 44 && narrowMobileSearch.clear.height >= 44, '320px Aircraft search clear action should remain touch sized');
  assert.ok(narrowMobileSearch.navigation.top >= narrowMobileSearch.field.bottom + 6, '320px search navigation should move below the full-width field');
  assert.ok(narrowMobileSearch.collapse.top >= narrowMobileSearch.field.bottom + 6, '320px search close action should move below the full-width field');
  assert.ok(narrowMobileSearch.panel.left >= 0 && narrowMobileSearch.panel.right <= narrowMobileSearch.viewportWidth + 2, '320px Aircraft search panel should fit the viewport');
  assert.ok(narrowMobileSearch.pageWidth <= narrowMobileSearch.viewportWidth + 2, '320px Aircraft search should not overflow horizontally');
  await click(windowRef, "document.querySelector('.aircraft-find__collapse')", 'narrow generic mobile Aircraft search close');
  await setContentSizeAndWait(windowRef, 390, 844, 'Aircraft phone restore');

  await setInputValue(windowRef, 'aircraft-profile-correction-select', 'bundled/msfs/pmdg-777');
  await waitFor(
    windowRef,
    "document.querySelector('[data-aircraft-template=\"pmdg-777\"]') && document.querySelector('.aircraft-section-ribbon__current strong')?.textContent.trim() === 'Gear'",
    'restored PMDG 777 fixture profile and remembered section after Airbus ribbon checks',
  );
  await setContentSizeAndWait(windowRef, viewportWidth, viewportHeight, 'Aircraft desktop restore');
  await waitFor(
    windowRef,
    "document.getElementById('aircraft-find-input')?.value === '' && !document.querySelector('[data-aircraft-find-match]')",
    'cleared Aircraft search state after profile navigation checks',
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
    "document.getElementById('timeline-flight-route')?.textContent.includes('KPHL -> KBOS')",
    'loaded Timeline header route',
  );
  await waitFor(
    windowRef,
    "document.querySelectorAll('#timeline-event-list .timeline-event').length >= 4",
    'loaded Timeline events',
  );
  const replayColumnLayout = await evaluate(
    windowRef,
    `(() => {
      const shell = document.getElementById('vue-timeline-map-shell-root')?.getBoundingClientRect();
      const card = document.getElementById('timeline-map-card')?.getBoundingClientRect();
      const map = document.querySelector('.timeline-map-wrap')?.getBoundingClientRect();
      return {
        shellHeight: shell?.height || 0,
        shellBottom: shell?.bottom || 0,
        cardBottom: card?.bottom || 0,
        mapHeight: map?.height || 0,
      };
    })();`,
  );
  assert.ok(
    replayColumnLayout.shellHeight > 0
      && replayColumnLayout.cardBottom >= replayColumnLayout.shellBottom - 2,
    'Timeline replay card should fill the available modal row height',
  );
  assert.ok(
    replayColumnLayout.mapHeight >= Math.min(360, replayColumnLayout.shellHeight * 0.45),
    'Timeline replay map should receive a useful share of the available vertical space',
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
    "document.querySelector('#landing-modal #landing-card') && document.querySelector('#landing-modal #landing-airport')?.textContent.includes('KBOS') && document.querySelector('#landing-modal #landing-grade')?.textContent.includes('PERFECT') && document.querySelector('#landing-modal #landing-summary-approach')?.textContent.includes('MARGINAL') && document.querySelector('#landing-modal #landing-summary-bounce')?.textContent.includes('1x') && document.querySelector('#landing-modal #landing-wind-direction')?.textContent.includes('240°T') && document.querySelector('#landing-modal #landing-wind-speed')?.textContent.includes('14 kt') && document.querySelector('#landing-modal #landing-wind-crosswind')?.textContent.includes('XW 8 kt from left')",
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
  await waitFor(
    windowRef,
    "document.getElementById('tab-flight')?.classList.contains('active')",
    'Overview as the initial workspace',
  );
  await assertHeaderLayout(windowRef);
  if (headerOnly) return;

  await runSecondScreenSetupSmoke(windowRef);
  await assertCompactFlightLayout(windowRef);
  await assertSimbriefLayout(windowRef);
  await runSettingsSmoke(windowRef);
  await runAircraftSearchSmoke(windowRef);
  await assertMobileShellLayout(windowRef);
  await runLiveMapSmoke(windowRef);
  await runTimelineSmoke(windowRef);
  await runReconnectSmoke(windowRef);
  await assertRemoteSecondScreenGuideLayout(windowRef);
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
  await assertMapLibreWorkerRuntime(windowRef);
  await runSmoke(windowRef);
  await windowRef.close();
  await app.quit();
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
  app.exit(1);
});
