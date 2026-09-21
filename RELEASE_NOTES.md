# FlightFabric 0.10.0 · Public Alpha

## [Download for Windows (.exe)](https://github.com/yenbuilds/flight-fabric/releases/download/v0.10.0/FlightFabric.Setup.0.10.0.exe)

**Public alpha · Free · Windows 64-bit · Microsoft Flight Simulator 2024**

Still in development. Expect bugs and incomplete aircraft support.

Finish your flight and close FlightFabric, then run the downloaded installer.
Launch FlightFabric again with MSFS 2024 running. If you already use the
FlightFabric toolbar panel, close MSFS and choose **Update** or **Reinstall** in
**Settings > MSFS 2024 toolbar panel**, then restart the simulator.

## What's new

- **A clearer app and Logbook:** consistent navigation, compact searchable flight
  lists and a more visible Landing debrief button make it easier to find your
  controls and review a flight.
- **Explore flights in 3D:** switch the live map and recorded-flight replay between
  2D and 3D, with terrain, altitude-coloured tracks and lighting that follows the
  simulator clock.
- **FlightFabric inside MSFS:** install the toolbar panel from Settings to see
  your SimBrief plan, voice-command reference, recording status and last landing
  without leaving the simulator.
- **More aircraft tools:** use the remote CDU on supported aircraft and try
  experimental Autotaxi with route previews, readiness checks and an explicit
  Stop control.
- **Better debriefs and everyday reliability:** share a landing as an image,
  review clearer touchdown-position feedback, and benefit from fixes to
  recording controls, voice commands and connection recovery.

<details>
<summary><strong>Full release notes</strong></summary>

### Find controls and recordings more easily

Desktop navigation and the phone layout keep the main views easy to reach.
Aircraft controls are grouped by cockpit system, with presets together and
secondary tools available from the Aircraft page. The Logbook keeps route and
airport search visible, puts sorting and aircraft filters together, and uses
compact flight rows. Open a saved flight to inspect events, replay its route or
choose **Landing debrief**.

**End Flight Manually** responds reliably to mouse and touch input, shows when
the flight is saving and prevents repeated requests during that save. Recording
status panels close when the recording ends or the connection is lost.

### Maps and landing reviews

The live and replay maps offer 3D terrain, flight tracks at altitude and several
camera views. Replay follows the selected point in the recording. Both maps
retain a 2D option, and online imagery and terrain can be disabled in Settings.

Landing reviews offer **Copy image** and **Save PNG** for a shareable summary.
Touchdown-position feedback accounts for runway length and distinguishes
measured outcomes, optional targets and operational cautions. Previously saved
results retain their recorded assessment.

### MSFS toolbar panel

Install the optional panel from **Settings > MSFS 2024 toolbar panel**. It shows
the loaded SimBrief plan, commands and questions for the active aircraft,
push-to-talk status, flight and recording information, and the last landing.
The panel reconnects when FlightFabric becomes available and has its own text
size, theme and density settings. It is a read-only companion; aircraft controls
remain in the desktop app or an authorized connected device.

### CDU, voice and experimental Autotaxi

Open **Aircraft > MCDU / CDU** for PMDG 737/777 and FlyByWire A32NX displays and
keys. Fenix aircraft open their own web MCDU. Setup instructions are available
from the panel's Help control. Integrated CDU keys work on paired devices with
aircraft-control access, and the panel adapts to phone and landscape screens.

Voice improvements include SimBrief questions, clearer spoken-feedback errors,
exterior-light presets and corrections to supported APU and target controls.

**Aircraft > Taxi** introduces experimental Autotaxi for compatible Generic
aircraft, PMDG 737/777 and Fenix A319/A320/A321 when their readiness checks pass.
Preview a route to a runway holding point or stand, monitor progress in 2D or
3D, and use Stop when needed. A connection recovery does not automatically
resume movement.

</details>

<details>
<summary><strong>Known limitations</strong></summary>

Autotaxi remains experimental. Live validation across the listed aircraft is
incomplete, and routes depend on the airport scenery's taxiway data. Inspect
the route before starting and remain ready to take over. Keep a controlling
phone or tablet page in the foreground.

Aircraft controls depend on the installed aircraft, its setup and fresh data.
PMDG integrations require the appropriate SDK options; the FlyByWire A32NX CDU
requires SimBridge. Unsupported controls remain unavailable. The iniBuilds
A330 integration is readback-only.

Voice recognition is available in the Windows desktop app. Phone and tablet
control requires pairing and approval on the simulator PC.

3D maps require compatible graphics support and online data for imagery and
terrain. Runway and approach data availability varies; unavailable measurements
remain unscored where required. MSFS 2020 and X-Plane are not currently supported.

</details>

<details>
<summary><strong>Installation help and optional file verification</strong></summary>

Download `FlightFabric.Setup.0.10.0.exe`. The **Source code** archives in GitHub's Assets
section are for developers; the installer is all you need to use FlightFabric.
Existing settings and recordings stay in their current locations.

The current alpha is unsigned, so the first time you open the installer Windows
shows a red **Windows protected your PC** screen. Select **More info**, check
that the app is `FlightFabric.Setup.0.10.0.exe` with **Unknown publisher**, and
select **Run anyway** if you downloaded it from the official link at the top of
this page. If there is no **Run anyway** option, or Windows reports a threat,
stop and report the exact warning; do not turn off antivirus, SmartScreen or
Smart App Control.

GitHub shows the installer's SHA-256 checksum beside the file in **Assets** if
you want to verify your download.

</details>

[Getting started](https://github.com/yenbuilds/flight-fabric#readme) ·
[Licence](https://github.com/yenbuilds/flight-fabric/blob/v0.10.0/LICENSE.md) ·
[Third-party notices](https://github.com/yenbuilds/flight-fabric/blob/v0.10.0/THIRD_PARTY_NOTICES.md)

Thank you to everyone supporting FlightFabric through feedback, testing and
donations.
