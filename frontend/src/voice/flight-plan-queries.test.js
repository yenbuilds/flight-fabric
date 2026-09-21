import test from 'node:test';
import assert from 'node:assert/strict';
import { answerFlightPlanQuery as answer, flightPlanQueryExamples } from './flight-plan-queries.js';

const MAX_READBACK_CHARS = 240;
const plan = Object.freeze({
  origin: 'YSSY', departureRunway: '34L', destination: 'WSSS', arrivalRunway: '02C', cruiseAltFl: 'FL360',
  procedures: { sid: 'DEEZ5', sidTransition: 'KADAL', star: 'ARAM1A', starTransition: null },
});

test('the full SimBrief read-back covers both legs in written and spoken forms', () => {
  for (const text of ['what is the simbrief flight plan', 'What are the SimBrief details?', 'sim brief details',
    "what's my flight plan", 'read back the flight plan']) {
    assert.deepEqual(answer(text, plan), {
      ok: true, id: 'flightPlan',
      text: 'Departure YSSY, runway 34L, SID DEEZ5, transition KADAL. Planned altitude FL360. Arrival WSSS, runway 02C, STAR ARAM1A, no transition.',
      spoken: 'Departure Y S S Y, runway three four left, SID D E E Z five, transition K A D A L. Planned altitude flight level three six zero. '
        + 'Arrival W S S S, runway zero two center, STAR A R A M one A, no transition.',
    }, text);
  }
});

test('departure and arrival questions read one leg and report missing procedures', () => {
  assert.equal(answer('what is the departure', plan).text, 'Departure YSSY, runway 34L, SID DEEZ5, transition KADAL.');
  assert.equal(answer('read back the arrival', plan).id, 'flightPlan.arrival');
  const noProcedures = { ...plan, departureRunway: null, procedures: { sid: null, sidTransition: 'IGNORED', star: null, starTransition: null } };
  assert.equal(answer('what is my departure', noProcedures).text, 'Departure YSSY, runway not planned, no SID.');
  assert.equal(answer('what is my departure', noProcedures).spoken, 'Departure Y S S Y, runway not planned, no SID.');
  assert.equal(answer('simbrief arrival', { ...plan, arrivalRunway: '9' }).spoken, 'Arrival W S S S, runway zero nine, STAR A R A M one A, no transition.');
});

test('the planned altitude has its own question and drops out of the brief when SimBrief has none', () => {
  assert.deepEqual(answer('what is the planned altitude', plan), { ok: true, id: 'flightPlan.altitude',
    text: 'Planned altitude FL360.', spoken: 'Planned altitude flight level three six zero.' });
  assert.equal(answer('cruise altitude', { ...plan, cruiseAltFl: 'FL85' }).spoken, 'Planned altitude flight level eight five.');
  const noAltitude = { ...plan, cruiseAltFl: null };
  assert.equal(answer('what is my cruise altitude', noAltitude).ok, false);
  assert.match(answer('what is my cruise altitude', noAltitude).text, /no planned altitude/);
  assert.equal(answer('read back the flight plan', noAltitude).text,
    'Departure YSSY, runway 34L, SID DEEZ5, transition KADAL. Arrival WSSS, runway 02C, STAR ARAM1A, no transition.');
  assert.equal(answer('cruise altitude', { ...plan, cruiseAltFl: '36000' }).ok, false, 'a non flight-level fallback string is not spoken as a level');
});

test('plans cached before procedures existed still read airports and runways and ask for a refetch', () => {
  const cached = { origin: 'YBBN', departureRunway: '01L', destination: 'YMML', arrivalRunway: '16' };
  assert.deepEqual(answer('flight plan details', cached), {
    ok: true, id: 'flightPlan',
    text: 'Departure YBBN, runway 01L. Arrival YMML, runway 16. Fetch the OFP again for SID and STAR details.',
    spoken: 'Departure Y B B N, runway zero one left. Arrival Y M M L, runway one six. Fetch the OFP again for SID and STAR details.',
  });
});

test('missing or incomplete plans fail without matching unrelated phrases', () => {
  assert.equal(answer('what is the departure', null).ok, false);
  assert.match(answer('what is the departure', null).text, /No SimBrief flight plan loaded/);
  assert.equal(answer('what is the arrival', { origin: 'YSSY' }).ok, false);
  assert.match(answer('what is the arrival', { origin: 'YSSY' }).spoken, /no departure or arrival airport/);
  for (const text of ['set heading 270', 'what is the selected altitude', 'departure', 'simbrief', '']) {
    assert.equal(answer(text, plan), null, text);
  }
});

test('the longest plausible combined read-back fits the local readback limit', () => {
  const longest = { origin: 'KDFW', departureRunway: '35C', destination: 'EGLL', arrivalRunway: '27R', cruiseAltFl: 'FL370',
    procedures: { sid: 'KADAL1A', sidTransition: 'RIVET1A', star: 'BNN1H', starTransition: 'KOPUL1A' } };
  const result = answer('what is the simbrief flight plan', longest);
  assert.ok(result.spoken.length <= MAX_READBACK_CHARS, `${result.spoken.length} chars`);
  assert.equal(flightPlanQueryExamples().length, 4);
});
