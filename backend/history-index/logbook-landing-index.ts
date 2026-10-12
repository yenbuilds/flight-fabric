'use strict';

const {
  createHistorySourceId,
} = require('./source-identity.js') as {
  createHistorySourceId: (_filePath: unknown, _recordingSessionId?: unknown) => string;
};
const {
  logbookOutcomeGrade,
} = require('../landing/flight-logbook.js') as {
  logbookOutcomeGrade: (_entry: AnyRecord) => string | null;
};

type AnyRecord = Record<string, any>;
type CsvFileIdentity = {
  filePath: string;
  mtimeMs: number;
  sizeBytes: number;
  bundleCatalogRevision?: number;
  bundleSizeBytes?: number;
  recordingSessionId?: string;
};

function landingToIndexInput(landing: AnyRecord, source: CsvFileIdentity): AnyRecord {
  const sourceId = createHistorySourceId(source.filePath, source.recordingSessionId);
  const sourceLandingId = typeof landing.id === 'string' && landing.id
    ? landing.id
    : String(landing.timestampMs ?? 0);
  const recordedVsFpm = landing.vsFpm !== null
    && landing.vsFpm !== undefined
    && Number.isFinite(Number(landing.vsFpm))
      ? Number(landing.vsFpm)
      : null;
  const hasKnownNonDescendingRate = recordedVsFpm !== null && recordedVsFpm >= 0;
  const indexedVsFpm = recordedVsFpm !== null && recordedVsFpm < 0 ? recordedVsFpm : null;
  const indexedGrade = hasKnownNonDescendingRate
    ? null
    : (typeof landing.grade === 'string' ? landing.grade : null);
  const indexedOutcomeGrade = hasKnownNonDescendingRate
    ? logbookOutcomeGrade(landing)
    : (typeof landing.outcomeGrade === 'string' ? landing.outcomeGrade : logbookOutcomeGrade(landing));
  return {
    // landing.id is display data and is not guaranteed to be globally unique.
    // Scope the SQLite primary key to the authoritative CSV source while the
    // original id remains intact in payload.
    landingId: `${sourceId}:${sourceLandingId}`,
    flightId: null,
    timestampMs: Number.isFinite(Number(landing.timestampMs)) ? Number(landing.timestampMs) : 0,
    timestamp: typeof landing.timestamp === 'string' && landing.timestamp
      ? landing.timestamp
      : new Date(Number(landing.timestampMs) || 0).toISOString(),
    aircraft: typeof landing.aircraft === 'string' ? landing.aircraft : null,
    aircraftProfileId: typeof landing.aircraftProfileId === 'string' ? landing.aircraftProfileId : null,
    icao: typeof landing.icao === 'string' ? landing.icao : null,
    runway: typeof landing.runway === 'string' ? landing.runway : null,
    vsFpm: indexedVsFpm,
    grade: indexedGrade,
    outcomeGrade: indexedOutcomeGrade,
    gateStable: typeof landing.gateStable === 'boolean' ? landing.gateStable : null,
    stabilityScore:
      landing.stabilityScore !== null
      && landing.stabilityScore !== undefined
      && !(typeof landing.stabilityScore === 'string' && landing.stabilityScore.trim() === '')
      && Number.isFinite(Number(landing.stabilityScore))
        ? Number(landing.stabilityScore)
        : null,
    stabilityVerdict: typeof landing.stabilityVerdict === 'string' ? landing.stabilityVerdict : 'no_verdict',
    stabilityGateFailures: Array.isArray(landing.stabilityGateFailures) ? landing.stabilityGateFailures : [],
    touchdownDistanceFt: Number.isFinite(Number(landing.touchdownDistanceFt)) ? Number(landing.touchdownDistanceFt) : null,
    touchdownDistanceGrade: typeof landing.touchdownDistanceGrade === 'string' ? landing.touchdownDistanceGrade : null,
    runwayExcursion: typeof landing.runwayExcursion === 'boolean' ? landing.runwayExcursion : null,
    shortLanding: typeof landing.shortLanding === 'boolean' ? landing.shortLanding : null,
    payload: landing,
  };
}

module.exports = {
  landingToIndexInput,
};

export {};
