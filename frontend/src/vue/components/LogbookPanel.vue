<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import AppTooltip from './AppTooltip.vue';
import { getAuthorizationScope, sendWs } from '../../../app-shared.js';
import {
  subscribeLandingReceived,
  subscribeWsMessage,
  subscribeWsOpen,
} from '../../app/runtime-signals.js';
import { buildLandingPresentation, gradeHex, gradeSeverity } from '../../landing/scoring.js';
import {
  HIDDEN_STABILITY_METRICS,
  getStabilityContextSummary,
} from '../../landing/stability-context.js';
import { initLogbookRuntime } from '../../logbook/runtime.js';
import { useLogbookStore } from '../stores/logbook.js';
import { useStatusStore } from '../stores/status.js';
import { useTabsStore } from '../stores/tabs.js';
import { useTimelineStore } from '../stores/timeline.js';

const logbook = useLogbookStore();
const status = useStatusStore();
const tabs = useTabsStore();
const timeline = useTimelineStore();
const isDesktopLayout = ref(getInitialDesktopLayout());
const logbookPanelExpanded = ref(false);

const GRADE_COLORS = {
  PERFECT: '#22c55e',
  SMOOTH: '#38bdf8',
  GOOD: '#38bdf8',
  FIRM: '#facc15',
  HARD: '#f97316',
  'VERY HARD': '#ef4444',
  'RUNWAY EXCURSION': '#ef4444',
  OTHER: '#64748b',
  Outstanding: '#22c55e',
  Good: '#22c55e',
  Acceptable: '#facc15',
  Marginal: '#f59e0b',
  'Long Landing': '#f97316',
  Poor: '#f97316',
  Dangerous: '#ef4444',
  'Short Landing': '#ef4444',
};

const GRADE_PILL_BG = {
  PERFECT: 'rgba(34,197,94,0.10)',
  SMOOTH: 'rgba(56,189,248,0.10)',
  GOOD: 'rgba(56,189,248,0.10)',
  FIRM: 'rgba(250,204,21,0.10)',
  HARD: 'rgba(249,115,22,0.12)',
  'VERY HARD': 'rgba(239,68,68,0.12)',
  'RUNWAY EXCURSION': 'rgba(239,68,68,0.12)',
  OTHER: 'rgba(100,116,139,0.12)',
  Outstanding: 'rgba(34,197,94,0.10)',
  Good: 'rgba(34,197,94,0.10)',
  Acceptable: 'rgba(250,204,21,0.10)',
  Marginal: 'rgba(245,158,11,0.12)',
  'Long Landing': 'rgba(249,115,22,0.12)',
  Poor: 'rgba(249,115,22,0.12)',
  Dangerous: 'rgba(239,68,68,0.12)',
  'Short Landing': 'rgba(239,68,68,0.12)',
};

const GRADE_BORDER = {
  PERFECT: '#22c55e',
  SMOOTH: 'transparent',
  GOOD: 'transparent',
  FIRM: '#facc15',
  HARD: '#f97316',
  'VERY HARD': '#ef4444',
  'RUNWAY EXCURSION': '#ef4444',
  OTHER: '#64748b',
  Outstanding: '#22c55e',
  Good: '#22c55e',
  Acceptable: '#facc15',
  Marginal: '#f59e0b',
  'Long Landing': '#f97316',
  Poor: '#f97316',
  Dangerous: '#ef4444',
  'Short Landing': '#ef4444',
};

const gradeKeys = [
  'PERFECT',
  'GOOD',
  'FIRM',
  'HARD',
  'VERY HARD',
  'OTHER',
];

const STABILITY_GATE_FAILURE_LABELS = {
  insufficient_data: 'insufficient stability data',
  no_gate_sample: 'no sample at the stability gate',
  gear_not_down_at_gate: 'gear not down at the gate',
  gear_changed_after_gate: 'gear changed after the gate',
  flaps_not_set_at_gate: 'flaps not set at the gate',
  flaps_changed_after_gate: 'flaps changed after the gate',
  speed_proxy_unstable_after_gate: 'speed unstable after the gate',
  speed_trend_unstable_after_gate: 'speed trend unstable after the gate',
  vs_unstable_after_gate: 'vertical speed unstable after the gate',
  glidepath_proxy_unstable_after_gate: 'path rate unstable after the gate',
  glidepath_too_low_after_gate: 'descent rate steeper than target after the gate',
  thrust_unstable_after_gate: 'throttle movement unstable after the gate',
  pitch_unstable_after_gate: 'pitch unstable after the gate',
  bank_unstable_after_gate: 'bank unstable after the gate',
  lateral_offset_unstable_at_touchdown: 'lateral offset unstable at touchdown',
};

const STABILITY_BREAKDOWN_LABELS = {
  gear_ok: 'Gear',
  flaps_ok: 'Flaps',
  config_ok: 'Configuration',
  speed_ok: 'Speed',
  speed_trend_ok: 'Speed trend',
  vs_ok: 'V/S',
  glidepath_ok: 'Path rate',
  glidepath_below_ok: 'Path rate steep',
  glidepath_above_ok: 'Path rate shallow',
  thrust_ok: 'Throttle movement',
  thrust_not_idle_ok: 'Idle-thrust proxy',
  thrust_stable_ok: 'Throttle movement',
  pitch_ok: 'Pitch',
  bank_ok: 'Bank',
  lateral_offset_ok: 'Lateral offset',
};

const RETIRED_STABILITY_FAILURES = new Set(['spoilers_moved_after_gate']);

let desktopMediaQuery = null;
let cleanupLogbookRuntime = null;

function getInitialDesktopLayout() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(min-width: 640px)').matches;
}

function syncDesktopLayout(event = null) {
  const matches = event?.matches ?? desktopMediaQuery?.matches;
  isDesktopLayout.value = matches !== false;
}

onMounted(() => {
  cleanupLogbookRuntime = initLogbookRuntime({
    logbookStore: logbook,
    timelineStore: timeline,
    tabsStore: tabs,
    statusStore: status,
    getAuthorizationScope,
    sendMessage: (payload) => sendWs(payload),
    subscribeLandingReceivedSignal: subscribeLandingReceived,
    subscribeWsMessageSignal: subscribeWsMessage,
    subscribeWsOpenSignal: subscribeWsOpen,
    windowRef: window,
  });

  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  desktopMediaQuery = window.matchMedia('(min-width: 640px)');
  syncDesktopLayout(desktopMediaQuery);
  if (typeof desktopMediaQuery.addEventListener === 'function') {
    desktopMediaQuery.addEventListener('change', syncDesktopLayout);
  } else if (typeof desktopMediaQuery.addListener === 'function') {
    desktopMediaQuery.addListener(syncDesktopLayout);
  }
});

onBeforeUnmount(() => {
  cleanupLogbookRuntime?.();
  cleanupLogbookRuntime = null;

  if (!desktopMediaQuery) return;
  if (typeof desktopMediaQuery.removeEventListener === 'function') {
    desktopMediaQuery.removeEventListener('change', syncDesktopLayout);
  } else if (typeof desktopMediaQuery.removeListener === 'function') {
    desktopMediaQuery.removeListener(syncDesktopLayout);
  }
  desktopMediaQuery = null;
});

const indexedLandingCount = computed(() => {
  const count = Number(logbook.historyIndexStatus?.counts?.landings);
  return Number.isFinite(count) && count > 0 ? count : 0;
});

const knownLandingCount = computed(() => {
  const statsTotal = Number(logbook.stats?.total || 0);
  return Math.max(Number.isFinite(statsTotal) ? statsTotal : 0, indexedLandingCount.value);
});

const indexedDetailsUnavailable = computed(() => (
  logbook.entries.length === 0
  && Number(logbook.stats?.total || 0) === 0
  && indexedLandingCount.value > 0
));

const subtitle = computed(() => {
  const total = knownLandingCount.value;
  return total
    ? `${total} landing${total !== 1 ? 's' : ''} recorded`
    : 'All scored landings across sessions';
});

const hasEntries = computed(() => logbook.entries.length > 0);

function emptyGradeCounts() {
  return gradeKeys.reduce((result, grade) => {
    result[grade] = 0;
    return result;
  }, {});
}

function gradeBucket(grade) {
  if (!grade || typeof grade !== 'string') return null;
  const normalized = grade.trim();
  if (!normalized) return null;
  const upper = normalized.toUpperCase();
  if (upper === 'PERFECT' || upper === 'BUTTER') return 'PERFECT';
  if (upper === 'SMOOTH' || upper === 'GOOD') return 'GOOD';
  if (upper === 'FIRM') return 'FIRM';
  if (upper === 'HARD') return 'HARD';
  if (upper === 'VERY HARD' || upper === 'SEVERE') return 'VERY HARD';
  return 'OTHER';
}

function incrementGradeCount(counts, grade, amount = 1) {
  const bucket = gradeBucket(grade);
  if (!bucket) return;
  counts[bucket] = (counts[bucket] || 0) + amount;
}

const gradeCounts = computed(() => {
  let counts = null;
  const statsGrades = logbook.stats?.grades;
  if (statsGrades && typeof statsGrades === 'object' && Object.keys(statsGrades).length > 0) {
    const statsCounts = emptyGradeCounts();
    for (const [grade, rawCount] of Object.entries(statsGrades)) {
      const count = Number(rawCount || 0);
      if (Number.isFinite(count) && count > 0) incrementGradeCount(statsCounts, grade, count);
    }
    const statsCountTotal = Object.values(statsCounts).reduce((total, count) => total + count, 0);
    if (statsCountTotal >= logbook.entries.length || logbook.entries.length === 0) counts = statsCounts;
  }

  if (!counts) {
    counts = emptyGradeCounts();
    for (const entry of logbook.entries) {
      incrementGradeCount(counts, touchdownGrade(entry));
    }
  }

  const knownTotal = Object.values(counts).reduce((total, count) => total + count, 0);
  const aggregateTotal = Number(logbook.stats?.total || 0);
  if (Number.isFinite(aggregateTotal) && aggregateTotal > knownTotal) {
    counts.OTHER = (counts.OTHER || 0) + (aggregateTotal - knownTotal);
  }
  return counts;
});

const gradeSegments = computed(() => {
  const segments = gradeKeys
    .map((grade) => ({
      grade,
      count: Number(gradeCounts.value[grade] || 0),
      color: gradeColor(grade),
    }))
    .filter((segment) => segment.count > 0);
  const segmentTotal = segments.reduce((total, segment) => total + segment.count, 0);
  if (!segmentTotal) return [];
  return segments.map((segment) => ({
    ...segment,
    width: `${((segment.count / segmentTotal) * 100).toFixed(1)}%`,
  }));
});

const longLandingCount = computed(() => {
  const statsGrades = logbook.stats?.grades;
  if (
    statsGrades
    && typeof statsGrades === 'object'
    && Object.keys(statsGrades).length > 0
    && Number.isFinite(Number(logbook.stats?.longLandingCount))
  ) {
    return Number(logbook.stats.longLandingCount);
  }
  return logbook.entries.reduce((count, entry) => {
    const grade = entry?.touchdownDistanceGrade || '';
    return grade === 'Long Landing' ? count + 1 : count;
  }, 0);
});

const displayedEntryCount = computed(() => logbook.entries.length);

const isEntryListLimited = computed(() => {
  const total = Number(logbook.stats?.total || 0);
  return total > displayedEntryCount.value;
});

const entryLimitText = computed(() => {
  if (!isEntryListLimited.value) return '';
  const total = Number(logbook.stats?.total || 0);
  return `Showing latest ${displayedEntryCount.value} of ${total}`;
});

const butterStreak = computed(() => {
  let streak = 0;
  for (const entry of logbook.entries) {
    if (touchdownGrade(entry) === 'PERFECT') streak += 1;
    else break;
  }
  return streak >= 2 ? `${streak}-touchdown-rate PERFECT streak` : '';
});

const trendGroups = computed(() => {
  const trends = logbook.stats?.trends || {};
  return [
    { key: 'aircraft', label: 'Aircraft', rows: Array.isArray(trends.aircraft) ? trends.aircraft : [] },
    { key: 'airports', label: 'Airports', rows: Array.isArray(trends.airports) ? trends.airports : [] },
    { key: 'runways', label: 'Runways', rows: Array.isArray(trends.runways) ? trends.runways : [] },
  ].filter((group) => group.rows.length > 0);
});

const hasTrendGroups = computed(() => trendGroups.value.length > 0);

const bestEntry = computed(() => {
  if (!hasEntries.value) return null;
  return logbook.entries.reduce((best, entry) => {
    const currentVs = typeof entry?.vsFpm === 'number' ? entry.vsFpm : Infinity;
    const bestVs = typeof best?.vsFpm === 'number' ? best.vsFpm : Infinity;
    return Math.abs(currentVs) < Math.abs(bestVs) ? entry : best;
  }, logbook.entries[0]);
});

const bestInlineText = computed(() => {
  const entry = bestEntry.value;
  if (!entry || typeof entry.vsFpm !== 'number') return '';
  const parts = [entry.icao || '', entry.runway || ''].filter(Boolean);
  return `Softest touchdown rate ${Math.round(entry.vsFpm)} fpm${parts.length ? ` · ${parts.join(' ')}` : ''}`;
});

function requestRefresh() {
  logbook.request();
}

function toggleLogbookPanel() {
  logbookPanelExpanded.value = !logbookPanelExpanded.value;
}

function formatDate(iso) {
  try {
    const date = new Date(iso);
    const month = date.toLocaleString('en', { month: 'short' });
    const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    return `${date.getDate()} ${month}\u2002${time}`;
  } catch {
    return iso || '--';
  }
}

function shortAircraft(name) {
  if (!name) return '--';
  return name
    .replace(/\s*\(.*?\)\s*/g, '')
    .slice(0, 26) || name.slice(0, 26);
}

function num(value, dp) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  return dp != null ? value.toFixed(dp) : String(Math.round(value));
}

function normalizeGateFailures(value) {
  if (Array.isArray(value)) {
    return value
      .map(String)
      .map((failure) => failure.trim())
      .filter((failure) => failure && !RETIRED_STABILITY_FAILURES.has(failure));
  }
  if (typeof value === 'string' && value.trim()) {
    return value
      .split('|')
      .map((failure) => failure.trim())
      .filter((failure) => failure && !RETIRED_STABILITY_FAILURES.has(failure));
  }
  return [];
}

function entryTouchdownDistance(entry) {
  if (!entry) return null;
  const hasTouchdownData = entry.touchdownDistanceFt != null
    || entry.touchdownDistanceGrade
    || entry.touchdownDistanceScore != null
    || entry.touchdownDistanceZone
    || entry.lateralOffsetFt != null
    || entry.bounceCount != null
    || entry.bounceGrade
    || entry.bounceScore != null;
  if (!hasTouchdownData) return null;
  return {
    distanceFt: entry.touchdownDistanceFt,
    grade: entry.touchdownDistanceGrade,
    score: entry.touchdownDistanceScore,
    zone: entry.touchdownDistanceZone,
    lateralOffsetFt: entry.lateralOffsetFt,
    lateralOffsetGrade: entry.lateralOffsetGrade,
    lateralOffsetScore: entry.lateralOffsetScore,
    lateralOffsetSide: entry.lateralOffsetSide,
    bounceCount: entry.bounceCount,
    bounceGrade: entry.bounceGrade,
    bounceScore: entry.bounceScore,
    shortLanding: entry.shortLanding,
    runwayLengthFt: entry.runwayLengthFt ?? entry.runwayPhysicalLengthFt,
    runwayWidthFt: entry.runwayWidthFt,
  };
}

function entryUltimateStability(entry) {
  if (!entry) return null;
  const stabilityScore = entry.stabilityScore ?? entry.ultimateStability?.score ?? null;
  const gateStable = entry.gateStable ?? entry.ultimateStability?.gateStable ?? null;
  const rawGateFailures = entry.stabilityGateFailures ?? entry.ultimateStability?.gateFailures;
  const gateFailures = normalizeGateFailures(rawGateFailures);
  const gateFailuresRecorded = Array.isArray(rawGateFailures) || typeof rawGateFailures === 'string';
  const breakdown = entry.stabilityBreakdown && typeof entry.stabilityBreakdown === 'object'
    ? entry.stabilityBreakdown
    : entry.ultimateStability?.breakdown && typeof entry.ultimateStability.breakdown === 'object'
      ? entry.ultimateStability.breakdown
      : null;
  const scoringContext = entry.stabilityContext && typeof entry.stabilityContext === 'object'
    ? entry.stabilityContext
    : entry.ultimateStability?.scoringContext || null;
  const stabilityVerdict = entry.stabilityVerdict ?? entry.ultimateStability?.verdict ?? null;
  const hasStabilityData = stabilityScore != null
    || gateStable === true
    || gateStable === false
    || Boolean(stabilityVerdict)
    || gateFailures.length > 0
    || Boolean(breakdown)
    || Boolean(scoringContext);
  if (!hasStabilityData) return null;
  return {
    score: stabilityScore,
    gateStable,
    verdict: stabilityVerdict,
    ...(gateFailuresRecorded ? { gateFailures } : {}),
    breakdown,
    scoringContext,
  };
}

function landingPresentation(entry) {
  const touchdownDistance = entryTouchdownDistance(entry);
  const ultimateStability = entryUltimateStability(entry);
  return buildLandingPresentation({
    grade: entry?.grade || null,
    runwayExcursion: entry?.runwayExcursion,
    shortLanding: entry?.shortLanding,
  }, {
    touchdownDistance,
    ultimateStability,
  });
}

function touchdownGrade(entry) {
  const grade = typeof entry?.grade === 'string' ? entry.grade.trim() : '';
  return grade ? grade.toUpperCase() : '--';
}

function touchdownGradeLabel(entry) {
  const grade = touchdownGrade(entry);
  return grade === 'Long Landing' || grade === 'LONG LANDING' ? 'LONG' : String(grade).toUpperCase();
}

function touchdownLabel(entry) {
  const tdz = entryTouchdownDistance(entry);
  if (!tdz) return '--';
  if (tdz.distanceFt != null && Number.isFinite(Number(tdz.distanceFt))) {
    return `${Math.round(Number(tdz.distanceFt))} ft`;
  }
  return tdz.grade || '--';
}

function touchdownSubLabel(entry) {
  const tdz = entryTouchdownDistance(entry);
  const parts = [];
  if (tdz?.grade) parts.push(tdz.grade);
  else if (tdz?.score != null && Number.isFinite(Number(tdz.score))) parts.push(`${Math.round(Number(tdz.score))}/100`);
  if (landingPresentation(entry).verdict.flags.runwayExcursion) parts.push('RUNWAY EXCURSION');
  return parts.join(' · ');
}

function bounceLabel(entry) {
  const presentation = landingPresentation(entry);
  return presentation.bounceKnown ? presentation.bounceText : '--';
}

function touchdownTooltip(entry) {
  const tdz = entryTouchdownDistance(entry);
  const presentation = landingPresentation(entry);
  const parts = [];
  if (tdz?.distanceFt != null && Number.isFinite(Number(tdz.distanceFt))) {
    parts.push(`${Math.round(Number(tdz.distanceFt))} ft from threshold`);
  }
  if (tdz?.grade) parts.push(tdz.grade);
  if (tdz?.score != null && Number.isFinite(Number(tdz.score))) {
    parts.push(`${Math.round(Number(tdz.score))}/100`);
  }
  if (tdz?.lateralOffsetFt != null && Number.isFinite(Number(tdz.lateralOffsetFt))) {
    const side = tdz.lateralOffsetSide || 'center';
    parts.push(`${Math.abs(Math.round(Number(tdz.lateralOffsetFt)))} ft ${side}`);
  }
  if (presentation.verdict.flags.runwayExcursion) parts.push('RUNWAY EXCURSION');
  if (presentation.bounceKnown) {
    parts.push(presentation.bounceCount === 0 ? 'Bounce clean' : `Bounce ${presentation.bounceText}`);
  }
  return parts.length ? `Touchdown: ${parts.join(' · ')}` : '';
}

function touchdownStyle(entry) {
  const presentation = landingPresentation(entry);
  if (presentation.verdict.flags.runwayExcursion) {
    const color = '#ef4444';
    return {
      color,
      background: `${color}1f`,
      border: `1px solid ${color}55`,
    };
  }
  if (!entryTouchdownDistance(entry)) {
    return {
      color: '#94a3b8',
      background: 'rgba(148,163,184,0.08)',
      border: '1px solid rgba(148,163,184,0.35)',
    };
  }
  const verdict = presentation.verdict;
  const color = verdict.touchdown.color;
  return {
    color,
    background: `${color}1f`,
    border: `1px solid ${color}55`,
  };
}

function gateFailureKeys(entry) {
  return normalizeGateFailures(entry?.stabilityGateFailures ?? entry?.ultimateStability?.gateFailures);
}

function stabilityBadge(entry) {
  const presentation = landingPresentation(entry);
  const approachVerdict = presentation.approachVerdict;
  const gateText = `${presentation.stabilityGateLabel} gate`;
  if (approachVerdict === 'STABLE') {
    return {
      tone: 'stable',
      label: 'Stable',
      shortLabel: 'STABLE',
      tooltipLead: `Stable after the ${gateText}`,
    };
  }
  if (approachVerdict === 'MARGINAL') {
    return {
      tone: 'marginal',
      label: 'Marginal',
      shortLabel: 'MARGINAL',
      tooltipLead: `Marginal after the ${gateText}`,
    };
  }
  if (approachVerdict !== 'UNSTABLE') {
    return {
      tone: 'unknown',
      label: approachVerdict === 'NO VERDICT' ? 'No verdict' : '--',
      shortLabel: approachVerdict || '--',
      tooltipLead: approachVerdict === 'NO VERDICT' ? `No verdict after the ${gateText}` : '',
    };
  }

  return {
    tone: 'unstable',
    label: 'Unstable',
    shortLabel: 'UNSTABLE',
    tooltipLead: `Unstable after the ${gateText}`,
  };
}

function stableLabel(entry) {
  return stabilityBadge(entry).label;
}

function stableClass(entry) {
  const tone = stabilityBadge(entry).tone;
  if (tone === 'stable') return 'logbook-mobile-card__stable is-stable';
  if (tone === 'marginal') return 'logbook-mobile-card__stable is-marginal';
  if (tone === 'unstable') return 'logbook-mobile-card__stable is-unstable';
  return 'logbook-mobile-card__stable';
}

function stableDesktopClass(entry) {
  const tone = stabilityBadge(entry).tone;
  if (tone === 'stable') return 'text-[10px] text-green-400 font-medium';
  if (tone === 'marginal' || tone === 'unstable') return 'text-[10px] font-medium px-1 rounded';
  return 'text-gray-600 text-[10px]';
}

function stableDesktopStyle(entry) {
  const tone = stabilityBadge(entry).tone;
  if (tone === 'marginal') return { color: '#f59e0b', background: 'rgba(245,158,11,0.12)' };
  if (tone === 'unstable') return { color: '#ef4444', background: 'rgba(239,68,68,0.12)' };
  return null;
}

function humanizeGateFailure(failure) {
  const key = String(failure || '').trim();
  if (!key) return '';
  return STABILITY_GATE_FAILURE_LABELS[key]
    || key.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function stabilityBreakdownReasons(entry) {
  const breakdown = entryUltimateStability(entry)?.breakdown || null;
  if (!breakdown) return [];
  return Object.entries(breakdown)
    .filter(([key]) => !HIDDEN_STABILITY_METRICS.has(key))
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value < 80)
    .sort((left, right) => Number(left[1]) - Number(right[1]))
    .slice(0, 3)
    .map(([key, value]) => `${STABILITY_BREAKDOWN_LABELS[key] || humanizeGateFailure(key)} ${Math.round(Number(value))}%`);
}

function stabilityCauseText(entry) {
  if (!['marginal', 'unstable'].includes(stabilityBadge(entry).tone)) return '';
  const breakdownReasons = stabilityBreakdownReasons(entry).slice(0, 2);
  if (breakdownReasons.length > 0) return breakdownReasons.join(' · ');
  return gateFailureKeys(entry)
    .map(humanizeGateFailure)
    .filter(Boolean)
    .slice(0, 2)
    .join(' · ');
}

function stableTooltip(entry) {
  if (!entry) return '';
  const badge = stabilityBadge(entry);
  const ultimateStability = entryUltimateStability(entry);
  const profileText = getStabilityContextSummary(
    ultimateStability?.scoringContext,
    entry.aircraftProfileId,
  ).label;
  const scoreText = ultimateStability?.score != null && Number.isFinite(Number(ultimateStability.score))
    ? `Approach score ${Math.round(Number(ultimateStability.score))}%`
    : '';
  if (badge.tone === 'stable' || badge.tone === 'unknown') {
    return [badge.tooltipLead, scoreText, profileText].filter(Boolean).join(' · ');
  }

  const failureLabels = gateFailureKeys(entry)
    .map(humanizeGateFailure)
    .filter(Boolean);
  const breakdownLabels = stabilityBreakdownReasons(entry);
  const reasons = [...new Set([...failureLabels, ...breakdownLabels])];
  return [
    reasons.length ? `${badge.tooltipLead}: ${reasons.join(', ')}` : badge.tooltipLead,
    badge.tone === 'marginal'
      ? `Strict check missed, without a hard or substantial deviation (recorded threshold ${landingPresentation(entry).stabilityPassPct}%)`
      : '',
    scoreText,
    profileText,
  ].filter(Boolean).join(' · ');
}

function gradeColor(grade) {
  const severity = gradeSeverity(grade);
  return GRADE_COLORS[grade] || (severity >= 0 ? gradeHex(severity) : '#9ca3af');
}

function gradePillStyle(grade) {
  const border = GRADE_BORDER[grade] || gradeColor(grade);
  return {
    color: gradeColor(grade),
    background: GRADE_PILL_BG[grade] || 'rgba(255,255,255,0.04)',
    border: `1px solid ${border}40`,
  };
}

function entryGradePillStyle(entry) {
  return gradePillStyle(touchdownGrade(entry));
}

function visibleGradeAccentColor(grade) {
  const border = GRADE_BORDER[grade];
  return border && border !== 'transparent' ? border : gradeColor(grade);
}

function mobileCardVars(grade) {
  return {
    '--logbook-border': visibleGradeAccentColor(grade),
    '--logbook-accent': gradeColor(grade),
  };
}

function entryMobileCardVars(entry) {
  return mobileCardVars(touchdownGrade(entry));
}

function trendLabel(value) {
  if (value === 'improving') return 'improving';
  if (value === 'regressing') return 'regressing';
  if (value === 'stable') return 'stable';
  return '--';
}

function hasTrendVs(value) {
  return value === 'improving' || value === 'regressing' || value === 'stable';
}

function trendTone(value) {
  if (value === 'improving') return 'text-green-400';
  if (value === 'regressing') return 'text-amber-400';
  if (value === 'stable') return 'text-gray-400';
  return 'text-gray-600';
}

function trendStabilityText(row) {
  const finiteRate = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };
  const stable = finiteRate(row?.stableRatePct);
  const marginal = finiteRate(row?.marginalRatePct);
  const acceptable = finiteRate(row?.acceptableRatePct);
  if (stable !== null && marginal !== null) {
    return `${stable}% stable · ${marginal}% marginal`;
  }
  if (acceptable !== null) return `${acceptable}% acceptable`;
  if (stable !== null) return `${stable}% strict stable`;
  return '';
}
</script>

<template>
  <div class="logbook-panel overflow-hidden">
    <div class="p-3 sm:p-4 border-b border-surface-200 flex items-center justify-between gap-3 flex-wrap">
      <div>
        <div class="text-sm font-semibold text-gray-300">Scored Landings</div>
        <div class="text-xs text-gray-500 mt-0.5">{{ subtitle }}</div>
      </div>
      <div class="flex items-center gap-2">
        <AppTooltip :content="logbookPanelExpanded ? 'Collapse scored landings' : 'Expand scored landings'">
          <button
            id="logbook-panel-toggle"
            type="button"
            class="px-2 py-1.5 text-xs font-semibold bg-surface-200 text-gray-300 rounded hover:bg-surface-300 transition-colors"
            :aria-expanded="logbookPanelExpanded ? 'true' : 'false'"
            aria-controls="logbook-panel-body"
            :aria-label="logbookPanelExpanded ? 'Collapse scored landings' : 'Expand scored landings'"
            @click="toggleLogbookPanel"
          >
            {{ logbookPanelExpanded ? 'v' : '>' }}
          </button>
        </AppTooltip>
        <button
          id="logbook-refresh-btn"
          type="button"
          class="px-3 py-1.5 text-xs font-medium bg-surface-200 text-gray-300 rounded hover:bg-surface-300 transition-colors"
          @click="requestRefresh"
        >
          Refresh
        </button>
      </div>
    </div>

    <div id="logbook-panel-body" v-show="logbookPanelExpanded">
    <div class="px-3 sm:px-4 py-3 border-b border-surface-200 grid grid-cols-3 sm:grid-cols-6 gap-2 sm:gap-3 text-center">
      <div>
        <div class="text-[10px] uppercase tracking-widest text-gray-500 mb-0.5">Landings</div>
        <div class="text-lg font-semibold text-gray-200 tabular-nums">{{ knownLandingCount }}</div>
      </div>
      <div>
        <div class="text-[10px] uppercase tracking-widest text-gray-500 mb-0.5">Perfect touchdown rates</div>
        <div class="text-lg font-semibold tabular-nums" style="color:#22c55e">{{ indexedDetailsUnavailable ? '--' : (gradeCounts.PERFECT || 0) }}</div>
      </div>
      <div>
        <div class="text-[10px] uppercase tracking-widest text-gray-500 mb-0.5">Avg touchdown rate</div>
        <div class="text-lg font-semibold text-gray-200 tabular-nums">
          {{ logbook.stats.avgVsFpm != null ? `${logbook.stats.avgVsFpm} fpm` : '--' }}
        </div>
      </div>
      <div>
        <div class="text-[10px] uppercase tracking-widest text-gray-500 mb-0.5">Long TDZ</div>
        <div class="text-lg font-semibold tabular-nums" style="color:#f97316">{{ indexedDetailsUnavailable ? '--' : longLandingCount }}</div>
      </div>
      <div>
        <div class="text-[10px] uppercase tracking-widest text-gray-500 mb-0.5">Airports</div>
        <div class="text-lg font-semibold text-gray-200 tabular-nums">{{ indexedDetailsUnavailable ? '--' : (logbook.stats.airports || 0) }}</div>
      </div>
      <div>
        <div class="text-[10px] uppercase tracking-widest text-gray-500 mb-0.5">Aircraft</div>
        <div class="text-lg font-semibold text-gray-200 tabular-nums">{{ indexedDetailsUnavailable ? '--' : (logbook.stats.aircraft || 0) }}</div>
      </div>
    </div>

    <div v-if="hasEntries" class="px-3 sm:px-4 pt-3 pb-2 border-b border-surface-200">
      <div class="logbook-grade-header">
        <span class="text-[10px] uppercase tracking-widest text-gray-500">Touchdown rate grade breakdown</span>
        <div class="logbook-grade-meta">
          <span v-if="bestInlineText" class="logbook-grade-best">{{ bestInlineText }}</span>
          <span v-if="butterStreak">{{ butterStreak }}</span>
          <span v-if="entryLimitText">{{ entryLimitText }}</span>
        </div>
      </div>
      <div class="flex h-2 rounded-full overflow-hidden">
        <AppTooltip
          v-for="segment in gradeSegments"
          :key="segment.grade"
          :content="`${segment.grade}: ${segment.count}`"
          :anchor-style="{ width: segment.width, minWidth: '2px', height: '100%' }"
          anchor-class="logbook-grade-segment-tooltip"
          anchor-tag="div"
        >
          <div :style="{ width: '100%', height: '100%', background: segment.color }" />
        </AppTooltip>
      </div>
      <div class="logbook-grade-legend">
        <span class="logbook-grade-legend-item"><span class="logbook-grade-legend-count">{{ gradeCounts.PERFECT || 0 }}</span><span style="color:#22c55e">Perfect</span></span>
        <span class="logbook-grade-legend-item"><span class="logbook-grade-legend-count">{{ gradeCounts.GOOD || 0 }}</span><span style="color:#38bdf8">Good</span></span>
        <span class="logbook-grade-legend-item"><span class="logbook-grade-legend-count">{{ gradeCounts.FIRM || 0 }}</span><span style="color:#facc15">Firm</span></span>
        <span class="logbook-grade-legend-item"><span class="logbook-grade-legend-count">{{ gradeCounts.HARD || 0 }}</span><span style="color:#f97316">Hard</span></span>
        <span class="logbook-grade-legend-item"><span class="logbook-grade-legend-count">{{ gradeCounts['VERY HARD'] || 0 }}</span><span style="color:#ef4444">Very Hard</span></span>
        <span v-if="gradeCounts.OTHER" class="logbook-grade-legend-item"><span class="logbook-grade-legend-count">{{ gradeCounts.OTHER }}</span><span style="color:#94a3b8">Other</span></span>
      </div>
    </div>

    <div v-if="hasTrendGroups" id="logbook-trends" class="px-3 sm:px-4 py-3 border-b border-surface-200">
      <div class="text-[10px] uppercase tracking-widest text-gray-500 mb-2">Recent Trends</div>
      <div class="grid gap-3 lg:grid-cols-3">
        <section
          v-for="group in trendGroups"
          :key="group.key"
          class="rounded border border-surface-200/60 bg-surface-50/30 px-3 py-2"
        >
          <div class="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-gray-500">{{ group.label }}</div>
          <div class="space-y-1.5">
            <div
              v-for="row in group.rows.slice(0, 3)"
              :key="row.key"
              class="flex items-center justify-between gap-3 text-xs"
            >
              <div class="min-w-0">
                <AppTooltip :content="row.label" anchor-class="min-w-0" anchor-tag="div">
                  <div class="truncate text-gray-200">{{ row.label }}</div>
                </AppTooltip>
                <div class="text-[10px] text-gray-600">
                  {{ row.count }} landings
                  <span v-if="row.avgVsFpm != null">&middot; avg {{ row.avgVsFpm }} fpm</span>
                  <span v-if="row.avgStabilityScore != null">&middot; avg approach score {{ row.avgStabilityScore }}%</span>
                </div>
              </div>
              <div class="shrink-0 text-right">
                <div v-if="hasTrendVs(row.trendVs)" class="text-[10px]" :class="trendTone(row.trendVs)">TD rate {{ trendLabel(row.trendVs) }}</div>
                <div v-if="trendStabilityText(row)" class="text-[10px] text-gray-600">{{ trendStabilityText(row) }}</div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>

    <div v-if="indexedDetailsUnavailable" class="p-8 text-center text-sm text-gray-500">
      {{ knownLandingCount }} scored landings are indexed. Details are temporarily unavailable while the active flight recording synchronizes.
    </div>

    <div v-else-if="!hasEntries" class="p-8 text-center text-sm text-gray-500">
      No landings recorded yet. Complete a flight with a landing to see your history here.
    </div>

    <div
      v-if="hasEntries"
      id="logbook-stability-verdict-explanation"
      class="border-b border-surface-200 px-3 py-2 text-[10px] leading-snug text-gray-500 sm:px-4"
    >
      Stable requires every applicable strict check to meet its recorded threshold (normally 80%). Marginal means a strict check was missed, but the approach had no hard or substantial deviation. Unstable identifies a hard configuration failure, a score below 80%, or a severe direct-metric miss.
    </div>

    <div v-if="hasEntries && !isDesktopLayout" class="logbook-mobile-list">
      <article
        v-for="entry in logbook.entries"
        :key="entry.id || `${entry.timestamp}-${entry.vsFpm}`"
        class="logbook-mobile-card"
        :style="entryMobileCardVars(entry)"
      >
        <div class="logbook-mobile-card__top">
          <div>
            <div class="logbook-mobile-card__date">{{ formatDate(entry.timestamp) }}</div>
            <div class="logbook-mobile-card__title">{{ shortAircraft(entry.aircraft) }}</div>
            <div class="logbook-mobile-card__meta">
              {{ entry.icao || '--' }}
              <span v-if="entry.runway" style="color:#64748b">{{ entry.runway }}</span>
            </div>
          </div>
          <div>
            <span class="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded" :style="entryGradePillStyle(entry)">
              TD RATE {{ touchdownGradeLabel(entry) }}
            </span>
          </div>
        </div>
        <div class="logbook-mobile-card__stats">
          <div>
            <span class="logbook-mobile-card__stat-label">Touchdown Rate</span>
            <span class="logbook-mobile-card__stat-value logbook-mobile-card__vs">{{ num(entry.vsFpm) }} fpm</span>
          </div>
          <div>
            <span class="logbook-mobile-card__stat-label">TDZ</span>
            <AppTooltip :content="touchdownTooltip(entry)" :disabled="!touchdownTooltip(entry)">
              <span class="inline-flex flex-col">
                <span class="logbook-mobile-card__stat-value" :style="{ color: landingPresentation(entry).verdict.touchdown.color }">{{ touchdownLabel(entry) }}</span>
                <span v-if="touchdownSubLabel(entry)" class="text-[9px] font-normal opacity-75 leading-tight">{{ touchdownSubLabel(entry) }}</span>
              </span>
            </AppTooltip>
          </div>
          <div>
            <span class="logbook-mobile-card__stat-label">Approach</span>
            <AppTooltip :content="stableTooltip(entry)" :disabled="!stableTooltip(entry)">
              <span class="inline-flex max-w-full flex-col">
                <span :class="stableClass(entry)">{{ stableLabel(entry) }}</span>
                <span v-if="stabilityCauseText(entry)" class="mt-0.5 text-[9px] font-normal leading-tight text-gray-500">{{ stabilityCauseText(entry) }}</span>
              </span>
            </AppTooltip>
          </div>
          <div>
            <span class="logbook-mobile-card__stat-label">Bounce</span>
            <span class="logbook-mobile-card__stat-value">{{ bounceLabel(entry) }}</span>
          </div>
        </div>
      </article>
    </div>

    <div v-if="hasEntries && isDesktopLayout" class="logbook-desktop-table overflow-x-auto">
      <table class="w-full text-xs">
        <thead>
          <tr class="text-[10px] uppercase tracking-widest text-gray-500 border-b border-surface-200 bg-surface-50/40">
            <th class="px-3 py-2 text-left font-medium">Date</th>
            <th class="px-3 py-2 text-left font-medium">Aircraft · Airport</th>
            <th class="px-3 py-2 text-right font-medium">Touchdown Rate</th>
            <th class="px-3 py-2 text-center font-medium">Touchdown Rate Grade</th>
            <th class="px-3 py-2 text-center font-medium">TDZ</th>
            <th class="px-3 py-2 text-center font-medium">Approach</th>
            <th class="px-3 py-2 text-center font-medium">Bounce</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="entry in logbook.entries"
            :key="entry.id || `${entry.timestamp}-${entry.vsFpm}`"
            class="transition-colors hover:bg-surface-50/20"
          >
            <td class="pl-2 pr-3 py-2.5 whitespace-nowrap text-xs text-gray-400 font-mono">{{ formatDate(entry.timestamp) }}</td>
            <td class="px-3 py-2.5 text-xs">
              <AppTooltip :content="entry.aircraft || ''" :disabled="!entry.aircraft" anchor-class="min-w-0" anchor-tag="div">
                <div class="text-gray-200">{{ shortAircraft(entry.aircraft) }}</div>
                <div class="text-[10px] text-gray-500 mt-0.5 font-mono">
                  {{ entry.icao || '--' }}
                  <span v-if="entry.runway" class="text-gray-600">{{ entry.runway }}</span>
                </div>
              </AppTooltip>
            </td>
            <td class="px-3 py-2.5 whitespace-nowrap text-xs text-right font-mono font-semibold" :style="{ color: gradeColor(entry.grade) }">
              {{ num(entry.vsFpm) }} fpm
            </td>
            <td class="px-3 py-2.5 whitespace-nowrap text-center">
              <span class="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded" :style="entryGradePillStyle(entry)">
                {{ touchdownGradeLabel(entry) }}
              </span>
            </td>
            <td class="px-3 py-2.5 whitespace-nowrap text-center">
              <AppTooltip :content="touchdownTooltip(entry)" :disabled="!touchdownTooltip(entry)">
                <span class="inline-flex flex-col items-center text-[10px] font-semibold px-1.5 py-0.5 rounded leading-tight" :style="touchdownStyle(entry)">
                  <span>{{ touchdownLabel(entry) }}</span>
                  <span v-if="touchdownSubLabel(entry)" class="font-normal opacity-75">{{ touchdownSubLabel(entry) }}</span>
                </span>
              </AppTooltip>
            </td>
            <td class="px-3 py-2.5 whitespace-nowrap text-center">
              <AppTooltip :content="stableTooltip(entry)" :disabled="!stableTooltip(entry)">
                <span class="inline-flex flex-col items-center">
                  <span :class="stableDesktopClass(entry)" :style="stableDesktopStyle(entry)">{{ stabilityBadge(entry).shortLabel }}</span>
                  <span v-if="stabilityCauseText(entry)" class="mt-0.5 text-[9px] font-normal leading-tight text-gray-500">{{ stabilityCauseText(entry) }}</span>
                </span>
              </AppTooltip>
            </td>
            <td class="px-3 py-2.5 whitespace-nowrap text-center text-[10px] font-semibold text-gray-300">
              {{ bounceLabel(entry) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    </div>
  </div>
</template>
