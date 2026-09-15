# Flight Fabric 0.9.9 · Public Alpha

## [Download for Windows (.exe)](https://github.com/yenbuilds/flight-fabric/releases/download/v0.9.9/Flight.Fabric.Setup.0.9.9.exe)

**Public alpha · Free · Windows 64-bit · Microsoft Flight Simulator 2024**

Still in development. Expect bugs and incomplete aircraft support.

When you have finished your flight, close Flight Fabric, open the downloaded
installer and follow the setup steps. Then launch Flight Fabric with MSFS 2024
running.

## What's new

- **Easier phone and tablet pairing:** request aircraft-control access on your
  device, then approve the matching code in Phone setup on your simulator PC.
- **Clearer flight debriefs:** see the approach score alongside recovered cautions,
  and review touchdown distance without a pass/fail label for the optional
  first-1,000-ft target.
- **Strobe and APU fixes:** more consistent strobe voice commands and more reliable
  PMDG 737/777 APU start-switch timing.
- **A simple way to donate:** a small Donate button in the desktop footer opens
  Ko-fi. Website Donate buttons no longer display a fixed amount.

<details>
<summary><strong>Full release notes</strong></summary>

### Phone and tablet setup

Phone setup supports device requests with matching approval codes. On a trusted
private home network, enable phone and tablet access in Settings, save and
restart Flight Fabric, then scan the QR code or enter the short address.
Request aircraft-control access on the device and approve its code on the PC.
Settings also provides clearer guidance for enabling second-screen access.

### Flight debriefs

Landing summaries, Timeline and Logbook show the approach score together with
specific recovered cautions. The recorded assessment remains available in the
details, and serious warnings and insufficient-data results remain explicit.
Touchdown distance and its zone description replace the first-1,000-ft pass/fail
tile. The chart's 1,000 ft aiming-point reference is shown neutrally. Scoring
thresholds, deductions and saved flight results are unchanged.

### Aircraft controls

Voice commands such as "set strobe lights on" and "set strobe lights off" are
recognized consistently across supported aircraft. On the PMDG 737, switching
strobes off keeps steady navigation lights on and leaves an already-OFF switch
alone. PMDG 737 and 777 APU start-switch movements have more time to register
before START is released.

### Donations and maintenance

The desktop footer includes a compact heart-icon Donate button beside
Diagnostics, linking to Yen's Ko-fi page. Both website donation buttons now say
Donate without a fixed amount.

This update also includes connection and recording reliability fixes, dependency
updates and refreshed third-party notices. The previously disabled aircraft
support workbench has been removed; existing saved workbench files are retained.

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

Runway data availability depends on the simulator and airport. Unavailable
target, runway or approach-guidance data remains unscored where required;
a high score does not imply that every criterion was measured.

Online maps use OpenStreetMap's community tile service. Flight Fabric does not
prefetch or provide offline tiles. Online map traffic can be disabled in
Settings. MSFS 2020 and X-Plane are not currently supported.

</details>

<details>
<summary><strong>Installation help and optional file verification</strong></summary>

The installer is `Flight.Fabric.Setup.0.9.9.exe`. The **Source code** archives
in GitHub's Assets section are for developers; you only need the installer to
use Flight Fabric.

The current alpha is unsigned, so Windows may show an **Unknown publisher**
warning. Use the official installer linked at the top of this page.

If you want to verify your download, GitHub shows its SHA-256 checksum beside
the installer in **Assets**. This is an optional file-integrity check.

</details>

[Getting started](https://github.com/yenbuilds/flight-fabric#readme) ·
[Licence](https://github.com/yenbuilds/flight-fabric/blob/v0.9.9/LICENSE.md) ·
[Third-party notices](https://github.com/yenbuilds/flight-fabric/blob/v0.9.9/THIRD_PARTY_NOTICES.md)
