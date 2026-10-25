// Period reporting over the activity register.
//
// Everything here is read from the tables the rest of the API already writes --
// activities, projects, users, activity_expenses, activity_evidence,
// activity_budget_requests and activity_history. A report stores nothing and
// creates no table of its own; it is only ever a reading of the register at a
// moment in time.
//
// The three budget figures are kept apart at every stage, because collapsing
// them is exactly what loses the history the Director needs:
//   original -- activities.requested_budget: what was asked for, or what the
//               Director set when assigning. Never overwritten by a decision.
//   revised  -- activities.approved_budget: the decided figure. NULL means "not
//               decided yet", which is not the same as a decided zero.
//   spent    -- activity_expenses: what was actually recorded as spent.

import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { pool } from '../db/database.js';
import { sectors } from '../data/seedData.js';
import { asyncRoute, hasFullScope, isAdmin, isGeneralManager, managerScope, operationsOf, projectScope, sectorIds, withinScope } from '../lib/http.js';
import { getCurrentRate, round2 } from '../lib/rates.js';
// Progress and the month's budget are read through the monthly module's own
// definitions rather than worked out again here: objectiveProgress and
// planProgress are what the plan screen, /review and the month-end report use,
// and a report that recomputes them is a report that can disagree with the plan
// it reports on.
import { monthStart, objectiveProgress, planProgress } from '../lib/monthly.js';
// The words of the report, in the reader's language. The dictionary is in
// shared/ for this reason: an exported PDF or spreadsheet is the one copy of a
// report that is printed and carried, and it was the only part of the system
// that could not be read in Kinyarwanda, French or Kiswahili.
import { fill, knownLanguage, translate } from '../../shared/strings.js';
import { operationName } from '../../shared/businessOperations.js';
import { DAY_COLUMNS } from '../../shared/dailyReport.js';
import { readableNote } from '../../shared/workbookNote.js';

const router = express.Router();

// Where the company mark lives, resolved once.
//
// `public/` is the source tree; `dist/` is what a built deployment serves, and
// Vite copies public/ into it. Both are checked so the logo appears on a report
// whether the API is running from a checkout or from a build. Resolved relative
// to this file rather than process.cwd(), which is whatever directory the
// process happened to be started from.
//
// null when neither exists -- the report then prints exactly as it did before,
// which is the right failure for a decoration.
const LOGO_CANDIDATES = ['../../public/logo-mark.png', '../../dist/logo-mark.png'];
let resolvedLogo;
function logoPath() {
  if (resolvedLogo !== undefined) return resolvedLogo;
  resolvedLogo = null;
  for (const candidate of LOGO_CANDIDATES) {
    const file = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(file)) { resolvedLogo = file; break; }
  }
  // Serverless: the function is unpacked at a task root that is not this file's
  // repository, so the relative walk above can miss even though the file was
  // bundled. Tried from the working directory as well before giving up.
  //
  // The file only reaches the bundle at all because vercel.json lists it in
  // `includeFiles` -- the path above is built with new URL() at runtime, which
  // Vercel's file tracing cannot follow, so without that entry the logo is
  // simply absent from the deployment and every printed report loses its mark.
  if (!resolvedLogo) {
    for (const candidate of ['public/logo-mark.png', 'dist/logo-mark.png']) {
      const file = resolve(process.cwd(), candidate);
      if (existsSync(file)) { resolvedLogo = file; break; }
    }
  }
  return resolvedLogo;
}

const SECTOR_NAMES = new Map(sectors.map((sector) => [sector.id, sector.name]));

// What a file is a report ON: the one operation, every operation the reader
// covers when that is several, or all of them.
function scopeHeading(scope, operation, t) {
  if (scope.sector) return operation(scope.sector);
  if (scope.sectors?.length) return scope.sectors.map(operation).join(' · ');
  return t('report.allOperations');
}

export function sectorName(id) {
  return SECTOR_NAMES.get(id) || id || 'Unassigned area';
}

// The register carries ten statuses; a report reads in four buckets. "Overdue"
// is deliberately not one of them -- it cuts across the others, so a late
// activity is counted both in its own bucket and as overdue.
const COMPLETED_STATUSES = ['Completed'];
const IN_PROGRESS_STATUSES = ['In Progress'];
const CANCELLED_STATUSES = ['Rejected', 'Cancelled'];
// Everything still waiting on somebody: not finished, not running, not refused.
const PENDING_STATUSES = [
  'Draft', 'Pending Approval', 'Approved', 'Budget Adjusted', 'Needs Correction', 'On Hold'
];
// A deadline only matters while the work can still be done.
const CLOSED_STATUSES = [...COMPLETED_STATUSES, ...CANCELLED_STATUSES];

export class ReportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---- period resolution ----------------------------------------------------

// Reports deal in calendar days, never instants. Everything below moves whole
// days around as YYYY-MM-DD strings so a period never drifts by a timezone.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function toDateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

function parseDay(value, label) {
  if (!DATE_ONLY.test(String(value || ''))) {
    throw new ReportError(400, `${label} must be a date in YYYY-MM-DD form.`);
  }
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new ReportError(400, `${label} is not a real date.`);
  }
  return date;
}

function addDays(date, days) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function readableDay(value) {
  const [year, month, day] = String(value).split('-').map(Number);
  return `${day} ${MONTH_NAMES[month - 1]} ${year}`;
}

// A week runs Monday to Sunday. The caller sends any day inside the week they
// want -- a date picker gives a day, not a week -- and it is widened to the
// whole week, so the same report comes back whichever day of it was picked.
function resolveWeek(anchor) {
  const day = anchor ? parseDay(anchor, 'The week') : new Date();
  // getDay() is 0 for Sunday, which belongs to the week that began six days
  // earlier rather than starting a new one.
  const offset = (day.getDay() + 6) % 7;
  const start = addDays(day, -offset);
  return {
    kind: 'weekly',
    start: toDateOnly(start),
    end: toDateOnly(addDays(start, 6)),
    label: `Week of ${readableDay(toDateOnly(start))}`
  };
}

function resolveMonth(month) {
  const value = month || toDateOnly(new Date()).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(value)) {
    throw new ReportError(400, 'The month must be in YYYY-MM form.');
  }
  const [year, monthNumber] = value.split('-').map(Number);
  if (monthNumber < 1 || monthNumber > 12) throw new ReportError(400, 'The month is not a real month.');
  // Day 0 of the next month is the last day of this one, which handles
  // February and leap years without a table of month lengths.
  const start = new Date(year, monthNumber - 1, 1);
  const end = new Date(year, monthNumber, 0);
  return {
    kind: 'monthly',
    start: toDateOnly(start),
    end: toDateOnly(end),
    label: `${MONTH_NAMES[monthNumber - 1]} ${year}`
  };
}

function resolveCustom(start, end) {
  const from = parseDay(start, 'The start date');
  const to = parseDay(end, 'The end date');
  if (to < from) throw new ReportError(400, 'The end date cannot fall before the start date.');
  return {
    kind: 'custom',
    start: toDateOnly(from),
    end: toDateOnly(to),
    label: `${readableDay(toDateOnly(from))} to ${readableDay(toDateOnly(to))}`
  };
}

export function resolvePeriod(query = {}) {
  const kind = String(query.period || 'weekly').toLowerCase();
  if (kind === 'monthly') return resolveMonth(query.month);
  if (kind === 'custom') return resolveCustom(query.start, query.end);
  if (kind === 'weekly') return resolveWeek(query.start);
  throw new ReportError(400, 'The period must be weekly, monthly or custom.');
}

// WHICH SLICE OF THE REGISTER THE REPORT COVERS.
//
// The period used to be the only question a report could ask, so the Director
// could read all four operations together and nothing else: "how did Mining do
// in August" meant exporting everything and deleting rows in Excel. An
// operation and a project narrow it. Both are optional, and leaving them out
// gives exactly the report that was produced before.
//
// Validated here rather than simply ANDed onto the query, because a manager who
// asked for somebody else's operation would otherwise get an empty report --
// which reads as a quiet month rather than as a refusal, and that is the kind
// of silence somebody eventually makes a decision on.
export async function resolveFilters(user, query = {}) {
  const wanted = String(query.operation || '').trim();
  const wantedProject = String(query.project || '').trim();
  const choice = { operation: null, operationName: null, projectId: null, projectName: null };

  if (wanted && wanted !== 'All') {
    if (!sectorIds.has(wanted)) throw new ReportError(400, 'That project does not exist.');
    if (!withinScope(user, wanted)) {
      throw new ReportError(403, 'That project is not yours to report on.');
    }
    choice.operation = wanted;
    choice.operationName = sectorName(wanted);
  }

  if (wantedProject && wantedProject !== 'All') {
    const found = await pool.query('SELECT id, name, sector FROM projects WHERE id = $1', [wantedProject]);
    if (!found.rowCount) throw new ReportError(400, 'That project does not exist.');
    const project = found.rows[0];
    // Authorised against the operation the project is in NOW, not the one the
    // caller named, exactly as everywhere else that takes an id from a query.
    if (!withinScope(user, project.sector)) {
      throw new ReportError(403, 'That project is not yours to report on.');
    }
    if (choice.operation && project.sector !== choice.operation) {
      throw new ReportError(400, 'That project does not match the one chosen.');
    }
    choice.projectId = project.id;
    choice.projectName = project.name;
    // A project names its own operation, so a report asked for by project alone
    // still says which operation it covers.
    choice.operation = project.sector;
    choice.operationName = sectorName(project.sector);
  }

  return choice;
}

// The filters as SQL, appended to whatever scoping the caller has already
// applied. They narrow; they never widen -- managerScope and projectScope have
// already been pushed, so a manager cannot reach past their own area by asking.
function applyChoice(choice, columns, values, filters) {
  if (choice?.operation && columns.sector) {
    values.push(choice.operation);
    filters.push(`${columns.sector} = $${values.length}`);
  }
  if (choice?.projectId && columns.project) {
    values.push(choice.projectId);
    filters.push(`${columns.project} = $${values.length}`);
  }
}

// ---- gathering ------------------------------------------------------------

// An activity belongs to the period in which the work was put on somebody's
// desk: assigned_at when the Director handed it out, created_at when a manager
// raised it. Both are cast to a date before they are compared, so a record
// created late in the evening cannot slide into the next day's report.
const PERIOD_DAY = 'COALESCE(a.assigned_at::date, a.created_at::date)';

// WHY THERE ARE NO NAMES IN HERE.
//
// A report used to carry a name on every line -- who the work was assigned to,
// who raised it, who recorded the day, who asked for the budget change and who
// answered it -- and a whole "manager performance" table of its own. The people
// reading these reports already know who runs each operation, so every one of
// those names was a column of noise between the reader and the figures. The
// register still records all of it (every row has its own history screen); a
// report is about the work, not about who typed it.
const SELECT_ROWS = `
  SELECT a.id, a.activity, a.description, a.category, a.sector, a.status, a.origin,
         a.requested_budget, a.approved_budget, a.admin_note, a.quantity,
         a.deadline, a.assigned_at, a.accepted_at, a.completed_at,
         a.completion_submitted_at, a.created_at, a.assigned_to,
         a.project_id, p.name AS project_name,
         -- The very day the row is filtered and bucketed on, returned as a
         -- date so the report never shows one day while counting another.
         -- Deriving it again in JavaScript would read a TIMESTAMPTZ in the Node
         -- process's zone while the filter cast it in the database's.
         ${PERIOD_DAY} AS period_day,
         COALESCE(ex.spent, 0) AS actual_spending,
         COALESCE(ev.items, 0)::int AS evidence_count
  FROM activities a
  LEFT JOIN projects p ON p.id = a.project_id
  -- Spending is the expense ledger, the same figure the activity review and the
  -- monthly plan show. It used to be the optional amount typed on an evidence
  -- upload, which a multi-file upload wrote onto every file, so three receipts
  -- for one purchase reported three times the spend.
  LEFT JOIN LATERAL (
    SELECT SUM(x.amount) AS spent FROM activity_expenses x WHERE x.activity_id = a.id
  ) ex ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS items FROM activity_evidence e WHERE e.activity_id = a.id
  ) ev ON TRUE
`;

function bucketFor(status) {
  if (COMPLETED_STATUSES.includes(status)) return 'completed';
  if (IN_PROGRESS_STATUSES.includes(status)) return 'inProgress';
  if (CANCELLED_STATUSES.includes(status)) return 'cancelled';
  if (PENDING_STATUSES.includes(status)) return 'pending';
  // A status the register gained without this file being told about it still
  // has to land somewhere, and "waiting on somebody" is the safe reading.
  return 'pending';
}

function isOverdue(row, today) {
  const deadline = toDateOnly(row.deadline);
  return Boolean(deadline) && deadline < today && !CLOSED_STATUSES.includes(row.status);
}

export async function buildReport(user, period, choice = null) {
  const values = [period.start, period.end];
  const filters = [`${PERIOD_DAY} BETWEEN $1::date AND $2::date`];
  // A manager reads their own working area and nothing else, exactly as
  // everywhere else in this API. The Director passes no filter at all.
  managerScope(user, 'a.sector', values, filters);
  // A report covers what the reader is responsible for, which for a project
  // manager is their project.
  projectScope(user, 'a.project_id', values, filters, { assignedColumn: 'a.assigned_to' });
  // And then whatever the reader asked for on top of that.
  applyChoice(choice, { sector: 'a.sector', project: 'a.project_id' }, values, filters);

  const rows = (await pool.query(
    `${SELECT_ROWS} WHERE ${filters.join(' AND ')} ORDER BY ${PERIOD_DAY} DESC, a.id`,
    values
  )).rows;

  const ids = rows.map((row) => row.id);
  // Two separate trails, and both are wanted. The history says what the
  // Director actually changed the budget to and why; the requests say what a
  // manager asked for and how it was answered.
  const [revisions, requests] = ids.length
    ? await Promise.all([
      pool.query(
        `SELECT activity_id, old_value, new_value, note, actor_name, created_at
         FROM activity_history
         WHERE field = 'approvedBudget' AND activity_id = ANY($1::varchar[])
         ORDER BY created_at`,
        [ids]
      ),
      pool.query(
        `SELECT activity_id, current_budget, requested_amount, reason, status,
                decision_note, decided_at, created_at
         FROM activity_budget_requests
         WHERE activity_id = ANY($1::varchar[])
         ORDER BY created_at`,
        [ids]
      )
    ])
    : [{ rows: [] }, { rows: [] }];

  const revisionsFor = new Map();
  for (const row of revisions.rows) {
    if (!revisionsFor.has(row.activity_id)) revisionsFor.set(row.activity_id, []);
    revisionsFor.get(row.activity_id).push({
      from: row.old_value === null ? null : round2(row.old_value),
      to: row.new_value === null ? null : round2(row.new_value),
      note: row.note || '',
      changedAt: row.created_at
    });
  }

  const requestsFor = new Map();
  for (const row of requests.rows) {
    if (!requestsFor.has(row.activity_id)) requestsFor.set(row.activity_id, []);
    requestsFor.get(row.activity_id).push({
      currentBudget: round2(row.current_budget),
      requestedAmount: round2(row.requested_amount),
      reason: row.reason,
      status: row.status,
      decisionNote: row.decision_note || '',
      decidedAt: row.decided_at,
      createdAt: row.created_at
    });
  }

  const today = toDateOnly(new Date());
  const activities = rows.map((row) => {
    const original = round2(row.requested_budget);
    // NULL approved_budget means the Director has not decided yet. The report
    // shows that as "not revised" rather than inventing a zero, but the money
    // side has to total something, so the original stands in for the effective
    // budget until a decision replaces it.
    const revised = row.approved_budget === null ? null : round2(row.approved_budget);
    const effective = revised === null ? original : revised;
    const spent = round2(row.actual_spending);
    return {
      id: row.id,
      activity: row.activity,
      description: row.description || '',
      category: row.category,
      projectId: row.project_id,
      projectName: row.project_name || row.project_id,
      sector: row.sector,
      sectorName: sectorName(row.sector),
      // Whether anybody is carrying it, without saying who: work nobody has
      // been given is a real gap in a report, the name of the person who has it
      // is not (see the note on SELECT_ROWS).
      assigned: Boolean(row.assigned_to),
      origin: row.origin || 'requested',
      originalBudget: original,
      revisedBudget: revised,
      effectiveBudget: effective,
      actualSpending: spent,
      remainingBudget: round2(effective - spent),
      budgetAdjustment: revised === null ? null : round2(revised - original),
      status: row.status,
      bucket: bucketFor(row.status),
      overdue: isOverdue(row, today),
      dateAssigned: toDateOnly(row.period_day),
      deadline: toDateOnly(row.deadline),
      completionDate: toDateOnly(row.completed_at),
      completionSubmitted: toDateOnly(row.completion_submitted_at),
      evidenceCount: row.evidence_count,
      adminNote: row.admin_note || '',
      budgetRevisions: revisionsFor.get(row.id) || [],
      budgetRequests: requestsFor.get(row.id) || []
    };
  });

  const activitySummary = {
    total: activities.length,
    completed: activities.filter((item) => item.bucket === 'completed').length,
    inProgress: activities.filter((item) => item.bucket === 'inProgress').length,
    pending: activities.filter((item) => item.bucket === 'pending').length,
    cancelled: activities.filter((item) => item.bucket === 'cancelled').length,
    // Cuts across the buckets above rather than being one of them, so these
    // five numbers are not meant to add up to the total.
    overdue: activities.filter((item) => item.overdue).length
  };

  const sum = (list, pick) => round2(list.reduce((total, item) => total + pick(item), 0));
  const budgetSummary = {
    assigned: sum(activities, (item) => item.originalBudget),
    revised: sum(activities, (item) => item.effectiveBudget),
    spent: sum(activities, (item) => item.actualSpending),
    remaining: sum(activities, (item) => item.effectiveBudget - item.actualSpending),
    // How much of the released budget has actually been evidenced.
    utilisation: 0
  };
  budgetSummary.utilisation = budgetSummary.revised > 0
    ? Math.round((budgetSummary.spent / budgetSummary.revised) * 100)
    : 0;

  // Budgets are kept in USD, but the people reading a report work in Rwandan
  // and Congolese francs. The report carries today's reference rate and says
  // so, rather than leaving every reader to convert the figures themselves.
  const rate = await getCurrentRate(pool);

  return {
    period,
    rate: { rwfPerUsd: rate.rwfPerUsd, cdfPerUsd: rate.cdfPerUsd, recordedAt: rate.recordedAt || null },
    generatedAt: new Date().toISOString(),
    scope: {
      // isDirector stays a question about authority -- it drives what the report
      // header claims about who produced it. The sector labels below describe
      // coverage, so an all-operations manager reads as all working areas.
      isDirector: isAdmin(user),
      // What the report actually covers, which is the asked-for operation when
      // one was asked for and the reader's own coverage otherwise. The header,
      // the spreadsheet and the PDF all read this one field, so a file for
      // Mining alone cannot be headed "All operations" -- which is the whole
      // point of being able to ask for one operation.
      sector: choice?.operation ?? (hasFullScope(user) || operationsOf(user).length !== 1 ? null : operationsOf(user)[0]),
      // A manager running several operations is covered by all of them, not by
      // the first: `sector` stays null (one heading cannot name two) and this
      // list is what the heading reads instead of "All operations".
      sectors: choice?.operation ? [choice.operation] : (hasFullScope(user) ? [] : operationsOf(user)),
      sectorName: choice?.operationName
        ?? (hasFullScope(user) ? 'All operations' : operationsOf(user).map(sectorName).join(', ')),
      projectId: choice?.projectId ?? null,
      projectName: choice?.projectName ?? null,
      // Whether the reader narrowed it themselves, so the screen can say "all
      // operations" without claiming the reader chose that.
      filtered: Boolean(choice?.operation || choice?.projectId),
      viewer: user.name
    },
    activitySummary,
    budgetSummary,
    activities,
    // THE BODY OF THE REPORT, and the reason the order of this object matters:
    // the month's objectives and the days recorded against them come first
    // everywhere a report is rendered, and the activity register below is shown
    // only when it has something in it.
    //
    // Everything above reads the activity register, and a month is no longer
    // worked that way. A Director who set objectives and watched their manager
    // record five days against them used to get a report headed "No work in
    // those dates" -- true of the register, and completely wrong about the
    // month. On screen it was worse than wrong: the register's emptiness hid
    // the recorded days altogether, while the PDF of the same query printed
    // them.
    monthlyWork: await buildMonthlyWork(user, period, choice)
  };
}

// THE MONTH'S OWN WORK -- the body of the report.
//
// The months the period falls in, every objective agreed for them, and the days
// recorded against those objectives inside the period.
//
// WHY EVERY OBJECTIVE AND NOT ONLY THE WORKED ONES: this used to start from the
// daily records, so an objective nobody had touched simply did not appear in
// the report. "Nothing has been recorded against this commitment" is the single
// most useful line a monthly report can carry, and it was the one line the
// report could not print -- an untouched objective and an objective that does
// not exist read identically.
//
// Scoped exactly like the rest of the report: a manager reads their own
// operation, the Director reads all of them. Progress is the objective's
// lifetime figure, not the period's -- "320 of 500 tonnes" is the number
// anybody reading a weekly report actually wants, and a percentage of one week
// against a monthly target would be meaningless. It is computed by
// objectiveProgress/planProgress from lib/monthly.js, the same definition the
// plan screen, /review and the month-end report read, so a report can never
// disagree with the plan it reports on.
async function buildMonthlyWork(user, period, choice = null) {
  // Whole months, because a plan IS a month: a week inside October is reported
  // against October's plan. monthStart() parses the string by hand rather than
  // through Date, which would read a bare month as UTC and land on the previous
  // one west of Greenwich.
  const values = [monthStart(period.start), monthStart(period.end), period.start, period.end];
  const filters = ['p.month BETWEEN $1::date AND $2::date'];
  managerScope(user, 'p.sector', values, filters);
  // Narrowed the same way as the activity half, or a report asked for Mining
  // would list Mining's activities above every operation's recorded days.
  applyChoice(choice, { sector: 'p.sector', project: 'p.project_id' }, values, filters);

  const plans = (await pool.query(
    `SELECT p.id, p.sector, p.status, to_char(p.month, 'YYYY-MM') AS plan_month,
            COALESCE(p.approved_budget, 0) AS approved_budget,
            -- The plan's lifetime spend, summed exactly as PLAN_TOTALS in
            -- routes/monthlyPlans.js sums it: the days' own costs plus anything
            -- recorded against the month's activities. Reading it any other way
            -- here would put a different "spent" in the report than the one the
            -- manager is looking at on the plan itself.
            COALESCE((SELECT SUM(r.cost) FROM plan_daily_reports r WHERE r.plan_id = p.id), 0)
              + COALESCE((SELECT SUM(e.amount) FROM activity_expenses e
                          JOIN activities ea ON ea.id = e.activity_id
                          WHERE ea.monthly_plan_id = p.id), 0) AS spent,
            COALESCE((SELECT SUM(r.cost) FROM plan_daily_reports r
                       WHERE r.plan_id = p.id
                         AND r.report_date BETWEEN $3::date AND $4::date), 0) AS cost_in_period,
            (SELECT COUNT(*) FROM plan_daily_reports r
              WHERE r.plan_id = p.id
                AND r.report_date BETWEEN $3::date AND $4::date)::int AS records_in_period
       FROM monthly_plans p
      WHERE ${filters.join(' AND ')}
      ORDER BY p.month, p.sector`,
    values
  )).rows;

  // HOW MANY MONTHS THE PROJECT FILTER LEFT OUT.
  //
  // A monthly plan may or may not be filed under a project. When a report is
  // asked for one project, a month of the same operation that is not filed
  // under it is correctly excluded -- it is somebody else's work -- but the
  // report then said "No monthly plan covers these dates", which reads as
  // "nothing was agreed for this month". Those are different statements, and
  // the second one is the kind a decision gets made on. Counted here so every
  // rendering can say which it means.
  let monthsOutsideProject = 0;
  if (choice?.projectId) {
    const wider = [monthStart(period.start), monthStart(period.end)];
    const widerFilters = ['p.month BETWEEN $1::date AND $2::date'];
    managerScope(user, 'p.sector', wider, widerFilters);
    // The operation's months, without the project narrowing: the difference is
    // what the filter cost.
    applyChoice({ operation: choice.operation }, { sector: 'p.sector' }, wider, widerFilters);
    const all = await pool.query(
      `SELECT COUNT(*)::int AS months FROM monthly_plans p WHERE ${widerFilters.join(' AND ')}`,
      wider
    );
    monthsOutsideProject = Math.max(0, Number(all.rows[0].months || 0) - plans.length);
  }

  if (!plans.length) return { ...emptyMonthlyWork(), monthsOutsideProject };

  const planIds = plans.map((row) => row.id);
  const range = [planIds, period.start, period.end];
  const [objectiveRows, dayRows] = await Promise.all([
    pool.query(
      `SELECT o.id, o.plan_id, o.title, o.target_quantity, o.target_unit, o.weight,
              o.supports_operation, o.deadline,
              p.sector, to_char(p.month, 'YYYY-MM') AS plan_month,
              COALESCE((SELECT SUM(d.quantity_done) FROM plan_daily_reports d
                         WHERE d.objective_id = o.id), 0) AS done_overall,
              COALESCE((SELECT SUM(d.quantity_done) FROM plan_daily_reports d
                         WHERE d.objective_id = o.id
                           AND d.report_date BETWEEN $2::date AND $3::date), 0) AS done_in_period,
              COALESCE((SELECT SUM(d.cost) FROM plan_daily_reports d
                         WHERE d.objective_id = o.id
                           AND d.report_date BETWEEN $2::date AND $3::date), 0) AS cost_in_period,
              (SELECT COUNT(*) FROM plan_daily_reports d
                WHERE d.objective_id = o.id
                  AND d.report_date BETWEEN $2::date AND $3::date)::int AS records_in_period,
              (SELECT COUNT(*) FROM plan_report_evidence e
                 JOIN plan_daily_reports d ON d.id = e.report_id
                WHERE d.objective_id = o.id
                  AND d.report_date BETWEEN $2::date AND $3::date)::int AS evidence_in_period
         FROM plan_objectives o
         JOIN monthly_plans p ON p.id = o.plan_id
        WHERE o.plan_id = ANY($1::int[])
        ORDER BY p.month, p.sector, o.sort_order, o.id`,
      range
    ),
    pool.query(
      `SELECT r.id, r.report_date, r.quantity_done, r.cost, r.notes, r.work_status, r.remarks,
              p.id AS plan_id, p.sector, to_char(p.month, 'YYYY-MM') AS plan_month,
              o.id AS objective_id, o.title AS objective_title, o.target_unit,
              (SELECT COUNT(*) FROM plan_report_evidence e WHERE e.report_id = r.id)::int AS evidence_count
         FROM plan_daily_reports r
         JOIN monthly_plans p ON p.id = r.plan_id
         LEFT JOIN plan_objectives o ON o.id = r.objective_id
        WHERE r.plan_id = ANY($1::int[])
          AND r.report_date BETWEEN $2::date AND $3::date
        ORDER BY r.report_date, r.id`,
      range
    )
  ]);

  const objectives = objectiveRows.rows.map((row) => {
    const progress = objectiveProgress(row.target_quantity, row.done_overall);
    return {
      objectiveId: row.id,
      planId: row.plan_id,
      planMonth: row.plan_month,
      operation: row.sector,
      title: row.title,
      unit: row.target_unit || '',
      target: progress.target,
      doneOverall: progress.done,
      remaining: progress.remaining,
      percent: progress.percent,
      complete: progress.complete,
      // planProgress() weights by this when any objective on the month carries
      // one, so it has to travel with the objective.
      weight: row.weight === null ? null : round2(row.weight),
      doneInPeriod: round2(row.done_in_period),
      costInPeriod: round2(row.cost_in_period),
      records: row.records_in_period,
      evidence: row.evidence_in_period,
      // The report's one judgement, and it is a fact rather than an opinion:
      // was anything at all written down against this commitment in these
      // dates? Everything else on the line is a figure.
      worked: row.records_in_period > 0,
      supportsOperation: row.supports_operation || null,
      deadline: toDateOnly(row.deadline)
    };
  });

  const months = plans.map((row) => {
    const own = objectives.filter((objective) => objective.planId === row.id);
    const approved = round2(row.approved_budget);
    const spent = round2(row.spent);
    return {
      planId: row.id,
      operation: row.sector,
      operationName: sectorName(row.sector),
      planMonth: row.plan_month,
      status: row.status,
      objectives: own.length,
      objectivesWorked: own.filter((objective) => objective.worked).length,
      objectivesDone: own.filter((objective) => objective.complete).length,
      records: row.records_in_period,
      percent: planProgress(own),
      // A month with approved_budget = 0 has no ceiling at all -- that is the
      // documented meaning of zero, not "a budget of nothing" -- so it is
      // reported as having none rather than as being 100% overspent.
      budget: approved > 0 ? approved : null,
      spent,
      remaining: approved > 0 ? round2(approved - spent) : null,
      costInPeriod: round2(row.cost_in_period)
    };
  });

  const sum = (rows, pick) => round2(rows.reduce((total, row) => total + Number(pick(row) || 0), 0));
  const withCeiling = months.filter((month) => month.budget !== null);
  const budget = sum(withCeiling, (month) => month.budget);
  const spent = sum(months, (month) => month.spent);

  return {
    summary: {
      months: months.length,
      operations: new Set(plans.map((row) => row.sector)).size,
      objectives: objectives.length,
      objectivesWorked: objectives.filter((objective) => objective.worked).length,
      objectivesDone: objectives.filter((objective) => objective.complete).length,
      // The month as one figure, the same way the plan screen reads it.
      percent: planProgress(objectives),
      records: dayRows.rows.length,
      evidence: dayRows.rows.reduce((total, row) => total + Number(row.evidence_count || 0), 0),
      cost: sum(dayRows.rows, (row) => row.cost)
    },
    // The money of the months covered, which is the figure a manager works
    // against. It is deliberately NOT the same reading as budgetSummary above:
    // that one totals the activity register's three budget figures, this one is
    // the monthly plan's ceiling and what has been spent out of it. Keeping
    // them in separate blocks, each saying what it is, is what stops a reader
    // adding the two together.
    money: {
      budget,
      spent,
      // Approved − Spent over the months that HAVE a budget, the way the plan
      // screen's Remaining Budget card reads it. It used to subtract the
      // spending of every month, so a month with no ceiling made a budgeted
      // one look overspent; that spending is named in spentWithoutBudget.
      remaining: budget > 0 ? round2(budget - sum(withCeiling, (month) => month.spent)) : null,
      spentWithoutBudget: sum(months.filter((month) => month.budget === null), (month) => month.spent),
      costInPeriod: sum(months, (month) => month.costInPeriod),
      monthsWithoutCeiling: months.length - withCeiling.length
    },
    months,
    // Months of this operation the project filter left out (0 unless a project
    // was asked for), so a report can say that instead of implying nothing was
    // agreed for the month.
    monthsOutsideProject,
    objectives,
    days: dayRows.rows.map((row) => ({
      id: row.id,
      date: toDateOnly(row.report_date),
      operation: row.sector,
      planId: row.plan_id,
      planMonth: row.plan_month,
      objective: row.objective_title || '',
      objectiveId: row.objective_id ?? null,
      quantity: round2(row.quantity_done),
      unit: row.target_unit || '',
      cost: round2(row.cost),
      notes: readableNote(row.notes),
      workStatus: row.work_status || '',
      remarks: row.remarks || '',
      evidenceCount: Number(row.evidence_count || 0)
    }))
  };
}

// No plan covers the period at all -- a report on a month nobody has written
// yet. Every field the renderers read, empty, so none of them has to guard.
function emptyMonthlyWork() {
  return {
    summary: {
      months: 0, operations: 0, objectives: 0, objectivesWorked: 0, objectivesDone: 0,
      percent: null, records: 0, evidence: 0, cost: 0
    },
    money: { budget: 0, spent: 0, remaining: null, spentWithoutBudget: 0, costInPeriod: 0, monthsWithoutCeiling: 0 },
    months: [],
    objectives: [],
    days: []
  };
}

// ---- routes ---------------------------------------------------------------

router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ message: 'Authentication required.' });
  // A period report is a management reading of a whole business operation: every
  // activity in it, what each was given, what each spent, and who ran it. That is
  // the Director's job and the operation manager's job, not a team member's.
  //
  // The comment on the routes below always said "a manager may ask for one",
  // but nothing enforced it: sector scoping alone let a team member pull -- and
  // export to Excel or PDF -- the entire budget and spend of their operation.
  // Scope answers "whose data?"; it was never an answer to "who may ask?".
  // The General Manager reads the organisation's reports on screen like the
  // Director does (scope comes from hasFullScope); the export below stays the
  // Director's alone.
  if (!isAdmin(req.user) && req.user.role !== 'manager' && !isGeneralManager(req.user)) {
    return res.status(403).json({ message: 'Only a manager or the Director can run a report.' });
  }
  next();
});

// The report on screen. A manager may ask for one, and gets their own working
// area; the Director gets every area. Nobody sees outside their scope, because
// the filter is the same managerScope the register itself uses.
router.get('/activities', asyncRoute(async (req, res) => {
  const period = resolvePeriod(req.query);
  const choice = await resolveFilters(req.user, req.query);
  res.json(await buildReport(req.user, period, choice));
}));

// ---- how far each project has got --------------------------------------------
//
// A project's completion is read from the objectives of the monthly plans
// filed under it (monthly_plans.project_id), through planProgress -- the same
// rule a month uses: weighted when any objective carries a weight, otherwise
// the plain average, and objectives with no countable target left out rather
// than counted as 0. Each objective's own figure is objectiveProgress, capped
// at 100 for display while the actual done figure is kept beside it.
//
// It is NOT money. Budget used and work done are different questions, and the
// payload carries no money at all so the two can never be read as one.
//
// When there is nothing to calculate from, the percent is null and `missing`
// says what is missing -- no plan filed under the project, or plans whose
// objectives have no number to count -- instead of inventing a figure. The
// projects.progress column is a number somebody typed, and is not used.
router.get('/projects', asyncRoute(async (req, res) => {
  const choice = await resolveFilters(req.user, req.query);
  const values = [];
  const filters = [];
  managerScope(req.user, 'p.sector', values, filters);
  projectScope(req.user, 'p.id', values, filters);
  if (choice.operation) { values.push(choice.operation); filters.push(`p.sector = $${values.length}`); }
  if (choice.projectId) { values.push(choice.projectId); filters.push(`p.id = $${values.length}`); }
  const projects = (await pool.query(
    `SELECT p.id, p.name, p.sector FROM projects p ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''} ORDER BY p.sector, p.name`,
    values
  )).rows;
  if (!projects.length) return res.json({ projects: [] });
  const objectiveRows = (await pool.query(
    `SELECT mp.project_id, mp.id AS plan_id, to_char(mp.month, 'YYYY-MM') AS plan_month,
            o.id, o.title, o.target_quantity, o.target_unit, o.weight,
            COALESCE((SELECT SUM(d.quantity_done) FROM plan_daily_reports d WHERE d.objective_id = o.id), 0) AS done,
            (SELECT COUNT(*) FROM plan_daily_reports d WHERE d.objective_id = o.id)::int AS records
       FROM monthly_plans mp JOIN plan_objectives o ON o.plan_id = mp.id
      WHERE mp.project_id = ANY($1::varchar[])
      ORDER BY mp.month, o.sort_order, o.id`,
    [projects.map((p) => p.id)]
  )).rows;
  const planCounts = (await pool.query(
    'SELECT project_id, COUNT(*)::int AS plans FROM monthly_plans WHERE project_id = ANY($1::varchar[]) GROUP BY project_id',
    [projects.map((p) => p.id)]
  )).rows;
  res.json({
    projects: projects.map((project) => {
      const own = objectiveRows.filter((row) => row.project_id === project.id).map((row) => {
        const progress = objectiveProgress(row.target_quantity, row.done);
        return {
          objectiveId: row.id, planMonth: row.plan_month, title: row.title, unit: row.target_unit || '',
          target: progress.target, done: progress.done, percent: progress.percent, complete: progress.complete,
          weight: row.weight === null ? null : round2(row.weight), records: row.records
        };
      });
      const plans = planCounts.find((row) => row.project_id === project.id)?.plans || 0;
      const countable = own.filter((objective) => objective.percent !== null);
      const percent = planProgress(own);
      return {
        id: project.id, name: project.name, operation: project.sector,
        plans, objectives: own.length, countable: countable.length,
        done: own.filter((objective) => objective.complete).length,
        recorded: own.filter((objective) => objective.records > 0).length,
        weighted: countable.some((objective) => Number(objective.weight) > 0),
        percent,
        missing: percent !== null ? null : plans === 0 ? 'no_plans' : own.length === 0 ? 'no_objectives' : 'no_countable',
        items: own
      };
    })
  });
}));

// ---- month by month ------------------------------------------------------------
//
// The last few months, each read by buildMonthlyWork -- the very function the
// period report uses -- so a trend point and the report for that month can
// never disagree. Months with no plan are returned as such (plans: 0) rather
// than left out, so a gap reads as a gap and not as a straight line.
router.get('/trends', asyncRoute(async (req, res) => {
  const choice = await resolveFilters(req.user, req.query);
  const count = Math.min(12, Math.max(2, Number.parseInt(req.query.months, 10) || 6));
  const now = new Date();
  const keys = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const months = [];
  for (const key of keys) {
    const work = await buildMonthlyWork(req.user, resolvePeriod({ period: 'monthly', month: key }), choice);
    months.push({
      month: key,
      plans: work.months.length,
      percent: work.summary.percent,
      objectives: work.summary.objectives,
      objectivesDone: work.summary.objectivesDone,
      approved: work.money.budget,
      spent: work.money.spent,
      remaining: work.money.remaining,
      spentWithoutBudget: work.money.spentWithoutBudget
    });
  }
  res.json({ operation: choice.operation, projectId: choice.projectId, months });
}));

// The same report, same scope, same query -- only the container differs. The
// export cannot show more than the screen does because both come through
// buildReport.
router.get('/activities/export', asyncRoute(async (req, res) => {
  // A manager reads their reports on screen but does not take a copy away: the
  // exported file is the one that leaves the building, and the Director decided
  // only they hand it out. Checked before anything is built.
  if (!isAdmin(req.user)) {
    return res.status(403).json({ message: 'Only the Director can export a report.', code: 'EXPORT_DIRECTOR_ONLY' });
  }
  const format = String(req.query.format || '').toLowerCase();
  if (!['xlsx', 'pdf'].includes(format)) {
    return res.status(400).json({ message: 'The export format must be xlsx or pdf.' });
  }
  const period = resolvePeriod(req.query);
  const choice = await resolveFilters(req.user, req.query);
  const report = await buildReport(req.user, period, choice);
  return sendReportFile(req, res, report, { format, period, choice });
}));

// Writes a built report as the file asked for. One function, used by the
// Director's export above and by a partner's export of a project shared with
// them (server/routes/partner.js), so the two files can never differ in
// anything but the rows the caller was allowed to read.
export async function sendReportFile(req, res, report, { format, period, choice }) {
  // WHICH LANGUAGE THE FILE IS WRITTEN IN.
  //
  // The reader's own, sent by the browser from the language they picked (the
  // screen has had it in four languages all along; the file was English only,
  // which is the one copy of the report that leaves the building). Anything
  // that is not one of the four reads as English rather than being trusted
  // into a lookup, so a hand-typed URL cannot do anything but fall back.
  //
  // It is NOT stored on the account: the language is a display choice the
  // browser owns, and a manager who switches the interface to French expects
  // the next file to come out in French.
  const language = knownLanguage(req.query.language || req.get('accept-language'));
  // The file says what is in it. Three downloads of "report-<dates>"
  // for three different operations are indistinguishable in a downloads folder,
  // which is where these files are read from.
  const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const subject = choice.projectName ? slug(choice.projectName)
    : choice.operation ? slug(choice.operation) : null;
  const stem = `report-${subject ? `${subject}-` : ''}${period.start}-to-${period.end}`;

  if (format === 'xlsx') {
    const workbook = await buildWorkbook(report, language);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${stem}.xlsx"`);
    await workbook.xlsx.write(res);
    return res.end();
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${stem}.pdf"`);
  return writePdf(report, res, language);
}

router.use((error, req, res, next) => {
  if (error instanceof ReportError) return res.status(error.status).json({ message: error.message });
  return next(error);
});

export default router;

// ---- exports --------------------------------------------------------------
//
// THE FILE IS WRITTEN IN ITS READER'S LANGUAGE.
//
// Every word below comes from shared/strings.js -- the same dictionary the
// screen reads, which is why it lives in shared/ and not in src/i18n.js. The
// exports were English only while the interface had been in four languages
// from the start, and the exported file is the copy that is printed, carried to
// a meeting and handed to a partner, so it was the one copy the reader could
// not read. Where the file and the screen say the same thing they read the same
// key, so the two cannot drift apart; the `export.*` family is only the words a
// file needs and a screen does not.
//
// Money is deliberately NOT localised: amounts stay grouped the way
// formatUsd/formatLocal group them on screen (en-US, "$50,710.89"), so a figure
// read off the screen and the same figure read off the file are the same string
// of characters. Only the words and the dates change.

const MONEY = '#,##0.00';

// The translator for one file: `t` for a word, `w` for a sentence with values
// in it.
function wordsFor(language) {
  return {
    t: (key) => translate(language, key),
    w: (key, values) => fill(translate(language, key), values)
  };
}

// A day as its reader writes one: "7 September 2026", "7 septembre 2026",
// "2026 Nzeri 7". Built from the three numbers rather than parsed, so a
// date-only string cannot slide a day either way through a timezone.
//
// The month names come from Node's own ICU data, not from the dictionary: all
// four languages are in CLDR, and a table of 48 month names maintained by hand
// is 48 chances to mistype one. A Node built with small-icu would fall back to
// English dates -- the words around them would still be translated, and no
// figure changes -- but every supported deployment (Vercel's runtime, and any
// ordinary node build since v13) ships the full set.
function dayInWords(value, language) {
  if (!value) return '';
  const [year, month, day] = String(value).slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return String(value);
  return new Intl.DateTimeFormat(language, { day: 'numeric', month: 'long', year: 'numeric' })
    .format(new Date(year, month - 1, day));
}

// 'YYYY-MM' as a month and a year: "September 2026", "septembre 2026".
function monthInWords(value, language) {
  const [year, month] = String(value || '').split('-').map(Number);
  if (!year || !month) return String(value || '');
  return new Intl.DateTimeFormat(language, { month: 'long', year: 'numeric' })
    .format(new Date(year, month - 1, 1));
}

// What the file is headed with. `period.label` is the English phrase the API
// built for the payload; this is the same period in the reader's language.
function periodInWords(period, language) {
  const { w } = wordsFor(language);
  if (period.kind === 'monthly') return monthInWords(period.start.slice(0, 7), language);
  if (period.kind === 'weekly') return w('export.weekOf', { date: dayInWords(period.start, language) });
  return `${dayInWords(period.start, language)} ${translate(language, 'report.to')} ${dayInWords(period.end, language)}`;
}

// An operation's name in the reader's language -- operationName() is where the
// four names live, with their translations, precisely because the API needs
// them too. sectorName() above is the English fallback for an id that is not
// one of the four.
function operationLabel(id, language) {
  if (!id) return translate(language, 'review.notAssigned');
  return operationName(id, language) || sectorName(id);
}

// A worksheet name Excel will accept: 31 characters, and none of the handful it
// reserves. A translated name is a name somebody wrote, not a constant, so it
// is checked rather than trusted.
function sheetName(text) {
  return String(text).replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Report';
}

// A spreadsheet is for working with the numbers again, so every money cell goes
// in as a number with a format, never as a pre-formatted string.
function money(sheet, columns) {
  for (const column of columns) sheet.getColumn(column).numFmt = MONEY;
}

function headerRow(sheet, rowNumber) {
  const row = sheet.getRow(rowNumber);
  row.font = { bold: true };
  row.commit?.();
}

// THE ORDER OF THE SHEETS IS THE ORDER OF THE REPORT.
//
// What was done, then the money, then the day-by-day record, and only then the
// activity register -- and the register's sheets are added only when there are
// activities in the period. A spreadsheet that opened on an empty "Summary" of
// a register nobody uses any more, with the month's actual work on sheet four,
// was a spreadsheet nobody scrolled to the end of.
//
// There is no "Manager performance" sheet and no "Recorded by" column: the
// people reading this know who runs each operation (see SELECT_ROWS).
async function buildWorkbook(report, language = 'en') {
  const { t, w } = wordsFor(language);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Project Management System';
  workbook.created = new Date();

  const work = report.monthlyWork || emptyMonthlyWork();
  const hasActivities = report.activities.length > 0;
  const operation = (id) => operationLabel(id, language);

  const summary = workbook.addWorksheet(sheetName(t('report.title')));
  summary.columns = [{ width: 36 }, { width: 22 }, { width: 18 }, { width: 18 }];

  // The title row is styled through the row addRow() hands back rather than by
  // number: adding the logo first pushes everything down by one, and
  // getRow(1).font then bolded an empty row and left the title plain -- which
  // is exactly what the old workbook did.
  const heading = scopeHeading(report.scope, operation, t);
  const titleRow = summary.addRow([`${heading} — ${periodInWords(report.period, language)}`]);
  titleRow.font = { bold: true, size: 14 };
  summary.addRow([t('export.datesCovered'),
    `${dayInWords(report.period.start, language)} ${t('report.to')} ${dayInWords(report.period.end, language)}`]);
  if (report.scope.projectName) summary.addRow([t('report.project'), report.scope.projectName]);
  summary.addRow([t('export.printed'), new Date(report.generatedAt).toLocaleString(language)]);

  // The same mark as the PDF, floated over the first rows so it brands the
  // sheet without occupying a cell anybody reads. Added after those rows so it
  // cannot shift them. Skipped silently when the file is missing, for the same
  // reason as the PDF.
  const logo = logoPath();
  if (logo) {
    const image = workbook.addImage({ filename: logo, extension: 'png' });
    summary.addImage(image, { tl: { col: 3.1, row: 0.1 }, ext: { width: 154, height: 90 } });
  }

  summary.addRow([]);

  summary.addRow([t('report.whatWasDone')]);
  headerRow(summary, summary.rowCount);
  if (work.objectives.length) {
    summary.addRow([t('report.commitments'), work.summary.objectives]);
    summary.addRow([t('report.workedOn'), work.summary.objectivesWorked]);
    summary.addRow([t('portal.completed'), work.summary.objectivesDone]);
    summary.addRow([t('report.daysWritten'), work.summary.records]);
    summary.addRow([t('report.photos'), work.summary.evidence]);
    if (work.summary.percent !== null) {
      const row = summary.addRow([t('report.howFar'), work.summary.percent / 100]);
      row.getCell(2).numFmt = '0%';
    }
  } else {
    summary.addRow([t('report.noPlanForDates')]);
  }
  // A project was asked for and the operation's month is not filed under it:
  // say so, rather than letting "no plan covers these dates" read as "nothing
  // was agreed".
  if (work.monthsOutsideProject > 0) {
    summary.addRow([w('export.monthsNotInProject', { count: work.monthsOutsideProject })]);
  }
  summary.addRow([]);

  // A MONEY heading over nothing but the exchange rate is a heading that wastes
  // a reader's time, so the whole block only appears when there is a figure in
  // it.
  const hasMoney = work.months.length > 0 || hasActivities;
  if (hasMoney) {
    summary.addRow([t('report.money')]);
    headerRow(summary, summary.rowCount);
    summary.addRow(['', 'USD', 'RWF', 'CDF']);
    headerRow(summary, summary.rowCount);
  }
  const inLocal = (amount) => [
    round2(amount * report.rate.rwfPerUsd),
    round2(amount * report.rate.cdfPerUsd)
  ];
  const moneyRow = (label, amount) => {
    const row = summary.addRow([label, amount, ...inLocal(amount)]);
    for (const column of [2, 3, 4]) row.getCell(column).numFmt = MONEY;
    return row;
  };
  // The monthly plan's money first: that is the figure the manager works
  // against. A month with no ceiling says so rather than printing a nought that
  // reads as "you were given nothing".
  if (work.money.budget > 0) {
    moneyRow(t('report.monthBudget'), work.money.budget);
    moneyRow(t('report.spentSoFar'), work.money.spent);
    moneyRow(work.money.remaining < 0 ? t('report.overBudgetBy') : t('report.moneyLeft'),
      Math.abs(work.money.remaining));
    // Why Budget − Spent is not the remainder when some months had no budget.
    if (work.money.spentWithoutBudget > 0) moneyRow(t('report.spentWithoutBudget'), work.money.spentWithoutBudget);
  } else if (work.months.length) {
    summary.addRow([t('report.monthBudget'), t('report.noCeiling')]);
    moneyRow(t('report.spentSoFar'), work.money.spent);
  }
  // Only when the period is narrower than the month it belongs to. On a
  // monthly report the two figures are the same number printed twice.
  if (work.money.costInPeriod > 0 && work.money.costInPeriod !== work.money.spent) {
    moneyRow(t('report.spentInDates'), work.money.costInPeriod);
  }
  // The activity register's own three figures, kept apart and labelled, because
  // they are a different reading of the money and must never be added to the
  // figures above.
  if (hasActivities) {
    summary.addRow([]);
    summary.addRow([t('export.fromRegister')]);
    headerRow(summary, summary.rowCount);
    moneyRow(t('report.totalAssignedBudget'), report.budgetSummary.assigned);
    moneyRow(t('export.afterDirectorReviewed'), report.budgetSummary.revised);
    moneyRow(t('field.spent'), report.budgetSummary.spent);
    moneyRow(report.budgetSummary.remaining < 0 ? t('report.overBudgetBy') : t('report.moneyLeft'),
      Math.abs(report.budgetSummary.remaining));
  }
  if (hasMoney) {
    summary.addRow([w('export.rateLine', { rwf: report.rate.rwfPerUsd, cdf: report.rate.cdfPerUsd })]);
  }

  if (hasActivities) {
    summary.addRow([]);
    summary.addRow([t('report.activitiesInDates')]);
    headerRow(summary, summary.rowCount);
    summary.addRow([t('report.totalActivities'), report.activitySummary.total]);
    summary.addRow([t('portal.completed'), report.activitySummary.completed]);
    summary.addRow([t('portal.inProgress'), report.activitySummary.inProgress]);
    summary.addRow([t('approval.pending'), report.activitySummary.pending]);
    summary.addRow([t('report.overdue'), report.activitySummary.overdue]);
    summary.addRow([t('status.Cancelled'), report.activitySummary.cancelled]);
  }

  // The month's work gets its own sheets rather than being squeezed into the
  // activity columns: it is a different register, counted in units those
  // columns have no place for (tonnes, inspections, hectares).
  if (work.objectives.length) {
    const progress = workbook.addWorksheet(sheetName(t('report.whatWasDone')));
    progress.columns = [
      { header: t('report.operation'), key: 'operation', width: 24 },
      { header: t('report.month'), key: 'month', width: 16 },
      { header: t('report.commitment'), key: 'objective', width: 38 },
      { header: t('export.doneInDates'), key: 'period', width: 19 },
      { header: t('export.doneInTotal'), key: 'done', width: 14 },
      { header: t('report.target'), key: 'target', width: 14 },
      { header: t('export.unit'), key: 'unit', width: 14 },
      { header: t('export.howFar'), key: 'percent', width: 12 },
      { header: t('export.days'), key: 'records', width: 8 },
      { header: t('report.photos'), key: 'photos', width: 9 },
      { header: t('export.supportFor'), key: 'supports', width: 22 }
    ];
    headerRow(progress, 1);
    for (const objective of work.objectives) {
      progress.addRow({
        operation: operation(objective.operation),
        month: monthInWords(objective.planMonth, language),
        objective: objective.title,
        // An objective nobody touched in these dates says so in words. Zero
        // would read as a measurement; this is the absence of one.
        period: objective.worked ? objective.doneInPeriod : t('report.nothingInDates'),
        done: objective.doneOverall,
        target: objective.target ?? t('export.noNumberToCount'),
        unit: objective.unit,
        percent: objective.percent === null ? t('plan.notCounted') : objective.percent / 100,
        records: objective.records,
        photos: objective.evidence,
        supports: objective.supportsOperation ? operation(objective.supportsOperation) : ''
      });
      if (objective.percent !== null) progress.getCell(`H${progress.rowCount}`).numFmt = '0%';
    }
  }

  if (work.days.length) {
    const daily = workbook.addWorksheet(sheetName(t('report.dayByDay')));
    // The columns of the day form, in its order and under its headers
    // (DAY_COLUMNS, `day.*`), so the sheet reads like the form the manager
    // typed into. Quantity stays a number -- the unit is in its cell format,
    // not in the value -- so the column can still be summed.
    const SHEET_COLUMN = {
      date: { width: 22 }, activity: { width: 38 }, description: { width: 60 }, quantity: { width: 16 },
      cost: { width: 14 }, status: { width: 24 }, remarks: { width: 40 }, photos: { width: 9 }
    };
    daily.columns = DAY_COLUMNS.map((column) => ({ header: t(`day.${column}`), key: column, ...SHEET_COLUMN[column] }));
    headerRow(daily, 1);
    const many = work.months.length > 1;
    for (const day of work.days) {
      const row = daily.addRow({
        date: dayInWords(day.date, language),
        // Across several operations the activity says whose it was, as the PDF does.
        activity: `${many ? `${operation(day.operation)} — ` : ''}${day.objective || t('report.notLinked')}`,
        description: day.notes,
        quantity: day.quantity,
        cost: day.cost,
        status: day.workStatus,
        remarks: day.remarks,
        photos: day.evidenceCount
      });
      row.getCell('cost').numFmt = MONEY;
      if (day.unit) row.getCell('quantity').numFmt = `#,##0.## "${day.unit.replace(/"/g, '')}"`;
      for (const key of ['activity', 'description', 'remarks']) {
        row.getCell(key).alignment = { wrapText: true, vertical: 'top' };
      }
    }
  }

  // And the register, last, only when it has anything in it.
  if (hasActivities) {
    const details = workbook.addWorksheet(sheetName(t('nav.activities')));
    details.columns = [
      { header: t('table.activity'), key: 'activity', width: 32 },
      { header: t('report.project'), key: 'project', width: 26 },
      { header: t('report.operation'), key: 'sector', width: 20 },
      { header: t('export.budgetGiven'), key: 'original', width: 16 },
      { header: t('export.afterReview'), key: 'revised', width: 18 },
      { header: t('field.spent'), key: 'spent', width: 16 },
      { header: t('report.moneyLeft'), key: 'remaining', width: 14 },
      { header: t('export.whereItStands'), key: 'status', width: 22 },
      { header: t('export.pastItsDate'), key: 'overdue', width: 13 },
      { header: t('export.startedOn'), key: 'assignedOn', width: 18 },
      { header: t('export.due'), key: 'deadline', width: 18 },
      { header: t('export.finishedOn'), key: 'completed', width: 18 },
      { header: t('report.adminNotes'), key: 'note', width: 46 },
      { header: t('export.whyBudgetChanged'), key: 'reason', width: 46 }
    ];
    headerRow(details, 1);
    for (const item of report.activities) {
      details.addRow({
        activity: item.activity,
        project: item.projectName,
        sector: operation(item.sector),
        original: item.originalBudget,
        // An undecided budget is left blank rather than shown as a nought, which
        // would read as "the Director released nothing".
        revised: item.revisedBudget === null ? t('export.notDecidedYet') : item.revisedBudget,
        spent: item.actualSpending,
        remaining: item.remainingBudget,
        status: item.assigned
          ? t(`status.${item.status}`)
          : `${t(`status.${item.status}`)} — ${t('report.nobodyGivenIt')}`,
        overdue: item.overdue ? t('export.yes') : t('export.no'),
        assignedOn: dayInWords(item.dateAssigned, language),
        deadline: dayInWords(item.deadline, language),
        completed: dayInWords(item.completionDate, language),
        note: item.adminNote,
        reason: budgetReasonText(item, language)
      });
    }
    money(details, ['original', 'revised', 'spent', 'remaining']);
  }

  return workbook;
}
// Why a budget moved, as one readable sentence per change, in the reader's
// language. The Director's own note is the usual source; the request that asked
// for it and the answer are added when there was one, because the "why" can sit
// on either side. No names: who asked is in the record's own history, and in a
// report it is one more thing between the reader and the figure.
function budgetReasonText(item, language = 'en') {
  const { t, w } = wordsFor(language);
  // Each sentence without its full stop, so joining them cannot produce the
  // "fuel prices.." a note that already ended in one used to print.
  const sentence = (text) => String(text).replace(/\s*\.\s*$/, '');
  const parts = item.budgetRevisions
    // A revision out of NULL is the budget being set for the first time, which
    // is the activity being created rather than its figure being changed.
    // "Changed from nothing set to $500.00" is on every single row and says
    // nothing.
    .filter((change) => change.from !== null)
    .map((change) => sentence(
      w('report.changedFromTo', {
        from: usd(change.from),
        to: change.to === null ? t('report.notSet') : usd(change.to)
      }) + (change.note ? ` — ${change.note}` : '')
    ));
  for (const request of item.budgetRequests) {
    const answer = request.status === 'Pending'
      ? t('report.awaitingAnswer')
      : t(`budgetRequest.status.${request.status}`);
    parts.push(sentence(
      `${w('report.askedFor', { amount: usd(request.requestedAmount) })} (${sentence(request.reason)}) — ${answer}`
      + (request.decisionNote ? `: ${request.decisionNote}` : '')
    ));
  }
  if (!parts.length && item.adminNote) return item.adminNote;
  return parts.join('. ');
}

// Money is written the way the screen writes it -- grouped en-US, with the
// dollar sign in front -- in every language, so a figure read off the screen
// and the same figure read off the file are the same string of characters
// (formatUsd in src/format.js, formatLocal in src/journey.jsx). Only the words
// and the dates around them are translated.
function usd(value) {
  if (value === null || value === undefined || value === '') return '0.00';
  return `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// The same figure in the two local currencies, for the readers who think in
// them. Whole francs: nobody budgets to the centime of a franc.
function localPair(amount, rate) {
  const whole = (value) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
  return `${whole(amount * rate.rwfPerUsd)} RWF  ·  ${whole(amount * rate.cdfPerUsd)} CDF`;
}

// THE PRINTED REPORT.
//
// Portrait, and in this order: what was done, the money, the day-by-day record,
// then the activity register if there is one. It used to be landscape because
// the register's table of three budget figures would not fit in portrait -- so
// every report, including the many that are nothing but a month's objectives,
// was shaped around the one section that is now the least used. Portrait reads
// as a report; landscape reads as a spreadsheet somebody printed.
//
// Nothing here names a person (see SELECT_ROWS).
function writePdf(report, stream, language = 'en') {
  const { t, w } = wordsFor(language);
  const operation = (id) => operationLabel(id, language);
  const day = (value) => dayInWords(value, language);
  const doc = new PDFDocument({ size: 'A4', margin: 46 });
  doc.pipe(stream);

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom;
  const work = report.monthlyWork || emptyMonthlyWork();

  const INK = '#102b46';
  const QUIET = '#5b6b7c';

  // ---- the pieces a page is made of ---------------------------------------

  // Room for `height` more points, or a new page. Every block asks before it
  // draws, which is what stops a heading printing at the foot of one page with
  // its figures on the next.
  const room = (height) => {
    if (doc.y > bottom - height) doc.addPage();
  };

  const section = (title) => {
    room(78);
    doc.moveDown(0.9);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(11.5).text(title, left, doc.y, { width });
    doc.moveDown(0.1);
    // A rule under the heading, so the eye can find where a section starts
    // without counting blank lines.
    doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor('#c9d6e2').lineWidth(0.8).stroke();
    doc.moveDown(0.55);
    doc.font('Helvetica').fontSize(9.5).fillColor(INK);
  };

  // One fact per line, label left and value right, which is how a figure gets
  // read. Six of them crammed on one line separated by runs of spaces -- what
  // this replaces -- is a line nobody reads to the end of.
  const fact = (label, value, hint = '') => {
    room(22);
    const top = doc.y;
    doc.font('Helvetica').fontSize(9.5).fillColor(QUIET).text(label, left, top, { width: width * 0.52 });
    const labelBottom = doc.y;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK)
      .text(String(value), left + width * 0.54, top, { width: width * 0.46, align: 'right' });
    doc.y = Math.max(labelBottom, doc.y);
    if (hint) {
      doc.font('Helvetica').fontSize(8).fillColor(QUIET).text(hint, left, doc.y, { width });
    }
    doc.moveDown(0.3);
    doc.fillColor(INK);
  };

  // ---- the header ---------------------------------------------------------
  //
  // The company mark, on every printed report. A report leaves the building --
  // it goes to a partner, a lender, a meeting -- and an unbranded sheet of
  // figures does not say who produced it.
  //
  // Drawn only if the file is actually there: a missing logo must degrade to
  // the plain header it used to be, never fail the export somebody is waiting
  // on. `fit` preserves the aspect ratio, so the mark can be replaced with a
  // different shape without editing this.
  const headerTop = doc.y;
  let headerX = left;
  const logo = logoPath();
  if (logo) {
    doc.image(logo, left, headerTop, { fit: [84, 50] });
    headerX = left + 96;
  }

  // The title says what this is a report ON, not the word "Activity report"
  // over a page with no activities in it.
  doc.fillColor(INK).fontSize(16).font('Helvetica-Bold')
    .text(scopeHeading(report.scope, operation, t),
      headerX, headerTop, { width: width - (headerX - left) });
  doc.fontSize(10.5).font('Helvetica').fillColor(QUIET)
    .text(periodInWords(report.period, language), { width: width - (headerX - left) });
  doc.fontSize(8.5).text(
    `${day(report.period.start)} ${t('report.to')} ${day(report.period.end)}`
    + (report.scope.projectName ? `   ·   ${report.scope.projectName}` : '')
    + `   ·   ${t('export.printed').toLowerCase()} ${new Date(report.generatedAt).toLocaleString(language)}`,
    { width: width - (headerX - left) }
  );
  if (logo) doc.y = Math.max(doc.y, headerTop + 50);
  doc.x = left;
  doc.fillColor(INK);

  // ---- what was done ------------------------------------------------------
  //
  // First, always. On a month run through objectives this is the whole report,
  // and burying it under an empty activity register is how the report came to
  // read as "you did nothing this week".
  section(t('report.whatWasDone'));
  if (!work.objectives.length) {
    doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(QUIET)
      .text(t('report.noPlanForDates'), left, doc.y, { width });
    doc.fillColor(INK);
  } else {
    if (work.summary.percent !== null) {
      fact(t('report.howFar'), `${work.summary.percent}%`);
    }
    fact(t('report.commitments'), work.summary.objectives);
    fact(t('report.workedOn'), `${work.summary.objectivesWorked} / ${work.summary.objectives}`);
    if (work.summary.objectivesDone) fact(t('portal.completed'), work.summary.objectivesDone);
    fact(t('report.daysWritten'), work.summary.records);
    if (work.summary.evidence) fact(t('report.photos'), work.summary.evidence);
    doc.moveDown(0.5);

    // One block per commitment: its own words, then where it stands. An
    // objective nobody touched is printed too, saying so -- it is the most
    // important line on the page and it used to be missing altogether.
    for (const objective of work.objectives) {
      room(58);
      // The commitment in its own words on the left, how far it has got on the
      // right, both printed from the same top so a title that wraps to two
      // lines does not drag the percentage down with it.
      const blockTop = doc.y;
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK)
        .text(objective.title, left, blockTop, { width: width * 0.76 });
      const titleBottom = doc.y;
      const standing = objective.percent === null ? t('plan.notCounted') : `${objective.percent}%`;
      doc.font('Helvetica-Bold').fontSize(objective.percent === null ? 8.5 : 10)
        .fillColor(objective.complete ? '#1f7a4d' : QUIET)
        .text(standing, left + width * 0.78, blockTop, { width: width * 0.22, align: 'right' });
      doc.y = Math.max(titleBottom, doc.y);

      // The progress bar: the one place a picture says it faster than a number.
      if (objective.percent !== null) {
        const barTop = doc.y + 2;
        doc.roundedRect(left, barTop, width, 5, 2.5).fillColor('#e7edf4').fill();
        if (objective.percent > 0) {
          doc.roundedRect(left, barTop, Math.max(2, width * (objective.percent / 100)), 5, 2.5)
            .fillColor(objective.complete ? '#1f7a4d' : '#2563a6').fill();
        }
        doc.y = barTop + 9;
      }

      const line = [];
      line.push(objective.worked
        ? w('report.doneInDates', { amount: `${objective.doneInPeriod} ${objective.unit}`.trim() })
        : t('report.nothingInDates'));
      line.push(objective.target === null
        ? w('report.doneInTotal', { amount: `${objective.doneOverall} ${objective.unit}`.trim() })
        : w('report.doneInTotal', {
          amount: w('plan.doneOfTarget', {
            done: objective.doneOverall, target: objective.target, unit: objective.unit
          }).trim()
        }));
      if (objective.records) line.push(w('report.daysCount', { count: objective.records }));
      if (objective.evidence) line.push(w('report.photosCount', { count: objective.evidence }));
      if (objective.costInPeriod > 0) line.push(w('report.spentAmount', { amount: usd(objective.costInPeriod) }));
      if (objective.supportsOperation) {
        line.push(w('plan.supportsBadge', { operation: operation(objective.supportsOperation) }));
      }
      // Which operation and month this belongs to, but only when the report
      // covers more than one -- on a single operation's month it is the title
      // of the report repeated on every line.
      if (work.months.length > 1) {
        line.unshift(`${operation(objective.operation)}, ${monthInWords(objective.planMonth, language)}`);
      }
      doc.font('Helvetica').fontSize(8.5).fillColor(QUIET).text(line.join('   ·   '), left, doc.y, { width });
      doc.fillColor(INK);
      doc.moveDown(0.7);
    }
  }

  // A project was asked for and the operation's month is not filed under it:
  // say so. "No monthly plan covers these dates" would read as "nothing was
  // agreed", which is a different and wrong statement.
  if (work.monthsOutsideProject > 0) {
    doc.moveDown(0.3);
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(QUIET)
      .text(w('export.monthsNotInProject', { count: work.monthsOutsideProject }), left, doc.y, { width });
    doc.fillColor(INK);
  }

  // ---- the money ----------------------------------------------------------
  //
  // Only when there is a figure to print. A MONEY heading with nothing under it
  // but the exchange rate is a heading that wastes a reader's time.
  const hasMoney = work.months.length > 0 || report.activities.length > 0;
  if (hasMoney) {
    section(t('report.money'));
  }
  if (work.months.length) {
    if (work.money.budget > 0) {
      fact(t('report.monthBudget'), usd(work.money.budget), localPair(work.money.budget, report.rate));
      fact(t('report.spentSoFar'), usd(work.money.spent), localPair(work.money.spent, report.rate));
      fact(work.money.remaining < 0 ? t('report.overBudgetBy') : t('report.moneyLeft'),
        usd(Math.abs(work.money.remaining)), localPair(Math.abs(work.money.remaining), report.rate));
      if (work.money.spentWithoutBudget > 0) {
        fact(t('report.spentWithoutBudget'), usd(work.money.spentWithoutBudget), localPair(work.money.spentWithoutBudget, report.rate));
      }
    } else {
      // approved_budget = 0 means no ceiling was set, which is not a budget of
      // nothing. Printing "$0.00 left" on such a month said the opposite of
      // what is true.
      fact(t('report.monthBudget'), t('report.noCeiling'));
      fact(t('report.spentSoFar'), usd(work.money.spent), localPair(work.money.spent, report.rate));
    }
    // Same reason as the spreadsheet: on a monthly report this is the figure
    // above, printed again.
    if (work.money.costInPeriod > 0 && work.money.costInPeriod !== work.money.spent) {
      fact(t('report.spentInDates'), usd(work.money.costInPeriod));
    }
  }

  // The register's own three figures, under their own sub-heading so nobody
  // adds them to the month's. They are a different reading of the money.
  if (report.activities.length) {
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(QUIET).text(t('export.fromRegister'), left, doc.y, { width });
    doc.moveDown(0.35);
    doc.fillColor(INK);
    fact(t('report.totalAssignedBudget'), usd(report.budgetSummary.assigned),
      localPair(report.budgetSummary.assigned, report.rate));
    if (report.budgetSummary.revised !== report.budgetSummary.assigned) {
      fact(t('export.afterDirectorReviewed'), usd(report.budgetSummary.revised),
        localPair(report.budgetSummary.revised, report.rate));
    }
    fact(t('field.spent'), usd(report.budgetSummary.spent), localPair(report.budgetSummary.spent, report.rate));
    fact(report.budgetSummary.remaining < 0 ? t('report.overBudgetBy') : t('report.moneyLeft'),
      usd(Math.abs(report.budgetSummary.remaining)),
      localPair(Math.abs(report.budgetSummary.remaining), report.rate));
  }
  if (hasMoney) {
    doc.font('Helvetica').fontSize(8).fillColor(QUIET)
      .text(w('export.rateLine', { rwf: report.rate.rwfPerUsd, cdf: report.rate.cdfPerUsd }), left, doc.y, { width });
    doc.fillColor(INK);
  }

  // ---- the day-by-day record ----------------------------------------------
  //
  // What the managers actually wrote down, in date order, as a table with the
  // day form's own columns and headers (DAY_COLUMNS) -- so the printed page
  // reads like the form the day was typed into. Every cell wraps: nothing is
  // clipped or ellipsed, because these sentences are what a report exists to
  // carry. A row too tall for what is left of the page starts a new page, and
  // the header row is drawn again at the top of it.
  if (work.days.length) {
    section(t('report.dayByDay'));
    const share = { date: 60, activity: 74, description: 104, quantity: 46, cost: 50, status: 52, remarks: 77, photos: 40 };
    const scale = width / DAY_COLUMNS.reduce((sum, column) => sum + share[column], 0);
    const columns = DAY_COLUMNS.map((column) => ({ column, width: share[column] * scale }));
    const PAD = 3;
    const many = work.months.length > 1;
    const drawRow = (cells, { bold = false, fill = null } = {}) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5);
      const height = Math.max(...columns.map(({ column, width: cellWidth }) =>
        doc.heightOfString(cells[column] || ' ', { width: cellWidth - PAD * 2 }))) + PAD * 2;
      const top = doc.y;
      if (fill) doc.rect(left, top, width, height).fillColor(fill).fill();
      let x = left;
      for (const { column, width: cellWidth } of columns) {
        doc.fillColor(INK)
          .text(cells[column] || '', x + PAD, top + PAD, { width: cellWidth - PAD * 2 });
        x += cellWidth;
      }
      doc.moveTo(left, top + height).lineTo(left + width, top + height).strokeColor('#dfe7ef').lineWidth(0.5).stroke();
      doc.y = top + height;
      return height;
    };
    const headers = Object.fromEntries(DAY_COLUMNS.map((column) => [column, t(`day.${column}`)]));
    const header = () => drawRow(headers, { bold: true, fill: '#eef3f8' });
    header();
    for (const entry of work.days) {
      const cells = {
        date: day(entry.date),
        activity: `${many ? `${operation(entry.operation)} — ` : ''}${entry.objective || t('report.notLinked')}`,
        description: entry.notes,
        quantity: `${entry.quantity} ${entry.unit}`.trim(),
        cost: entry.cost > 0 ? usd(entry.cost) : '—',
        status: entry.workStatus,
        remarks: entry.remarks,
        photos: String(entry.evidenceCount || 0)
      };
      doc.font('Helvetica').fontSize(7.5);
      const needed = Math.max(...columns.map(({ column, width: cellWidth }) =>
        doc.heightOfString(cells[column] || ' ', { width: cellWidth - PAD * 2 }))) + PAD * 2;
      if (doc.y + needed > bottom) { doc.addPage(); header(); }
      drawRow(cells);
    }
    doc.font('Helvetica').fontSize(9.5).fillColor(INK);
    doc.x = left;
  }

  // ---- the activity register, when there is one ---------------------------
  if (report.activities.length) {
    section(t('report.activitiesInDates'));
    fact(t('report.totalActivities'), report.activitySummary.total);
    if (report.activitySummary.completed) fact(t('portal.completed'), report.activitySummary.completed);
    if (report.activitySummary.inProgress) fact(t('portal.inProgress'), report.activitySummary.inProgress);
    if (report.activitySummary.pending) fact(t('approval.pending'), report.activitySummary.pending);
    if (report.activitySummary.overdue) fact(t('report.overdue'), report.activitySummary.overdue);
    if (report.activitySummary.cancelled) fact(t('status.Cancelled'), report.activitySummary.cancelled);
    doc.moveDown(0.5);

    // One block per activity rather than a row in a nine-column table. The
    // table was drawn with line breaks switched off and an ellipsis, so every
    // activity name and every note longer than its share of the page width was
    // silently cut -- in a document whose whole purpose is to be read later.
    for (const item of report.activities) {
      room(54);
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(item.activity, left, doc.y, { width });
      const facts = [activityStanding(item, language)];
      if (item.projectName) facts.push(item.projectName);
      if (work.months.length > 1 || report.scope.sector === null) facts.push(operation(item.sector));
      facts.push(w('export.givenSpent', {
        given: usd(item.effectiveBudget), spent: usd(item.actualSpending)
      }));
      if (item.dateAssigned) facts.push(`${t('export.startedOn')} ${day(item.dateAssigned)}`);
      if (item.deadline) facts.push(`${t('export.due')} ${day(item.deadline)}`);
      if (item.completionDate) facts.push(`${t('export.finishedOn')} ${day(item.completionDate)}`);
      doc.font('Helvetica').fontSize(8.5).fillColor(QUIET).text(facts.join('   ·   '), left, doc.y, { width });
      const reason = budgetReasonText(item, language);
      if (reason) {
        doc.font('Helvetica-Oblique').fontSize(8.5).text(reason, left, doc.y, { width });
      }
      // Only when the note is not already inside the reason line above: the
      // Director's note IS usually the reason they changed the figure, and
      // printing it twice under one activity reads as two separate remarks.
      if (item.adminNote && !reason.includes(item.adminNote.replace(/\s*\.\s*$/, ''))) {
        doc.font('Helvetica-Oblique').fontSize(8.5)
          .text(w('export.directorsNoteLine', { note: item.adminNote }), left, doc.y, { width });
      }
      doc.fillColor(INK);
      doc.moveDown(0.6);
    }
  }

  // Only truly empty when BOTH registers are empty. Saying "no activities" on a
  // week full of recorded days was the bug this replaces.
  if (!report.activities.length && !work.days.length && !work.objectives.length) {
    doc.moveDown(1);
    doc.font('Helvetica-Oblique').fontSize(10).fillColor(QUIET)
      .text(t('export.nothingAtAll'), left, doc.y, { width });
  }

  doc.end();
  return doc;
}

// Where an activity stands, including the one thing worth saying about who has
// it: whether anybody has it at all.
function activityStanding(item, language = 'en') {
  const { t } = wordsFor(language);
  const standing = t(`status.${item.status}`) + (item.overdue ? ` (${t('export.pastItsDate').toLowerCase()})` : '');
  if (!item.assigned) return `${standing} — ${t('report.nobodyGivenIt')}`;
  return standing;
}
