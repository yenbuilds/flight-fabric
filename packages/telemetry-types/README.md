# @flight-fabric/telemetry-types

TypeScript type definitions for Flight Fabric telemetry WebSocket messages.

## Installation

```bash
npm install @flight-fabric/telemetry-types
```

## Usage

```typescript
import {
  MSG,
  PHASE,
  type TelemetryMessage,
  type TelemetryState,
  type Phase,
} from '@flight-fabric/telemetry-types';

// Handle messages with type checking
function handleMessage(msg: TelemetryMessage) {
  switch (msg.type) {
    case MSG.IAS:
      console.log(`IAS: ${msg.value} knots`);
      break;
    case MSG.PHASE:
      console.log(`Phase: ${msg.value}`);
      break;
    case MSG.LANDING:
      console.log(`Landing: ${msg.grade} at ${msg.vs} fpm`);
      break;
  }
}

// Read state with type checking
function checkApproach(state: TelemetryState): boolean {
  return state.phase === PHASE.APPROACH;
}
```

## Exports

### Enums

- `MSG` - WebSocket message type constants
- `PHASE` - Flight phase values
- `ENVELOPE_STATUS` - Envelope status values

### Message types

All WebSocket message types are exported individually:

- `IASMessage`, `VSMessage`, `AltitudeMessage`: scalar streams
- `LightsMessage`, `GearMessage`, `FlapsMessage`, `SpoilersMessage`: aircraft systems
- `LandingMessage`: landing grade, vertical speed, and runway information
- `PhaseMessage`: flight phase changes
- ... and many more

### State

- `TelemetryState`: normalized state for client applications
- `createInitialState()`: creates an initial state

### Commands

Types for messages sent TO the backend:

- `BaseCommand`: base shape for client messages
- `TelemetryCommand`: a generic client message, such as `{ type: 'requestState' }`

## Related Packages

- `@flight-fabric/telemetry-client`: React hooks and a telemetry client
