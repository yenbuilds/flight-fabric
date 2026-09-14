# Flight Fabric 0.9.8 · Public Alpha

## [Download for Windows (.exe)](https://github.com/yenbuilds/flight-fabric/releases/download/v0.9.8/Flight.Fabric.Setup.0.9.8.exe)

**Public alpha · Free · Windows 64-bit · Microsoft Flight Simulator 2024**

Still in development. Expect bugs and incomplete aircraft support.

When you have finished your flight, close Flight Fabric, open the downloaded
installer and follow the setup steps. Then launch Flight Fabric with MSFS 2024
running.

## What's new

- **Clearer aircraft pages:** presets now have one dedicated section with a
  subtle aviation watermark. Individual cockpit controls are organized into
  related sections, with the full searchable catalogue available in Control library.
- **More reliable NAV voice commands:** say either "set nav radios one zero nine
  decimal five" or "set nav radios one zero nine point five" to request 109.50
  on aircraft that support setting both NAV radios.
- **Landing-light fixes:** PMDG 737 fixed landing lights now move fully ON,
  and switching all landing lights OFF also retracts the retractable lights.
- **Easier-to-read maps:** stronger track, route and aircraft-marker contrast
  helps you follow flights in Live Map and Timeline.

<details>
<summary><strong>Full release notes</strong></summary>

### Aircraft controls and presets

PMDG 737/777, Fenix A32X, FlyByWire A32NX/A380X and iniBuilds A350 pages have
clearer grouping and fewer repeated controls. Presets are visually distinct
from individual switches and settings. Radios and approach settings sit near
flight guidance where supported, and section navigation follows the page order.
The A350 layout also fits narrow phone screens more reliably.

Control library keeps the complete advertised command set searchable without
adding another long section to the aircraft page. Controls retain their
availability checks and explanations when live aircraft data is missing.

### Voice and exterior lighting

NAV command recognition better preserves the complete spoken command when
frequencies are read digit by digit. Both "decimal" and "point" are accepted;
the aircraft's frequency limits still apply. Recognition can vary with the
microphone, background noise and pronunciation.

PMDG 737 landing-light commands use the full switch positions. Supported fixed
exterior-light commands on the iniBuilds L-1011 are reapplied when lamp output
alone cannot confirm all cockpit switch positions.

### Maps and performance

Live Map and Timeline use outlined tracks and clearer route and aircraft
markers. Nearby-airport searches also do less repeated work during a flight.

</details>

<details>
<summary><strong>Known limitations</strong></summary>

Aircraft mappings have not all completed live simulator testing. PMDG controls
require the matching installed aircraft and working SDK data. Unsupported
commands remain unavailable. Generic SimConnect controls remain best-effort
compatibility controls, and the iniBuilds A330 integration is readback-only.

Blank PMDG IAS/Mach and V/S/FPA windows remain unavailable until the aircraft
provides the corresponding target readback. Setting a target does not open a
cockpit window or engage an autopilot mode.

Voice recognition works only in the Windows desktop app. Push to talk is off
by default and accepts only commands advertised for the active aircraft.

The experimental aircraft support workbench is temporarily unavailable while it
undergoes further review. Previously saved workbench sessions are retained.

Runway data availability depends on the simulator and airport. Unavailable
target, runway or approach-guidance data remains unscored where required;
a high score does not imply that every criterion was measured.

Online maps use OpenStreetMap's community tile service. Flight Fabric does not
prefetch or provide offline tiles. Online map traffic can be disabled in
Settings. MSFS 2020 and X-Plane are not currently supported.

</details>

<details>
<summary><strong>Installation help and optional file verification</strong></summary>

The installer is `Flight.Fabric.Setup.0.9.8.exe`. The **Source code** archives
in GitHub's Assets section are for developers; you only need the installer to
use Flight Fabric.

The current alpha is unsigned, so Windows may show an **Unknown publisher**
warning. Use the official installer linked at the top of this page.

If you want to verify your download, GitHub shows its SHA-256 checksum beside
the installer in **Assets**. This is an optional file-integrity check.

</details>

[Getting started](https://github.com/yenbuilds/flight-fabric#readme) ·
[Licence](https://github.com/yenbuilds/flight-fabric/blob/v0.9.8/LICENSE.md) ·
[Third-party notices](https://github.com/yenbuilds/flight-fabric/blob/v0.9.8/THIRD_PARTY_NOTICES.md)
