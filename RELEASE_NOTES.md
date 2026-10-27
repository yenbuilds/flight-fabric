# FlightFabric 0.13.1 · Public Alpha

## [Download for Windows (.exe)](https://github.com/yenbuilds/flight-fabric/releases/download/v0.13.1/FlightFabric.Setup.0.13.1.exe)

**Public alpha · Free · Windows 64-bit · Microsoft Flight Simulator 2024**

Still in development. Expect bugs and incomplete aircraft support.

Finish your flight before updating. Check **Settings > About** for supported
desktop updates, or choose **Quit FlightFabric** from the system tray and run
the installer above. Your settings and recordings stay in their current locations.
Users on 0.12.1 or earlier need the manual installer.

To update the MSFS toolbar, close MSFS, open **Settings > Devices > MSFS 2024
toolbar panel**, choose **Update** or **Reinstall**, then restart the simulator.

## What's new

- **Lighter spoken feedback:** Windows TTS is the default for new speech settings. Your saved Kokoro engine and voice stay selected, with a clearer warning about neural voices' higher RAM use.
- **Independent brightness:** adjust cockpit lighting and flight-display brightness with separate presets on supported aircraft.
- **Cleaner CDU:** use the default appearance without a theme selector, with corrected PMDG empty-entry symbols.
- **Clearer PMDG guidance:** get a prompt to select Mach mode before setting a 737 Mach target, and clearer feedback when approach selection is unconfirmed.
- **Less background work:** skip recording-sample preparation while recording is off, with normal sampling resuming when recording starts.

<details>
<summary><strong>More improvements</strong></summary>

### Voice and settings

Recognition and spoken feedback now sit below the microphone controls, making
better use of the Voice settings layout. Connection help is shorter and written
for the desktop app.

Windows TTS and Kokoro both work offline. Kokoro remains available in
**Settings > Voice > Configure > Recognition & spoken feedback**. Existing saved
engine and voice choices are preserved. Neural voices use significantly more
RAM than Windows TTS, so Windows TTS is the lighter choice alongside MSFS.

Say "Let's hit it" to apply the full takeoff-lights preset on supported aircraft.

### Aircraft and toolbar

The Aircraft waiting screen and public aircraft overviews use shorter family
names such as PMDG 737, PMDG 777, Fenix A32X and iniBuilds A350.

Cockpit lighting and display-brightness presets control separate groups on
supported profiles that provide those presets. Individual dimmer controls remain
available.

Flight, Plan and Voice stay available in the MSFS toolbar tab bar. The **Open on**
preference still selects your initial tab.

### Recording

Recording can still start automatically or manually during a flight. Live
telemetry continues while recording is off. The retired Dutch roll statistic
has been removed from flight summaries.

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

Download `FlightFabric.Setup.0.13.1.exe`. GitHub's **Source code** archives are for
developers; the installer is all you need to use FlightFabric.

The current alpha is unsigned, so Windows may show **Windows protected your
PC**. Select **More info**, check for `FlightFabric.Setup.0.13.1.exe` with **Unknown
publisher**, and select **Run anyway** only if you downloaded it from the
official link above. If that option is unavailable or Windows reports a threat,
stop and report the warning; do not disable Windows security protections.

GitHub shows the installer's SHA-256 checksum beside the file in **Assets**.

</details>

[Getting started](https://github.com/yenbuilds/flight-fabric#readme) ·
[Licence](https://github.com/yenbuilds/flight-fabric/blob/v0.13.1/LICENSE.md) ·
[Third-party notices](https://github.com/yenbuilds/flight-fabric/blob/v0.13.1/THIRD_PARTY_NOTICES.md)

Thank you to everyone supporting FlightFabric through feedback, testing and donations.
