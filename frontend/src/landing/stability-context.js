const PROFILE_RELIABILITY_LABELS = {
  authoritative: 'Authoritative profile',
  profile: 'Profile-based estimate',
  generic: 'Generic estimate',
  unavailable: 'Limited data',
};

export const HIDDEN_STABILITY_METRICS = new Set([
  'spoilers_ok',
  'thrust_not_idle_ok',
  'thrust_stable_ok',
]);

const STABILITY_FAILURE_LABELS = {
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
  incomplete_gate_coverage: 'recording started too far below the approach gate',
  path_rate_steep_after_gate: 'descent rate steeper than target after the gate',
  path_rate_shallow_after_gate: 'descent rate shallower than target after the gate',
  glideslope_unstable_after_gate: 'glideslope deviation after the gate',
  localizer_unstable_after_gate: 'localizer deviation after the gate',
  approach_warning: 'severe or sustained approach violation',
  approach_caution: 'approach caution recorded',
};

export function stabilityFailureLabel(value) {
  const key = String(value || '').trim();
  return STABILITY_FAILURE_LABELS[key]
    || key.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatNumber(value, maximumFractionDigits = 2) {
  const numeric = finite(value);
  if (numeric == null) return '--';
  const rounded = Number(numeric.toFixed(maximumFractionDigits));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function signed(value) {
  const numeric = finite(value);
  if (numeric == null) return '--';
  return `${numeric > 0 ? '+' : ''}${formatNumber(numeric)}`;
}

function profileIdFromFallback(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const segments = text.split(/[/:]/).filter(Boolean);
  return segments[segments.length - 1] || text;
}

function normalizeStabilityScoringContext(value, fallbackProfileId = null) {
  const raw = value && typeof value === 'object' ? value : null;
  const profile = raw?.profile && typeof raw.profile === 'object' ? raw.profile : null;
  const criteria = raw?.criteria && typeof raw.criteria === 'object' ? raw.criteria : null;
  const reference = raw?.reference && typeof raw.reference === 'object' ? raw.reference : null;
  const policy = raw?.policy && typeof raw.policy === 'object' ? raw.policy : null;
  const coverage = raw?.coverage && typeof raw.coverage === 'object' ? raw.coverage : null;
  const fallbackId = profileIdFromFallback(fallbackProfileId);
  const id = String(profile?.id || fallbackId || '').trim() || null;
  const name = String(profile?.name || '').trim() || (id === 'generic' ? 'Generic Aircraft' : id);
  const reliability = String(profile?.reliability || '').trim()
    || (id === 'generic' ? 'generic' : (raw ? 'profile' : ''));
  return {
    available: Boolean(raw && criteria),
    criteriaSource: String(raw?.criteriaSource || 'recorded'),
    criteria,
    reference,
    policy,
    coverage,
    assessment: raw?.assessment?.version === 4 && raw.assessment.rules && typeof raw.assessment.rules === 'object'
      ? raw.assessment : null,
    profile: { id, name, reliability },
  };
}

export function getStabilityContextSummary(value, fallbackProfileId = null) {
  const context = normalizeStabilityScoringContext(value, fallbackProfileId);
  const { id, name, reliability } = context.profile;
  if (!id && !name) {
    return {
      label: 'Legacy scoring result',
      detail: 'Exact profile criteria were not recorded for this flight.',
      isGeneric: false,
      isLegacy: true,
    };
  }

  const reliabilityLabel = PROFILE_RELIABILITY_LABELS[reliability]
    || (id === 'generic' ? PROFILE_RELIABILITY_LABELS.generic : PROFILE_RELIABILITY_LABELS.profile);
  const reconstructed = context.criteriaSource === 'reconstructed';
  const policyName = String(context.policy?.name || '').trim();
  const policyVersion = finite(context.policy?.version);
  const policyLabel = policyName
    ? `${policyName}${policyVersion == null ? '' : ` v${policyVersion}`}`
    : null;
  const scoredMetrics = finite(context.coverage?.scoredMetrics);
  const totalMetrics = finite(context.coverage?.totalMetrics);
  const coverageDetail = scoredMetrics != null && totalMetrics != null
    ? ` ${scoredMetrics} of ${totalMetrics} ${context.assessment ? 'scoring groups' : 'available checks'} contributed; unavailable signals were excluded.`
    : '';
  const groupNames = { configuration: 'Configuration', speed: 'Speed', vertical: 'Vertical profile', attitude: 'Attitude', thrust: 'Throttle movement', alignment: 'Alignment' };
  const contributions = Object.entries(context.assessment?.groups || {})
    .filter(([, group]) => typeof group.pointsLost === 'number' && group.pointsLost > 0)
    .map(([key, group]) => `${groupNames[key] || key} −${group.pointsLost.toFixed(1)}`);
  const assessmentDetail = context.assessment
    ? ` Quality reflects deviation size and elapsed time, with extra weight below ${context.assessment.rules.lowHeightFt} ft. Related checks share a contribution.${contributions.length ? ` Points lost: ${contributions.join('; ')}.` : ''} Cautions affect the approach verdict; severe violations prevent a stable verdict.`
    : '';
  return {
    label: `${name || id} - ${reliabilityLabel}${policyLabel ? ` · ${policyLabel}` : ''}`,
    detail: context.available
      ? (reconstructed
          ? `Criteria were reconstructed with the current policy because this older flight did not record a snapshot.${coverageDetail}${assessmentDetail}`
          : `Explanations below use the exact game rules recorded with this approach score.${coverageDetail}${assessmentDetail}`)
      : 'Exact criteria were not saved with this older result; the profile name is shown for context only.',
    isGeneric: id === 'generic' || reliability === 'generic',
    isLegacy: !context.available || reconstructed,
  };
}

export function getStabilityMetricPresentation(key, value, fallback = {}) {
  const context = normalizeStabilityScoringContext(value);
  const criteria = context.criteria;
  if (!criteria) return fallback;

  const gate = finite(criteria.gateRaFt);
  const floor = 50;
  const gateText = gate == null ? 'the stability gate' : `${gate} ft gate`;
  const speedMinus = finite(criteria.speedMinusKts);
  const speedPlus = finite(criteria.speedPlusKts);
  const gateIas = finite(context.reference?.gateIasKts);
  const speedBand = speedMinus == null || speedPlus == null
    ? null
    : gateIas == null
      ? `-${formatNumber(speedMinus)}/+${formatNumber(speedPlus)} kt from gate IAS`
      : `${formatNumber(gateIas - speedMinus, 1)}-${formatNumber(gateIas + speedPlus, 1)} kt (gate IAS ${formatNumber(gateIas, 1)} kt; -${formatNumber(speedMinus)}/+${formatNumber(speedPlus)})`;
  const vsMin = finite(criteria.vsMinFpm);
  const vsMax = finite(criteria.vsMaxClimbFpm);
  const pathAngle = finite(criteria.glidepathAngleDeg);
  const pathDelta = finite(criteria.glidepathVsDeltaMaxFpm);
  const speedTrend = finite(criteria.speedTrendMaxKtsPerSec);
  const thrustTrend = finite(criteria.thrustStableMaxPctPerSec);
  const pitchMin = finite(criteria.pitchMinDeg);
  const pitchMax = finite(criteria.pitchMaxDeg);
  const bankMax = finite(criteria.bankMaxDeg);
  const passPct = finite(criteria.passPct);

  const presentations = {
    config_ok: {
      desc: `Aggregate configuration check at and below the ${gateText}. Gear and flaps must both pass.`,
      criteria: `Gear and flaps both pass; configuration failures can cap the approach score.`,
    },
    gear_ok: {
      desc: `Gear must be down at the ${gateText} and its raw value must not change before touchdown.`,
      criteria: `Gear down at ${gateText} and unchanged afterwards.`,
    },
    flaps_ok: {
      desc: `Flaps must be in a landing configuration at the ${gateText} and must not change before touchdown.`,
      criteria: `Landing flaps at ${gateText} and unchanged afterwards.`,
    },
    speed_ok: {
      desc: `IAS is compared with the IAS actually observed at the ${gateText}; flare speed bleed below ${floor} ft is excluded.`,
      criteria: speedBand ? `IAS ${speedBand}, from the gate to ${floor} ft AAL.` : fallback.criteriaText,
    },
    speed_trend_ok: {
      desc: `IAS change is measured over rolling one-second windows from the gate to ${floor} ft AAL.`,
      criteria: speedTrend == null ? fallback.criteriaText : `Absolute IAS trend <= ${speedTrend} kt/sec down to ${floor} ft AAL.`,
    },
    vs_ok: {
      desc: `Vertical speed is checked below the ${gateText}.`,
      criteria: vsMin == null || vsMax == null ? fallback.criteriaText : `V/S ${signed(vsMin)} to ${signed(vsMax)} fpm below the gate.`,
    },
    glidepath_ok: {
      desc: 'This is a path-rate proxy based on ground speed and one-second average vertical speed, not an ILS/PAPI position measurement.',
      criteria: pathAngle == null || pathDelta == null ? fallback.criteriaText : `Average V/S within ${pathDelta} fpm of the ${pathAngle} deg target path, down to ${floor} ft AAL.`,
    },
    glidepath_below_ok: {
      desc: 'This directional proxy detects descent rate steeper than the target; it does not establish geometric position below a glideslope.',
      criteria: pathAngle == null || pathDelta == null ? fallback.criteriaText : `No more than ${pathDelta} fpm steeper than the ${pathAngle} deg target path.`,
    },
    glidepath_above_ok: {
      desc: 'This directional proxy detects descent rate shallower than the target; it does not establish geometric position above a glideslope.',
      criteria: pathAngle == null || pathDelta == null ? fallback.criteriaText : `No more than ${pathDelta} fpm shallower than the ${pathAngle} deg target path.`,
    },
    thrust_ok: {
      desc: `Throttle/engine-percent movement is measured over rolling one-second windows from the gate to ${floor} ft AAL. It is not an idle-thrust check.`,
      criteria: thrustTrend == null ? fallback.criteriaText : `Rolling one-second absolute throttle/engine-percent trend <= ${thrustTrend} percentage points/sec.`,
    },
    pitch_ok: {
      desc: `Pitch is checked below the ${gateText} using the recorded scoring-policy limits.`,
      criteria: pitchMin == null || pitchMax == null ? fallback.criteriaText : `Pitch ${signed(pitchMin)} deg to ${signed(pitchMax)} deg below the gate.`,
    },
    bank_ok: {
      desc: `Bank magnitude is checked below the ${gateText}.`,
      criteria: bankMax == null ? fallback.criteriaText : `Absolute bank <= ${bankMax} deg below the gate.`,
    },
    lateral_offset_ok: {
      desc: 'Touchdown lateral offset is scored only when trusted runway geometry is available.',
      criteria: passPct == null ? fallback.criteriaText : `The lateral score passes at ${passPct}% or higher.`,
    },
  };

  const presentation = presentations[key];
  if (context.assessment?.version === 4) {
    const rules = context.assessment.rules;
    const graded = {
      speed_ok: [`IAS is compared with recorded gate IAS, which is an estimate rather than a verified VAPP.`, `Ideal IAS ${speedBand}; deductions increase gradually outside this band, reaching full severity a further ${rules.speedWarningMarginKts} kt outside it.`],
      speed_trend_ok: ['Speed changes are assessed over one second and share the speed contribution with IAS deviation.', `Ideal trend ≤${speedTrend} kt/s; greater changes have a gradual effect.`],
      vs_ok: ['Sink rate and path guidance share one vertical contribution; overlapping deviations use the greater penalty.', `Ideal V/S ${signed(vsMin)} to ${signed(vsMax)} fpm, adjusted for supported steep approaches. Full severity a further ${rules.sinkWarningMarginFpm} fpm outside the band.`],
      glidepath_ok: ['Groundspeed and smoothed vertical speed estimate the path rate. A valid glideslope signal takes precedence in the vertical contribution.', `Ideal rate within ${pathDelta} fpm of the ${pathAngle}° target; caution beyond ${pathDelta + rules.pathCautionMarginFpm} fpm. Quality decreases gradually beyond the ideal band.`],
      glidepath_below_ok: ['Directional path-rate detail; no separate scoring contribution and no claim about position below a glideslope.', `Ideal rate no more than ${pathDelta} fpm steeper than the target; deviations are graded gradually.`],
      glidepath_above_ok: ['Directional path-rate detail; no separate scoring contribution and no claim about position above a glideslope.', `Ideal rate no more than ${pathDelta} fpm shallower than the target; deviations are graded gradually.`],
      thrust_ok: ['Throttle/engine-percent movement is measured over one second. This is not an idle-thrust check.', `Ideal movement ≤${thrustTrend} percentage points/s; greater movement has a gradual effect.`],
      pitch_ok: ['Pitch and bank share the attitude contribution; overlapping deviations use the greater penalty.', `Ideal pitch ${signed(pitchMin)}° to ${signed(pitchMax)}°; full severity a further ${rules.pitchWarningMarginDeg}° outside the band.`],
      bank_ok: ['Pitch and bank share the attitude contribution; overlapping deviations use the greater penalty.', `Ideal bank within ${bankMax}°; full severity a further ${rules.bankWarningMarginDeg}° outside the band.`],
      glideslope_ok: ['Scored only with a valid glideslope receiver signal. Replaces the path-rate estimate in the vertical contribution.', `Ideal within ${rules.navigationCautionDots} dot; full severity at ${rules.navigationWarningDots} dots.`],
      localizer_ok: ['Scored only with a valid localizer signal. Shares alignment with trusted touchdown lateral offset; the lower quality applies.', `Ideal within ${rules.navigationCautionDots} dot; full severity at ${rules.navigationWarningDots} dots.`],
    }[key];
    if (graded) {
      const continuesToTouchdown = ['vs_ok', 'pitch_ok', 'bank_ok'].includes(key);
      const heightSource = context.reference?.altitudeSource === 'radio' ? 'radio height (AAL unavailable)' : 'AAL';
      const window = `From ${gate} ft ${heightSource} to ${continuesToTouchdown ? 'touchdown' : `${rules.flareHeightFt} ft`}.`;
      return { ...fallback, descriptionText: `${graded[0]} Quality is weighted by elapsed time, ×${rules.lowHeightWeight} below ${rules.lowHeightFt} ft. ${window}`,
        criteriaText: graded[1], tooltip: graded[1] };
    }
  }
  if (!presentation) return fallback;
  return {
    ...fallback,
    descriptionText: presentation.desc || fallback.descriptionText,
    criteriaText: presentation.criteria || fallback.criteriaText,
    tooltip: presentation.criteria || fallback.tooltip,
  };
}

export function getStabilityMetricShortCriterion(key, value) {
  const context = normalizeStabilityScoringContext(value);
  const criteria = context.criteria;
  if (!criteria) return '';
  const gate = finite(criteria.gateRaFt);
  switch (key) {
    case 'speed_ok':
      return `-${finite(criteria.speedMinusKts)}/+${finite(criteria.speedPlusKts)} kt from gate IAS`;
    case 'speed_trend_ok':
      return `<=${finite(criteria.speedTrendMaxKtsPerSec)} kt/s`;
    case 'vs_ok':
      return `${signed(criteria.vsMinFpm)} to ${signed(criteria.vsMaxClimbFpm)} fpm`;
    case 'glidepath_ok':
    case 'glidepath_below_ok':
    case 'glidepath_above_ok':
      return `${finite(criteria.glidepathAngleDeg)} deg +/-${finite(criteria.glidepathVsDeltaMaxFpm)} fpm`;
    case 'pitch_ok':
      return `${signed(criteria.pitchMinDeg)} to ${signed(criteria.pitchMaxDeg)} deg`;
    case 'bank_ok':
      return `<=${finite(criteria.bankMaxDeg)} deg`;
    case 'gear_ok':
    case 'flaps_ok':
    case 'config_ok':
      return gate == null ? '' : `${gate} ft gate`;
    case 'thrust_ok':
      return `<=${finite(criteria.thrustStableMaxPctPerSec)} %/s movement`;
    default:
      return '';
  }
}
