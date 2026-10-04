# FlightFabric 0.12.0 · Public Alpha

## [Download for Windows (.exe)](https://github.com/yenbuilds/flight-fabric/releases/download/v0.12.0/FlightFabric.Setup.0.12.0.exe)

**Public alpha · Free · Windows 64-bit · Microsoft Flight Simulator 2024**

Still in development. Expect bugs and incomplete aircraft support.

Finish your flight and close FlightFabric, then run the downloaded installer.
Your settings and recordings stay in their current locations. Update the
toolbar too: close MSFS, open **Settings > MSFS 2024 toolbar panel** in
FlightFabric, choose **Update** or **Reinstall**, then restart the simulator.

## What's new

- **Review your takeoff:** see ground roll, liftoff speed, rotation and runway
  remaining, with detected cautions in the app and MSFS toolbar.
- **Talk using your controller:** choose a yoke or joystick button for voice
  push-to-talk, alongside the existing keyboard shortcut.
- **Simpler toolbar taxi map:** follow a north-up 2D route with a live aircraft
  marker, improved pushback startup and clearer toolbar update reminders.
- **More aircraft controls:** expanded lighting and flight-guidance controls
  for supported aircraft, with availability matched to the current aircraft.
- **Clearer desktop setup:** keyboard and controller voice options are grouped
  together, connection recovery is improved, and settings fit small screens better.

<details>
<summary><strong>Full release notes</strong></summary>

### Review your takeoff

The takeoff report shows ground-roll distance, liftoff speed, average rotation
and runway remaining, with detected cautions alongside the measurements.
Open **Full Report** in the app for more detail, or check **Last takeoff** in
the MSFS toolbar. Saved departures are available alongside your flight history.

Capture normally finishes around 50 ft. The report covers the takeoff roll and
liftoff; normal flight recording continues through the climb. More runway
remaining does not mean a better takeoff. Landing reports continue separately.

### Use a yoke or joystick button for voice

Open **Settings > Voice control** and choose a controller button under
**Push-to-talk**. Follow the press-and-release check, then save the button.
Hold it to speak and release it when finished, including while MSFS is in front.
The keyboard shortcut and on-screen voice button remain available.

After setup, a restart or reconnection, an extra press and release may be needed
before the first hold. Existing simulator or ATC assignments still respond to
the same button, so choose an otherwise unassigned button. Device support varies.

### Follow a simpler taxi map in the toolbar

The toolbar's **Taxi map** now shows a simple north-up route diagram and live
aircraft marker. It retains the route while the aircraft moves; fresh position
data is required to show the marker. The desktop taxi views remain available.

Pushback startup now waits for the simulator tug to couple before treating its
inactive readback as a stop. An outdated toolbar package gets a clearer update
reminder. Use the toolbar update instructions above after installing FlightFabric.

### Aircraft controls and desktop improvements

Aircraft lighting and flight-guidance controls have been expanded, with more
precise aircraft identification and availability checks. Support still depends
on the aircraft and installed version; unavailable controls explain what is missing.

Voice settings put keyboard and controller push-to-talk together. Connection
recovery, SimBrief guidance and saved-flight search controls are clearer, with
layout improvements on narrow screens.

</details>

<details>
<summary><strong>Known limitations</strong></summary>

Pushback and Autotaxi remain experimental. Check the route and aircraft readiness
before starting, and keep the stop control available. Autotaxi can stop with
**Control write failed. Take control.**; take over manually if this occurs.
Automatic parking-brake handover can also fail at the holding point. If prompted,
set the parking brake yourself before releasing controls.

Voice recognition runs locally in the Windows desktop app. Results depend on
your microphone, accent and background noise. Controller compatibility varies;
reconnecting a device may require selecting its button again.

Aircraft and scenery combinations have not all been verified. The iniBuilds A380
integration is partial. Aircraft controls require the appropriate setup and fresh data.

Desktop 3D maps require compatible graphics support and online imagery services.
Phone and tablet control requires pairing and approval on the simulator PC.
MSFS 2020 and X-Plane are not currently supported.

</details>

<details>
<summary><strong>Installation help and optional file verification</strong></summary>

Download `FlightFabric.Setup.0.12.0.exe`. GitHub's **Source code** archives are for
developers; the installer is all you need to use FlightFabric.

The current alpha is unsigned, so Windows may show **Windows protected your
PC** when you open the installer. Select **More info**, check that the app is
`FlightFabric.Setup.0.12.0.exe` with **Unknown publisher**, and select **Run anyway** if
you downloaded it from the official link above. If that option is unavailable
or Windows reports a threat, stop and report the warning; do not disable
Windows security protections.

GitHub shows the installer's SHA-256 checksum beside the file in **Assets** if
you want to verify your download.

</details>

[Getting started](https://github.com/yenbuilds/flight-fabric#readme) ·
[Licence](https://github.com/yenbuilds/flight-fabric/blob/v0.12.0/LICENSE.md) ·
[Third-party notices](https://github.com/yenbuilds/flight-fabric/blob/v0.12.0/THIRD_PARTY_NOTICES.md)

Thank you to everyone supporting FlightFabric through feedback, testing and
donations.
