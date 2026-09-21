'use strict';

// Electron work areas are in device-independent pixels and exclude the taskbar.
// Size the whole native window, leaving room to reach its frame on small screens.
function getMainWindowBounds(workArea) {
  const width = Math.min(1180, Math.max(1, workArea.width - 48));
  const height = Math.min(960, Math.max(1, workArea.height - 48));
  return {
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + Math.floor((workArea.height - height) / 2),
    width,
    height,
    minWidth: Math.min(760, width),
    minHeight: Math.min(520, height),
  };
}

function normalizeBounds(value) {
  if (!value || !['x', 'y', 'width', 'height'].every((key) => (
    Number.isFinite(value[key]) && Math.abs(value[key]) <= 1000000
  )) || value.width < 1 || value.height < 1) return null;
  return Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, Math.round(value[key])]));
}

function normalizeWindowState(value) {
  const bounds = normalizeBounds(value?.bounds);
  if (value?.version !== 1 || !bounds) return null;
  return {
    version: 1,
    bounds,
    maximized: value.maximized === true,
    display: Number.isSafeInteger(value.display?.id) && normalizeBounds(value.display?.workArea)
      ? { id: value.display.id, workArea: normalizeBounds(value.display.workArea) }
      : null,
  };
}

function overlapArea(a, b) {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}

function findDisplayForBounds(bounds, displays, fallback) {
  let best = fallback;
  let largest = 0;
  for (const display of displays) {
    const overlap = overlapArea(bounds, display.workArea);
    if (overlap > largest) {
      largest = overlap;
      best = display;
    }
  }
  return best;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

// Electron coordinates and dimensions already use DIPs. Multiplying by the
// display scale factor would double-scale a restored window on a HiDPI monitor.
function restoreMainWindowState(savedValue, availableDisplays, primaryDisplay) {
  const displays = availableDisplays.filter((display) => normalizeBounds(display.workArea));
  // Remote desktop/display transitions can briefly report no work areas. Keep
  // startup alive; the controller recovers again when a real display appears.
  if (displays.length === 0) displays.push({ id: -1, workArea: { x: 0, y: 0, width: 1280, height: 800 } });
  const primary = displays.find((display) => display.id === primaryDisplay?.id) || displays[0];
  const saved = normalizeWindowState(savedValue);
  const previousDisplay = saved?.display;
  const matchingDisplay = previousDisplay && displays.find((display) => display.id === previousDisplay.id);
  const display = matchingDisplay || (saved && findDisplayForBounds(saved.bounds, displays, primary)) || primary;
  const area = display.workArea;
  const defaults = getMainWindowBounds(area);
  let bounds = { x: defaults.x, y: defaults.y, width: defaults.width, height: defaults.height };
  const minWidth = defaults.minWidth;
  const minHeight = defaults.minHeight;

  if (saved) {
    const width = clamp(saved.bounds.width, minWidth, area.width);
    const height = clamp(saved.bounds.height, minHeight, area.height);
    let { x, y } = saved.bounds;
    if (matchingDisplay && previousDisplay.workArea) {
      // Preserve the relative location when the same monitor moves, rotates,
      // changes scaling, or gains a taskbar on a different edge.
      const oldArea = previousDisplay.workArea;
      for (const [axis, dimension, nextDimension] of [['x', 'width', width], ['y', 'height', height]]) {
        const oldSpace = oldArea[dimension] - saved.bounds[dimension];
        const fraction = oldSpace > 0 ? clamp((saved.bounds[axis] - oldArea[axis]) / oldSpace, 0, 1) : 0.5;
        const coordinate = Math.round(area[axis] + fraction * (area[dimension] - nextDimension));
        if (axis === 'x') x = coordinate;
        else y = coordinate;
      }
    } else if (overlapArea(saved.bounds, area) === 0) {
      x = area.x + Math.floor((area.width - width) / 2);
      y = area.y + Math.floor((area.height - height) / 2);
    }
    bounds = {
      x: clamp(x, area.x, area.x + area.width - width),
      y: clamp(y, area.y, area.y + area.height - height),
      width,
      height,
    };
  }

  return {
    version: 1,
    bounds,
    maximized: saved?.maximized === true,
    display: { id: display.id, workArea: { ...area } },
    windowOptions: { ...bounds, minWidth, minHeight },
  };
}

module.exports = { getMainWindowBounds, normalizeBounds, normalizeWindowState, findDisplayForBounds, restoreMainWindowState };
