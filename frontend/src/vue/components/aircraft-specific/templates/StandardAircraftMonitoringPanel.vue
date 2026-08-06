<script setup>
import { computed } from 'vue';

const props = defineProps({
  templateId: { type: String, required: true },
  title: { type: String, required: true },
  subtitle: { type: String, required: true },
  guidanceLabel: { type: String, required: true },
  guidancePrefix: { type: String, required: true },
  modeIndicators: { type: Array, default: () => [] },
  lightFields: {
    type: Array,
    default: null,
    validator: (value) => value === null || value.every((field) => (
      field
      && typeof field.id === 'string'
      && typeof field.label === 'string'
    )),
  },
  engineN1: { type: Boolean, default: false },
  engineCount: {
    type: Number,
    default: 2,
    validator: (value) => Number.isInteger(value) && value >= 1 && value <= 4,
  },
  gearNote: { type: String, default: '' },
  values: { type: Object, default: () => ({}) },
  unavailable: { type: Array, default: () => [] },
  sourceStatus: { type: String, default: 'awaiting-values' },
});

const unavailableFields = computed(() => new Set(props.unavailable));
const engineNumbers = computed(() => Array.from(
  { length: Math.min(4, Math.max(1, Math.trunc(props.engineCount))) },
  (_, index) => index + 1,
));
const defaultLightFields = [
  { id: 'lights.strobe', label: 'STROBE' },
  { id: 'lights.beacon', label: 'BEACON' },
  { id: 'lights.nav', label: 'NAV' },
  { id: 'lights.logo', label: 'LOGO' },
  { id: 'lights.wing', label: 'WING' },
  { id: 'lights.landing', label: 'LANDING' },
  { id: 'lights.taxi', label: 'TAXI' },
  { id: 'lights.runwayTurnoff', label: 'TURN OFF' },
];
const lights = computed(() => props.lightFields || defaultLightFields);

function guidanceField(name) {
  return `${props.guidancePrefix}.${name}`;
}

function engineField(engineNumber, suffix) {
  return `systems.engine${engineNumber}${suffix}`;
}

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
  const current = numberValue(guidanceField('headingDeg'));
  return current === null ? '---' : String(Math.round(current)).padStart(3, '0');
}

function verticalSpeedText() {
  const current = numberValue(guidanceField('verticalSpeedFpm'));
  if (current === null) return '----';
  const rounded = Math.round(current);
  return `${rounded > 0 ? '+' : ''}${rounded}`;
}

function booleanText(id) {
  const current = value(id);
  if (current === true) return 'ON';
  if (current === false) return 'OFF';
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

function tonnesText(id) {
  const pounds = numberValue(id);
  return pounds === null ? '--' : (pounds * 0.00045359237).toFixed(1);
}
</script>

<template>
  <div
    class="p-3 sm:p-4 space-y-5"
    :data-aircraft-template="templateId"
    data-aircraft-page-scope="monitoring-first"
  >
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 class="text-base font-semibold text-gray-100">{{ title }}</h3>
        <p class="text-xs text-gray-500">{{ subtitle }}</p>
      </div>
      <div class="flex flex-wrap justify-end gap-1.5">
        <span class="rounded border border-surface-300 px-2 py-1 text-[9px] uppercase tracking-widest text-gray-400">{{ sourceStatus }}</span>
        <span class="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[9px] uppercase tracking-widest text-amber-300">Monitoring only</span>
      </div>
    </div>

    <section>
      <div class="dashboard-section-kicker">{{ guidanceLabel }}</div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
          <div class="text-[9px] uppercase tracking-widest text-gray-500">SPD</div>
          <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ integerText(guidanceField('speedKts')) }}</div>
        </div>
        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
          <div class="text-[9px] uppercase tracking-widest text-gray-500">HDG</div>
          <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ headingText() }}°</div>
        </div>
        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
          <div class="text-[9px] uppercase tracking-widest text-gray-500">ALTITUDE</div>
          <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ integerText(guidanceField('altitudeFt')) }} <span class="text-xs text-gray-500">ft</span></div>
        </div>
        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
          <div class="text-[9px] uppercase tracking-widest text-gray-500">V/S</div>
          <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ verticalSpeedText() }} <span class="text-xs text-gray-500">fpm</span></div>
        </div>
      </div>
      <div class="mt-2 grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-6 gap-2">
        <div
          v-for="indicator in modeIndicators"
          :key="indicator.id"
          class="rounded border px-2.5 py-2 text-[10px] font-semibold"
          :class="indicatorClass(indicator.id)"
        >
          {{ indicator.label }} <span class="float-right opacity-70">{{ booleanText(indicator.id) }}</span>
        </div>
      </div>
      <p class="mt-2 text-[10px] leading-relaxed text-gray-500">Unavailable values are shown as --.</p>
    </section>

    <section>
      <div class="dashboard-section-kicker">Exterior Lights</div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div
          v-for="light in lights"
          :key="light.id"
          :data-aircraft-field="light.id"
          class="rounded border px-2.5 py-2 text-[10px] font-semibold"
          :class="indicatorClass(light.id)"
        >
          {{ light.label }} <span class="float-right opacity-70">{{ booleanText(light.id) }}</span>
        </div>
      </div>
    </section>

    <section>
      <div class="dashboard-section-kicker">Flight Configuration</div>
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3 text-sm text-gray-300">FLAP HANDLE <span class="float-right font-mono font-semibold">{{ integerText('controls.flapsPercent') }}%</span></div>
        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3 text-sm text-gray-300">FLAP INDEX <span class="float-right font-mono font-semibold">{{ integerText('controls.flapsIndex') }}</span></div>
        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3 text-sm text-gray-300">FLAP ANGLE <span class="float-right font-mono font-semibold">{{ decimalText('controls.flapAngleDeg') }}°</span></div>
      </div>
      <div class="mt-2 grid grid-cols-2 sm:grid-cols-5 gap-2">
        <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="indicatorClass('controls.gearHandleDown')">GEAR HANDLE <span class="float-right">{{ value('controls.gearHandleDown') === null ? '--' : (value('controls.gearHandleDown') ? 'DOWN' : 'UP') }}</span></div>
        <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="gearClass('controls.gearNosePct')">NOSE <span class="float-right">{{ integerText('controls.gearNosePct') }}%</span></div>
        <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="gearClass('controls.gearLeftPct')">LEFT <span class="float-right">{{ integerText('controls.gearLeftPct') }}%</span></div>
        <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="gearClass('controls.gearRightPct')">RIGHT <span class="float-right">{{ integerText('controls.gearRightPct') }}%</span></div>
        <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="indicatorClass('controls.parkingBrake', true)">PARK BRAKE <span class="float-right">{{ booleanText('controls.parkingBrake') }}</span></div>
      </div>
      <p v-if="gearNote" class="mt-2 text-[10px] leading-relaxed text-gray-500">{{ gearNote }}</p>
    </section>

    <section>
      <div class="dashboard-section-kicker">Engines, Fuel &amp; Pressurization</div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div
          v-for="engineNumber in engineNumbers"
          :key="engineNumber"
          class="rounded-lg border border-surface-200 bg-surface-50 p-3"
          :data-aircraft-engine="engineNumber"
        >
          <div class="text-[9px] uppercase tracking-widest text-gray-500">ENGINE {{ engineNumber }}</div>
          <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ engineN1 ? `${decimalText(engineField(engineNumber, 'N1'))}%` : booleanText(engineField(engineNumber, 'Running')) }}</div>
        </div>
        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
          <div class="text-[9px] uppercase tracking-widest text-gray-500">FUEL</div>
          <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ decimalText('systems.fuelTotalPct') }}%</div>
        </div>
        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
          <div class="text-[9px] uppercase tracking-widest text-gray-500">GROSS WEIGHT</div>
          <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ tonnesText('systems.grossWeightLbs') }} <span class="text-xs text-gray-500">t</span></div>
        </div>
      </div>
      <div class="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px] text-gray-300">
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2">FUEL WT <span class="float-right font-semibold">{{ tonnesText('systems.fuelTotalWeightLbs') }} t</span></div>
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2">CAB ALT <span class="float-right font-semibold">{{ integerText('systems.cabinAltitudeFt') }} ft</span></div>
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2">CAB V/S <span class="float-right font-semibold">{{ integerText('systems.cabinVerticalSpeedFpm') }} fpm</span></div>
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2">DELTA P <span class="float-right font-semibold">{{ decimalText('systems.cabinDeltaPressurePsi', 2) }} psi</span></div>
      </div>
    </section>

  </div>
</template>
