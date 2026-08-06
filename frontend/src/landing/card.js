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

function normalizeUltimateStability(value) {
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

  const hasData = Number.isFinite(score)
    || Number.isFinite(samples)
    || gateStable !== null
    || gateFailures.length > 0
    || Boolean(breakdown)
    || Boolean(scoringContext);
  if (!hasData) return null;

  return {
    score: Number.isFinite(score) ? score : null,
    samples: Number.isFinite(samples) ? samples : null,
    gateStable,
    gateFailures,
    ...(breakdown ? { breakdown } : {}),
    ...(scoringContext ? { scoringContext } : {}),
  };
}

export function mergeLandingMessageUltimateStability(msg, fallbackUltimateStability) {
  if (!msg || typeof msg !== 'object') return msg;

  const current = normalizeUltimateStability(msg.ultimateStability);
  const fallback = normalizeUltimateStability(fallbackUltimateStability);
  if (!fallback) return msg;

  const currentHasScore = current?.score != null && Number.isFinite(Number(current.score));
  if (currentHasScore) return msg;

  return {
    ...msg,
    ultimateStability: {
      ...(current || {}),
      ...fallback,
    },
  };
}

export function createLandingCardRenderer({
  getLandingStore = () => null,
  getLastUltimateStability = () => null,
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

    const lastUltimateStability = getLastUltimateStability();
    const cardMsg = mergeLandingMessageUltimateStability(msg, lastUltimateStability);
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

    if (lastUltimateStability && lastUltimateStability.breakdown) {
      renderStabilityBreakdown(lastUltimateStability);
    }
    if (lastUltimateStability && lastUltimateStability.approachProfile && lastUltimateStability.approachProfile.length > 0) {
      renderApproachProfile(lastUltimateStability, cardMsg);
    }

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
