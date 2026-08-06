# Aircraft Profiles

Each aircraft profile belongs to one simulator and uses this identity:

`namespace/simulator/id`

Examples:

- `bundled/msfs/fbw-a32nx`
- `bundled/xplane/generic`

This prevents name collisions between simulators and keeps aircraft behavior
separate from simulator bindings.

## Layout

Bundled Flight Fabric profiles live under:

- `backend/aircraft/profiles/bundled/msfs/*.json`
- `backend/aircraft/profiles/bundled/xplane/*.json`

## Loading and ownership

Bundled profiles are read from the repository or installed app resources. The
runtime accepts only `bundled/<simulator>/<id>` profiles owned by a Flight
Fabric release. Profile import, editing, copying, deletion, and user-directory
overrides are intentionally unsupported. Older files under
`Profiles/Aircraft/Local/` or `Profiles/Aircraft/Community/` are ignored and
left untouched. These locations are unrelated to the MSFS `Community`
installation folder used as aircraft-matching evidence.

## File shape

Each profile describes one simulator. MSFS and X-Plane variants use separate
files.

Basic shape:

```json
{
  "version": 2,
  "id": "example-airliner",
  "name": "Example Airliner",
  "simulator": "msfs",
  "namespace": "bundled",
  "aircraft": {
    "category": "D",
    "flaps": {},
    "gear": {},
    "stability": {},
    "landing": {},
    "throttle": {},
    "engines": {},
    "performance": {}
  },
  "integration": {
    "matching": {},
    "telemetry": {},
    "controls": {},
    "signalReliability": {},
    "presentation": {}
  },
  "meta": {},
  "provenance": {}
}
```

## Design rule

Put aircraft behavior under `aircraft.*`:

- flap detents
- landing grade thresholds
- landing configuration and telemetry used by debriefs
- category A stability metadata and compatibility fields
- engine count/type

Put simulator bindings under `integration.*`:

- MSFS title matching
- X-Plane `.acf` matching
- LVARs, SDK channels, datarefs, commands
- control actions
- light source reliability
- UI presentation support

If a field names an MSFS or X-Plane primitive, it belongs under `integration`,
not at the top level.

## Family profiles and variant IDs

A profile ID describes shared behavior, not necessarily one exact aircraft
variant. A family ID such as `example-airliner-family` is appropriate when its variants share
simulator bindings, cockpit signals, controls, flap and gear behavior, and
scoring assumptions.

Use the profile name, matching rules, and source notes to describe the covered
variants. Telemetry and flight logs retain the exact simulator aircraft name;
`aircraft_profile_id` records the behavior profile that was active.

Split a family only when a variant changes behavior that Flight Fabric needs to
model, such as:

- different LVAR, SDK, dataref, command, or control names
- different engine count, layout, or cockpit system behavior
- different flap detents, landing configuration, V speed envelope, or limits
- different category A stability or debrief behavior
- different fallback or suppression rules for unreliable simulator values

When splitting a family, provide an alias or migration path so IDs in older logs
and settings still resolve. Let a variant inherit from the family when their
shared behavior matches.

## Stability And Debrief Criteria

Approach stability uses shared, versioned scoring rules. It is not an aircraft
certification model.

Current policy:

- Generic aircraft and aircraft outside category A use the common
  `transport-v1` criteria.
- Category A aircraft use the lighter `ga-profile-v1` path, where mapped
  `aircraft.stability` values can override matching common fields.
- Profiles continue to define telemetry decoding, signal reliability, and the
  meaning of gear, flap, spoiler, and throttle data.
- A recorded scoring context, not the currently active profile, is authoritative
  when explaining a saved result.

Existing `aircraft.stability` blocks remain valid for category A scoring,
metadata, and older recordings. Transport scoring ignores bands for individual
airliners, so changing a transport profile's stability block does not change
its live score.

`vref` ranges are metadata. Flight Fabric does not calculate the selected Vref
or Vapp from weight and flap state, and it does not yet have a verified target
speed signal. The speed check uses IAS at the stability gate. A profile should
claim authoritative Vref data only when a verified source has been added and
tested.

## Telemetry source preference

`integration.telemetry.preferred` names the main telemetry provider. For MSFS,
`preferred: "simconnect"` keeps the normal SimConnect frame as the main source
for speed, altitude, attitude, engines, gear, flaps, and generic systems.

Active `integration.telemetry.lvars` are still subscribed when present. They
provide focused read overlays for fields that the profile maps explicitly,
such as AP/A/T state, MCP/FCU windows, mode lights, spoilers, parking brake, or
aircraft lights.

Having LVARs does not by itself justify changing `preferred`. Choose a custom
provider only when SimConnect is unreliable for that profile, and explain the
choice in comments or `provenance.verification`.

## Aircraft integrations and panel bindings

Aircraft panels use stable logical field and action IDs. Raw vendor names,
provider selection, and write mechanics stay in the backend.

There are two supported integration mechanisms inside a bundled profile:

- a bundled integration adapter owned by the backend; or
- declarative read fields plus a registered template.

### Bundled adapters

A bundled profile selects its adapter with a small reference:

```json
{
  "integration": {
    "aircraftSpecific": {
      "adapter": "fbw-a32nx"
    }
  }
}
```

An adapter ID alone does not grant access. Flight Fabric activates it only when
the ID and complete profile key match a trusted backend registration. Writes
also require the current profile revision. For example,
only `bundled/msfs/fbw-a32nx` can activate the `fbw-a32nx` adapter.

The adapter owns the reviewed aircraft behavior:

- logical field IDs, decoders, and ordered source choices;
- the registered panel template;
- logical write actions, verification state, guards, and confirmation rules;
- transport routes such as MobiFlight calculator execution, Input
  Events, LVAR inputs, or vendor SDK commands.

These mappings and routes do not belong in the profile JSON. Profiles must not
contain raw calculator code, adapter routes, backend commands, guard
definitions, or transport readback rules. The browser receives only logical
IDs, decoded values, and capability state.

Fields used to confirm writes are kept in an internal adapter set. A profile can
change panel presentation, but it cannot replace the source or decoder that
guards a trusted write.

Adapter sources are stored in preference order. The loader chooses the first
source supported by a registered binding. An SDK source is eligible only when
the profile configures that SDK adapter. This choice happens while loading the
profile; it is not automatic live failover.

### Declarative read-only panels

Bundled profiles can build a read-only panel without an adapter. They declare
bounded fields and select a template registered in the app:

```json
{
  "integration": {
    "telemetry": {
      "aircraftSpecific": {
        "fields": {
          "mcp.altitudeFt": {
            "source": {
              "type": "sdk",
              "adapter": "clientdata-manifest",
              "path": "automation.mcp.altitudeFt"
            },
            "decode": { "type": "number", "precision": 0 }
          }
        }
      }
    },
    "presentation": {
      "aircraftSpecific": {
        "template": "example-sdk-aircraft"
      }
    }
  }
}
```

Here, `source.adapter` identifies a normalized SDK telemetry source. It is
different from `integration.aircraftSpecific.adapter`, which selects a trusted
integration.

Declarative `lvar` fields share duplicate sidecar subscriptions. Declarative
`sdk` fields can read only bounded paths from the active adapter's normalized
snapshot. Templates never receive raw SDK payloads or code supplied by a
profile.

Only a bundled profile key registered by the backend can activate a trusted
adapter and its writes.

## Flap notches and scoring

Flap notches are mainly display and normalization metadata. They can turn
`FLAPS HANDLE INDEX`, custom flap LVARs, or `FLAPS HANDLE PERCENT` into a
cockpit label. By themselves, they do not verify Vref or landing configuration.

Stability scoring treats flaps as configured when extension is above 10 percent
or the resolved notch is above zero. It then checks that raw flap percentage
does not change after the stability gate. The exact value does not need to
appear in `landingNotches`.

Broad base profiles must not define flap notches when they match unrelated
aircraft. Keep `airbus-base`, `boeing-base`, `widebody-base`, `regional-jet`,
`ga-base`, and `turboprop-base` free of
`aircraft.flaps.notches`; put detents supported by source evidence on a specific
aircraft or narrow family profile instead.

Generic fallback profiles should not assert flap detents. Runtime helpers may
still expose permissive percent fallback values for display/API compatibility,
but those values are not source evidence for any aircraft.

## Control actions

The UI sends intents such as `gear down`, `flaps increment`, or
`autopilot heading set 240`. Profiles translate them into simulator actions
under `integration.controls`.

A control action can be either a single action object or an ordered list of
candidate actions. Lists allow a preferred aircraft control with a safe
fallback.

Broad generic MSFS cockpit writes are blocked by default. Without a profile
mapping, Flight Fabric supports only gear up, down, and toggle, plus flap
increment and decrement.

Set `genericFallback: true` only when broad simulator controls are known to be
appropriate. To allow only standard gear and flap controls, use
`genericFallback: false` with `standardSurfaceFallback: true`.

```json
{
  "integration": {
    "controls": {
      "genericFallback": true,
      "autopilot": {
        "selectorActions": {
          "headingSet": [
            { "type": "input-event", "name": "CUSTOM_HEADING_INPUT", "verification": "untested" },
            { "type": "lvar", "name": "L:CUSTOM_HEADING_FALLBACK", "unit": "Number", "verification": "partial" },
            { "type": "key-event", "name": "HEADING_BUG_SET", "verification": "verified" }
          ]
        }
      }
    }
  }
}
```

Public MSFS profile action types are `key-event`, `input-event`, `html-event`,
`lvar`, and `simvar`. The current MSFS runtime written in Rust supports
`key-event`, `lvar`, and `simvar`. List `input-event` and B-var support only
with a fallback until the provider supports them.

Aircraft integration actions are not public profile action types. Their routes
are selected only after exact profile and provider checks. Do not place
calculator code, adapter commands, route selections, or private transport
payloads under
`integration.controls`; add them to the reviewed adapter instead.

Control actions are simulator tokens, not scripts. The runtime limits names,
units, values, and parameters, removes unexpected fields, and rejects nested
payloads or values that resemble shell commands before execution.

X-Plane action types are `command` and `dataref`. Profiles can declare them, but
X-Plane control execution is not implemented yet.

Keep `integration.telemetry` and `integration.controls` separate. A read LVAR or
dataref may overlap with a write target, but many aircraft expose different
readbacks and command inputs. Duplicate the name when that is the clearest
profile contract.

Each active control action in bundled profiles must include `verification`:

- `untested` means source evidence exists but the action has not been tried in
  the simulator.
- `partial` means it has limited manual coverage or only part of the action chain
  has been exercised.
- `verified` means the action name is covered by `provenance.sources[]` and the
  write path has been tested against the target aircraft.

## Matching

MSFS profiles use:

- `integration.matching.titleContains`
- `integration.matching.titleRegex`
- `integration.matching.titleExcludes` to reject title matches regardless of
  case
- `integration.matching.configPathContains` / `configPathRegex` for package and
  SimObject path evidence
- `integration.matching.configPathExcludes` to reject paths regardless of case
- `integration.matching.aircraftCfg` for structured `aircraft.cfg` fields such
  as `icao_type_designator`, `title`, and `ui_createdby`. Require evidence for
  both the aircraft type and its vendor.

Exclusions take precedence over every positive rule, including structured
`aircraft.cfg` evidence. Use them when related products reuse titles, model
folders, or compatibility assets. A child profile inherits its
parent's exclusions unless it explicitly replaces the arrays.

X-Plane profiles use:

- `integration.matching.xplane.acfPaths`
- `integration.matching.xplane.acfFileNames`
- `integration.matching.xplane.aliases`

## Creation

Start from:

- `_template.json` for MSFS
- `_template-xplane.json` for X-Plane

Minimum practical fields for a new profile:

```json
{
  "$schema": "./aircraft-profile.schema.json",
  "version": 2,
  "id": "my-aircraft",
  "name": "My Aircraft",
  "simulator": "msfs",
  "namespace": "local",
  "aircraft": {
    "category": "C"
  },
  "integration": {
    "matching": {
      "titleContains": ["My Aircraft"]
    },
    "telemetry": {
      "preferred": "simconnect"
    }
  },
  "meta": {
    "status": "experimental",
    "platforms": ["msfs2020", "msfs2024"]
  }
}
```

## Provenance

Every active custom mapping in a bundled profile needs supporting
`provenance.sources[]` evidence. This includes:

- active LVARs
- SDK connector, adapter, and channel tokens
- aircraft adapter selections and the backend mappings
  they activate
- X-Plane datarefs and commands
- custom control action names

Use exact names in source notes when possible. Wildcard families such as
`VENDOR787_MCP_*` are allowed when the source genuinely covers the whole family.
Every active mapping must be supported by an authoritative source or a
reproducible in-simulator verification record.

An evidence source may set `supportsActiveMappings: true` only when:

- `authority` is `simulator-vendor` or `aircraft-vendor`;
- `access` is `public` or `vendor-install`;
- `type` is `official-sdk`, `official-docs`, or a `forum` owned or staffed by
  the vendor;
- its notes identify the exact names or a documented wildcard family.

Standard MSFS SimVars remain covered by Microsoft's simulator SDK. A vendor
value stays unavailable when the aircraft does not mirror the standard state.

Custom telemetry preferences and fallback suppression must be explained in
profile evidence. If `integration.telemetry.preferred` is not `simconnect`, or
if standard SimVars are marked unreliable/suppressed, document why and what
source replaces or suppresses them.

A bundled profile with active custom mappings can use
`meta.status: "production"` only when `provenance.verification.status` is
`verified`.

## Notes

- `extends` should prefer the full `namespace/simulator/id` form.
- Release profiles use the v2 format.
- Profiles in `Profiles/Aircraft/Local/` and
  `Profiles/Aircraft/Community/` are ignored and left untouched.

## Validation

Useful commands:

- `npm run validate:profiles`
- `node scripts/validate-aircraft-profiles.js --strict`
- `node scripts/validate-profile-completeness.js`
- `npm run test:aircraft-profile-provenance`
- `npm run build:backend:runtime`
- `npm run test:rust-sidecar` when SDK mappings changed

Active mappings must satisfy the source and verification requirements above;
keep incomplete mappings inactive until the required evidence is available.
