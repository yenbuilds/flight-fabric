<script setup>
import { computed } from 'vue';
import { getAircraftControlCommandPendingKey } from '../../../../aircraft/control-ui.js';
import { useAircraftControlsStore } from '../../../stores/aircraft-controls.js';

const props = defineProps({
  profileKey: { type: String, default: '' },
  values: { type: Object, default: () => ({}) },
  unavailable: { type: Array, default: () => [] },
  sourceStatus: { type: String, default: 'awaiting-values' },
  sourceStatuses: { type: Object, default: () => ({}) },
  actionCapabilities: { type: Object, default: () => ({}) },
  requestAction: { type: Function, default: () => false },
  isActionPending: { type: Function, default: () => false },
});

const aircraftControls = useAircraftControlsStore();
const unavailableFields = computed(() => new Set(props.unavailable));

const flapDetents = Object.freeze(['UP', '1', '2', '5', '10', '15', '25', '30', '40']);

const mcpWindows = Object.freeze([
  { id: 'mcp.speed', label: 'SPD', unit: '' },
  { id: 'mcp.headingDeg', label: 'HDG', unit: 'deg' },
  { id: 'mcp.altitudeFt', label: 'ALTITUDE', unit: 'ft' },
  { id: 'mcp.verticalSpeedFpm', label: 'VERT SPEED', unit: 'fpm' },
]);

const afdsIndicators = Object.freeze([
  { id: 'afds.cmdA', label: 'CMD A' },
  { id: 'afds.autothrottleArm', label: 'A/T ARM' },
  { id: 'afds.lnav', label: 'LNAV' },
  { id: 'afds.headingSelect', label: 'HDG SEL' },
  { id: 'afds.levelChange', label: 'LVL CHG' },
  { id: 'afds.approach', label: 'APP' },
  { id: 'afds.altitudeHold', label: 'ALT HLD' },
  { id: 'afds.verticalSpeed', label: 'V/S' },
]);

const lightIndicators = Object.freeze([
  { id: 'lights.strobe', label: 'STROBE' },
  { id: 'lights.beacon', label: 'BEACON' },
  { id: 'lights.nav', label: 'NAV' },
  { id: 'lights.logo', label: 'LOGO' },
  { id: 'lights.wing', label: 'WING' },
  { id: 'lights.landing', label: 'LANDING' },
  { id: 'lights.taxi', label: 'TAXI' },
  { id: 'lights.runwayTurnoff', label: 'TURN OFF' },
]);

const engines = Object.freeze([
  { number: 1, n1Id: 'systems.engine1N1', runningId: 'systems.engine1Running' },
  { number: 2, n1Id: 'systems.engine2N1', runningId: 'systems.engine2Running' },
]);

const genericCommands = Object.freeze([
  { id: 'ctrl-gear-up-btn', key: 'gearUp', label: 'Gear Up', command: { type: 'preset', id: 'gearUp' } },
  { id: 'ctrl-gear-down-btn', key: 'gearDown', label: 'Gear Down', command: { type: 'preset', id: 'gearDown' } },
  { id: 'ctrl-flaps-dec-btn', key: 'flapsDecrease', label: 'Flaps Less', command: { type: 'preset', id: 'flapsDecrease' } },
  { id: 'ctrl-flaps-inc-btn', key: 'flapsIncrease', label: 'Flaps More', command: { type: 'preset', id: 'flapsIncrease' } },
]);

const simvarStatus = computed(() => (
  typeof props.sourceStatuses.simvar === 'string'
    ? props.sourceStatuses.simvar
    : props.sourceStatus
));

function hasValue(id) {
  return !unavailableFields.value.has(id)
    && Object.prototype.hasOwnProperty.call(props.values, id);
}

function value(id) {
  return hasValue(id) ? props.values[id] : null;
}

function numberValue(id) {
  const current = value(id);
  return typeof current === 'number' && Number.isFinite(current) ? current : null;
}

function integerText(id, fallback = '--') {
  const current = numberValue(id);
  return current === null ? fallback : Math.round(current).toLocaleString('en-US');
}

function decimalText(id, precision = 1, fallback = '--') {
  const current = numberValue(id);
  return current === null ? fallback : current.toFixed(precision);
}

function mcpText(field) {
  const current = numberValue(field.id);
  if (current === null) return field.id === 'mcp.headingDeg' ? '---' : '--';
  if (field.id === 'mcp.speed' && current > 0 && current < 10) return current.toFixed(2);
  if (field.id === 'mcp.headingDeg') return String(Math.round(current)).padStart(3, '0');
  if (field.id === 'mcp.altitudeFt') return Math.round(current).toLocaleString('en-US');
  if (field.id === 'mcp.verticalSpeedFpm') {
    const rounded = Math.round(current);
    return `${rounded > 0 ? '+' : ''}${rounded}`;
  }
  return String(Math.round(current));
}

function booleanText(id, trueLabel = 'ON', falseLabel = 'OFF') {
  const current = value(id);
  if (current === true) return trueLabel;
  if (current === false) return falseLabel;
  return '--';
}

function indicatorClass(id, warning = false) {
  const current = value(id);
  if (current === null) return 'border-surface-200 bg-surface-50 text-gray-500';
  if (current !== true) return 'border-surface-200 bg-surface-50 text-gray-400';
  return warning
    ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
    : 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300';
}

function gearClass(id) {
  const current = numberValue(id);
  if (current === null) return 'border-surface-200 bg-surface-50 text-gray-500';
  if (current >= 99) return 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300';
  if (current <= 1) return 'border-surface-200 bg-surface-50 text-gray-400';
  return 'border-amber-500/50 bg-amber-500/15 text-amber-300';
}

function flapDetentText() {
  const index = numberValue('controls.flapsIndex');
  if (index === null || !Number.isInteger(index) || index < 0 || index >= flapDetents.length) return '--';
  return flapDetents[index];
}

function tonnesText(id) {
  const pounds = numberValue(id);
  return pounds === null ? '--' : (pounds * 0.00045359237).toFixed(1);
}

function isCommandPending(command) {
  return aircraftControls.isCommandPending(getAircraftControlCommandPendingKey(command));
}

function isCommandDisabled(command) {
  return aircraftControls.isCommandDisabled(command);
}

function commandTitle(command) {
  if (isCommandPending(command)) return 'Command in progress';
  if (aircraftControls.isCommandSupported(command) !== true) {
    return 'No mapped action is available for this aircraft profile';
  }
  return aircraftControls.availability.reason || undefined;
}

function requestGenericCommand(command) {
  if (isCommandDisabled(command)) return false;
  return aircraftControls.requestControlCommand(command, {
    pendingKey: getAircraftControlCommandPendingKey(command),
  });
}
</script>

<template>
  <div
    class="p-3 sm:p-4 space-y-4"
    data-aircraft-template="ifly-737-max-8"
    data-ifly-737-scope="max-8"
  >
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 class="text-base font-semibold text-gray-100">iFly Boeing 737 MAX 8</h3>
        <p class="text-xs text-gray-500">A compact MCP, configuration, and systems view with guarded standard surface controls.</p>
      </div>
      <div class="flex flex-wrap justify-end gap-1.5">
        <span class="rounded border border-surface-300 px-2 py-1 text-[9px] uppercase tracking-widest text-gray-400">Standard mirrors {{ simvarStatus }}</span>
      </div>
    </div>

    <section>
      <div class="dashboard-section-kicker">Mode Control Panel</div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div
          v-for="field in mcpWindows"
          :key="field.id"
          class="rounded-lg border border-surface-200 bg-surface-50 p-3"
          :data-ifly-mcp-field="field.id"
        >
          <div class="text-[9px] uppercase tracking-widest text-gray-500">{{ field.label }}</div>
          <div class="mt-1 flex items-baseline gap-1">
            <span class="font-mono text-lg font-semibold text-gray-100">{{ mcpText(field) }}</span>
            <span v-if="field.unit" class="text-[10px] text-gray-500">{{ field.unit }}</span>
          </div>
        </div>
      </div>

      <div class="mt-2 grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-2">
        <div
          v-for="indicator in afdsIndicators"
          :key="indicator.id"
          class="rounded border px-2.5 py-2 text-[10px] font-semibold"
          :class="indicatorClass(indicator.id)"
          :data-ifly-afds-indicator="indicator.id"
        >
          <span>{{ indicator.label }}</span>
          <span class="float-right opacity-70">{{ booleanText(indicator.id) }}</span>
        </div>
      </div>
      <p class="mt-2 text-[10px] leading-relaxed text-gray-500">
        MCP and AFDS status may not match the cockpit.
      </p>
    </section>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <section>
        <div class="dashboard-section-kicker">Flight Configuration</div>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
            <div class="text-[9px] uppercase tracking-widest text-gray-500">FLAP DETENT</div>
            <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ flapDetentText() }}</div>
          </div>
          <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
            <div class="text-[9px] uppercase tracking-widest text-gray-500">FLAP HANDLE</div>
            <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ integerText('controls.flapsPercent') }}<span class="text-xs text-gray-500">%</span></div>
          </div>
          <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
            <div class="text-[9px] uppercase tracking-widest text-gray-500">FLAP ANGLE</div>
            <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ decimalText('controls.flapAngleDeg') }}<span class="text-xs text-gray-500"> deg</span></div>
          </div>
          <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
            <div class="text-[9px] uppercase tracking-widest text-gray-500">SPEEDBRAKE</div>
            <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ integerText('controls.speedbrakePercent') }}<span class="text-xs text-gray-500">%</span></div>
          </div>
        </div>
        <div class="mt-2 grid grid-cols-2 sm:grid-cols-5 gap-2">
          <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="indicatorClass('controls.gearHandleDown')">
            GEAR <span class="float-right">{{ booleanText('controls.gearHandleDown', 'DOWN', 'UP') }}</span>
          </div>
          <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="gearClass('controls.gearNosePct')">
            NOSE <span class="float-right">{{ integerText('controls.gearNosePct') }}%</span>
          </div>
          <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="gearClass('controls.gearLeftPct')">
            LEFT <span class="float-right">{{ integerText('controls.gearLeftPct') }}%</span>
          </div>
          <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="gearClass('controls.gearRightPct')">
            RIGHT <span class="float-right">{{ integerText('controls.gearRightPct') }}%</span>
          </div>
          <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="indicatorClass('controls.parkingBrake', true)">
            PARK <span class="float-right">{{ booleanText('controls.parkingBrake', 'SET', 'OFF') }}</span>
          </div>
        </div>
      </section>

      <section>
        <div class="dashboard-section-kicker">Engines &amp; Exterior Lights</div>
        <div class="grid grid-cols-2 gap-2">
          <div
            v-for="engine in engines"
            :key="engine.number"
            class="rounded-lg border border-surface-200 bg-surface-50 p-3"
            :data-ifly-engine="engine.number"
          >
            <div class="flex items-center justify-between gap-2">
              <div class="text-[9px] uppercase tracking-widest text-gray-500">ENGINE {{ engine.number }}</div>
              <span class="rounded border px-2 py-1 text-[9px] font-semibold" :class="indicatorClass(engine.runningId)">
                {{ booleanText(engine.runningId, 'RUNNING', 'STOPPED') }}
              </span>
            </div>
            <div class="mt-3 flex items-end justify-between">
              <span class="text-[10px] uppercase tracking-widest text-gray-500">N1</span>
              <span class="font-mono text-xl font-semibold text-gray-100">{{ decimalText(engine.n1Id) }}<span class="ml-0.5 text-xs text-gray-500">%</span></span>
            </div>
          </div>
        </div>
        <div class="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div
            v-for="indicator in lightIndicators"
            :key="indicator.id"
            class="rounded border px-2.5 py-2 text-[10px] font-semibold"
            :class="indicatorClass(indicator.id)"
            :data-ifly-light="indicator.id"
          >
            {{ indicator.label }} <span class="float-right opacity-70">{{ booleanText(indicator.id) }}</span>
          </div>
        </div>
      </section>
    </div>

    <section>
      <div class="dashboard-section-kicker">Fuel, Weight &amp; Environment</div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
          <div class="text-[9px] uppercase tracking-widest text-gray-500">FUEL</div>
          <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ decimalText('systems.fuelTotalPct') }}<span class="text-xs text-gray-500">%</span></div>
        </div>
        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
          <div class="text-[9px] uppercase tracking-widest text-gray-500">FUEL WEIGHT</div>
          <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ tonnesText('systems.fuelTotalWeightLbs') }} <span class="text-xs text-gray-500">t</span></div>
        </div>
        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
          <div class="text-[9px] uppercase tracking-widest text-gray-500">GROSS WEIGHT</div>
          <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ tonnesText('systems.grossWeightLbs') }} <span class="text-xs text-gray-500">t</span></div>
        </div>
        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
          <div class="text-[9px] uppercase tracking-widest text-gray-500">OAT / MACH</div>
          <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ decimalText('systems.outsideAirTemperatureC') }}<span class="text-xs text-gray-500"> C</span> / {{ decimalText('systems.mach', 3) }}</div>
        </div>
      </div>
      <div class="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2 text-[10px] text-gray-300">
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2">CAB ALT <span class="float-right font-semibold">{{ integerText('systems.cabinAltitudeFt') }} ft</span></div>
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2">CAB V/S <span class="float-right font-semibold">{{ integerText('systems.cabinVerticalSpeedFpm') }} fpm</span></div>
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2">DELTA P <span class="float-right font-semibold">{{ decimalText('systems.cabinDeltaPressurePsi', 2) }} psi</span></div>
      </div>
    </section>

    <section class="rounded-lg border border-surface-200 bg-surface-50 p-3" data-ifly-generic-controls>
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div class="dashboard-section-kicker">Gear &amp; Flap Commands</div>
          <p class="text-[10px] leading-relaxed text-gray-500">MCP and AFDS controls are unavailable.</p>
        </div>
        <span class="rounded border border-amber-500/35 bg-amber-500/10 px-2 py-1 text-[9px] uppercase tracking-widest text-amber-300">
          {{ aircraftControls.availability.enabled ? 'Ready' : 'Unavailable' }}
        </span>
      </div>
      <div class="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
        <button
          v-for="item in genericCommands"
          :id="item.id"
          :key="item.key"
          type="button"
          class="min-h-11 rounded border border-surface-300 bg-surface-100 px-2.5 py-2 text-[10px] font-semibold text-gray-200 transition-colors hover:border-cyan-500/45 disabled:cursor-not-allowed disabled:opacity-45"
          :class="isCommandPending(item.command) ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-200' : ''"
          :data-ifly-generic-command="item.key"
          :disabled="isCommandDisabled(item.command)"
          :aria-busy="isCommandPending(item.command) ? 'true' : 'false'"
          :title="commandTitle(item.command)"
          @click="requestGenericCommand(item.command)"
        >
          {{ isCommandPending(item.command) ? 'Sending...' : item.label }}
        </button>
      </div>
    </section>

  </div>
</template>
