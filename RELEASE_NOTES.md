# FlightFabric 0.11.0 · Public Alpha

## [Download for Windows (.exe)](https://github.com/yenbuilds/flight-fabric/releases/download/v0.11.0/FlightFabric.Setup.0.11.0.exe)

**Public alpha · Free · Windows 64-bit · Microsoft Flight Simulator 2024**

Still in development. Expect bugs and incomplete aircraft support.

Finish your flight and close FlightFabric, then run the downloaded installer.
Your settings and recordings stay in their current locations. To get the new
toolbar tabs, close MSFS and choose **Update** or **Reinstall** in
**Settings > MSFS 2024 toolbar panel**, then restart the simulator.

## What's new

- **Presets in the cockpit:** use the toolbar's new **Presets** tab for the
  available presets on your current aircraft, with progress and availability
  shown alongside each action.
- **Taxi guidance and pushback:** preview a departure route, start experimental
  guided pushback and continue with manual taxi guidance in the app or toolbar.
  **Show route** leaves you in control; pushback requires a separate action.
- **Easier PMDG setup:** the desktop app checks the 737 and 777 connection
  settings and offers steps to help you enable the required data broadcasts.
- **Updated offline voice:** a refreshed English recognizer and stricter
  handling of ambiguous numbers help you review and issue cockpit commands.
- **More reliable operation:** improved recovery after interrupted sessions,
  handling of slow connected displays and aircraft-control feedback.

<details>
<summary><strong>Full release notes</strong></summary>

### Toolbar presets and taxi assistance

The MSFS toolbar now includes **Presets** and **Taxi** alongside Flight, Plan
and Voice. Presets follow the current aircraft's available controls and show
unavailable reasons and progress.

Taxi assistant helps you find a runway holding point or stand using a route
ribbon or 2D map. Departure details can come from your loaded SimBrief plan,
and you can change the destination yourself. Showing a route provides guidance
while you taxi manually.

For departures, the assistant previews a pushback path and the aircraft's final
direction. **Push back** starts the experimental guided manoeuvre, with
**Stop pushback** available while it runs. After a confirmed stop, the display
continues with manual taxi guidance. Closing the toolbar Taxi tab stops a
pushback started by that tab. Optional **Autotaxi** remains a separate action
in the desktop app; the toolbar has no Autotaxi controls.

### Aircraft setup and controls

The PMDG connection guide checks known 737 and 777 options files, shows what
needs attention and provides **Open folder**, **Copy settings** and **Check
again**. It does not edit simulator configuration files for you. Desktop setup
links also make the toolbar installer easier to find.

This version includes a partial iniBuilds A380 integration and updates to
MD-11 controls and lighting presets. Support varies by aircraft and installed
version; use the available actions and readiness information shown in the app.

### Voice and reliability

Voice recognition remains offline in the Windows desktop app. The updated
English model is accompanied by checks for silence and ambiguous numeric
commands, plus microphone cleanup when recognition stops unexpectedly.
Recognition still depends on your microphone, accent and background noise.

Startup recovery more carefully identifies FlightFabric's own background
processes. Slow or stalled connected displays are disconnected before replies
can continue accumulating in memory. Flight recording keeps its existing
per-file limits and low-disk checks; completed recordings remain yours to keep
or delete.

</details>

<details>
<summary><strong>Known limitations</strong></summary>

Pushback and Autotaxi remain experimental. Check the route and aircraft
readiness before starting, and keep the stop control available. Aircraft and
scenery combinations have different behavior and have not all been verified.

The iniBuilds A380 integration is partial. Takeoff scoring remains disabled.
Aircraft controls require the appropriate aircraft setup and fresh data.

3D maps are optional and require compatible graphics support. Online imagery
and terrain depend on their data services; use 2D if 3D is unreliable on your
system. Phone and tablet control requires pairing and approval on the simulator
PC. MSFS 2020 and X-Plane are not currently supported.

</details>

<details>
<summary><strong>Installation help and optional file verification</strong></summary>

Download `FlightFabric.Setup.0.11.0.exe`. GitHub's **Source code** archives are for
developers; the installer is all you need to use FlightFabric.

The current alpha is unsigned, so Windows may show **Windows protected your
PC** when you open the installer. Select **More info**, check that the app is
`FlightFabric.Setup.0.11.0.exe` with **Unknown publisher**, and select **Run anyway** if
you downloaded it from the official link above. If that option is unavailable
or Windows reports a threat, stop and report the warning; do not disable
Windows security protections.

GitHub shows the installer's SHA-256 checksum beside the file in **Assets** if
you want to verify your download.

</details>

[Getting started](https://github.com/yenbuilds/flight-fabric#readme) ·
[Licence](https://github.com/yenbuilds/flight-fabric/blob/v0.11.0/LICENSE.md) ·
[Third-party notices](https://github.com/yenbuilds/flight-fabric/blob/v0.11.0/THIRD_PARTY_NOTICES.md)

Thank you to everyone supporting FlightFabric through feedback, testing and
donations.
