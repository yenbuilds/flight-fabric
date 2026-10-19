# FlightFabric Rust SimConnect Sidecar

This crate is FlightFabric's native bridge to Microsoft Flight Simulator's
SimConnect API. It communicates with the FlightFabric backend using
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

Rust owns the SimConnect session and native reads/writes. The TypeScript
bridges own process supervision, provider normalization and aircraft/profile
selection; flight scoring and presentation stay outside this crate. The same
sidecar supports generic SimVars, LVARs and declarative SDK/ClientData connectors.
The protocol uses commands on stdin and JSON messages on stdout; diagnostics
belong on stderr. See [`src/protocol.rs`](src/protocol.rs) for wire shapes and
input bounds.

## Build and checks

Run these from the repository root with the project dependencies and Rust
toolchain installed:

```powershell
npm.cmd run build:backend:runtime
npm.cmd run test:rust-sidecar
```

The runtime build compiles a release binary in an isolated repository scratch
target and stages it under `dist/backend/telemetry-provider/`. The maintained
test command exercises the configured SDK connector matrix and protocol tests;
a single default `cargo test` invocation is not that complete matrix.

Production modules are under `src/`. Unit-test bodies live in `tests/unit/`
and are included by the original `#[cfg(test)]` modules, preserving private
access and feature gates. `tests/sidecar_protocol.rs` contains integration tests.

Runtime DLL discovery, bridge ownership and migration history are described in
the [Rust SimConnect migration](../../../docs/RUST-SIMCONNECT-MIGRATION.md).
Aircraft transport configuration belongs in the
[integration transport guide](../../../docs/AIRCRAFT-INTEGRATION-TRANSPORTS.md).

Historical components and their distribution status are documented in
[`THIRD_PARTY_NOTICES.md`](../../../THIRD_PARTY_NOTICES.md).
