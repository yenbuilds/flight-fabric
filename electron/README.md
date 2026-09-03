# Flight Fabric Electron app

This directory contains the Windows launcher and packaging setup.

## Release artifacts

The `user` release profile builds a Windows installer and a portable test build:

```bash
npm run build
```

Output files:

- `dist/electron/Flight Fabric Setup <version>.exe`
- `dist/electron/Flight Fabric <version>.exe`
- `dist/electron/win-unpacked/Flight Fabric.exe`

`npm run electron:release` runs the packaged smoke, lifecycle, content, and
summary checks. Publish only the installer and `SHA256SUMS.txt`, never the
portable executable. Upload the installer as `Flight.Fabric.Setup.<version>.exe`;
the checksum file uses that name even though the local output uses spaces.

## Features

- Native Windows launcher.
- Backend start, stop, restart, and status reporting.
- One running app instance at a time.
- System tray behavior.
- Local port conflict handling.
- Persistent settings in the Flight Fabric application data folder.

## Development

### Prerequisites

- Node.js 22.12+
- npm
- Windows for packaging Windows executables
- Rust toolchain with `cargo` on `PATH`

Install Rust with Rustup if `cargo --version` fails:

```powershell
winget install --id Rustlang.Rustup -e --source winget
$env:PATH="$env:USERPROFILE\.cargo\bin;$env:PATH"
cargo --version
```

### Quick start

```bash
npm install
npm run electron:install
npm run electron
```

The `electron` script builds the frontend and backend before opening the app.

## Building

The supported local package build is the root build command:

```bash
npm run build
```

`npm run build` and `npm run electron:build -- --profile=user` use the same
script. It validates the user profile and required airport data, builds the
backend, Rust SimConnect sidecar, frontend, and production dependencies, then
creates the installer, portable build, and unpacked app. It also verifies the
package and starts the installer payload's backend from an empty scratch
directory, preventing a stale installation from satisfying the check.

For the first build on a clean machine, run:

```powershell
npm install
npm run electron:install
cargo --version
cargo build --release --manifest-path backend\telemetry-provider\rust-simconnect-sidecar\Cargo.toml
npm run data:sync:required
npm run build
```

Release checks:

```bash
npm run electron:build -- --profile=user
npm run electron:release
npm run test:electron
npm run test:electron:packaged
npm run test:electron:installer-payload
```

Build output goes to `dist/electron/`.

The build removes stale `SHA256SUMS` files before replacing the executables.
Create upload checksums only after the final packaged checks pass.

### Build troubleshooting

#### Missing Rust sidecar executable

If the backend runtime build fails with:

```text
Rust SimConnect sidecar is required but ff-rust-simconnect-sidecar.exe was not found
```

install Rustup, make sure `cargo` is available in the current shell, and build
the sidecar:

```powershell
$env:PATH="$env:USERPROFILE\.cargo\bin;$env:PATH"
cargo build --release --manifest-path backend\telemetry-provider\rust-simconnect-sidecar\Cargo.toml
npm run build:backend:runtime
```

The runtime build accepts the sidecar from one of these paths:

- `backend/telemetry-provider/ff-rust-simconnect-sidecar.exe`
- `backend/telemetry-provider/rust-simconnect-sidecar/target/release/ff-rust-simconnect-sidecar.exe`
- `backend/telemetry-provider/rust-simconnect-sidecar/target/debug/ff-rust-simconnect-sidecar.exe`

#### OurAirports checksum mismatch

The Electron build requires `airports.csv`, `runways.csv`, and
`manifest.json` under `backend/data-sync/data/ourairports/`. The normal command
is:

```bash
npm run data:sync:required
```

If OurAirports publishes newer CSVs before the pinned checksums in
`scripts/sync-aviation-data.js` are updated, sync can fail with a checksum
mismatch. For local development only, refresh the files and manifest without
checksum verification:

```bash
node scripts/sync-aviation-data.js --required-only --skip-verify
```

For a release, update and review the checksum pins; do not use `--skip-verify`.

#### Expected local warnings

Local builds are unsigned unless signing variables are set. The frontend may
warn about legacy scripts; the build copies those compatibility assets.

## Packaged structure

Packaged resources are assembled under Electron's `resources/` directory:

```text
resources/
  backend/
  frontend/
  shared/
  launcher/
```

The build places the backend, production dependencies, frontend, shared assets,
launcher files, and Rust sidecar here.

## Source layout

```text
electron/
  main.js
  preload.js
  build-electron.js
  package.json
  icon.ico
```

### Main process

`main.js`:

- creates the application window
- starts and stops the backend child process
- manages the tray menu
- handles settings IPC
- exposes backend status and log streams
- prevents a second app instance

### Preload script

`preload.js` exposes a limited `window.electronAPI` bridge. Requests use
`ipcRenderer.invoke`, and event listeners return unsubscribe functions.

Common APIs include:

```javascript
window.electronAPI.startBackend();
window.electronAPI.stopBackend();
window.electronAPI.restartBackend();
window.electronAPI.getBackendStatus();
window.electronAPI.getSettings();
window.electronAPI.saveSettings(settings);
window.electronAPI.onBackendStatus(callback);
window.electronAPI.onBackendLog(callback);
```

## Settings

- Settings live in the user's application data folder, for example
  `%APPDATA%/Flight Fabric/Settings/settings.json`.
- Environment variables override the settings file, which overrides the
  defaults included with the app.
- Backend changes take effect after a backend or app restart.
- Electron saves settings through IPC. Browser development pages cannot write
  the settings file directly.

## Remote access

The backend HTTP server defaults to port `8100` and serves the mobile dashboard at:

```text
http://<LAN-IP>:8100/remote?mobile=1
```

Remote access is off by default. Enable `network.remoteAccess` only on a trusted
private network.

Remote browsers are view-only by default. Aircraft controls also require
`network.remoteAircraftControl` and the paired Mobile Browser link shown on the
Flight Fabric PC. Treat its URL and QR code as private. The token expires when
the backend restarts and grants aircraft-control access only; it cannot access
settings, recordings, history, file deletion, or profile management.

If a phone cannot connect:

1. Open `http://localhost:8100/setup` on the simulator PC and use the complete
   paired URL shown there. A setup page opened remotely provides a view only
   link.
2. Confirm `network.remoteAccess` is true.
3. Confirm Windows Firewall allows the active backend process on private
   networks. Packaged releases use `Flight Fabric.exe`; `start-simbridge.bat`
   uses Node.js.
4. Confirm the phone is on the same private Wi-Fi network and device isolation
   is off.
5. Check VPNs, Private Relay, DNS filters, and router security tools. If one is
   blocking the connection, allow the local traffic rather than leaving it off.

## Code signing

For signed production releases, provide:

- `CSC_LINK` and `CSC_KEY_PASSWORD`
- or `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`

Unsigned local builds are expected during development.

## Troubleshooting

### Cannot find module `electron`

Run:

```bash
npm run electron:install
```

### Backend will not start

Run the backend runtime build and Electron smoke test:

```bash
npm run build:backend:runtime
npm run test:electron
```

### Packaged app looks stale

Rebuild the frontend and packaged app:

```bash
npm run build
```

The build includes CSS and frontend assets; no manual Tailwind copy is needed.
