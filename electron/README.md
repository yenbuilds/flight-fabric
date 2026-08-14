# Flight Fabric Electron app

This directory contains the Windows launcher and packaging configuration.

## Release artifacts

The `user` release profile produces a Windows installer and a local portable
build used for packaging tests:

```bash
npm run build
```

Output files:

- `dist/electron/Flight Fabric Setup <version>.exe`
- `dist/electron/Flight Fabric <version>.exe`
- `dist/electron/win-unpacked/Flight Fabric.exe`

`npm run electron:release` also runs packaged smoke tests, backend lifecycle
checks, final content verification, and the release summary. Publish only the
installer and `SHA256SUMS.txt`; never upload the portable executable. Stage the
installer for GitHub as `Flight.Fabric.Setup.<version>.exe`; the checksum file
uses that exact published filename even though the local builder output keeps
spaces.

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
build script. It:

1. validates the `user` release profile;
2. checks the required OurAirports data and runs
   `scripts/sync-aviation-data.js --required-only` when airport/runway CSVs or
   their manifest are missing or stale;
3. compiles the backend into `dist/backend/`;
4. builds and copies the Rust SimConnect sidecar;
5. copies production backend dependencies;
6. builds the frontend into `frontend-dist/`;
7. packages installer, portable, and unpacked Windows builds;
8. verifies the packaged contents; and
9. extracts the installer into an empty scratch directory and launches that
   payload's backend, so a build cannot rely on files left by an older install.

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

The build removes old `SHA256SUMS` files before replacing the executables. Create
upload checksums only after the final packaged checks pass.

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

If OurAirports has published newer CSVs and the pinned checksums in
`scripts/sync-aviation-data.js` have not been updated yet, the sync command can
fail with a checksum mismatch. For local development only, refresh the required
files and manifest without checksum verification:

```bash
node scripts/sync-aviation-data.js --required-only --skip-verify
```

For release work, update and review the checksum pins instead of relying on
`--skip-verify`.

#### Expected local warnings

Local builds are unsigned unless signing variables are set. The frontend may
also warn about older scripts and Leaflet images; the build copies those assets
for compatibility.

## Packaged structure

Packaged resources are assembled under Electron's `resources/` directory:

```text
resources/
  backend/
  frontend/
  shared/
  launcher/
```

The build copies the backend, production dependencies, frontend, shared assets,
launcher files, and Rust sidecar into this directory.

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

Remote access is disabled by default. Enable `network.remoteAccess` only for a
trusted device on your private network.

Remote browsers can only view data by default. Aircraft controls require the
separate `network.remoteAircraftControl` setting and the paired Mobile Browser
link shown on the Flight Fabric PC. Treat that URL and QR code as private. Its
random token expires when the backend restarts and grants access only to
aircraft controls, not settings, recordings, history, file deletion, or profile
management.

If a phone cannot connect:

1. Open `http://localhost:8100/setup` on the simulator PC and use the complete
   paired URL shown there. A setup page opened remotely provides a view only
   link.
2. Confirm `network.remoteAccess` is true.
3. Confirm Windows Firewall allows the active backend process on private
   networks. Packaged releases use `Flight Fabric.exe`; `start-simbridge.bat`
   uses Node.js.
4. Confirm the phone is on the same private Wi-Fi network and that device
   isolation is disabled.
5. Check VPNs, Private Relay, DNS filters, and router security tools. If turning
   one off fixes the connection, review its logs and allow the local traffic.

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
