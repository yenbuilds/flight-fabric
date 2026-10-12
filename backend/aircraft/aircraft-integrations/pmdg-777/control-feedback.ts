/** Existing advice attached only to unconfirmed parking-brake commands. */
export function getPmdg777ReadbackFailureHint(actionId: string): string {
  return actionId.startsWith('controls.parkingBrake.')
    ? ' PMDG Realistic parking-brake mode can require both toe brakes to be held before the lever accepts SET; releasing may be controlled by pedal input.'
    : '';
}
