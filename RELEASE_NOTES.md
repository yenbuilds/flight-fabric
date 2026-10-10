# FlightFabric 0.12.4 · Public Alpha

## [Download for Windows (.exe)](https://github.com/yenbuilds/flight-fabric/releases/download/v0.12.4/FlightFabric.Setup.0.12.4.exe)

**Public alpha · Free · Windows 64-bit · Microsoft Flight Simulator 2024**

Still in development. Expect bugs and incomplete aircraft support.

Finish your flight before updating. You can check for supported desktop updates
in **Settings > About**, or choose **Quit FlightFabric** from the system tray
and run the installer above. Your settings and recordings stay in their current
locations. Users on 0.12.1 or earlier need the manual installer.

To update the MSFS toolbar, close MSFS, open **Settings > MSFS 2024 toolbar panel**,
choose **Update** or **Reinstall**, then restart the simulator.

## What's new

- **Airport memory management:** keep the airport-data cache bounded during
  longer FlightFabric sessions.
- **Taxi and pushback:** preserve the data needed by active routes and prepared
  pushbacks when older airport entries are cleared.
- **Flight analysis:** preserve runway information in takeoff and landing
  results, recordings and saved flight reviews.

<details>
<summary><strong>Full release notes</strong></summary>

### Airport memory management

FlightFabric now limits how much airport data its cache retains as more airports
are encountered during a session. Recently used airports stay available, while
older entries can be cleared and loaded again when needed.

Active taxi routes and prepared or active pushbacks retain their airport data.
Takeoff and landing analysis, recordings and saved flight reviews preserve their
existing runway information.

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

Download `FlightFabric.Setup.0.12.4.exe`. GitHub's **Source code** archives are for
developers; the installer is all you need to use FlightFabric.

The current alpha is unsigned, so Windows may show **Windows protected your
PC** when you open the installer. Select **More info**, check that the app is
`FlightFabric.Setup.0.12.4.exe` with **Unknown publisher**, and select **Run anyway** if
you downloaded it from the official link above. If that option is unavailable
or Windows reports a threat, stop and report the warning; do not disable
Windows security protections.

GitHub shows the installer's SHA-256 checksum beside the file in **Assets** if
you want to verify your download.

</details>

[Getting started](https://github.com/yenbuilds/flight-fabric#readme) ·
[Licence](https://github.com/yenbuilds/flight-fabric/blob/v0.12.4/LICENSE.md) ·
[Third-party notices](https://github.com/yenbuilds/flight-fabric/blob/v0.12.4/THIRD_PARTY_NOTICES.md)

Thank you to everyone supporting FlightFabric through feedback, testing and
donations.
