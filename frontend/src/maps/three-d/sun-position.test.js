import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyLightingPhase,
  daylightLighting,
  directionFromSky,
  formatZuluTime,
  lightingForSunElevation,
  moonDirectionForSun,
  sunPosition,
} from './sun-position.js';

test('the sun stands where the almanac says it does', () => {
  // Greenwich, March equinox 2026 (20 March, 14:46 UTC); solar noon is
  // about 12:07 UTC because the equation of time is around -7 minutes.
  const noon = sunPosition(Date.UTC(2026, 2, 20, 12, 7, 0), 51.4779, 0);
  assert.ok(Math.abs(noon.elevationDeg - 38.5) < 0.6, `equinox noon elevation ${noon.elevationDeg.toFixed(2)}`);
  assert.ok(Math.abs(noon.azimuthDeg - 180) < 1.5, `solar noon azimuth ${noon.azimuthDeg.toFixed(2)}`);
  assert.ok(Math.abs(noon.declinationDeg) < 0.4, 'declination is near zero at the equinox');

  const midnight = sunPosition(Date.UTC(2026, 2, 20, 0, 7, 0), 51.4779, 0);
  assert.ok(midnight.elevationDeg < -35, `midnight elevation ${midnight.elevationDeg.toFixed(1)}`);

  const sunrise = sunPosition(Date.UTC(2026, 2, 20, 6, 4, 0), 51.4779, 0);
  assert.ok(Math.abs(sunrise.elevationDeg) < 1.5, `sunrise elevation ${sunrise.elevationDeg.toFixed(2)}`);
  assert.ok(Math.abs(sunrise.azimuthDeg - 89) < 3, `sunrise is in the east: ${sunrise.azimuthDeg.toFixed(1)}`);

  // Sydney at the December solstice: the noon sun is north of the zenith.
  const sydney = sunPosition(Date.UTC(2026, 11, 21, 1, 55, 0), -33.8688, 151.2093);
  assert.ok(Math.abs(sydney.elevationDeg - 79.6) < 0.8, `Sydney solstice noon ${sydney.elevationDeg.toFixed(2)}`);
  assert.ok(sydney.azimuthDeg < 20 || sydney.azimuthDeg > 340, `Sydney noon sun is to the north: ${sydney.azimuthDeg.toFixed(1)}`);

  assert.equal(sunPosition(NaN, 0, 0), null);
});

test('lighting phases and the rig blend continuously through twilight', () => {
  assert.equal(classifyLightingPhase(-20), 'night');
  assert.equal(classifyLightingPhase(-3), 'dusk');
  assert.equal(classifyLightingPhase(4), 'golden');
  assert.equal(classifyLightingPhase(40), 'day');
  assert.equal(classifyLightingPhase(undefined), 'day');

  const night = lightingForSunElevation(-30);
  const day = lightingForSunElevation(60);
  assert.equal(night.phase, 'night');
  assert.equal(night.sunIntensity, 0, 'no sun below the horizon');
  assert.ok(night.moonIntensity > 0.4, 'moonlight keeps the terrain readable');
  assert.equal(day.phase, 'day');
  assert.equal(day.moonIntensity, 0);
  assert.ok(day.sunIntensity > 0.8);
  assert.equal(day.sunColor, 0xffffff, 'high sun is white');
  assert.ok(night.hemisphereIntensity < day.hemisphereIntensity);
  assert.ok(night.aircraftEmissive > day.aircraftEmissive, 'the aircraft glows at night');
  assert.deepEqual(daylightLighting(), day);

  // Sample the ramp finely: no channel jumps more than a small step.
  let previous = lightingForSunElevation(-12);
  for (let elevation = -11.5; elevation <= 30; elevation += 0.5) {
    const next = lightingForSunElevation(elevation);
    assert.ok(Math.abs(next.sunIntensity - previous.sunIntensity) < 0.08, `sun jump at ${elevation}`);
    assert.ok(Math.abs(next.moonIntensity - previous.moonIntensity) < 0.08, `moon jump at ${elevation}`);
    assert.ok(Math.abs(next.hemisphereIntensity - previous.hemisphereIntensity) < 0.05, `hemisphere jump at ${elevation}`);
    previous = next;
  }
  const lowSun = lightingForSunElevation(3);
  assert.equal(lowSun.phase, 'golden');
  assert.notEqual(lowSun.sunColor, 0xffffff, 'a low sun is warm');
});

test('sky directions follow scene axes and the moon light sits opposite the sun', () => {
  const east = directionFromSky(0, 90);
  assert.ok(Math.abs(east.x - 1) < 1e-9 && Math.abs(east.y) < 1e-9 && Math.abs(east.z) < 1e-9);
  const north = directionFromSky(0, 0);
  assert.ok(Math.abs(north.z + 1) < 1e-9, 'north is -z');
  const up = directionFromSky(90, 123);
  assert.ok(Math.abs(up.y - 1) < 1e-9);
  const moon = moonDirectionForSun(90);
  assert.ok(moon.x < 0 && moon.y > 0.8, 'the night light comes from the west when the sun set... rose in the east');
  assert.equal(formatZuluTime(Date.UTC(2026, 8, 19, 21, 4)), '21:04Z');
  assert.equal(formatZuluTime(null), '--:--Z');
});
