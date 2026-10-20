# FlightFabric 0.12.7 · Public Alpha

## [Download for Windows (.exe)](https://github.com/yenbuilds/flight-fabric/releases/download/v0.12.7/FlightFabric.Setup.0.12.7.exe)

**Public alpha · Free · Windows 64-bit · Microsoft Flight Simulator 2024**

Still in development. Expect bugs and incomplete aircraft support.

Finish your flight before updating. You can check for supported desktop updates
in **Settings > About**, or choose **Quit FlightFabric** from the system tray
and run the installer above. Your settings and recordings stay in their current
locations. Users on 0.12.1 or earlier need the manual installer.

To update the MSFS toolbar, close MSFS, open **Settings > MSFS 2024 toolbar panel**,
choose **Update** or **Reinstall**, then restart the simulator.

## What's new

- **Guided setup:** three focused steps introduce voice, recording and the MSFS
  toolbar. Reopen the introduction anytime from Setup in the desktop menu.
- **Aircraft presets:** start with grouped actions in Presets, then switch to
  Cockpit controls or Find controls when you need an individual setting.
- **Easier voice access:** Voice commands stays visible beside Find controls.
  Configure voice in Settings, with recognition and spoken feedback always visible.
- **Connect your phone:** a permanent menu link opens the QR code and pairing
  guidance, making it easier to get back to your phone or tablet controls.

<details>
<summary><strong>Full release notes</strong></summary>

### Setup when you need it

The introduction uses three focused steps for voice, flight recording and the
MSFS toolbar. Each step keeps its guidance visible in the setup window. Choose
**Setup** in the desktop menu whenever you want to revisit it.

### Presets and cockpit controls

The Aircraft page opens in **Presets**, keeping grouped actions together. A
labelled switch with distinct icons takes you to **Cockpit controls** for
individual settings. Your entered targets stay in place when you switch views.
**Find controls** opens the appropriate view and takes you to the matching control.

The preset frames retain their green accent with simpler, nearly square corners.
Flight and Logbook views also use more compact layouts and clearer summaries.

### Voice commands within reach

**Voice commands** has its own button beside Find controls on the desktop.
Connected phones and tablets show **Voice phrases** in the same place.
Microphone, push-to-talk and spoken-feedback configuration live together in
**Settings > Voice**. Recognition and spoken feedback stay visible while
configuring voice.

### Phone and tablet setup

Choose **Connect phone** in the desktop menu to open the QR code, connection
instructions and pairing guidance. Device approval stays on the simulator PC.

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

The A350 surface controls have ground checks on the -1000; the -900,
airborne operation and actual automatic braking remain unverified. MD-11
surface controls have limited ground checks on the PW4462, while the added
flight-guidance buttons still need live verification. These additions do not
establish complete aircraft or variant support. Reported PMDG heading/approach
commands that do not respond are still under investigation.

Desktop 3D maps require compatible graphics support and online imagery services.
Phone and tablet control requires pairing and approval on the simulator PC.
MSFS 2020 and X-Plane are not currently supported.

</details>

<details>
<summary><strong>Installation help and optional file verification</strong></summary>

Download `FlightFabric.Setup.0.12.7.exe`. GitHub's **Source code** archives are for
developers; the installer is all you need to use FlightFabric.

The current alpha is unsigned, so Windows may show **Windows protected your
PC** when you open the installer. Select **More info**, check that the app is
`FlightFabric.Setup.0.12.7.exe` with **Unknown publisher**, and select **Run anyway** if
you downloaded it from the official link above. If that option is unavailable
or Windows reports a threat, stop and report the warning; do not disable
Windows security protections.

GitHub shows the installer's SHA-256 checksum beside the file in **Assets** if
you want to verify your download.

</details>

[Getting started](https://github.com/yenbuilds/flight-fabric#readme) ·
[Licence](https://github.com/yenbuilds/flight-fabric/blob/v0.12.7/LICENSE.md) ·
[Third-party notices](https://github.com/yenbuilds/flight-fabric/blob/v0.12.7/THIRD_PARTY_NOTICES.md)

Thank you to everyone supporting FlightFabric through feedback, testing and
donations.
