import {
  getGlobalRootObject,
} from '../app/shared-globals.js';

export function getFlightFabricAppSettings() {
  const shared = getGlobalRootObject().FlightFabricAppSettings;
  if (!shared || typeof shared.normalizeAppSettings !== 'function') {
    throw new Error('FlightFabricAppSettings shared module is required before settings consumers');
  }
  return shared;
}
