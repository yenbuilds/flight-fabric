# FlightFabric 0.11.1 · Public Alpha

## [Download for Windows (.exe)](https://github.com/yenbuilds/flight-fabric/releases/download/v0.11.1/FlightFabric.Setup.0.11.1.exe)

**Public alpha · Free · Windows 64-bit · Microsoft Flight Simulator 2024**

Still in development. Expect bugs and incomplete aircraft support.

Finish your flight and close FlightFabric, then run the downloaded installer.
Your settings and recordings stay in their current locations. To update the
toolbar, close MSFS and choose **Update** or **Reinstall** in
**Settings > MSFS 2024 toolbar panel**, then restart the simulator.

## What's new

- **Test your microphone:** check input levels, speech recognition and recording
  playback in Settings without loading MSFS or sending aircraft commands.
- **Voice settings together:** find your microphone, push-to-talk shortcut and
  spoken feedback in **Settings > Voice control**, with clearer setup reminders.
- **Clearer automatic pushback:** the app and MSFS toolbar explain how your
  departure runway guides the pushback direction and show **Start pushback**.
- **Small usability improvements:** slightly louder push-to-talk beeps, better
  search sizing on narrow screens and more consistent keyboard focus.

<details>
<summary><strong>Full release notes</strong></summary>

### Check voice before loading a flight

Open **Settings > Voice control**, enable voice control and choose your
microphone. Select **Start voice test** and say “Set heading two seven zero”.
The test shows your input level and recognized speech, then lets you play back
the short recording. It works without MSFS, a loaded aircraft or a saved
push-to-talk shortcut, and never sends aircraft commands.

Test recordings stay in memory and are cleared when you leave Settings. Use
**Test spoken feedback** to check audio output separately. Testing does not
change your saved spoken-feedback preference.

The sidebar voice reminder now sits beside the other setup tasks. Start and
release beeps are slightly louder while keeping their short duration and smooth
fade. Normal aircraft commands still use push-to-talk and the aircraft's live
availability checks.

### Automatic pushback is easier to find

In the app or the toolbar's **Pushback & taxi** tab, enter your departure airport
and runway to preview the route and planned pushback direction. Choose
**Start pushback** when you are ready. Selecting a runway or showing a route
does not move the aircraft.

**Stop pushback** remains available while the manoeuvre runs. After a confirmed
stop, the display continues with manual taxi guidance. Closing the toolbar tab
stops pushback started there. Optional Autotaxi remains a separate desktop-app
action.

### Other improvements

Search fits narrow screens more reliably, keyboard focus returns to useful
controls after closing tools, and the setup guidance is clearer. This update
also includes refreshed README screenshots and patched bundled dependencies.

</details>

<details>
<summary><strong>Known limitations</strong></summary>

Pushback and Autotaxi remain experimental. Check the route and aircraft
readiness before starting, and keep the stop control available. Aircraft and
scenery combinations have different behavior and have not all been verified.

Voice recognition runs locally in the Windows desktop app. Results depend on
your microphone, accent and background noise. A successful voice test confirms
recognition of the sample phrase; it does not confirm aircraft command support.

Aircraft support varies by aircraft and installed version. The iniBuilds A380
integration is partial, and takeoff scoring remains disabled. Aircraft controls
require the appropriate setup and fresh data.

3D maps require compatible graphics support and online imagery services. Phone
and tablet control requires pairing and approval on the simulator PC.
MSFS 2020 and X-Plane are not currently supported.

</details>

<details>
<summary><strong>Installation help and optional file verification</strong></summary>

Download `FlightFabric.Setup.0.11.1.exe`. GitHub's **Source code** archives are for
developers; the installer is all you need to use FlightFabric.

The current alpha is unsigned, so Windows may show **Windows protected your
PC** when you open the installer. Select **More info**, check that the app is
`FlightFabric.Setup.0.11.1.exe` with **Unknown publisher**, and select **Run anyway** if
you downloaded it from the official link above. If that option is unavailable
or Windows reports a threat, stop and report the warning; do not disable
Windows security protections.

GitHub shows the installer's SHA-256 checksum beside the file in **Assets** if
you want to verify your download.

</details>

[Getting started](https://github.com/yenbuilds/flight-fabric#readme) ·
[Licence](https://github.com/yenbuilds/flight-fabric/blob/v0.11.1/LICENSE.md) ·
[Third-party notices](https://github.com/yenbuilds/flight-fabric/blob/v0.11.1/THIRD_PARTY_NOTICES.md)

Thank you to everyone supporting FlightFabric through feedback, testing and
donations.
