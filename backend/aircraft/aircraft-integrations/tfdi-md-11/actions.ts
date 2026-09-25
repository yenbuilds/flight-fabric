'use strict';

import type { AircraftIntegrationAction, AircraftIntegrationActionCondition } from '../types.js';

// Only documented EXTCTL inputs and CEVENT events are writable. State,
// annunciator and animation LVARs remain read-only. See MD11-CONTROL-VALIDATION.md.
const actions: Record<string, AircraftIntegrationAction> = {};
const powered: AircraftIntegrationActionCondition = {
  fieldId: 'systems.busVoltage', freshness: 'field', min: 90, max: 130,
};
const eventCode = (id: number) => `${id} (>L:CEVENT, Number)`;

function target(id: string, fieldId: string, lvar: string, min: number, max: number, step: number,
  modeField?: string, mode?: string | number): void {
  actions[id] = {
    id, input: { type: 'number', min, max, step },
    guard: { cooldownMs: 400, groupId: 'md11.fcp', retry: 'never', requires: [powered,
      ...(modeField ? [{ fieldId: modeField, freshness: 'field' as const, expectedValue: mode }] : []),
      { fieldId, freshness: 'field', min, max },
    ] },
    routes: [{ id: `md11.${id}.external`, transport: 'simconnect-sequence',
      operations: [{ type: 'lvar', name: `L:${lvar}`, unit: 'Number', inputValue: { source: 'input' } }],
      readback: { fieldId, expectedInput: true, freshness: 'field', timeoutMs: 3000 },
    }], verification: 'partial',
  };
}

target('flightGuidance.speed.set', 'afs.speedValue', 'MD11_EXTCTL_FCP_SPD', 100, 399, 1, 'afs.speedMode', 'ias');
target('flightGuidance.heading.set', 'afs.headingValue', 'MD11_EXTCTL_FCP_HDG', 0, 359, 1, 'afs.headingMode', 'heading');
target('flightGuidance.altitude.set', 'afs.altitudeValue', 'MD11_EXTCTL_FCP_ALT', 0, 50000, 100, 'afs.altitudeUnit', 'feet');

function button(prefix: string, fieldId: string, down: number, up: number): void {
  for (const [suffix, expectedValue] of [['off', false], ['on', true]] as const) {
    const id = `${prefix}.${suffix}`;
    actions[id] = { id,
      // CEVENT is one shared mailbox: serialize all switch transactions.
      guard: { cooldownMs: 400, groupId: 'md11.cevent', retry: 'never', requires: [powered] },
      routes: [{ id: `md11.${id}.event`, transport: 'mobiflight-calculator', mode: 'pulse',
        pressCode: eventCode(down), releaseCode: eventCode(up), delayMs: 150,
        readback: { fieldId, expectedValue, freshness: 'field', timeoutMs: 3000 },
      }], verification: 'partial',
    };
  }
}
button('lights.nav', 'lights.nav', 90267, 90268);
button('lights.beacon', 'lights.beacon', 90271, 90272);
button('lights.strobe', 'lights.strobe', 90273, 90274);
button('lights.logo', 'lights.logo', 90269, 90270);
button('lights.turnoffLeft', 'lights.turnoffLeft', 90263, 90264);
button('lights.turnoffRight', 'lights.turnoffRight', 90265, 90266);

function selector(id: string, fieldId: string, increase: number, decrease: number,
  min: number, max: number, step: number, maxSteps: number): void {
  actions[id] = { id, input: { type: 'number', min, max, step },
    guard: { cooldownMs: 400, groupId: 'md11.cevent', retry: 'never', requires: [powered] },
    routes: [{ id: `md11.${id}.event`, transport: 'mobiflight-calculator', mode: 'step-to-target',
      increaseCode: eventCode(increase), decreaseCode: eventCode(decrease), maxSteps,
      readback: { fieldId, expectedInput: true, freshness: 'field', timeoutMs: 3000 },
    }], verification: 'partial',
  };
}
// Both directions and all three positions confirmed on the parked PW4462.
selector('lights.landingLeft.set', 'lights.landingLeftPosition', 90258, 90257, 0, 2, 1, 2);
selector('lights.landingRight.set', 'lights.landingRightPosition', 90260, 90259, 0, 2, 1, 2);
selector('lights.nose.set', 'lights.nosePosition', 90262, 90261, 0, 2, 1, 2);
selector('cabin.seatBelts.set', 'cabin.seatBeltsPosition', 90249, 90248, 0, 2, 1, 2);
selector('cabin.noSmoking.set', 'cabin.noSmokingPosition', 90247, 90246, 0, 2, 1, 2);

// The EXTCTL minimums input did not move the loaded aircraft. Use the published
// wheel events, with a fresh RADIO reference and confirmation after every detent.
for (const [side, increase, decrease] of [['captain', 86064, 86065], ['firstOfficer', 86134, 86135]] as const) {
  const id = `approach.${side}.minimums.set`;
  selector(id, `approach.${side}.minimums`, increase, decrease, 0, 1000, 10, 100);
  actions[id] = { ...actions[id], guard: { ...actions[id].guard,
    requires: [powered, { fieldId: `approach.${side}.minimumsMode`, freshness: 'field', expectedValue: 'radio' }],
  } };
}

for (const [side, prefix] of [['captain', 'CAP'], ['firstOfficer', 'FO']] as const) {
  target(`baro.${side}.inHg.set`, `baro.${side}.value`, `MD11_EXTCTL_${prefix}_BARO`,
    28, 31, 0.01);
}

const TFDI_MD_11_ACTIONS = Object.freeze(actions);

module.exports = {
  TFDI_MD_11_ACTIONS,
};

export {};
