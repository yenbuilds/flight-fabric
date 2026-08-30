import { defineStore } from 'pinia';
import '../../../../shared/violation-rules.js';
import { buildDebriefConfidence, buildDebriefReasons } from '../../landing/debrief-insights.js';
import { buildLandingPresentation, normalizeBooleanLike } from '../../landing/scoring.js';
import { getStabilityContextSummary } from '../../landing/stability-context.js';
import { buildLandingWindPresentation } from '../../landing/wind.js';

const { VIOLATION_RULE } = globalThis.FlightFabricViolationRules;

const DEFAULT_GRADE_COLOR = '#4a5e74';
const IN_FLIGHT_UPSET_RULE_IDS = new Set([
  VIOLATION_RULE.UPSET_PITCH_NOSE_UP,
  VIOLATION_RULE.UPSET_PITCH_NOSE_DOWN,
  VIOLATION_RULE.UPSET_BANK,
  VIOLATION_RULE.GFORCE_HIGH,
  VIOLATION_RULE.GFORCE_NEGATIVE,
]);
function createDefaultLandingCardState() {
  return {
    gradeAnimationNonce: 0,
    runwayExcursionVisible: false,
    gradeText: '--',
    gradeColor: DEFAULT_GRADE_COLOR,
    gradeBreakdownText: '--',
    gradeBreakdownVisible: false,
    gforceText: 'G: --',
    airportText: '--',
    runwayText: '--',
    vsText: '--',
    vsColor: 'inherit',
    wind: buildLandingWindPresentation(),
    touchdown: {
      distanceText: '-- ft',
      distanceGradeText: '--',
      distanceGradeTone: 'text-gray-500',
      achievedText: '--',
      achievedTone: 'text-gray-100',
      lateralText: '-- ft',
      lateralTone: 'text-gray-100',
      lateralGradeText: '--',
      lateralGradeTone: 'text-gray-500',
      bounceText: '--',
      bounceTone: 'text-gray-100',
      bounceGradeText: '--',
      bounceGradeTone: 'text-gray-500',
    },
    approach: {
      stabilityText: '--',
      stabilityTone: 'text-gray-100',
      stabilityNoteText: 'Approach score --',
      stabilityTooltip: 'Approach score is a retrospective aggregate from the configured gate to touchdown.',
      speedText: '-- kt',
      gsText: 'GS: --',
      crosswindText: '-- kt',
      crosswindTone: 'text-gray-100',
      windTotalText: '--',
      typeText: '--',
    },
    attitude: {
      pitchText: '-- deg',
      pitchTone: 'text-gray-100',
      pitchGradeText: '--',
      bankText: '-- deg',
      bankTone: 'text-gray-100',
      bankGradeText: '--',
      centerlineText: '-- deg',
      centerlineTone: 'text-gray-100',
      centerlineGradeText: '--',
      upsetCountText: '--',
      upsetTone: 'text-gray-100',
      upsetGradeText: '--',
      upsetGradeTone: 'text-gray-500',
    },
    debrief: {
      reasons: [],
      confidenceText: 'High',
      confidenceReason: '',
      confidenceToneClass: 'text-green-400',
      visible: false,
    },
    rollout: {
      visible: false,
      assessmentText: '--',
      assessmentToneClass: 'text-gray-300',
      metrics: [],
      noteText: '',
    },
    inflight: {
      visible: false,
      stats: [],
      violations: [],
    },
  };
}

function createDefaultStabilityMetricModalState() {
  return {
    open: false,
    title: '--',
    scoreText: '--',
    descriptionText: '--',
    criteriaText: '--',
    detailVisible: false,
    detailText: '--',
  };
}

function createDefaultRenderedProfileState() {
  return {
    visible: false,
    svgHtml: '',
    gateLabel: '',
  };
}

function formatSummaryDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.round(Number(durationMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatSummaryNumber(value, maximumFractionDigits = 0) {
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  });
}

function hasFiniteSummaryNumber(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function appendPartialCoverage(parts, coveragePercent) {
  if (!hasFiniteSummaryNumber(coveragePercent)) return;
  const coverage = Math.max(0, Math.min(100, Number(coveragePercent)));
  if (coverage < 100) parts.push(`Coverage ${formatSummaryNumber(coverage)}%`);
}

function buildPostFlightInsightStats(summary) {
  const insights = summary?.insights || summary?.postFlightInsights;
  if (!insights) return [];
  const stats = [];

  const time = insights.time;
  if (time && hasFiniteSummaryNumber(time.airborne_time_ms)) {
    const parts = [`Airborne ${formatSummaryDuration(time.airborne_time_ms)}`];
    if (Number(time.taxi_time_ms) > 0) parts.push(`Taxi ${formatSummaryDuration(time.taxi_time_ms)}`);
    if (Number(time.paused_time_ms) > 0) parts.push(`Paused ${formatSummaryDuration(time.paused_time_ms)}`);
    stats.push({ key: 'flight-time', label: 'Flight Time', value: parts.join(' · '), toneClass: 'text-gray-200' });
  }

  const route = insights.route;
  if (route && Number(route.distance_nm) > 0) {
    const parts = [`${formatSummaryNumber(route.distance_nm, 1)} NM`];
    if (hasFiniteSummaryNumber(route.average_ground_speed_kts)) {
      parts.push(`Avg GS ${formatSummaryNumber(route.average_ground_speed_kts)} kt`);
    }
    appendPartialCoverage(parts, route.coverage_percent);
    stats.push({ key: 'route', label: 'Route', value: parts.join(' · '), toneClass: 'text-gray-200' });
  }

  const fuel = insights.fuel;
  if (fuel && (hasFiniteSummaryNumber(fuel.burn_lbs) || hasFiniteSummaryNumber(fuel.burn_gal))) {
    const parts = [];
    if (hasFiniteSummaryNumber(fuel.burn_lbs)) {
      parts.push(`${formatSummaryNumber(fuel.burn_lbs)} lb used`);
      if (hasFiniteSummaryNumber(fuel.efficiency_lbs_per_nm)) {
        parts.push(`${formatSummaryNumber(fuel.efficiency_lbs_per_nm, 1)} lb/NM`);
      }
    } else {
      parts.push(`${formatSummaryNumber(fuel.burn_gal, 1)} gal used`);
      if (hasFiniteSummaryNumber(fuel.efficiency_gal_per_nm)) {
        parts.push(`${formatSummaryNumber(fuel.efficiency_gal_per_nm, 2)} gal/NM`);
      }
    }
    stats.push({ key: 'fuel', label: 'Fuel', value: parts.join(' · '), toneClass: 'text-gray-200' });
  }

  const automation = insights.automation;
  if (automation && hasFiniteSummaryNumber(automation.autopilot_percent)) {
    const parts = [
      `AP ${formatSummaryNumber(automation.autopilot_percent)}%`,
      `Hand ${formatSummaryDuration(automation.hand_flown_time_ms)}`,
    ];
    if (Number(automation.hand_flown_below_1000_ft_ms) > 0) {
      parts.push(`Below 1,000 ft ${formatSummaryDuration(automation.hand_flown_below_1000_ft_ms)}`);
    }
    appendPartialCoverage(parts, automation.coverage_percent);
    stats.push({ key: 'automation', label: 'Automation', value: parts.join(' · '), toneClass: 'text-gray-200' });
  }

  const weather = insights.weather;
  if (weather) {
    const parts = [];
    if (hasFiniteSummaryNumber(weather.in_cloud_time_ms)) {
      parts.push(`Cloud ${formatSummaryDuration(weather.in_cloud_time_ms)}`);
    }
    if (hasFiniteSummaryNumber(weather.precipitation_time_ms)) {
      parts.push(`Precip ${formatSummaryDuration(weather.precipitation_time_ms)}`);
    }
    if (hasFiniteSummaryNumber(weather.max_wind_kts)) {
      parts.push(`Max wind ${formatSummaryNumber(weather.max_wind_kts)} kt`);
    }
    if (parts.length > 0) {
      appendPartialCoverage(parts, weather.coverage_percent);
      stats.push({ key: 'weather', label: 'Weather', value: parts.join(' · '), toneClass: 'text-gray-200' });
    }
  }

  const configuration = insights.configuration;
  if (configuration) {
    const parts = [];
    if (hasFiniteSummaryNumber(configuration.gear_down_ra_ft)) {
      parts.push(`Gear ${formatSummaryNumber(configuration.gear_down_ra_ft)} ft AGL`);
    } else if (configuration.gear_down_recorded === true) {
      parts.push('Gear down recorded');
    }
    if (configuration.landing_flaps) {
      const flapAltitude = hasFiniteSummaryNumber(configuration.landing_flaps_ra_ft)
        ? ` at ${formatSummaryNumber(configuration.landing_flaps_ra_ft)} ft AGL`
        : ' recorded';
      parts.push(`Flaps ${configuration.landing_flaps}${flapAltitude}`);
    }
    if (parts.length > 0) {
      stats.push({ key: 'configuration', label: 'Configuration', value: parts.join(' · '), toneClass: 'text-gray-200' });
    }
  }

  const comfort = insights.comfort;
  if (comfort) {
    const parts = [];
    if (hasFiniteSummaryNumber(comfort.peak_g)) parts.push(`Peak ${formatSummaryNumber(comfort.peak_g, 2)} G`);
    if (hasFiniteSummaryNumber(comfort.max_bank_deg)) parts.push(`Bank ${formatSummaryNumber(comfort.max_bank_deg, 1)}°`);
    if (hasFiniteSummaryNumber(comfort.rough_air_time_ms)) {
      parts.push(`Rough-air indications ${formatSummaryDuration(comfort.rough_air_time_ms)}`);
    }
    if (parts.length > 0) {
      stats.push({ key: 'comfort', label: 'Flight Comfort', value: parts.join(' · '), toneClass: 'text-gray-200' });
    }
  }

  const approach = insights.approach;
  if (approach && hasFiniteSummaryNumber(approach.duration_ms)) {
    const attemptCount = Math.max(1, Math.round(Number(approach.attempt_count) || 1));
    const parts = [
      `Final ${formatSummaryDuration(approach.duration_ms)}`,
      `${attemptCount} ${attemptCount === 1 ? 'attempt' : 'attempts'}`,
    ];
    if (hasFiniteSummaryNumber(approach.established_distance_nm)) {
      parts.push(`Started ${formatSummaryNumber(approach.established_distance_nm, 1)} NM out`);
    }
    stats.push({ key: 'approach', label: 'Approach', value: parts.join(' · '), toneClass: 'text-gray-200' });
  }
  return stats;
}

function buildInflightStats(summary) {
  const stats = [];
  if (summary?.max_alt_ft != null) {
    stats.push({
      key: 'max-alt',
      label: 'Max Alt',
      value: `${Math.round(summary.max_alt_ft).toLocaleString()} ft`,
      toneClass: 'text-gray-200',
    });
  }
  if (summary?.max_ias_kts != null) {
    stats.push({
      key: 'max-ias',
      label: 'Max IAS',
      value: `${summary.max_ias_kts} kt`,
      toneClass: 'text-gray-200',
    });
  }
  stats.push(...buildPostFlightInsightStats(summary));
  if (summary?.go_around_count > 0) {
    stats.push({
      key: 'go-arounds',
      label: 'Possible Go-Arounds',
      value: String(summary.go_around_count),
      toneClass: 'text-amber-400',
    });
  }
  const holding = summary?.holding || summary?.holdingPattern;
  if (holding?.detected === true && Number(holding.loop_count) > 0) {
    const loopCount = Math.round(Number(holding.loop_count));
    const duration = Number.isFinite(Number(holding.duration_ms))
      ? formatSummaryDuration(holding.duration_ms)
      : null;
    stats.push({
      key: 'holding',
      label: 'Possible Holding',
      value: `${loopCount} ${loopCount === 1 ? 'loop' : 'loops'}${duration ? ` · ${duration}` : ''}`,
      toneClass: 'text-sky-300',
    });
  }
  const dutchRoll = summary?.dutch_roll || summary?.dutchRoll;
  if (dutchRoll?.detected === true) {
    const confidence = String(dutchRoll.confidence || 'possible').toLowerCase();
    const confidenceLabel = confidence.charAt(0).toUpperCase() + confidence.slice(1);
    const durationSeconds = Number.isFinite(Number(dutchRoll.max_duration_ms))
      ? Math.round(Number(dutchRoll.max_duration_ms) / 1000)
      : null;
    stats.push({
      key: 'dutch-roll',
      label: 'Dutch Roll',
      value: durationSeconds !== null
        ? `Possible (${confidenceLabel}, ${durationSeconds}s)`
        : `Possible (${confidenceLabel})`,
      toneClass: 'text-sky-300',
    });
  }
  return stats;
}

function buildInflightViolations(summary) {
  const violations = [];
  if (summary?.overspeed_count > 0) {
    violations.push({
      key: 'overspeed',
      label: 'Overspeed',
      value: `${summary.overspeed_count}x`,
      containerClass: 'border-red-500 bg-red-900/10',
      valueClass: 'text-red-400',
    });
  }

  for (const violation of summary?.violations || []) {
    const fallbackLabel = violation.rule_id === VIOLATION_RULE.LATE_GO_AROUND || violation.ruleId === VIOLATION_RULE.LATE_GO_AROUND
      ? 'Possible late go-around'
      : (violation.rule_id || violation.ruleId || 'Violation');
    const containerClass = violation.severity === 'critical'
      ? 'border-red-500 bg-red-900/10'
      : violation.severity === 'warning'
        ? 'border-amber-500 bg-amber-900/10'
        : 'border-gray-600 bg-surface-200/40';
    const valueClass = violation.severity === 'critical'
      ? 'text-red-400'
      : violation.severity === 'warning'
        ? 'text-amber-400'
        : 'text-gray-500';
    const durationText = violation.duration_ms != null
      ? ` - ${(violation.duration_ms / 1000).toFixed(0)}s`
      : '';
    violations.push({
      key: `${violation.rule_id || violation.ruleId || 'violation'}-${violations.length}`,
      label: String(violation.label || fallbackLabel),
      value: `${String(violation.severity || '')}${durationText}`.trim(),
      containerClass,
      valueClass,
    });
  }

  if (violations.length === 0) {
    return [{
      key: 'none',
      label: 'No in-flight violations recorded',
      value: '',
      containerClass: 'border-gray-600 bg-surface-200/20',
      valueClass: 'text-gray-500',
      empty: true,
    }];
  }

  return violations;
}

function isExplicitFalse(value) {
  return value === false
    || value === 0
    || value === '0'
    || (typeof value === 'string' && value.toLowerCase() === 'false');
}

function isExplicitTrue(value) {
  return value === true
    || value === 1
    || value === '1'
    || (typeof value === 'string' && value.toLowerCase() === 'true');
}

function violationCountsAsFlightUpset(violation) {
  if (!violation || typeof violation !== 'object') return false;
  const explicit = violation.counts_as_upset ?? violation.countsAsUpset;
  if (isExplicitFalse(explicit)) return false;
  if (isExplicitTrue(explicit)) return true;
  return IN_FLIGHT_UPSET_RULE_IDS.has(violation.rule_id || violation.ruleId);
}

function countFlightUpsetsFromSummary(summary) {
  if (!summary || !Array.isArray(summary.violations)) return null;
  return summary.violations.filter(violationCountsAsFlightUpset).length;
}

function currentDisplayedUpsetCount(landingCard) {
  const parsed = Number(landingCard?.attitude?.upsetCountText);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function setFlightUpsetSummary(landingCard, count) {
  landingCard.attitude.upsetCountText = String(count);
  landingCard.attitude.upsetTone = count > 0 ? 'text-red-400' : 'text-gray-100';
  landingCard.attitude.upsetGradeText = count === 0
    ? 'None recorded'
    : count === 1
      ? '1 upset event'
      : `${count} upset events`;
  landingCard.attitude.upsetGradeTone = count > 0 ? 'text-red-400' : 'text-gray-500';
}

export const useLandingStore = defineStore('landing', {
  state: () => ({
    cardVisible: false,
    waitingVisible: true,
    landingModalOpen: false,
    landingModalLoading: false,
    landingModalError: '',
    landingCard: createDefaultLandingCardState(),
    stabilityBreakdownVisible: false,
    stabilityMetrics: [],
    stabilitySamplesText: '',
    stabilityContextText: '',
    stabilityContextDetail: '',
    stabilityContextGeneric: false,
    stabilityMetricModal: createDefaultStabilityMetricModalState(),
    approachProfile: createDefaultRenderedProfileState(),
    topdownProfile: createDefaultRenderedProfileState(),
  }),

  getters: {
    landingGradeStyle: (state) => ({
      color: state.landingCard.gradeColor,
    }),

    landingVsStyle: (state) => ({
      color: state.landingCard.vsColor,
    }),

    stabilityMetricModalClass: (state) => [
      'fixed inset-0 z-[240] flex items-center justify-center p-4 modal-backdrop',
      state.stabilityMetricModal.open ? '' : 'hidden',
    ].filter(Boolean).join(' '),

  },

  actions: {
    setLandingCardVisible(visible) {
      this.cardVisible = visible === true;
      this.waitingVisible = this.cardVisible !== true;
    },

    openLandingModal({ loading = false, error = '' } = {}) {
      this.landingModalOpen = true;
      this.landingModalLoading = loading === true;
      this.landingModalError = String(error || '');
    },

    closeLandingModal() {
      this.landingModalOpen = false;
      this.landingModalLoading = false;
      this.landingModalError = '';
    },

    setLandingModalLoading(loading) {
      this.landingModalLoading = loading === true;
      if (loading) this.landingModalError = '';
    },

    setLandingModalError(error) {
      this.landingModalLoading = false;
      this.landingModalError = String(error || 'Could not load landing details');
      this.landingModalOpen = true;
    },

    resetLandingCard() {
      this.setLandingCardVisible(false);
      this.landingCard = createDefaultLandingCardState();
      this.clearStabilityBreakdown();
      this.closeStabilityMetricModal();
      this.clearApproachProfile();
      this.clearTopdownProfile();
    },

    setFlightUpsetCount(count) {
      const numericCount = Number.isFinite(Number(count)) ? Math.max(0, Math.round(Number(count))) : 0;
      setFlightUpsetSummary(this.landingCard, numericCount);
    },

    setInflightSummary(summary) {
      if (!summary) {
        this.landingCard.inflight = {
          visible: false,
          stats: [],
          violations: [],
        };
        return;
      }

      this.landingCard.inflight = {
        visible: true,
        stats: buildInflightStats(summary),
        violations: buildInflightViolations(summary),
      };

      const summaryUpsetCount = countFlightUpsetsFromSummary(summary);
      if (summaryUpsetCount !== null) {
        setFlightUpsetSummary(
          this.landingCard,
          Math.max(currentDisplayedUpsetCount(this.landingCard), summaryUpsetCount),
        );
      }
    },

    setStabilityBreakdown(payload = {}) {
      const metrics = Array.isArray(payload.metrics) ? payload.metrics.slice() : [];
      this.stabilityMetrics = metrics;
      this.stabilitySamplesText = payload.samplesText ? String(payload.samplesText) : '';
      this.stabilityContextText = payload.contextText ? String(payload.contextText) : '';
      this.stabilityContextDetail = payload.contextDetail ? String(payload.contextDetail) : '';
      this.stabilityContextGeneric = payload.contextGeneric === true;
      this.stabilityBreakdownVisible = metrics.length > 0
        || Boolean(this.stabilitySamplesText)
        || Boolean(this.stabilityContextText);
    },

    clearStabilityBreakdown() {
      this.stabilityBreakdownVisible = false;
      this.stabilityMetrics = [];
      this.stabilitySamplesText = '';
      this.stabilityContextText = '';
      this.stabilityContextDetail = '';
      this.stabilityContextGeneric = false;
    },

    openStabilityMetricModal(payload = {}) {
      this.stabilityMetricModal = {
        open: true,
        title: payload.title || payload.label || payload.key || 'Metric',
        scoreText: payload.scoreText || '--',
        descriptionText: payload.descriptionText || 'No description available.',
        criteriaText: payload.criteriaText || '--',
        detailVisible: Boolean(payload.detailText),
        detailText: payload.detailText || '--',
      };
    },

    closeStabilityMetricModal() {
      this.stabilityMetricModal = createDefaultStabilityMetricModalState();
    },

    setApproachProfile(payload = {}) {
      this.approachProfile = {
        visible: Boolean(payload.svgHtml),
        svgHtml: payload.svgHtml || '',
        gateLabel: payload.gateLabel || '',
      };
    },

    clearApproachProfile() {
      this.approachProfile = createDefaultRenderedProfileState();
    },

    setTopdownProfile(payload = {}) {
      this.topdownProfile = {
        visible: Boolean(payload.svgHtml),
        svgHtml: payload.svgHtml || '',
        gateLabel: '',
      };
    },

    clearTopdownProfile() {
      this.topdownProfile = createDefaultRenderedProfileState();
    },

    applyLandingCardMessage(msg, options = {}) {
      if (!msg || typeof msg !== 'object') return false;

      const observedLandingVsFpm = msg.vs !== null
        && msg.vs !== undefined
        && msg.vs !== ''
        && Number.isFinite(Number(msg.vs))
        ? Number(msg.vs)
        : null;
      const hasKnownNonDescendingRate = observedLandingVsFpm !== null && observedLandingVsFpm >= 0;
      const summaryPresentation = buildLandingPresentation(hasKnownNonDescendingRate
        ? { ...msg, grade: null, color: null }
        : msg);
      const verdict = summaryPresentation.verdict;
      const normalized = verdict.normalized;
      const tdz = msg.touchdownDistance;
      const landingCard = createDefaultLandingCardState();
      const flightUpsetCount = Number.isFinite(Number(options.flightUpsetCount))
        ? Math.max(0, Math.round(Number(options.flightUpsetCount)))
        : 0;

      landingCard.gradeAnimationNonce = this.landingCard.gradeAnimationNonce + 1;
      landingCard.runwayExcursionVisible = verdict.flags.runwayExcursion;
      landingCard.gradeText = summaryPresentation.touchdownGrade;
      landingCard.gradeColor = summaryPresentation.touchdownColor;
      landingCard.gforceText = msg.gforce ? `G: ${msg.gforce.toFixed(2)}` : 'G: --';
      landingCard.airportText = msg.icao || '--';
      landingCard.runwayText = msg.runway ? `RWY ${msg.runway}` : '--';
      const landingVsFpm = observedLandingVsFpm !== null && observedLandingVsFpm < 0
        ? observedLandingVsFpm
        : null;
      landingCard.vsText = landingVsFpm === null ? '--' : String(Math.round(landingVsFpm));
      landingCard.vsColor = hasKnownNonDescendingRate ? 'inherit' : (msg.color || 'inherit');

      landingCard.gradeBreakdownText = summaryPresentation.touchdownDetailText;
      landingCard.gradeBreakdownVisible = summaryPresentation.touchdownDetailParts.length > 0;

      if (tdz && tdz.distanceFt != null) {
        landingCard.touchdown.distanceText = Math.abs(tdz.distanceFt) <= 15000
          ? `${Math.round(tdz.distanceFt).toLocaleString()} ft`
          : 'Off Airport';
        landingCard.touchdown.distanceGradeText = tdz.grade || '--';
        landingCard.touchdown.distanceGradeTone = tdz.grade === 'Outstanding'
          ? 'text-green-500'
          : tdz.grade === 'Good'
            ? 'text-gray-500'
            : verdict.touchdown.severity === 1
              ? 'text-amber-500'
              : verdict.touchdown.severity >= 2
                ? 'text-red-400'
                : 'text-gray-500';
        landingCard.touchdown.achievedText = verdict.flags.touchdownTargetAchieved ? 'YES' : 'NO';
        landingCard.touchdown.achievedTone = verdict.flags.touchdownTargetAchieved ? 'text-gray-100' : 'text-amber-400';
      }

      const stabilityScore = summaryPresentation.stabilityScore;
      if (summaryPresentation.approachText) {
        const stabilityVerdict = summaryPresentation.stabilityVerdict;
        const contextSummary = getStabilityContextSummary(
          msg?.ultimateStability?.scoringContext,
          msg?.aircraftProfileId || msg?.aircraft_profile_id,
        );
        landingCard.approach.stabilityText = summaryPresentation.approachText;
        landingCard.approach.stabilityTone = stabilityVerdict === 'unstable'
          ? 'text-red-400'
          : stabilityVerdict === 'marginal'
            ? 'text-amber-400'
            : stabilityVerdict === 'stable'
              ? 'text-green-400'
              : 'text-gray-400';
        landingCard.approach.stabilityNoteText = summaryPresentation.approachDetailText
          || (contextSummary.isGeneric ? 'Generic-profile estimate' : 'Approach score --');
        const gateLabel = summaryPresentation.stabilityGateLabel;
        const passPct = summaryPresentation.stabilityPassPct;
        const stabilityExplanation = stabilityVerdict === 'unstable'
          ? `A hard or substantial deviation was recorded after the ${gateLabel} gate.`
          : stabilityVerdict === 'marginal'
            ? `Only soft/proxy checks missed the strict ${passPct}% threshold after the ${gateLabel} gate.`
            : stabilityVerdict === 'stable'
              ? `Every applicable strict check met its recorded ${passPct}% threshold after the ${gateLabel} gate.`
              : `There was not enough usable data for an approach verdict after the ${gateLabel} gate.`;
        landingCard.approach.stabilityTooltip = `${contextSummary.label}. ${stabilityExplanation} Approach score is a separate retrospective aggregate.`;
      }

      landingCard.approach.typeText = msg.approachType || 'VISUAL';

      landingCard.wind = buildLandingWindPresentation(msg);
      landingCard.approach.crosswindText = landingCard.wind.crosswindText;
      landingCard.approach.crosswindTone = landingCard.wind.crosswindText === '-- kt'
        ? 'text-gray-500'
        : 'text-gray-100';
      landingCard.approach.windTotalText = landingCard.wind.totalText;

      if (msg.iasKts != null) {
        landingCard.approach.speedText = `${msg.iasKts} kt`;
        landingCard.approach.gsText = msg.gsKts != null ? `GS: ${msg.gsKts}` : 'GS: --';
      }

      if (msg.pitchDeg != null) {
        const pitch = Number(msg.pitchDeg);
        if (Number.isFinite(pitch)) {
          landingCard.attitude.pitchText = `${pitch > 0 ? '+' : ''}${pitch.toFixed(1)} deg`;
          landingCard.attitude.pitchTone = (pitch < 0 || pitch > 6) ? 'text-amber-400' : 'text-gray-100';
          landingCard.attitude.pitchGradeText = pitch < 0 ? 'Nose down!'
            : pitch < 2 ? 'Flat'
            : pitch <= 6 ? 'Good flare'
            : pitch <= 8 ? 'High'
            : 'Very high';
        }
      }

      if (msg.bankDeg != null) {
        const bank = Number(msg.bankDeg);
        if (Number.isFinite(bank)) {
          const bankAbs = Math.abs(bank);
          const bankDir = bank >= 0 ? 'R' : 'L';
          landingCard.attitude.bankText = bankAbs < 0.5 ? '0 deg' : `${bankAbs.toFixed(1)} deg ${bankDir}`;
          landingCard.attitude.bankTone = bankAbs <= 5 ? 'text-gray-100' : bankAbs <= 10 ? 'text-amber-400' : 'text-red-400';
          landingCard.attitude.bankGradeText = bankAbs <= 3 ? 'Wings level'
            : bankAbs <= 5 ? 'Slight bank'
            : bankAbs <= 10 ? 'Moderate bank'
            : 'Excessive bank';
        }
      }

      if (msg.centerlineDev != null) {
        const deviation = Number(msg.centerlineDev);
        if (Number.isFinite(deviation)) {
          const deviationAbs = Math.abs(deviation);
          const deviationDir = deviation >= 0 ? 'R' : 'L';
          landingCard.attitude.centerlineText = deviationAbs < 0.5 ? 'ALIGNED' : `${deviationAbs.toFixed(1)} deg ${deviationDir}`;
          landingCard.attitude.centerlineTone = deviationAbs <= 5 ? 'text-gray-100' : deviationAbs <= 10 ? 'text-amber-400' : 'text-red-400';
          landingCard.attitude.centerlineGradeText = deviationAbs <= 3 ? 'Runway aligned'
            : deviationAbs <= 5 ? 'Slight heading error'
            : deviationAbs <= 10 ? 'Heading misaligned'
            : 'Major heading error';
        }
      }

      const rollout = msg.rolloutAnalysis;
      if (rollout && typeof rollout === 'object') {
        const assessment = String(rollout.assessment || 'normal').toLowerCase();
        const assessmentText = assessment.toUpperCase();
        const assessmentToneClass = assessment === 'critical' || assessment === 'warning'
          ? 'text-red-400'
          : assessment === 'caution'
            ? 'text-amber-400'
            : 'text-green-400';
        const rolloutMetrics = [];
        if (Number.isFinite(Number(rollout.maxBankDeg))) {
          rolloutMetrics.push({
            key: 'bank',
            label: 'Peak bank',
            value: `${Number(rollout.maxBankDeg).toFixed(1)} deg`,
          });
        }
        if (Number.isFinite(Number(rollout.maxBankRateDegS))) {
          rolloutMetrics.push({
            key: 'bank-rate',
            label: 'Bank change',
            value: `${Number(rollout.maxBankRateDegS).toFixed(1)} deg/s`,
          });
        }
        if (Number.isFinite(Number(rollout.maxHeadingDeviationDeg))) {
          rolloutMetrics.push({
            key: 'heading',
            label: 'Heading deviation',
            value: `${Number(rollout.maxHeadingDeviationDeg).toFixed(1)} deg ${rollout.maxHeadingDeviationSide || ''}`.trim(),
          });
        }
        if (Number.isFinite(Number(rollout.maxLateralOffsetFt))) {
          rolloutMetrics.push({
            key: 'lateral',
            label: 'Peak lateral offset',
            value: `${Math.round(Number(rollout.maxLateralOffsetFt))} ft ${rollout.maxLateralOffsetSide || ''}`.trim(),
          });
        }
        const edgeMarginFt = rollout.conservativeRunwayEdgeMarginFt ?? rollout.minRunwayEdgeMarginFt;
        if (Number.isFinite(Number(edgeMarginFt))) {
          rolloutMetrics.push({
            key: 'edge-margin',
            label: rollout.conservativeRunwayEdgeMarginFt != null ? 'Conservative edge margin' : 'Runway edge margin',
            value: `${Math.round(Number(edgeMarginFt))} ft`,
          });
        }
        const noteParts = ['Separate from approach stability.'];
        if (rollout.lateralDataQuality === 'low') {
          noteParts.push(`Lateral estimate has \u00b1${Math.round(Number(rollout.lateralUncertaintyFt || 0))} ft coordinate uncertainty.`);
        }
        if (Array.isArray(rollout.flags) && rollout.flags.length > 0) {
          noteParts.push(rollout.flags.map((flag) => flag.label).filter(Boolean).join('; '));
        }
        landingCard.rollout = {
          visible: true,
          assessmentText,
          assessmentToneClass,
          metrics: rolloutMetrics,
          noteText: noteParts.join(' '),
        };
      }

      if (tdz && tdz.lateralOffsetFt != null) {
        const lateralOffset = Number(tdz.lateralOffsetFt);
        if (Number.isFinite(lateralOffset)) {
          const latAbs = Math.abs(lateralOffset);
          const latSide = String(tdz.lateralOffsetSide || (lateralOffset >= 0 ? 'R' : 'L')).toUpperCase().charAt(0);
          landingCard.touchdown.lateralText = latAbs < 15 ? 'ON CL' : `${Math.round(latAbs)} ft ${latSide}`;
          const lateralGrade = tdz.lateralOffsetGrade || 'Unknown';
          landingCard.touchdown.lateralTone = lateralGrade === 'Poor'
            ? 'text-amber-400'
            : lateralGrade === 'Excursion'
              ? 'text-red-400'
              : 'text-gray-100';
          landingCard.touchdown.lateralGradeText = tdz.lateralOffsetGrade || '--';
          landingCard.touchdown.lateralGradeTone = tdz.lateralOffsetScore >= 90
            ? 'text-green-400'
            : tdz.lateralOffsetScore >= 70
              ? 'text-amber-500'
              : 'text-red-400';
        }
      }

      if (summaryPresentation.bounceKnown) {
        const bounce = verdict.bounce;
        const bounceCount = bounce.bounceCount;
        landingCard.touchdown.bounceText = bounceCount === 0 ? 'Clean' : `${bounceCount}x`;
        const bounceGrade = bounce.bounceGrade || 'Clean';
        landingCard.touchdown.bounceTone = verdict.bounce.severity === 1
          ? 'text-amber-400'
          : verdict.bounce.severity >= 3
            ? 'text-red-400'
            : 'text-gray-100';
        landingCard.touchdown.bounceGradeText = tdz?.bounceDistanceFt && tdz.bounceDistanceFt > 0
          ? `${bounceGrade} (${Math.round(tdz.bounceDistanceFt)} ft)`
          : bounceGrade;
        const bounceScore = Number(tdz?.bounceScore);
        landingCard.touchdown.bounceGradeTone = Number.isFinite(bounceScore)
          ? (bounceScore >= 90
              ? 'text-green-400'
              : bounceScore >= 70
                ? 'text-amber-500'
                : 'text-red-400')
          : (bounceGrade === 'Clean'
              ? 'text-green-400'
              : verdict.bounce.severity === 1
                ? 'text-amber-500'
                : 'text-red-400');
      }

      const debriefReasons = buildDebriefReasons(msg, {
        normalized,
        ultimateStability: msg?.ultimateStability || null,
        touchdownDistance: tdz || null,
        limit: 6,
      });
      const confidence = buildDebriefConfidence(
        msg,
        msg?.ultimateStability || null,
        msg?.ultimateStability || null,
      );
      landingCard.debrief = {
        reasons: debriefReasons,
        confidenceText: confidence.confidenceText,
        confidenceReason: confidence.confidenceReason,
        confidenceToneClass: confidence.confidenceToneClass,
        visible: debriefReasons.length > 0 || confidence.confidenceText !== 'High',
      };

      setFlightUpsetSummary(landingCard, flightUpsetCount);

      this.landingCard = landingCard;
      this.setInflightSummary(msg.flightSummary || null);
      this.setLandingCardVisible(true);
      return true;
    },

  },
});
