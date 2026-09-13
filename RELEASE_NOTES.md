# Flight Fabric 0.9.5 · Public Alpha

## [Download for Windows (.exe)](https://github.com/yenbuilds/flight-fabric/releases/download/v0.9.5/Flight.Fabric.Setup.0.9.5.exe)

**Public alpha · Free · Windows 64-bit · Microsoft Flight Simulator 2024**

Still in development. Expect bugs and incomplete aircraft support.

Open the downloaded installer, follow the setup steps, then launch Flight
Fabric with MSFS 2024 running. Close Flight Fabric before installing the update.

Flight Fabric is experimental alpha software for consumer flight simulators.
It is not certified, approved, or intended for real-world aviation. Do not rely
on it for real-world decisions.

## What's new

- **Takeoff lights stay available:** fixed a refresh and reconnect bug that
  could disable supported lighting presets even with a healthy connection.
- **Autopilot controls recover correctly:** the same fix restores supported
  PMDG 737/777 inputs and other aircraft controls when their integration is ready.
- **Coverage across all bundled aircraft:** regression checks cover all 50
  profiles, including integration loss and recovery, desktop and paired browsers.

<details>
<summary><strong>Full release notes</strong></summary>

## Aircraft controls after refresh

A page could receive the current aircraft controls when connecting, then
overwrite them with an older startup snapshot when requesting saved state.
That left takeoff lights, autopilot inputs and other supported controls
disabled after a refresh or focus change.

The saved state now retains capability updates for the exact aircraft and
profile revision. It also retains loss of availability when an integration
disconnects, so unavailable controls remain guarded.

The affected integrations include PMDG 737/777, Fenix A32X, FlyByWire
A32NX/A380X, supported iniBuilds aircraft, Microsoft 737 MAX 8 and Headwind
A330 controls. This fixes availability of existing mappings; it does not add
unsupported commands.

Automated tests cover every bundled profile through startup, individual
integration loss and recovery, and full integration loss and recovery. They
also check typed and spoken autopilot targets and rendered MCP inputs for
all eight PMDG variants.

Release lifecycle tests now use their own temporary profile, ports and launch
lock, allowing verification alongside a running Flight Fabric session.

</details>

<details>
<summary><strong>Known limitations</strong></summary>

Blank PMDG IAS/Mach and V/S/FPA windows remain unavailable until the aircraft
provides the corresponding target readback. Setting a target does not open a
cockpit window or engage an autopilot mode.

Aircraft mappings have not all completed live simulator testing. Automated
tests verify routing and guards, not actual cockpit response or recognition
with every microphone. PMDG controls require the matching installed aircraft
and working SDK data. Unsupported commands remain unavailable.

Generic SimConnect controls remain best-effort compatibility controls. Complex
add-ons can ignore standard events or keep authoritative state elsewhere.
The iniBuilds A330 integration remains readback-only.

Approach scores are aviation-informed game rules. Gate IAS is an estimate,
not the aircraft's selected VAPP/Vref, and unusual approaches can fall outside
the scoring assumptions.

Voice recognition works only in the Windows desktop app. Push to talk is off
by default and accepts only commands advertised for the active aircraft.

Online maps use OpenStreetMap's community tile service. Flight Fabric does not
prefetch or provide offline tiles. Online map traffic can be disabled in
Settings. MSFS 2020 and X-Plane are not currently supported.

</details>

<details>
<summary><strong>Installation help and optional file verification</strong></summary>

The installer is `Flight.Fabric.Setup.0.9.5.exe`. The **Source code** archives
in GitHub's Assets section are for developers; you only need the installer to
use Flight Fabric.

The current alpha is unsigned, so Windows may show an **Unknown publisher**
warning. Use the official installer linked at the top of this page.

If you want to verify your download, GitHub shows its SHA-256 checksum beside
the installer in **Assets**. This is an optional file-integrity check, not an
installation step.

</details>

[Getting started](https://github.com/yenbuilds/flight-fabric#readme) ·
[Safety information](https://github.com/yenbuilds/flight-fabric/blob/v0.9.5/SAFETY-NOTICE.md) ·
[Licence](https://github.com/yenbuilds/flight-fabric/blob/v0.9.5/LICENSE.md) ·
[Third-party notices](https://github.com/yenbuilds/flight-fabric/blob/v0.9.5/THIRD_PARTY_NOTICES.md)
