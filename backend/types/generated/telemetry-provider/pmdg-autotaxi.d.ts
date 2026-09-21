/** Compatibility exports for existing PMDG fixtures. Production uses the shared factory. */
export { createAutotaxi as createPmdgAutotaxi } from './aircraft-autotaxi.js';
export { brakeAxis, writeTaxiAxes } from '../autotaxi/axes.js';
