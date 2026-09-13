# Flight Fabric 0.9.7 · Public Alpha

## [Download for Windows (.exe)](https://github.com/yenbuilds/flight-fabric/releases/download/v0.9.7/Flight.Fabric.Setup.0.9.7.exe)

**Public alpha · Free · Windows 64-bit · Microsoft Flight Simulator 2024**

Still in development. Expect bugs and incomplete aircraft support.

Close Flight Fabric, open the downloaded installer and follow the setup steps.
Then launch Flight Fabric with MSFS 2024 running.

## What's new

- **Runway data ready earlier:** Flight Fabric now requests nearby airport data
  from MSFS while you are on the ground or approaching an airport, helping make
  simulator runway dimensions available for your landing debrief.
- **Clearer landing summaries:** refreshed grade cards, telemetry displays and
  Settings layouts make results and controls easier to read.
- **Focused flight details:** Timeline flight details open in a responsive dialog
  that you can close with Escape or by clicking outside it.
- **Easier control browsing:** clear the aircraft-control filters even while the
  simulator is disconnected.

<details>
<summary><strong>Full release notes</strong></summary>

### Airport data and saved flights

Nearby airport data is requested in the background during normal simulator use,
including after reconnecting. Invalid runway dimensions or coordinates are
rejected, failed requests can be retried, and a failed refresh preserves usable
cached airport data.

Saved flights retain their recorded airport geometry when you revisit them in
Timeline or Logbook. These changes do not replace the geometry in older flights.

### Interface improvements

Landing grade cards, telemetry and Settings have updated spacing and layouts,
including adjustments for smaller screens. Timeline flight details now appear in
a focused dialog with keyboard and click-outside dismissal.

Aircraft-control filters can be reset without a live simulator connection.
Sending a command still requires an available, supported aircraft control.

</details>

<details>
<summary><strong>Known limitations</strong></summary>

Runway data availability depends on the simulator and airport. Database fallback
geometry remains unverified where scoring requires reliable simulator data.
Unavailable target, runway or approach-guidance data remains unscored where
required; a high score does not imply that every criterion was measured.

The experimental aircraft support workbench is temporarily unavailable while it
undergoes further review. Previously saved workbench sessions are retained.

Aircraft mappings have not all completed live simulator testing. PMDG controls
require the matching installed aircraft and working SDK data. Unsupported
commands remain unavailable. Generic SimConnect controls remain best-effort
compatibility controls, and the iniBuilds A330 integration is readback-only.

Blank PMDG IAS/Mach and V/S/FPA windows remain unavailable until the aircraft
provides the corresponding target readback. Setting a target does not open a
cockpit window or engage an autopilot mode.

Voice recognition works only in the Windows desktop app. Push to talk is off
by default and accepts only commands advertised for the active aircraft.

Online maps use OpenStreetMap's community tile service. Flight Fabric does not
prefetch or provide offline tiles. Online map traffic can be disabled in
Settings. MSFS 2020 and X-Plane are not currently supported.

</details>

<details>
<summary><strong>Installation help and optional file verification</strong></summary>

The installer is `Flight.Fabric.Setup.0.9.7.exe`. The **Source code** archives
in GitHub's Assets section are for developers; you only need the installer to
use Flight Fabric.

The current alpha is unsigned, so Windows may show an **Unknown publisher**
warning. Use the official installer linked at the top of this page.

If you want to verify your download, GitHub shows its SHA-256 checksum beside
the installer in **Assets**. This is an optional file-integrity check.

</details>

[Getting started](https://github.com/yenbuilds/flight-fabric#readme) ·
[Licence](https://github.com/yenbuilds/flight-fabric/blob/v0.9.7/LICENSE.md) ·
[Third-party notices](https://github.com/yenbuilds/flight-fabric/blob/v0.9.7/THIRD_PARTY_NOTICES.md)
