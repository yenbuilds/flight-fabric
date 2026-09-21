import type { TaxiInput } from './controller.js';
import type { TaxiFamily } from './adapters.js';

type Ack = { ok?: boolean; error?: string };
export type TaxiAxisTransport = {
  sendEvent: (name: string, value: number) => Promise<Ack>;
  setNamedVar?: (input: { name: string; unit: string; value: number }) => Promise<Ack>;
};
export type TaxiAxisConfig = Readonly<{ family: TaxiFamily; engineCount: number; maxThrottle: number }>;

export class TaxiControlWriteError extends Error {
  constructor(readonly command: string, readonly transportError: string) {
    super(`${command}: ${transportError}`);
  }
}

export function brakeAxis(fraction: number): number {
  // Microsoft AXIS_*_BRAKE_SET curve. Zero event data applies about27% brake;
  // released pedals require -16383. See AUTOTAXI-AIRCRAFT.md source references.
  const points = [[0, -16383], [0.08, -8191], [0.27, 0], [0.53, 8191], [1, 16383]];
  for (let i = 1; i < points.length; i++) {
    if (fraction <= points[i][0]) {
      const [p, a] = points[i - 1], [q, b] = points[i];
      return Math.round(a + (fraction - p) / (q - p) * (b - a));
    }
  }
  return 16383;
}

/** App-owned bounded recipes. Event/variable names cannot come from a client. */
export async function writeGroundAxes(input: TaxiInput, transport: TaxiAxisTransport, valid: () => boolean, config: TaxiAxisConfig): Promise<void> {
  if (!Number.isInteger(config.engineCount) || config.engineCount < 1 || config.engineCount > 4
    || !Number.isFinite(config.maxThrottle) || config.maxThrottle <= 0 || config.maxThrottle > 1
    || ![input.throttle, input.brake, input.steering].every(Number.isFinite)
    || input.throttle < 0 || input.throttle > config.maxThrottle || input.brake < 0 || input.brake > 1
    || Math.abs(input.steering) > 1 || (input.brake > 0 && input.throttle > 0)) {
    throw new Error('Invalid ground-control demand.');
  }
  if (config.family === 'fenix-a32x' && (config.engineCount !== 2 || config.maxThrottle > 0.25)) {
    throw new Error('Fenix continuous throttle transport is unavailable or outside its taxi range.');
  }
  if (config.family === 'fenix-a32x' && !transport.setNamedVar && !(input.throttle === 0 && input.brake === 1)) {
    throw new Error('Fenix continuous throttle transport is unavailable.');
  }
  const commands: { label: string; send: () => Promise<Ack> }[] = [];
  const throttle = () => {
    for (let index = 1; index <= config.engineCount; index++) {
      if (config.family === 'fenix-a32x') {
        // Installed Fenix Interactions.xml DRAG_CODE explicitly writes a
        // continuous value.2 is idle;3 is CLB. Stay within the forward idle gate.
        const name = `L:A_FC_THROTTLE_${index === 1 ? 'LEFT' : 'RIGHT'}_INPUT`;
        commands.push({ label: name, send: async () => {
          if (!transport.setNamedVar) throw new Error('Fenix continuous throttle transport is unavailable.');
          return transport.setNamedVar({ name, unit: 'Number', value: 2 + input.throttle });
        } });
      } else {
        const name = `THROTTLE${index}_SET`;
        commands.push({ label: name, send: () => transport.sendEvent(name, Math.round(input.throttle * 16383)) });
      }
    }
  };
  if (input.throttle === 0) throttle();
  for (const name of ['AXIS_LEFT_BRAKE_SET', 'AXIS_RIGHT_BRAKE_SET']) {
    commands.push({ label: name, send: () => transport.sendEvent(name, brakeAxis(input.brake)) });
  }
  commands.push({ label: 'AXIS_STEERING_SET', send: () => transport.sendEvent('AXIS_STEERING_SET', Math.round(input.steering * 16384)) });
  if (input.throttle > 0) throttle();
  let firstError: Error | null = null;
  for (const command of commands) {
    if (!valid()) throw new Error('Autotaxi control ownership changed.');
    try {
      const ack = await command.send();
      if (ack?.ok !== true) throw new Error(ack?.error || `${command.label} was rejected.`);
    } catch (error) {
      firstError ??= new TaxiControlWriteError(command.label, error instanceof Error ? error.message : String(error));
      // A full stop attempts every installed engine and both brakes even when
      // an earlier command failed. It must still stop at an identity change.
      if (input.throttle > 0 || input.brake !== 1) throw firstError;
    }
  }
  if (firstError) throw firstError;
}

/** Existing737 fixture API; production uses explicit per-aircraft configuration. */
export function writeTaxiAxes(input: TaxiInput, send: TaxiAxisTransport['sendEvent'], valid: () => boolean): Promise<void> {
  return writeGroundAxes(input, { sendEvent: send }, valid, { family: 'pmdg-737', engineCount: 2, maxThrottle: 0.18 });
}
