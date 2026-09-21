// Canvas badges for 3D event markers and airport labels. They reuse the
// timeline marker visuals (glyph, colours, shape) so an event looks the same
// in the 2D and 3D replay views.

const MARKER_PIXEL_RATIO = 2;

function roundedRectPath(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height - r);
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  ctx.lineTo(x + r, y + height);
  ctx.arcTo(x, y + height, x, y + height - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/**
 * Draw an event badge into a canvas. Returns null when 2D canvas drawing is
 * unavailable so callers can skip the marker instead of failing the scene.
 */
export function createEventBadgeCanvas(documentRef, visual) {
  if (!documentRef?.createElement) return null;
  const canvas = documentRef.createElement('canvas');
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return null;

  const glyph = String(visual?.glyph || 'E');
  const fontSize = Math.max(10, Number(visual?.size) || 10) + 2;
  const isPill = visual?.shape === 'pill';
  const width = isPill ? Math.max(30, (glyph.length * fontSize * 0.7) + 14) : Math.max(24, fontSize + 12);
  const height = isPill ? Math.max(20, fontSize + 8) : width;
  canvas.width = Math.ceil(width * MARKER_PIXEL_RATIO);
  canvas.height = Math.ceil(height * MARKER_PIXEL_RATIO);
  ctx.scale(MARKER_PIXEL_RATIO, MARKER_PIXEL_RATIO);

  ctx.save();
  if (visual?.shape === 'diamond') {
    ctx.translate(width / 2, height / 2);
    ctx.rotate(Math.PI / 4);
    roundedRectPath(ctx, -width / 2.9, -height / 2.9, width / 1.45, height / 1.45, 3);
  } else {
    roundedRectPath(ctx, 1.5, 1.5, width - 3, height - 3, isPill ? height / 2 : width / 2);
  }
  ctx.fillStyle = visual?.bg || '#334155';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = visual?.border || '#cbd5e1';
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = visual?.fg || '#f8fafc';
  ctx.font = `700 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, width / 2, height / 2 + 0.5);

  return { canvas, width, height };
}

/** A small text label with a dark backing, used for airport pins. */
export function createLabelCanvas(documentRef, text, { color = '#f2f5f7', background = '#152536' } = {}) {
  if (!documentRef?.createElement) return null;
  const canvas = documentRef.createElement('canvas');
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return null;

  const label = String(text || '').slice(0, 24);
  const fontSize = 12;
  ctx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  const width = Math.ceil(ctx.measureText(label).width) + 14;
  const height = fontSize + 10;
  canvas.width = width * MARKER_PIXEL_RATIO;
  canvas.height = height * MARKER_PIXEL_RATIO;
  ctx.scale(MARKER_PIXEL_RATIO, MARKER_PIXEL_RATIO);
  roundedRectPath(ctx, 0.5, 0.5, width - 1, height - 1, 5);
  ctx.fillStyle = background;
  ctx.fill();
  ctx.fillStyle = color;
  ctx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, width / 2, height / 2 + 0.5);
  return { canvas, width, height };
}
