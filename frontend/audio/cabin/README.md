# Cabin PA Audio

This folder contains bundled cabin announcement packs. Flight Fabric can also
load personal audio from the user's application data folder.

## How playback works

Cabin announcements are driven by backend telemetry events:

- The backend watches flight phase changes and altitude crossings.
- When a slot should play, it broadcasts a `cabinAnnouncement` WebSocket
  message with `{ phase, style }`.
- The frontend maps the phase and slot to a filename, finds the audio, queues
  it, and plays it through `HTMLAudioElement`.
- Each phase or altitude slot plays at most once per flight. The list resets on
  `flight:started` and `simconnect:aircraftChanged`.
- Duplicate messages are ignored while the same phase is queued, starting,
  playing, or paused.

Cabin announcements are disabled by default. Enable them under
**Settings** -> **Cabin Audio**.

## Recognized slots

The code recognizes these slots and filenames:

| Backend slot | Filename stem | Trigger |
|---|---|---|
| `TAXI` | `pushback-start` | Stable taxi before the aircraft has been airborne, with latest telemetry on the ground |
| `CLIMB` | `climb` | Stable climb after takeoff, with confirmed airborne telemetry and final radio altitude at least 1,000 ft |
| `CRUISE` | `cruise` | Stable cruise, with confirmed airborne telemetry |
| `DESCENT` | `descent-start` | Stable descent, with confirmed airborne telemetry |
| `APPROACH` | `approach` | Transition into approach, with confirmed airborne telemetry |
| `TAXI-IN` | `shortly-after-landing-rollout` | Transition to taxi after landing, with airborne history and current telemetry confirming the aircraft is on the ground |
| `ABOVE_10K` | `transition-to-above-10k-feet` | Airborne climb through 10,200 ft MSL |
| `BELOW_10K` | `transition-to-below-10k-feet` | Airborne descent through 9,800 ft MSL |

Supported extensions are tried in this order: `.mp3`, `.ogg`, `.wav`.

## Bundled standard pack

The current bundled `standard` pack contains:

```text
frontend/audio/cabin/standard/
  pushback-start.wav
  climb.wav
  cruise.wav
  descent-start.wav
  approach.wav
  shortly-after-landing-rollout.wav
  transition-to-above-10k-feet.wav
  transition-to-below-10k-feet.wav
```

## Provenance And Licensing

The bundled `standard` pack is original first-party audio made for Flight
Fabric and contains no third-party recordings. The project owner authorizes
these files to be distributed with Flight Fabric source and binary releases
under the project's release terms.

Only bundle audio that the project can redistribute. If future audio comes from
a third party, record its source, licence, and required attribution in
`THIRD_PARTY_NOTICES.md` before adding it. Do not copy audio from airlines,
simulators, stock libraries, or other third parties without that review.

## Timing and suppression

The first phase sample establishes a baseline and does not play an announcement.
This prevents stale audio when Flight Fabric connects during a flight.

Phase dwell timers:

| Phase | Dwell |
|---|---:|
| `TAXI` | 5 seconds |
| `CLIMB` | 30 seconds |
| `CRUISE` | 120 seconds |
| `DESCENT` | 180 seconds |
| `APPROACH` | 0 seconds |
| `TAXI-IN` | 0 seconds |

If the phase changes before the dwell ends, the pending announcement is
canceled.

Additional gates:

- Phase announcements require at least one telemetry frame.
- `TAXI` is suppressed if the aircraft has already been airborne or the latest
  telemetry says it is airborne.
- `CLIMB`, `CRUISE`, `DESCENT`, and `APPROACH` are suppressed while the latest
  telemetry says the aircraft is on the ground, or until it confirms an
  airborne state.
- `CLIMB` is suppressed at the final check if radio altitude is below 1,000 ft.
- `TAXI-IN` is suppressed unless the aircraft has been airborne and the latest
  telemetry confirms that it is back on the ground.
- A frame confirms flight with an explicit airborne flag, or with radio
  altitude above 50 ft when ground state is unavailable. MSL altitude alone is
  not enough.
- Altitude slots use a 200 ft buffer around 10,000 ft: above plays at 10,200 ft
  and below plays at 9,800 ft.
- During startup and while on the ground, altitude samples establish a baseline
  without playing audio. This prevents an old crossing from replaying.
- Startup grace defaults to 5,000 ms and resets when the app, flight, or aircraft
  changes.
- Browser tabs coordinate through the Web Locks API when available, so only one
  tab plays a PA message.

## File search order

For a style such as `standard` and a slot such as `pushback-start`, the frontend
tries:

```text
/user-assets/cabin/standard/pushback-start.mp3
/user-assets/cabin/standard/pushback-start.ogg
/user-assets/cabin/standard/pushback-start.wav
audio/cabin/standard/pushback-start.mp3
audio/cabin/standard/pushback-start.ogg
audio/cabin/standard/pushback-start.wav
```

The backend serves `/user-assets/cabin/...` from:

```text
<app-data>/Flight Fabric/Audio/Cabin/{style}/
```

Then the frontend falls back to bundled files under:

```text
frontend/audio/cabin/{style}/
```

Custom styles do not fall back to `standard`. If `easyjet` is selected, Flight
Fabric looks only for `easyjet` files.

## User audio folder

Direct user overrides live here:

```text
Windows: %APPDATA%/Flight Fabric/Audio/Cabin/{style}/
macOS:   ~/Library/Application Support/Flight Fabric/Audio/Cabin/{style}/
Linux:   ${XDG_CONFIG_HOME:-~/.config}/Flight Fabric/Audio/Cabin/{style}/
```

Example:

```text
%APPDATA%/Flight Fabric/Audio/Cabin/standard/pushback-start.wav
```

This file overrides the bundled `standard/pushback-start.wav`.

## Settings

Settings UI:

```text
Settings -> Cabin Audio
```

Settings JSON shape:

```json
"cabinAnnouncements": {
  "enabled": false,
  "style": "standard",
  "startupGraceMs": 5000
}
```

Style names may contain letters, numbers, hyphens, and underscores. Startup
grace is limited to `0..60000` ms.

Environment overrides also exist:

```text
CABIN_ANNOUNCEMENTS_ENABLED=true|false
CABIN_ANNOUNCEMENTS_STYLE=standard
CABIN_ANNOUNCEMENTS_STARTUP_GRACE_MS=5000
```

Saved settings are the normal way to configure announcements.

## Playback controls

Cabin announcements play without a dedicated header indicator or mute button.

Muting behavior:

- Muting pauses current audio; unmuting resumes it.
- An announcement received while muted is discarded instead of queued.
- Mute is temporary interface state; it does not change the settings file.
