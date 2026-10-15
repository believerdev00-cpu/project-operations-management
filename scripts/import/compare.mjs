// What is already in a deployment, against what the import file says.
//
// An import of several hundred round trips can die half way, and this one did:
// four of twelve months landed and the other eight had to be worked out by
// hand. The unique index on monthly_plans(sector, month) means a month that
// finished can never be written twice -- a re-run is refused there with 409.
// The dangerous one is a month that was cut off MID-WAY: its plan exists, so a
// re-run is refused at creation and its missing days are never recorded, and
// the 409 it reports is indistinguishable from the ones the finished months
// give. There is no DELETE for a plan through the API either, so "delete it and
// start again" is not a path the import can offer.
//
// So every month is read back and compared with the file day by day, and only
// what is absent is added. This is where that comparison lives, on its own,
// away from the HTTP: it decides whether a figure is recorded twice, and that
// is worth a test that needs no database (`tests/pure-logic.test.mjs`).
import { cents } from '../../server/lib/monthly.js';

// A day is the same day when it is the same work, on the same date, against the
// same objective, for the same money. The note is deliberately NOT part of
// that: the server trims and caps it, and a note that reads differently is no
// reason to record a second day of the same work.
//
// The two mistakes this key can make are not equal. A match missed costs one
// absent day -- the check reports it and the next run fills it. A match
// invented costs a doubled figure in somebody's books, which nothing here can
// detect afterwards. So the key is the loose one on purpose.
export const dayKey = (objectiveId, day) =>
  `${objectiveId}|${day.date}|${cents(day.quantityDone)}|${cents(day.cost)}`;

// The days and the money one month of the file holds.
export function fileTotals(plan) {
  let fileDays = 0;
  let fileMoney = 0;
  for (const objective of plan.objectives) {
    for (const day of objective.days) {
      fileDays += 1;
      fileMoney += Number(day.cost || 0);
    }
  }
  return { fileDays, fileMoney };
}

// One month of the file against the deployment.
//
//   plan      the month as the file states it
//   existing  the row from GET /api/monthly-plans, or null if there is none
//   detail    the payload from GET /api/monthly-plans/:id for that row
//
// Returns one of three states: `absent` (create it), `complete` (every day the
// file holds is already recorded -- leave it alone) or `partial`, which carries
// `missing`: the days to add, each with the id of the objective they belong to.
export function compareMonth(plan, existing, detail) {
  const verdict = { ...fileTotals(plan), missing: [], unknownObjectives: [], extra: 0 };
  if (!existing) return { ...verdict, state: 'absent' };

  const idOf = new Map();
  for (const objective of detail?.objectives || []) {
    idOf.set(`${objective.title}|${objective.supportsOperation || ''}`, objective.id);
  }

  // The days already recorded, counted as a MULTISET rather than a set: a month
  // may honestly hold two identical days -- two tanks of fuel at the same price
  // on the same date -- and a set would read the second one as already there
  // and drop it.
  const recorded = new Map();
  for (const day of detail?.dailyReports || []) {
    const key = dayKey(day.objectiveId, day);
    recorded.set(key, (recorded.get(key) || 0) + 1);
  }

  for (const objective of plan.objectives) {
    const objectiveId = idOf.get(`${objective.title}|${objective.supportsOperation || ''}`);
    if (objectiveId === undefined) { verdict.unknownObjectives.push(objective.title); continue; }
    for (const day of objective.days) {
      const key = dayKey(objectiveId, day);
      const have = recorded.get(key) || 0;
      if (have > 0) recorded.set(key, have - 1);
      // The operation a support objective serves travels with the day: on
      // Movement & Facilitation's own plan the same words appear once per
      // operation they are for, and a report that printed the title alone
      // listed the same commitment twice with no way to tell them apart.
      else verdict.missing.push({
        objectiveId,
        title: objective.title,
        supportsOperation: objective.supportsOperation || null,
        day
      });
    }
  }
  // Whatever is left over is recorded in the month and not in this file: either
  // somebody's own work, or a day the file now states differently.
  verdict.extra = [...recorded.values()].reduce((sum, count) => sum + count, 0);

  // `complete` has to mean "this month IS what the file says", not merely "the
  // file has nothing left to add": a month carrying days the file does not
  // contain is a month somebody should look at, and reading it as complete
  // would skip it silently with no reason printed anywhere.
  return {
    ...verdict,
    state: verdict.missing.length || verdict.unknownObjectives.length || verdict.extra ? 'partial' : 'complete',
    planId: existing.id,
    status: existing.status,
    managerId: existing.managerId ?? null,
    existingBudget: Number(existing.approvedBudget || 0),
    budgetMatches: cents(existing.approvedBudget) === cents(plan.approvedBudget),
    recordedDays: (detail?.dailyReports || []).length
  };
}

// Why a half-recorded month is left alone instead of being filled in. Each of
// these means the month on the deployment is not the month the file describes,
// and the import cannot tell which of the two is right -- so it reports and
// touches nothing. One definition, read by --check and by the run itself, so
// the check cannot promise what the run then refuses.
export function blockers(plan, verdict) {
  const reasons = [];
  if (verdict.unknownObjectives.length) {
    reasons.push(`objectives this file has and the month does not (${verdict.unknownObjectives.join('; ')})`);
  }
  if (verdict.extra) {
    reasons.push(`${verdict.extra} day(s) recorded in the month that this file does not contain`);
  }
  if (!verdict.budgetMatches) {
    reasons.push(`an approved budget of $${verdict.existingBudget.toFixed(2)} where this file says $${Number(plan.approvedBudget || 0).toFixed(2)}`);
  }
  // A day is refused on a month the manager cannot work: Draft is not handed
  // over yet, Closed is read-only until the Director reopens it.
  if (verdict.status === 'Closed' || verdict.status === 'Draft') {
    reasons.push(`the status ${verdict.status}, which refuses a day`);
  }
  return reasons;
}
