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

const flapDetents = Object.freeze(['UP', '4', '10', '22', '33', '42']);
const engines = Object.freeze([
  { number: 1, station: 'LEFT WING', n1Id: 'systems.engine1N1', runningId: 'systems.engine1Running' },
  { number: 2, station: 'TAIL', n1Id: 'systems.engine2N1', runningId: 'systems.engine2Running' },
  { number: 3, station: 'RIGHT WING', n1Id: 'systems.engine3N1', runningId: 'systems.engine3Running' },
]);
const lightIndicators = Object.freeze([
  { id: 'lights.strobe', label: 'STROBE' },
  { id: 'lights.beacon', label: 'BEACON' },
  { id: 'lights.nav', label: 'NAV' },
  { id: 'lights.logo', label: 'LOGO' },
  { id: 'lights.landing', label: 'LANDING' },
  { id: 'lights.taxi', label: 'TAXI' },
]);
const genericCommands = Object.freeze([
  { id: 'ctrl-gear-up-btn', key: 'gearUp', label: 'Gear Up', command: { type: 'preset', id: 'gearUp' } },
  { id: 'ctrl-gear-down-btn', key: 'gearDown', label: 'Gear Down', command: { type: 'preset', id: 'gearDown' } },
  { id: 'ctrl-flaps-dec-btn', key: 'flapsDecrease', label: 'Flaps Less', command: { type: 'preset', id: 'flapsDecrease' } },
  { id: 'ctrl-flaps-inc-btn', key: 'flapsIncrease', label: 'Flaps More', command: { type: 'preset', id: 'flapsIncrease' } },
  { id: 'ap-master-btn', key: 'autopilotMasterToggle', label: 'AP Master', command: { type: 'preset', id: 'autopilotMasterToggle' } },
  { id: 'ap-fd-btn', key: 'flightDirectorToggle', label: 'Flight Director', command: { type: 'preset', id: 'flightDirectorToggle' } },
  { id: 'ap-spd-engage', key: 'speedHoldToggle', label: 'SPD Hold', command: { type: 'selector-hold', mode: 'spd' } },
  { id: 'ap-hdg-engage', key: 'headingHoldToggle', label: 'HDG Hold', command: { type: 'selector-hold', mode: 'hdg' } },
  { id: 'ap-alt-engage', key: 'altitudeHoldToggle', label: 'ALT Hold', command: { type: 'selector-hold', mode: 'alt' } },
  { id: 'ap-vs-engage', key: 'verticalSpeedHoldToggle', label: 'V/S Hold', command: { type: 'selector-hold', mode: 'vs' } },
  { id: 'ap-loc-btn', key: 'locToggle', label: 'LOC', command: { type: 'preset', id: 'locToggle' } },
  { id: 'ap-app-btn', key: 'appToggle', label: 'APP', command: { type: 'preset', id: 'appToggle' } },
]);

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

function headingText() {
  const current = numberValue('flightGuidance.headingDeg');
  return current === null ? '---' : String(Math.round(current)).padStart(3, '0');
}

function verticalSpeedText() {
  const current = numberValue('flightGuidance.verticalSpeedFpm');
  if (current === null) return '----';
  const rounded = Math.round(current);
  return `${rounded > 0 ? '+' : ''}${rounded}`;
}

function flapDetentText() {
  const index = numberValue('controls.flapsIndex');
  if (index === null || !Number.isInteger(index) || index < 0 || index >= flapDetents.length) return '--';
  return flapDetents[index];
}

function booleanText(id, trueLabel = 'ON', falseLabel = 'OFF') {
  const current = value(id);
  if (current === true) return trueLabel;
  if (current === false) return falseLabel;
  return '--';
}

function indicatorClass(id, warning = false) {
  const current = value(id);
  if (current !== true) return 'border-surface-200 bg-surface-50 text-gray-500';
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
    data-aircraft-template="inibuilds-tristar"
    data-inibuilds-tristar-scope="msfs-2024-airliner"
  >
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 class="text-base font-semibold text-gray-100">iniBuilds Lockheed L-1011 TriStar</h3>
        <p class="text-xs text-gray-500">A compact live view of the classic three-engine wide-body.</p>
      </div>
      <div class="flex flex-wrap justify-end gap-1.5">
        <span class="rounded border border-surface-300 px-2 py-1 text-[9px] uppercase tracking-widest text-gray-400">{{ sourceStatus }}</span>
        <span class="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[9px] uppercase tracking-widest text-amber-300">Standard SimVars</span>
      </div>
    </div>

    <section>
      <div class="dashboard-section-kicker">RB211 Engine Deck</div>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div
          v-for="engine in engines"
          :key="engine.number"
          class="rounded-lg border border-surface-200 bg-surface-50 p-3"
          :data-tristar-engine="engine.number"
        >
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-[9px] uppercase tracking-widest text-gray-500">ENGINE {{ engine.number }}</div>
              <div class="mt-0.5 text-[10px] font-semibold tracking-wide text-gray-300">{{ engine.station }}</div>
            </div>
            <span
              class="rounded border px-2 py-1 text-[9px] font-semibold"
              :class="indicatorClass(engine.runningId)"
            >
              {{ booleanText(engine.runningId, 'RUNNING', 'STOPPED') }}
            </span>
          </div>
          <div class="mt-3 flex items-end justify-between">
            <span class="text-[10px] uppercase tracking-widest text-gray-500">N1</span>
            <span class="font-mono text-xl font-semibold text-gray-100">{{ decimalText(engine.n1Id) }}<span class="ml-0.5 text-xs text-gray-500">%</span></span>
          </div>
        </div>
      </div>
      <p class="mt-2 text-[10px] leading-relaxed text-gray-500">
        The TriStar is EPR-rated. These N1 values are standard simulator spool indications, not a substitute for the aircraft's EPR gauges.
      </p>
    </section>

    <section>
      <div class="dashboard-section-kicker">AFCS Selectors</div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
          <div class="text-[9px] uppercase tracking-widest text-gray-500">SPD</div>
          <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ integerText('flightGuidance.speedValue') }}</div>
        </div>
        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
          <div class="text-[9px] uppercase tracking-widest text-gray-500">HDG</div>
          <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ headingText() }}°</div>
        </div>
        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
          <div class="text-[9px] uppercase tracking-widest text-gray-500">ALTITUDE</div>
          <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ integerText('flightGuidance.altitudeFt') }} <span class="text-xs text-gray-500">ft</span></div>
        </div>
        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
          <div class="text-[9px] uppercase tracking-widest text-gray-500">V/S</div>
          <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ verticalSpeedText() }} <span class="text-xs text-gray-500">fpm</span></div>
        </div>
      </div>
      <p class="mt-2 text-[10px] leading-relaxed text-amber-200/80">
        AFCS mode status is unavailable, and selector values may not match the cockpit.
      </p>
    </section>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <section>
        <div class="dashboard-section-kicker">Flight Configuration</div>
        <div class="grid grid-cols-3 gap-2">
          <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
            <div class="text-[9px] uppercase tracking-widest text-gray-500">FLAP DETENT</div>
            <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ flapDetentText() }}</div>
          </div>
          <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
            <div class="text-[9px] uppercase tracking-widest text-gray-500">HANDLE</div>
            <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ integerText('controls.flapsPercent') }}<span class="text-xs text-gray-500">%</span></div>
          </div>
          <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
            <div class="text-[9px] uppercase tracking-widest text-gray-500">FLAP ANGLE</div>
            <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ decimalText('controls.flapAngleDeg') }}<span class="text-xs text-gray-500">°</span></div>
          </div>
        </div>
        <div class="mt-2 grid grid-cols-2 sm:grid-cols-5 gap-2">
          <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="indicatorClass('controls.gearHandleDown')">GEAR <span class="float-right">{{ booleanText('controls.gearHandleDown', 'DOWN', 'UP') }}</span></div>
          <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="gearClass('controls.gearNosePct')">NOSE <span class="float-right">{{ integerText('controls.gearNosePct') }}%</span></div>
          <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="gearClass('controls.gearLeftPct')">LEFT <span class="float-right">{{ integerText('controls.gearLeftPct') }}%</span></div>
          <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="gearClass('controls.gearRightPct')">RIGHT <span class="float-right">{{ integerText('controls.gearRightPct') }}%</span></div>
          <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="indicatorClass('controls.parkingBrake', true)">PARK <span class="float-right">{{ booleanText('controls.parkingBrake') }}</span></div>
        </div>
      </section>

      <section>
        <div class="dashboard-section-kicker">Exterior Lights</div>
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <div
            v-for="indicator in lightIndicators"
            :key="indicator.id"
            class="rounded border px-2.5 py-2 text-[10px] font-semibold"
            :class="indicatorClass(indicator.id)"
          >
            {{ indicator.label }} <span class="float-right opacity-70">{{ booleanText(indicator.id) }}</span>
          </div>
        </div>
      </section>
    </div>

    <section>
      <div class="dashboard-section-kicker">Fuel, Weight &amp; Pressurization</div>
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
          <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ decimalText('systems.outsideAirTemperatureC') }}° / {{ decimalText('systems.mach', 3) }}</div>
        </div>
      </div>
      <div class="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2 text-[10px] text-gray-300">
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2">CAB ALT <span class="float-right font-semibold">{{ integerText('systems.cabinAltitudeFt') }} ft</span></div>
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2">CAB V/S <span class="float-right font-semibold">{{ integerText('systems.cabinVerticalSpeedFpm') }} fpm</span></div>
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2">DELTA P <span class="float-right font-semibold">{{ decimalText('systems.cabinDeltaPressurePsi', 2) }} psi</span></div>
      </div>
    </section>

    <section class="rounded-lg border border-surface-200 bg-surface-50 p-3" data-tristar-generic-controls>
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div class="dashboard-section-kicker">Aircraft Commands</div>
          <p class="text-[10px] leading-relaxed text-gray-500">AFCS buttons send a command but do not show whether the mode is active.</p>
        </div>
        <span class="rounded border border-amber-500/35 bg-amber-500/10 px-2 py-1 text-[9px] uppercase tracking-widest text-amber-300">{{ aircraftControls.availability.enabled ? 'Ready' : 'Unavailable' }}</span>
      </div>
      <div class="mt-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <button
          v-for="item in genericCommands"
          :id="item.id"
          :key="item.key"
          type="button"
          class="rounded border border-surface-300 bg-surface-100 px-2.5 py-2 text-[10px] font-semibold text-gray-200 transition-colors hover:border-cyan-500/45 disabled:cursor-not-allowed disabled:opacity-45"
          :class="isCommandPending(item.command) ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-200' : ''"
          :data-tristar-generic-command="item.key"
          :disabled="isCommandDisabled(item.command)"
          :aria-busy="isCommandPending(item.command) ? 'true' : 'false'"
          :title="commandTitle(item.command)"
          @click="requestGenericCommand(item.command)"
        >
          {{ isCommandPending(item.command) ? 'Sending…' : item.label }}
        </button>
      </div>
    </section>

  </div>
</template>
