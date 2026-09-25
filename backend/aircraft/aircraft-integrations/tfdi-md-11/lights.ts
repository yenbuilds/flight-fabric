// Stable switch selections, shared by the overview and the aircraft controls.
// Standard LIGHT STATES remains unchanged when this add-on's switches move.
export function resolveTfdiMd11Lights(snapshot: any, now = Date.now()): Record<string, any> | null {
  if (snapshot?.profileId !== 'bundled/msfs/tfdi-md-11' || snapshot.status !== 'running') return null;
  const read = (name: string, allowed: number[]) => {
    const key = `aircraft_specific_${name}`;
    const value = snapshot.values?.[key], time = Date.parse(snapshot.valueUpdatedAt?.[key]);
    return Number.isFinite(time) && now - time >= -5000 && now - time <= 2500 && allowed.includes(value) ? value : null;
  };
  const nav = read('lights_nav', [0, 1]), beacon = read('lights_beacon', [0, 1]);
  const strobe = read('lights_strobe', [0, 1]), logo = read('lights_logo', [0, 1]);
  const left = read('lights_landing_left_position', [0, 1, 2]), right = read('lights_landing_right_position', [0, 1, 2]);
  const nose = read('lights_nose_position', [0, 1, 2]);
  const turnLeft = read('lights_turnoff_left', [0, 1]), turnRight = read('lights_turnoff_right', [0, 1]);
  const powerKey = 'aircraft_specific_systems_bus_voltage';
  const powerTime = Date.parse(snapshot.valueUpdatedAt?.[powerKey]), power = snapshot.values?.[powerKey];
  if ([nav, beacon, strobe, logo, left, right, nose, turnLeft, turnRight].some(v => v === null)
    || !Number.isFinite(powerTime) || now - powerTime > 2500 || now - powerTime < -5000 || !(power >= 90 && power <= 130)) return null;
  return { nav: nav === 0, beacon: beacon === 0, strobe: strobe === 0, logo: logo === 1,
    landing: left === 2 || right === 2, taxi: nose > 0, turnoff: turnLeft === 1 || turnRight === 1 };
}
