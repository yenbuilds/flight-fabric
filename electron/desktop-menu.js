'use strict';

function createDesktopMenuTemplate({ hasTray, isDev, hideWindow, quit, showWindow, resetPlacement, showAbout, openReleases }) {
  return [
    {
      label: '&File',
      submenu: [
        ...(hasTray ? [{ label: 'Hide to Tray', click: hideWindow }] : [{ role: 'close' }]),
        { type: 'separator' },
        { label: 'Quit FlightFabric', click: quit },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: '&View',
      submenu: [
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
        ...(isDev ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: '&Window',
      submenu: [
        { role: 'minimize' }, { label: 'Show FlightFabric', click: showWindow },
        { type: 'separator' }, { label: 'Reset Window Position', click: resetPlacement },
      ],
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Release Notes', click: openReleases },
        { type: 'separator' }, { label: 'About FlightFabric', click: showAbout },
      ],
    },
  ];
}

module.exports = { createDesktopMenuTemplate };
