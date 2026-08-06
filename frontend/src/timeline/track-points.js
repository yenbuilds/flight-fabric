function toFiniteAngle(raw) {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function getAngleFromCandidates(...candidates) {
  for (const candidate of candidates) {
    const value = toFiniteAngle(candidate);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

export function getEventAttitudeDeg(event) {
  if (!event || typeof event !== 'object') return { headingDeg: null, pitchDeg: null, rollDeg: null };

  const headingDeg = getAngleFromCandidates(
    event.hdgTrueDeg,
    event.hdg_true_deg,
    event.hdgDeg,
    event.heading,
    event.headingDeg,
    event.context?.hdgTrueDeg,
    event.context?.hdg_true_deg,
    event.context?.hdgDeg,
    event.context?.heading,
    event.context?.headingDeg,
    event.metrics?.hdg_true_deg,
    event.metrics?.hdgDeg,
    event.metrics?.heading,
    event.metrics?.headingDeg,
  );

  const pitchDeg = getAngleFromCandidates(
    event.pitchDeg,
    event.pitch_deg,
    event.pitch,
    event.context?.pitchDeg,
    event.context?.pitch_deg,
    event.context?.pitch,
    event.metrics?.pitchDeg,
    event.metrics?.pitch_deg,
    event.metrics?.pitch,
  );

  const rollDeg = getAngleFromCandidates(
    event.rollDeg,
    event.roll_deg,
    event.roll,
    event.bankDeg,
    event.bank_deg,
    event.bank,
    event.context?.rollDeg,
    event.context?.roll_deg,
    event.context?.roll,
    event.context?.bankDeg,
    event.context?.bank_deg,
    event.context?.bank,
    event.metrics?.rollDeg,
    event.metrics?.roll_deg,
    event.metrics?.roll,
    event.metrics?.bankDeg,
    event.metrics?.bank_deg,
    event.metrics?.bank,
  );

  return { headingDeg, pitchDeg, rollDeg };
}

export function normalizeTimelineTrackPoints(
  timeline,
  {
    isValidCoord,
    getEventPosition,
    getEventAttitude = getEventAttitudeDeg,
  } = {},
) {
  const rawTrack = Array.isArray(timeline?.track) ? timeline.track : [];
  if (rawTrack.length > 0) {
    return rawTrack
      .map((point) => {
        const lat = Number(point?.lat);
        const lon = Number(point?.lon);
        const timestampMs = Number(point?.timestampMs);
        const hdgTrueDeg = Number(point?.hdgTrueDeg);
        const pitchDeg = getAngleFromCandidates(point?.pitchDeg, point?.pitch_deg, point?.pitch, point?.attitude?.pitchDeg, point?.attitude?.pitch);
        const rollDeg = getAngleFromCandidates(point?.rollDeg, point?.roll_deg, point?.roll, point?.bankDeg, point?.bank_deg, point?.bank, point?.attitude?.bankDeg, point?.attitude?.rollDeg);
        const iasKts = Number(point?.iasKts ?? point?.ias_kts);
        const altFt = Number(point?.altFt ?? point?.alt_msl_ft ?? point?.alt_ft);
        if (typeof isValidCoord !== 'function' || !isValidCoord(lat, lon)) return null;
        return {
          lat,
          lon,
          timestampMs: Number.isFinite(timestampMs) ? timestampMs : null,
          hdgTrueDeg: Number.isFinite(hdgTrueDeg) ? hdgTrueDeg : null,
          pitchDeg: Number.isFinite(pitchDeg) ? pitchDeg : null,
          rollDeg: Number.isFinite(rollDeg) ? rollDeg : null,
          iasKts: Number.isFinite(iasKts) ? iasKts : null,
          altFt: Number.isFinite(altFt) ? altFt : null,
        };
      })
      .filter(Boolean);
  }

  const rawEvents = Array.isArray(timeline?.events) ? timeline.events : [];
  return rawEvents
    .map((event) => {
      const pos = typeof getEventPosition === 'function' ? getEventPosition(event) : null;
      if (!pos) return null;
      const timestampMs = Number(event?.timestampMs);
      const { headingDeg, pitchDeg, rollDeg } = getEventAttitude(event);
      const evtIas = Number(event?.ias_kts);
      const evtAlt = Number(event?.alt_msl_ft ?? event?.alt_ft);
      return {
        lat: pos.lat,
        lon: pos.lon,
        timestampMs: Number.isFinite(timestampMs) ? timestampMs : null,
        hdgTrueDeg: Number.isFinite(headingDeg) ? headingDeg : null,
        pitchDeg: Number.isFinite(pitchDeg) ? pitchDeg : null,
        rollDeg: Number.isFinite(rollDeg) ? rollDeg : null,
        iasKts: Number.isFinite(evtIas) ? evtIas : null,
        altFt: Number.isFinite(evtAlt) ? evtAlt : null,
      };
    })
    .filter(Boolean);
}
