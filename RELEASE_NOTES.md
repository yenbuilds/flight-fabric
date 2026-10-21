# FlightFabric 0.12.8 · Public Alpha

## [Download for Windows (.exe)](https://github.com/yenbuilds/flight-fabric/releases/download/v0.12.8/FlightFabric.Setup.0.12.8.exe)

**Public alpha · Free · Windows 64-bit · Microsoft Flight Simulator 2024**

Still in development. Expect bugs and incomplete aircraft support.

Finish your flight before updating. You can check for supported desktop updates
in **Settings > About**, or choose **Quit FlightFabric** from the system tray
and run the installer above. Your settings and recordings stay in their current
locations. Users on 0.12.1 or earlier need the manual installer.

To update the MSFS toolbar, close MSFS, open **Settings > MSFS 2024 toolbar panel**,
choose **Update** or **Reinstall**, then restart the simulator.

## What's new

- **Keyboard shortcut removal:** remove keyboard push-to-talk in Voice settings
  while keeping your controller button and other voice preferences.
- **Clearer saved bindings:** see your saved keyboard shortcut and controller
  button together. Switching setup views keeps those bindings configured.
- **Input-conflict guidance:** keyboard and controller setup explain how to
  choose inputs that are unassigned in MSFS and other apps.

<details>
<summary><strong>Full release notes</strong></summary>

### Remove a keyboard shortcut independently

In **Settings > Voice**, open **Keyboard** and choose **Remove shortcut** to
turn off keyboard push-to-talk. Your controller button and other voice
preferences are kept. You can also remove a shortcut while voice control is off.

Settings shows progress and confirms removal. The Keyboard view stays open so
you can see the result or set another shortcut. If removal fails, the saved
binding stays in place and you can retry.

### See which inputs are configured

The saved-bindings summary shows your keyboard shortcut and controller button
across all three setup views. **On screen**, **Keyboard** and **Yoke or joystick**
open their respective settings; selecting a view does not disable another input.
When voice control is off, the summary explains that saved bindings are inactive.

### Avoid overlapping controls

Push-to-talk keys and controller buttons also reach MSFS and other applications.
The setup guidance now covers both input types, helping you choose an unassigned
key or button so talking does not trigger another action.

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

Download `FlightFabric.Setup.0.12.8.exe`. GitHub's **Source code** archives are for
developers; the installer is all you need to use FlightFabric.

The current alpha is unsigned, so Windows may show **Windows protected your
PC** when you open the installer. Select **More info**, check that the app is
`FlightFabric.Setup.0.12.8.exe` with **Unknown publisher**, and select **Run anyway** if
you downloaded it from the official link above. If that option is unavailable
or Windows reports a threat, stop and report the warning; do not disable
Windows security protections.

GitHub shows the installer's SHA-256 checksum beside the file in **Assets** if
you want to verify your download.

</details>

[Getting started](https://github.com/yenbuilds/flight-fabric#readme) ·
[Licence](https://github.com/yenbuilds/flight-fabric/blob/v0.12.8/LICENSE.md) ·
[Third-party notices](https://github.com/yenbuilds/flight-fabric/blob/v0.12.8/THIRD_PARTY_NOTICES.md)

Thank you to everyone supporting FlightFabric through feedback, testing and
donations.
