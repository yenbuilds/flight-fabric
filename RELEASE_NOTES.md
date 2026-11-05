# FlightFabric 0.13.2 · Public Alpha

## [Download for Windows (.exe)](https://github.com/yenbuilds/flight-fabric/releases/download/v0.13.2/FlightFabric.Setup.0.13.2.exe)

**Public alpha · Free · Windows 64-bit · Microsoft Flight Simulator 2024**

Still in development. Expect bugs and incomplete aircraft support.

Finish your flight before updating. Check **Settings > About** for desktop
updates, or choose **Quit FlightFabric** from the system tray and run the
installer above. Your settings and recordings stay in their current locations.
Users on 0.12.1 or earlier need the manual installer.

To update the MSFS toolbar, close MSFS, open **Settings > Devices > MSFS 2024
toolbar panel**, choose **Update** or **Reinstall**, then restart the simulator.

## What's new

- **More reliable voice:** improve altitude and lighting recognition, recognize "engage approach", and give spoken word endings more time after push-to-talk release.
- **Shorter commands:** say settings such as "altitude thirteen thousand" without "set", and use "turnoff lights on/off" or "runway lights on/off".
- **Clearer lighting:** separate panel backlighting, flood/task lights and flight-display brightness on supported Airbus aircraft.
- **Simpler setup:** reduce text in Settings and make phone connection instructions and pairing prompts easier to follow.

<details>
<summary><strong>More improvements</strong></summary>

### Voice commands

FlightFabric shows the interpreted command before its result and asks for a
retry when a recording cannot finish. Incomplete recordings are discarded.
Voice commands use your desktop microphone; phone and tablet cockpit controls
remain available through the browser.

### Cockpit lighting

Separate lighting controls are available on Fenix, FlyByWire, Headwind A330 and
iniBuilds A350 aircraft. Combined cockpit lighting remains available as a preset
and an explicit voice command.

</details>

<details>
<summary><strong>Known limitations</strong></summary>

Aircraft support is still developing, and not every command has been verified
in a live simulator session. An unconfirmed approach-selection message does not
establish that the aircraft captured the approach; check the flight mode annunciator.
The PMDG 737 Mach target control requires the cockpit speed window to be in Mach mode.

Pushback and Autotaxi remain experimental and depend on the aircraft and airport
scenery. Some stands still require the simulator's pushback controls. Voice
recognition depends on your microphone, accent and background noise. Controller
compatibility varies; reconnecting a device may require selecting its button again.

The iniBuilds A380 integration is partial. A350 surface controls have ground
checks on the -1000; the -900, airborne operation and automatic braking remain
unverified. MD-11 surface controls have limited ground checks on the PW4462;
its added flight-guidance buttons still need live verification.

Desktop 3D maps require compatible graphics support and online imagery services.
Phone and tablet control requires pairing on the simulator PC. MSFS 2020 and
X-Plane are not currently supported.

</details>

<details>
<summary><strong>Installation help and optional file verification</strong></summary>

Download `FlightFabric.Setup.0.13.2.exe`. GitHub's **Source code** archives are for
developers; the installer is all you need to use FlightFabric.

The current alpha is unsigned, so Windows may show **Windows protected your
PC**. Select **More info**, check for `FlightFabric.Setup.0.13.2.exe` with **Unknown
publisher**, and select **Run anyway** only if you downloaded it from the
official link above. If that option is unavailable or Windows reports a threat,
stop and report the warning; do not disable Windows security protections.

GitHub shows the installer's SHA-256 checksum beside the file in **Assets**.

</details>

[Getting started](https://github.com/yenbuilds/flight-fabric#readme) ·
[Licence](https://github.com/yenbuilds/flight-fabric/blob/v0.13.2/LICENSE.md) ·
[Third-party notices](https://github.com/yenbuilds/flight-fabric/blob/v0.13.2/THIRD_PARTY_NOTICES.md)

Thank you to everyone supporting FlightFabric through feedback, testing and donations.
