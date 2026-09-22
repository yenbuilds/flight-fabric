# FlightFabric 0.10.1 · Public Alpha

## [Download for Windows (.exe)](https://github.com/yenbuilds/flight-fabric/releases/download/v0.10.1/FlightFabric.Setup.0.10.1.exe)

**Public alpha · Free · Windows 64-bit · Microsoft Flight Simulator 2024**

Still in development. Expect bugs and incomplete aircraft support.

Finish your flight and close FlightFabric, then run the downloaded installer.
Your settings and recordings stay in their current locations. If you use the
FlightFabric toolbar panel, close MSFS and choose **Update** or **Reinstall** in
**Settings > MSFS 2024 toolbar panel**, then restart the simulator.

## What's new

- **Maps start in 2D:** the live map and Logbook replay open in 2D, including
  after previously using 3D. You can still switch to 3D for the current session.
- **Clearer flight reviews:** event details stay beside the replay map on
  desktop and open as a bottom sheet on phones, leaving the map visible.
- **Better replay controls:** the map follows the aircraft as you scrub. Pan
  to explore, use **Resume Follow** to return, and keep your zoom when opening
  or closing event details.
- **PMDG connection recovery:** FlightFabric restarts the SDK connector if
  its background process stops, helping 737 and 777 data recover automatically.
- **Safer toolbar typing:** searching voice commands in the MSFS panel no
  longer sends those keystrokes to simulator controls. Update the panel from
  Settings to get this fix.

<details>
<summary><strong>Full release notes</strong></summary>

### Live and recorded-flight maps

Both maps start in 2D whenever FlightFabric opens or the page reloads. Choosing
3D is optional, and your saved 3D settings remain available.

The replay map follows the selected point as you scrub through a recording.
Dragging the map pauses following; **Resume Follow** brings it back to the
aircraft. Selecting an event centers the map on that event. Opening or closing
details and resizing the window preserve a view you have already panned or
zoomed; opening another recording frames the new flight.

Desktop Logbook reviews keep the event list and map side by side, including
on laptops. Event details use the events column, while phones retain the
Events / Replay map switch and show details in a compact bottom sheet.

In 3D replay, detailed ground imagery follows the aircraft as you scrub.
The live map also rejects impossible altitude spikes during simulator loading,
preventing an isolated bad sample from stretching the trail and its framing.

### Aircraft connection and toolbar fixes

When a PMDG SDK connector stops unexpectedly, FlightFabric retries the
connection and explains the recovery status on the aircraft page.

The MSFS toolbar panel keeps keyboard input while a text field is focused,
then returns it when you leave the field, click the cockpit, or hide or close
the panel. Reinstall or update the panel from Settings to replace its loader.

</details>

<details>
<summary><strong>Known limitations</strong></summary>

3D maps remain optional and require compatible graphics support. Online
imagery and terrain depend on their data services; use 2D if 3D is unreliable
on your system.

Autotaxi remains experimental. Aircraft controls depend on the installed
aircraft, its setup and fresh data. Voice recognition runs in the Windows
desktop app; phone and tablet control requires pairing and approval on the
simulator PC. MSFS 2020 and X-Plane are not currently supported.

</details>

<details>
<summary><strong>Installation help and optional file verification</strong></summary>

Download `FlightFabric.Setup.0.10.1.exe`. The **Source code** archives in GitHub's Assets
section are for developers; the installer is all you need to use FlightFabric.

The current alpha is unsigned, so Windows may show **Windows protected your
PC** when you open the installer. Select **More info**, check that the app is
`FlightFabric.Setup.0.10.1.exe` with **Unknown publisher**, and select **Run anyway** if
you downloaded it from the official link above. If that option is unavailable
or Windows reports a threat, stop and report the warning; do not disable
Windows security protections.

GitHub shows the installer's SHA-256 checksum beside the file in **Assets** if
you want to verify your download.

</details>

[Getting started](https://github.com/yenbuilds/flight-fabric#readme) ·
[Licence](https://github.com/yenbuilds/flight-fabric/blob/v0.10.1/LICENSE.md) ·
[Third-party notices](https://github.com/yenbuilds/flight-fabric/blob/v0.10.1/THIRD_PARTY_NOTICES.md)

Thank you to everyone supporting FlightFabric through feedback, testing and
donations.
