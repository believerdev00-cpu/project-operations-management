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
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { pool } from '../db/database.js';
import { sectors } from '../data/seedData.js';
import { asyncRoute, hasFullScope, isAdmin, managerScope } from '../lib/http.js';
import { getCurrentRate, round2 } from '../lib/rates.js';

const router = express.Router();

const SECTOR_NAMES = new Map(sectors.map((sector) => [sector.id, sector.name]));

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

class ReportError extends Error {
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

// ---- gathering ------------------------------------------------------------

// An activity belongs to the period in which the work was put on somebody's
// desk: assigned_at when the Director handed it out, created_at when a manager
// raised it. Both are cast to a date before they are compared, so a record
// created late in the evening cannot slide into the next day's report.
const PERIOD_DAY = 'COALESCE(a.assigned_at::date, a.created_at::date)';

const SELECT_ROWS = `
  SELECT a.id, a.activity, a.description, a.category, a.sector, a.status, a.origin,
         a.requested_budget, a.approved_budget, a.admin_note, a.quantity,
         a.deadline, a.assigned_at, a.accepted_at, a.completed_at,
         a.completion_submitted_at, a.created_at, a.created_by_name, a.assigned_to,
         a.project_id, p.name AS project_name,
         -- The very day the row is filtered and bucketed on, returned as a
         -- date so the report never shows one day while counting another.
         -- Deriving it again in JavaScript would read a TIMESTAMPTZ in the Node
         -- process's zone while the filter cast it in the database's.
         ${PERIOD_DAY} AS period_day,
         m.name AS assigned_to_name,
         COALESCE(ex.spent, 0) AS actual_spending,
         COALESCE(ev.items, 0)::int AS evidence_count
  FROM activities a
  LEFT JOIN projects p ON p.id = a.project_id
  LEFT JOIN users m ON m.id = a.assigned_to
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

export async function buildReport(user, period) {
  const values = [period.start, period.end];
  const filters = [`${PERIOD_DAY} BETWEEN $1::date AND $2::date`];
  // A manager reads their own working area and nothing else, exactly as
  // everywhere else in this API. The Director passes no filter at all.
  managerScope(user, 'a.sector', values, filters);

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
                decision_note, requested_by_name, decided_by_name, decided_at, created_at
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
      changedBy: row.actor_name || '',
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
      requestedBy: row.requested_by_name || '',
      decidedBy: row.decided_by_name || '',
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
      assignedTo: row.assigned_to,
      assignedToName: row.assigned_to_name || null,
      raisedBy: row.created_by_name || '',
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

  // Grouped from the same rows the details table shows, so the two can never
  // disagree. Work nobody has been given yet still has to be accounted for, so
  // it is gathered under one unassigned row instead of being dropped.
  const byManager = new Map();
  for (const item of activities) {
    const key = item.assignedTo === null || item.assignedTo === undefined ? 'unassigned' : String(item.assignedTo);
    if (!byManager.has(key)) {
      byManager.set(key, {
        managerId: item.assignedTo ?? null,
        managerName: item.assignedToName || 'Not yet assigned',
        assigned: 0, completed: 0, inProgress: 0, pending: 0, overdue: 0,
        budgetHandled: 0, spent: 0
      });
    }
    const entry = byManager.get(key);
    entry.assigned += 1;
    if (item.bucket === 'completed') entry.completed += 1;
    if (item.bucket === 'inProgress') entry.inProgress += 1;
    if (item.bucket === 'pending') entry.pending += 1;
    if (item.overdue) entry.overdue += 1;
    entry.budgetHandled = round2(entry.budgetHandled + item.effectiveBudget);
    entry.spent = round2(entry.spent + item.actualSpending);
  }
  const managers = [...byManager.values()].sort((left, right) => right.assigned - left.assigned
    || left.managerName.localeCompare(right.managerName));

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
      sector: hasFullScope(user) ? null : user.sector,
      sectorName: hasFullScope(user) ? 'All working areas' : sectorName(user.sector),
      viewer: user.name
    },
    basis: 'Activities are counted in the period they were assigned or raised.',
    activitySummary,
    budgetSummary,
    managers,
    activities
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
  if (!isAdmin(req.user) && req.user.role !== 'manager') {
    return res.status(403).json({ message: 'Only a manager or the Director can run a report.' });
  }
  next();
});

// The report on screen. A manager may ask for one, and gets their own working
// area; the Director gets every area. Nobody sees outside their scope, because
// the filter is the same managerScope the register itself uses.
router.get('/activities', asyncRoute(async (req, res) => {
  const period = resolvePeriod(req.query);
  res.json(await buildReport(req.user, period));
}));

// The same report, same scope, same query -- only the container differs. The
// export cannot show more than the screen does because both come through
// buildReport.
router.get('/activities/export', asyncRoute(async (req, res) => {
  const format = String(req.query.format || '').toLowerCase();
  if (!['xlsx', 'pdf'].includes(format)) {
    return res.status(400).json({ message: 'The export format must be xlsx or pdf.' });
  }
  const period = resolvePeriod(req.query);
  const report = await buildReport(req.user, period);
  const stem = `activity-report-${period.start}-to-${period.end}`;

  if (format === 'xlsx') {
    const workbook = await buildWorkbook(report);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${stem}.xlsx"`);
    await workbook.xlsx.write(res);
    return res.end();
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${stem}.pdf"`);
  return writePdf(report, res);
}));

router.use((error, req, res, next) => {
  if (error instanceof ReportError) return res.status(error.status).json({ message: error.message });
  return next(error);
});

export default router;

// ---- exports --------------------------------------------------------------

const MONEY = '#,##0.00';

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

async function buildWorkbook(report) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Gisuma Project Operations';
  workbook.created = new Date();

  const summary = workbook.addWorksheet('Summary');
  summary.columns = [{ width: 32 }, { width: 18 }, { width: 18 }, { width: 18 }];
  summary.addRow(['Activity report', report.period.label]);
  summary.addRow(['Period', `${report.period.start} to ${report.period.end}`]);
  summary.addRow(['Working area', report.scope.sectorName]);
  summary.addRow(['Generated', new Date(report.generatedAt).toLocaleString()]);
  summary.addRow([]);
  summary.addRow(['ACTIVITY SUMMARY']);
  headerRow(summary, summary.rowCount);
  summary.addRow(['Total activities', report.activitySummary.total]);
  summary.addRow(['Completed', report.activitySummary.completed]);
  summary.addRow(['In progress', report.activitySummary.inProgress]);
  summary.addRow(['Pending', report.activitySummary.pending]);
  summary.addRow(['Overdue', report.activitySummary.overdue]);
  summary.addRow(['Cancelled', report.activitySummary.cancelled]);
  summary.addRow([]);
  summary.addRow(['BUDGET SUMMARY']);
  headerRow(summary, summary.rowCount);
  summary.addRow(['', 'USD', 'RWF', 'CDF']);
  headerRow(summary, summary.rowCount);
  const budgetFrom = summary.rowCount + 1;
  const inLocal = (amount) => [
    round2(amount * report.rate.rwfPerUsd),
    round2(amount * report.rate.cdfPerUsd)
  ];
  summary.addRow(['Total assigned budget', report.budgetSummary.assigned, ...inLocal(report.budgetSummary.assigned)]);
  summary.addRow(['Total revised budget', report.budgetSummary.revised, ...inLocal(report.budgetSummary.revised)]);
  summary.addRow(['Total actual spending', report.budgetSummary.spent, ...inLocal(report.budgetSummary.spent)]);
  summary.addRow(['Remaining budget', report.budgetSummary.remaining, ...inLocal(report.budgetSummary.remaining)]);
  summary.addRow([`At today's rate: 1 USD = ${report.rate.rwfPerUsd} RWF = ${report.rate.cdfPerUsd} CDF`]);
  for (let index = budgetFrom; index <= budgetFrom + 3; index += 1) {
    summary.getCell(`B${index}`).numFmt = MONEY;
    summary.getCell(`C${index}`).numFmt = MONEY;
    summary.getCell(`D${index}`).numFmt = MONEY;
  }
  summary.getRow(1).font = { bold: true, size: 14 };

  const people = workbook.addWorksheet('Manager performance');
  people.columns = [
    { header: 'Manager', key: 'name', width: 28 },
    { header: 'Activities assigned', key: 'assigned', width: 20 },
    { header: 'Completed', key: 'completed', width: 14 },
    { header: 'In progress', key: 'inProgress', width: 14 },
    { header: 'Overdue', key: 'overdue', width: 12 },
    { header: 'Total budget handled', key: 'budget', width: 22 },
    { header: 'Spent', key: 'spent', width: 16 }
  ];
  headerRow(people, 1);
  for (const entry of report.managers) {
    people.addRow({
      name: entry.managerName, assigned: entry.assigned, completed: entry.completed,
      inProgress: entry.inProgress, overdue: entry.overdue,
      budget: entry.budgetHandled, spent: entry.spent
    });
  }
  money(people, ['budget', 'spent']);

  const details = workbook.addWorksheet('Activity details');
  details.columns = [
    { header: 'Activity', key: 'activity', width: 30 },
    { header: 'Project', key: 'project', width: 26 },
    { header: 'Working area', key: 'sector', width: 20 },
    { header: 'Assigned manager', key: 'manager', width: 22 },
    { header: 'Original budget', key: 'original', width: 16 },
    { header: 'Revised budget', key: 'revised', width: 16 },
    { header: 'Actual spending', key: 'spent', width: 16 },
    { header: 'Remaining', key: 'remaining', width: 14 },
    { header: 'Status', key: 'status', width: 18 },
    { header: 'Overdue', key: 'overdue', width: 10 },
    { header: 'Date assigned', key: 'assignedOn', width: 14 },
    { header: 'Deadline', key: 'deadline', width: 14 },
    { header: 'Completion date', key: 'completed', width: 16 },
    { header: 'Admin note', key: 'note', width: 46 },
    { header: 'Budget change reason', key: 'reason', width: 46 }
  ];
  headerRow(details, 1);
  for (const item of report.activities) {
    details.addRow({
      activity: item.activity,
      project: item.projectName,
      sector: item.sectorName,
      manager: item.assignedToName || 'Not yet assigned',
      original: item.originalBudget,
      // An undecided budget is left blank rather than shown as a nought, which
      // would read as "the Director released nothing".
      revised: item.revisedBudget === null ? '' : item.revisedBudget,
      spent: item.actualSpending,
      remaining: item.remainingBudget,
      status: item.status,
      overdue: item.overdue ? 'Yes' : 'No',
      assignedOn: item.dateAssigned || '',
      deadline: item.deadline || '',
      completed: item.completionDate || '',
      note: item.adminNote,
      reason: budgetReasonText(item)
    });
  }
  money(details, ['original', 'revised', 'spent', 'remaining']);
  return workbook;
}

// The reason a budget moved, as one readable line per change. The Director's
// own note is the usual source; a manager's request and the answer to it are
// added when there was one, because the "why" can sit on either side.
function budgetReasonText(item) {
  const parts = item.budgetRevisions.map((change) => {
    const from = change.from === null ? 'not set' : change.from.toFixed(2);
    const to = change.to === null ? 'not set' : change.to.toFixed(2);
    return `${from} -> ${to}${change.note ? `: ${change.note}` : ''}`;
  });
  for (const request of item.budgetRequests) {
    const answer = request.status === 'Pending' ? 'awaiting an answer' : request.status.toLowerCase();
    parts.push(`${request.requestedBy || 'Manager'} asked for ${request.requestedAmount.toFixed(2)} (${request.reason}) - ${answer}${request.decisionNote ? `: ${request.decisionNote}` : ''}`);
  }
  if (!parts.length && item.adminNote) return item.adminNote;
  return parts.join(' | ');
}

function usd(value) {
  if (value === null || value === undefined || value === '') return '-';
  return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Landscape, because the details table carries three budget figures beside the
// dates and will not read in portrait.
function writePdf(report, stream) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
  doc.pipe(stream);

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom;

  doc.fontSize(17).font('Helvetica-Bold').text('Activity report', left, doc.y);
  doc.moveDown(0.2);
  doc.fontSize(10).font('Helvetica')
    .text(`${report.period.label}  (${report.period.start} to ${report.period.end})`)
    .text(`Working area: ${report.scope.sectorName}    Generated: ${new Date(report.generatedAt).toLocaleString()}`)
    .text(report.basis);
  doc.moveDown(0.8);

  const section = (title) => {
    if (doc.y > bottom - 70) doc.addPage();
    doc.fontSize(11).font('Helvetica-Bold').text(title, left, doc.y);
    doc.moveDown(0.35);
    doc.font('Helvetica').fontSize(9);
  };

  // Six figures across one line each, so the eye can compare them without a
  // table border getting in the way.
  section('ACTIVITY SUMMARY');
  const counts = report.activitySummary;
  doc.text(`Total activities: ${counts.total}      Completed: ${counts.completed}      In progress: ${counts.inProgress}`
    + `      Pending: ${counts.pending}      Overdue: ${counts.overdue}      Cancelled: ${counts.cancelled}`);
  doc.moveDown(0.8);

  section('BUDGET SUMMARY (USD)');
  const budget = report.budgetSummary;
  doc.text(`Total assigned: ${usd(budget.assigned)}      Total revised: ${usd(budget.revised)}`
    + `      Actual spending: ${usd(budget.spent)}      Remaining: ${usd(budget.remaining)}`);
  const local = (amount, perUsd) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(amount * perUsd);
  doc.moveDown(0.3);
  doc.fontSize(8).fillColor('#555555').text(
    `In RWF: assigned ${local(budget.assigned, report.rate.rwfPerUsd)}      revised ${local(budget.revised, report.rate.rwfPerUsd)}`
    + `      spent ${local(budget.spent, report.rate.rwfPerUsd)}      remaining ${local(budget.remaining, report.rate.rwfPerUsd)}`
  );
  doc.text(
    `In CDF: assigned ${local(budget.assigned, report.rate.cdfPerUsd)}      revised ${local(budget.revised, report.rate.cdfPerUsd)}`
    + `      spent ${local(budget.spent, report.rate.cdfPerUsd)}      remaining ${local(budget.remaining, report.rate.cdfPerUsd)}`
  );
  doc.text(`At today's rate: 1 USD = ${report.rate.rwfPerUsd} RWF = ${report.rate.cdfPerUsd} CDF`);
  doc.fillColor('#000000').fontSize(10);
  doc.moveDown(0.8);

  // One shared row painter for both tables. Widths are fractions of the text
  // column, so the layout survives a change of page size.
  const table = (headers, fractions, rows) => {
    const widths = fractions.map((fraction) => fraction * width);
    const paint = (cells, bold) => {
      const height = 14;
      if (doc.y > bottom - height * 2) {
        doc.addPage();
        paint(headers, true);
      }
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
      let x = left;
      const top = doc.y;
      cells.forEach((cell, index) => {
        doc.text(String(cell ?? ''), x + 2, top, { width: widths[index] - 4, height, ellipsis: true, lineBreak: false });
        x += widths[index];
      });
      doc.y = top + height;
      doc.moveTo(left, doc.y - 3).lineTo(left + width, doc.y - 3)
        .strokeColor(bold ? '#333333' : '#dddddd').lineWidth(0.5).stroke();
    };
    paint(headers, true);
    for (const row of rows) paint(row, false);
  };

  section('MANAGER PERFORMANCE');
  table(
    ['Manager', 'Assigned', 'Completed', 'In progress', 'Overdue', 'Budget handled', 'Spent'],
    [0.28, 0.1, 0.11, 0.12, 0.1, 0.15, 0.14],
    report.managers.map((entry) => [
      entry.managerName, entry.assigned, entry.completed, entry.inProgress,
      entry.overdue, usd(entry.budgetHandled), usd(entry.spent)
    ])
  );
  doc.moveDown(1);

  section('ACTIVITY DETAILS');
  table(
    ['Activity', 'Project', 'Manager', 'Original', 'Revised', 'Spent', 'Status', 'Assigned', 'Completed'],
    [0.19, 0.15, 0.13, 0.08, 0.08, 0.08, 0.11, 0.09, 0.09],
    report.activities.map((item) => [
      item.activity, item.projectName, item.assignedToName || 'Not yet assigned',
      usd(item.originalBudget), item.revisedBudget === null ? '-' : usd(item.revisedBudget),
      usd(item.actualSpending), item.overdue ? `${item.status} (late)` : item.status,
      item.dateAssigned || '-', item.completionDate || '-'
    ])
  );

  // The notes are the point of keeping three budget figures apart, so they get
  // their own block rather than being squeezed into a table cell and clipped.
  const annotated = report.activities.filter((item) => item.adminNote || budgetReasonText(item));
  if (annotated.length) {
    doc.moveDown(1);
    section('BUDGET CHANGES AND ADMIN NOTES');
    for (const item of annotated) {
      if (doc.y > bottom - 40) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(8.5).text(item.activity, left, doc.y, { width });
      doc.font('Helvetica').fontSize(8)
        .text(`Original ${usd(item.originalBudget)}  |  Revised ${item.revisedBudget === null ? 'not decided' : usd(item.revisedBudget)}  |  Spent ${usd(item.actualSpending)}`, { width });
      const reason = budgetReasonText(item);
      if (reason) doc.text(`Reason: ${reason}`, { width });
      if (item.adminNote && reason !== item.adminNote) doc.text(`Admin note: ${item.adminNote}`, { width });
      doc.moveDown(0.5);
    }
  }

  if (!report.activities.length) {
    doc.moveDown(1);
    doc.font('Helvetica-Oblique').fontSize(10)
      .text('No activities fall in this period.', left, doc.y, { width });
  }

  doc.end();
  return doc;
}
