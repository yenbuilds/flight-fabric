# FlightFabric 0.10.2 · Public Alpha

## [Download for Windows (.exe)](https://github.com/yenbuilds/flight-fabric/releases/download/v0.10.2/FlightFabric.Setup.0.10.2.exe)

**Public alpha · Free · Windows 64-bit · Microsoft Flight Simulator 2024**

Still in development. Expect bugs and incomplete aircraft support.

Finish your flight and close FlightFabric, then run the downloaded installer.
Your settings and recordings stay in their current locations. If you use the
FlightFabric toolbar panel, close MSFS and choose **Update** or **Reinstall** in
**Settings > MSFS 2024 toolbar panel**, then restart the simulator.

## What's new

- **Easier event inspection:** desktop event details expand inside the flight
  list. Selecting a map marker scrolls to and highlights its event, ready for
  you to open the details. Phones retain their existing detail sheet.
- **Landing reviews up front:** scored-landing history is above the Logbook
  workspace, and **Landing debrief** opens the complete review directly.
- **Clearer review tools:** **Compare scoring rules** explains the scoring
  preview, while event-list and map filters clearly show their separate scope.
- **More reliable 3D maps:** imagery refreshes after resizing or moving the
  camera, failed images retry, and coarse terrain no longer obscures loaded
  detailed ground.

<details>
<summary><strong>Full release notes</strong></summary>

### Flight events and landing reviews

Desktop Logbook reviews keep the event list and replay map visible while
details expand beneath an event. **Details**, **Hide details** and Escape make
opening and closing clear. The list scrolls to keep the event and its details
in view, including when closing a long detail panel.

Clicking a desktop map marker highlights and scrolls to the matching event
without opening its details. Events hidden by list filters are temporarily
shown with an explanation; your saved filter choices stay intact. Phones
continue to open event details in their existing bottom sheet.

Scored-landing history now appears above the flight workspace. The selected
flight's **Landing debrief** button opens the complete latest landing review
directly. Its additional recorded context belongs to that landing, and closing
the review returns you to the same flight.

**Compare scoring rules** lets you preview results under today's rules before
choosing whether to save them. A separate **Saved** indicator shows when current
scoring has been saved. **Filter event list** and **Map events** explain which
surface they affect and show when event types are hidden.

### 3D map loading and terrain

Live and recorded-flight 3D maps refresh their imagery after the window changes
size and after camera movement settles. Failed images retry within a limited
number of attempts, and delayed images appear when they finish loading.

Detailed ground remains visible when overlapping coarse terrain has a different
height. Coarse coverage remains while detailed tiles load, and joins between
terrain levels avoid gaps. Terrain still depends on the available elevation
data and can differ from a simulator's airport surface.

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

Download `FlightFabric.Setup.0.10.2.exe`. The **Source code** archives in GitHub's Assets
section are for developers; the installer is all you need to use FlightFabric.

The current alpha is unsigned, so Windows may show **Windows protected your
PC** when you open the installer. Select **More info**, check that the app is
`FlightFabric.Setup.0.10.2.exe` with **Unknown publisher**, and select **Run anyway** if
you downloaded it from the official link above. If that option is unavailable
or Windows reports a threat, stop and report the warning; do not disable
Windows security protections.

GitHub shows the installer's SHA-256 checksum beside the file in **Assets** if
you want to verify your download.

</details>

[Getting started](https://github.com/yenbuilds/flight-fabric#readme) ·
[Licence](https://github.com/yenbuilds/flight-fabric/blob/v0.10.2/LICENSE.md) ·
[Third-party notices](https://github.com/yenbuilds/flight-fabric/blob/v0.10.2/THIRD_PARTY_NOTICES.md)

Thank you to everyone supporting FlightFabric through feedback, testing and
donations.
