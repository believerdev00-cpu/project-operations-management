// Activity register and approval workflow.
//
// Every activity names the person who must approve it, in
// approval_required_from, and carries its own approval_status alongside the
// workflow status. Two routings exist, and they are the same mechanism read
// from either end:
//
//   Director assigns work to a manager -> the manager is approval_required_from
//     -> it appears in that manager's "What I Need to Approve" -> approve/reject.
//   Manager raises work needing the Director -> the Director is
//     approval_required_from -> it appears in the Director's queue, where the
//     budget can be changed and a note left before approving or rejecting.
//
// The requested figure is never overwritten: a changed budget lands in
// approved_budget so both survive side by side. After approval the manager does
// the work, attaches evidence, and hands it back; the Director reviews the
// evidence and closes the record. Every material change is appended to
// activity_history.

import express from 'express';
import multer from 'multer';
import { pool, safeRollback } from '../db/database.js';
import { ACTIVITY_STATUSES, ACTIVITY_ORIGINS } from '../db/activitySchema.js';
import {
  asyncRoute, contentDisposition, hasFullScope, isAdmin, isValidDate, managerScope, parseId, requiredText,
  validNumber, validateSector, withinScope
} from '../lib/http.js';
import { canApprove, decisionOpen, pendingForMeSql, resolveDirector, APPROVER_ROLE_LABELS } from '../lib/approvals.js';
import { PAYMENT_METHODS } from '../db/monthlySchema.js';
import {
  DEAD_STATUSES, FINAL_CHECK_SQL, OVER_BUDGET_MESSAGE, canDeleteExpense, canRecordExpense, cents, openWorkSql,
  fitsRemaining, fromCents
} from '../lib/monthly.js';
import { round2 } from '../lib/rates.js';
import { MAX_EVIDENCE_BYTES, MAX_EVIDENCE_FILES, MAX_EVIDENCE_LABEL, deleteFile, readFile, saveFile, storedFileName } from '../lib/storage.js';

const router = express.Router();

export { ACTIVITY_STATUSES, ACTIVITY_ORIGINS };
export const EVIDENCE_KINDS = ['Receipt', 'Invoice', 'Fuel Slip', 'Delivery Note', 'Payment Proof', 'Photograph', 'Other'];
export const EVIDENCE_STATUSES = ['Pending', 'Partial', 'Complete'];

// Statuses that mean the work is cleared to happen, so the activity counts as
// approved, and statuses from which finished work may be handed back.
const APPROVED_STATUSES = ['Approved', 'Budget Adjusted', 'In Progress', 'Needs Correction', 'Completed'];
const WORKABLE_STATUSES = ['Approved', 'Budget Adjusted', 'In Progress', 'Needs Correction'];

// Which status may follow which. Reopening is deliberate: completed work can go
// back to the manager if the evidence turns out to be short.
const STATUS_FLOW = {
  Draft: ['Pending Approval', 'Cancelled'],
  'Pending Approval': ['Approved', 'Budget Adjusted', 'Rejected', 'On Hold', 'Cancelled'],
  Approved: ['In Progress', 'Completed', 'Needs Correction', 'Budget Adjusted', 'On Hold', 'Rejected', 'Cancelled'],
  'Budget Adjusted': ['In Progress', 'Completed', 'Needs Correction', 'Approved', 'On Hold', 'Rejected', 'Cancelled'],
  'In Progress': ['Completed', 'Needs Correction', 'Budget Adjusted', 'On Hold', 'Rejected', 'Cancelled'],
  'Needs Correction': ['In Progress', 'Completed', 'Budget Adjusted', 'On Hold', 'Rejected', 'Cancelled'],
  Completed: ['In Progress', 'Needs Correction'],
  // Reopened straight to a decision. Draft used to be offered here too, but no
  // screen can send a draft on, so it was a dead end only the Director could clear.
  Rejected: ['Pending Approval'],
  Cancelled: ['Pending Approval'],
  'On Hold': ['Pending Approval', 'Approved', 'Budget Adjusted', 'In Progress', 'Rejected', 'Cancelled']
};

// Where a record may move to, for this record. Work that never needed anybody's
// approval -- a planned activity, pre-approved when the month was planned --
// cannot be sent back for one: it would name no approver, sit in nobody's queue
// and be impossible to decide. Reopened, it goes straight back to Approved.
function allowedNextStatuses(row) {
  const flow = STATUS_FLOW[row.status] || [];
  if (row.approval_required) return flow;
  return flow.filter((status) => status !== 'Pending Approval')
    .concat(['Rejected', 'Cancelled'].includes(row.status) ? ['Approved'] : []);
}

// Where the bytes go is the storage adapter's business (server/uploads).
const EVIDENCE_FOLDER = 'activities';

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
  'application/pdf'
]);

class ActivityError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Files are held in memory and handed to the storage adapter once the request
// has been authorised, rather than being written to disk by multer before this
// code has decided whether the caller may upload at all.
const upload = multer({
  storage: multer.memoryStorage(),
  // Browsers send the filename as UTF-8. Busboy reads it as Latin-1 unless told
  // otherwise, which stored "Fagitire_ñ.pdf" as mojibake.
  defParamCharset: 'utf8',
  limits: { fileSize: MAX_EVIDENCE_BYTES, files: MAX_EVIDENCE_FILES },
  fileFilter: (req, file, done) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return done(new ActivityError(400, 'Evidence must be a JPG, PNG, GIF, WEBP, HEIC image or a PDF.'));
    }
    done(null, true);
  }
});

function optionalText(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function stringify(value) {
  if (value === null || value === undefined) return null;
  return String(value);
}

async function logHistory(client, activityId, user, entries) {
  for (const entry of entries) {
    await client.query(
      `INSERT INTO activity_history (activity_id, action, field, old_value, new_value, note, actor_id, actor_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [activityId, entry.action, entry.field || null, stringify(entry.oldValue), stringify(entry.newValue), entry.note || '', user.id, user.name]
    );
  }
}

// The request was priced at some USD-to-local rate; the approved figure is
// shown at that same rate so the two are directly comparable rather than
// re-converted at today's rate.
function equivalents(row, usdAmount) {
  const requestedUsd = Number(row.cost_usd) || 0;
  const rwfPerUsd = requestedUsd > 0 ? Number(row.cost_rwf) / requestedUsd : 1450;
  const cdfPerUsd = requestedUsd > 0 ? Number(row.cost_cdf) / requestedUsd : 2850;
  return { usd: round2(usdAmount), rwf: round2(usdAmount * rwfPerUsd), cdf: round2(usdAmount * cdfPerUsd) };
}

export function mapActivity(row) {
  const requestedBudget = Number(row.requested_budget ?? row.cost_usd ?? 0);
  const approvedBudget = row.approved_budget === null || row.approved_budget === undefined
    ? null
    : Number(row.approved_budget);

  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name ?? null,
    sector: row.sector,
    category: row.category,
    activity: row.activity,
    description: row.description,
    materials: row.materials || '',
    quantity: Number(row.quantity),
    costUsd: Number(row.cost_usd),
    costRwf: Number(row.cost_rwf),
    costCdf: Number(row.cost_cdf),
    requestedBudget,
    approvedBudget,
    // Positive means the Director released more than was asked for, negative
    // means the request was trimmed. Null until a decision exists.
    budgetAdjustment: approvedBudget === null ? null : round2(approvedBudget - requestedBudget),
    requestedEquivalent: equivalents(row, requestedBudget),
    approvedEquivalent: approvedBudget === null ? null : equivalents(row, approvedBudget),
    adminNote: row.admin_note || '',
    rejectionReason: row.rejection_reason || '',

    // ---- monthly plan -------------------------------------------------------
    // A planned activity belongs to a month's approved budget; one without a
    // plan is off-plan work that spends nothing from it.
    monthlyPlanId: row.monthly_plan_id ?? null,
    planMonth: row.plan_month ? String(row.plan_month).slice(0, 7) : null,
    planStatus: row.plan_status ?? null,
    priority: row.priority || 'Medium',
    // Section 5: remaining = approved - actual, derived from the expense rows.
    actualSpent: row.actual_spent === undefined ? undefined : round2(row.actual_spent),
    remainingBudget: row.actual_spent === undefined
      ? undefined
      : round2((approvedBudget === null ? requestedBudget : approvedBudget) - Number(row.actual_spent)),
    expenseCount: row.expense_count === undefined ? undefined : Number(row.expense_count),
    paymentEvidenceCount: row.payment_evidence_count === undefined ? undefined : Number(row.payment_evidence_count),
    activityEvidenceCount: row.activity_evidence_count === undefined ? undefined : Number(row.activity_evidence_count),
    // Whether an external partner in this operation may see it -- one of the
    // three conditions, alongside being approved and in their operation.
    externallyVisible: row.externally_visible !== false,
    instructions: row.instructions || '',
    origin: row.origin || 'requested',
    // The sector *is* the department -- Farming, Mining, Agriculture,
    // Logistics. It is surfaced under both names so the approval screens can
    // say "Department" without a second column that could drift out of step.
    department: row.sector,
    assignedTo: row.assigned_to ?? null,
    assignedToName: row.assigned_to_name ?? null,
    assignedAt: row.assigned_at ?? null,
    acceptedAt: row.accepted_at ?? null,

    // ---- who must approve this, and what they decided ----------------------
    approvalRequired: row.approval_required !== false,
    approvalRequiredFrom: row.approval_required_from ?? null,
    approvalRequiredFromName: row.approval_required_from_name ?? null,
    // The approver's own role and area, so the detail screen can name them the
    // way a reader recognises them: "John — Farming Manager".
    approvalRequiredFromRole: row.approval_required_from_role ?? null,
    approvalRequiredFromSector: row.approval_required_from_sector ?? null,
    approvalRequiredRole: row.approval_required_role ?? null,
    approvalRequiredLabel: APPROVER_ROLE_LABELS[row.approval_required_role] || null,
    approvalStatus: row.approval_status || 'pending',
    approvedBy: row.approved_by ?? null,
    approvedByName: row.approved_by_name ?? null,
    approvedAt: row.approved_at ?? null,
    // A DATE column arrives as a Date at local midnight; sending it on as a
    // timestamp shifts the calendar day for a reader in another zone.
    deadline: toDateOnly(row.deadline),
    scheduledFor: toDateOnly(row.scheduled_for),
    pendingBudgetRequests: row.pending_budget_requests === undefined ? undefined : Number(row.pending_budget_requests),
    signed: row.signed,
    approved: row.approved,
    status: row.status,
    evidenceStatus: row.evidence_status || 'Pending',
    evidenceCount: row.evidence_count === undefined ? undefined : Number(row.evidence_count),
    createdBy: row.created_by ?? null,
    createdByName: row.created_by_name || '',
    reviewedBy: row.reviewed_by ?? null,
    reviewedByName: row.reviewed_by_name ?? null,
    reviewedAt: row.reviewed_at ?? null,
    completionSubmittedAt: row.completion_submitted_at ?? null,
    completedAt: row.completed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// node-postgres hands back a DATE as a Date at local midnight, so a date-only
// column leaves as a date-only string.
function toDateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

function mapBudgetRequest(row) {
  return {
    id: row.id,
    activityId: row.activity_id,
    currentBudget: Number(row.current_budget),
    requestedAmount: Number(row.requested_amount),
    change: round2(Number(row.requested_amount) - Number(row.current_budget)),
    reason: row.reason,
    status: row.status,
    decisionNote: row.decision_note || '',
    requestedBy: row.requested_by,
    requestedByName: row.requested_by_name,
    decidedBy: row.decided_by,
    decidedByName: row.decided_by_name,
    decidedAt: row.decided_at,
    createdAt: row.created_at
  };
}

function mapEvidence(row) {
  return {
    id: row.id,
    activityId: row.activity_id,
    // 'payment' proves money was spent; 'activity' proves the work was done.
    evidenceType: row.evidence_type || 'payment',
    expenseId: row.expense_id ?? null,
    kind: row.kind,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    amount: Number(row.amount),
    note: row.note,
    uploadedBy: row.uploaded_by,
    uploadedByName: row.uploaded_by_name,
    createdAt: row.created_at
  };
}

function mapHistory(row) {
  return {
    id: row.id,
    activityId: row.activity_id,
    action: row.action,
    field: row.field,
    oldValue: row.old_value,
    newValue: row.new_value,
    note: row.note || '',
    actorId: row.actor_id,
    actorName: row.actor_name,
    createdAt: row.created_at
  };
}

const SELECT_ACTIVITY = `
  SELECT a.*, p.name AS project_name, r.name AS reviewed_by_name, m.name AS assigned_to_name,
         COALESCE((SELECT SUM(e.amount) FROM activity_expenses e WHERE e.activity_id = a.id), 0) AS actual_spent,
         (SELECT COUNT(*) FROM activity_expenses e WHERE e.activity_id = a.id)::int AS expense_count,
         (SELECT COUNT(*) FROM activity_evidence ev WHERE ev.activity_id = a.id AND ev.evidence_type = 'payment')::int AS payment_evidence_count,
         (SELECT COUNT(*) FROM activity_evidence ev WHERE ev.activity_id = a.id AND ev.evidence_type = 'activity')::int AS activity_evidence_count,
         pl.month AS plan_month, pl.status AS plan_status,
         req.name AS approval_required_from_name, req.role AS approval_required_from_role,
         req.sector AS approval_required_from_sector,
         app.name AS approved_by_name,
         (SELECT COUNT(*) FROM activity_evidence e WHERE e.activity_id = a.id)::int AS evidence_count,
         (SELECT COUNT(*) FROM activity_budget_requests b WHERE b.activity_id = a.id AND b.status = 'Pending')::int AS pending_budget_requests
  FROM activities a
  LEFT JOIN projects p ON p.id = a.project_id
  LEFT JOIN users r ON r.id = a.reviewed_by
  LEFT JOIN users m ON m.id = a.assigned_to
  LEFT JOIN users req ON req.id = a.approval_required_from
  LEFT JOIN users app ON app.id = a.approved_by
  LEFT JOIN monthly_plans pl ON pl.id = a.monthly_plan_id
`;

// Sector scoping, exactly as everywhere else in this API: the Director sees
// every record, anyone else sees their own working area -- plus anything that
// is waiting on their own approval. Without that second clause an approver
// could see a row in their queue and then be refused when they opened it.
async function loadActivity(id, user) {
  const values = [id];
  const scopeFilters = [];
  managerScope(user, 'a.sector', values, scopeFilters);
  const scope = scopeFilters.length
    ? `(${scopeFilters.join(' AND ')} OR ${pendingForMeSql(user, values, 'a')})`
    : '';
  const result = await pool.query(
    `${SELECT_ACTIVITY} WHERE a.id = $1${scope ? ` AND ${scope}` : ''}`,
    values
  );
  if (!result.rowCount) throw new ActivityError(404, 'Activity not found.');
  return result.rows[0];
}

// The record as it stands after a write the caller was already authorised to
// make. Not scoped again: approving a record is exactly what takes it out of the
// approver's "waiting on me" scope, and re-reading it through that scope turned
// a saved approval into "Activity not found."
async function reloadActivity(id) {
  const result = await pool.query(`${SELECT_ACTIVITY} WHERE a.id = $1`, [id]);
  if (!result.rowCount) throw new ActivityError(404, 'Activity not found.');
  return result.rows[0];
}

function requireAdmin(user, action) {
  if (!isAdmin(user)) throw new ActivityError(403, `Only the Director can ${action}.`);
}

// A closed month is a signed-off account. Anything that would change what it
// recorded -- a decision, a status, a budget, a spend, the evidence -- waits
// until the Director reopens the month.
function assertPlanOpen(row) {
  if (row.plan_status === 'Closed') {
    throw new ActivityError(409, 'This activity belongs to a closed month. Ask the Director to reopen the month first.');
  }
}

// A manager may correct their own request only while it is still undecided --
// once the Director has decided it, the record is read-only to them.
function canEditRequest(user, row) {
  if (isAdmin(user)) return true;
  return row.created_by === user.id && ['Draft', 'Pending Approval'].includes(row.status);
}

// Evidence belongs to whoever carries the work: the Director, the sector's
// managers, or the account the work was handed to. A team member in the same
// sector is not a party to a manager's activity and goes through their manager.
function canAttachEvidence(user, row) {
  if (isAdmin(user)) return true;
  if (!withinScope(user, row.sector)) return false;
  return user.role === 'manager' || Number(row.assigned_to) === Number(user.id);
}

router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ message: 'Authentication required.' });
  next();
});

// ---- register -------------------------------------------------------------

router.get('/', asyncRoute(async (req, res) => {
  const { projectId, sector, status, search, awaiting, assignedTo, limit, offset, unplanned, paged } = req.query;
  const values = [];
  const filters = [];

  if (projectId && projectId !== 'All') {
    values.push(projectId);
    filters.push(`a.project_id = $${values.length}`);
  }
  if (sector && sector !== 'All') {
    values.push(sector);
    filters.push(`a.sector = $${values.length}`);
  }
  if (status && status !== 'All') {
    values.push(status);
    filters.push(`a.status = $${values.length}`);
  }
  if (search) {
    values.push(`%${search}%`);
    filters.push(`(a.activity ILIKE $${values.length} OR a.description ILIKE $${values.length} OR a.category ILIKE $${values.length} OR a.materials ILIKE $${values.length})`);
  }
  // "What I Need to Approve", built from the signed-in user rather than from a
  // hard-coded role: approval_required_from = me AND approval_status = pending.
  // The sector scope below is deliberately not applied on top of this -- an
  // approver named on a record can always see that record.
  const approvalQueue = awaiting === 'approval';
  if (approvalQueue) {
    filters.push(pendingForMeSql(req.user, values, 'a'));
  }
  // Everything sitting on the Director's desk: undecided requests, finished
  // work handed back, and budget changes waiting for an answer.
  if (awaiting === 'review') {
    filters.push(`(a.status = 'Pending Approval'
      OR (a.completion_submitted_at IS NOT NULL AND a.status <> 'Completed')
      OR EXISTS (SELECT 1 FROM activity_budget_requests b WHERE b.activity_id = a.id AND b.status = 'Pending'))`);
  }
  // Everything sitting on this manager's desk: work waiting on their approval,
  // and work sent back for correction.
  if (awaiting === 'mine') {
    values.push(req.user.id);
    filters.push(`(a.assigned_to = $${values.length}
      AND (a.status = 'Needs Correction' OR (a.approval_status = 'pending' AND a.status = 'Pending Approval')))`);
  }
  if (assignedTo === 'me') {
    values.push(req.user.id);
    filters.push(`a.assigned_to = $${values.length}`);
  }
  if (awaiting === 'work') filters.push(openWorkSql(values, 'a', req.user.id));
  if (awaiting === 'final-check') filters.push(FINAL_CHECK_SQL('a'));
  // Approved, live work that no monthly plan has taken in yet: what the Director
  // may attach to a month. Asked of the server rather than filtered out of the
  // newest page of the register, which silently missed anything older.
  if (unplanned === '1' || unplanned === 'true') {
    filters.push(`(a.monthly_plan_id IS NULL AND a.approval_status = 'approved' AND a.status NOT IN ('Rejected', 'Cancelled'))`);
  }
  if (!approvalQueue) managerScope(req.user, 'a.sector', values, filters);

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const requestedLimit = Number(limit || 5);
  const safeLimit = Number.isInteger(requestedLimit) && requestedLimit > 0 && requestedLimit <= 200 ? requestedLimit : 5;
  const requestedOffset = Number(offset || 0);
  const safeOffset = Number.isInteger(requestedOffset) && requestedOffset >= 0 && requestedOffset <= 100000 ? requestedOffset : 0;
  // One row beyond the page is read so the register knows whether to offer
  // "Load more" without a second counting query.
  values.push(safeLimit + 1, safeOffset);
  const result = await pool.query(
    `${SELECT_ACTIVITY} ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  const items = result.rows.slice(0, safeLimit).map(mapActivity);
  // The register asks for pages; every older caller still receives a plain list.
  if (paged === '1' || paged === 'true') {
    return res.json({ items, hasMore: result.rows.length > safeLimit, offset: safeOffset, limit: safeLimit });
  }
  res.json(items);
}));

// The full review screen in one request: the record, its evidence, its history.
router.get('/:id', asyncRoute(async (req, res) => {
  const row = await loadActivity(req.params.id, req.user);
  const [evidence, history, budgetRequests] = await Promise.all([
    pool.query('SELECT * FROM activity_evidence WHERE activity_id = $1 ORDER BY created_at DESC', [row.id]),
    pool.query('SELECT * FROM activity_history WHERE activity_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200', [row.id]),
    pool.query('SELECT * FROM activity_budget_requests WHERE activity_id = $1 ORDER BY created_at DESC', [row.id])
  ]);
  res.json({
    activity: mapActivity(row),
    evidence: evidence.rows.map(mapEvidence),
    history: history.rows.map(mapHistory),
    budgetRequests: budgetRequests.rows.map(mapBudgetRequest)
  });
}));

function validateRequestBody(payload) {
  if (!payload.projectId || !payload.category || !payload.activity) {
    return 'Project, category, and activity are required.';
  }
  if (!requiredText(payload.category) || !requiredText(payload.activity)
    || !validNumber(payload.quantity, { minimum: 0.01 })
    || !validNumber(payload.costUsd) || !validNumber(payload.costRwf) || !validNumber(payload.costCdf ?? payload.costFco)) {
    return 'Category, activity, quantity, USD, RWF, and CDF values must be valid. Quantity must be greater than zero.';
  }
  // The column widths, answered here rather than as a database error.
  if (payload.category.trim().length > 100) return 'The category can be at most 100 characters.';
  if (payload.activity.trim().length > 200) return 'The activity name can be at most 200 characters.';
  return null;
}

router.post('/', asyncRoute(async (req, res) => {
  // The Director assigns work and a manager asks for it. A team member does
  // neither: they follow their operation's work but raise nothing that would land
  // in the Director's approval queue. The screen hid the form from nobody, so
  // the rule lives here.
  if (!isAdmin(req.user) && req.user.role !== 'manager') {
    return res.status(403).json({ message: 'Only a manager or the Director can add an activity.' });
  }
  const payload = req.body || {};
  const invalid = validateRequestBody(payload);
  if (invalid) return res.status(400).json({ message: invalid });

  const projectResult = await pool.query(
    `SELECT id, sector FROM projects WHERE id = $1${hasFullScope(req.user) ? '' : ' AND sector = $2'}`,
    hasFullScope(req.user) ? [payload.projectId] : [payload.projectId, req.user.sector]
  );
  if (!projectResult.rowCount) return res.status(404).json({ message: 'Select an existing project before assigning an activity.' });

  const sector = validateSector(payload.sector, projectResult.rows[0].sector);
  if (!sector) return res.status(400).json({ message: 'Choose a valid business operation.' });
  if (!withinScope(req.user, sector)) {
    return res.status(403).json({ message: 'You can only add work in your own business operation.' });
  }

  // Two ways in, one table. The Director assigns work to a manager, and that
  // manager is the one who must approve it. A manager raises a need, and the
  // Director is the one who must approve it. Either way the record names its
  // approver at the moment it is created; neither is left generically pending.
  const assigning = isAdmin(req.user);
  const budget = round2(payload.costUsd || 0);
  // Always minted here. Taking an id from the request let a caller choose the
  // record's key, which nothing else in the API allows.
  const id = `ACT-${Date.now()}`;

  // A manager's own request is theirs to carry once approved. Left unassigned it
  // could be started and finished by them, but not spent against -- expenses
  // belong to the assignee -- so an approved request had no way to record money.
  let assignedTo = assigning ? null : req.user.id;
  let deadline = null;
  // When the work is to happen. Anyone raising or assigning work may set it,
  // unlike the deadline, which is the Director's to impose.
  const scheduledFor = payload.scheduledFor ? String(payload.scheduledFor).slice(0, 10) : null;
  if (scheduledFor && !isValidDate(scheduledFor)) {
    return res.status(400).json({ message: 'The date of the activity must be a real date.' });
  }
  if (assigning) {
    assignedTo = parseId(payload.assignedTo);
    if (!assignedTo) {
      return res.status(400).json({ message: 'Choose the manager who will carry out this activity.' });
    }
    const manager = await pool.query(
      "SELECT id, sector, role, covers_all_sectors AS \"coversAllSectors\" FROM users WHERE id = $1 AND role = 'manager' AND status = 'active'",
      [assignedTo]
    );
    if (!manager.rowCount) return res.status(400).json({ message: 'The selected manager is invalid.' });
    // A manager only ever reads the working areas they cover, so handing them
    // work outside those would leave them assigned to a record they cannot open.
    // A manager who covers every area can be handed anything.
    if (!withinScope(manager.rows[0], sector)) {
      return res.status(400).json({ message: 'That manager works in a different business operation. Pick a manager from this one.' });
    }
    deadline = payload.deadline ? String(payload.deadline).slice(0, 10) : null;
    if (deadline && !isValidDate(deadline)) {
      return res.status(400).json({ message: 'The deadline must be a real date.' });
    }
  }

  // The Director may hand over routine work that needs nobody's sign-off; a
  // manager's request always needs one. Saving a draft parks the record with
  // its author without putting it in anybody's queue.
  const approvalRequired = assigning ? payload.approvalRequired !== false : true;
  const isDraft = payload.status === 'Draft';

  // An assigned activity carries the Director's own figure, so it is both the
  // original budget and the approved one. A raised request has no approved
  // budget until the Director decides it.
  const approvedBudget = assigning ? budget : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Who must approve, resolved to an account id rather than left as a role.
    // Assigned work waits on the manager it was handed to; a raised request
    // waits on the Director.
    let approvalRole = null;
    let approvalFrom = null;
    if (approvalRequired) {
      if (assigning) {
        approvalRole = 'manager';
        approvalFrom = assignedTo;
      } else {
        const director = await resolveDirector(client);
        if (!director) {
          await safeRollback(client);
          return res.status(500).json({ message: 'No Director account exists to approve this request.' });
        }
        approvalRole = 'director';
        approvalFrom = director.id;
      }
    }

    const status = isDraft ? 'Draft' : (approvalRequired ? 'Pending Approval' : 'Approved');
    const approvalStatus = approvalRequired ? 'pending' : 'approved';

    const result = await client.query(
      `INSERT INTO activities
         (id, project_id, sector, category, activity, description, materials, quantity,
          cost_usd, cost_rwf, cost_cdf, requested_budget, approved_budget, signed, approved, status,
          created_by, created_by_name, origin, assigned_to, assigned_at, deadline, scheduled_for, instructions,
          reviewed_by, reviewed_at,
          approval_required, approval_required_from, approval_required_role, approval_status,
          approved_by, approved_at)
       -- $18 is cast here as well as in the CASE arms below. Feeding it once as
       -- the bare origin column (varchar) and once as $18::text leaves Postgres
       -- unable to settle on a type for the parameter, and the whole insert is
       -- rejected with "inconsistent types deduced for parameter $18".
       SELECT $1, p.id, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::text, $19,
              CASE WHEN $19::int IS NULL THEN NULL ELSE NOW() END, $20::date, $27::date, $21,
              CASE WHEN $18::text = 'assigned' THEN $16::int ELSE NULL END,
              CASE WHEN $18::text = 'assigned' THEN NOW() ELSE NULL END,
              $23, $24, $25, $26::text,
              -- Nobody's sign-off needed means the creator is the approver of
              -- record, so the trail still names a person and a moment.
              CASE WHEN $26::text = 'approved' THEN $16::int ELSE NULL END,
              CASE WHEN $26::text = 'approved' THEN NOW() ELSE NULL END
       FROM projects p WHERE p.id = $22
       RETURNING id`,
      [
        id, sector, payload.category, payload.activity, payload.description || '',
        optionalText(payload.materials, 2000), Number(payload.quantity || 0),
        budget, Number(payload.costRwf || 0), Number(payload.costCdf ?? payload.costFco ?? 0),
        budget, approvedBudget, Boolean(payload.signed), !approvalRequired, status,
        req.user.id, req.user.name, assigning ? 'assigned' : 'requested', assignedTo,
        deadline, optionalText(payload.instructions, 4000), payload.projectId,
        approvalRequired, approvalFrom, approvalRole, approvalStatus, scheduledFor
      ]
    );
    if (!result.rowCount) {
      await safeRollback(client);
      return res.status(404).json({ message: 'Project not found.' });
    }
    const entries = assigning
      ? [
        { action: 'Activity assigned', field: 'status', oldValue: null, newValue: status, note: optionalText(payload.instructions, 4000) },
        { action: 'Budget set', field: 'approvedBudget', oldValue: null, newValue: budget },
        { action: 'Manager assigned', field: 'assignedTo', oldValue: null, newValue: String(assignedTo) }
      ]
      : [
        { action: 'Activity submitted', field: 'status', oldValue: null, newValue: status },
        { action: 'Budget requested', field: 'requestedBudget', oldValue: null, newValue: budget }
      ];
    if (approvalRequired) {
      entries.push({
        action: 'Approval requested',
        field: 'approvalRequiredFrom',
        oldValue: null,
        newValue: String(approvalFrom),
        note: approvalRole === 'manager' ? 'Manager Approval' : 'Director Approval'
      });
    }
    await logHistory(client, id, req.user, entries);
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }

  // Reloaded only after the transaction's connection is back in the pool. The
  // reload goes through pool.query, and on Vercel the pool holds exactly one
  // connection (max: 1 in db/database.js) -- asking it for a second while this
  // one was still checked out waited out connectionTimeoutMillis and threw.
  // That happened *after* the COMMIT, so the activity was written and the caller
  // still got "Server or database error".
  const saved = await loadActivity(id, req.user);
  res.status(201).json(mapActivity(saved));
}));

// Correcting the request itself. The decision fields are not reachable here --
// a manager cannot edit their way to an approved budget.
router.put('/:id', asyncRoute(async (req, res) => {
  const existing = await loadActivity(req.params.id, req.user);
  assertPlanOpen(existing);
  if (!canEditRequest(req.user, existing)) {
    return res.status(403).json({ message: 'This request has been reviewed and can no longer be edited. Ask the Director to reopen it.' });
  }

  const payload = req.body || {};
  const invalid = validateRequestBody(payload);
  if (invalid) return res.status(400).json({ message: invalid });

  const projectResult = await pool.query(
    `SELECT id, sector FROM projects WHERE id = $1${hasFullScope(req.user) ? '' : ' AND sector = $2'}`,
    hasFullScope(req.user) ? [payload.projectId] : [payload.projectId, req.user.sector]
  );
  if (!projectResult.rowCount) return res.status(404).json({ message: 'Select an existing project before assigning an activity.' });

  const sector = validateSector(payload.sector, projectResult.rows[0].sector);
  if (!sector) return res.status(400).json({ message: 'Choose a valid business operation.' });
  if (!withinScope(req.user, sector)) {
    return res.status(403).json({ message: 'You can only add work in your own business operation.' });
  }

  const requestedBudget = round2(payload.costUsd || 0);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const edited = await client.query(
      `UPDATE activities
       SET project_id = $2, sector = $3, category = $4, activity = $5, description = $6, materials = $7,
           quantity = $8, cost_usd = $9, cost_rwf = $10, cost_cdf = $11, requested_budget = $12,
           signed = $13, scheduled_for = $16::date, updated_at = NOW()
       -- Checked against what was read above: an edit that lands just after the
       -- Director decided the request would change a budget already approved.
       WHERE id = $1 AND status = $14::text AND approval_status = $15::text`,
      [
        existing.id, payload.projectId, sector, payload.category, payload.activity, payload.description || '',
        optionalText(payload.materials, 2000), Number(payload.quantity || 0),
        requestedBudget, Number(payload.costRwf || 0), Number(payload.costCdf ?? payload.costFco ?? 0),
        requestedBudget, Boolean(payload.signed), existing.status, existing.approval_status,
        payload.scheduledFor === undefined ? toDateOnly(existing.scheduled_for) : (payload.scheduledFor || null)
      ]
    );
    if (!edited.rowCount) {
      await safeRollback(client);
      return res.status(409).json({ message: 'This request was decided while you were editing it. Refresh to see the decision.' });
    }
    const entries = [{ action: 'Request edited', field: 'activity', oldValue: existing.activity, newValue: payload.activity }];
    if (round2(existing.requested_budget) !== requestedBudget) {
      entries.push({ action: 'Request edited', field: 'requestedBudget', oldValue: round2(existing.requested_budget), newValue: requestedBudget });
    }
    await logHistory(client, existing.id, req.user, entries);
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }

  res.json(mapActivity(await loadActivity(existing.id, req.user)));
}));

// ---- the approval decision ------------------------------------------------

// Approve or reject, taken by the person the record names as its approver.
//
// Authorisation is the whole point of this route: the caller must be
// approval_required_from (or hold the Director's office when the record names
// that office). Nothing in the request body can widen that -- a browser drawing
// an Approve button on a record that is not the caller's gets a 403 here.
//
// The approver may also change the budget and leave a note in the same call, so
// "cut this to $50, note why, approve" is one decision in the trail rather than
// three unrelated edits.
router.patch('/:id/approval', asyncRoute(async (req, res) => {
  const existing = await loadActivity(req.params.id, req.user);
  const payload = req.body || {};

  const action = String(payload.action || '').toLowerCase();
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ message: 'The decision must be approve or reject.' });
  }

  if (!existing.approval_required) {
    return res.status(400).json({ message: 'This activity does not require approval.' });
  }
  if (existing.approval_status !== 'pending') {
    return res.status(409).json({
      message: `This activity has already been ${existing.approval_status}.`
    });
  }
  if (existing.status === 'Draft') {
    return res.status(400).json({ message: 'This activity is still a draft and has not been submitted for approval.' });
  }
  // Parked work is the Director's to bring back. Without this, the manager a
  // held activity was assigned to could approve it straight out of On Hold.
  if (['On Hold', 'Cancelled', 'Rejected'].includes(existing.status)) {
    return res.status(409).json({ message: `This activity is ${existing.status} and cannot be approved or rejected.` });
  }
  assertPlanOpen(existing);
  // The check the whole workflow rests on: current_user.id must be the account
  // the record is waiting on.
  if (!canApprove(req.user, existing)) {
    return res.status(403).json({
      message: 'Only the person this activity is waiting on can approve or reject it.'
    });
  }

  const rejectionReason = optionalText(payload.rejectionReason ?? payload.reason, 2000);
  if (action === 'reject' && !rejectionReason) {
    return res.status(400).json({ message: 'Say why this activity is being rejected.' });
  }

  // A budget change and an admin note are the Director's tools when answering a
  // manager's request; a manager approving work handed to them may leave a note
  // but may not move the figure the Director set.
  const budgetGiven = Object.prototype.hasOwnProperty.call(payload, 'approvedBudget')
    && payload.approvedBudget !== null && payload.approvedBudget !== '';
  const requestedBudget = round2(existing.requested_budget);
  const previousApproved = existing.approved_budget === null ? null : round2(existing.approved_budget);
  let approvedBudget = previousApproved;
  if (budgetGiven) {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ message: 'Only the Director can change the budget on an activity.' });
    }
    if (!validNumber(payload.approvedBudget)) {
      return res.status(400).json({ message: 'The approved budget must be a valid non-negative number.' });
    }
    approvedBudget = round2(payload.approvedBudget);
  }

  const noteGiven = Object.prototype.hasOwnProperty.call(payload, 'adminNote');
  const adminNote = noteGiven ? optionalText(payload.adminNote, 2000) : (existing.admin_note || '');
  if (noteGiven && !isAdmin(req.user) && !canApprove(req.user, existing)) {
    return res.status(403).json({ message: 'Only the approver can leave a note on this activity.' });
  }
  // Approving a figure the requester did not ask for has to say why, or they
  // are left with less money and no explanation.
  if (action === 'approve' && approvedBudget !== null && approvedBudget !== requestedBudget && !adminNote) {
    return res.status(400).json({ message: 'A note is required when the approved budget differs from the requested budget.' });
  }

  // An approval settles the record at Approved whether or not the figure moved.
  // A trimmed budget is not a different outcome -- it is an approval with a
  // smaller number, and the number, the note and the trail already carry that.
  const approved = action === 'approve';
  const status = approved ? 'Approved' : 'Rejected';
  // On approval the figure that was cleared is recorded, so a record approved
  // without an explicit budget still carries one.
  const settledBudget = approved && approvedBudget === null ? requestedBudget : approvedBudget;

  const entries = [];
  if (budgetGiven && previousApproved !== approvedBudget) {
    entries.push({
      action: 'Budget decided',
      field: 'approvedBudget',
      oldValue: previousApproved === null ? requestedBudget : previousApproved,
      newValue: approvedBudget,
      note: adminNote
    });
  }
  if (noteGiven && adminNote !== (existing.admin_note || '')) {
    entries.push({ action: 'Note recorded', field: 'adminNote', oldValue: existing.admin_note || null, newValue: adminNote });
  }
  entries.push({
    action: approved ? 'Approved' : 'Rejected',
    field: 'approvalStatus',
    oldValue: 'pending',
    newValue: approved ? 'approved' : 'rejected',
    note: approved ? adminNote : rejectionReason
  });
  if (status !== existing.status) {
    entries.push({ action: 'Status changed', field: 'status', oldValue: existing.status, newValue: status, note: approved ? adminNote : rejectionReason });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const written = await client.query(
      `UPDATE activities
       SET approval_status = $2::text,
           approved_by = $3,
           approved_at = NOW(),
           status = $4::text,
           approved = $5,
           approved_budget = $6,
           admin_note = $7,
           rejection_reason = $8,
           -- The approver has now reviewed it, whichever way they decided.
           reviewed_by = $3, reviewed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
         -- Belt and braces against two approvers racing: the row must still be
         -- pending at the moment of the write, not merely when it was read.
         AND approval_status = 'pending'`,
      [
        existing.id, approved ? 'approved' : 'rejected', req.user.id, status, approved,
        settledBudget, adminNote, approved ? '' : rejectionReason
      ]
    );
    // Two approvers answering at once: the guard above lets only one write
    // land, and the other must be told rather than logged as a second decision.
    if (!written.rowCount) {
      await safeRollback(client);
      return res.status(409).json({ message: 'Somebody else decided this activity a moment ago. Refresh to see the outcome.' });
    }
    await logHistory(client, existing.id, req.user, entries);
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }

  res.json(mapActivity(await reloadActivity(existing.id)));
}));

// Whether an external business partner assigned to this operation may see this
// record. The Director's control over what leaves the organisation.
//
// This is only one of the three conditions: the record must also be approved
// and belong to the partner's operation. Turning the flag on therefore does not
// publish anything that has not been approved.
router.patch('/:id/visibility', asyncRoute(async (req, res) => {
  requireAdmin(req.user, 'change what external partners can see');
  const existing = await loadActivity(req.params.id, req.user);
  const { externallyVisible } = req.body || {};
  if (typeof externallyVisible !== 'boolean') {
    return res.status(400).json({ message: 'Say whether this activity should be visible to external partners.' });
  }
  if (externallyVisible === (existing.externally_visible !== false)) {
    return res.status(400).json({ message: 'External visibility is already set that way.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE activities SET externally_visible = $2, updated_at = NOW() WHERE id = $1', [existing.id, externallyVisible]);
    await logHistory(client, existing.id, req.user, [
      {
        action: externallyVisible ? 'Made visible to external partners' : 'Hidden from external partners',
        field: 'externallyVisible',
        oldValue: existing.externally_visible !== false,
        newValue: externallyVisible,
        note: optionalText(req.body?.note, 500)
      }
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }

  res.json(mapActivity(await loadActivity(existing.id, req.user)));
}));

// Submitting a draft into the approval queue. Only its author, or the Director.
router.patch('/:id/submit', asyncRoute(async (req, res) => {
  const existing = await loadActivity(req.params.id, req.user);
  if (existing.status !== 'Draft') {
    return res.status(400).json({ message: 'Only a draft can be submitted for approval.' });
  }
  if (!isAdmin(req.user) && existing.created_by !== req.user.id) {
    return res.status(403).json({ message: 'Only the person who drafted this activity can submit it.' });
  }
  if (!existing.approval_required_from) {
    return res.status(400).json({ message: 'This activity has nobody to approve it. Set an approver first.' });
  }
  assertPlanOpen(existing);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sent = await client.query(
      `UPDATE activities SET status = 'Pending Approval', approval_status = 'pending', updated_at = NOW()
       WHERE id = $1 AND status = 'Draft'`,
      [existing.id]
    );
    if (!sent.rowCount) {
      await safeRollback(client);
      return res.status(409).json({ message: 'This activity has already been sent for approval.' });
    }
    await logHistory(client, existing.id, req.user, [
      { action: 'Submitted for approval', field: 'status', oldValue: 'Draft', newValue: 'Pending Approval' }
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }

  res.json(mapActivity(await loadActivity(existing.id, req.user)));
}));

// Approved budget, status and note in one save, so the trail records one
// coherent decision rather than three unrelated edits. This is the Director's
// wider editing surface -- reopening, parking, sending work back -- and sits
// alongside the approve/reject route above rather than replacing it.
router.patch('/:id/decision', asyncRoute(async (req, res) => {
  requireAdmin(req.user, 'review an activity');
  const existing = await loadActivity(req.params.id, req.user);
  assertPlanOpen(existing);
  const payload = req.body || {};

  const statusGiven = Object.prototype.hasOwnProperty.call(payload, 'status') && payload.status !== null && payload.status !== '';
  const status = statusGiven ? payload.status : existing.status;
  if (!ACTIVITY_STATUSES.includes(status)) {
    return res.status(400).json({ message: 'Activity status is invalid.' });
  }
  if (status !== existing.status && !allowedNextStatuses(existing).includes(status)) {
    return res.status(400).json({ message: `A ${existing.status} activity cannot move straight to ${status}.` });
  }
  // A record waiting on a decision is decided by the person it names, through
  // the approve/reject route. This wider surface used to reach Approved as well
  // -- and its form started on Approved -- so saving a note approved work that
  // was waiting on a manager, over that manager's head, and skipped the
  // approver check entirely. While the decision is open the Director may only
  // park the record or cancel it here.
  const awaitingDecision = decisionOpen(existing);
  if (awaitingDecision && status !== existing.status && !['On Hold', 'Cancelled'].includes(status)) {
    return res.status(409).json({
      code: 'DECISION_PENDING',
      message: 'This activity is waiting for a decision. Approve or reject it with the decision buttons instead.'
    });
  }

  const budgetGiven = Object.prototype.hasOwnProperty.call(payload, 'approvedBudget');
  let approvedBudget = existing.approved_budget === null ? null : Number(existing.approved_budget);
  if (budgetGiven) {
    if (payload.approvedBudget === null || payload.approvedBudget === '') {
      approvedBudget = null;
    } else {
      if (!validNumber(payload.approvedBudget)) {
        return res.status(400).json({ message: 'The approved budget must be a valid non-negative number.' });
      }
      approvedBudget = round2(payload.approvedBudget);
    }
  }

  const noteGiven = Object.prototype.hasOwnProperty.call(payload, 'adminNote');
  // The note supplied by THIS request, as distinct from whatever note the
  // record already carries. The two are different things and conflating them
  // was a real hole: a planned activity created with "From the planning
  // meeting" already had a note, so a later budget change inherited it, passed
  // the "a reason is required" check below, and wrote that stale sentence into
  // the trail as though it were the reason for the change.
  const freshNote = noteGiven ? optionalText(payload.adminNote, 2000) : '';
  const adminNote = noteGiven ? freshNote : existing.admin_note;
  // A refusal has to say why: the manager is left with nothing to act on
  // otherwise. Trimming a budget likewise needs a reason on the record.
  const requestedBudget = round2(existing.requested_budget);
  if (status === 'Rejected' && !adminNote) {
    return res.status(400).json({ message: 'A note is required when a request is rejected.' });
  }
  // Sending finished work back has to say what needs correcting, or the manager
  // has nothing to act on.
  if (status === 'Needs Correction' && !adminNote) {
    return res.status(400).json({ message: 'Say what needs correcting when you send an activity back.' });
  }
  // Section 10: moving an approved budget is a financial change, so it needs a
  // reason given for the change itself -- not one inherited from the record.
  const previousApprovedFigure = existing.approved_budget === null ? null : round2(existing.approved_budget);
  const budgetIsMoving = budgetGiven && previousApprovedFigure !== approvedBudget;
  // The budget of an undecided request is set by the decision itself.
  if (awaitingDecision && budgetIsMoving) {
    return res.status(409).json({
      code: 'DECISION_PENDING',
      message: 'This activity is waiting for a decision. Set the budget when you approve it.'
    });
  }
  if (budgetIsMoving && !freshNote) {
    return res.status(400).json({ message: 'Say why the approved budget is changing.' });
  }
  if (!budgetIsMoving && approvedBudget !== null && approvedBudget !== requestedBudget && !adminNote) {
    return res.status(400).json({ message: 'A note is required when the approved budget differs from the original budget.' });
  }

  const settled = APPROVED_STATUSES.includes(status);
  // Work sent back is no longer submitted: it returns to the manager's court,
  // and they resubmit it once corrected. Reopening completed work does the same.
  const returned = status === 'Needs Correction' || (existing.status === 'Completed' && status !== 'Completed');
  const entries = [];
  const previousApproved = existing.approved_budget === null ? null : round2(existing.approved_budget);
  if (budgetGiven && previousApproved !== approvedBudget) {
    entries.push({
      action: 'Budget decided',
      field: 'approvedBudget',
      // The first decision is measured against what was asked for, which is the
      // comparison the note in the trail should read as.
      oldValue: previousApproved === null ? requestedBudget : previousApproved,
      newValue: approvedBudget,
      // The reason for THIS change. Falling back to the record's standing note
      // would file an unrelated sentence as the justification for moving money.
      note: freshNote || adminNote
    });
  }
  if (status !== existing.status) {
    entries.push({ action: 'Status changed', field: 'status', oldValue: existing.status, newValue: status, note: adminNote });
  }
  if (noteGiven && adminNote !== (existing.admin_note || '')) {
    entries.push({ action: 'Note recorded', field: 'adminNote', oldValue: existing.admin_note || null, newValue: adminNote });
  }
  if (!entries.length) {
    return res.status(400).json({ message: 'Nothing to save: change the approved budget, the status, or the note.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const written = await client.query(
      `UPDATE activities
       SET approved_budget = $2, status = $3::text, admin_note = $4, approved = $5,
           reviewed_by = $6, reviewed_at = NOW(),
           -- A note saved on finished work leaves the day it was finished alone.
           completed_at = CASE
             WHEN $3::text = 'Completed' THEN (CASE WHEN status = 'Completed' THEN completed_at ELSE NOW() END)
             ELSE NULL END,
           completion_submitted_at = CASE WHEN $7 THEN NULL ELSE completion_submitted_at END,
           evidence_status = CASE WHEN $7 AND evidence_status = 'Complete' THEN 'Partial' ELSE evidence_status END,
           -- The Director's wider decision surface reaches the same statuses the
           -- approve/reject route does, so the approval trail has to follow it.
           -- Otherwise a record cleared here would sit in its approver's queue
           -- for ever, and one reopened here would never come back.
           --
           -- On Hold is deliberately absent: parking work is not reopening its
           -- decision. Treating it as 'pending' put held work back in its
           -- approver's queue, where they could approve it out of the hold.
           approval_status = CASE
             WHEN $3::text = ANY($8::text[]) THEN 'approved'
             WHEN $3::text IN ('Rejected', 'Cancelled') THEN 'rejected'
             WHEN $3::text IN ('Pending Approval', 'Draft') THEN 'pending'
             ELSE approval_status END,
           approved_by = CASE
             WHEN $3::text = ANY($8::text[]) THEN COALESCE(approved_by, $6)
             WHEN $3::text IN ('Pending Approval', 'Draft') THEN NULL
             ELSE approved_by END,
           approved_at = CASE
             WHEN $3::text = ANY($8::text[]) THEN COALESCE(approved_at, NOW())
             WHEN $3::text IN ('Pending Approval', 'Draft') THEN NULL
             ELSE approved_at END,
           rejection_reason = CASE
             WHEN $3::text = 'Rejected' THEN $4
             WHEN $3::text = ANY($8::text[]) THEN ''
             ELSE rejection_reason END,
           updated_at = NOW()
       -- The move was validated against the status read above; it only lands
       -- if nobody has moved the record since.
       WHERE id = $1 AND status = $9::text`,
      [existing.id, approvedBudget, status, adminNote, settled, req.user.id, returned, APPROVED_STATUSES, existing.status]
    );
    if (!written.rowCount) {
      await safeRollback(client);
      return res.status(409).json({ message: 'This activity changed while you were reviewing it. Refresh and try again.' });
    }
    await logHistory(client, existing.id, req.user, entries);
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }

  res.json(mapActivity(await loadActivity(existing.id, req.user)));
}));

// ---- status moves ---------------------------------------------------------

router.patch('/:id/status', asyncRoute(async (req, res) => {
  const existing = await loadActivity(req.params.id, req.user);
  const { status } = req.body || {};
  if (!ACTIVITY_STATUSES.includes(status)) {
    return res.status(400).json({ message: 'Activity status is invalid.' });
  }
  if (status === existing.status) {
    return res.status(400).json({ message: `This activity is already ${status}.` });
  }
  if (!allowedNextStatuses(existing).includes(status)) {
    return res.status(400).json({ message: `A ${existing.status} activity cannot move straight to ${status}.` });
  }
  assertPlanOpen(existing);

  // The one move a manager owns on their own work: starting what has been
  // approved. Approving and rejecting go through /approval, which checks that
  // the caller is the named approver; everything else is the Director's.
  // Unassigned work in a sector is its managers' to start, not a team member's.
  const ownsIt = !isAdmin(req.user)
    && withinScope(req.user, existing.sector)
    && (existing.assigned_to === null ? req.user.role === 'manager' : existing.assigned_to === req.user.id);
  const managerStart = ownsIt
    && status === 'In Progress'
    && ['Approved', 'Budget Adjusted', 'Needs Correction'].includes(existing.status);
  // Planned work is approved when it is added to a month, before the month is
  // confirmed. Starting it then led straight to expenses the API refuses, so
  // the month has to be confirmed first.
  if (managerStart && existing.plan_status === 'Draft') {
    return res.status(409).json({ message: 'This month has not been confirmed yet. Ask the Director to confirm it before starting the work.' });
  }
  // A record still waiting on somebody cannot be started around them.
  if (managerStart && existing.approval_required && existing.approval_status !== 'approved') {
    return res.status(403).json({ message: 'This activity has not been approved yet.' });
  }
  if (!managerStart) requireAdmin(req.user, 'change the status of an activity');

  const note = optionalText(req.body?.note, 2000);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const written = await client.query(
      `UPDATE activities
       SET status = $2::text,
           approved = CASE WHEN $2::text = ANY($3::text[]) THEN TRUE ELSE approved END,
           completed_at = CASE WHEN $2::text = 'Completed' THEN NOW() ELSE NULL END,
           -- Same reason as the decision route: a status move that clears,
           -- refuses or reopens a record has to carry the approval trail with
           -- it, or the approver's queue and the register disagree. On Hold
           -- keeps the decision as it stood, for the same reason as there.
           approval_status = CASE
             WHEN $2::text = ANY($3::text[]) THEN 'approved'
             WHEN $2::text IN ('Rejected', 'Cancelled') THEN 'rejected'
             WHEN $2::text IN ('Pending Approval', 'Draft') THEN 'pending'
             ELSE approval_status END,
           approved_by = CASE
             WHEN $2::text = ANY($3::text[]) THEN COALESCE(approved_by, $4)
             WHEN $2::text IN ('Pending Approval', 'Draft') THEN NULL
             ELSE approved_by END,
           approved_at = CASE
             WHEN $2::text = ANY($3::text[]) THEN COALESCE(approved_at, NOW())
             WHEN $2::text IN ('Pending Approval', 'Draft') THEN NULL
             ELSE approved_at END,
           rejection_reason = CASE
             WHEN $2::text = 'Rejected' THEN $5
             WHEN $2::text = ANY($3::text[]) THEN ''
             ELSE rejection_reason END,
           -- Reopening finished work clears its hand-back. Left set, the record
           -- read "completion submitted" for ever and the manager could never
           -- hand it back again.
           completion_submitted_at = CASE WHEN $7 THEN NULL ELSE completion_submitted_at END,
           evidence_status = CASE WHEN $7 AND evidence_status = 'Complete' THEN 'Partial' ELSE evidence_status END,
           updated_at = NOW()
       WHERE id = $1 AND status = $6::text`,
      [existing.id, status, APPROVED_STATUSES, req.user.id, note, existing.status, existing.status === 'Completed']
    );
    if (!written.rowCount) {
      await safeRollback(client);
      return res.status(409).json({ message: 'This activity changed a moment ago. Refresh and try again.' });
    }
    await logHistory(client, existing.id, req.user, [
      { action: 'Status changed', field: 'status', oldValue: existing.status, newValue: status, note }
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }

  res.json(mapActivity(await loadActivity(existing.id, req.user)));
}));

// The manager hands finished work back with its evidence. This does not close
// the record: the Director reviews the evidence and sets Completed.
router.post('/:id/completion', asyncRoute(async (req, res) => {
  const existing = await loadActivity(req.params.id, req.user);
  // Finished work is handed back by whoever carries it: the manager it was
  // assigned to, or -- for unassigned work -- a manager of that sector.
  const carriesIt = isAdmin(req.user) || (
    withinScope(req.user, existing.sector)
    && (existing.assigned_to === null ? req.user.role === 'manager' : existing.assigned_to === req.user.id)
  );
  if (!carriesIt) {
    return res.status(403).json({ message: 'Only the manager carrying out this activity can submit it as finished.' });
  }
  assertPlanOpen(existing);
  if (!WORKABLE_STATUSES.includes(existing.status)) {
    return res.status(400).json({ message: `A ${existing.status} activity cannot be submitted as finished.` });
  }
  if (existing.completion_submitted_at) {
    return res.status(409).json({ message: 'This activity has already been submitted as finished and is waiting for the Director.' });
  }
  const evidence = await pool.query('SELECT COUNT(*)::int AS total FROM activity_evidence WHERE activity_id = $1', [existing.id]);
  if (!evidence.rows[0].total) {
    return res.status(400).json({ message: 'Attach the receipts, invoices or photographs for this work before submitting it as finished.' });
  }

  const note = optionalText(req.body?.note, 2000);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const handedBack = await client.query(
      `UPDATE activities SET completion_submitted_at = NOW(), evidence_status = 'Complete', updated_at = NOW()
       WHERE id = $1 AND status = $2::text AND completion_submitted_at IS NULL`,
      [existing.id, existing.status]
    );
    if (!handedBack.rowCount) {
      await safeRollback(client);
      return res.status(409).json({ message: 'This activity changed a moment ago. Refresh and try again.' });
    }
    await logHistory(client, existing.id, req.user, [
      { action: 'Completion submitted', field: 'completionSubmittedAt', oldValue: existing.completion_submitted_at, newValue: 'submitted for review', note }
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }

  res.json(mapActivity(await loadActivity(existing.id, req.user)));
}));

// ---- assignment -----------------------------------------------------------

// Handing the work to a different manager, or moving the deadline. The budget
// is not reachable here; that is the decision route.
router.patch('/:id/assignment', asyncRoute(async (req, res) => {
  requireAdmin(req.user, 'assign an activity');
  const existing = await loadActivity(req.params.id, req.user);
  assertPlanOpen(existing);
  const payload = req.body || {};

  const managerGiven = Object.prototype.hasOwnProperty.call(payload, 'assignedTo');
  const deadlineGiven = Object.prototype.hasOwnProperty.call(payload, 'deadline');
  const scheduledGiven = Object.prototype.hasOwnProperty.call(payload, 'scheduledFor');
  const instructionsGiven = Object.prototype.hasOwnProperty.call(payload, 'instructions');
  if (!managerGiven && !deadlineGiven && !scheduledGiven && !instructionsGiven) {
    return res.status(400).json({ message: 'Provide a manager, a date, a deadline, or instructions.' });
  }

  let assignedTo = existing.assigned_to;
  if (managerGiven) {
    const unassigning = payload.assignedTo === null || payload.assignedTo === '';
    assignedTo = unassigning ? null : parseId(payload.assignedTo);
    if (!unassigning && !assignedTo) {
      return res.status(400).json({ message: 'The selected manager is invalid.' });
    }
    if (assignedTo) {
      const manager = await pool.query(
        "SELECT id, sector, name, role, covers_all_sectors AS \"coversAllSectors\" FROM users WHERE id = $1 AND role = 'manager' AND status = 'active'",
        [assignedTo]
      );
      if (!manager.rowCount) return res.status(400).json({ message: 'The selected manager is invalid.' });
      if (!withinScope(manager.rows[0], existing.sector)) {
        return res.status(400).json({ message: 'That manager works in a different business operation. Pick a manager from this one.' });
      }
    }
  }

  let scheduledFor = toDateOnly(existing.scheduled_for);
  if (scheduledGiven) {
    scheduledFor = payload.scheduledFor ? String(payload.scheduledFor).slice(0, 10) : null;
    if (scheduledFor && !isValidDate(scheduledFor)) {
      return res.status(400).json({ message: 'The date of the activity must be a real date.' });
    }
  }
  let deadline = toDateOnly(existing.deadline);
  if (deadlineGiven) {
    deadline = payload.deadline ? String(payload.deadline).slice(0, 10) : null;
    if (deadline && !isValidDate(deadline)) {
      return res.status(400).json({ message: 'The deadline must be a real date.' });
    }
  }

  const instructions = instructionsGiven ? optionalText(payload.instructions, 4000) : existing.instructions;
  const entries = [];
  if (managerGiven && assignedTo !== existing.assigned_to) {
    entries.push({ action: 'Manager assigned', field: 'assignedTo', oldValue: existing.assigned_to, newValue: assignedTo, note: optionalText(payload.note, 2000) });
  }
  if (deadlineGiven && deadline !== toDateOnly(existing.deadline)) {
    entries.push({ action: 'Deadline changed', field: 'deadline', oldValue: toDateOnly(existing.deadline), newValue: deadline });
  }
  if (scheduledGiven && scheduledFor !== toDateOnly(existing.scheduled_for)) {
    entries.push({ action: 'Date changed', field: 'scheduledFor', oldValue: toDateOnly(existing.scheduled_for), newValue: scheduledFor });
  }
  if (instructionsGiven && instructions !== (existing.instructions || '')) {
    entries.push({ action: 'Instructions updated', field: 'instructions', oldValue: existing.instructions || null, newValue: instructions });
  }
  if (!entries.length) return res.status(400).json({ message: 'Nothing to change.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE activities
       SET assigned_to = $2, deadline = $3::date, instructions = $4, scheduled_for = $5::date,
           assigned_at = CASE WHEN $2::int IS DISTINCT FROM assigned_to THEN NOW() ELSE assigned_at END,
           accepted_at = CASE WHEN $2::int IS DISTINCT FROM assigned_to THEN NULL ELSE accepted_at END,
           -- Handing the work to someone else hands the decision over with it,
           -- but only while it is still undecided: a record already approved
           -- keeps the name of whoever approved it.
           approval_required_from = CASE
             WHEN approval_required_role = 'manager' AND approval_status = 'pending' THEN $2::int
             ELSE approval_required_from END,
           updated_at = NOW()
       WHERE id = $1`,
      [existing.id, assignedTo, deadline, instructions, scheduledFor]
    );
    await logHistory(client, existing.id, req.user, entries);
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }

  res.json(mapActivity(await loadActivity(existing.id, req.user)));
}));

// ---- budget change requests ----------------------------------------------

// A manager cannot move a budget the Director set. They ask, with a reason, and
// the Director answers. The activity's own budget is only ever written by the
// approval below, which keeps the original figure intact in requested_budget.
// A budget can only be changed once there is an approved one to change. Before
// that the Director sets the figure in the approval itself; after refusal or
// cancellation there is nothing left to fund.
const BUDGET_CHANGEABLE_STATUSES = ['Approved', 'Budget Adjusted', 'In Progress', 'Needs Correction', 'On Hold', 'Completed'];

router.post('/:id/budget-requests', asyncRoute(async (req, res) => {
  const existing = await loadActivity(req.params.id, req.user);
  if (!isAdmin(req.user) && (!withinScope(req.user, existing.sector) || req.user.role !== 'manager')) {
    return res.status(403).json({ message: 'Only a manager in this business operation can ask for a different budget.' });
  }
  assertPlanOpen(existing);
  if (!BUDGET_CHANGEABLE_STATUSES.includes(existing.status)) {
    return res.status(400).json({ message: `A ${existing.status} activity has no approved budget to change yet.` });
  }
  const { amount, reason } = req.body || {};
  if (!validNumber(amount)) {
    return res.status(400).json({ message: 'The amount you need must be a valid non-negative number.' });
  }
  if (!requiredText(reason)) {
    return res.status(400).json({ message: 'Say why the budget needs to change.' });
  }
  const currentBudget = existing.approved_budget === null ? round2(existing.requested_budget) : round2(existing.approved_budget);
  const requestedAmount = round2(amount);
  if (requestedAmount === currentBudget) {
    return res.status(400).json({ message: 'That is the budget the activity already carries.' });
  }
  const open = await pool.query("SELECT id FROM activity_budget_requests WHERE activity_id = $1 AND status = 'Pending'", [existing.id]);
  if (open.rowCount) {
    return res.status(400).json({ message: 'A budget change is already waiting for the Director on this activity.' });
  }

  const client = await pool.connect();
  let saved;
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO activity_budget_requests
         (activity_id, current_budget, requested_amount, reason, requested_by, requested_by_name)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [existing.id, currentBudget, requestedAmount, optionalText(reason, 2000), req.user.id, req.user.name]
    );
    saved = result.rows[0];
    await logHistory(client, existing.id, req.user, [{
      action: 'Budget change requested', field: 'budgetRequest',
      oldValue: currentBudget, newValue: requestedAmount, note: optionalText(reason, 2000)
    }]);
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }

  res.status(201).json(mapBudgetRequest(saved));
}));

router.patch('/:id/budget-requests/:requestId', asyncRoute(async (req, res) => {
  requireAdmin(req.user, 'decide a budget change');
  const existing = await loadActivity(req.params.id, req.user);
  assertPlanOpen(existing);
  const { status, decisionNote } = req.body || {};
  if (!['Approved', 'Declined'].includes(status)) {
    return res.status(400).json({ message: 'Approve or decline the budget change.' });
  }
  if (status === 'Declined' && !requiredText(decisionNote)) {
    return res.status(400).json({ message: 'Say why the budget change is declined.' });
  }
  if (status === 'Approved' && !BUDGET_CHANGEABLE_STATUSES.includes(existing.status)) {
    return res.status(400).json({ message: `A ${existing.status} activity has no approved budget to change. Decline the request instead.` });
  }
  const requestId = parseId(req.params.requestId);
  if (!requestId) return res.status(404).json({ message: 'That budget change is not waiting for a decision.' });

  const found = await pool.query(
    "SELECT * FROM activity_budget_requests WHERE id = $1 AND activity_id = $2 AND status = 'Pending'",
    [requestId, existing.id]
  );
  if (!found.rowCount) return res.status(404).json({ message: 'That budget change is not waiting for a decision.' });
  const request = found.rows[0];
  const note = optionalText(decisionNote, 2000);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Only a request still Pending at the moment of the write is decided, so two
    // answers given at once cannot both land.
    const decided = await client.query(
      `UPDATE activity_budget_requests
       SET status = $2, decision_note = $3, decided_by = $4, decided_by_name = $5, decided_at = NOW()
       WHERE id = $1 AND status = 'Pending'`,
      [request.id, status, note, req.user.id, req.user.name]
    );
    if (!decided.rowCount) {
      await safeRollback(client);
      return res.status(409).json({ message: 'This budget change was decided a moment ago. Refresh to see the outcome.' });
    }
    const entries = [{
      action: `Budget change ${status.toLowerCase()}`, field: 'budgetRequest',
      oldValue: round2(request.current_budget), newValue: round2(request.requested_amount), note
    }];
    if (status === 'Approved') {
      // Locked, so a spend recorded at the same instant cannot slip under a
      // budget that is about to shrink beneath it.
      const position = await budgetPosition(client, existing.id);
      if (cents(request.requested_amount) < cents(position.spent)) {
        await safeRollback(client);
        return res.status(400).json({
          message: `${round2(position.spent)} has already been spent on this activity, so its budget cannot be set below that.`
        });
      }
      // Only the revised figure moves. requested_budget still holds the
      // original, so the activity carries both from here on. Finished and parked
      // work keeps its status; live work reads as Budget Adjusted, which every
      // live status may move to.
      const nextStatus = ['Completed', 'On Hold'].includes(existing.status) ? existing.status : 'Budget Adjusted';
      await client.query(
        `UPDATE activities
         SET approved_budget = $2, status = $5::text,
             admin_note = $3, reviewed_by = $4, reviewed_at = NOW(), approved = TRUE,
             approval_status = CASE WHEN approval_required THEN 'approved' ELSE approval_status END,
             approved_by = COALESCE(approved_by, $4), approved_at = COALESCE(approved_at, NOW()),
             updated_at = NOW()
         WHERE id = $1`,
        [existing.id, round2(request.requested_amount), note || existing.admin_note, req.user.id, nextStatus]
      );
      entries.push({
        action: 'Budget decided', field: 'approvedBudget',
        oldValue: round2(request.current_budget), newValue: round2(request.requested_amount),
        note: note || request.reason
      });
      if (nextStatus !== existing.status) {
        entries.push({ action: 'Status changed', field: 'status', oldValue: existing.status, newValue: nextStatus, note });
      }
    }
    await logHistory(client, existing.id, req.user, entries);
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }

  const refreshed = await pool.query('SELECT * FROM activity_budget_requests WHERE id = $1', [request.id]);
  res.json({
    budgetRequest: mapBudgetRequest(refreshed.rows[0]),
    activity: mapActivity(await loadActivity(existing.id, req.user))
  });
}));

router.get('/:id/budget-requests', asyncRoute(async (req, res) => {
  const existing = await loadActivity(req.params.id, req.user);
  const result = await pool.query('SELECT * FROM activity_budget_requests WHERE activity_id = $1 ORDER BY created_at DESC', [existing.id]);
  res.json(result.rows.map(mapBudgetRequest));
}));

router.delete('/:id', asyncRoute(async (req, res) => {
  const existing = await loadActivity(req.params.id, req.user);
  // A manager may withdraw their own request while it is still undecided. This
  // used to test for 'Pending Review', a status the migration retired, so the
  // branch could never be taken and every withdrawal was refused.
  const withdrawable = existing.created_by === req.user.id
    && ['Draft', 'Pending Approval'].includes(existing.status)
    && existing.approval_status === 'pending';
  if (!isAdmin(req.user) && !withdrawable) {
    return res.status(403).json({ message: 'Only the Director can delete a reviewed activity.' });
  }
  assertPlanOpen(existing);
  // Money recorded against the work is part of the month's accounts. Deleting
  // the activity took its expenses with it by cascade, silently; it is
  // cancelled instead, which keeps them.
  const spent = await pool.query('SELECT COUNT(*)::int AS total FROM activity_expenses WHERE activity_id = $1', [existing.id]);
  if (spent.rows[0].total) {
    return res.status(409).json({ message: 'Expenses have been recorded against this activity, so it cannot be deleted. Cancel it instead.' });
  }
  const files = await pool.query('SELECT stored_name FROM activity_evidence WHERE activity_id = $1', [existing.id]);

  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    result = await client.query('DELETE FROM activities WHERE id = $1 RETURNING *', [existing.id]);
    // A planned activity added to a confirmed month raised the month's approved
    // allocation, so removing it lowers the allocation by the same amount and
    // says so in the month's history -- otherwise the month kept money for work
    // that no longer exists.
    if (result.rowCount && existing.monthly_plan_id && existing.plan_status === 'Confirmed') {
      const budget = round2(existing.approved_budget === null ? existing.requested_budget : existing.approved_budget);
      const plan = await client.query(
        `UPDATE monthly_plans SET approved_budget = GREATEST(0, approved_budget - $2), updated_at = NOW()
         WHERE id = $1 AND status = 'Confirmed'
         RETURNING approved_budget + $2 AS old_value, approved_budget AS new_value`,
        [existing.monthly_plan_id, budget]
      );
      if (plan.rowCount && budget) {
        await client.query(
          `INSERT INTO monthly_plan_history (plan_id, action, field, old_value, new_value, note, actor_id, actor_name)
           VALUES ($1, 'Approved allocation changed', 'approvedBudget', $2, $3, $4, $5, $6)`,
          [
            existing.monthly_plan_id, String(round2(plan.rows[0].old_value)), String(round2(plan.rows[0].new_value)),
            `Activity deleted: ${String(existing.activity).slice(0, 200)}`, req.user.id, req.user.name
          ]
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }
  // The rows are already gone by cascade; the bytes follow. A file that cannot
  // be removed is not worth failing a completed delete over.
  await Promise.all(files.rows.map((row) => deleteFile(EVIDENCE_FOLDER, row.stored_name)));
  res.json({ message: 'Activity deleted successfully.', deletedActivity: mapActivity(result.rows[0]) });
}));

// ---- evidence -------------------------------------------------------------

router.get('/:id/evidence', asyncRoute(async (req, res) => {
  const existing = await loadActivity(req.params.id, req.user);
  const result = await pool.query('SELECT * FROM activity_evidence WHERE activity_id = $1 ORDER BY created_at DESC', [existing.id]);
  res.json(result.rows.map(mapEvidence));
}));

// Decides whether the caller may upload BEFORE multer reads the body. Checked
// after, any signed-in account could make the server hold 100 MB in memory for
// an activity it cannot even see, only to be refused at the end.
const authorizeEvidenceUpload = asyncRoute(async (req, res, next) => {
  const existing = await loadActivity(req.params.id, req.user);
  if (!canAttachEvidence(req.user, existing)) {
    return res.status(403).json({ message: 'You cannot attach evidence to this activity.' });
  }
  assertPlanOpen(existing);
  req.activity = existing;
  next();
});

router.post('/:id/evidence', authorizeEvidenceUpload, upload.array('files', 10), asyncRoute(async (req, res) => {
  // Nothing has been written anywhere yet -- the files are still in memory --
  // so a refused upload leaves no bytes behind and needs no cleanup.
  const existing = req.activity;
  if (!req.files?.length) return res.status(400).json({ message: 'Select at least one receipt, invoice or photograph to upload.' });

  const kind = EVIDENCE_KINDS.includes(req.body.kind) ? req.body.kind : 'Receipt';
  const amount = validNumber(req.body.amount || 0) ? round2(req.body.amount || 0) : 0;
  const note = optionalText(req.body.note, 500);

  // Section 7: proof money was spent and proof the work was done are different
  // things, counted and reported separately.
  const evidenceType = req.body.evidenceType === 'activity' ? 'activity' : 'payment';

  // Payment evidence may name the expense it belongs to, which is what lets the
  // review say "3 of 3 expenses documented" rather than merely counting files.
  let expenseId = null;
  if (req.body.expenseId) {
    if (evidenceType !== 'payment') {
      return res.status(400).json({ message: 'Only payment evidence can be attached to an expense.' });
    }
    expenseId = parseId(req.body.expenseId);
    if (!expenseId) return res.status(404).json({ message: 'That expense does not belong to this activity.' });
    const expense = await pool.query('SELECT id FROM activity_expenses WHERE id = $1 AND activity_id = $2', [expenseId, existing.id]);
    if (!expense.rowCount) return res.status(404).json({ message: 'That expense does not belong to this activity.' });
  }

  // Stored first, recorded second. A file with no row is an orphan nobody sees;
  // a row with no file is a broken link in the evidence trail, so the write
  // that can fail goes first and its objects are removed if the rows fail.
  const stored = [];
  try {
    for (const file of req.files) {
      const storedName = storedFileName(file.originalname);
      await saveFile(EVIDENCE_FOLDER, storedName, file.buffer);
      stored.push({ file, storedName });
    }
  } catch (error) {
    await Promise.all(stored.map((item) => deleteFile(EVIDENCE_FOLDER, item.storedName)));
    // The disk error names the absolute folder on the server, which is nobody's
    // business in the browser; it goes to the server log instead.
    console.error('Evidence could not be stored:', error);
    return res.status(502).json({ message: 'The file could not be saved. Please try again.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const saved = [];
    for (const [index, { file, storedName }] of stored.entries()) {
      const result = await client.query(
        `INSERT INTO activity_evidence
           (activity_id, kind, original_name, stored_name, mime_type, size_bytes, amount, note,
            uploaded_by, uploaded_by_name, evidence_type, expense_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [
          existing.id, kind, file.originalname.slice(0, 255), storedName, file.mimetype, file.size,
          // One amount typed for one upload is one figure: carried on the first
          // file only, so three receipts for a purchase do not read as three.
          index === 0 ? amount : 0, note, req.user.id, req.user.name, evidenceType, expenseId
        ]
      );
      saved.push(mapEvidence(result.rows[0]));
    }
    await client.query(
      `UPDATE activities SET evidence_status = CASE WHEN evidence_status = 'Pending' THEN 'Partial' ELSE evidence_status END,
       updated_at = NOW() WHERE id = $1`,
      [existing.id]
    );
    await logHistory(client, existing.id, req.user, saved.map((item) => ({
      action: 'Evidence uploaded', field: 'evidence', oldValue: null, newValue: `${item.kind}: ${item.originalName}`
    })));
    await client.query('COMMIT');
    res.status(201).json(saved);
  } catch (error) {
    await safeRollback(client);
    await Promise.all(stored.map((item) => deleteFile(EVIDENCE_FOLDER, item.storedName)));
    throw error;
  } finally {
    client.release();
  }
}));

router.get('/:id/evidence/:evidenceId/file', asyncRoute(async (req, res) => {
  const existing = await loadActivity(req.params.id, req.user);
  const evidenceId = parseId(req.params.evidenceId);
  if (!evidenceId) return res.status(404).json({ message: 'Evidence not found.' });
  const result = await pool.query(
    'SELECT * FROM activity_evidence WHERE id = $1 AND activity_id = $2',
    [evidenceId, existing.id]
  );
  if (!result.rowCount) return res.status(404).json({ message: 'Evidence not found.' });

  const record = result.rows[0];
  const file = await readFile(EVIDENCE_FOLDER, record.stored_name);
  if (!file) return res.status(404).json({ message: 'The stored file is missing from the server.' });

  res.type(record.mime_type);
  res.setHeader('Content-Disposition', contentDisposition(record.original_name));
  // Who may read this file is decided per request, so no shared cache and no
  // browser may keep a copy that outlives the check.
  res.setHeader('Cache-Control', 'private, no-store');
  // A read that fails part-way ends this response instead of leaving it hanging.
  file.once('error', () => (res.headersSent ? res.destroy() : res.status(500).json({ message: 'The stored file could not be read.' })));
  return file.pipe(res);
}));

router.delete('/:id/evidence/:evidenceId', asyncRoute(async (req, res) => {
  const existing = await loadActivity(req.params.id, req.user);
  requireAdmin(req.user, 'remove evidence');
  assertPlanOpen(existing);
  const evidenceId = parseId(req.params.evidenceId);
  if (!evidenceId) return res.status(404).json({ message: 'Evidence not found.' });

  // The row and its trail entry go together or not at all; the bytes are
  // removed only once both are committed, so a failure can never leave evidence
  // gone with no record of who removed it.
  const client = await pool.connect();
  let removed;
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'DELETE FROM activity_evidence WHERE id = $1 AND activity_id = $2 RETURNING *',
      [evidenceId, existing.id]
    );
    if (!result.rowCount) {
      await safeRollback(client);
      return res.status(404).json({ message: 'Evidence not found.' });
    }
    removed = result.rows[0];
    await logHistory(client, existing.id, req.user, [
      { action: 'Evidence removed', field: 'evidence', oldValue: removed.original_name, newValue: null }
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }

  await deleteFile(EVIDENCE_FOLDER, removed.stored_name);
  res.json({ message: 'Evidence removed.', deletedEvidence: mapEvidence(removed) });
}));

// ---- what was actually spent ----------------------------------------------
//
// Sections 5, 6 and 8. The manager records a spend against work the Director
// assigned them; the platform checks it against what is left, stores it with
// its payment evidence, and derives the remaining balance from the rows.
//
// No money moves. This records a spend that happened outside the platform.

// The approved budget and what has been spent so far, read together so the
// remaining balance cannot be computed from two different moments.
async function budgetPosition(client, activityId) {
  const result = await client.query(
    `SELECT a.approved_budget, a.requested_budget, a.monthly_plan_id,
            COALESCE((SELECT SUM(e.amount) FROM activity_expenses e WHERE e.activity_id = a.id), 0) AS spent
     FROM activities a WHERE a.id = $1
     -- Locked for the transaction, so two spends submitted at the same instant
     -- cannot each read the same remaining balance and both fit inside it.
     FOR UPDATE OF a`,
    [activityId]
  );
  const row = result.rows[0];
  const approved = row.approved_budget === null ? round2(row.requested_budget) : round2(row.approved_budget);
  return { approved, spent: round2(row.spent), planId: row.monthly_plan_id };
}

router.get('/:id/expenses', asyncRoute(async (req, res) => {
  const existing = await loadActivity(req.params.id, req.user);
  const result = await pool.query(
    `SELECT e.*,
            (SELECT COUNT(*) FROM activity_evidence ev
              WHERE ev.expense_id = e.id AND ev.evidence_type = 'payment')::int AS evidence_count
     FROM activity_expenses e WHERE e.activity_id = $1 ORDER BY e.spent_on DESC, e.id DESC`,
    [existing.id]
  );
  const approved = existing.approved_budget === null ? round2(existing.requested_budget) : round2(existing.approved_budget);
  const spent = result.rows.reduce((total, row) => total + cents(row.amount), 0);
  res.json({
    expenses: result.rows.map(mapExpense),
    approvedBudget: approved,
    totalSpent: fromCents(spent),
    remaining: fromCents(cents(approved) - spent)
  });
}));

router.post('/:id/expenses', asyncRoute(async (req, res) => {
  const existing = await loadActivity(req.params.id, req.user);
  // Section 13: the manager the work is assigned to, or the Director. Not
  // another manager, and not on the strength of a button being on screen.
  if (!canRecordExpense(req.user, existing)) {
    return res.status(403).json({ message: 'You can only record expenses against activities assigned to you.' });
  }
  if (existing.approval_required && existing.approval_status !== 'approved') {
    return res.status(400).json({ message: 'This activity has not been approved yet.' });
  }
  if (DEAD_STATUSES.includes(existing.status)) {
    return res.status(400).json({ message: `A ${existing.status} activity cannot carry expenses.` });
  }

  const payload = req.body || {};
  if (!validNumber(payload.amount, { minimum: 0.01 })) {
    return res.status(400).json({ message: 'The amount spent must be greater than zero.' });
  }
  const spentOn = payload.spentOn ? String(payload.spentOn).slice(0, 10) : null;
  if (!spentOn || !isValidDate(spentOn)) {
    return res.status(400).json({ message: 'The date spent must be a real date.' });
  }
  if (!PAYMENT_METHODS.includes(payload.paymentMethod)) {
    return res.status(400).json({ message: `The payment method must be one of: ${PAYMENT_METHODS.join(', ')}.` });
  }
  if (!requiredText(payload.description)) {
    return res.status(400).json({ message: 'Describe what the money was spent on.' });
  }

  const amount = round2(payload.amount);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // A closed month is a signed-off account; nothing more is recorded against
    // it. A month still in Draft has no confirmed allocation yet, so there is no
    // money handed over to spend.
    if (existing.monthly_plan_id) {
      // Locked, so the month cannot be closed between this check and the insert.
      const plan = await client.query('SELECT status FROM monthly_plans WHERE id = $1 FOR UPDATE', [existing.monthly_plan_id]);
      if (plan.rowCount && plan.rows[0].status === 'Closed') {
        await safeRollback(client);
        return res.status(400).json({ message: 'This month has been closed. Ask the Director to reopen it.' });
      }
      if (plan.rowCount && plan.rows[0].status === 'Draft') {
        await safeRollback(client);
        return res.status(400).json({ message: 'This month has not been confirmed yet, so nothing can be spent against it.' });
      }
    }

    const position = await budgetPosition(client, existing.id);
    // Section 8, the rule that makes the budget mean something: a spend past
    // what is left is refused, and the manager is told what to do instead.
    if (!fitsRemaining(amount, position.approved, position.spent)) {
      await safeRollback(client);
      return res.status(400).json({
        message: OVER_BUDGET_MESSAGE,
        approvedBudget: position.approved,
        alreadySpent: position.spent,
        remaining: fromCents(cents(position.approved) - cents(position.spent)),
        attempted: amount
      });
    }

    const inserted = await client.query(
      `INSERT INTO activity_expenses
         (activity_id, amount, spent_on, payment_method, description, recorded_by, recorded_by_name)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7) RETURNING *`,
      [
        existing.id, amount, spentOn, payload.paymentMethod,
        optionalText(payload.description, 2000), req.user.id, req.user.name
      ]
    );
    await logHistory(client, existing.id, req.user, [
      {
        action: 'Expense recorded', field: 'actualExpense',
        oldValue: position.spent, newValue: fromCents(cents(position.spent) + cents(amount)),
        note: optionalText(payload.description, 500)
      }
    ]);
    await client.query('COMMIT');

    const remaining = fromCents(cents(position.approved) - cents(position.spent) - cents(amount));
    res.status(201).json({
      expense: mapExpense({ ...inserted.rows[0], evidence_count: 0 }),
      approvedBudget: position.approved,
      totalSpent: fromCents(cents(position.spent) + cents(amount)),
      remaining
    });
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }
}));

// Section 13: a manager may not delete financial records. Only the Director,
// and the removal is written to the trail with the figure it took out.
router.delete('/:id/expenses/:expenseId', asyncRoute(async (req, res) => {
  const existing = await loadActivity(req.params.id, req.user);
  if (!canDeleteExpense(req.user)) {
    return res.status(403).json({ message: 'Only the Director can remove a recorded expense.' });
  }
  assertPlanOpen(existing);
  const expenseId = parseId(req.params.expenseId);
  if (!expenseId) return res.status(404).json({ message: 'Expense not found.' });

  const client = await pool.connect();
  // The payment evidence filed against this expense is removed with it by
  // cascade. Its rows are read first so the stored files go too, rather than
  // being left in storage with nothing pointing at them.
  let orphanedFiles = [];
  try {
    await client.query('BEGIN');
    const files = await client.query(
      'SELECT stored_name, original_name FROM activity_evidence WHERE expense_id = $1 AND activity_id = $2',
      [expenseId, existing.id]
    );
    const removed = await client.query(
      'DELETE FROM activity_expenses WHERE id = $1 AND activity_id = $2 RETURNING amount, description',
      [expenseId, existing.id]
    );
    if (!removed.rowCount) {
      await safeRollback(client);
      return res.status(404).json({ message: 'Expense not found.' });
    }
    orphanedFiles = files.rows;
    await logHistory(client, existing.id, req.user, [
      {
        action: 'Expense removed', field: 'actualExpense',
        oldValue: round2(removed.rows[0].amount), newValue: null,
        note: optionalText(req.body?.reason, 500) || removed.rows[0].description
      },
      ...files.rows.map((file) => ({
        action: 'Evidence removed', field: 'evidence', oldValue: file.original_name, newValue: null,
        note: 'Removed with its expense'
      }))
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }
  await Promise.all(orphanedFiles.map((file) => deleteFile(EVIDENCE_FOLDER, file.stored_name)));

  res.json({ message: 'Expense removed. The activity budget has been restored by that amount.' });
}));

function mapExpense(row) {
  return {
    id: row.id,
    activityId: row.activity_id,
    amount: round2(row.amount),
    spentOn: toDateOnly(row.spent_on),
    paymentMethod: row.payment_method,
    description: row.description,
    recordedBy: row.recorded_by ?? null,
    recordedByName: row.recorded_by_name || '',
    // Section 9: an expense with no receipt is what the Director is looking for.
    evidenceCount: row.evidence_count ?? 0,
    createdAt: row.created_at
  };
}

router.get('/:id/history', asyncRoute(async (req, res) => {
  const existing = await loadActivity(req.params.id, req.user);
  const result = await pool.query(
    'SELECT * FROM activity_history WHERE activity_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200',
    [existing.id]
  );
  res.json(result.rows.map(mapHistory));
}));

router.use((error, req, res, next) => {
  if (error instanceof ActivityError) {
    return res.status(error.status).json({ message: error.message });
  }
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? `Each evidence file must be ${MAX_EVIDENCE_LABEL} or smaller.`
      : error.code === 'LIMIT_FILE_COUNT'
        ? 'Upload at most 10 evidence files at a time.'
        : 'The evidence upload was rejected.';
    return res.status(400).json({ message });
  }
  return next(error);
});

export default router;
