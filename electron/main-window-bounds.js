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

module.exports = { getMainWindowBounds };
