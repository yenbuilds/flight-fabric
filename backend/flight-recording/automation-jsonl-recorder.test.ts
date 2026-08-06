'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const recorderModule = require('./automation-jsonl-recorder.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  + ${name}`);
    passed++;
  } catch (err) {
    console.log(`  - ${name}: ${err.message}`);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  + ${name}`);
    passed++;
  } catch (err) {
    console.log(`  - ${name}: ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function baseInput(overrides: any = {}) {
  const fdm = {
    apMaster: true,
    apFdActive: true,
    athrArmed: false,
    athrActive: false,
    apHdgHold: true,
    apAltHold: true,
    apVsHold: false,
    apLnavHold: false,
    apLocHold: false,
    apApprHold: false,
    apAltTargetFt: 5000,
    apHdgTargetDeg: 180,
    apSpeedTargetKts: 210,
    apVsTargetFpm: 0,
    ...overrides.fdm,
  };

  const baseFdm = {
    ...fdm,
    ...overrides.baseFdm,
  };

  return {
    timeMs: overrides.timeMs ?? 0,
    timestampIso: overrides.timestampIso || '2026-06-18T00:00:00.000Z',
    flightElapsedMs: overrides.flightElapsedMs ?? overrides.timeMs ?? 0,
    flightId: 'flight-automation-test',
    flightStartIso: '2026-06-18T00:00:00.000Z',
    aircraftProfileId: 'generic',
    aircraftTitle: 'Test Aircraft',
    dataSource: 'simconnect',
    fdm,
    baseFdm,
    simconnect: overrides.simconnect || baseFdm,
    reliability: {
      apReliable: true,
      athrReliable: true,
      reason: 'simconnect-only',
      ...overrides.reliability,
    },
    sourceContext: {
      lvarSidecarConnected: false,
      sdkConnected: false,
      sdkHasData: false,
      lvarValues: overrides.lvarValues || {},
      sdkValues: {},
      sdkNormalized: {},
      ...overrides.sourceContext,
    },
  };
}

async function runTests() {
  console.log('\nAutomation JSONL Recorder Tests\n');

  await testAsync('writes checkpoints, deltas, events, and immutable route metadata', async () => {
    const outputDir = path.join(os.tmpdir(), `automation-jsonl-test-${Date.now()}`);
    const recorder = new recorderModule.AutomationJsonlRecorder({
      flightId: '2026-06-18T00:00:00.000Z',
      outputDir,
      checkpointIntervalMs: 60000,
    });

    assert(recorder.start(), 'recorder should start');

    assert(recorder.recordAutopilotState(baseInput()), 'first snapshot should be recorded');
    assert(recorder.recordAutopilotState(baseInput({
      timeMs: 1000,
      fdm: { apAltTargetFt: 5050 },
    })), 'below-threshold altitude change should not force a row');
    assert(recorder.recordAutopilotState(baseInput({
      timeMs: 2000,
      fdm: { apAltTargetFt: 5200 },
    })), 'meaningful altitude change should be recorded');
    assert(recorder.recordAutopilotState(baseInput({
      timeMs: 3000,
      fdm: {
        apMaster: false,
        apAltTargetFt: 5200,
      },
    })), 'AP disengage should be recorded');
    assert(recorder.recordAutopilotState(baseInput({
      timeMs: 70000,
      fdm: {
        apMaster: false,
        apAltTargetFt: 5200,
      },
    })), 'heartbeat checkpoint should be recorded');

    const originalPath = recorder.filePath;
    assert(await recorder.updateFilename(null, 'YSSY'), 'route metadata update should succeed');
    const statsAfterRoute = recorder.getStats();
    assert(statsAfterRoute.filename === 'automation.jsonl', 'sidecar filename should remain canonical');
    assert(statsAfterRoute.filePath === originalPath, 'route metadata must not rename the immutable bundle');

    const stats = await recorder.close({
      timeMs: 80000,
      timestampIso: '2026-06-18T00:01:20.000Z',
      flightElapsedMs: 80000,
      endReason: 'test_end',
    });

    assert(fs.existsSync(stats.filePath), 'sidecar file should exist after close');
    const rows = readJsonl(stats.filePath);
    const rowTypes = rows.map((row) => row.type);
    const manifest = rows[0];
    const firstCheckpoint = rows.find((row) => row.type === 'automation_checkpoint');
    const altitudeDelta = rows.find(
      (row) => row.type === 'automation_delta' && row.stateChanged?.selectedAltitudeFt === 5200,
    );
    const apDisconnect = rows.find(
      (row) => row.type === 'automation_event' && row.eventType === 'ap_disengaged',
    );

    assert(manifest.schemaVersion === 2, 'new recordings should declare compact automation schema v2');
    assert(rowTypes.includes('automation_checkpoint'), 'should include checkpoint rows');
    assert(rowTypes.includes('automation_delta'), 'should include delta rows');
    assert(rowTypes.includes('automation_event'), 'should include event rows');
    assert(altitudeDelta, 'should preserve selected altitude changes as state deltas');
    assert(firstCheckpoint?.context?.aircraftProfileId === 'generic', 'checkpoint should store compact source context');
    assert(!Object.prototype.hasOwnProperty.call(firstCheckpoint, 'raw'), 'checkpoint should not duplicate raw source payloads');
    assert(!Object.prototype.hasOwnProperty.call(firstCheckpoint, 'confidence'), 'checkpoint should not duplicate derivable confidence maps');
    assert(!Object.prototype.hasOwnProperty.call(altitudeDelta, 'rawChanged'), 'delta should not duplicate one change across raw source payloads');
    assert(!Object.prototype.hasOwnProperty.call(altitudeDelta, 'confidenceChanged'), 'delta should omit empty or derivable confidence changes');
    assert(!Object.prototype.hasOwnProperty.call(altitudeDelta, 'flightId'), 'delta should inherit immutable flight identity from the manifest');
    assert(!Object.prototype.hasOwnProperty.call(altitudeDelta, 'timestampIso'), 'delta should not duplicate its epoch clock as ISO text');
    assert(!Object.prototype.hasOwnProperty.call(altitudeDelta, 'flightElapsedMs'), 'delta should derive elapsed time from the manifest clock');
    assert(!Object.prototype.hasOwnProperty.call(altitudeDelta, 'schemaVersion'), 'delta should inherit schema version from the manifest');
    assert(!rows.some((row) => row.type === 'automation_event' && row.eventType === 'selected_altitude_changed'), 'should not emit selected altitude changes as timeline events');
    assert(apDisconnect, 'should emit AP disengage event');
    assert(apDisconnect.simconnectCorroborated === true, 'AP disconnect should keep compact SimConnect corroboration');
    assert(rows.some((row) => row.type === 'automation_checkpoint' && row.reason === 'recording_end'), 'should emit final checkpoint');
    assert(!rows.some((row) => row.type === 'automation_event' && row.current === 5050), 'below-threshold altitude change should not emit an event');
  });

  await testAsync('does not rewrite unchanged state on a production heartbeat interval', async () => {
    const outputDir = path.join(os.tmpdir(), `automation-jsonl-no-heartbeat-${Date.now()}`);
    const recorder = new recorderModule.AutomationJsonlRecorder({
      flightId: '2026-06-18T00:00:00.000Z',
      outputDir,
    });

    assert(recorder.start(), 'recorder should start');
    assert(recorder.recordAutopilotState(baseInput()), 'first snapshot should be recorded');
    assert(recorder.recordAutopilotState(baseInput({ timeMs: 600000 })), 'unchanged later snapshot should be accepted');
    const stats = await recorder.close({
      timeMs: 601000,
      endReason: 'test_end',
    });
    const rows = readJsonl(stats.filePath);
    const checkpoints = rows.filter((row) => row.type === 'automation_checkpoint');

    assert(checkpoints.length === 2, `expected first/final checkpoints only, got ${checkpoints.length}`);
    assert(!checkpoints.some((row) => row.reason === 'heartbeat'), 'default recording should not repeat unchanged heartbeat state');
  });

  await testAsync('capacity shutdown drains accepted rows without appending a final checkpoint', async () => {
    const outputDir = path.join(os.tmpdir(), `automation-jsonl-capacity-close-${Date.now()}`);
    const recorder = new recorderModule.AutomationJsonlRecorder({
      flightId: '2026-06-18T00:00:00.000Z',
      outputDir,
    });
    try {
      assert(recorder.start(), 'recorder should start');
      assert(recorder.recordAutopilotState(baseInput()), 'first snapshot should be accepted');
      const acceptedRows = recorder.getStats().rowCount;
      const stats = await recorder.close({
        endReason: 'low_disk_safety_floor',
        skipFinalCheckpoint: true,
      });
      const rows = readJsonl(stats.filePath);
      assert(stats.rowCount === acceptedRows, 'capacity close must not increase the accepted row count');
      assert(!rows.some((row) => row.reason === 'recording_end'),
        'capacity close must not append a recording_end checkpoint');
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  await testAsync('does not emit timeline events when automation modes become unknown', async () => {
    const outputDir = path.join(os.tmpdir(), `automation-jsonl-unknown-test-${Date.now()}`);
    const recorder = new recorderModule.AutomationJsonlRecorder({
      flightId: '2026-06-18T00:00:00.000Z',
      outputDir,
      checkpointIntervalMs: 60000,
    });

    assert(recorder.start(), 'recorder should start');
    assert(recorder.recordAutopilotState(baseInput({
      fdm: {
        apMaster: true,
        athrActive: true,
        apHdgHold: false,
        apAltHold: false,
        apLnavHold: true,
        apVnavHold: true,
      },
    })), 'first snapshot should be recorded');
    assert(recorder.recordAutopilotState(baseInput({
      timeMs: 1000,
      fdm: {
        apMaster: null,
        athrActive: null,
        apHdgHold: null,
        apNavHold: null,
        apLnavHold: null,
        apLocHold: null,
        apAltHold: null,
        apVsHold: null,
        apVnavHold: null,
        apLvlChgHold: null,
        apFlcHold: null,
        apExpedHold: null,
        apApprHold: null,
      },
    })), 'unknown automation state should be recorded as a delta only');

    const stats = await recorder.close({
      timeMs: 2000,
      timestampIso: '2026-06-18T00:00:02.000Z',
      flightElapsedMs: 2000,
      endReason: 'test_end',
    });
    const rows = readJsonl(stats.filePath);
    const eventTypes = rows
      .filter((row) => row.type === 'automation_event')
      .map((row) => row.eventType);

    assert(rows.some((row) => row.type === 'automation_delta' && row.stateChanged?.lateralMode === null), 'should preserve unknown mode deltas');
    assert(!eventTypes.includes('ap_disengaged'), 'unknown AP state should not appear as AP disconnected');
    assert(!eventTypes.includes('athr_disengaged'), 'unknown A/THR state should not appear as A/THR disconnected');
    assert(!eventTypes.includes('lateral_mode_changed'), 'unknown lateral mode should not emit a timeline event');
    assert(!eventTypes.includes('vertical_mode_changed'), 'unknown vertical mode should not emit a timeline event');
  });

  await testAsync('emits mode events when automation modes become known', async () => {
    const outputDir = path.join(os.tmpdir(), `automation-jsonl-known-mode-test-${Date.now()}`);
    const recorder = new recorderModule.AutomationJsonlRecorder({
      flightId: '2026-06-18T00:00:00.000Z',
      outputDir,
      checkpointIntervalMs: 60000,
    });

    assert(recorder.start(), 'recorder should start');
    assert(recorder.recordAutopilotState(baseInput({
      fdm: {
        apHdgHold: false,
        apAltHold: false,
        apLnavHold: null,
        apVnavHold: null,
      },
    })), 'first unknown mode snapshot should be recorded');
    assert(recorder.recordAutopilotState(baseInput({
      timeMs: 1000,
      fdm: {
        apHdgHold: false,
        apAltHold: false,
        apLnavHold: true,
        apVnavHold: true,
      },
    })), 'known LNAV/VNAV modes should be recorded');

    const stats = await recorder.close({
      timeMs: 2000,
      timestampIso: '2026-06-18T00:00:02.000Z',
      flightElapsedMs: 2000,
      endReason: 'test_end',
    });
    const rows = readJsonl(stats.filePath);

    assert(rows.some((row) => row.type === 'automation_event' && row.eventType === 'lateral_mode_changed' && row.current === 'LNAV'), 'LNAV becoming known should emit a mode event');
    assert(rows.some((row) => row.type === 'automation_event' && row.eventType === 'vertical_mode_changed' && row.current === 'VNAV'), 'VNAV becoming known should emit a mode event');
    assert(!rows.some((row) => row.type === 'automation_event' && Object.prototype.hasOwnProperty.call(row, 'requireCurrentKnownMode')), 'internal mode-filter options should not be serialized');
  });

  await testAsync('emits A/T ARM events while keeping active-state transitions as diagnostic data', async () => {
    const outputDir = path.join(os.tmpdir(), `automation-jsonl-athr-arm-test-${Date.now()}`);
    const recorder = new recorderModule.AutomationJsonlRecorder({
      flightId: '2026-06-18T00:00:00.000Z',
      outputDir,
      checkpointIntervalMs: 60000,
    });

    assert(recorder.start(), 'recorder should start');
    assert(recorder.recordAutopilotState(baseInput({
      fdm: {
        athrArmed: false,
        athrActive: true,
      },
    })), 'initial A/T state should be recorded');
    assert(recorder.recordAutopilotState(baseInput({
      timeMs: 1000,
      fdm: {
        athrArmed: false,
        athrActive: false,
      },
    })), 'A/T active-state transition should be recorded');
    assert(recorder.recordAutopilotState(baseInput({
      timeMs: 2000,
      fdm: {
        athrArmed: true,
        athrActive: false,
      },
    })), 'A/T ARM transition should be recorded');
    assert(recorder.recordAutopilotState(baseInput({
      timeMs: 3000,
      fdm: {
        athrArmed: false,
        athrActive: false,
      },
    })), 'A/T disarm transition should be recorded');

    const stats = await recorder.close({
      timeMs: 4000,
      timestampIso: '2026-06-18T00:00:04.000Z',
      flightElapsedMs: 4000,
      endReason: 'test_end',
    });
    const rows = readJsonl(stats.filePath);
    const events = rows.filter((row) => row.type === 'automation_event');

    assert(
      rows.some((row) => row.type === 'automation_delta' && row.stateChanged?.athrActive === false),
      'active-state changes must remain available as diagnostic deltas',
    );
    assert(
      !events.some((row) => row.field === 'athrActive'),
      'active-state changes must not claim an A/T timeline action',
    );
    assert(
      events.some((row) => (
        row.eventType === 'athr_armed'
        && row.field === 'athrArmed'
        && row.previous === false
        && row.current === true
      )),
      'A/T ARM on should emit a semantic arm event',
    );
    assert(
      events.some((row) => (
        row.eventType === 'athr_disarmed'
        && row.field === 'athrArmed'
        && row.previous === true
        && row.current === false
      )),
      'A/T ARM off should emit a semantic disarm event',
    );
  });

  await testAsync('does not record profile false AP or A/THR when base simulator state remains on', async () => {
    const outputDir = path.join(os.tmpdir(), `automation-jsonl-conflict-test-${Date.now()}`);
    const recorder = new recorderModule.AutomationJsonlRecorder({
      flightId: '2026-06-18T00:00:00.000Z',
      outputDir,
      checkpointIntervalMs: 60000,
    });

    assert(recorder.start(), 'recorder should start');
    assert(recorder.recordAutopilotState(baseInput({
      fdm: {
        apMaster: true,
        athrActive: true,
      },
      baseFdm: {
        apMaster: true,
        athrActive: true,
      },
      reliability: {
        reason: 'lvar-sidecar-connected',
      },
    })), 'first snapshot should be recorded');
    assert(recorder.recordAutopilotState(baseInput({
      timeMs: 1000,
      fdm: {
        apMaster: false,
        athrActive: false,
      },
      baseFdm: {
        apMaster: true,
        athrActive: true,
      },
      reliability: {
        reason: 'lvar-sidecar-connected',
      },
    })), 'conflicting profile false state should not become a semantic disconnect');

    const stats = await recorder.close({
      timeMs: 2000,
      timestampIso: '2026-06-18T00:00:02.000Z',
      flightElapsedMs: 2000,
      endReason: 'test_end',
    });
    const rows = readJsonl(stats.filePath);
    const eventTypes = rows
      .filter((row) => row.type === 'automation_event')
      .map((row) => row.eventType);

    assert(!rows.some((row) => row.type === 'automation_delta' && row.stateChanged?.apMaster === false), 'conflicting AP false should not be recorded as state off');
    assert(!rows.some((row) => row.type === 'automation_delta' && row.stateChanged?.athrActive === false), 'conflicting A/THR false should not be recorded as state off');
    assert(!eventTypes.includes('ap_disengaged'), 'conflicting AP false should not emit AP disconnected');
    assert(!eventTypes.includes('athr_disengaged'), 'conflicting A/THR false should not emit A/THR disconnected');
  });

  test('buildAutomationState derives normalized modes and confidence', () => {
    const { state, confidence } = recorderModule.buildAutomationState(baseInput({
      fdm: {
        apLnavHold: true,
        apHdgHold: false,
        apVnavHold: true,
        apAltHold: false,
      },
    }));

    assert(state.lateralMode === 'LNAV', 'expected LNAV lateral mode');
    assert(state.verticalMode === 'VNAV', 'expected VNAV vertical mode');
    assert(confidence.apMaster === 'simconnect', 'expected simconnect confidence');
  });

  test('buildAutomationState treats unreliable AP and A/THR values as unknown', () => {
    const { state, confidence } = recorderModule.buildAutomationState(baseInput({
      fdm: {
        apMaster: false,
        apFdActive: true,
        apLnavHold: true,
        apVnavHold: true,
        apAltTargetFt: 24000,
        athrArmed: true,
        athrActive: false,
      },
      baseFdm: {
        apMaster: false,
        athrActive: false,
      },
      reliability: {
        apReliable: false,
        athrReliable: false,
        reason: 'lvar-sidecar-running:fenix-a320',
      },
    }));

    assert(state.apMaster === null, 'unreliable AP master should be unknown');
    assert(state.fdActive === null, 'unreliable FD should be unknown');
    assert(state.lateralMode === null, 'unreliable lateral mode should be unknown');
    assert(state.verticalMode === null, 'unreliable vertical mode should be unknown');
    assert(state.selectedAltitudeFt === null, 'unreliable AP selector should be unknown');
    assert(state.athrArmed === null, 'unreliable A/THR armed should be unknown');
    assert(state.athrActive === null, 'unreliable A/THR active should be unknown');
    assert(confidence.apMaster === 'unreliable', 'expected AP confidence to stay unreliable');
    assert(confidence.athrActive === 'unreliable', 'expected A/THR confidence to stay unreliable');
  });

  test('buildSnapshot does not label empty SDK connections as the automation source', () => {
    const snapshot = recorderModule.buildSnapshot(baseInput({
      sourceContext: {
        sdkConnected: true,
        sdkHasData: true,
        sdkHasAutomationData: false,
        lvarSidecarConnected: false,
      },
    }));

    assert(snapshot.meta.source === 'simconnect', `expected simconnect source, got ${snapshot.meta.source}`);
  });

  test('buildSnapshot does not label empty LVAR sidecars as the automation source', () => {
    const snapshot = recorderModule.buildSnapshot(baseInput({
      sourceContext: {
        lvarSidecarConnected: true,
        lvarHasAutopilotData: false,
        lvarHasAutothrottleData: false,
        lvarValues: {
          autopilot: null,
          autothrottle: null,
        },
      },
    }));

    assert(snapshot.meta.source === 'simconnect', `expected simconnect source, got ${snapshot.meta.source}`);
  });

  test('buildSnapshot labels false LVAR automation values as the automation source', () => {
    const snapshot = recorderModule.buildSnapshot(baseInput({
      sourceContext: {
        lvarSidecarConnected: true,
        lvarHasAutopilotData: true,
        lvarHasAutothrottleData: true,
        lvarValues: {
          autopilot: false,
          autothrottle: false,
        },
      },
    }));

    assert(snapshot.meta.source === 'lvar', `expected lvar source, got ${snapshot.meta.source}`);
  });

  test('buildSnapshot labels populated LVAR MCP fields as the automation source', () => {
    const snapshot = recorderModule.buildSnapshot(baseInput({
      sourceContext: {
        lvarSidecarConnected: true,
        lvarHasAutopilotData: false,
        lvarHasAutothrottleData: false,
        lvarValues: {
          autopilot: null,
          autothrottle: null,
          mode_lnav: true,
          mode_vnav: false,
        },
      },
    }));

    assert(snapshot.meta.source === 'lvar', `expected lvar source, got ${snapshot.meta.source}`);
    assert(snapshot.raw.lvars.mode_lnav === true, 'expected raw LVAR mode data to be preserved');
  });

  test('buildSnapshot preserves SDK FD and A/T armed raw automation fields', () => {
    const snapshot = recorderModule.buildSnapshot(baseInput({
      sourceContext: {
        sdkConnected: true,
        sdkHasData: true,
        sdkHasAutomationData: true,
        sdkValues: {
          fd_l: 0,
          fd_r: 1,
          at_armed: 1,
          at_arm_l: 0,
          at_arm_r: 1,
        },
      },
    }));

    assert(snapshot.meta.source === 'sdk', `expected sdk source, got ${snapshot.meta.source}`);
    assert(snapshot.raw.sdkRaw.fd_l === 0, 'expected raw left FD SDK value to be preserved');
    assert(snapshot.raw.sdkRaw.fd_r === 1, 'expected raw right FD SDK value to be preserved');
    assert(snapshot.raw.sdkRaw.at_armed === 1, 'expected raw A/T armed SDK value to be preserved');
    assert(snapshot.raw.sdkRaw.at_arm_r === 1, 'expected raw right A/T arm SDK value to be preserved');
  });

  test('automation JSONL rename queue is bounded while route rename is blocked', () => {
    const outputDir = path.join(os.tmpdir(), `automation-jsonl-rename-backlog-test-${Date.now()}`);
    const recorder = new recorderModule.AutomationJsonlRecorder({
      flightId: '2026-06-18T00:00:00.000Z',
      outputDir,
    });
    const largeLine = 'x'.repeat(1024 * 1024);
    const originalConsoleError = console.error;
    let rejected = false;

    recorder.renameInProgress = true;
    console.error = () => {};
    try {
      for (let index = 0; index < 20; index += 1) {
        if (!recorder.appendLine(largeLine)) {
          rejected = true;
          break;
        }
      }
    } finally {
      console.error = originalConsoleError;
    }

    assert(rejected === true, 'automation JSONL rename queue should reject writes once capped');
    assert(recorder.renameQueuedLineBytes <= 8 * 1024 * 1024, 'automation JSONL rename queue should stay within byte cap');
    assert(
      recorder.lastError && recorder.lastError.message.includes('rename backlog exceeded'),
      `Expected rename backlog error, got ${recorder.lastError && recorder.lastError.message}`
    );
  });

  test('automation JSONL stream writes are rejected when stream backlog is already capped', () => {
    const outputDir = path.join(os.tmpdir(), `automation-jsonl-stream-backlog-test-${Date.now()}`);
    const recorder = new recorderModule.AutomationJsonlRecorder({
      flightId: '2026-06-18T00:00:00.000Z',
      outputDir,
    });
    const originalConsoleError = console.error;
    recorder.stream = {
      writableLength: 16 * 1024 * 1024,
      write: () => {
        throw new Error('write should not be reached after backlog cap');
      },
    };

    let accepted = true;
    console.error = () => {};
    try {
      accepted = recorder.appendLine('sample');
    } finally {
      console.error = originalConsoleError;
    }

    assert(accepted === false, 'automation JSONL stream write should be rejected when stream backlog is capped');
    assert(recorder.rowCount === 0, 'rejected automation JSONL stream write should not increment row count');
    assert(
      recorder.lastError && recorder.lastError.message.includes('stream backlog exceeded'),
      `Expected stream backlog error, got ${recorder.lastError && recorder.lastError.message}`
    );
  });

  await testAsync('a repeated start cannot delete or disable an active automation sidecar', async () => {
    const outputDir = path.join(os.tmpdir(), `automation-jsonl-repeat-start-${Date.now()}`);
    fs.mkdirSync(outputDir, { recursive: true });
    const recorder = new recorderModule.AutomationJsonlRecorder({
      flightId: 'automation-repeat-start',
      recordingSessionId: 'automation-repeat-session',
      outputDir,
    });
    try {
      assert(recorder.start(), 'first start should succeed');
      const activePath = recorder.filePath;
      assert(!recorder.start(), 'a recorder instance must refuse a second start');
      assert(fs.existsSync(activePath), 'refusing a second start must preserve the active artifact');
      const stats = await recorder.close({ endReason: 'test_end' });
      const rows = fs.readFileSync(activePath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      assert(stats.hasError === false && rows.length === 1 && rows[0].seq === 1,
        'manifest history should remain healthy after the refusal');
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  await testAsync('failed automation manifest startup closes and removes its exclusive claim', async () => {
    const outputDir = path.join(os.tmpdir(), `automation-jsonl-manifest-failure-${Date.now()}`);
    fs.mkdirSync(outputDir, { recursive: true });
    const terminalErrors: Error[] = [];
    const recorder = new recorderModule.AutomationJsonlRecorder({
      flightId: 'automation-manifest-failure',
      recordingSessionId: 'automation-manifest-session',
      outputDir,
      onTerminalError: (error: Error) => terminalErrors.push(error),
    });
    const originalFdatasyncSync = fs.fdatasyncSync;
    try {
      (fs as any).fdatasyncSync = () => {
        throw new Error('simulated automation manifest durability failure');
      };
      assert(!recorder.start(), 'manifest durability failure must reject automation startup');
    } finally {
      (fs as any).fdatasyncSync = originalFdatasyncSync;
    }
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      const stats = await recorder.close({ endReason: 'test_end' });
      assert(!fs.existsSync(recorder.filePath), 'failed automation startup must remove its owned claim');
      assert(stats.rowCount === 0, 'failed automation manifest must not advance sequence state');
      assert(terminalErrors.length === 1, 'failed automation startup should report one terminal error');
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  if (failed > 0) {
    console.error(`\n${failed} automation JSONL recorder test(s) failed`);
    process.exit(1);
  }

  console.log(`\n${passed} automation JSONL recorder tests passed\n`);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
