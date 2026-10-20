export function createTimelineProfileController({
  profileCanvas,
  windowRef = window,
} = {}) {
  const PROFILE_RENDER_POINT_LIMIT = 700;
  let profilePoints = [];
  let profileMaxAlt = 1000;
  let profileCursorFrac = 0;

  function downsampleProfilePoints(points, limit = PROFILE_RENDER_POINT_LIMIT) {
    if (!Array.isArray(points) || points.length <= limit) return Array.isArray(points) ? points : [];
    const result = [];
    const step = (points.length - 1) / (Math.max(2, limit) - 1);
    for (let i = 0; i < limit; i += 1) {
      result.push(points[Math.max(0, Math.min(points.length - 1, Math.round(i * step)))]);
    }
    return result;
  }

  function drawProfile() {
    if (!profileCanvas || profilePoints.length < 2) return;
    const dpr = windowRef.devicePixelRatio || 1;
    const rect = profileCanvas.parentElement.getBoundingClientRect();
    const width = Math.round(rect.width * dpr);
    const height = Math.round(rect.height * dpr);
    if (width <= 0 || height <= 0) return;
    if (profileCanvas.width !== width || profileCanvas.height !== height) {
      profileCanvas.width = width;
      profileCanvas.height = height;
    }

    const ctx = profileCanvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);

    const pad = { top: 14 * dpr, bottom: 6 * dpr, left: 4 * dpr, right: 4 * dpr };
    const plotWidth = width - pad.left - pad.right;
    const plotHeight = height - pad.top - pad.bottom;
    if (plotWidth <= 0 || plotHeight <= 0) return;

    const toX = (fraction) => pad.left + fraction * plotWidth;
    const toY = (altitude) => pad.top + plotHeight - (altitude / profileMaxAlt) * plotHeight;

    ctx.beginPath();
    ctx.moveTo(toX(profilePoints[0].x), toY(profilePoints[0].alt));
    for (let i = 1; i < profilePoints.length; i += 1) {
      ctx.lineTo(toX(profilePoints[i].x), toY(profilePoints[i].alt));
    }
    ctx.lineTo(toX(profilePoints[profilePoints.length - 1].x), toY(0));
    ctx.lineTo(toX(profilePoints[0].x), toY(0));
    ctx.closePath();

    const fillGradient = ctx.createLinearGradient(0, pad.top, 0, height - pad.bottom);
    fillGradient.addColorStop(0, 'rgba(0, 212, 255, 0.12)');
    fillGradient.addColorStop(1, 'rgba(0, 212, 255, 0.02)');
    ctx.fillStyle = fillGradient;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(toX(profilePoints[0].x), toY(profilePoints[0].alt));
    for (let i = 1; i < profilePoints.length; i += 1) {
      ctx.lineTo(toX(profilePoints[i].x), toY(profilePoints[i].alt));
    }
    ctx.strokeStyle = 'rgba(0, 212, 255, 0.5)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.stroke();

    if (!profilePoints.length) return;

    const cursorFraction = Math.max(0, Math.min(1, profileCursorFrac));
    let cursorAlt = 0;
    for (let i = 0; i < profilePoints.length - 1; i += 1) {
      if (cursorFraction >= profilePoints[i].x && cursorFraction <= profilePoints[i + 1].x) {
        const segmentFraction = (cursorFraction - profilePoints[i].x) / (profilePoints[i + 1].x - profilePoints[i].x || 1);
        cursorAlt = profilePoints[i].alt + segmentFraction * (profilePoints[i + 1].alt - profilePoints[i].alt);
        break;
      }
    }
    if (cursorFraction >= profilePoints[profilePoints.length - 1].x) {
      cursorAlt = profilePoints[profilePoints.length - 1].alt;
    }

    const cursorX = toX(cursorFraction);
    const cursorY = toY(cursorAlt);

    ctx.beginPath();
    ctx.moveTo(cursorX, pad.top);
    ctx.lineTo(cursorX, height - pad.bottom);
    ctx.strokeStyle = 'rgba(138, 155, 181, 0.2)';
    ctx.lineWidth = 1 * dpr;
    ctx.stroke();

    const scale = 5 * dpr;
    ctx.save();
    ctx.translate(cursorX, cursorY);
    ctx.beginPath();
    ctx.moveTo(-scale * 1.8, 0);
    ctx.lineTo(-scale * 0.3, -scale * 0.2);
    ctx.lineTo(scale * 1.8, -scale * 0.15);
    ctx.lineTo(scale * 1.8, scale * 0.15);
    ctx.lineTo(-scale * 0.3, scale * 0.2);
    ctx.closePath();
    ctx.moveTo(-scale * 0.2, -scale * 0.2);
    ctx.lineTo(scale * 0.4, -scale * 1.0);
    ctx.lineTo(scale * 0.7, -scale * 1.0);
    ctx.lineTo(scale * 0.2, -scale * 0.2);
    ctx.moveTo(-scale * 1.5, 0);
    ctx.lineTo(-scale * 1.2, -scale * 0.8);
    ctx.lineTo(-scale * 0.9, -scale * 0.8);
    ctx.lineTo(-scale * 1.1, -scale * 0.1);
    ctx.fillStyle = '#d4a853';
    ctx.fill();
    ctx.restore();

    const altitudeLabel = `${Math.round(cursorAlt).toLocaleString()} ft`;
    ctx.font = `${8 * dpr}px monospace`;
    ctx.fillStyle = 'rgba(138, 155, 181, 0.7)';
    const labelX = cursorX + 8 * dpr;
    const clampedLabelX = Math.min(labelX, width - ctx.measureText(altitudeLabel).width - 4 * dpr);
    ctx.fillText(altitudeLabel, clampedLabelX, cursorY - 6 * dpr);
  }

  function setPoints(scrubberPoints) {
    if (!Array.isArray(scrubberPoints) || scrubberPoints.length < 2) {
      profilePoints = [];
      return;
    }

    const startMs = scrubberPoints[0].timestampMs;
    const endMs = scrubberPoints[scrubberPoints.length - 1].timestampMs;
    const durationMs = endMs - startMs;
    if (durationMs <= 0) {
      profilePoints = [];
      return;
    }

    let maxAlt = 0;
    profilePoints = downsampleProfilePoints(scrubberPoints)
      .filter((point) => Number.isFinite(point.altFt) && Number.isFinite(point.timestampMs))
      .map((point) => {
        const alt = Math.max(0, point.altFt);
        if (alt > maxAlt) maxAlt = alt;
        return { x: (point.timestampMs - startMs) / durationMs, alt };
      });
    profileMaxAlt = Math.max(maxAlt, 100);
    drawProfile();
  }

  function updateCursorByOffset(offsetMs, startMs, endMs) {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;
    const durationMs = endMs - startMs;
    if (durationMs <= 0) return;
    profileCursorFrac = Math.max(0, Math.min(1, offsetMs / durationMs));
    drawProfile();
  }

  return {
    redraw: drawProfile,
    setPoints,
    updateCursorByOffset,
  };
}
