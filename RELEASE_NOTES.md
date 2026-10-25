# FlightFabric 0.13.0 · Public Alpha

## [Download for Windows (.exe)](https://github.com/yenbuilds/flight-fabric/releases/download/v0.13.0/FlightFabric.Setup.0.13.0.exe)

**Public alpha · Free · Windows 64-bit · Microsoft Flight Simulator 2024**

Still in development. Expect bugs and incomplete aircraft support.

Finish your flight before updating. Check **Settings > About** for supported
desktop updates, or choose **Quit FlightFabric** from the system tray and run
the installer above. Your settings and recordings stay in their current locations.
Users on 0.12.1 or earlier need the manual installer.

To update the MSFS toolbar, close MSFS, open **Settings > Devices > MSFS 2024
toolbar panel**, choose **Update** or **Reinstall**, then restart the simulator.

## What's new

- **Natural offline speech:** hear command feedback through Kokoro, with Windows
  TTS still available as a lighter alternative.
- **US and UK voices:** choose from four voices per accent, preview them and keep
  your preferred voice between sessions.
- **Easier aircraft controls:** find controls and presets faster, with matching
  abbreviation search in the toolbar and clearer virtual throttles.
- **Simpler pushback:** less setup text and more flexible route planning for
  stands that need an extra reverse turn.
- **Less clutter:** shorter guidance throughout setup, settings and help.

<details>
<summary><strong>Full release notes</strong></summary>

### Choose your spoken voice

Open **Settings > Voice > Configure > Recognition & spoken feedback** to choose
Kokoro or Windows TTS. Select a voice and use **Test spoken feedback** to hear it.
Kokoro is the default speech engine and works entirely offline, with no API key
or subscription. Voice control stays off until you enable it.

The new picker includes Bella, Heart, Michael and Puck for US English, and Emma,
Isabella, Fable and George for UK English. An earlier saved Kokoro voice remains
available if it is your current selection. Windows TTS remains available if you
prefer lower resource use, and provides fallback speech if Kokoro cannot start.

### Find controls with less searching

Aircraft search brings controls, presets and voice phrases together. Common
abbreviations such as HDG, ALT and V/S also work in the toolbar voice reference.
Virtual throttles have clearer styles and state indicators.

### Push back with fewer distractions

The pushback panel focuses on the route, preview and start/stop actions. Route
planning can now use an additional reverse curve where a direct taxiway join
does not fit. Pushback remains experimental and depends on the aircraft and
airport scenery.

</details>

<details>
<summary><strong>Known limitations</strong></summary>

Kokoro uses more memory than Windows TTS and may take a moment to prepare or
generate speech. Recognition still depends on your microphone, accent and
background noise. Controller compatibility varies; reconnecting a device may
require selecting its button again.

Pushback and Autotaxi remain experimental, including on Fenix aircraft. Some
stands still require the simulator's pushback controls. Autotaxi can stop after
a control-write failure and may require manual parking-brake handover.

Aircraft and scenery combinations have not all been verified. The iniBuilds
A380 integration is partial. A350 surface controls have ground checks on the
-1000; the -900, airborne operation and automatic braking remain unverified.
MD-11 surface controls have limited ground checks on the PW4462, while its added
flight-guidance buttons still need live verification. Reported PMDG
heading/approach commands that do not respond remain under investigation.

Desktop 3D maps require compatible graphics support and online imagery services.
Phone and tablet control requires pairing on the simulator PC. MSFS 2020 and
X-Plane are not currently supported.

</details>

<details>
<summary><strong>Installation help and optional file verification</strong></summary>

Download `FlightFabric.Setup.0.13.0.exe`. GitHub's **Source code** archives are for
developers; the installer is all you need to use FlightFabric.

The current alpha is unsigned, so Windows may show **Windows protected your
PC**. Select **More info**, check for `FlightFabric.Setup.0.13.0.exe` with **Unknown
publisher**, and select **Run anyway** only if you downloaded it from the
official link above. If that option is unavailable or Windows reports a threat,
stop and report the warning; do not disable Windows security protections.

GitHub shows the installer's SHA-256 checksum beside the file in **Assets**.

</details>

[Getting started](https://github.com/yenbuilds/flight-fabric#readme) ·
[Licence](https://github.com/yenbuilds/flight-fabric/blob/v0.13.0/LICENSE.md) ·
[Third-party notices](https://github.com/yenbuilds/flight-fabric/blob/v0.13.0/THIRD_PARTY_NOTICES.md)

Thank you to everyone supporting FlightFabric through feedback, testing and donations.
