// The shareable landing card: a PNG painted straight onto a canvas from the
// same landing-card state the app shows, so the image can never disagree
// with the screen and needs no rendering library. The model builder is pure;
// the painter only needs a 2D context; the actions need a document.

export const LANDING_SHARE_WIDTH = 1200;
export const LANDING_SHARE_HEIGHT = 630;
const LANDING_SHARE_SCALE = 2;
export const LANDING_SHARE_SITE = 'flightfabric.com';
const LANDING_SHARE_ICON_SRC = '/assets/app-icon.png';
export const LANDING_SHARE_MAX_TAGS = 6;

const FONT_UI = '"Aptos", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
const FONT_MONO = '"IBM Plex Mono", "B612 Mono", "SFMono-Regular", Consolas, monospace';

const CARD_BACKGROUND = '#0b1017';
const TILE_BACKGROUND = '#111923';
const TILE_BORDER = '#1f2a37';
const ACCENT = '#00d4ff';
const TEXT = '#e5e7eb';
const TEXT_MUTED = '#8b95a5';
const TEXT_FAINT = '#5b6573';
const DEFAULT_GRADE = '#4a5e74';

// The app expresses tones as Tailwind classes; the image needs colours.
const TONE_COLORS = Object.freeze({
  'text-green-400': '#4ade80',
  'text-green-500': '#22c55e',
  'text-amber-400': '#fbbf24',
  'text-amber-500': '#f59e0b',
  'text-red-400': '#f87171',
  'text-gray-100': '#f3f4f6',
  'text-gray-200': '#e5e7eb',
  'text-gray-300': '#d1d5db',
  'text-gray-400': '#9ca3af',
  'text-gray-500': '#6b7280',
});

export function toneColor(toneClass, fallback = TEXT) {
  const classes = String(toneClass || '').split(/\s+/);
  for (const name of classes) {
    if (TONE_COLORS[name]) return TONE_COLORS[name];
  }
  return fallback;
}

// "--", "-- ft" and "Approach score --" are all the screen's way of saying
// nothing is known; the image leaves those out rather than printing dashes.
function isBlank(value) {
  const text = String(value ?? '').trim();
  if (text === '') return true;
  return /(^|\s)--(\s|$)/.test(text) && !/\d/.test(text);
}

function formatShareDate(capturedAtMs) {
  const ms = Number(capturedAtMs);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  try {
    return new Date(ms).toLocaleString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function filenameStamp(capturedAtMs) {
  const ms = Number(capturedAtMs);
  const date = Number.isFinite(ms) && ms > 0 ? new Date(ms) : new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function filenameSegment(value, fallback) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

export function buildLandingShareModel({
  landingCard = null,
  aircraftName = '',
  profileName = '',
  capturedAtMs = null,
  versionText = '',
} = {}) {
  if (!landingCard || typeof landingCard !== 'object') return null;
  const touchdown = landingCard.touchdown || {};
  const approach = landingCard.approach || {};
  const wind = landingCard.wind || {};
  const debrief = landingCard.debrief || {};

  const icao = isBlank(landingCard.airportText) ? '' : String(landingCard.airportText).trim();
  const runway = isBlank(landingCard.runwayText) ? '' : String(landingCard.runwayText).trim();
  const runwayId = runway.replace(/^RWY\s+/i, '');
  const placeText = [icao || 'Unknown airport', runway].filter(Boolean).join(' · ');

  const grade = isBlank(landingCard.gradeText) ? '' : String(landingCard.gradeText).trim().toUpperCase();
  const vs = isBlank(landingCard.vsText) ? '' : `${String(landingCard.vsText).trim()} fpm`;
  const gforceMatch = String(landingCard.gforceText || '').match(/-?\d+(?:\.\d+)?/);
  const gforce = gforceMatch ? `${gforceMatch[0]} G` : '';
  const rateLine = [vs, gforce].filter(Boolean).join(' · ');

  const name = String(aircraftName || '').trim();
  const profile = String(profileName || '').trim();
  const aircraftText = !isBlank(name) ? name : (!isBlank(profile) ? profile : 'Aircraft');
  const contextText = !isBlank(profile) && profile !== aircraftText ? profile : '';

  const bounceValue = isBlank(touchdown.bounceText) ? '--' : String(touchdown.bounceText).trim();
  const bounceNote = isBlank(touchdown.bounceGradeText)
    || String(touchdown.bounceGradeText).trim().toLowerCase() === bounceValue.toLowerCase()
    ? ''
    : String(touchdown.bounceGradeText).trim();

  let windValue = '--';
  let windNote = '';
  if (wind.available) {
    windValue = wind.calm ? 'CALM' : [wind.directionText, wind.speedText].filter((part) => !isBlank(part)).join(' ');
    windNote = String(wind.crosswindDetailText || '').trim();
  }

  const tiles = [
    {
      key: 'touchdown',
      label: 'Touchdown',
      value: isBlank(touchdown.distanceText) ? '--' : String(touchdown.distanceText).trim(),
      valueColor: TEXT,
      note: isBlank(touchdown.distanceGradeText) ? '' : String(touchdown.distanceGradeText).trim(),
      noteColor: toneColor(touchdown.distanceGradeTone, TEXT_MUTED),
    },
    {
      key: 'approach',
      label: 'Approach',
      value: isBlank(approach.stabilityText) ? '--' : String(approach.stabilityText).trim(),
      valueColor: toneColor(approach.stabilityTone, TEXT),
      note: isBlank(approach.stabilityNoteText) ? '' : String(approach.stabilityNoteText).trim(),
      noteColor: TEXT_MUTED,
    },
    {
      key: 'bounce',
      label: 'Bounce',
      value: bounceValue,
      valueColor: toneColor(touchdown.bounceTone, TEXT),
      note: bounceNote,
      noteColor: toneColor(touchdown.bounceGradeTone, TEXT_MUTED),
    },
    {
      key: 'wind',
      label: 'Wind at touchdown',
      value: windValue || '--',
      valueColor: TEXT,
      note: windNote,
      noteColor: TEXT_MUTED,
    },
  ];

  const tags = (Array.isArray(debrief.reasons) ? debrief.reasons : [])
    .filter((reason) => reason && typeof reason.text === 'string' && reason.text.trim())
    .slice(0, LANDING_SHARE_MAX_TAGS)
    .map((reason) => ({
      text: reason.text.trim(),
      color: reason.color || TEXT,
      backgroundColor: reason.backgroundColor || `${reason.color || TEXT}22`,
      borderColor: reason.borderColor || `${reason.color || TEXT}44`,
    }));

  const confidenceText = isBlank(debrief.confidenceText) ? '' : String(debrief.confidenceText).trim();
  return {
    brandText: 'FlightFabric',
    kickerText: 'LANDING DEBRIEF',
    siteText: LANDING_SHARE_SITE,
    footerText: 'MSFS 2024 simulator debrief',
    versionText: isBlank(versionText) ? '' : String(versionText).trim(),
    aircraftText,
    contextText,
    dateText: formatShareDate(capturedAtMs),
    placeText,
    gradeText: grade || 'NO GRADE',
    gradeColor: grade && landingCard.gradeColor ? String(landingCard.gradeColor) : DEFAULT_GRADE,
    rateLine,
    tiles,
    tags,
    confidenceText,
    confidenceReason: isBlank(debrief.confidenceReason) ? '' : String(debrief.confidenceReason).trim(),
    confidenceColor: toneColor(debrief.confidenceToneClass, TEXT_MUTED),
    filename: `flightfabric-landing-${filenameSegment(icao, 'airport')}-${filenameSegment(runwayId, 'rwy')}-${filenameStamp(capturedAtMs)}.png`,
  };
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function textWidth(ctx, text) {
  const metrics = ctx.measureText(String(text));
  return Number.isFinite(metrics?.width) ? metrics.width : 0;
}

// Cuts text to the available width with an ellipsis rather than overflowing
// the card; every line on the image must stay inside its box.
function fitText(ctx, text, maxWidth) {
  let value = String(text ?? '');
  if (textWidth(ctx, value) <= maxWidth) return value;
  while (value.length > 1 && textWidth(ctx, `${value}…`) > maxWidth) value = value.slice(0, -1);
  return `${value.trimEnd()}…`;
}

function drawText(ctx, text, x, y, { font, color, align = 'left', maxWidth = Infinity, baseline = 'alphabetic', letterSpacing = '' } = {}) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  if ('letterSpacing' in ctx) ctx.letterSpacing = letterSpacing || '0px';
  const value = fitText(ctx, text, maxWidth);
  ctx.fillText(value, x, y);
  return textWidth(ctx, value);
}

function drawBrandMark(ctx, x, y, size, icon) {
  if (icon) {
    ctx.drawImage(icon, x, y, size, size);
    return;
  }
  roundedRect(ctx, x, y, size, size, size * 0.24);
  ctx.fillStyle = ACCENT;
  ctx.fill();
  drawText(ctx, 'FF', x + size / 2, y + size / 2, {
    font: `700 ${Math.round(size * 0.46)}px ${FONT_UI}`, color: CARD_BACKGROUND, align: 'center', baseline: 'middle',
  });
}

export function paintLandingShareCard(ctx, model, {
  width = LANDING_SHARE_WIDTH,
  height = LANDING_SHARE_HEIGHT,
  icon = null,
} = {}) {
  if (!ctx || !model) return false;
  const pad = 56;
  const inner = width - pad * 2;

  ctx.fillStyle = CARD_BACKGROUND;
  ctx.fillRect(0, 0, width, height);
  const bar = ctx.createLinearGradient?.(0, 0, width, 0);
  if (bar && typeof bar.addColorStop === 'function') {
    bar.addColorStop(0, ACCENT);
    bar.addColorStop(1, 'rgba(0, 212, 255, 0)');
    ctx.fillStyle = bar;
  } else {
    ctx.fillStyle = ACCENT;
  }
  ctx.fillRect(0, 0, width, 6);

  // Header: who made it, when, in what.
  const markSize = 40;
  drawBrandMark(ctx, pad, pad, markSize, icon);
  drawText(ctx, model.brandText, pad + markSize + 14, pad + 19, {
    font: `700 26px ${FONT_UI}`, color: '#ffffff', baseline: 'middle',
  });
  drawText(ctx, model.kickerText, pad + markSize + 14, pad + 42, {
    font: `600 12px ${FONT_MONO}`, color: ACCENT, baseline: 'middle', letterSpacing: '2px',
  });
  const headerRightWidth = inner * 0.5;
  if (model.dateText) {
    drawText(ctx, model.dateText, width - pad, pad + 14, {
      font: `400 16px ${FONT_UI}`, color: TEXT_MUTED, align: 'right', baseline: 'middle', maxWidth: headerRightWidth,
    });
  }
  drawText(ctx, model.aircraftText, width - pad, pad + 40, {
    font: `600 20px ${FONT_UI}`, color: TEXT, align: 'right', baseline: 'middle', maxWidth: headerRightWidth,
  });
  if (model.contextText) {
    drawText(ctx, model.contextText, width - pad, pad + 62, {
      font: `400 14px ${FONT_UI}`, color: TEXT_MUTED, align: 'right', baseline: 'middle', maxWidth: headerRightWidth,
    });
  }

  // Place and outcome.
  drawText(ctx, model.placeText, pad, 168, {
    font: `600 34px ${FONT_MONO}`, color: TEXT, baseline: 'middle', maxWidth: inner,
  });
  const gradeWidth = drawText(ctx, model.gradeText, pad, 246, {
    font: `700 84px ${FONT_MONO}`, color: model.gradeColor, baseline: 'middle', maxWidth: inner * 0.62, letterSpacing: '4px',
  });
  if (model.rateLine) {
    drawText(ctx, model.rateLine, pad + gradeWidth + 32, 252, {
      font: `500 30px ${FONT_MONO}`, color: TEXT, baseline: 'middle', maxWidth: Math.max(0, inner - gradeWidth - 32),
    });
  }
  // Four equal-weight facts.
  const tilesTop = 340;
  const tileHeight = 118;
  const gap = 16;
  const tileWidth = (inner - gap * (model.tiles.length - 1)) / model.tiles.length;
  model.tiles.forEach((tile, index) => {
    const x = pad + index * (tileWidth + gap);
    roundedRect(ctx, x, tilesTop, tileWidth, tileHeight, 12);
    ctx.fillStyle = TILE_BACKGROUND;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = TILE_BORDER;
    ctx.stroke();
    const textLeft = x + 18;
    const textMax = tileWidth - 36;
    drawText(ctx, tile.label.toUpperCase(), textLeft, tilesTop + 26, {
      font: `600 11px ${FONT_MONO}`, color: TEXT_FAINT, baseline: 'middle', maxWidth: textMax, letterSpacing: '1.5px',
    });
    drawText(ctx, tile.value, textLeft, tilesTop + 62, {
      font: `600 30px ${FONT_MONO}`, color: tile.valueColor, baseline: 'middle', maxWidth: textMax,
    });
    if (tile.note) {
      drawText(ctx, tile.note, textLeft, tilesTop + 94, {
        font: `400 14px ${FONT_UI}`, color: tile.noteColor, baseline: 'middle', maxWidth: textMax,
      });
    }
  });

  // Factor tags on one line; anything that would not fit is left off rather
  // than squeezed.
  const tagsTop = 486;
  const tagHeight = 32;
  let tagX = pad;
  ctx.font = `500 14px ${FONT_UI}`;
  for (const tag of model.tags) {
    const labelWidth = textWidth(ctx, tag.text);
    const pillWidth = labelWidth + 28;
    if (tagX + pillWidth > pad + inner) break;
    roundedRect(ctx, tagX, tagsTop, pillWidth, tagHeight, 8);
    ctx.fillStyle = tag.backgroundColor;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = tag.borderColor;
    ctx.stroke();
    drawText(ctx, tag.text, tagX + 14, tagsTop + tagHeight / 2 + 1, {
      font: `500 14px ${FONT_UI}`, color: tag.color, baseline: 'middle',
    });
    tagX += pillWidth + 10;
  }

  // Footer: how much to trust it, and where it came from.
  const footerY = height - pad + 4;
  ctx.strokeStyle = TILE_BORDER;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, footerY - 26);
  ctx.lineTo(width - pad, footerY - 26);
  ctx.stroke();
  let footerX = pad;
  if (model.confidenceText) {
    footerX += drawText(ctx, 'Telemetry confidence', footerX, footerY, {
      font: `400 14px ${FONT_UI}`, color: TEXT_MUTED, baseline: 'middle',
    }) + 8;
    footerX += drawText(ctx, model.confidenceText, footerX, footerY, {
      font: `600 14px ${FONT_UI}`, color: model.confidenceColor, baseline: 'middle',
    }) + 10;
    if (model.confidenceReason) {
      footerX += drawText(ctx, `· ${model.confidenceReason}`, footerX, footerY, {
        font: `400 14px ${FONT_UI}`, color: TEXT_FAINT, baseline: 'middle', maxWidth: Math.max(0, inner * 0.5 - (footerX - pad)),
      });
    }
  }
  // A quiet watermark in the footer, clear of the facts and factor tags.
  const siteWidth = drawText(ctx, model.siteText, width - pad, footerY, {
    font: `500 15px ${FONT_UI}`, color: TEXT_FAINT, align: 'right', baseline: 'middle',
  });
  // The confidence line is the honest part, so it is drawn first and the
  // origin line takes only the room that remains beside the site mark.
  const rightText = [model.footerText, model.versionText].filter(Boolean).join(' · ');
  const originRight = width - pad - siteWidth - 20;
  const rightRoom = originRight - footerX - 24;
  if (rightText && rightRoom > 40) {
    drawText(ctx, rightText, originRight, footerY, {
      font: `400 14px ${FONT_UI}`, color: TEXT_MUTED, align: 'right', baseline: 'middle', maxWidth: rightRoom,
    });
  }
  return true;
}

// Same-origin icon; a missing file just means the drawn fallback mark.
function loadLandingShareIcon({ documentRef = document, src = LANDING_SHARE_ICON_SRC, timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const image = documentRef?.createElement?.('img');
      if (!image) {
        finish(null);
        return;
      }
      image.decoding = 'async';
      image.onload = () => finish(image);
      image.onerror = () => finish(null);
      image.src = src;
      setTimeout(() => finish(null), timeoutMs);
    } catch {
      finish(null);
    }
  });
}

export async function renderLandingShareCanvas(model, {
  documentRef = document,
  scale = LANDING_SHARE_SCALE,
  icon = undefined,
} = {}) {
  if (!model) return null;
  const canvas = documentRef?.createElement?.('canvas');
  if (!canvas) return null;
  canvas.width = Math.round(LANDING_SHARE_WIDTH * scale);
  canvas.height = Math.round(LANDING_SHARE_HEIGHT * scale);
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return null;
  const resolvedIcon = icon === undefined ? await loadLandingShareIcon({ documentRef }) : icon;
  if (typeof documentRef?.fonts?.ready?.then === 'function') {
    try { await documentRef.fonts.ready; } catch {}
  }
  ctx.scale(scale, scale);
  paintLandingShareCard(ctx, model, { icon: resolvedIcon });
  return canvas;
}

function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    if (typeof canvas?.toBlob !== 'function') {
      reject(new Error('Canvas export is unavailable.'));
      return;
    }
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('The landing card could not be encoded.'));
    }, 'image/png');
  });
}

export function canCopyLandingShareImage({ navigatorRef = globalThis.navigator, windowRef = globalThis } = {}) {
  return typeof navigatorRef?.clipboard?.write === 'function' && typeof windowRef?.ClipboardItem === 'function';
}

export async function copyLandingShareImage(model, {
  documentRef = document,
  navigatorRef = globalThis.navigator,
  windowRef = globalThis,
  icon = undefined,
} = {}) {
  if (!canCopyLandingShareImage({ navigatorRef, windowRef })) return false;
  // The write must start inside the click's user activation, so the item
  // carries a promise and the canvas renders while the clipboard waits.
  const blob = renderLandingShareCanvas(model, { documentRef, icon }).then((canvas) => {
    if (!canvas) throw new Error('The landing card could not be drawn.');
    return canvasToPngBlob(canvas);
  });
  await navigatorRef.clipboard.write([new windowRef.ClipboardItem({ 'image/png': blob })]);
  return true;
}

export async function saveLandingShareImage(model, {
  documentRef = document,
  windowRef = globalThis,
  icon = undefined,
  revokeAfterMs = 10000,
} = {}) {
  const canvas = await renderLandingShareCanvas(model, { documentRef, icon });
  if (!canvas) return false;
  const blob = await canvasToPngBlob(canvas);
  const urlApi = windowRef?.URL || globalThis.URL;
  if (typeof urlApi?.createObjectURL !== 'function') return false;
  const url = urlApi.createObjectURL(blob);
  const link = documentRef.createElement('a');
  link.href = url;
  link.download = model.filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  documentRef.body?.appendChild?.(link);
  link.click();
  link.remove?.();
  windowRef.setTimeout?.(() => {
    try { urlApi.revokeObjectURL(url); } catch {}
  }, revokeAfterMs);
  return true;
}
