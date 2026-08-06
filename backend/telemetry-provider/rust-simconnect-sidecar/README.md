# Flight Fabric Rust SimConnect Sidecar

This crate is Flight Fabric's native bridge to Microsoft Flight Simulator's
SimConnect API. It communicates with the Flight Fabric backend using
newline-delimited JSON over standard input and output.

## Licence and source

This crate is licensed under the GNU Affero General Public License version 3
only (`AGPL-3.0-only`). The full licence is
[`../../../LICENSE.md`](../../../LICENSE.md). Corresponding source for released
versions is available from
<https://github.com/yenbuilds/flight-fabric/releases>.

## Implementation

The current crate dynamically loads Microsoft's `SimConnect.dll` and calls the
SimConnect C ABI. It does not bundle a third-party SimConnect implementation.

Historical components and their distribution status are documented in
[`THIRD_PARTY_NOTICES.md`](../../../THIRD_PARTY_NOTICES.md).
