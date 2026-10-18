// Standard COM radio bounds and event contract shared by the registry and executor.
export const COM_RADIO_INPUT = Object.freeze({ type: 'number', min: 118, max: 136.99, step: 0.005 } as const);
export const COM_RADIO_PROPERTIES = ['installed', 'status', 'spacingMode', 'activeMhz', 'standbyMhz'] as const;

export function comRadioOperations(index: 1 | 2, operation: string) {
  return [
    ...(operation !== 'swap' ? [{ type: 'event' as const,
      name: index === 1 ? 'COM_STBY_RADIO_SET_HZ' : 'COM2_STBY_RADIO_SET_HZ',
      inputValue: { source: 'input' as const, scale: 1000000, round: 'nearest' as const } }] : []),
    ...(operation !== 'setStandby' ? [{ type: 'event' as const, name: `COM${index}_RADIO_SWAP`, value: 0 }] : []),
  ];
}
