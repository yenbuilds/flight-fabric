import { emitLandingReceived } from '../app/runtime-signals.js';

const RETIRED_STABILITY_FAILURES = new Set(['spoilers_moved_after_gate']);

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

function normalizeUltimateStability(value, { preserveEmpty = false } = {}) {
  if (!value || typeof value !== 'object') return null;

  const score = value.score != null ? Number(value.score) : NaN;
  const samples = value.samples != null ? Number(value.samples) : NaN;
  const gateFailures = normalizeGateFailures(value.gateFailures);
  const breakdown = value.breakdown && typeof value.breakdown === 'object'
    ? value.breakdown
    : null;
  const scoringContext = value.scoringContext && typeof value.scoringContext === 'object'
    ? value.scoringContext
    : null;
  const gateStable = value.gateStable === true || value.gateStable === false
    ? value.gateStable
    : null;
  const verdict = typeof (value.verdict ?? value.stabilityVerdict) === 'string'
    ? String(value.verdict ?? value.stabilityVerdict).trim().toLowerCase()
    : null;

  const hasData = Number.isFinite(score)
    || Number.isFinite(samples)
    || gateStable !== null
    || Boolean(verdict)
    || gateFailures.length > 0
    || Boolean(breakdown)
    || Boolean(scoringContext);
  if (!hasData && !preserveEmpty) return null;

  return {
    score: Number.isFinite(score) ? score : null,
    samples: Number.isFinite(samples) ? samples : null,
    gateStable,
    ...(verdict ? { verdict } : {}),
    gateFailures,
    ...(breakdown ? { breakdown } : {}),
    ...(scoringContext ? { scoringContext } : {}),
  };
}

export function mergeLandingMessageUltimateStability(msg, fallbackUltimateStability) {
  if (!msg || typeof msg !== 'object') return msg;

  const hasCurrentValue = Object.prototype.hasOwnProperty.call(msg, 'ultimateStability');
  if (hasCurrentValue && (msg.ultimateStability === null || typeof msg.ultimateStability !== 'object')) {
    return msg;
  }

  const currentSource = msg.ultimateStability;
  const current = normalizeUltimateStability(currentSource, { preserveEmpty: true });
  const fallback = normalizeUltimateStability(fallbackUltimateStability);
  if (!fallback) return msg;

  const hasCurrentField = (...keys) => Boolean(currentSource)
    && keys.some((key) => Object.prototype.hasOwnProperty.call(currentSource, key));
  const verdict = hasCurrentField('verdict', 'stabilityVerdict')
    ? current?.verdict ?? null
    : fallback.verdict ?? null;
  const breakdown = hasCurrentField('breakdown')
    ? current?.breakdown ?? null
    : fallback.breakdown ?? null;
  const scoringContext = hasCurrentField('scoringContext')
    ? current?.scoringContext ?? null
    : fallback.scoringContext ?? null;

  return {
    ...msg,
    ultimateStability: {
      score: hasCurrentField('score') ? current?.score ?? null : fallback.score,
      samples: hasCurrentField('samples') ? current?.samples ?? null : fallback.samples,
      gateStable: hasCurrentField('gateStable') ? current?.gateStable ?? null : fallback.gateStable,
      ...(verdict ? { verdict } : {}),
      gateFailures: hasCurrentField('gateFailures')
        ? current?.gateFailures ?? []
        : fallback.gateFailures,
      ...(breakdown ? { breakdown } : {}),
      ...(scoringContext ? { scoringContext } : {}),
    },
  };
}

export function replaceLandingMessageUltimateStability(msg, ultimateStability) {
  if (!msg || typeof msg !== 'object') return msg;

  return {
    ...msg,
    ultimateStability: normalizeUltimateStability(ultimateStability, { preserveEmpty: true }),
  };
}

export function createLandingCardRenderer({
  getLandingStore = () => null,
  getPendingUltimateStability = () => null,
  setLastLandingData = () => {},
  getFlightUpsetCount = () => 0,
  updateDataLandingPreview = () => {},
  renderStabilityBreakdown = () => {},
  renderApproachProfile = () => {},
}) {
  function renderInflightSummary(flightSummary) {
    getLandingStore()?.setInflightSummary?.(flightSummary || null);
  }

  function renderLandingCard(msg) {
    const landingStore = getLandingStore();
    if (!landingStore) return null;

    const pendingUltimateStability = getPendingUltimateStability();
    const cardMsg = mergeLandingMessageUltimateStability(msg, pendingUltimateStability);
    if (cardMsg.final) setLastLandingData(cardMsg);

    updateDataLandingPreview(cardMsg);
    landingStore.applyLandingCardMessage?.(cardMsg, {
      flightUpsetCount: getFlightUpsetCount(),
    });

    emitLandingReceived({
      final: cardMsg?.final === true,
      grade: cardMsg?.grade || '',
      vsFpm: cardMsg?.vs_fpm ?? null,
    });

    const stabilityDetails = pendingUltimateStability || cardMsg.ultimateStability || {};
    renderStabilityBreakdown(stabilityDetails);

    const profileDetails = pendingUltimateStability?.approachProfile?.length > 0
      ? pendingUltimateStability
      : (cardMsg.approachProfile?.length > 0 ? cardMsg : { approachProfile: [] });
    renderApproachProfile(profileDetails, cardMsg);

    renderInflightSummary(cardMsg.flightSummary || null);
    return cardMsg;
  }

  function clearLandingCard() {
    getLandingStore()?.resetLandingCard?.();
  }

  return {
    renderLandingCard,
    renderInflightSummary,
    clearLandingCard,
  };
}
