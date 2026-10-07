# FlightFabric 0.12.1 · Public Alpha

## [Download for Windows (.exe)](https://github.com/yenbuilds/flight-fabric/releases/download/v0.12.1/FlightFabric.Setup.0.12.1.exe)

**Public alpha · Free · Windows 64-bit · Microsoft Flight Simulator 2024**

Still in development. Expect bugs and incomplete aircraft support.

Finish your flight and close FlightFabric, then run the downloaded installer.
Your settings and recordings stay in their current locations. To update the
MSFS toolbar, close MSFS, open **Settings > MSFS 2024 toolbar panel** in
FlightFabric, choose **Update** or **Reinstall**, then restart the simulator.

## What's new

- **PMDG aircraft controls:** fix flap selection on the PMDG 737 and gear
  up/down commands on the PMDG 737 and 777, with clearer confirmation feedback.
- **Easier Settings navigation:** jump between sections, keep unsaved changes
  while moving around Settings, and find voice setup in one place.
- **Clearer flight history:** distinguish simulator start times from the
  real-world recording time, shown in your local timezone.
- **Voice recovery:** improve microphone cleanup and recovery when cancelling
  recognition, testing voice or leaving Voice settings.
- **Security updates:** update app and build dependencies to address security
  advisories.

<details>
<summary><strong>Full release notes</strong></summary>

### PMDG flap and gear controls

PMDG 737 flap selection now confirms the selected lever position while the
flaps are moving. Gear up/down commands on the PMDG 737 and 777 now use the
working aircraft control path. Feedback distinguishes a confirmed selection
from a request that could not be confirmed.

### Settings and voice setup

Settings has section navigation on desktop and phones. Unsaved changes remain
available when switching sections, with clearer save feedback. Microphone,
keyboard and controller push-to-talk, and spoken feedback options stay together
in Voice settings.

Offline speech recognition continues to run locally on your PC. Microphone
cleanup and cancellation handling are improved, including recovery after a
cancelled voice test or an interrupted recognition session.

### Flight history and dependency updates

The Logbook distinguishes simulator local time, simulator UTC and the real-world
recording start time. Recording times use your local timezone and show the UTC
offset in the flight details.

App and build dependencies have been updated to address security advisories.

</details>

<details>
<summary><strong>Known limitations</strong></summary>

Experimental Autotaxi can stop after a control-write failure and can require
manual parking-brake handover at the holding point.

Voice recognition results depend on your microphone, accent and background
noise. Controller compatibility varies; reconnecting a device may require
selecting its button again.

Aircraft and scenery combinations have not all been verified. The iniBuilds A380
integration is partial. Aircraft controls require the appropriate setup and
fresh data.

Desktop 3D maps require compatible graphics support and online imagery services.
Phone and tablet control requires pairing and approval on the simulator PC.
MSFS 2020 and X-Plane are not currently supported.

</details>

<details>
<summary><strong>Installation help and optional file verification</strong></summary>

Download `FlightFabric.Setup.0.12.1.exe`. GitHub's **Source code** archives are for
developers; the installer is all you need to use FlightFabric.

The current alpha is unsigned, so Windows may show **Windows protected your
PC** when you open the installer. Select **More info**, check that the app is
`FlightFabric.Setup.0.12.1.exe` with **Unknown publisher**, and select **Run anyway** if
you downloaded it from the official link above. If that option is unavailable
or Windows reports a threat, stop and report the warning; do not disable
Windows security protections.

GitHub shows the installer's SHA-256 checksum beside the file in **Assets** if
you want to verify your download.

</details>

[Getting started](https://github.com/yenbuilds/flight-fabric#readme) ·
[Licence](https://github.com/yenbuilds/flight-fabric/blob/v0.12.1/LICENSE.md) ·
[Third-party notices](https://github.com/yenbuilds/flight-fabric/blob/v0.12.1/THIRD_PARTY_NOTICES.md)

Thank you to everyone supporting FlightFabric through feedback, testing and
donations.
