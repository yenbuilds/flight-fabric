# Flight Fabric

Flight Fabric is an experimental alpha desktop companion for airline flying in
MSFS 2024. It turns simulator telemetry into flight debriefs, landing analysis,
timelines, and live monitoring.

Flight Fabric is not certified, approved, or intended for real-world aviation.
Do not rely on it for real-world operations, navigation, training, or safety
decisions.

## Unsigned Alpha Builds

Flight Fabric is free, experimental alpha software. Its Windows builds are not
currently code signed, so Windows SmartScreen or antivirus software may show an
**Unknown publisher** warning.

Only download Flight Fabric from the official GitHub release page. Verify the
published SHA-256 checksum for the installer or portable executable before
running it. If the file came from another source or its checksum does not
match, do not run it.

Please review the [safety notice](SAFETY-NOTICE.md) and
[GNU AGPL](LICENSE.md).

## License and Corresponding Source

Flight Fabric is free software licensed under the GNU Affero General Public
License version 3 only (`AGPL-3.0-only`). The complete corresponding source for
released versions is available from the
[Flight Fabric releases page](https://github.com/yenbuilds/flight-fabric/releases),
where users can select the release matching the version shown in the app. The
desktop and browser interfaces also display this source link.

Third-party component notices, source links, and applicable license terms are
documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Requirements

- Node.js 22.12+
- npm
- Windows for the full Electron and MSFS workflow
- Microsoft Flight Simulator 2024 for the supported SimConnect telemetry path.
  Microsoft Flight Simulator 2020 is not a tested or supported target; it may
  provide some features through SimConnect, but compatibility is not guaranteed.
- The Microsoft Flight Simulator 2024 SDK when building the Windows Electron
  app from public source (see **Provide SimConnect.dll** below).
- Rust toolchain with `cargo` on `PATH`
- Visual Studio Build Tools 2022 or newer with the "Desktop development with
  C++" workload, or another MSVC toolchain that provides `link.exe`

## Installation

Install Rust before running backend runtime builds, tests, or Electron
packaging. The build scripts compile the required SimConnect sidecar from
`backend/telemetry-provider/rust-simconnect-sidecar/`, so `cargo` must be
available on `PATH`.

```bash
cargo --version
```

On Windows, Rust also needs the Microsoft C++ linker from Visual Studio Build
Tools. After installing the build tools, open a new terminal and confirm the
linker is visible:

```powershell
Get-Command link.exe
```

Install the root, backend, frontend, and Electron dependencies:

```bash
npm install
npm --prefix backend install
npm run frontend:install
npm run electron:install
```

Fetch the required local airport/runway data before launching the backend
directly with `start-simbridge.bat` or running the complete test suite:

```bash
npm run data:sync:required
```

### Provide SimConnect.dll

`SimConnect.dll` is not included in the public source mirror because its
redistribution terms are currently uncertain. The DLL remains Microsoft's
proprietary runtime and is not licensed under Flight Fabric's AGPL. To build the
Windows Electron app, obtain your own copy from an SDK installation that you
are entitled to use:

1. In Microsoft Flight Simulator 2024, enable **Developer Mode** under the
   General options.
2. From the Developer Mode toolbar, select **Help** -> **SDK Installer**, then
   install the SDK. See Microsoft's
   [SDK installation documentation](https://docs.flightsimulator.com/msfs2024/html/1_Introduction/SDK_Overview.htm)
   for details.
3. Locate `SimConnect.dll`, normally at:

   ```text
   C:\MSFS 2024 SDK\SimConnect SDK\lib\SimConnect.dll
   ```

The Electron build detects that default SDK location automatically. For a
custom SDK location, either copy the DLL to:

```text
backend\telemetry-provider\simconnect\SimConnect.dll
```

or set `FF_SIMCONNECT_DLL_PATH` to its absolute path before building:

```powershell
$env:FF_SIMCONNECT_DLL_PATH = 'D:\path\to\SimConnect.dll'
npm run build
```

An existing DLL at the repository path above takes priority. If it is absent,
the build checks `FF_SIMCONNECT_DLL_PATH` and then installed SDK locations. The
build logs the selected source and SHA-256 checksum.

Do not commit the DLL to a public fork. Review and comply with the
[Microsoft Flight Simulator SDK licence](https://docs.flightsimulator.com/msfs2024/html/1_Introduction/SDK_EULA.htm)
that applies to your SDK installation.

## Build and Run

Run the Electron app from source:

```bash
npm run electron
```

Build the packaged Windows app:

```bash
npm run build
```

Packaged output is written to `dist/electron`.

## Mobile Devices on Your LAN

Flight Fabric can serve the dashboard to a phone, tablet, or second computer on
the same trusted private network as your simulator PC. Enable **Allow trusted
LAN access** under **Settings** -> **Network**, then open
`http://localhost:8100/setup` on the simulator PC and use the complete URL or QR
code shown there.

Treat a paired aircraft-control URL as private; its session token expires when
the backend restarts. If the page does not load, confirm both devices are on the
same private LAN and that Windows Firewall allows Flight Fabric's configured
HTTP port.

## OBS Widget Overlays

Flight Fabric serves stream widgets from its local HTTP server. Start Flight
Fabric, add an OBS **Browser Source**, leave **Local file**
unchecked, and use these URLs:

```text
http://localhost:8100/widgets-compact/widget-top.html
http://localhost:8100/widgets-compact/widget-bottom.html
```

## AI Use

Read a short note on [how Flight Fabric uses AI](AI_POLICY.md).
