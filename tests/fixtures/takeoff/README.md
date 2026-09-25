# Recorded takeoff regression fixture

`rolling-runway-entry.csv` contains the original takeoff-relevant samples from
the local 2026-07-26 02:11:22Z PMDG 737 recording, from 180 seconds before
liftoff to 10 seconds afterwards. Time is relative to the observed WOW release;
identity fields and unrelated telemetry are omitted. Sample spacing, speeds,
headings, position, attitude and surface observations are retained.

The aircraft taxis above 30 kt before turning onto runway 34 at Melbourne.
Explicit runway contact starts 32.5 seconds before liftoff. The previous
selection counted 162.5 seconds, including the opposite-direction taxi, as
the takeoff roll. This fixture protects the runway-entry boundary while the
synthetic runner tests protect excursions after a roll has been established.

`rolling-unknown-surface.csv` retains the same columns from the 2026-07-12
05:42:49Z recording. Surface membership was unavailable while taxiing above
30 kt in the opposite direction before slowing and turning onto the runway.
It protects selection of the final acceleration run when surface data cannot
identify runway entry. This prevents the entry correction from reintroducing
earlier taxiing into recordings with missing surface telemetry.

The runner suite also mutates copies of `rolling-runway-entry.csv` in memory
to test a rejected takeoff and two settle-backs with an earlier pitch peak.
The source fixture remains unchanged. These mutations test detection and
retained findings; they do not model aircraft physics or engine failures.

For an optional read-only review of other local recordings, compile the backend
and run `node tests/scripts/replay-takeoff-csv.js <csv-or-recordings-directory>`.
It uses the production CSV parser and takeoff runner, prints JSON summaries,
and does not write scores back to recordings or the Logbook. CSV samples cannot
recreate unrecorded provider freshness signals, and offline airport geometry
does not establish the simulator runway's accuracy.

## Reference expectations and degraded telemetry (2026-09-24)

The existing runner suite now contains a small reference matrix. Its expected
outcomes are defined by the constructed events independently of analyzer
output. It uses the same production runner and the two CSV fixtures above;
there is no separate scoring implementation or additional replay framework.

| Evidence/case | Expected result |
| --- | --- |
| Synthetic normal departure, with isolated heading or position spikes | One departure; no operational warning from the isolated sample |
| Airborne crosswind heading or first airborne position outside the reference edge | Measured heading/offset; no ground-control or excursion claim from that airborne point |
| One WOW release during an otherwise continuous ground roll | No confirmed settle-back; the later sustained departure is retained |
| One ground-contact indication during climb, including a following telemetry gap | Contact remains uncertain; neither a confirmed hop nor a clean departure |
| Two distinct ground observations during a 200 ms settle-back | One confirmed hop, retained through the subsequent climb |
| One height spike, including an exact duplicate of that sample | Cannot finalize the departure or establish a screen-height crossing by itself |
| Synthetic normal departure and sustained excursion at 200/500/1,000 ms intervals | Departure retained in each case; the supported excursion remains critical |
| Missing or non-finite heading, position, surface or height inputs | No invented pilot-error finding; incomplete height remains explicit |
| Recorded rolling departure with duplicated rows or every third row removed | One departure, no additional findings, roll still excludes the preceding fast taxi |
| Recorded rolling departure with runway membership removed | One departure without added findings; rolling-start estimate stays qualified |

Analysis tests separately exercise confirmed lateral edge contact, isolated
positions, duplicate timestamps, missing surface membership, unverified
geometry, and heading evidence that is isolated, opposed, missing or separated
by a gap. Existing rejected-takeoff, overrun, touch-and-go, pause/disconnect,
missing-WOW and recovered-excursion cases remain in the same suite.

Removing runway membership can move the estimated rolling start. The reference
case therefore checks the rolling-start qualification rather than demanding
the original distance after its supporting evidence has been removed.

These are telemetry-level expectations. Recorded cases have not been labelled
against simulator video, and synthetic cases are not aircraft-physics models.
Passing the set measures regression coverage, not a population error rate or
independent proof of what happened in every recorded flight. Very brief real
contacts seen in only one sample remain unresolved. Correlated bad samples
and stale data without provider freshness metadata can still defeat simple
corroboration checks; controlled simulator observations remain outstanding.
