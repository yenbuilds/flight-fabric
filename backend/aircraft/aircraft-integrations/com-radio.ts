import type { AircraftIntegrationAction, AircraftIntegrationField } from './types.js';

export const COM_RADIO_INPUT = Object.freeze({ type: 'number', min: 118, max: 136.99, step: 0.005 } as const);
export const COM_RADIO_PROPERTIES = ['installed', 'status', 'spacingMode', 'activeMhz', 'standbyMhz'] as const;

export function comRadioFields(): Record<string, AircraftIntegrationField> {
  return Object.fromEntries(([1, 2] as const).flatMap((index) => [
    ['installed', 'COM AVAILABLE', 'Bool'], ['status', 'COM STATUS', 'Number'],
    ['spacingMode', 'COM SPACING MODE', 'Number'], ['activeMhz', 'COM ACTIVE FREQUENCY', 'MHz'],
    ['standbyMhz', 'COM STANDBY FREQUENCY', 'MHz'],
  ].map(([property, name, unit]) => {
    const id = `radios.com${index}.${property}`;
    return [id, { id, sources: [{ route: { type: 'simvar', name: `${name}:${index}`, unit },
      decode: property === 'installed'
        ? { type: 'boolean', trueValues: [true, 1], falseValues: [false, 0] }
        : { type: 'number', precision: property.endsWith('Mhz') ? 3 : 0 },
    }] } as AircraftIntegrationField];
  })));
}

export function comRadioOperations(index: 1 | 2, operation: string) {
  return [
    ...(operation !== 'swap' ? [{ type: 'event' as const,
      name: index === 1 ? 'COM_STBY_RADIO_SET_HZ' : 'COM2_STBY_RADIO_SET_HZ',
      inputValue: { source: 'input' as const, scale: 1000000, round: 'nearest' as const } }] : []),
    ...(operation !== 'setStandby' ? [{ type: 'event' as const, name: `COM${index}_RADIO_SWAP`, value: 0 }] : []),
  ];
}

/** Opt in only after reviewing the aircraft's actual COM panel interface. */
export function comRadioActions(prefix: string): Record<string, AircraftIntegrationAction> {
  return Object.fromEntries(([1, 2] as const).flatMap((index) => (
    (['setStandby', 'swap', 'switchTo'] as const).map((operation) => {
      const id = `radios.com${index}.${operation}`;
      return [id, {
        id, guard: { groupId: `${prefix}.radios.com${index}`, cooldownMs: 750, retry: 'never' },
        ...(operation !== 'swap' ? { input: COM_RADIO_INPUT } : {}),
        routes: [{ id: `${prefix}.${id}.simconnectSequence`, transport: 'simconnect-sequence',
          comRadio: { index, operation }, operations: comRadioOperations(index, operation),
          readback: { fieldId: `radios.com${index}.${operation === 'setStandby' ? 'standbyMhz' : 'activeMhz'}`,
            timeoutMs: 2500, ...(operation === 'swap' ? { confirmation: 'changed' } : { expectedInput: true }) },
        }], verification: 'untested',
      } as AircraftIntegrationAction];
    })
  )));
}
