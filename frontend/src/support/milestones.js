// The rules that keep the support prompt from ever feeling like nagging.
// They are pure so the store, the runtime and the tests all share one truth.
//
//   - It asks only right after a final landing score arrives, at a flight
//     milestone, and only once per milestone: at most five times, ever.
//   - Never in the first week, and never within 30 days of the last ask,
//     whatever the user clicked.
//   - Never after "I've supported" or "Don't ask again".
//   - Never in the remote phone view, never behind a modal, and never in a
//     session that already showed the what's-new card (the runtime checks).
//   - The card fades by itself; ignoring it costs nothing.

export const SUPPORT_MILESTONES = Object.freeze([10, 50, 100, 250, 500]);
export const SUPPORT_MIN_DAYS_SINCE_FIRST_SEEN = 7;
export const SUPPORT_MIN_DAYS_BETWEEN_PROMPTS = 30;
export const SUPPORT_RECORD_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_GOAL_COUNT = 100000;

function finiteOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export function createSupportRecord(now = Date.now()) {
  return {
    version: SUPPORT_RECORD_VERSION,
    firstSeenAt: now,
    lastPromptAt: 0,
    milestonesShown: [],
    supported: false,
    muted: false,
  };
}

export function normalizeSupportRecord(raw, now = Date.now()) {
  const record = createSupportRecord(now);
  if (!raw || typeof raw !== 'object') return record;
  record.firstSeenAt = finiteOrZero(raw.firstSeenAt) || now;
  record.lastPromptAt = finiteOrZero(raw.lastPromptAt);
  record.milestonesShown = Array.isArray(raw.milestonesShown)
    ? raw.milestonesShown.map(Number).filter((value) => SUPPORT_MILESTONES.includes(value))
    : [];
  record.supported = raw.supported === true;
  record.muted = raw.muted === true;
  return record;
}

// The highest milestone the user has reached and not yet been asked about.
// Marking it shown also marks every lower milestone, so someone who reaches
// 100 flights while muted is asked once when unmuted, not three times.
export function nextSupportMilestone(total, milestonesShown = []) {
  const count = finiteOrZero(total);
  const shown = new Set(milestonesShown);
  const reached = SUPPORT_MILESTONES.filter((milestone) => count >= milestone && !shown.has(milestone));
  return reached.length ? reached[reached.length - 1] : null;
}

export function milestonesUpTo(milestone) {
  return SUPPORT_MILESTONES.filter((value) => value <= milestone);
}

export function supportPromptBlockReason(record, { total, now = Date.now() } = {}) {
  if (!record) return 'no-record';
  if (record.supported) return 'supported';
  if (record.muted) return 'muted';
  if (now - record.firstSeenAt < SUPPORT_MIN_DAYS_SINCE_FIRST_SEEN * DAY_MS) return 'too-soon-after-first-seen';
  if (record.lastPromptAt && now - record.lastPromptAt < SUPPORT_MIN_DAYS_BETWEEN_PROMPTS * DAY_MS) return 'too-soon-after-last-prompt';
  if (nextSupportMilestone(total, record.milestonesShown) == null) return 'no-milestone';
  return null;
}

// Supporter goal from the update manifest. It is only ever shown for the
// month it describes, so a forgotten manifest goes quiet instead of stale.
export function currentSupportPeriod(now = Date.now()) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function sanitizeSupportGoal(value) {
  if (!value || typeof value !== 'object') return null;
  const period = typeof value.period === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value.period) ? value.period : null;
  const supporters = value.supporters;
  const goal = value.goal;
  if (!period) return null;
  if (!Number.isInteger(supporters) || supporters < 0 || supporters > MAX_GOAL_COUNT) return null;
  if (!Number.isInteger(goal) || goal <= 0 || goal > MAX_GOAL_COUNT) return null;
  return { period, supporters, goal };
}

export function describeSupportGoal(goal, now = Date.now()) {
  const clean = sanitizeSupportGoal(goal);
  if (!clean || clean.period !== currentSupportPeriod(now)) return null;
  const percent = Math.max(0, Math.min(100, Math.round((clean.supporters / clean.goal) * 100)));
  return {
    ...clean,
    percent,
    label: `${clean.supporters} of ${clean.goal} supporters this month`,
  };
}
