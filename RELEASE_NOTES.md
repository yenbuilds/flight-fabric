# FlightFabric 0.12.3 · Public Alpha

## [Download for Windows (.exe)](https://github.com/yenbuilds/flight-fabric/releases/download/v0.12.3/FlightFabric.Setup.0.12.3.exe)

**Public alpha · Free · Windows 64-bit · Microsoft Flight Simulator 2024**

Still in development. Expect bugs and incomplete aircraft support.

Finish your flight before updating. You can check for supported desktop updates
in **Settings > About**, or choose **Quit FlightFabric** from the system tray
and run the installer above. Your settings and recordings stay in their current
locations. Users on 0.12.1 or earlier need the manual installer.

To update the MSFS toolbar, close MSFS, open **Settings > MSFS 2024 toolbar panel**,
choose **Update** or **Reinstall**, then restart the simulator.

## What's new

- **Push-to-talk reliability:** improve keyboard and controller input handling,
  microphone cleanup and recovery between voice commands.
- **Safer shortcut setup:** pause push-to-talk while recording a new keyboard
  shortcut, choose a single key or combination, and keep the saved binding
  until you apply your changes.
- **Keyboard shortcut compatibility:** keyboard push-to-talk now also reaches
  the foreground app. Choose a key or combination unused by MSFS and other apps.
- **More room in the Logbook:** give the replay map more space, compact the
  flight summary and replay controls, and keep phone controls easy to use.

<details>
<summary><strong>Full release notes</strong></summary>

### Voice commands and push-to-talk

Keyboard and controller push-to-talk handling is more resilient when a command
ends, an input device disconnects or voice input is interrupted. Cancelled and
completed commands release their microphone resources so later attempts can
start normally. Voice feedback remains visible during shortcut setup.

Recording a new keyboard shortcut temporarily pauses push-to-talk. Saving or
cancelling setup restores input using your saved settings. Existing bindings
are retained, and no keyboard shortcut is assigned by default.
You can now choose a single key, including Caps Lock or either side of Ctrl,
Alt, Shift and Windows, or a key combination. To assign a modifier alone,
press and release it in the recorder or choose it from the modifier list.
Caps Lock still toggles capitalisation; hold it to talk and release to finish.

Keyboard shortcuts are no longer blocked from reaching the foreground app.
If your shortcut also operates a simulator control or types into another app,
choose a different key or combination in Voice control settings.

### A more compact Logbook

The desktop replay map takes a larger share of the flight review. The collapsed
Scored landings header and replay scrubber use less vertical space, while alerts
fit beside the flight metrics when space allows. Narrow screens retain wrapping
and touch-sized replay controls.

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

Download `FlightFabric.Setup.0.12.3.exe`. GitHub's **Source code** archives are for
developers; the installer is all you need to use FlightFabric.

The current alpha is unsigned, so Windows may show **Windows protected your
PC** when you open the installer. Select **More info**, check that the app is
`FlightFabric.Setup.0.12.3.exe` with **Unknown publisher**, and select **Run anyway** if
you downloaded it from the official link above. If that option is unavailable
or Windows reports a threat, stop and report the warning; do not disable
Windows security protections.

GitHub shows the installer's SHA-256 checksum beside the file in **Assets** if
you want to verify your download.

</details>

[Getting started](https://github.com/yenbuilds/flight-fabric#readme) ·
[Licence](https://github.com/yenbuilds/flight-fabric/blob/v0.12.3/LICENSE.md) ·
[Third-party notices](https://github.com/yenbuilds/flight-fabric/blob/v0.12.3/THIRD_PARTY_NOTICES.md)

Thank you to everyone supporting FlightFabric through feedback, testing and
donations.
