// The rules of the monthly cycle, in one place so the routes cannot each
// invent their own version of them.
//
// The money model, stated once because everything here depends on it: the
// platform moves no money. A confirmed plan records that the Director approved
// an allocation and handed the cash to the manager outside the system. What is
// recorded afterwards is what was spent, the evidence for it, and what is left.
// There is no transaction, wallet, transfer or gateway anywhere in this module.

import { hasFullScope, isAdmin } from './http.js';

// 'YYYY-MM' as the browser sends it, to the first of that month as the column
// stores it. Built from the parts rather than through Date, which would read a
// bare 'YYYY-MM' as UTC and land on the previous month west of Greenwich.
export function monthStart(value) {
  const text = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})/.exec(text);
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return `${match[1]}-${match[2]}-01`;
}

export function monthKey(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 7);
  const month = String(value.getMonth() + 1).padStart(2, '0');
  return `${value.getFullYear()}-${month}`;
}

export function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// node-postgres hands back a DATE as a Date at local midnight; a date-only
// column leaves as a date-only string.
export function toDateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

// Money is compared and summed to the cent. Working in floats and then
// comparing "is this spend within the remaining budget" lets 0.1 + 0.2 refuse a
// spend that is exactly on budget, so every comparison goes through cents.
export function cents(value) {
  return Math.round(Number(value || 0) * 100);
}

export function fromCents(value) {
  return Math.round(Number(value || 0)) / 100;
}

// ---- who may do what ------------------------------------------------------
//
// Section 13, enforced here and called from every route rather than trusted to
// the browser. A manager sees and touches their own operation's plan and the
// activities assigned to them, and nothing else.

export function canReadPlan(user, plan) {
  if (hasFullScope(user)) return true;
  // A manager reads the plan for their own business operation. Being named on
  // it is not required -- a manager covering Farming can see Farming's month
  // even if the Director has since named somebody else on it -- but another
  // operation's plan is never readable.
  return Boolean(user.sector) && plan.sector === user.sector;
}

// The manager the plan names is the one who works it. A different manager in
// the same operation can read the plan but records nothing against it.
export function isPlanManager(user, plan) {
  return !isAdmin(user) && plan.manager_id !== null && Number(plan.manager_id) === Number(user.id);
}

// Who may work this month and report against it.
//
// The month belongs to a business operation, and the manager of that operation
// is responsible for it -- that relationship already exists on the account and
// is what decides whose portal the plan appears in, so it decides who may work
// it too. Naming a manager on the plan narrows it to that person; leaving it
// blank leaves the month to whoever manages the operation, which is the normal
// case and no longer means "nobody can touch it".
//
// The Director may report on a manager's behalf: covering for somebody is part
// of running the operations, and every row records who submitted it.
export function canWorkPlan(user, plan) {
  if (isAdmin(user)) return true;
  if (user.role !== 'manager') return false;
  if (!canReadPlan(user, plan)) return false;
  return plan.manager_id === null || Number(plan.manager_id) === Number(user.id);
}

// Recording a spend is the manager's act on their own assigned work. The
// Director may record one too -- correcting a manager's books is part of the
// review -- but nobody else may, whatever the browser drew.
//
// The same person who may start and finish the work: its assignee, or -- for
// work nobody was handed -- a manager of its operation. The two rules used to
// differ, so an approved request its own manager raised could be started and
// handed back but not spent against.
export function canRecordExpense(user, activity) {
  if (isAdmin(user)) return true;
  const inScope = hasFullScope(user) || (Boolean(user.sector) && activity.sector === user.sector);
  if (!inScope) return false;
  if (!activity.assigned_to) return user.role === 'manager';
  return Number(activity.assigned_to) === Number(user.id);
}

// Financial records are never deleted by the person who created them. Only the
// Director may remove an expense, and the removal is audited.
export function canDeleteExpense(user) {
  return isAdmin(user);
}

// ---- the budget arithmetic ------------------------------------------------

// Section 5: remaining = approved - spent, derived rather than stored.
export function activityRemaining(approvedBudget, spent) {
  return fromCents(cents(approvedBudget) - cents(spent));
}

// Section 8. The message is the one the specification asks for, word for word,
// because it is what tells the manager what to do next.
export const OVER_BUDGET_MESSAGE =
  'Expense exceeds the remaining approved budget. Submit a budget change request to Admin.';

// Whether a spend fits inside what is left on the activity. Everything is in
// cents, so a spend of exactly the remaining budget is allowed and a spend one
// cent over is not.
export function fitsRemaining(amount, approvedBudget, alreadySpent) {
  const remaining = cents(approvedBudget) - cents(alreadySpent);
  return cents(amount) <= remaining;
}

// ---- the month's ceiling --------------------------------------------------
//
// The budget the Director approved for the month is a ceiling, not a running
// total. Before this existed the plan's approved figure was recalculated from
// whatever activities happened to be on it -- adding work after confirmation
// quietly raised the allocation -- so the month could never be over budget and
// this refusal could never happen. Now the figure is the Director's, and work
// has to fit inside what is left of it.
//
// Committed is the sum of the budgets handed out, whether or not they have been
// spent yet: money promised to an activity is not available to promise again.
export function fitsBudget(amount, ceiling, alreadyCommitted) {
  return cents(amount) <= cents(ceiling) - cents(alreadyCommitted);
}

// The amount still free to hand out.
export function uncommitted(ceiling, alreadyCommitted) {
  return fromCents(cents(ceiling) - cents(alreadyCommitted));
}

// Money is shown to people in the currency they approved it in, to the cent.
export function formatUsd(value) {
  const amount = Number(value || 0);
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// What the manager is told when the work they are assigning does not fit. It
// names the figure, because "over budget" without it leaves them to go and
// work out how much room they actually have.
export function overMonthlyBudgetMessage(remaining) {
  return `This activity exceeds the remaining monthly budget of ${formatUsd(remaining)}.`;
}

// And the same refusal one level down: the day-by-day work a manager assigns
// cannot add up to more than the planned activity it belongs to was given.
export function overActivityBudgetMessage(remaining) {
  return `This work exceeds the remaining budget of ${formatUsd(remaining)} on this planned activity.`;
}

// ---- statuses -------------------------------------------------------------

// An activity counts as done when it reaches Completed. Everything else that is
// still live counts as outstanding; refused and cancelled work counts as
// neither, because it is not waiting on anybody.
export const COMPLETED_STATUS = 'Completed';
export const DEAD_STATUSES = ['Rejected', 'Cancelled'];

// "Your work" on the home screen and in the register: approved work this account
// carries that is not finished and not already handed back for the final check.
// One definition, used by the count and by the list, so the two always agree.
export function openWorkSql(values, alias = 'a', userId) {
  values.push(userId);
  return `(${alias}.assigned_to = $${values.length}
    AND ${alias}.status IN ('Approved', 'Budget Adjusted', 'In Progress', 'Needs Correction')
    AND ${alias}.completion_submitted_at IS NULL)`;
}

// Finished work handed back and waiting for the Director's final check.
export const FINAL_CHECK_SQL = (alias = 'a') =>
  `(${alias}.completion_submitted_at IS NOT NULL AND ${alias}.status <> 'Completed')`;

export function isLive(status) {
  return !DEAD_STATUSES.includes(status);
}

// A closed month is a historical record. Recording a spend against it, or
// editing its plan, would rewrite an account the Director has already signed
// off, so both are refused.
export function isPlanOpen(plan) {
  return plan.status !== 'Closed';
}

// ---- how far the month's objectives have got -------------------------------
//
// THE RULE: progress is calculated from the work actually recorded, never typed.
// A manager cannot set "60%" on an objective; they record the 1.2 hectares they
// cultivated and the percentage follows. That is the whole point of keeping the
// daily records -- a typed percentage and the days behind it drift apart, and
// then the month's figure is somebody's opinion rather than its history.
//
// An objective with no countable target (no target_quantity) has no percentage.
// It is not 0% -- "nothing to count" and "nothing done" are different things,
// and showing the second for the first makes a month look failed when it is
// simply not measured that way.
export function objectiveProgress(targetQuantity, quantityDone) {
  const target = targetQuantity === null || targetQuantity === undefined
    ? null
    : fromCents(cents(targetQuantity));
  const done = fromCents(cents(quantityDone || 0));
  if (target === null || target <= 0) {
    return { target: null, done, remaining: null, percent: null, complete: false };
  }
  const remaining = fromCents(Math.max(0, cents(target) - cents(done)));
  // Capped at 100: the report route refuses work that would take an objective
  // past its target, but a target lowered after the fact must not print 140%.
  const percent = Math.min(100, Math.round((done / target) * 100));
  return { target, done, remaining, percent, complete: cents(done) >= cents(target) };
}

// The month as one figure, from its objectives.
//
// Weighted by `weight` when any objective carries one, so "produce 500 tons"
// need not count for the same as "file 2 reports". When none does -- the usual
// case -- it is the plain average of the objectives' percentages, which is what
// the spec asks for and what people expect when nobody has said otherwise.
//
// Objectives with no countable target are left out of the average rather than
// counted as zero, for the same reason they have no percentage of their own. A
// month made entirely of uncountable objectives has no overall percentage.
export function planProgress(objectives) {
  const counted = (objectives || []).filter((objective) => objective.percent !== null);
  if (!counted.length) return null;
  const weighted = counted.some((objective) => Number(objective.weight) > 0);
  if (!weighted) {
    const total = counted.reduce((sum, objective) => sum + objective.percent, 0);
    return Math.round(total / counted.length);
  }
  // An objective with no weight among weighted ones counts as 1, so adding a
  // weight to one objective does not silently erase the others.
  let weightSum = 0;
  let scoreSum = 0;
  for (const objective of counted) {
    const weight = Number(objective.weight) > 0 ? Number(objective.weight) : 1;
    weightSum += weight;
    scoreSum += weight * objective.percent;
  }
  return weightSum ? Math.round(scoreSum / weightSum) : null;
}
