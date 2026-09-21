import { normalizeVoiceText } from './aviation-number-parser.js';
import { spokenIdentifier, spokenRunway } from './local-readback.js';

const NO_PLAN_TEXT = 'No SimBrief flight plan loaded. Fetch an OFP on the SimBrief tab first.';
const INCOMPLETE_PLAN_TEXT = 'The loaded SimBrief flight plan has no departure or arrival airport.';
const NO_ALTITUDE_TEXT = 'The loaded SimBrief flight plan has no planned altitude.';

/** Plan legs: label, airport, runway, and the procedure/transition pair each leg reads back. */
const legs = Object.freeze({
  departure: { label: 'Departure', airport: 'origin', runway: 'departureRunway', procedure: 'sid', transition: 'sidTransition', procedureName: 'SID' },
  arrival: { label: 'Arrival', airport: 'destination', runway: 'arrivalRunway', procedure: 'star', transition: 'starTransition', procedureName: 'STAR' },
});

const queries = [
  { id: 'flightPlan', sections: ['departure', 'altitude', 'arrival'],
    phrases: ['what is the simbrief flight plan', 'what are the simbrief details', 'simbrief details', 'read back the simbrief flight plan',
      'read back the flight plan', 'what is the flight plan', 'what is my flight plan', 'flight plan details'] },
  { id: 'flightPlan.departure', sections: ['departure'],
    phrases: ['what is the departure', 'what is my departure', 'read back the departure', 'simbrief departure', 'departure details'] },
  { id: 'flightPlan.arrival', sections: ['arrival'],
    phrases: ['what is the arrival', 'what is my arrival', 'read back the arrival', 'simbrief arrival', 'arrival details'] },
  { id: 'flightPlan.altitude', sections: ['altitude'],
    phrases: ['what is the planned altitude', 'what is my planned altitude', 'planned altitude', 'what is the cruise altitude',
      'what is my cruise altitude', 'cruise altitude', 'simbrief altitude'] },
];

/** Recognizers split the product name and contract "what is"; accept both forms. */
function normalize(value) {
  return normalizeVoiceText(value).replace(/\bsim brief\b/g, 'simbrief').replace(/^whats\b/, 'what is');
}

function legReadback(plan, leg) {
  const { label, airport, runway, procedure, transition, procedureName } = legs[leg];
  const procedures = plan.procedures;
  const written = [`${label} ${plan[airport]}`, plan[runway] ? `runway ${plan[runway]}` : 'runway not planned'];
  const spoken = [`${label} ${spokenIdentifier(plan[airport])}`, plan[runway] ? `runway ${spokenRunway(plan[runway])}` : 'runway not planned'];
  if (procedures && typeof procedures === 'object') {
    const ident = procedures[procedure];
    written.push(ident ? `${procedureName} ${ident}` : `no ${procedureName}`);
    spoken.push(ident ? `${procedureName} ${spokenIdentifier(ident)}` : `no ${procedureName}`);
    if (ident) {
      const via = procedures[transition];
      written.push(via ? `transition ${via}` : 'no transition');
      spoken.push(via ? `transition ${spokenIdentifier(via)}` : 'no transition');
    }
  }
  return { written: `${written.join(', ')}.`, spoken: `${spoken.join(', ')}.` };
}

/** The store keeps the initial cruise altitude as a flight level such as FL360. */
function altitudeReadback(plan) {
  const level = /^FL(\d{2,3})$/.exec(String(plan.cruiseAltFl || '').trim().toUpperCase());
  if (!level) return null;
  return { written: `Planned altitude FL${level[1]}.`, spoken: `Planned altitude flight level ${spokenIdentifier(level[1])}.` };
}

function sectionReadback(plan, section) {
  return section === 'altitude' ? altitudeReadback(plan) : legReadback(plan, section);
}

export function flightPlanQueryExamples() {
  return queries.map((query) => query.phrases[0]);
}

/** Exact read-only phrases answered from the loaded SimBrief OFP; never dispatched as commands. */
export function answerFlightPlanQuery(transcript, plan) {
  const text = normalize(transcript);
  const query = queries.find((entry) => entry.phrases.some((phrase) => normalize(phrase) === text));
  if (!query) return null;
  if (!plan || typeof plan !== 'object') return { ok: false, id: query.id, text: NO_PLAN_TEXT, spoken: NO_PLAN_TEXT };
  if (!plan.origin || !plan.destination) return { ok: false, id: query.id, text: INCOMPLETE_PLAN_TEXT, spoken: INCOMPLETE_PLAN_TEXT };
  const readbacks = query.sections.map((section) => sectionReadback(plan, section)).filter(Boolean);
  if (!readbacks.length) return { ok: false, id: query.id, text: NO_ALTITUDE_TEXT, spoken: NO_ALTITUDE_TEXT };
  // Plans cached before procedures were normalized carry no SID or STAR at all.
  const refetch = plan.procedures && typeof plan.procedures === 'object' ? '' : ' Fetch the OFP again for SID and STAR details.';
  return {
    ok: true,
    id: query.id,
    text: `${readbacks.map((readback) => readback.written).join(' ')}${refetch}`,
    spoken: `${readbacks.map((readback) => readback.spoken).join(' ')}${refetch}`,
  };
}
