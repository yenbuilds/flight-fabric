/** Shared lifecycle interpretation for MSFS frames and active control guards. */
export function computeMenuState({ systemSim, simRunningRaw, cameraState, crashFlag, crashSequence, userInput, paused }) {
  const hasSystemSimState = systemSim === 0 || systemSim === 1;
  const simRunning = (typeof simRunningRaw === 'boolean') ? simRunningRaw : (hasSystemSimState ? systemSim === 1 : null);
  const camState = Number.isFinite(cameraState) ? cameraState : null;
  const cameraUserControl = camState == null ? true : camState <= 6;
  const crashFlagCode = typeof crashFlag === 'number' && Number.isFinite(crashFlag) ? crashFlag : null;
  const crashFlagActive = crashFlag === true || (crashFlagCode !== null && crashFlagCode > 0);
  const crashSequenceValue = Number.isFinite(crashSequence) ? crashSequence : 0;
  const crashActive = crashFlagActive || crashSequenceValue > 0;
  const inMenuBySystemState = systemSim === 0;
  const inFlightBySystemState = systemSim === 1;
  const fallbackInMenu = userInput === false;
  const baseInMenu = hasSystemSimState ? inMenuBySystemState : fallbackInMenu;
  const effectiveInMenu = baseInMenu || cameraUserControl === false || crashActive || simRunning === false;
  const inFlightContext = !paused && userInput !== false && cameraUserControl === true && crashActive === false && simRunning !== false && (hasSystemSimState ? inFlightBySystemState : true);
  return { effectiveInMenu, inFlightContext, simRunning, systemSim, hasSystemSimState, cameraState: camState, cameraUserControl, crashFlagActive, crashSequenceValue, crashActive };
}
