import { createLandingCardRenderer, mergeLandingMessageUltimateStability } from './card.js';
import { approachProfileApi } from './approach-profile-global.js';
import { gradeHex, gradeSeverity, normalizeLandingData } from './scoring.js';
import {
  HIDDEN_STABILITY_METRICS,
  getStabilityContextSummary,
  getStabilityMetricPresentation,
} from './stability-context.js';

const STABILITY_METRIC_LABELS = {
  config_ok: 'Config',
  gear_ok: 'Gear',
  flaps_ok: 'Flaps',
  spoilers_ok: 'Spoilers (retired)',
  speed_ok: 'Airspeed',
  speed_trend_ok: 'Speed Trend',
  vs_ok: 'V/S',
  glidepath_ok: 'Path Rate',
  glidepath_below_ok: 'Path Rate (steep)',
  glidepath_above_ok: 'Path Rate (shallow)',
  thrust_ok: 'Throttle Movement',
  thrust_not_idle_ok: 'Idle-thrust proxy',
  thrust_stable_ok: 'Throttle Movement',
  pitch_ok: 'Pitch',
  bank_ok: 'Bank',
  lateral_offset_ok: 'Lateral Offset',
};

const STABILITY_METRIC_TOOLTIPS = {
  config_ok: 'AND of Gear and Flaps checks (100% only if both pass). Configuration failures also cap the approach score.',
  gear_ok: 'Gear reported down at the 1,000 ft RA gate and not changed afterwards',
  flaps_ok: 'Flaps extended beyond 10% (or notch > 0) at the gate and not changed afterwards',
  spoilers_ok: 'Retired neutral compatibility field; spoiler telemetry is not scored',
  speed_ok: 'IAS within \u00b15 kt of the IAS recorded at the 1,000 ft RA gate, scored down to 50 ft AAL',
  speed_trend_ok: 'IAS rate-of-change \u22642.5 kt/sec over a rolling one-second window, scored down to 50 ft AAL',
  vs_ok: 'Vertical speed between \u22121,000 fpm and +200 fpm below the gate',
  glidepath_ok: 'One-second average V/S within \u2264200 fpm of the rate a 3\u00b0 path requires, scored down to 50 ft AAL',
  glidepath_below_ok: 'One-second average V/S is no more than 200 fpm steeper than the target path rate; this is not a position-based glideslope measurement',
  glidepath_above_ok: 'One-second average V/S is no more than 200 fpm shallower than the target path rate; this is not a position-based glideslope measurement',
  thrust_ok: 'Throttle/engine-percent movement score',
  thrust_not_idle_ok: 'Legacy neutral idle-thrust proxy retained for CSV compatibility',
  thrust_stable_ok: 'Throttle/engine-percent rate-of-change \u226410 percentage points/sec between consecutive samples from the gate to 50 ft AAL',
  pitch_ok: 'Pitch between \u22125\u00b0 and +15\u00b0 below the gate',
  bank_ok: 'Bank magnitude \u226425\u00b0 below the gate',
  lateral_offset_ok: 'Touchdown lateral offset from runway centerline, scored only when trusted runway geometry is available',
};

const STABILITY_METRIC_DESCRIPTIONS = {
  config_ok: {
    desc: 'Aggregate configuration check. This is a binary 100 / 0 score that is 100 only when Gear and Flaps both pass. Gear/flap failures at the stability gate cap the approach score to 60, and gear/flap changes after the gate cap it to 70.',
    criteria: 'gear_ok AND flaps_ok both = 100. Configuration failures cap the final approach score even if the other approach metrics are clean.',
  },
  gear_ok: {
    desc: 'Gear must be "down" at the 1,000 ft RA stability gate and the raw gear value must not change between the gate and touchdown. "Down" is taken from whichever of these the active telemetry exposes: a `gearDown` boolean, `gear.locked`, `gear_locked`, or SimConnect\'s `GEAR TOTAL PCT EXTENDED` = 100 % (`gearDownLocked === 1`). Gear-locked sensing therefore depends on what the aircraft publishes - some 3rd-party aircraft only expose extension percent. The check fails if the gear is not down at the gate, or if the raw extension value changes after the gate (e.g. late retract/extend, or oscillating reads).',
    criteria: 'Gear-down at the 1,000 ft RA gate AND raw gear value identical at every sample from the gate to touchdown.',
  },
  flaps_ok: {
    desc: 'Flaps must be in a landing configuration at the 1,000 ft RA gate and the raw flap value must not change afterwards. When a profile does not provide an exact briefed landing detent, this fallback stays deliberately permissive: extension > 10 %, OR notch > 0, OR no flaps data at all (assumed OK). NOTE: configuring further flap on short final - even a normal Flap 30 -> Flap Full - changes the raw value and will fail this metric.',
    criteria: 'Flaps extended (>10 % or notch >0, or no-data) at the 1,000 ft RA gate AND raw flap value identical at every sample from the gate to touchdown.',
  },
  spoilers_ok: {
    desc: 'Retired compatibility field. Spoiler telemetry remains available in Systems and recordings but does not contribute to cross-aircraft stability scoring.',
    criteria: 'Neutral at 100 %. Hidden from the debrief metric list.',
  },
  speed_ok: {
    desc: 'IAS must stay within the recorded policy band around the IAS observed AT the stability gate. We use gate IAS because the app does not know your briefed Vref/Vapp. Normal flare speed bleed below 50 ft is excluded. Missing IAS samples are excluded from the metric.',
    criteria: 'IAS within \u00b15 kt of the gate-sample IAS at every sample from the gate down to 50 ft AAL.',
  },
  speed_trend_ok: {
    desc: 'Even if instantaneous IAS is in band, a sustained acceleration or deceleration trend means the approach is not yet settled. This metric measures IAS change over a rolling one-second window so 10 Hz telemetry jitter is not mistaken for aircraft acceleration. Normal flare deceleration below 50 ft AAL is excluded.',
    criteria: '|\u0394 IAS / \u0394 t| \u2264 2.5 kt/sec over each eligible one-second window from the gate down to 50 ft AAL.',
  },
  vs_ok: {
    desc: 'Vertical speed must stay inside the recorded policy range below the gate. Missing V/S samples are excluded from the metric.',
    criteria: 'V/S between \u22121,000 and +200 fpm at every sample below the gate.',
  },
  glidepath_ok: {
    desc: 'Compares a trailing one-second average V/S against the V/S the recorded target path requires at the current ground speed. It is scored from the gate down to 50 ft AAL so the normal flare is excluded. It requires valid ground speed \u2265 30 kt; otherwise the metric is unavailable and excluded. This is not a true ILS or PAPI position measurement.',
    criteria: '|one-second average V/S \u2212 (\u2212GS \u00d7 5.31)| \u2264 200 fpm from the gate down to 50 ft AAL when GS \u2265 30 kt.',
  },
  glidepath_below_ok: {
    desc: 'Directional path-rate metric: a sample fails when V/S is more than 200 fpm steeper than the 3\u00b0 target at the current ground speed. It detects excess descent rate only; without a geometric path or ILS/PAPI deviation it cannot establish that the aircraft was below a glideslope or infer terrain/obstacle clearance.',
    criteria: 'One-second average V/S \u2265 (\u2212GS \u00d7 5.31) \u2212 200 fpm from the gate down to 50 ft AAL when GS \u2265 30 kt.',
  },
  glidepath_above_ok: {
    desc: 'Directional path-rate metric: a sample fails when V/S is more than 200 fpm shallower than the 3\u00b0 target at the current ground speed. It detects shallow descent rate only; without a geometric path or ILS/PAPI deviation it cannot establish that the aircraft was above a glideslope or predict a long landing.',
    criteria: 'One-second average V/S \u2264 (\u2212GS \u00d7 5.31) + 200 fpm from the gate down to 50 ft AAL when GS \u2265 30 kt.',
  },
  thrust_ok: {
    desc: 'Movement score based on the best available throttle/engine-percent signal from the gate down to 50 ft AAL. Live scoring prefers explicit throttle lever percent when available, then falls back to engine/N1-like percent. The old "Thrust Not Idle" check is no longer scored because real idle on many turbojets can sit around 20 % rather than 0 %.',
    criteria: 'Same as Throttle Movement until a reliable cross-aircraft throttle-lever idle-detent source exists.',
  },
  thrust_not_idle_ok: {
    desc: 'Legacy compatibility field. This used to score whether reported engine/thrust percent was above an idle threshold, but that signal is not a reliable cross-aircraft throttle-lever idle-detent source.',
    criteria: 'Neutral at 100 %. Retained in CSV/debug contracts only.',
  },
  thrust_stable_ok: {
    desc: 'The commanded throttle/engine-percent signal should not be hunting up and down on final. This is not a jet engine spool-rate test: live scoring uses throttle lever percent when the aircraft exposes it, and historical replay may use N1-like engine percent from recorded CSV fields. We score consecutive sample pairs by absolute rate-of-change - not standard deviation. A sustained step or oscillation faster than 10 percentage points/sec fails the pair. Normal thrust reduction below 50 ft AAL is excluded.',
    criteria: '|\u0394 throttle-or-engine % / \u0394 t| \u2264 10 percentage points/sec for each pair from the gate down to 50 ft AAL that reports the signal.',
  },
  pitch_ok: {
    desc: 'Pitch should sit in a normal transport-category approach band. Until a profile provides narrower aircraft-specific limits, pitch < \u22125\u00b0 (steep dive) or > +15\u00b0 (very high AoA / risk of tail-strike or stall) is counted as failed for that sample.',
    criteria: '\u22125\u00b0 \u2264 pitch \u2264 +15\u00b0 at every sample below the gate that reports pitch.',
  },
  bank_ok: {
    desc: 'Wings should be roughly level on short final. The threshold is \u00b125\u00b0 (NOT \u00b110\u00b0) - it is generous on purpose so it only catches genuinely abnormal line-up corrections rather than normal crab-kick or VFR pattern turns close to the gate.',
    criteria: '|bank| \u2264 25\u00b0 at every sample below the gate that reports bank.',
  },
  lateral_offset_ok: {
    desc: 'Touchdown lateral offset is scored at the touchdown point using the runway-centerline metric shown on the landing card. It appears only when the backend has a finite offset from trusted runway geometry; if no finite offset is available, this metric is omitted from the approach score.',
    criteria: 'Bands use absolute offset versus runway width: <=10 ft = 100, <=33% of half-width = 95, <=66% = 85, <=runway edge = 70, outside the edge = Excursion with a decreasing score. Scores below the stability pass threshold (80% by default) fail this metric.',
  },
};

export function createLandingController({
  $,
  setText,
  windowRef = window,
  flightStore = null,
  landingStore = null,
  tabsStore = null,
} = {}) {
  if (!landingStore) {
    throw new Error('Landing store is required before landing controller');
  }

  let lastUltimateStability = null;
  let lastLandingData = null;
  let flightUpsetCount = 0;

  function getLandingStore() {
    return landingStore;
  }

  function resetDataLandingPreview() {
    flightStore?.resetLandingPreview?.();
  }

  function updateDataLandingPreview(rawLanding) {
    if (!rawLanding) return null;
    return flightStore?.updateLandingPreview?.(rawLanding) || normalizeLandingData(rawLanding);
  }

  const landingCardRenderer = createLandingCardRenderer({
    $,
    windowRef,
    getLandingStore,
    getLastUltimateStability: () => lastUltimateStability,
    setLastLandingData: (data) => {
      lastLandingData = data;
    },
    getFlightUpsetCount: () => flightUpsetCount,
    updateDataLandingPreview,
    renderStabilityBreakdown,
    renderApproachProfile,
  });
  function showLanding(msg) {
    landingCardRenderer.renderLandingCard(msg);
  }

  function activateLandingTab() {
    if (typeof tabsStore?.requestTabChange === 'function') {
      return tabsStore.requestTabChange('landing');
    }
    if (typeof tabsStore?.setActiveTab === 'function') {
      tabsStore.setActiveTab('landing');
      return true;
    }
    return false;
  }

  function openTimelineLandingModal({ loading = false } = {}) {
    getLandingStore()?.openLandingModal?.({ loading });
  }

  function showTimelineLandingError(error) {
    const message = typeof error === 'string' && error.trim()
      ? error.trim()
      : 'Could not load landing details';
    getLandingStore()?.setLandingModalError?.(message);
  }

  function renderInflightSummary(flightSummary) {
    landingCardRenderer.renderInflightSummary(flightSummary);
  }

  function showTimelineLanding(event, options = {}) {
    if (!event || event.type !== 'landing') return;
    const openModal = options.openModal === true;
    if (openModal) {
      getLandingStore()?.openLandingModal?.({ loading: false });
    }

    const verticalSpeed = event.vs_fpm || 0;
    const grade = event.grade || null;
    const color = gradeHex(gradeSeverity(grade));
    const msg = {
      vs: verticalSpeed,
      grade,
      color,
      iasKts: event.ias_kts != null ? Math.round(event.ias_kts) : null,
      pitchDeg: event.pitch_deg != null ? event.pitch_deg : null,
      icao: event.runway ? event.runway.airport_icao : null,
      runway: event.runway ? event.runway.runway_id : null,
      runwayHdg: event.touchdownDistance?.runwayHeadingTrueDeg ?? (event.runway ? event.runway.heading : null),
      runwayThreshold: event.touchdownDistance?.runwayThresholdLat != null && event.touchdownDistance?.runwayThresholdLon != null
        ? { lat: event.touchdownDistance.runwayThresholdLat, lon: event.touchdownDistance.runwayThresholdLon }
        : (event.runway ? event.runway.threshold : null),
      runwayReferenceElevFt: Number.isFinite(event.runwayReferenceElevFt)
        ? event.runwayReferenceElevFt
        : (Number.isFinite(event.thresholdElevFt) ? event.thresholdElevFt : null),
      thresholdElevFt: Number.isFinite(event.thresholdElevFt)
        ? event.thresholdElevFt
        : (Number.isFinite(event.runwayReferenceElevFt) ? event.runwayReferenceElevFt : null),
      touchdownDistance: event.touchdownDistance
        ? {
            ...event.touchdownDistance,
            runwayLengthFt: event.touchdownDistance.runwayLengthFt
              ?? event.touchdownDistance.runwayPhysicalLengthFt
              ?? (event.runway ? event.runway.length_ft : null),
            runwayWidthFt: event.touchdownDistance.runwayWidthFt
              ?? (event.runway && Number.isFinite(event.runway.width_ft) ? event.runway.width_ft : null),
          }
        : null,
      bounceCount: event.bounceCount ?? null,
      bounceGrade: event.bounceGrade ?? null,
      runwayExcursion: event.runwayExcursion === true,
      shortLanding: event.shortLanding === true,
      rolloutAnalysis: event.rolloutAnalysis || null,
      ultimateStability: event.ultimateStability || null,
      centerlineDev: event.centerlineDev ?? null,
      bankDeg: event.bank_deg != null ? event.bank_deg : null,
      gsKts: event.gs_kts != null ? Math.round(event.gs_kts) : null,
      crosswind: event.xwind_kts != null ? Math.round(event.xwind_kts) : null,
      windSpeed: event.wind_speed_kts != null ? Math.round(event.wind_speed_kts) : null,
      gforce: event.gforce != null ? event.gforce : null,
      approachType: null,
      aircraftProfileId: event.aircraftProfileId || event.aircraft_profile_id || null,
      final: true,
      flightSummary: event.flightSummary || null,
    };

    if (event.ultimateStability) {
      lastUltimateStability = {
        ...event.ultimateStability,
        approachProfile: event.approachProfile || [],
        runwayReferenceElevFt: Number.isFinite(event.runwayReferenceElevFt)
          ? event.runwayReferenceElevFt
          : (Number.isFinite(event.thresholdElevFt) ? event.thresholdElevFt : null),
        thresholdElevFt: Number.isFinite(event.thresholdElevFt)
          ? event.thresholdElevFt
          : (Number.isFinite(event.runwayReferenceElevFt) ? event.runwayReferenceElevFt : null),
      };
    } else if (event.approachProfile) {
      lastUltimateStability = {
        approachProfile: event.approachProfile,
        runwayReferenceElevFt: Number.isFinite(event.runwayReferenceElevFt)
          ? event.runwayReferenceElevFt
          : (Number.isFinite(event.thresholdElevFt) ? event.thresholdElevFt : null),
        thresholdElevFt: Number.isFinite(event.thresholdElevFt)
          ? event.thresholdElevFt
          : (Number.isFinite(event.runwayReferenceElevFt) ? event.runwayReferenceElevFt : null),
      };
    }

    showLanding(msg);
    if (openModal) {
      getLandingStore()?.setLandingModalLoading?.(false);
    } else {
      activateLandingTab();
    }
  }

  function updateStabilityBreakdown(msg) {
    lastUltimateStability = msg;
    if (lastLandingData) {
      const mergedLandingData = mergeLandingMessageUltimateStability(lastLandingData, msg);
      if (mergedLandingData !== lastLandingData) {
        lastLandingData = mergedLandingData;
        updateDataLandingPreview(lastLandingData);
        getLandingStore()?.applyLandingCardMessage?.(lastLandingData, {
          flightUpsetCount,
        });
      }
    }
    renderStabilityBreakdown(msg);
    if (msg.approachProfile && msg.approachProfile.length > 0) {
      renderApproachProfile(msg, lastLandingData);
      return;
    }

    const landingStore = getLandingStore();
    landingStore?.clearApproachProfile?.();
    landingStore?.clearTopdownProfile?.();
  }

  function renderStabilityBreakdown(msg) {
    const landingStore = getLandingStore();
    if (!landingStore || !msg.breakdown) {
      landingStore?.clearStabilityBreakdown?.();
      return;
    }

    const details = msg.breakdownDetails || {};
    const metrics = [];
    for (const [key, label] of Object.entries(STABILITY_METRIC_LABELS)) {
      if (HIDDEN_STABILITY_METRICS.has(key)) continue;
      const value = msg.breakdown[key];
      if (value == null) continue;

      const valueClass = value >= 80 ? 'text-success' : value >= 60 ? 'text-warning' : 'text-danger';
      const backgroundClass = value >= 80 ? 'bg-success/10' : value >= 60 ? 'bg-warning/10' : 'bg-danger/10';
      const detail = details[key];
      const explanation = detail && detail.message && value < 100 ? String(detail.message) : '';
      const tooltip = STABILITY_METRIC_TOOLTIPS[key] || '';
      const detailMsg = (detail && detail.message) ? String(detail.message) : '';
      const description = STABILITY_METRIC_DESCRIPTIONS[key] || null;
      const presentation = getStabilityMetricPresentation(key, msg.scoringContext, {
        tooltip,
        descriptionText: (description && description.desc) || tooltip || 'No description available.',
        criteriaText: (description && description.criteria) || '--',
      });

      metrics.push({
        key,
        label,
        valueText: `${Math.round(value)}%`,
        valueClass,
        backgroundClass,
        explanation,
        tooltip: presentation.tooltip ? `${presentation.tooltip} - click for details` : 'Click for details',
        modal: {
          key,
          label,
          scoreText: `Score: ${Math.round(value)}%`,
          descriptionText: presentation.descriptionText,
          criteriaText: presentation.criteriaText,
          detailText: detailMsg,
        },
      });
    }

    const contextSummary = getStabilityContextSummary(
      msg.scoringContext,
      lastLandingData?.aircraftProfileId || lastLandingData?.aircraft_profile_id,
    );
    landingStore.setStabilityBreakdown({
      metrics,
      samplesText: msg.samples ? String(msg.samples) : '',
      contextText: contextSummary.label,
      contextDetail: contextSummary.detail,
      contextGeneric: contextSummary.isGeneric,
    });
  }

  function getRenderedApproachProfileLandingData(msg, landingData) {
    return Object.assign({}, landingData || {}, {
      runwayReferenceElevFt: (landingData && Number.isFinite(landingData.runwayReferenceElevFt))
        ? landingData.runwayReferenceElevFt
        : (Number.isFinite(msg.runwayReferenceElevFt)
          ? msg.runwayReferenceElevFt
          : (Number.isFinite(msg.thresholdElevFt) ? msg.thresholdElevFt : null)),
      thresholdElevFt: (landingData && Number.isFinite(landingData.thresholdElevFt))
        ? landingData.thresholdElevFt
        : (Number.isFinite(msg.thresholdElevFt)
          ? msg.thresholdElevFt
          : (Number.isFinite(msg.runwayReferenceElevFt) ? msg.runwayReferenceElevFt : null)),
    });
  }

  function getApproachProfileGateLabel(msg) {
    const gateAltitude = approachProfileApi.GATE_ALTITUDE_FT;
    const runwayReferenceElevFt = Number.isFinite(msg.runwayReferenceElevFt)
      ? msg.runwayReferenceElevFt
      : (Number.isFinite(msg.thresholdElevFt) ? msg.thresholdElevFt : null);
    const heightResolver = approachProfileApi.createProfileHeightResolver(
      msg.approachProfile || [],
      runwayReferenceElevFt,
    );
    const profileAltitudes = (msg.approachProfile || [])
      .map(heightResolver.heightOf)
      .filter(Number.isFinite);
    if (profileAltitudes.length === 0 || Math.max(...profileAltitudes) * 1.12 < gateAltitude) {
      return '';
    }

    const usingRunwayReference = heightResolver.usesRunwayReference;
    return `Gate: ${gateAltitude} ft ${usingRunwayReference ? 'above runway reference' : 'RA'}`;
  }

  function getTopdownLandingData(msg, landingData) {
    const nextLandingData = Object.assign({}, landingData || {});
    if (!Number.isFinite(nextLandingData.runwayReferenceElevFt)) {
      nextLandingData.runwayReferenceElevFt = Number.isFinite(msg.runwayReferenceElevFt)
        ? msg.runwayReferenceElevFt
        : (Number.isFinite(msg.thresholdElevFt) ? msg.thresholdElevFt : null);
    }
    if (!Number.isFinite(nextLandingData.thresholdElevFt)) {
      nextLandingData.thresholdElevFt = Number.isFinite(msg.thresholdElevFt)
        ? msg.thresholdElevFt
        : (Number.isFinite(msg.runwayReferenceElevFt) ? msg.runwayReferenceElevFt : null);
    }
    if (!Number.isFinite(nextLandingData.runwayHdg) && Number.isFinite(msg.runwayHdg)) nextLandingData.runwayHdg = msg.runwayHdg;
    if (!nextLandingData.runway && msg.runwayId) nextLandingData.runway = msg.runwayId;
    if (!nextLandingData.runwayThreshold && msg.runwayThreshold) nextLandingData.runwayThreshold = msg.runwayThreshold;
    if (!nextLandingData.touchdownDistance && (Number.isFinite(msg.runwayWidthFt) || Number.isFinite(msg.runwayLengthFt))) {
      nextLandingData.touchdownDistance = {};
    }
    if (nextLandingData.touchdownDistance) {
      if (!Number.isFinite(nextLandingData.touchdownDistance.runwayWidthFt) && Number.isFinite(msg.runwayWidthFt)) {
        nextLandingData.touchdownDistance.runwayWidthFt = msg.runwayWidthFt;
      }
      if (!Number.isFinite(nextLandingData.touchdownDistance.runwayLengthFt) && Number.isFinite(msg.runwayLengthFt)) {
        nextLandingData.touchdownDistance.runwayLengthFt = msg.runwayLengthFt;
      }
    }
    return nextLandingData;
  }

  function renderApproachProfile(msg, landingData) {
    const landingStore = getLandingStore();
    if (!landingStore) return;

    const renderedLandingData = getRenderedApproachProfileLandingData(msg, landingData);
    const svgHtml = approachProfileApi.buildSvg(
      msg.approachProfile,
      renderedLandingData,
      { idSuffix: '' },
    );
    const gateLabel = svgHtml ? getApproachProfileGateLabel(msg) : '';

    if (svgHtml) {
      landingStore.setApproachProfile?.({ svgHtml, gateLabel });
    } else {
      landingStore.clearApproachProfile?.();
    }

    renderTopDownProfile(msg, landingData);
  }

  function renderTopDownProfile(msg, landingData) {
    const landingStore = getLandingStore();
    if (!landingStore) return;

    const svgHtml = approachProfileApi.buildTopDownSvg(
      msg.approachProfile,
      getTopdownLandingData(msg, landingData),
      { idSuffix: 'td' },
    );

    if (svgHtml) {
      landingStore.setTopdownProfile?.({ svgHtml });
    } else {
      landingStore.clearTopdownProfile?.();
    }
  }

  function handleLandingMessage(msg) {
    if (msg?.final) showLanding(msg);
  }

  function handleFlightSummaryMessage(msg) {
    renderInflightSummary(msg);
  }

  function handleUltimateStabilityScoreMessage(msg) {
    updateStabilityBreakdown(msg);
  }

  function handleFlightViolationMessage(msg) {
    if (msg?.event === 'start' && msg.counts_as_upset !== false) {
      flightUpsetCount += 1;
      getLandingStore()?.setFlightUpsetCount?.(flightUpsetCount);
    }
  }

  function resetSession() {
    flightUpsetCount = 0;
    lastUltimateStability = null;
    lastLandingData = null;
    landingCardRenderer.clearLandingCard();
    resetDataLandingPreview();
    getLandingStore()?.setFlightUpsetCount?.(flightUpsetCount);
  }

  return {
    handleFlightSummaryMessage,
    handleFlightViolationMessage,
    handleLandingMessage,
    handleUltimateStabilityScoreMessage,
    renderInflightSummary,
    resetSession,
    showLanding,
    showTimelineLanding,
    openTimelineLandingModal,
    showTimelineLandingError,
    updateDataLandingPreview,
  };
}
