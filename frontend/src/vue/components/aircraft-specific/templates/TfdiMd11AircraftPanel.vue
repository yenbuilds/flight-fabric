<script setup>
import { computed } from 'vue';

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

const unavailableFields = computed(() => new Set(props.unavailable));

const engines = Object.freeze([
  { number: 1, station: 'LEFT WING', n1Id: 'systems.engine1N1', runningId: 'systems.engine1Running' },
  { number: 2, station: 'TAIL', n1Id: 'systems.engine2N1', runningId: 'systems.engine2Running' },
  { number: 3, station: 'RIGHT WING', n1Id: 'systems.engine3N1', runningId: 'systems.engine3Running' },
]);

const vSpeeds = Object.freeze([
  { id: 'performance.v1', label: 'V1' },
  { id: 'performance.vr', label: 'VR' },
  { id: 'performance.v2', label: 'V2' },
  { id: 'performance.vsr', label: 'VSR' },
  { id: 'performance.vfr', label: 'VFR' },
]);

const lights = Object.freeze([
  { id: 'lights.strobe', label: 'STROBE' },
  { id: 'lights.beacon', label: 'BEACON' },
  { id: 'lights.nav', label: 'NAV' },
  { id: 'lights.logo', label: 'LOGO' },
  { id: 'lights.landing', label: 'LANDING' },
  { id: 'lights.taxi', label: 'NOSE' },
  { id: 'lights.runwayTurnoff', label: 'TURN OFF' },
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

function afsNumber(id) {
  const current = numberValue(id);
  if (current === null) return null;
  if ((id === 'afs.speedValue' || id === 'afs.headingValue') && current === -999) return null;
  if (id === 'afs.verticalValue' && current === -9999) return null;
  return current;
}

function integerText(id, fallback = '--') {
  const current = numberValue(id);
  return current === null ? fallback : Math.round(current).toLocaleString('en-US');
}

function decimalText(id, precision = 1, fallback = '--') {
  const current = numberValue(id);
  return current === null ? fallback : current.toFixed(precision);
}

function speedText() {
  const current = afsNumber('afs.speedValue');
  if (current === null) return '---';
  if (value('afs.speedMode') === 'mach') {
    return current.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  }
  return String(Math.round(current));
}

function speedUnit() {
  if (value('afs.speedMode') === 'mach') return 'MACH';
  if (value('afs.speedMode') === 'ias') return 'KTS';
  return '';
}

function headingText() {
  const current = afsNumber('afs.headingValue');
  return current === null ? '---' : String(Math.round(current)).padStart(3, '0');
}

function headingLabel() {
  if (value('afs.headingMode') === 'track') return 'TRK';
  if (value('afs.headingMode') === 'heading') return 'HDG';
  return 'HDG/TRK';
}

function altitudeText() {
  const current = afsNumber('afs.altitudeValue');
  return current === null ? '-----' : Math.round(current).toLocaleString('en-US');
}

function altitudeUnit() {
  if (value('afs.altitudeUnit') === 'metres') return 'm';
  if (value('afs.altitudeUnit') === 'feet') return 'ft';
  return '';
}

function verticalText() {
  const current = afsNumber('afs.verticalValue');
  if (current === null) return '----';
  const rendered = value('afs.verticalMode') === 'flight-path-angle'
    ? current.toFixed(1)
    : String(Math.round(current));
  return current > 0 ? `+${rendered}` : rendered;
}

function verticalUnit() {
  if (value('afs.verticalMode') === 'flight-path-angle') return 'FPA';
  if (value('afs.verticalMode') === 'vertical-speed') return 'FPM';
  return '';
}

function apStateText() {
  const labels = {
    off: 'OFF',
    ap1: 'AP 1',
    ap2: 'AP 2',
    dual: 'AP 1+2',
  };
  const current = value('afs.apState');
  return typeof current === 'string' && labels[current] ? labels[current] : '--';
}

function enumText(id) {
  const current = value(id);
  return typeof current === 'string' ? current.replaceAll('-', ' ').toUpperCase() : '--';
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

function apuClass() {
  const current = value('systems.apuState');
  if (current === 'running') return 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300';
  if (current === 'starting' || current === 'stopping') return 'border-amber-500/50 bg-amber-500/15 text-amber-300';
  return 'border-surface-200 bg-surface-50 text-gray-500';
}

function tonnesText(id) {
  const pounds = numberValue(id);
  return pounds === null ? '--' : (pounds * 0.00045359237).toFixed(1);
}
</script>

<template>
  <div
    class="p-3 sm:p-4 space-y-5"
    data-aircraft-template="tfdi-md-11"
    data-tfdi-md11-scope="monitoring-only"
  >
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 class="text-base font-semibold text-gray-100">TFDi Design MD-11</h3>
        <p class="text-xs text-gray-500">Passenger/freighter, GE/PW tri-jet monitoring for MSFS 2020 and 2024.</p>
      </div>
      <div class="flex flex-wrap justify-end gap-1.5">
        <span class="rounded border border-surface-300 px-2 py-1 text-[9px] uppercase tracking-widest text-gray-400">{{ props.sourceStatus }}</span>
        <span class="rounded border border-cyan-500/35 bg-cyan-500/10 px-2 py-1 text-[9px] uppercase tracking-widest text-cyan-300">TFDi integration LVARs</span>
        <span class="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[9px] uppercase tracking-widest text-amber-300">Monitoring only</span>
      </div>
    </div>

    <section>
      <div class="dashboard-section-kicker">Automatic Flight System</div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3" data-tfdi-afs-field="afs.speedValue">
          <div class="text-[9px] uppercase tracking-widest text-gray-500">SPD</div>
          <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ speedText() }} <span class="text-xs text-gray-500">{{ speedUnit() }}</span></div>
        </div>
        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3" data-tfdi-afs-field="afs.headingValue">
          <div class="text-[9px] uppercase tracking-widest text-gray-500">{{ headingLabel() }}</div>
          <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ headingText() }}&deg;</div>
        </div>
        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3" data-tfdi-afs-field="afs.altitudeValue">
          <div class="text-[9px] uppercase tracking-widest text-gray-500">ALTITUDE</div>
          <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ altitudeText() }} <span class="text-xs text-gray-500">{{ altitudeUnit() }}</span></div>
        </div>
        <div class="rounded-lg border border-surface-200 bg-surface-50 p-3" data-tfdi-afs-field="afs.verticalValue">
          <div class="text-[9px] uppercase tracking-widest text-gray-500">VS / FPA</div>
          <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ verticalText() }} <span class="text-xs text-gray-500">{{ verticalUnit() }}</span></div>
        </div>
      </div>
      <div class="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2 text-[10px] font-semibold" data-tfdi-ap-state>
          AP CHANNEL <span class="float-right">{{ apStateText() }}</span>
        </div>
        <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="indicatorClass('afs.atsClamped')">
          ATS CLAMP <span class="float-right">{{ booleanText('afs.atsClamped', 'CLAMPED', 'OPEN') }}</span>
        </div>
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2 text-[10px] font-semibold">
          HDG/TRK <span class="float-right">{{ enumText('afs.headingMode') }}</span>
        </div>
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2 text-[10px] font-semibold">
          VS/FPA <span class="float-right">{{ enumText('afs.verticalMode') }}</span>
        </div>
      </div>
      <p class="mt-2 text-[10px] leading-relaxed text-gray-500">
        Dashes indicate that no target is set.
      </p>
    </section>

    <section>
      <div class="dashboard-section-kicker">Takeoff &amp; Retraction Speeds</div>
      <div class="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <div
          v-for="item in vSpeeds"
          :key="item.id"
          class="rounded-lg border border-surface-200 bg-surface-50 p-3"
          :data-tfdi-vspeed="item.id"
        >
          <div class="text-[9px] uppercase tracking-widest text-gray-500">{{ item.label }}</div>
          <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ integerText(item.id) }} <span class="text-xs text-gray-500">kt</span></div>
        </div>
      </div>
    </section>

    <section>
      <div class="dashboard-section-kicker">Three-Engine Deck</div>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div
          v-for="engine in engines"
          :key="engine.number"
          class="rounded-lg border border-surface-200 bg-surface-50 p-3"
          :data-tfdi-engine="engine.number"
        >
          <div class="flex items-start justify-between gap-2">
            <div>
              <div class="text-[9px] uppercase tracking-widest text-gray-500">ENGINE {{ engine.number }}</div>
              <div class="mt-0.5 text-[10px] font-semibold tracking-wide text-gray-300">{{ engine.station }}</div>
            </div>
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
      <p class="mt-2 text-[10px] leading-relaxed text-gray-500">N1 is a standard simulator spool indication; the MD-11's primary thrust reference remains EPR.</p>
    </section>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <section>
        <div class="dashboard-section-kicker">Dial-a-Flap &amp; Gear</div>
        <div class="grid grid-cols-2 gap-2">
          <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
            <div class="text-[9px] uppercase tracking-widest text-gray-500">FLAP HANDLE</div>
            <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ integerText('controls.flapsPercent') }}<span class="text-xs text-gray-500">%</span></div>
          </div>
          <div class="rounded-lg border border-surface-200 bg-surface-50 p-3">
            <div class="text-[9px] uppercase tracking-widest text-gray-500">LEFT FLAP ANGLE</div>
            <div class="mt-1 font-mono text-lg font-semibold text-gray-100">{{ decimalText('controls.flapAngleDeg') }}<span class="text-xs text-gray-500">&deg;</span></div>
          </div>
        </div>
        <div class="mt-2 grid grid-cols-2 sm:grid-cols-5 gap-2">
          <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="indicatorClass('controls.gearHandleDown')">HANDLE <span class="float-right">{{ booleanText('controls.gearHandleDown', 'DOWN', 'UP') }}</span></div>
          <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="gearClass('controls.gearLeftPct')">LEFT <span class="float-right">{{ integerText('controls.gearLeftPct') }}%</span></div>
          <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="gearClass('controls.gearNosePct')">NOSE <span class="float-right">{{ integerText('controls.gearNosePct') }}%</span></div>
          <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="gearClass('controls.gearRightPct')">RIGHT <span class="float-right">{{ integerText('controls.gearRightPct') }}%</span></div>
          <div class="rounded border px-2.5 py-2 text-[10px] font-semibold" :class="indicatorClass('controls.parkingBrake', true)">PARK <span class="float-right">{{ booleanText('controls.parkingBrake') }}</span></div>
        </div>
        <p class="mt-2 text-[10px] leading-relaxed text-gray-500">Centre gear status is unavailable.</p>
      </section>

      <section>
        <div class="dashboard-section-kicker">Exterior Lights</div>
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <div
            v-for="light in lights"
            :key="light.id"
            class="rounded border px-2.5 py-2 text-[10px] font-semibold"
            :class="indicatorClass(light.id)"
            :data-tfdi-light="light.id"
          >
            {{ light.label }} <span class="float-right opacity-70">{{ booleanText(light.id) }}</span>
          </div>
        </div>
        <p class="mt-2 text-[10px] leading-relaxed text-gray-500">Exterior lights are read-only. Unavailable values are shown as --.</p>
      </section>
    </div>

    <section>
      <div class="dashboard-section-kicker">APU, Fuel, Weight &amp; Pressurization</div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div class="rounded-lg border p-3" :class="apuClass()" data-tfdi-apu-state>
          <div class="text-[9px] uppercase tracking-widest opacity-70">APU</div>
          <div class="mt-1 text-sm font-semibold">{{ enumText('systems.apuState') }}</div>
          <div class="mt-1 font-mono text-[10px] opacity-80">N1 {{ decimalText('systems.apuN1') }} / N2 {{ decimalText('systems.apuN2') }}</div>
        </div>
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
      </div>
      <div class="mt-2 grid grid-cols-2 sm:grid-cols-5 gap-2 text-[10px] text-gray-300">
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2">CAB ALT <span class="float-right font-semibold">{{ integerText('systems.cabinAltitudeFt') }} ft</span></div>
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2">CAB V/S <span class="float-right font-semibold">{{ integerText('systems.cabinVerticalSpeedFpm') }} fpm</span></div>
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2">DELTA P <span class="float-right font-semibold">{{ decimalText('systems.cabinDeltaPressurePsi', 2) }} psi</span></div>
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2">OAT <span class="float-right font-semibold">{{ decimalText('systems.outsideAirTemperatureC') }}&deg;C</span></div>
        <div class="rounded border border-surface-200 bg-surface-50 px-2.5 py-2">MACH <span class="float-right font-semibold">{{ decimalText('systems.mach', 3) }}</span></div>
      </div>
    </section>

  </div>
</template>
