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

function finite(value) {
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

export function normalizeStabilityScoringContext(value, fallbackProfileId = null) {
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
    ? ` ${scoredMetrics} of ${totalMetrics} available checks contributed; unavailable signals were excluded.`
    : '';
  return {
    label: `${name || id} - ${reliabilityLabel}${policyLabel ? ` · ${policyLabel}` : ''}`,
    detail: context.available
      ? (reconstructed
          ? `Criteria were reconstructed with the current policy because this older flight did not record a snapshot.${coverageDetail}`
          : `Explanations below use the exact game rules recorded with this approach score.${coverageDetail}`)
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
