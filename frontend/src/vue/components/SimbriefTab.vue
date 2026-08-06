<script setup>
import { computed } from 'vue';
import AppTooltip from './AppTooltip.vue';
import { useSimbriefStore } from '../stores/simbrief.js';
import { buildRunwayAnalysisSections } from '../simbrief-runway-analysis.js';

const simbrief = useSimbriefStore();
const runwayAnalysisSections = computed(() => buildRunwayAnalysisSections(simbrief.plan?.tlr));

function onUsernameKeydown(event) {
  if (event.key === 'Enter') {
    simbrief.fetchOfp();
  }
}

function formatEpoch(value) {
  if (!value) return '--';
  const date = new Date(Number(value) * 1000);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString([], {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
}

function formatDuration(value) {
  return simbrief.fmtEte(Number(value));
}

function formatWeight(value) {
  return simbrief.fmtFuel(Number(value), simbrief.plan?.weightUnit || 'lbs');
}

function formatNumber(value, suffix = '') {
  return value === null || value === undefined || value === ''
    ? '--'
    : `${Number(value).toLocaleString()}${suffix}`;
}

function hasValues(object) {
  return object && Object.values(object).some((value) => value !== null && value !== undefined && value !== '');
}
</script>

<template>
  <div class="simbrief-shell page-stack">
    <div class="page-intro">
      <h2 class="text-sm font-semibold tracking-wide mb-1">SimBrief</h2>
      <p class="text-xs text-muted-fg">Fetch your latest SimBrief Operational Flight Plan. The active OFP is broadcast to all connected strip overlays and stored locally for the session.</p>
    </div>

    <div class="simbrief-card ff-card overflow-hidden">
      <div class="simbrief-card-section simbrief-card-section--header px-4 py-3">
        <div class="simbrief-card-head">
          <div class="simbrief-kicker">SimBrief</div>
          <div class="text-xs text-muted-fg">Enter your SimBrief username or numeric pilot ID, then fetch your latest OFP.</div>
        </div>
      </div>
      <div class="px-4 py-4 space-y-3">
        <div class="simbrief-fetch-row">
          <input
            id="sb-username-input"
            v-model="simbrief.username"
            type="text"
            maxlength="40"
            autocomplete="off"
            spellcheck="false"
            placeholder="SimBrief username or pilot ID"
            class="simbrief-input"
            @keydown="onUsernameKeydown"
          />
          <button
            id="sb-fetch-btn"
            type="button"
            class="simbrief-button simbrief-button--primary whitespace-nowrap disabled:opacity-60 disabled:cursor-not-allowed"
            :disabled="simbrief.fetchInProgress"
            @click="simbrief.fetchOfp"
          >
            {{ simbrief.fetchInProgress ? 'Fetching...' : 'Fetch Latest OFP' }}
          </button>
          <AppTooltip content="Clear active flight plan">
            <button
              id="sb-clear-btn"
              type="button"
              class="simbrief-button simbrief-button--secondary"
              @click="simbrief.clearOfp"
            >
              Clear
            </button>
          </AppTooltip>
        </div>
        <div
          id="sb-status"
          class="simbrief-status"
          :class="{
            hidden: !simbrief.status,
            'simbrief-status--danger': simbrief.statusTone === 'danger',
          }"
        >
          {{ simbrief.status }}
        </div>
        <div id="sb-error" class="simbrief-error" :class="{ hidden: !simbrief.error }">{{ simbrief.error }}</div>
      </div>
    </div>

    <div
      id="sb-result-panel"
      class="simbrief-card ff-card overflow-hidden"
      :class="{ hidden: !simbrief.plan }"
    >
      <div class="simbrief-card-section simbrief-card-section--header px-4 py-3 flex items-center justify-between gap-3">
        <div class="simbrief-kicker">Active OFP</div>
        <div id="sb-fetched-at" class="text-xs text-muted-fg">{{ simbrief.fetchedAtLabel }}</div>
      </div>

      <div class="simbrief-card-section px-4 py-4">
        <div class="simbrief-route-hero">
          <div class="simbrief-route-title">
            <span id="sb-origin" class="simbrief-route-code">{{ simbrief.displayValue(simbrief.plan?.origin) }}</span>
            <svg class="w-4 h-4 text-muted-fg shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8l4 4m0 0l-4 4m4-4H3"/></svg>
            <span id="sb-dest" class="simbrief-route-code">{{ simbrief.displayValue(simbrief.plan?.destination) }}</span>
          </div>
          <div class="simbrief-route-meta text-muted-fg">
            <span>ALT: <span id="sb-alt" class="simbrief-inline-value">{{ simbrief.alternateLabel }}</span></span>
            <span v-if="simbrief.plan?.departureRunway">DEP RWY: <span id="sb-departure-runway" class="simbrief-inline-value">{{ simbrief.plan.departureRunway }}</span></span>
            <span v-if="simbrief.plan?.arrivalRunway">ARR RWY: <span id="sb-arrival-runway" class="simbrief-inline-value">{{ simbrief.plan.arrivalRunway }}</span></span>
            <span id="sb-origin-name">{{ simbrief.displayValue(simbrief.plan?.originName) }}</span>
            <span id="sb-dest-name">{{ simbrief.displayValue(simbrief.plan?.destinationName) }}</span>
          </div>
        </div>
      </div>

      <div class="simbrief-kpi-grid">
        <div class="simbrief-kpi-cell">
          <div class="simbrief-metric-label">Callsign</div>
          <div id="sb-callsign" class="simbrief-metric-value">{{ simbrief.displayValue(simbrief.plan?.callsign) }}</div>
          <div id="sb-flight-number" class="text-xs text-muted-fg mt-0.5">{{ simbrief.displayValue(simbrief.plan?.flightNumber) }}</div>
        </div>
        <div class="simbrief-kpi-cell">
          <div class="simbrief-metric-label">Aircraft</div>
          <div id="sb-aircraft" class="simbrief-metric-value">{{ simbrief.displayValue(simbrief.plan?.aircraft) }}</div>
          <div id="sb-aircraft-name" class="text-xs text-muted-fg mt-0.5">{{ simbrief.displayValue(simbrief.plan?.aircraftName) }}</div>
        </div>
        <div class="simbrief-kpi-cell">
          <div class="simbrief-metric-label">Cruise</div>
          <div id="sb-cruise" class="simbrief-metric-value">{{ simbrief.cruiseLabel }}</div>
        </div>
        <div class="simbrief-kpi-cell">
          <div class="simbrief-metric-label">ETE</div>
          <div id="sb-ete" class="simbrief-metric-value">{{ simbrief.eteLabel }}</div>
        </div>
        <div class="simbrief-kpi-cell">
          <div class="simbrief-metric-label">Fuel (ramp)</div>
          <div id="sb-fuel" class="simbrief-metric-value">{{ simbrief.fuelLabel }}</div>
        </div>
      </div>

      <div class="simbrief-kpi-grid simbrief-kpi-grid--secondary">
        <div class="simbrief-kpi-cell">
          <div class="simbrief-metric-label">Cost index</div>
          <div id="sb-cost-index" class="simbrief-metric-value">{{ simbrief.displayValue(simbrief.plan?.costIndex) }}</div>
        </div>
        <div class="simbrief-kpi-cell">
          <div class="simbrief-metric-label">Arrival</div>
          <div id="sb-arrival-time" class="simbrief-metric-value">{{ formatEpoch(simbrief.plan?.estimatedIn || simbrief.plan?.scheduledIn) }}</div>
        </div>
        <div class="simbrief-kpi-cell">
          <div class="simbrief-metric-label">Trip fuel</div>
          <div id="sb-trip-fuel" class="simbrief-metric-value">{{ formatWeight(simbrief.plan?.fuel?.trip) }}</div>
        </div>
        <div class="simbrief-kpi-cell">
          <div class="simbrief-metric-label">Landing fuel</div>
          <div id="sb-landing-fuel" class="simbrief-metric-value">{{ formatWeight(simbrief.plan?.fuel?.landing) }}</div>
        </div>
        <div class="simbrief-kpi-cell">
          <div class="simbrief-metric-label">Payload</div>
          <div id="sb-payload" class="simbrief-metric-value">{{ formatWeight(simbrief.plan?.weights?.payload) }}</div>
        </div>
      </div>

      <div class="simbrief-route-block">
        <div class="flex items-center justify-between gap-3">
          <div class="simbrief-metric-label">Route</div>
          <button
            id="sb-copy-route-btn"
            type="button"
            class="simbrief-copy-button"
            @click="simbrief.copyRoute"
          >
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
            <span id="sb-copy-route-label">{{ simbrief.copyLabel }}</span>
          </button>
        </div>
        <div id="sb-route" class="simbrief-route-value">{{ simbrief.displayValue(simbrief.plan?.route) }}</div>
      </div>

      <div class="simbrief-details-stack">
        <details v-if="hasValues(simbrief.plan?.weather)" class="simbrief-details">
          <summary>
            <span>Planning weather</span>
            <span class="simbrief-details-hint">OFP snapshot · not live</span>
          </summary>
          <div class="simbrief-details-body">
            <div class="simbrief-weather-note">
              Weather captured when this OFP was generated<span v-if="simbrief.plan?.generatedAt"> on {{ formatEpoch(simbrief.plan.generatedAt) }}</span>. Refreshing the OFP does not make this live weather.
            </div>
            <div v-for="item in [
              ['Origin METAR', simbrief.plan?.weather?.originMetar],
              ['Origin TAF', simbrief.plan?.weather?.originTaf],
              ['Destination METAR', simbrief.plan?.weather?.destinationMetar],
              ['Destination TAF', simbrief.plan?.weather?.destinationTaf],
              ['Alternate METAR', simbrief.plan?.weather?.alternateMetar],
              ['Alternate TAF', simbrief.plan?.weather?.alternateTaf],
              ['ETOPS METAR', simbrief.plan?.weather?.etopsMetar],
              ['ETOPS TAF', simbrief.plan?.weather?.etopsTaf],
            ]" v-show="item[1]" :key="item[0]" class="simbrief-report-row">
              <div class="simbrief-metric-label">{{ item[0] }}</div>
              <div class="simbrief-report-text">{{ item[1] }}</div>
            </div>
          </div>
        </details>

        <details v-if="hasValues(simbrief.plan?.fuel) || hasValues(simbrief.plan?.weights)" class="simbrief-details">
          <summary><span>Fuel & weights</span><span class="simbrief-details-hint">{{ simbrief.plan?.weightUnit || 'lbs' }}</span></summary>
          <div class="simbrief-details-body simbrief-data-columns">
            <section>
              <div class="simbrief-detail-heading">Fuel</div>
              <dl class="simbrief-data-list">
                <template v-for="item in [['Taxi', 'taxi'], ['Trip', 'trip'], ['Contingency', 'contingency'], ['Alternate', 'alternate'], ['Final reserve', 'reserve'], ['Extra', 'extra'], ['Takeoff', 'takeoff'], ['Landing', 'landing']]" :key="item[1]">
                  <div v-if="simbrief.plan?.fuel?.[item[1]] != null"><dt>{{ item[0] }}</dt><dd>{{ formatWeight(simbrief.plan.fuel[item[1]]) }}</dd></div>
                </template>
                <div v-if="simbrief.plan?.enduranceSeconds"><dt>Endurance</dt><dd>{{ formatDuration(simbrief.plan.enduranceSeconds) }}</dd></div>
              </dl>
            </section>
            <section>
              <div class="simbrief-detail-heading">Weights & load</div>
              <dl class="simbrief-data-list">
                <div v-if="simbrief.plan?.weights?.passengers != null"><dt>Passengers</dt><dd>{{ formatNumber(simbrief.plan.weights.passengers) }}</dd></div>
                <template v-for="item in [['Cargo', 'cargo'], ['Payload', 'payload'], ['Zero fuel', 'zeroFuel'], ['Ramp', 'ramp'], ['Takeoff', 'takeoff'], ['Landing', 'landing'], ['Max takeoff', 'maxTakeoff'], ['Max landing', 'maxLanding']]" :key="item[1]">
                  <div v-if="simbrief.plan?.weights?.[item[1]] != null"><dt>{{ item[0] }}</dt><dd>{{ formatWeight(simbrief.plan.weights[item[1]]) }}</dd></div>
                </template>
              </dl>
            </section>
          </div>
        </details>

        <details class="simbrief-details">
          <summary><span>Times & performance</span><span class="simbrief-details-hint">Schedule and planning data</span></summary>
          <div class="simbrief-details-body simbrief-data-columns">
            <section>
              <div class="simbrief-detail-heading">Times</div>
              <dl class="simbrief-data-list">
                <div v-for="item in [['Scheduled out', 'scheduledOut'], ['Scheduled off', 'scheduledOff'], ['Scheduled on', 'scheduledOn'], ['Scheduled in', 'scheduledIn'], ['Estimated out', 'estimatedOut'], ['Estimated off', 'estimatedOff'], ['Estimated on', 'estimatedOn'], ['Estimated in', 'estimatedIn']]" :key="item[1]" v-show="simbrief.plan?.[item[1]]"><dt>{{ item[0] }}</dt><dd>{{ formatEpoch(simbrief.plan?.[item[1]]) }}</dd></div>
                <div v-if="simbrief.plan?.blockSeconds"><dt>Block time</dt><dd>{{ formatDuration(simbrief.plan.blockSeconds) }}</dd></div>
                <div v-if="simbrief.plan?.taxiOutSeconds"><dt>Taxi out</dt><dd>{{ formatDuration(simbrief.plan.taxiOutSeconds) }}</dd></div>
                <div v-if="simbrief.plan?.taxiInSeconds"><dt>Taxi in</dt><dd>{{ formatDuration(simbrief.plan.taxiInSeconds) }}</dd></div>
              </dl>
            </section>
            <section>
              <div class="simbrief-detail-heading">Flight planning</div>
              <dl class="simbrief-data-list">
                <div><dt>Cost index</dt><dd>{{ simbrief.displayValue(simbrief.plan?.costIndex) }}</dd></div>
                <div><dt>AIRAC</dt><dd>{{ simbrief.displayValue(simbrief.plan?.airac) }}</dd></div>
                <div><dt>Registration</dt><dd>{{ simbrief.displayValue(simbrief.plan?.registration) }}</dd></div>
                <div><dt>Route distance</dt><dd>{{ formatNumber(simbrief.plan?.performance?.routeDistance, ' nm') }}</dd></div>
                <div><dt>Air distance</dt><dd>{{ formatNumber(simbrief.plan?.performance?.airDistance, ' nm') }}</dd></div>
                <div><dt>Great-circle distance</dt><dd>{{ formatNumber(simbrief.plan?.performance?.greatCircleDistance, ' nm') }}</dd></div>
                <div><dt>Cruise TAS</dt><dd>{{ formatNumber(simbrief.plan?.performance?.cruiseTas, ' kt') }}</dd></div>
                <div><dt>Average wind</dt><dd>{{ formatNumber(simbrief.plan?.performance?.averageWindDirection, '°') }} / {{ formatNumber(simbrief.plan?.performance?.averageWindSpeed, ' kt') }}</dd></div>
                <div><dt>Wind component</dt><dd>{{ formatNumber(simbrief.plan?.performance?.averageWindComponent, ' kt') }}</dd></div>
                <div v-if="simbrief.plan?.performance?.stepClimbs"><dt>Step climbs</dt><dd>{{ simbrief.plan.performance.stepClimbs }}</dd></div>
              </dl>
            </section>
          </div>
        </details>

        <details v-if="simbrief.plan?.navlog?.length" class="simbrief-details">
          <summary><span>Navlog</span><span class="simbrief-details-hint">{{ simbrief.plan.navlog.length }} waypoints</span></summary>
          <div class="simbrief-details-body simbrief-table-wrap">
            <table class="simbrief-navlog-table">
              <thead><tr><th>Fix</th><th>Type</th><th>Altitude</th><th>Wind</th><th>OAT</th><th>Leg</th><th>Time</th><th>Fuel</th></tr></thead>
              <tbody><tr v-for="(fix, index) in simbrief.plan.navlog" :key="`${fix.ident}-${index}`">
                <td>{{ fix.ident }}</td><td>{{ simbrief.displayValue(fix.type) }}</td><td>{{ formatNumber(fix.altitude, ' ft') }}</td>
                <td>{{ formatNumber(fix.windDirection, '°') }} / {{ formatNumber(fix.windSpeed, ' kt') }}</td><td>{{ formatNumber(fix.temperature, '°C') }}</td>
                <td>{{ formatNumber(fix.distance, ' nm') }}</td><td>{{ formatDuration(fix.legTime) }}</td><td>{{ formatWeight(fix.fuelRemaining) }}</td>
              </tr></tbody>
            </table>
          </div>
        </details>

        <details v-if="runwayAnalysisSections.length" class="simbrief-details">
          <summary><span>Runway analysis</span><span class="simbrief-details-hint">Planned runways only</span></summary>
          <div class="simbrief-details-body simbrief-data-columns">
            <section v-for="section in runwayAnalysisSections" :key="section.key">
              <div class="simbrief-detail-heading simbrief-runway-heading">
                <span>{{ section.label }}</span>
                <span v-if="section.location" class="simbrief-runway-location">{{ section.location }}</span>
              </div>
              <dl class="simbrief-data-list">
                <div v-for="row in section.rows" :key="row.key"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></div>
              </dl>
            </section>
          </div>
        </details>

        <details v-if="simbrief.plan?.icaoFlightPlan" class="simbrief-details">
          <summary><span>ICAO flight plan</span><span class="simbrief-details-hint">Filed-format text</span></summary>
          <div class="simbrief-details-body"><pre id="sb-icao-flight-plan" class="simbrief-icao-text">{{ simbrief.plan.icaoFlightPlan }}</pre></div>
        </details>
      </div>
    </div>
  </div>
</template>

<style scoped>
.simbrief-shell {
  width: 100%;
  max-width: none;
  margin-inline: auto;
}

.simbrief-card-section {
  border-bottom: 1px solid rgb(var(--border) / 0.72);
}

.simbrief-card-section--header {
  background: linear-gradient(180deg, rgb(var(--panel-subtle) / 0.88) 0%, rgb(var(--panel) / 0.68) 100%);
}

.simbrief-card-head {
  display: grid;
  gap: 0.25rem;
}

.simbrief-fetch-row {
  display: grid;
  grid-template-columns: minmax(14rem, 0.42fr) auto auto;
  gap: 0.55rem;
  align-items: center;
}

.simbrief-kicker,
.simbrief-metric-label,
.simbrief-copy-button {
  font-family: var(--ff-font-mono);
  text-transform: uppercase;
}

.simbrief-kicker,
.simbrief-metric-label {
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.18em;
}

.simbrief-kicker {
  color: rgb(var(--primary));
}

.simbrief-input {
  flex: 1 1 auto;
  min-width: 0;
  border: 1px solid rgb(var(--border) / 0.88);
  border-radius: 8px;
  background: rgb(var(--panel) / 0.92);
  color: rgb(var(--foreground));
  padding: 0.66rem 0.78rem;
  font-size: 0.84rem;
  font-family: var(--ff-font-mono);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.045);
  transition:
    border-color var(--ff-motion-fast) var(--ff-motion-ease),
    box-shadow var(--ff-motion-fast) var(--ff-motion-ease),
    background var(--ff-motion-fast) var(--ff-motion-ease);
}

.simbrief-input::placeholder {
  color: rgb(var(--muted-foreground));
}

.simbrief-input:focus {
  outline: none;
  border-color: rgb(var(--primary) / 0.4);
  box-shadow: 0 0 0 4px rgb(var(--primary) / 0.14), 0 14px 28px rgba(15, 23, 42, 0.08);
}

.simbrief-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 2.5rem;
  border-radius: 8px;
  padding: 0.62rem 0.85rem;
  border: 1px solid transparent;
  font-size: 0.78rem;
  font-weight: 760;
  transition:
    background var(--ff-motion-fast) var(--ff-motion-ease),
    color var(--ff-motion-fast) var(--ff-motion-ease),
    border-color var(--ff-motion-fast) var(--ff-motion-ease),
    box-shadow var(--ff-motion-fast) var(--ff-motion-ease);
}

.simbrief-button--primary {
  background: rgb(var(--primary) / 0.12);
  border-color: rgb(var(--primary) / 0.24);
  color: rgb(var(--primary));
  box-shadow: var(--ff-shadow-soft);
}

.simbrief-button--primary:hover:enabled {
  background: rgb(var(--primary) / 0.18);
  border-color: rgb(var(--primary) / 0.34);
}

.simbrief-button--secondary {
  background: rgb(var(--panel-subtle) / 0.88);
  border-color: rgb(var(--border) / 0.86);
  color: rgb(var(--muted-foreground));
}

.simbrief-button--secondary:hover {
  background: rgb(var(--panel-elevated) / 0.8);
  color: rgb(var(--foreground));
}

.simbrief-status,
.simbrief-error {
  font-size: 0.75rem;
  line-height: 1.4;
}

.simbrief-status {
  color: rgb(var(--muted-foreground));
}

.simbrief-status--danger,
.simbrief-error {
  color: rgb(var(--danger));
}

.simbrief-route-code,
.simbrief-inline-value,
.simbrief-metric-value,
.simbrief-route-value {
  font-family: var(--ff-font-mono);
}

.simbrief-route-code {
  color: rgb(var(--foreground));
  font-size: clamp(1.55rem, 3vw, 2.35rem);
  font-weight: 760;
  letter-spacing: 0.12em;
}

.simbrief-route-hero {
  display: grid;
  gap: 0.55rem;
}

.simbrief-route-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 0.8rem;
}

.simbrief-route-title svg {
  width: 1.15rem;
  height: 1.15rem;
  color: rgb(var(--primary));
}

.simbrief-route-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem 0.85rem;
  color: rgb(var(--muted-foreground));
  font-size: 0.76rem;
  line-height: 1.45;
}

.simbrief-inline-value,
.simbrief-metric-value {
  color: rgb(var(--gray-200));
}

.simbrief-metric-value {
  font-size: 0.9rem;
  font-weight: 760;
}

.simbrief-kpi-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 1px;
  border-bottom: 1px solid rgb(var(--border) / 0.72);
  background: rgb(var(--border) / 0.72);
}

.simbrief-kpi-grid--secondary .simbrief-kpi-cell {
  min-height: 4.4rem;
  background: rgb(var(--panel-subtle) / 0.72);
}

.simbrief-kpi-cell {
  display: grid;
  align-content: start;
  gap: 0.22rem;
  min-width: 0;
  min-height: 5.1rem;
  border: 1px solid rgb(var(--border) / 0.72);
  border-width: 0;
  background: rgb(var(--panel) / 0.9);
  padding: 0.82rem 0.9rem;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
}

.simbrief-route-block {
  display: grid;
  gap: 0.58rem;
  padding: 0.95rem 1rem;
  background: linear-gradient(180deg, rgb(var(--panel-subtle) / 0.48) 0%, rgb(var(--panel) / 0.9) 100%);
}

.simbrief-copy-button {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  color: rgb(var(--muted-foreground));
  font-size: 0.68rem;
  letter-spacing: 0.16em;
  transition: color var(--ff-motion-fast) var(--ff-motion-ease);
}

.simbrief-copy-button:hover {
  color: rgb(var(--primary));
}

.simbrief-route-value {
  color: rgb(var(--gray-300));
  font-size: 0.78rem;
  line-height: 1.7;
  word-break: break-word;
}

.simbrief-details-stack {
  border-top: 1px solid rgb(var(--border) / 0.72);
}

.simbrief-details + .simbrief-details {
  border-top: 1px solid rgb(var(--border) / 0.72);
}

.simbrief-details summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.85rem 1rem;
  color: rgb(var(--gray-200));
  font-family: var(--ff-font-mono);
  font-size: 0.74rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  cursor: pointer;
  list-style-position: inside;
  transition: background var(--ff-motion-fast) var(--ff-motion-ease);
}

.simbrief-details summary:hover,
.simbrief-details[open] summary {
  background: rgb(var(--panel-elevated) / 0.42);
}

.simbrief-details-hint {
  color: rgb(var(--muted-foreground));
  font-family: var(--ff-font-sans);
  font-size: 0.68rem;
  font-weight: 500;
  letter-spacing: normal;
  text-align: right;
  text-transform: none;
}

.simbrief-details-body {
  padding: 0.25rem 1rem 1rem;
}

.simbrief-weather-note {
  margin: 0.35rem 0 0.85rem;
  border-left: 2px solid rgb(var(--primary) / 0.5);
  padding: 0.45rem 0.65rem;
  color: rgb(var(--muted-foreground));
  font-size: 0.72rem;
  line-height: 1.5;
}

.simbrief-report-row + .simbrief-report-row {
  margin-top: 0.85rem;
}

.simbrief-report-text,
.simbrief-icao-text {
  margin-top: 0.35rem;
  color: rgb(var(--gray-300));
  font-family: var(--ff-font-mono);
  font-size: 0.72rem;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.simbrief-data-columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1.25rem;
}

.simbrief-detail-heading {
  margin: 0.45rem 0 0.6rem;
  color: rgb(var(--primary));
  font-family: var(--ff-font-mono);
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.simbrief-runway-heading {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
}

.simbrief-runway-location {
  color: rgb(var(--gray-300));
  letter-spacing: 0.06em;
  text-align: right;
}

.simbrief-data-list > div {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  border-top: 1px solid rgb(var(--border) / 0.45);
  padding: 0.43rem 0;
  font-size: 0.72rem;
}

.simbrief-data-list dt { color: rgb(var(--muted-foreground)); }
.simbrief-data-list dd { color: rgb(var(--gray-200)); font-family: var(--ff-font-mono); text-align: right; }

.simbrief-table-wrap { overflow-x: auto; }
.simbrief-navlog-table { width: 100%; min-width: 52rem; border-collapse: collapse; font-family: var(--ff-font-mono); font-size: 0.68rem; }
.simbrief-navlog-table th { color: rgb(var(--muted-foreground)); font-weight: 600; letter-spacing: 0.08em; text-align: left; text-transform: uppercase; }
.simbrief-navlog-table th, .simbrief-navlog-table td { border-bottom: 1px solid rgb(var(--border) / 0.45); padding: 0.5rem 0.65rem; white-space: nowrap; }
.simbrief-navlog-table td { color: rgb(var(--gray-300)); }
.simbrief-icao-text { margin: 0.45rem 0 0; }

@media (max-width: 980px) {
  .simbrief-fetch-row,
  .simbrief-kpi-grid {
    grid-template-columns: 1fr;
  }

  .simbrief-button {
    width: 100%;
  }
}

@media (max-width: 640px) {
  .simbrief-data-columns {
    grid-template-columns: 1fr;
  }
  .simbrief-route-code {
    font-size: 1.4rem;
  }

  .simbrief-kpi-cell {
    min-height: auto;
  }
}
</style>
