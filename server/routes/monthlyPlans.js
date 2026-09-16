// Monthly planning, allocation and month-end review.
//
// The cycle this implements, and nothing beyond it:
//
//   PLANNING          the Director creates a plan per business operation for
//                     the month, names the manager, states what the month is
//                     for, TYPES THE BUDGET THEY APPROVE, and lists the
//                     planned activities with a budget each
//   CONFIRMATION      the Director confirms it. This RECORDS an approved
//                     allocation. The money itself is handed over outside the
//                     platform -- there is no transaction, no transfer, no
//                     wallet, no gateway
//   ASSIGNMENT        the manager opens the confirmed plan and assigns the
//                     day-by-day work that will finish each planned activity:
//                     what, which day, who does it, what it costs. This is the
//                     manager's only way in -- they do not invent work outside
//                     the plan, and nothing they assign can exceed what is
//                     left of the Director's budget
//   EXECUTION         the person it was assigned to does that day's work
//   EXPENSE           what was actually spent is recorded against the day's
//                     work, with payment evidence, and cannot exceed what is
//                     left
//   COMPLETION        evidence the work was really done is attached
//   REVIEW            the Director watches each planned activity progress
//                     through the days underneath it, and sees budget,
//                     committed, spend, remaining and the evidence gaps
//   MONTH-END         the manager reports; the Director closes the month
//
// THE THREE THINGS THAT ARE NOT THE SAME, because they were being confused:
//
//   business operation  one of the four fixed operations (farming, agriculture,
//                       mining, movement). A column, not a record.
//   project             a named undertaking inside one operation. Activities
//                       have always belonged to one.
//   monthly plan        one operation's one month, with the budget approved for
//                       it. This is the thing a manager works from.
//
// Activities live in the existing `activities` table, at two levels: a planned
// activity has a monthly_plan_id and no parent, and the manager's day-by-day
// work has both. There is no second activity system and no third entity.

import express from 'express';
import { pool, safeRollback } from '../db/database.js';
import { asyncRoute, hasFullScope, isAdmin, isValidDate, parseId, requiredText, sectorIds, validNumber, withinScope } from '../lib/http.js';
import { PLAN_PRIORITIES, REPORT_STATUSES } from '../db/monthlySchema.js';
import { getCurrentRate, round2 } from '../lib/rates.js';
import {
  COMPLETED_STATUS, canReadPlan, cents, currentMonth, fitsBudget, formatUsd, fromCents,
  isPlanManager, isPlanOpen, monthKey, monthStart, overActivityBudgetMessage,
  overMonthlyBudgetMessage, toDateOnly, uncommitted
} from '../lib/monthly.js';

const router = express.Router();

class PlanError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireAdmin(user, action) {
  if (!isAdmin(user)) throw new PlanError(403, `Only the Director can ${action}.`);
}

function optionalText(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

async function logPlanHistory(client, planId, user, entries) {
  for (const entry of entries) {
    await client.query(
      `INSERT INTO monthly_plan_history (plan_id, action, field, old_value, new_value, note, actor_id, actor_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        planId, entry.action, entry.field || null,
        entry.oldValue === null || entry.oldValue === undefined ? null : String(entry.oldValue),
        entry.newValue === null || entry.newValue === undefined ? null : String(entry.newValue),
        entry.note || '', user.id, user.name
      ]
    );
  }
}

// ---- the two budget ceilings ----------------------------------------------
//
// The Director's approved budget is the month's ceiling, and each planned
// activity's budget is a ceiling for the day-by-day work underneath it. Both are
// checked the same way: read the ceiling under a row lock, add up what has
// already been promised against it, and refuse anything that does not fit.
//
// The lock matters. Two managers assigning work in the same second would
// otherwise both read the same remaining figure and both fit inside it, and the
// month would end up over budget with no single request to blame.

// What the month has approved and what it has already given out. Only planned
// activities count towards committed -- the work underneath them is already
// counted through the planned activity it belongs to.
async function planPosition(client, planId) {
  const plan = await client.query(
    'SELECT approved_budget, status FROM monthly_plans WHERE id = $1 FOR UPDATE',
    [planId]
  );
  if (!plan.rowCount) throw new PlanError(404, 'Monthly plan not found.');
  const committed = await client.query(
    `SELECT COALESCE(SUM(COALESCE(approved_budget, requested_budget)), 0) AS committed
     FROM activities
     WHERE monthly_plan_id = $1 AND parent_activity_id IS NULL
       AND status NOT IN ('Rejected', 'Cancelled')`,
    [planId]
  );
  const approved = round2(Number(plan.rows[0].approved_budget || 0));
  const alreadyCommitted = round2(Number(committed.rows[0].committed || 0));
  return {
    status: plan.rows[0].status,
    approved,
    committed: alreadyCommitted,
    uncommitted: uncommitted(approved, alreadyCommitted)
  };
}

// The same question one level down: what this planned activity was given, and
// how much of it is already promised to the days underneath it. A spend recorded
// directly on the planned activity counts as promised too, so a plan that
// predates the day-by-day work cannot be over-committed by it.
async function plannedActivityPosition(client, activityId) {
  const activity = await client.query(
    `SELECT id, activity, sector, status, monthly_plan_id, parent_activity_id,
            COALESCE(approved_budget, requested_budget, 0) AS approved
     FROM activities WHERE id = $1 FOR UPDATE`,
    [activityId]
  );
  if (!activity.rowCount) throw new PlanError(404, 'Planned activity not found.');
  const promised = await client.query(
    `SELECT
       COALESCE((SELECT SUM(COALESCE(approved_budget, requested_budget)) FROM activities
                 WHERE parent_activity_id = $1 AND status NOT IN ('Rejected', 'Cancelled')), 0) AS children,
       COALESCE((SELECT SUM(amount) FROM activity_expenses WHERE activity_id = $1), 0) AS own_spent`,
    [activityId]
  );
  const approved = round2(Number(activity.rows[0].approved || 0));
  const committed = round2(Number(promised.rows[0].children || 0) + Number(promised.rows[0].own_spent || 0));
  return {
    row: activity.rows[0],
    approved,
    committed,
    uncommitted: uncommitted(approved, committed)
  };
}

// Every figure the plan screens need, computed from the rows rather than stored
// on the plan -- except the approved budget itself, which is the Director's
// decision and lives on monthly_plans.approved_budget. What is COMMITTED (money
// handed out to planned activities) and what is SPENT are both derived, so
// neither can drift out of step with the rows they are made of.
//
// Only planned activities (parent_activity_id IS NULL) are counted and summed
// here. The manager's day-by-day work carries the same monthly_plan_id so that
// scoping and the closed-month guard reach it, which means counting every row
// would add each budget twice -- once on the planned activity and again on the
// work underneath it. Spend is the exception: it is summed over both levels,
// because a day's work is where money is actually recorded.
const PLAN_TOTALS = `
  SELECT
    -- An activity approved without an explicit figure was approved at what it
    -- asked for. The spend check already reads it that way (budgetPosition in
    -- routes/activities.js); counting it here as zero let the plan show a
    -- negative balance for money that was, in fact, approved.
    COALESCE(SUM(COALESCE(a.approved_budget, a.requested_budget))
      FILTER (WHERE a.parent_activity_id IS NULL AND a.status NOT IN ('Rejected', 'Cancelled')), 0) AS planned_budget,
    COUNT(*) FILTER (WHERE a.parent_activity_id IS NULL AND a.status NOT IN ('Rejected', 'Cancelled'))::int AS activity_count,
    COUNT(*) FILTER (WHERE a.parent_activity_id IS NULL AND a.status = 'Completed')::int AS completed_count,
    COUNT(*) FILTER (WHERE a.parent_activity_id IS NULL AND a.status NOT IN ('Rejected', 'Cancelled', 'Completed'))::int AS outstanding_count,
    -- The day-by-day work underneath, so the Director can see the month moving
    -- rather than only its planned activities sitting there.
    COUNT(*) FILTER (WHERE a.parent_activity_id IS NOT NULL AND a.status NOT IN ('Rejected', 'Cancelled'))::int AS work_count,
    COUNT(*) FILTER (WHERE a.parent_activity_id IS NOT NULL AND a.status = 'Completed')::int AS work_completed_count,
    COALESCE((SELECT SUM(e.amount) FROM activity_expenses e
              JOIN activities ea ON ea.id = e.activity_id
              WHERE ea.monthly_plan_id = p.id), 0) AS total_spent,
    COALESCE((SELECT COUNT(*) FROM activity_expenses e
              JOIN activities ea ON ea.id = e.activity_id
              WHERE ea.monthly_plan_id = p.id), 0)::int AS expense_count,
    -- Section 9: an expense with no receipt behind it is the thing the Director
    -- is looking for, so it is counted rather than left to be eyeballed.
    COALESCE((SELECT COUNT(*) FROM activity_expenses e
              JOIN activities ea ON ea.id = e.activity_id
              WHERE ea.monthly_plan_id = p.id
                AND NOT EXISTS (SELECT 1 FROM activity_evidence ev
                                WHERE ev.expense_id = e.id AND ev.evidence_type = 'payment')), 0)::int
      AS expenses_without_evidence,
    -- And likewise finished work with nothing to show for it. A planned
    -- activity's proof may sit on the day's work underneath it rather than on
    -- the planned activity itself, so the subtree is what is searched.
    COUNT(*) FILTER (WHERE a.parent_activity_id IS NULL AND a.status = 'Completed'
      AND NOT EXISTS (SELECT 1 FROM activity_evidence ev
                      JOIN activities sub ON sub.id = ev.activity_id
                      WHERE (sub.id = a.id OR sub.parent_activity_id = a.id)
                        AND ev.evidence_type = 'activity'))::int
      AS completed_without_evidence
  FROM activities a WHERE a.monthly_plan_id = p.id
`;

const SELECT_PLAN = `
  SELECT p.*, m.name AS manager_name, m.username AS manager_username,
         c.name AS created_by_name, cf.name AS confirmed_by_name, cl.name AS closed_by_name,
         pr.name AS project_name,
         totals.*,
         r.id AS report_id, r.status AS report_status, r.submitted_at AS report_submitted_at
  FROM monthly_plans p
  LEFT JOIN users m ON m.id = p.manager_id
  LEFT JOIN users c ON c.id = p.created_by
  LEFT JOIN users cf ON cf.id = p.confirmed_by
  LEFT JOIN users cl ON cl.id = p.closed_by
  LEFT JOIN projects pr ON pr.id = p.project_id
  LEFT JOIN monthly_reports r ON r.plan_id = p.id
  LEFT JOIN LATERAL (${PLAN_TOTALS}) totals ON TRUE
`;

function mapPlan(row) {
  // The four figures the month is read by, and what each one means:
  //
  //   approved    the ceiling the Director set and handed over. Theirs to type,
  //               stored on the plan, never recalculated from anything.
  //   committed   the sum of the budgets given to this month's planned
  //               activities. Money promised is not available to promise again.
  //   spent       what has actually been recorded as spent, at either level.
  //   remaining   approved - spent: what is left of the cash.
  //
  // uncommitted (approved - committed) is the one a manager needs before
  // assigning work, and is what the over-budget refusal quotes.
  const approvedBudget = round2(Number(row.approved_budget || 0));
  const committedBudget = round2(Number(row.planned_budget || 0));
  const totalSpent = round2(Number(row.total_spent || 0));

  return {
    id: row.id,
    operation: row.sector,
    month: monthKey(row.month),
    managerId: row.manager_id ?? null,
    managerName: row.manager_name ?? null,
    status: row.status,
    notes: row.notes || '',
    // What the month is about and what it is meant to achieve.
    category: row.category || '',
    objective: row.objective || '',
    projectId: row.project_id ?? null,
    projectName: row.project_name ?? null,

    // ---- the money -------------------------------------------------------
    approvedBudget,
    committedBudget,
    uncommittedBudget: uncommitted(approvedBudget, committedBudget),
    totalSpent,
    remainingBalance: fromCents(cents(approvedBudget) - cents(totalSpent)),
    // Kept under its old name as well: the plan screens, the month-end report
    // and the exports all read plannedBudget, and it is the same figure.
    plannedBudget: committedBudget,
    // Positive when more has been committed than was approved. That can no
    // longer happen through the API -- the ceiling refuses it -- but a plan
    // whose allocation was lowered after the fact can still show it, and the
    // Director should see that rather than have it folded away.
    budgetDrift: fromCents(cents(committedBudget) - cents(approvedBudget)),

    activityCount: row.activity_count ?? 0,
    completedCount: row.completed_count ?? 0,
    outstandingCount: row.outstanding_count ?? 0,
    // The day-by-day work underneath the planned activities.
    workCount: row.work_count ?? 0,
    workCompletedCount: row.work_completed_count ?? 0,
    expenseCount: row.expense_count ?? 0,
    expensesWithoutEvidence: row.expenses_without_evidence ?? 0,
    completedWithoutEvidence: row.completed_without_evidence ?? 0,

    createdBy: row.created_by ?? null,
    createdByName: row.created_by_name ?? null,
    confirmedBy: row.confirmed_by ?? null,
    confirmedByName: row.confirmed_by_name ?? null,
    confirmedAt: row.confirmed_at ?? null,
    closedBy: row.closed_by ?? null,
    closedByName: row.closed_by_name ?? null,
    closedAt: row.closed_at ?? null,
    report: row.report_id
      ? { id: row.report_id, status: row.report_status, submittedAt: row.report_submitted_at }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// A plan, scoped. A manager reads their own operation's plans and no others --
// checked in SQL, not filtered in the browser.
async function loadPlan(id, user) {
  const planId = parseId(id);
  if (!planId) throw new PlanError(404, 'Monthly plan not found.');
  const values = [planId];
  let scope = '';
  if (!hasFullScope(user)) {
    values.push(user.sector);
    scope = ` AND p.sector = $${values.length}`;
  }
  const result = await pool.query(`${SELECT_PLAN} WHERE p.id = $1${scope}`, values);
  if (!result.rowCount) throw new PlanError(404, 'Monthly plan not found.');
  return result.rows[0];
}

router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ message: 'Authentication required.' });
  next();
});

// ---- the register of plans -------------------------------------------------

router.get('/', asyncRoute(async (req, res) => {
  const values = [];
  const filters = [];

  if (req.query.month) {
    const month = monthStart(req.query.month);
    if (!month) return res.status(400).json({ message: 'The month must be in YYYY-MM form.' });
    values.push(month);
    filters.push(`p.month = $${values.length}::date`);
  }
  if (req.query.operation && req.query.operation !== 'All') {
    if (!sectorIds.has(req.query.operation)) {
      return res.status(400).json({ message: 'That business operation does not exist.' });
    }
    values.push(req.query.operation);
    filters.push(`p.sector = $${values.length}`);
  }
  // The scope a manager cannot ask their way out of.
  if (!hasFullScope(req.user)) {
    values.push(req.user.sector);
    filters.push(`p.sector = $${values.length}`);
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const result = await pool.query(`${SELECT_PLAN} ${where} ORDER BY p.month DESC, p.sector`, values);
  res.json(result.rows.map(mapPlan));
}));

// Section 9: the Director's monthly review, all four operations side by side.
// A manager gets the same shape for their own operation, so their dashboard and
// the Director's review can never disagree about the figures.
router.get('/review', asyncRoute(async (req, res) => {
  const month = monthStart(req.query.month || currentMonth());
  if (!month) return res.status(400).json({ message: 'The month must be in YYYY-MM form.' });

  const values = [month];
  let scope = '';
  if (!hasFullScope(req.user)) {
    values.push(req.user.sector);
    scope = ` AND p.sector = $${values.length}`;
  }
  const plans = await pool.query(`${SELECT_PLAN} WHERE p.month = $1::date${scope} ORDER BY p.sector`, values);
  const rows = plans.rows.map(mapPlan);

  res.json({
    month: monthKey(month),
    operations: rows,
    totals: {
      approvedBudget: round2(rows.reduce((sum, plan) => sum + plan.approvedBudget, 0)),
      totalSpent: round2(rows.reduce((sum, plan) => sum + plan.totalSpent, 0)),
      remainingBalance: round2(rows.reduce((sum, plan) => sum + plan.remainingBalance, 0)),
      activities: rows.reduce((sum, plan) => sum + plan.activityCount, 0),
      completed: rows.reduce((sum, plan) => sum + plan.completedCount, 0),
      outstanding: rows.reduce((sum, plan) => sum + plan.outstandingCount, 0),
      expensesWithoutEvidence: rows.reduce((sum, plan) => sum + plan.expensesWithoutEvidence, 0),
      completedWithoutEvidence: rows.reduce((sum, plan) => sum + plan.completedWithoutEvidence, 0)
    }
  });
}));

// One plan with everything on it: the activities, what each has spent, and the
// evidence counts. This is what both the Director's plan screen and the
// manager's "my activities this month" are built from.
// One activity row, at either level, in the shape the screens read.
function mapPlanActivity(activity) {
  const approved = round2(Number(activity.approved_budget || 0));
  const spent = round2(Number(activity.spent || 0));
  return {
    id: activity.id,
    activity: activity.activity,
    description: activity.description || '',
    category: activity.category,
    operation: activity.sector,
    status: activity.status,
    priority: activity.priority || 'Medium',
    approvedBudget: approved,
    spent,
    // Section 5: remaining = approved - actual, per activity.
    remaining: fromCents(cents(approved) - cents(spent)),
    deadline: toDateOnly(activity.deadline),
    // The day the work is being done, which is the manager's, not the deadline,
    // which is the Director's.
    scheduledFor: toDateOnly(activity.scheduled_for),
    adminNote: activity.admin_note || '',
    instructions: activity.instructions || '',
    evidenceRequired: activity.evidence_required !== false,
    assignedTo: activity.assigned_to ?? null,
    assignedToName: activity.assigned_to_name ?? null,
    assignedToRole: activity.assigned_to_role ?? null,
    completedAt: activity.completed_at ?? null,
    completionSubmittedAt: activity.completion_submitted_at ?? null,
    expenseCount: activity.expense_count,
    paymentEvidenceCount: activity.payment_evidence_count,
    activityEvidenceCount: activity.activity_evidence_count,
    expensesWithoutEvidence: activity.expenses_without_evidence
  };
}

// The whole month in one payload: the plan, its planned activities with the
// day-by-day work nested underneath each one, the audit trail and the report.
//
// Both levels come back in a single query and are assembled here rather than
// asked for one planned activity at a time, so a month with thirty days of work
// on it is still one round trip.
async function planDetail(planId, user) {
  const row = await loadPlan(planId, user);
  const [activities, history, report] = await Promise.all([
    pool.query(
      `SELECT a.id, a.activity, a.description, a.category, a.sector, a.status, a.priority,
              COALESCE(a.approved_budget, a.requested_budget) AS approved_budget,
              a.deadline, a.scheduled_for, a.admin_note, a.instructions, a.evidence_required,
              a.assigned_to, a.completed_at, a.completion_submitted_at, a.parent_activity_id,
              m.name AS assigned_to_name, m.role AS assigned_to_role,
              COALESCE((SELECT SUM(e.amount) FROM activity_expenses e WHERE e.activity_id = a.id), 0) AS spent,
              (SELECT COUNT(*) FROM activity_expenses e WHERE e.activity_id = a.id)::int AS expense_count,
              (SELECT COUNT(*) FROM activity_evidence ev
                WHERE ev.activity_id = a.id AND ev.evidence_type = 'payment')::int AS payment_evidence_count,
              (SELECT COUNT(*) FROM activity_evidence ev
                WHERE ev.activity_id = a.id AND ev.evidence_type = 'activity')::int AS activity_evidence_count,
              (SELECT COUNT(*) FROM activity_expenses e
                WHERE e.activity_id = a.id
                  AND NOT EXISTS (SELECT 1 FROM activity_evidence ev
                                  WHERE ev.expense_id = e.id AND ev.evidence_type = 'payment'))::int
                AS expenses_without_evidence
       FROM activities a
       LEFT JOIN users m ON m.id = a.assigned_to
       WHERE a.monthly_plan_id = $1
       ORDER BY CASE a.priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END,
                a.deadline NULLS LAST, a.scheduled_for NULLS LAST, a.created_at`,
      [planId]
    ),
    pool.query('SELECT * FROM monthly_plan_history WHERE plan_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200', [planId]),
    pool.query(
      `SELECT r.*, s.name AS submitted_by_name, v.name AS reviewed_by_name
       FROM monthly_reports r
       LEFT JOIN users s ON s.id = r.submitted_by
       LEFT JOIN users v ON v.id = r.reviewed_by
       WHERE r.plan_id = $1`,
      [planId]
    )
  ]);

  // The days of work, grouped by the planned activity they serve, each group in
  // date order -- that is the order somebody reading the month wants them in,
  // whatever priority they were given.
  const workByParent = new Map();
  for (const activity of activities.rows) {
    if (!activity.parent_activity_id) continue;
    const group = workByParent.get(activity.parent_activity_id) || [];
    group.push(mapPlanActivity(activity));
    workByParent.set(activity.parent_activity_id, group);
  }
  for (const group of workByParent.values()) {
    group.sort((a, b) => String(a.scheduledFor || '').localeCompare(String(b.scheduledFor || '')));
  }

  const planned = activities.rows.filter((activity) => !activity.parent_activity_id).map((activity) => {
    const mapped = mapPlanActivity(activity);
    const work = workByParent.get(activity.id) || [];
    const live = work.filter((day) => !['Rejected', 'Cancelled'].includes(day.status));
    // What the planned activity has promised to the days underneath it, and what
    // has actually been spent anywhere in it. A spend recorded directly on the
    // planned activity counts as committed as well, so an activity that was
    // being spent against before the day-by-day work existed cannot be
    // over-committed by it.
    const committedToWork = fromCents(live.reduce((total, day) => total + cents(day.approvedBudget), 0));
    const workSpent = fromCents(work.reduce((total, day) => total + cents(day.spent), 0));
    const spent = fromCents(cents(mapped.spent) + cents(workSpent));
    return {
      ...mapped,
      // Rolled up, so the Director reads one figure per planned activity rather
      // than adding up the days themselves.
      spent,
      remaining: fromCents(cents(mapped.approvedBudget) - cents(spent)),
      committedToWork,
      uncommitted: uncommitted(mapped.approvedBudget, fromCents(cents(committedToWork) + cents(mapped.spent))),
      workCount: live.length,
      workCompletedCount: live.filter((day) => day.status === COMPLETED_STATUS).length,
      workExpensesWithoutEvidence: work.reduce((total, day) => total + day.expensesWithoutEvidence, 0),
      // How far along this planned activity is, by the days of work finished
      // under it. Null when nothing has been assigned yet -- "no work planned"
      // is a different thing from "0% done".
      workProgress: live.length
        ? Math.round((live.filter((day) => day.status === COMPLETED_STATUS).length / live.length) * 100)
        : null,
      work
    };
  });

  return {
    plan: mapPlan(row),
    activities: planned,
    history: history.rows.map((entry) => ({
      id: entry.id,
      action: entry.action,
      field: entry.field,
      oldValue: entry.old_value,
      newValue: entry.new_value,
      note: entry.note || '',
      actorName: entry.actor_name,
      createdAt: entry.created_at
    })),
    report: report.rowCount ? mapReport(report.rows[0]) : null
  };
}

router.get('/:id', asyncRoute(async (req, res) => {
  const row = await loadPlan(req.params.id, req.user);
  if (!canReadPlan(req.user, row)) {
    return res.status(403).json({ message: 'This plan belongs to another business operation.' });
  }
  res.json(await planDetail(row.id, req.user));
}));

function mapReport(row) {
  return {
    id: row.id,
    planId: row.plan_id,
    approvedBudget: round2(Number(row.approved_budget)),
    totalSpent: round2(Number(row.total_spent)),
    remainingBalance: round2(Number(row.remaining_balance)),
    completedActivities: row.completed_activities,
    incompleteActivities: row.incomplete_activities,
    activityEvidenceCount: row.activity_evidence_count,
    paymentEvidenceCount: row.payment_evidence_count,
    unusedBalanceExplanation: row.unused_balance_explanation || '',
    budgetDifferenceExplanation: row.budget_difference_explanation || '',
    status: row.status,
    reviewNote: row.review_note || '',
    submittedBy: row.submitted_by ?? null,
    submittedByName: row.submitted_by_name ?? null,
    submittedAt: row.submitted_at,
    reviewedBy: row.reviewed_by ?? null,
    reviewedByName: row.reviewed_by_name ?? null,
    reviewedAt: row.reviewed_at ?? null
  };
}

// ---- creating and editing the plan (Director only) -------------------------

router.post('/', asyncRoute(async (req, res) => {
  requireAdmin(req.user, 'create a monthly plan');
  const { operation, managerId } = req.body || {};

  if (!sectorIds.has(operation)) {
    return res.status(400).json({ message: 'Choose one of the four business operations.' });
  }
  const month = monthStart(req.body?.month);
  if (!month) return res.status(400).json({ message: 'The month must be in YYYY-MM form.' });

  // The budget the Director approves for the month. It used to be worked out at
  // confirmation from whatever activities had been added, which meant the
  // Director never actually set a figure and the month could not be over budget.
  // It is theirs to state, and everything else has to fit inside it.
  const budgetGiven = Object.prototype.hasOwnProperty.call(req.body || {}, 'approvedBudget')
    && req.body.approvedBudget !== '' && req.body.approvedBudget !== null;
  if (budgetGiven && !validNumber(req.body.approvedBudget)) {
    return res.status(400).json({ message: 'The approved budget must be a valid non-negative number.' });
  }
  const approvedBudget = budgetGiven ? round2(req.body.approvedBudget) : 0;

  // The project the month's work belongs to, when the operation runs more than
  // one. It must be a project of this operation, or the plan would point at
  // work in somebody else's area.
  let projectId = null;
  if (requiredText(req.body?.projectId)) {
    const project = await pool.query('SELECT id FROM projects WHERE id = $1 AND sector = $2', [req.body.projectId, operation]);
    if (!project.rowCount) {
      return res.status(400).json({ message: 'That project does not belong to this business operation.' });
    }
    projectId = project.rows[0].id;
  }

  // The manager responsible must actually cover this operation, or they would
  // be named on a plan whose activities they cannot open.
  let manager = null;
  if (managerId) {
    const managerKey = parseId(managerId);
    if (!managerKey) return res.status(400).json({ message: 'The selected manager is invalid.' });
    const found = await pool.query(
      "SELECT id, name, sector, role, covers_all_sectors AS \"coversAllSectors\" FROM users WHERE id = $1 AND role = 'manager' AND status = 'active'",
      [managerKey]
    );
    if (!found.rowCount) return res.status(400).json({ message: 'The selected manager is invalid.' });
    // A manager covering every operation may run any operation's month.
    if (!withinScope(found.rows[0], operation)) {
      return res.status(400).json({ message: 'That manager works in a different business operation.' });
    }
    manager = found.rows[0];
  }

  let planId = null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO monthly_plans
         (sector, month, manager_id, status, notes, created_by, category, objective, project_id, approved_budget)
       VALUES ($1, $2::date, $3, 'Draft', $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        operation, month, manager?.id ?? null, optionalText(req.body?.notes, 2000), req.user.id,
        optionalText(req.body?.category, 100), optionalText(req.body?.objective, 4000),
        projectId, approvedBudget
      ]
    );
    await logPlanHistory(client, inserted.rows[0].id, req.user, [
      { action: 'Plan created', field: 'month', oldValue: null, newValue: monthKey(month) },
      ...(manager ? [{ action: 'Manager assigned', field: 'managerId', oldValue: null, newValue: String(manager.id) }] : []),
      ...(approvedBudget ? [{
        action: 'Approved allocation changed', field: 'approvedBudget', oldValue: null, newValue: approvedBudget,
        note: 'Budget approved for the month by the Director.'
      }] : [])
    ]);
    await client.query('COMMIT');
    planId = inserted.rows[0].id;
  } catch (error) {
    await safeRollback(client);
    // One plan per operation per month, enforced by a unique index.
    if (error?.code === '23505') {
      return res.status(409).json({ message: 'A plan already exists for that business operation and month.' });
    }
    throw error;
  } finally {
    client.release();
  }

  // Reloaded only after the transaction's connection is back in the pool. The
  // reload goes through pool.query, and on Vercel the pool holds exactly one
  // connection (max: 1 in db/database.js) -- asking it for a second while this
  // one was still checked out waited out connectionTimeoutMillis and threw.
  // That happened *after* the COMMIT, so the plan was written and the caller
  // still got "Server or database error".
  res.status(201).json(mapPlan(await loadPlan(planId, req.user)));
}));

// Section 10: the Director may change the plan before or during the month.
// Every change is written to the audit trail, never silently applied.
router.patch('/:id', asyncRoute(async (req, res) => {
  requireAdmin(req.user, 'change a monthly plan');
  const existing = await loadPlan(req.params.id, req.user);
  if (!isPlanOpen(existing)) {
    return res.status(400).json({ message: 'This month has been closed. Reopen it before changing the plan.' });
  }
  const payload = req.body || {};
  const entries = [];

  let managerId = existing.manager_id;
  if (Object.prototype.hasOwnProperty.call(payload, 'managerId')) {
    const clearing = payload.managerId === null || payload.managerId === '';
    managerId = clearing ? null : parseId(payload.managerId);
    if (!clearing && !managerId) return res.status(400).json({ message: 'The selected manager is invalid.' });
    if (managerId) {
      const found = await pool.query(
        "SELECT id, sector, role, covers_all_sectors AS \"coversAllSectors\" FROM users WHERE id = $1 AND role = 'manager' AND status = 'active'",
        [managerId]
      );
      if (!found.rowCount) return res.status(400).json({ message: 'The selected manager is invalid.' });
      if (!withinScope(found.rows[0], existing.sector)) {
        return res.status(400).json({ message: 'That manager works in a different business operation.' });
      }
    }
    if (managerId !== existing.manager_id) {
      entries.push({
        action: 'Manager changed', field: 'managerId',
        oldValue: existing.manager_id, newValue: managerId,
        note: optionalText(payload.reason, 1000)
      });
    }
  }

  const notesGiven = Object.prototype.hasOwnProperty.call(payload, 'notes');
  const notes = notesGiven ? optionalText(payload.notes, 2000) : existing.notes;
  if (notesGiven && notes !== (existing.notes || '')) {
    entries.push({ action: 'Notes updated', field: 'notes', oldValue: existing.notes || null, newValue: notes });
  }

  // What the month is about, and what it is meant to achieve. Both are the
  // Director's words and both are audited, because the manager works to them.
  const categoryGiven = Object.prototype.hasOwnProperty.call(payload, 'category');
  const category = categoryGiven ? optionalText(payload.category, 100) : existing.category;
  if (categoryGiven && category !== (existing.category || '')) {
    entries.push({ action: 'Category updated', field: 'category', oldValue: existing.category || null, newValue: category });
  }
  const objectiveGiven = Object.prototype.hasOwnProperty.call(payload, 'objective');
  const objective = objectiveGiven ? optionalText(payload.objective, 4000) : existing.objective;
  if (objectiveGiven && objective !== (existing.objective || '')) {
    entries.push({ action: 'Objectives updated', field: 'objective', oldValue: existing.objective || null, newValue: objective });
  }

  let projectId = existing.project_id;
  if (Object.prototype.hasOwnProperty.call(payload, 'projectId')) {
    const clearing = payload.projectId === null || payload.projectId === '';
    projectId = clearing ? null : String(payload.projectId);
    if (projectId) {
      const project = await pool.query('SELECT id FROM projects WHERE id = $1 AND sector = $2', [projectId, existing.sector]);
      if (!project.rowCount) {
        return res.status(400).json({ message: 'That project does not belong to this business operation.' });
      }
    }
    if (projectId !== existing.project_id) {
      entries.push({ action: 'Project changed', field: 'projectId', oldValue: existing.project_id, newValue: projectId });
    }
  }

  // Changing the confirmed allocation is a financial change: it needs a reason
  // and it is kept in the trail alongside the figure it replaced.
  let approvedBudget = round2(Number(existing.approved_budget));
  if (Object.prototype.hasOwnProperty.call(payload, 'approvedBudget')) {
    if (!validNumber(payload.approvedBudget)) {
      return res.status(400).json({ message: 'The approved budget must be a valid non-negative number.' });
    }
    const next = round2(payload.approvedBudget);
    if (next !== approvedBudget) {
      // Once the month is running, a change to the figure the manager is working
      // to needs a reason on the record. While it is still a draft the Director
      // is simply setting it, and being made to justify a first draft of a
      // number is how people end up typing "n/a".
      if (existing.status !== 'Draft' && !requiredText(payload.reason)) {
        return res.status(400).json({ message: 'Say why the approved allocation is changing.' });
      }
      // Lowering the ceiling below what has already been given out would leave
      // the month over budget with nothing on screen to explain it, and the
      // manager unable to act on either figure.
      const committed = round2(Number(existing.planned_budget || 0));
      if (cents(next) < cents(committed)) {
        return res.status(400).json({
          message: `${formatUsd(committed)} has already been committed to this month's activities. Remove or reduce some before lowering the budget to ${formatUsd(next)}.`
        });
      }
      entries.push({
        action: 'Approved allocation changed', field: 'approvedBudget',
        oldValue: approvedBudget, newValue: next, note: optionalText(payload.reason, 1000)
      });
      approvedBudget = next;
    }
  }

  if (!entries.length) return res.status(400).json({ message: 'Nothing to change.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE monthly_plans
       SET manager_id = $2, notes = $3, approved_budget = $4, category = $5, objective = $6,
           project_id = $7, updated_at = NOW()
       WHERE id = $1`,
      [existing.id, managerId, notes, approvedBudget, category, objective, projectId]
    );
    // A new manager takes over the month's live work with it. Left on the old
    // manager, the activities could not have expenses recorded by the new one
    // (canRecordExpense checks assigned_to), and anything still waiting on a
    // manager's approval would keep waiting on somebody no longer responsible.
    if (managerId && managerId !== existing.manager_id) {
      const handed = await client.query(
        `UPDATE activities
         SET assigned_to = $2, assigned_at = NOW(),
             approval_required_from = CASE
               WHEN approval_required_role = 'manager' AND approval_status = 'pending' THEN $2::int
               ELSE approval_required_from END,
             updated_at = NOW()
         WHERE monthly_plan_id = $1
           AND status NOT IN ('Completed', 'Rejected', 'Cancelled')
           AND assigned_to IS DISTINCT FROM $2::int
         RETURNING id, assigned_to`,
        [existing.id, managerId]
      );
      for (const row of handed.rows) {
        await client.query(
          `INSERT INTO activity_history (activity_id, action, field, old_value, new_value, note, actor_id, actor_name)
           VALUES ($1, 'Manager assigned', 'assignedTo', $2, $3, $4, $5, $6)`,
          [row.id, existing.manager_id === null ? null : String(existing.manager_id), String(managerId),
            'The monthly plan changed manager', req.user.id, req.user.name]
        );
      }
    }
    await logPlanHistory(client, existing.id, req.user, entries);
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }

  res.json(mapPlan(await loadPlan(existing.id, req.user)));
}));

// ---- confirming the plan ---------------------------------------------------

// Section 2. This records that the Director approved an allocation for the
// month. It does NOT move money: the cash is handed to the manager outside the
// platform, and this row is the accountability record of what was handed over.
router.post('/:id/confirm', asyncRoute(async (req, res) => {
  requireAdmin(req.user, 'confirm a monthly plan');
  const existing = await loadPlan(req.params.id, req.user);

  if (existing.status === 'Closed') {
    return res.status(400).json({ message: 'This month has been closed.' });
  }
  if (existing.status === 'Confirmed') {
    return res.status(409).json({ message: 'This plan has already been confirmed.' });
  }
  if (!existing.manager_id) {
    return res.status(400).json({ message: 'Name the manager responsible before confirming the plan.' });
  }
  if (!Number(existing.activity_count)) {
    return res.status(400).json({ message: 'Add at least one activity before confirming the plan.' });
  }

  // The allocation is the figure the Director typed on the plan, not a total
  // worked out from the activities. Confirming used to overwrite it with that
  // sum, which is why the Director never really approved a budget and why the
  // month could never be over it.
  const allocation = round2(Number(existing.approved_budget || 0));
  const committed = round2(Number(existing.planned_budget || 0));
  if (!allocation) {
    return res.status(400).json({ message: 'Set the budget you are approving for this month before confirming it.' });
  }
  // Confirming a plan whose activities already ask for more than was approved
  // would hand the manager two contradictory figures on their first screen.
  if (cents(committed) > cents(allocation)) {
    return res.status(400).json({
      message: `This month's activities come to ${formatUsd(committed)}, which is more than the ${formatUsd(allocation)} approved. Raise the budget or reduce the activities before confirming.`
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const confirmed = await client.query(
      `UPDATE monthly_plans
       SET status = 'Confirmed', confirmed_by = $2, confirmed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'Draft'`,
      [existing.id, req.user.id]
    );
    // Confirmed by somebody else between the read and the write: one record of
    // the allocation, not two.
    if (!confirmed.rowCount) {
      await safeRollback(client);
      return res.status(409).json({ message: 'This plan has already been confirmed.' });
    }
    await logPlanHistory(client, existing.id, req.user, [
      {
        action: 'Plan confirmed', field: 'approvedBudget', oldValue: null, newValue: allocation,
        // Spelled out in the trail so nobody reading it later mistakes this row
        // for a payment the system made.
        note: `Approved allocation recorded, ${formatUsd(committed)} of it committed to planned activities. The funds are handed to the manager outside the platform.`
      }
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }

  res.json(mapPlan(await loadPlan(existing.id, req.user)));
}));

// Reopening a confirmed month, so a plan that was confirmed too early can be
// corrected rather than worked around.
router.post('/:id/reopen', asyncRoute(async (req, res) => {
  requireAdmin(req.user, 'reopen a monthly plan');
  const existing = await loadPlan(req.params.id, req.user);
  if (existing.status === 'Draft') {
    return res.status(400).json({ message: 'This plan is already a draft.' });
  }
  if (!requiredText(req.body?.reason)) {
    return res.status(400).json({ message: 'Say why the month is being reopened.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // A confirmed plan reopens to Draft; a closed one reopens to Confirmed, so
    // reopening never quietly discards the allocation that was handed over.
    const reopened = existing.status === 'Closed'
      ? await client.query(
        `UPDATE monthly_plans SET status = 'Confirmed', closed_by = NULL, closed_at = NULL, updated_at = NOW()
         WHERE id = $1 AND status = 'Closed'`,
        [existing.id]
      )
      : await client.query(
        `UPDATE monthly_plans SET status = 'Draft', confirmed_by = NULL, confirmed_at = NULL, updated_at = NOW()
         WHERE id = $1 AND status = 'Confirmed'`,
        [existing.id]
      );
    if (!reopened.rowCount) {
      await safeRollback(client);
      return res.status(409).json({ message: 'This plan changed a moment ago. Refresh and try again.' });
    }
    // The report that closed the month is handed back with the reason, so the
    // manager can file a corrected one and the Director can close the month
    // again. Left Accepted, neither of them had any way to close it a second time.
    if (existing.status === 'Closed') {
      await client.query(
        `UPDATE monthly_reports SET status = 'Returned', review_note = $2, reviewed_by = $3, reviewed_at = NOW()
         WHERE plan_id = $1`,
        [existing.id, optionalText(req.body.reason, 2000), req.user.id]
      );
    }
    await logPlanHistory(client, existing.id, req.user, [
      {
        action: 'Plan reopened', field: 'status',
        oldValue: existing.status, newValue: existing.status === 'Closed' ? 'Confirmed' : 'Draft',
        note: optionalText(req.body.reason, 1000)
      }
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }

  res.json(mapPlan(await loadPlan(existing.id, req.user)));
}));

// ---- the planned activities ------------------------------------------------

// Section 1: the Director creates the month's activities. A planned activity is
// a row in the existing activities table carrying this plan's id, assigned to
// the plan's manager and approved from the outset -- the Director set it, so
// there is nobody left to approve it.
router.post('/:id/activities', asyncRoute(async (req, res) => {
  requireAdmin(req.user, 'add an activity to a monthly plan');
  const plan = await loadPlan(req.params.id, req.user);
  if (!isPlanOpen(plan)) {
    return res.status(400).json({ message: 'This month has been closed. Reopen it before adding activities.' });
  }

  const payload = req.body || {};
  if (!requiredText(payload.activity)) return res.status(400).json({ message: 'The activity name is required.' });
  if (!requiredText(payload.category)) return res.status(400).json({ message: 'A category is required.' });
  // What the work is for. The manager assigns the days that will deliver this
  // and the person doing them reads it, so a planned activity that is only a
  // title leaves both of them guessing.
  if (!requiredText(payload.description)) {
    return res.status(400).json({ message: 'Describe what this activity involves. The manager and the person doing the work both work from it.' });
  }
  if (!validNumber(payload.approvedBudget)) {
    return res.status(400).json({ message: 'The approved budget must be a valid non-negative number.' });
  }
  const priority = payload.priority || 'Medium';
  if (!PLAN_PRIORITIES.includes(priority)) {
    return res.status(400).json({ message: 'Priority must be Low, Medium or High.' });
  }
  const deadline = payload.deadline ? String(payload.deadline).slice(0, 10) : null;
  if (deadline && !isValidDate(deadline)) {
    return res.status(400).json({ message: 'The expected completion date must be a real date.' });
  }
  if (!plan.manager_id) {
    return res.status(400).json({ message: 'Name the manager responsible before adding activities.' });
  }

  // Activities belong to a project, as they always have. The operation's
  // project is used unless the Director names one.
  const projectResult = await pool.query(
    'SELECT id FROM projects WHERE id = $1 OR sector = $2 ORDER BY (id = $1) DESC, updated_at DESC LIMIT 1',
    [payload.projectId || '', plan.sector]
  );
  if (!projectResult.rowCount) {
    return res.status(400).json({ message: 'No project exists for this business operation. Add one first.' });
  }

  const budget = round2(payload.approvedBudget);
  const id = `ACT-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  // The local equivalents are priced at the Director's current reference rate,
  // the same one the Movements module uses, rather than a figure fixed in code.
  const rate = await getCurrentRate(pool);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The month's ceiling, read under a lock. Work used to be added freely and
    // the allocation raised to cover it, so the approved budget followed the
    // activities around instead of constraining them.
    const position = await planPosition(client, plan.id);
    if (!fitsBudget(budget, position.approved, position.committed)) {
      await safeRollback(client);
      return res.status(400).json({
        message: overMonthlyBudgetMessage(position.uncommitted),
        code: 'OVER_MONTHLY_BUDGET',
        remaining: position.uncommitted
      });
    }
    await client.query(
      `INSERT INTO activities
         (id, project_id, sector, category, activity, description, quantity,
          cost_usd, cost_rwf, cost_cdf, requested_budget, approved_budget,
          status, approved, priority, monthly_plan_id, deadline, admin_note, instructions,
          created_by, created_by_name, origin, assigned_to, assigned_at,
          approval_required, approval_status, approved_by, approved_at, reviewed_by, reviewed_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, 1,
          $7, $8, $9, $7, $7,
          'Approved', TRUE, $10, $11, $12::date, $13, $13,
          $14, $15, 'assigned', $16, NOW(),
          FALSE, 'approved', $14, NOW(), $14, NOW())`,
      [
        id, projectResult.rows[0].id, plan.sector, payload.category.trim().slice(0, 100),
        payload.activity.trim().slice(0, 200), optionalText(payload.description, 4000),
        budget, round2(budget * rate.rwfPerUsd), round2(budget * rate.cdfPerUsd),
        priority, plan.id, deadline, optionalText(payload.adminNote, 2000),
        req.user.id, req.user.name, plan.manager_id
      ]
    );
    await client.query(
      `INSERT INTO activity_history (activity_id, action, field, old_value, new_value, note, actor_id, actor_name)
       VALUES ($1, 'Added to monthly plan', 'approvedBudget', NULL, $2, $3, $4, $5)`,
      [id, String(budget), `${plan.sector} ${monthKey(plan.month)}`, req.user.id, req.user.name]
    );
    await logPlanHistory(client, plan.id, req.user, [
      { action: 'Activity added', field: 'activity', oldValue: null, newValue: payload.activity.trim().slice(0, 200), note: `${budget}` }
    ]);
    // No allocation change here. Work added to a confirmed month used to raise
    // the approved budget to cover itself, which meant the Director's figure was
    // whatever had been added and a month could never be over it. The activity
    // now has to fit inside the budget instead, and the Director raises it
    // deliberately through PATCH if they want more room.
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }

  res.status(201).json(mapPlan(await loadPlan(plan.id, req.user)));
}));

// ---- the day-by-day work underneath a planned activity ---------------------
//
// This is the manager's way in, and deliberately their ONLY way in to the
// month's money. The Director sets the planned activities and the budget; the
// manager breaks each planned activity into the days of work that will finish
// it -- what is being done, which day, who is doing it, what it costs -- and the
// days add up to the planned activity, which adds up to the month.
//
// Why it is not `POST /api/activities`: that route creates work in an operation,
// which is how a manager ended up running a month's worth of activities with no
// relation to the plan at all. Work created here cannot exist without a planned
// activity to belong to, and cannot cost more than that activity has left.
//
// Nothing here needs approving. The Director approved the money when they
// approved the plan, and approved the work when they wrote the planned activity;
// asking them to approve each day of it again would put the month in a queue.
router.post('/:id/activities/:activityId/work', asyncRoute(async (req, res) => {
  const plan = await loadPlan(req.params.id, req.user);
  if (!canReadPlan(req.user, plan)) {
    return res.status(403).json({ message: 'This plan belongs to another business operation.' });
  }
  // The manager the plan names, or the Director. Another manager in the same
  // operation can read the month but does not staff it.
  if (!isAdmin(req.user) && !isPlanManager(req.user, plan)) {
    return res.status(403).json({ message: 'Only the manager this month was given to can assign its work.' });
  }
  if (!isPlanOpen(plan)) {
    return res.status(400).json({ message: 'This month has been closed. Reopen it before assigning more work.' });
  }
  // A draft plan is the Director still writing it. Work assigned against a
  // budget that has not been approved yet cannot be spent against anyway -- the
  // status route already refuses to start it -- so it is refused here, where the
  // manager can still be told why.
  if (plan.status === 'Draft') {
    return res.status(409).json({ message: 'This month has not been confirmed yet. The Director confirms the plan and its budget before the work is assigned.' });
  }

  const payload = req.body || {};
  if (!requiredText(payload.activity)) {
    return res.status(400).json({ message: 'Say what this day of work is.' });
  }
  // Required, not optional. The person it is assigned to opens this on their
  // phone and has nothing else to go on.
  if (!requiredText(payload.description)) {
    return res.status(400).json({ message: 'Describe the work. The person doing it reads this and nothing else.' });
  }
  // The day it is happening. This is the whole point of the level: a planned
  // activity has a deadline, and the days underneath it are when the work is
  // actually done.
  const scheduledFor = payload.scheduledFor ? String(payload.scheduledFor).slice(0, 10) : null;
  if (!scheduledFor) {
    return res.status(400).json({ message: 'Give the day this work is being done.' });
  }
  if (!isValidDate(scheduledFor)) {
    return res.status(400).json({ message: 'The day of the work must be a real date.' });
  }
  // Work towards September's plan happens in September. A day outside the month
  // would be counted in a month whose budget it is not spending.
  if (monthKey(scheduledFor) !== monthKey(plan.month)) {
    return res.status(400).json({ message: `That day is outside this month. Choose a day in ${monthKey(plan.month)}.` });
  }
  if (!validNumber(payload.budget ?? 0)) {
    return res.status(400).json({ message: 'The budget for this work must be a valid non-negative number.' });
  }
  const budget = round2(payload.budget ?? 0);
  const priority = payload.priority || 'Medium';
  if (!PLAN_PRIORITIES.includes(priority)) {
    return res.status(400).json({ message: 'Priority must be Low, Medium or High.' });
  }
  // Whether finishing it needs something to show for it. Evidence is demanded by
  // default; a meeting or a supervision visit sometimes has nothing to
  // photograph, and the rule had no way of saying so.
  const evidenceRequired = payload.evidenceRequired !== false;

  // Who is doing it. A team member or a manager, in this operation -- the
  // assignee is the one who starts it, records its spending and attaches its
  // evidence, so they have to be able to open it. Left unsaid, the manager
  // running the month is doing it themselves.
  let assignedTo = plan.manager_id;
  if (requiredText(String(payload.assignedTo ?? ''))) {
    assignedTo = parseId(payload.assignedTo);
    if (!assignedTo) return res.status(400).json({ message: 'The selected person is invalid.' });
    const person = await pool.query(
      `SELECT id, name, sector, role, covers_all_sectors AS "coversAllSectors"
       FROM users WHERE id = $1 AND status = 'active' AND role IN ('manager', 'staff')`,
      [assignedTo]
    );
    if (!person.rowCount) return res.status(400).json({ message: 'The selected person is invalid.' });
    if (!withinScope(person.rows[0], plan.sector)) {
      return res.status(400).json({ message: 'That person works in a different business operation.' });
    }
  }
  if (!assignedTo) {
    return res.status(400).json({ message: 'Say who is doing this work.' });
  }

  const id = `ACT-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const rate = await getCurrentRate(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The planned activity this belongs to, and what is left of its budget. Read
    // under a row lock so two days of work assigned at once cannot both fit into
    // the same remaining amount.
    const parent = await plannedActivityPosition(client, req.params.activityId);
    if (Number(parent.row.monthly_plan_id) !== Number(plan.id)) {
      await safeRollback(client);
      return res.status(404).json({ message: 'That planned activity is not part of this month.' });
    }
    if (parent.row.parent_activity_id) {
      await safeRollback(client);
      return res.status(400).json({ message: 'That is already a day of work. Add the day under the planned activity itself.' });
    }
    if (['Rejected', 'Cancelled'].includes(parent.row.status)) {
      await safeRollback(client);
      return res.status(400).json({ message: `A ${parent.row.status} activity takes no more work.` });
    }
    // The planned activity's own ceiling. The month's ceiling is not re-checked
    // here: this budget is already inside the planned activity's, which was
    // checked against the month when the Director added it.
    if (!fitsBudget(budget, parent.approved, parent.committed)) {
      await safeRollback(client);
      return res.status(400).json({
        message: overActivityBudgetMessage(parent.uncommitted),
        code: 'OVER_ACTIVITY_BUDGET',
        remaining: parent.uncommitted
      });
    }

    // Inherits the planned activity's project and category, so a day of work is
    // never filed under a different heading from the activity it serves.
    await client.query(
      `INSERT INTO activities
         (id, project_id, sector, category, activity, description, quantity,
          cost_usd, cost_rwf, cost_cdf, requested_budget, approved_budget,
          status, approved, priority, monthly_plan_id, parent_activity_id,
          scheduled_for, deadline, instructions, evidence_required,
          created_by, created_by_name, origin, assigned_to, assigned_at,
          approval_required, approval_status, approved_by, approved_at, reviewed_by, reviewed_at)
       SELECT $1, parent.project_id, $2, parent.category, $3, $4, 1,
              $5, $6, $7, $5, $5,
              'Approved', TRUE, $8, $9, parent.id,
              $10::date, COALESCE($10::date, parent.deadline), $11, $12,
              $13, $14, 'assigned', $15, NOW(),
              FALSE, 'approved', $13, NOW(), $13, NOW()
       FROM activities parent WHERE parent.id = $16`,
      [
        id, plan.sector, payload.activity.trim().slice(0, 200), optionalText(payload.description, 4000),
        budget, round2(budget * rate.rwfPerUsd), round2(budget * rate.cdfPerUsd),
        priority, plan.id, scheduledFor, optionalText(payload.notes, 4000), evidenceRequired,
        req.user.id, req.user.name, assignedTo, parent.row.id
      ]
    );
    await client.query(
      `INSERT INTO activity_history (activity_id, action, field, old_value, new_value, note, actor_id, actor_name)
       VALUES ($1, 'Work assigned', 'scheduledFor', NULL, $2, $3, $4, $5)`,
      [id, scheduledFor, `Towards: ${parent.row.activity}`, req.user.id, req.user.name]
    );
    // The planned activity is under way the moment its first day is assigned, so
    // the Director's screen shows the month moving rather than a list of
    // approved activities that all look untouched.
    if (['Approved', 'Budget Adjusted'].includes(parent.row.status)) {
      await client.query(
        "UPDATE activities SET status = 'In Progress', updated_at = NOW() WHERE id = $1 AND status = $2",
        [parent.row.id, parent.row.status]
      );
      await client.query(
        `INSERT INTO activity_history (activity_id, action, field, old_value, new_value, note, actor_id, actor_name)
         VALUES ($1, 'Status changed', 'status', $2, 'In Progress', $3, $4, $5)`,
        [parent.row.id, parent.row.status, 'The first day of work was assigned', req.user.id, req.user.name]
      );
    }
    await logPlanHistory(client, plan.id, req.user, [{
      action: 'Work assigned', field: 'activity', oldValue: null,
      newValue: payload.activity.trim().slice(0, 200),
      note: `${scheduledFor} · ${parent.row.activity} · ${formatUsd(budget)}`
    }]);
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }

  res.status(201).json({ id, ...(await planDetail(plan.id, req.user)) });
}));

// Section 4: an activity a manager raised is NOT automatically part of the
// month's budget. Once the Director has approved it, they may attach it here --
// deliberately, which is what adds its budget to the plan.
router.post('/:id/attach/:activityId', asyncRoute(async (req, res) => {
  requireAdmin(req.user, 'attach an activity to a monthly plan');
  const plan = await loadPlan(req.params.id, req.user);
  if (!isPlanOpen(plan)) {
    return res.status(400).json({ message: 'This month has been closed.' });
  }

  const client = await pool.connect();
  let activity;
  let budget;
  try {
    await client.query('BEGIN');
    // Read under a row lock, so two attaches of the same activity at once cannot
    // both find it unattached and add its budget to two plans.
    const found = await client.query(
      `SELECT id, activity, sector, status, approval_status, approved_budget, requested_budget,
              monthly_plan_id, parent_activity_id
       FROM activities WHERE id = $1 FOR UPDATE`,
      [req.params.activityId]
    );
    if (!found.rowCount) {
      await safeRollback(client);
      return res.status(404).json({ message: 'Activity not found.' });
    }
    activity = found.rows[0];
    let refusal = null;
    if (activity.monthly_plan_id) refusal = [409, 'That activity already belongs to a monthly plan.'];
    else if (activity.parent_activity_id) refusal = [400, 'That is a day of work under another activity, not an activity of its own.'];
    else if (activity.sector !== plan.sector) refusal = [400, 'That activity belongs to a different business operation.'];
    // Only approved, live work joins an approved budget.
    else if (activity.approval_status !== 'approved' || ['Rejected', 'Cancelled'].includes(activity.status)) {
      refusal = [400, 'Approve the activity before attaching it to a monthly plan.'];
    }
    if (refusal) {
      await safeRollback(client);
      return res.status(refusal[0]).json({ message: refusal[1] });
    }

    // An activity approved without an explicit figure was approved at what it
    // asked for; that figure is written down as it joins the plan, so the plan,
    // the spend check and the reports all read the same number.
    budget = round2(Number(activity.approved_budget ?? activity.requested_budget ?? 0));
    // Folding off-plan work into the month spends the month's budget on it, so
    // it is held to the same ceiling as work planned from the start. This used to
    // raise the allocation to cover whatever was attached.
    const position = await planPosition(client, plan.id);
    if (!fitsBudget(budget, position.approved, position.committed)) {
      await safeRollback(client);
      return res.status(400).json({
        message: overMonthlyBudgetMessage(position.uncommitted),
        code: 'OVER_MONTHLY_BUDGET',
        remaining: position.uncommitted
      });
    }
    await client.query(
      `UPDATE activities SET monthly_plan_id = $2, assigned_to = COALESCE(assigned_to, $3),
         approved_budget = COALESCE(approved_budget, $4), updated_at = NOW() WHERE id = $1`,
      [activity.id, plan.id, plan.manager_id, budget]
    );
    await client.query(
      `INSERT INTO activity_history (activity_id, action, field, old_value, new_value, note, actor_id, actor_name)
       VALUES ($1, 'Attached to monthly plan', 'monthlyPlanId', NULL, $2, $3, $4, $5)`,
      [activity.id, String(plan.id), optionalText(req.body?.reason, 1000), req.user.id, req.user.name]
    );
    await logPlanHistory(client, plan.id, req.user, [
      {
        action: 'Off-plan activity attached', field: 'committedBudget',
        oldValue: position.committed, newValue: round2(position.committed + budget),
        note: `${activity.activity}${req.body?.reason ? ` — ${optionalText(req.body.reason, 500)}` : ''}`
      }
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }

  res.json(mapPlan(await loadPlan(plan.id, req.user)));
}));

// ---- the month-end report --------------------------------------------------

// Section 11: the manager's account of the month. The figures are taken from
// the plan at the moment of submission rather than typed, so the report cannot
// disagree with the records it summarises.
router.post('/:id/report', asyncRoute(async (req, res) => {
  const plan = await loadPlan(req.params.id, req.user);
  if (!canReadPlan(req.user, plan)) {
    return res.status(403).json({ message: 'This plan belongs to another business operation.' });
  }
  // The manager the plan names writes the report; the Director may file one on
  // their behalf. Another manager in the same operation may not.
  if (!isAdmin(req.user) && Number(plan.manager_id) !== Number(req.user.id)) {
    return res.status(403).json({ message: 'Only the manager this plan names can submit its report.' });
  }
  if (plan.status === 'Draft') {
    return res.status(400).json({ message: 'This plan has not been confirmed yet.' });
  }
  // A closed month's accepted report is the signed-off account. Submitting again
  // used to overwrite it and mark it Submitted under a plan that stayed Closed.
  if (plan.status === 'Closed' || plan.report_status === 'Accepted') {
    return res.status(409).json({ message: 'This month has been closed. Ask the Director to reopen it first.' });
  }

  const payload = req.body || {};
  const approvedBudget = round2(Number(plan.approved_budget || 0));
  const totalSpent = round2(Number(plan.total_spent || 0));
  const remaining = fromCents(cents(approvedBudget) - cents(totalSpent));

  // An unspent balance and an overspend both need explaining; a month that came
  // out exactly on budget does not.
  // Either box counts. The form offers one for the unused balance and one for
  // budget differences, and an overspend explained in the second -- the natural
  // place for it -- used to be refused.
  if (remaining !== 0 && !requiredText(payload.unusedBalanceExplanation) && !requiredText(payload.budgetDifferenceExplanation)) {
    return res.status(400).json({
      message: remaining > 0
        ? 'Explain what happened to the unused balance.'
        : 'Explain why spending went past the approved budget.'
    });
  }

  const evidence = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE ev.evidence_type = 'activity')::int AS activity_evidence,
       COUNT(*) FILTER (WHERE ev.evidence_type = 'payment')::int AS payment_evidence
     FROM activity_evidence ev
     JOIN activities a ON a.id = ev.activity_id
     WHERE a.monthly_plan_id = $1`,
    [plan.id]
  );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO monthly_reports
         (plan_id, approved_budget, total_spent, remaining_balance, completed_activities,
          incomplete_activities, activity_evidence_count, payment_evidence_count,
          unused_balance_explanation, budget_difference_explanation, status, submitted_by, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'Submitted', $11, NOW())
       ON CONFLICT (plan_id) DO UPDATE SET
         approved_budget = EXCLUDED.approved_budget,
         total_spent = EXCLUDED.total_spent,
         remaining_balance = EXCLUDED.remaining_balance,
         completed_activities = EXCLUDED.completed_activities,
         incomplete_activities = EXCLUDED.incomplete_activities,
         activity_evidence_count = EXCLUDED.activity_evidence_count,
         payment_evidence_count = EXCLUDED.payment_evidence_count,
         unused_balance_explanation = EXCLUDED.unused_balance_explanation,
         budget_difference_explanation = EXCLUDED.budget_difference_explanation,
         status = 'Submitted',
         review_note = '',
         submitted_by = EXCLUDED.submitted_by,
         submitted_at = NOW(),
         reviewed_by = NULL,
         reviewed_at = NULL`,
      [
        plan.id, approvedBudget, totalSpent, remaining,
        Number(plan.completed_count || 0), Number(plan.outstanding_count || 0),
        evidence.rows[0].activity_evidence, evidence.rows[0].payment_evidence,
        optionalText(payload.unusedBalanceExplanation, 4000),
        optionalText(payload.budgetDifferenceExplanation, 4000),
        req.user.id
      ]
    );
    await logPlanHistory(client, plan.id, req.user, [
      { action: 'Month-end report submitted', field: 'totalSpent', oldValue: approvedBudget, newValue: totalSpent }
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }

  const saved = await pool.query(
    `SELECT r.*, s.name AS submitted_by_name, v.name AS reviewed_by_name
     FROM monthly_reports r
     LEFT JOIN users s ON s.id = r.submitted_by
     LEFT JOIN users v ON v.id = r.reviewed_by
     WHERE r.plan_id = $1`,
    [plan.id]
  );
  res.status(201).json(mapReport(saved.rows[0]));
}));

// The Director accepts the report and closes the month, or sends it back.
router.patch('/:id/report', asyncRoute(async (req, res) => {
  requireAdmin(req.user, 'review a month-end report');
  const plan = await loadPlan(req.params.id, req.user);

  const status = req.body?.status;
  if (!REPORT_STATUSES.includes(status) || status === 'Submitted') {
    return res.status(400).json({ message: 'The decision must be Accepted or Returned.' });
  }
  const note = optionalText(req.body?.reviewNote, 2000);
  if (status === 'Returned' && !note) {
    return res.status(400).json({ message: 'Say what the manager needs to correct.' });
  }

  const existing = await pool.query('SELECT id FROM monthly_reports WHERE plan_id = $1', [plan.id]);
  if (!existing.rowCount) return res.status(404).json({ message: 'No month-end report has been submitted yet.' });
  if (plan.status === 'Closed') {
    return res.status(409).json({ message: 'This month has already been closed.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Only a report waiting for review is decided: a returned one waits for the
    // manager to file it again, and an accepted one already closed the month.
    const reviewed = await client.query(
      `UPDATE monthly_reports SET status = $2, review_note = $3, reviewed_by = $4, reviewed_at = NOW()
       WHERE plan_id = $1 AND status = 'Submitted'`,
      [plan.id, status, note, req.user.id]
    );
    if (!reviewed.rowCount) {
      await safeRollback(client);
      return res.status(409).json({ message: 'This report is not waiting for review.' });
    }
    // Accepting the report closes the month: the plan becomes a historical
    // record and stops accepting expenses or edits.
    if (status === 'Accepted') {
      await client.query(
        `UPDATE monthly_plans SET status = 'Closed', closed_by = $2, closed_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [plan.id, req.user.id]
      );
    }
    await logPlanHistory(client, plan.id, req.user, [
      { action: status === 'Accepted' ? 'Month closed' : 'Report returned', field: 'status', oldValue: plan.status, newValue: status === 'Accepted' ? 'Closed' : plan.status, note }
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }

  res.json(mapPlan(await loadPlan(plan.id, req.user)));
}));

// Anything else goes on to the application's error handler, which turns bad
// input the database refused into a 400 rather than a bare server error.
router.use((error, req, res, next) => {
  if (error instanceof PlanError) return res.status(error.status).json({ message: error.message });
  next(error);
});

export default router;
