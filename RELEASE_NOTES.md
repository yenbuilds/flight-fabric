# FlightFabric 0.12.5 · Public Alpha

## [Download for Windows (.exe)](https://github.com/yenbuilds/flight-fabric/releases/download/v0.12.5/FlightFabric.Setup.0.12.5.exe)

**Public alpha · Free · Windows 64-bit · Microsoft Flight Simulator 2024**

Still in development. Expect bugs and incomplete aircraft support.

Finish your flight before updating. You can check for supported desktop updates
in **Settings > About**, or choose **Quit FlightFabric** from the system tray
and run the installer above. Your settings and recordings stay in their current
locations. Users on 0.12.1 or earlier need the manual installer.

To update the MSFS toolbar, close MSFS, open **Settings > MSFS 2024 toolbar panel**,
choose **Update** or **Reinstall**, then restart the simulator.

## What's new

- **Smoother startup:** a loading indicator shows activity while your preferences
  arrive, with more time for automatic recovery before Reconnect appears.
- **Getting started:** a new introduction guides you through setup; replay it
  anytime from Settings > General > Introduction.
- **Aircraft controls:** add flap and landing-autobrake selections for the
  iniBuilds A350, plus further surface and flight-guidance controls for the TFDi MD-11.
- **Clearer command feedback:** improve PMDG 777 flap and spoiler confirmation,
  and distinguish unconfirmed flap/spoiler requests from commands that could not be sent.
- **Recording visibility:** see the current recording size and open your Logbook
  or debrief from the recording indicator.

<details>
<summary><strong>Full release notes</strong></summary>

### Startup and introduction

FlightFabric waits for your saved preferences before opening the workspace or
showing setup. A small activity ring accompanies the loading message and respects
reduced-motion preferences. Automatic connection recovery has time to complete
before the Reconnect button appears; a stopped desktop service offers Start service.

Startup also uses less memory when loading aircraft data.

The introduction helps you find the main features and set up optional voice,
phone access and the MSFS toolbar. To see it again, open **Settings > General**,
scroll to **Introduction**, and choose **Show intro again**.

### Aircraft controls and feedback

The iniBuilds A350 gains UP/1/2/3/FULL flap selection and landing-autobrake
arm/disarm commands. TFDi MD-11 additions cover flap selection, spoiler arm/stow,
autobrake selection and flight-guidance button requests. These controls are
available through the shared Control library and voice catalogue where supported.

PMDG 777 flap confirmation now allows time for the aircraft's selection readback,
and the spoiler HALF command recognizes the aircraft's reported lever position.
Flap and spoiler feedback distinguishes a request sent without confirmation from
a request that could not be sent. Check the observed aircraft state before retrying.

### Recording visibility

The recording indicator shows how much data has been written during the current
flight. Open it to see the local recording location, go to the Logbook or debrief,
or end the flight manually.

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

The new A350 surface controls have ground checks on the -1000; the -900,
airborne operation and actual automatic braking remain unverified. New MD-11
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

Download `FlightFabric.Setup.0.12.5.exe`. GitHub's **Source code** archives are for
developers; the installer is all you need to use FlightFabric.

The current alpha is unsigned, so Windows may show **Windows protected your
PC** when you open the installer. Select **More info**, check that the app is
`FlightFabric.Setup.0.12.5.exe` with **Unknown publisher**, and select **Run anyway** if
you downloaded it from the official link above. If that option is unavailable
or Windows reports a threat, stop and report the warning; do not disable
Windows security protections.

GitHub shows the installer's SHA-256 checksum beside the file in **Assets** if
you want to verify your download.

</details>

[Getting started](https://github.com/yenbuilds/flight-fabric#readme) ·
[Licence](https://github.com/yenbuilds/flight-fabric/blob/v0.12.5/LICENSE.md) ·
[Third-party notices](https://github.com/yenbuilds/flight-fabric/blob/v0.12.5/THIRD_PARTY_NOTICES.md)

Thank you to everyone supporting FlightFabric through feedback, testing and
donations.
