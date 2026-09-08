// Activity register and review workflow.
//
// A manager raises an activity with the budget they need; the Director reviews
// it, may approve a smaller figure, leaves a note, and sets the status. The
// requested figure is never overwritten. The manager then does the work,
// attaches evidence, and hands it back; the Director reviews the evidence and
// closes the record. Every material change is appended to activity_history.

import express from 'express';
import multer from 'multer';
import { pool } from '../db/database.js';
import { ACTIVITY_STATUSES, ACTIVITY_ORIGINS } from '../db/activitySchema.js';
import { asyncRoute, isAdmin, managerScope, requiredText, validNumber, validateSector } from '../lib/http.js';
import { round2 } from '../lib/rates.js';
import { deleteFile, readFile, saveFile, storedFileName } from '../lib/storage.js';

const router = express.Router();

export { ACTIVITY_STATUSES, ACTIVITY_ORIGINS };
export const EVIDENCE_KINDS = ['Receipt', 'Invoice', 'Fuel Slip', 'Delivery Note', 'Payment Proof', 'Photograph', 'Other'];
export const EVIDENCE_STATUSES = ['Pending', 'Partial', 'Complete'];

// Statuses that mean the work is cleared to happen, so the activity counts as
// approved, and statuses from which finished work may be handed back.
const APPROVED_STATUSES = ['Assigned', 'Accepted', 'Approved', 'Budget Adjusted', 'In Progress', 'Needs Correction', 'Completed'];
const WORKABLE_STATUSES = ['Accepted', 'Approved', 'Budget Adjusted', 'In Progress', 'Needs Correction'];

// Which status may follow which. Reopening is deliberate: completed work can go
// back to the manager if the evidence turns out to be short.
const STATUS_FLOW = {
  Assigned: ['Accepted', 'In Progress', 'Budget Adjusted', 'On Hold', 'Rejected'],
  Accepted: ['In Progress', 'Budget Adjusted', 'On Hold', 'Rejected'],
  'Pending Review': ['Approved', 'Budget Adjusted', 'Rejected', 'On Hold'],
  Approved: ['In Progress', 'Completed', 'Needs Correction', 'Budget Adjusted', 'On Hold', 'Rejected'],
  'Budget Adjusted': ['In Progress', 'Completed', 'Needs Correction', 'Approved', 'On Hold', 'Rejected'],
  'In Progress': ['Completed', 'Needs Correction', 'Budget Adjusted', 'On Hold', 'Rejected'],
  'Needs Correction': ['In Progress', 'Completed', 'Budget Adjusted', 'On Hold', 'Rejected'],
  Completed: ['In Progress', 'Needs Correction'],
  Rejected: ['Pending Review', 'Assigned'],
  'On Hold': ['Assigned', 'Accepted', 'Pending Review', 'Approved', 'Budget Adjusted', 'In Progress', 'Rejected']
};

// Where the bytes go is the storage adapter's business: the local disk on a
// server, Supabase Storage on a host without one.
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
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
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
    instructions: row.instructions || '',
    origin: row.origin || 'requested',
    assignedTo: row.assigned_to ?? null,
    assignedToName: row.assigned_to_name ?? null,
    assignedAt: row.assigned_at ?? null,
    acceptedAt: row.accepted_at ?? null,
    // A DATE column arrives as a Date at local midnight; sending it on as a
    // timestamp shifts the calendar day for a reader in another zone.
    deadline: toDateOnly(row.deadline),
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
         (SELECT COUNT(*) FROM activity_evidence e WHERE e.activity_id = a.id)::int AS evidence_count,
         (SELECT COUNT(*) FROM activity_budget_requests b WHERE b.activity_id = a.id AND b.status = 'Pending')::int AS pending_budget_requests
  FROM activities a
  LEFT JOIN projects p ON p.id = a.project_id
  LEFT JOIN users r ON r.id = a.reviewed_by
  LEFT JOIN users m ON m.id = a.assigned_to
`;

// Sector scoping, exactly as everywhere else in this API: the Director sees
// every record, anyone else sees their own working area.
async function loadActivity(id, user) {
  const values = [id];
  const filters = [];
  managerScope(user, 'a.sector', values, filters);
  const result = await pool.query(
    `${SELECT_ACTIVITY} WHERE a.id = $1${filters.length ? ` AND ${filters.join(' AND ')}` : ''}`,
    values
  );
  if (!result.rowCount) throw new ActivityError(404, 'Activity not found.');
  return result.rows[0];
}

function requireAdmin(user, action) {
  if (!isAdmin(user)) throw new ActivityError(403, `Only the Director can ${action}.`);
}

// A manager may correct their own request only while it is still theirs -- once
// the Director has decided it, the record is read-only to them.
function canEditRequest(user, row) {
  if (isAdmin(user)) return true;
  return row.created_by === user.id && ['Pending Review', 'Rejected'].includes(row.status);
}

function canAttachEvidence(user, row) {
  return isAdmin(user) || user.sector === row.sector;
}

router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ message: 'Authentication required.' });
  next();
});

// ---- register -------------------------------------------------------------

router.get('/', asyncRoute(async (req, res) => {
  const { projectId, sector, status, search, awaiting, assignedTo, limit } = req.query;
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
  // Everything sitting on the Director's desk: undecided requests, finished
  // work handed back, and budget changes waiting for an answer.
  if (awaiting === 'review') {
    filters.push(`(a.status = 'Pending Review'
      OR (a.completion_submitted_at IS NOT NULL AND a.status <> 'Completed')
      OR EXISTS (SELECT 1 FROM activity_budget_requests b WHERE b.activity_id = a.id AND b.status = 'Pending'))`);
  }
  // Everything sitting on this manager's desk: work handed to them that they
  // have not accepted yet, and work sent back for correction.
  if (awaiting === 'mine') {
    values.push(req.user.id);
    filters.push(`(a.assigned_to = $${values.length} AND a.status IN ('Assigned', 'Needs Correction'))`);
  }
  if (assignedTo === 'me') {
    values.push(req.user.id);
    filters.push(`a.assigned_to = $${values.length}`);
  }
  managerScope(req.user, 'a.sector', values, filters);

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const requestedLimit = Number(limit || 5);
  const safeLimit = Number.isInteger(requestedLimit) && requestedLimit > 0 && requestedLimit <= 200 ? requestedLimit : 5;
  values.push(safeLimit);
  const result = await pool.query(`${SELECT_ACTIVITY} ${where} ORDER BY a.created_at DESC LIMIT $${values.length}`, values);
  res.json(result.rows.map(mapActivity));
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
  return null;
}

router.post('/', asyncRoute(async (req, res) => {
  const payload = req.body || {};
  const invalid = validateRequestBody(payload);
  if (invalid) return res.status(400).json({ message: invalid });

  const projectResult = await pool.query(
    `SELECT id, sector FROM projects WHERE id = $1${isAdmin(req.user) ? '' : ' AND sector = $2'}`,
    isAdmin(req.user) ? [payload.projectId] : [payload.projectId, req.user.sector]
  );
  if (!projectResult.rowCount) return res.status(404).json({ message: 'Select an existing project before assigning an activity.' });

  const sector = validateSector(payload.sector, projectResult.rows[0].sector);
  if (!sector) return res.status(400).json({ message: 'Activity sector is invalid.' });
  if (!isAdmin(req.user) && sector !== req.user.sector) {
    return res.status(403).json({ message: 'You can only record activities in your own sector.' });
  }

  // Two ways in, one table. The Director assigns work that is already funded and
  // already approved; a manager raises a need that still has to be decided.
  const assigning = isAdmin(req.user);
  const budget = round2(payload.costUsd || 0);
  const id = payload.id || `ACT-${Date.now()}`;

  let assignedTo = null;
  let deadline = null;
  if (assigning) {
    assignedTo = payload.assignedTo ? Number(payload.assignedTo) : null;
    if (!assignedTo) {
      return res.status(400).json({ message: 'Choose the manager who will carry out this activity.' });
    }
    const manager = await pool.query("SELECT id, sector FROM users WHERE id = $1 AND role = 'manager'", [assignedTo]);
    if (!manager.rowCount) return res.status(400).json({ message: 'The selected manager is invalid.' });
    // A manager only ever reads their own working area, so handing them work in
    // another one would leave them assigned to a record they cannot open.
    if (manager.rows[0].sector !== sector) {
      return res.status(400).json({ message: 'That manager works in a different area. Pick a manager from the same working area.' });
    }
    deadline = payload.deadline ? String(payload.deadline).slice(0, 10) : null;
    if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
      return res.status(400).json({ message: 'The deadline must be a date.' });
    }
  }

  const status = assigning ? 'Assigned' : 'Pending Review';
  // An assigned activity carries the Director's own figure, so it is both the
  // original budget and the approved one. A raised request has no approved
  // budget until the Director decides it.
  const approvedBudget = assigning ? budget : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO activities
         (id, project_id, sector, category, activity, description, materials, quantity,
          cost_usd, cost_rwf, cost_cdf, requested_budget, approved_budget, signed, approved, status,
          created_by, created_by_name, origin, assigned_to, assigned_at, deadline, instructions,
          reviewed_by, reviewed_at)
       -- $18 is cast here as well as in the CASE arms below. Feeding it once as
       -- the bare origin column (varchar) and once as $18::text leaves Postgres
       -- unable to settle on a type for the parameter, and the whole insert is
       -- rejected with "inconsistent types deduced for parameter $18".
       SELECT $1, p.id, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::text, $19,
              CASE WHEN $19::int IS NULL THEN NULL ELSE NOW() END, $20::date, $21,
              CASE WHEN $18::text = 'assigned' THEN $16::int ELSE NULL END,
              CASE WHEN $18::text = 'assigned' THEN NOW() ELSE NULL END
       FROM projects p WHERE p.id = $22
       RETURNING id`,
      [
        id, sector, payload.category, payload.activity, payload.description || '',
        optionalText(payload.materials, 2000), Number(payload.quantity || 0),
        budget, Number(payload.costRwf || 0), Number(payload.costCdf ?? payload.costFco ?? 0),
        budget, approvedBudget, Boolean(payload.signed), assigning, status,
        req.user.id, req.user.name, assigning ? 'assigned' : 'requested', assignedTo,
        deadline, optionalText(payload.instructions, 4000), payload.projectId
      ]
    );
    if (!result.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Project not found.' });
    }
    await logHistory(client, id, req.user, assigning
      ? [
        { action: 'Activity assigned', field: 'status', oldValue: null, newValue: 'Assigned', note: optionalText(payload.instructions, 4000) },
        { action: 'Budget set', field: 'approvedBudget', oldValue: null, newValue: budget },
        { action: 'Manager assigned', field: 'assignedTo', oldValue: null, newValue: String(assignedTo) }
      ]
      : [
        { action: 'Activity submitted', field: 'status', oldValue: null, newValue: 'Pending Review' },
        { action: 'Budget requested', field: 'requestedBudget', oldValue: null, newValue: budget }
      ]);
    await client.query('COMMIT');
    const saved = await loadActivity(id, req.user);
    res.status(201).json(mapActivity(saved));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

// Correcting the request itself. The decision fields are not reachable here --
// a manager cannot edit their way to an approved budget.
router.put('/:id', asyncRoute(async (req, res) => {
  const existing = await loadActivity(req.params.id, req.user);
  if (!canEditRequest(req.user, existing)) {
    return res.status(403).json({ message: 'This request has been reviewed and can no longer be edited. Ask the Director to reopen it.' });
  }

  const payload = req.body || {};
  const invalid = validateRequestBody(payload);
  if (invalid) return res.status(400).json({ message: invalid });

  const projectResult = await pool.query(
    `SELECT id, sector FROM projects WHERE id = $1${isAdmin(req.user) ? '' : ' AND sector = $2'}`,
    isAdmin(req.user) ? [payload.projectId] : [payload.projectId, req.user.sector]
  );
  if (!projectResult.rowCount) return res.status(404).json({ message: 'Select an existing project before assigning an activity.' });

  const sector = validateSector(payload.sector, projectResult.rows[0].sector);
  if (!sector) return res.status(400).json({ message: 'Activity sector is invalid.' });
  if (!isAdmin(req.user) && sector !== req.user.sector) {
    return res.status(403).json({ message: 'You can only record activities in your own sector.' });
  }

  const requestedBudget = round2(payload.costUsd || 0);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE activities
       SET project_id = $2, sector = $3, category = $4, activity = $5, description = $6, materials = $7,
           quantity = $8, cost_usd = $9, cost_rwf = $10, cost_cdf = $11, requested_budget = $12,
           signed = $13, updated_at = NOW()
       WHERE id = $1`,
      [
        existing.id, payload.projectId, sector, payload.category, payload.activity, payload.description || '',
        optionalText(payload.materials, 2000), Number(payload.quantity || 0),
        requestedBudget, Number(payload.costRwf || 0), Number(payload.costCdf ?? payload.costFco ?? 0),
        requestedBudget, Boolean(payload.signed)
      ]
    );
    const entries = [{ action: 'Request edited', field: 'activity', oldValue: existing.activity, newValue: payload.activity }];
    if (round2(existing.requested_budget) !== requestedBudget) {
      entries.push({ action: 'Request edited', field: 'requestedBudget', oldValue: round2(existing.requested_budget), newValue: requestedBudget });
    }
    await logHistory(client, existing.id, req.user, entries);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  res.json(mapActivity(await loadActivity(existing.id, req.user)));
}));

// ---- the Director's decision ---------------------------------------------

// Approved budget, status and note in one save, so the trail records one
// coherent decision rather than three unrelated edits.
router.patch('/:id/decision', asyncRoute(async (req, res) => {
  requireAdmin(req.user, 'review an activity');
  const existing = await loadActivity(req.params.id, req.user);
  const payload = req.body || {};

  const statusGiven = Object.prototype.hasOwnProperty.call(payload, 'status') && payload.status !== null && payload.status !== '';
  const status = statusGiven ? payload.status : existing.status;
  if (!ACTIVITY_STATUSES.includes(status)) {
    return res.status(400).json({ message: 'Activity status is invalid.' });
  }
  if (status !== existing.status && !(STATUS_FLOW[existing.status] || []).includes(status)) {
    return res.status(400).json({ message: `A ${existing.status} activity cannot move straight to ${status}.` });
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
  const adminNote = noteGiven ? optionalText(payload.adminNote, 2000) : existing.admin_note;
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
  if (approvedBudget !== null && approvedBudget !== requestedBudget && !adminNote) {
    return res.status(400).json({ message: 'A note is required when the approved budget differs from the original budget.' });
  }

  const settled = APPROVED_STATUSES.includes(status);
  // Work sent back is no longer submitted: it returns to the manager's court,
  // and they resubmit it once corrected.
  const returned = status === 'Needs Correction';
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
      note: adminNote
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
    await client.query(
      `UPDATE activities
       SET approved_budget = $2, status = $3::text, admin_note = $4, approved = $5,
           reviewed_by = $6, reviewed_at = NOW(),
           completed_at = CASE WHEN $3::text = 'Completed' THEN NOW() ELSE NULL END,
           completion_submitted_at = CASE WHEN $7 THEN NULL ELSE completion_submitted_at END,
           updated_at = NOW()
       WHERE id = $1`,
      [existing.id, approvedBudget, status, adminNote, settled, req.user.id, returned]
    );
    await logHistory(client, existing.id, req.user, entries);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
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
  if (!(STATUS_FLOW[existing.status] || []).includes(status)) {
    return res.status(400).json({ message: `A ${existing.status} activity cannot move straight to ${status}.` });
  }

  // The moves a manager owns on their own work: accepting what they were given,
  // and starting it. Everything else is the Director's.
  const ownsIt = !isAdmin(req.user)
    && req.user.sector === existing.sector
    && (existing.assigned_to === null || existing.assigned_to === req.user.id);
  const managerAccept = ownsIt && status === 'Accepted' && existing.status === 'Assigned';
  const managerStart = ownsIt
    && status === 'In Progress'
    && ['Assigned', 'Accepted', 'Approved', 'Budget Adjusted', 'Needs Correction'].includes(existing.status);
  if (!managerAccept && !managerStart) requireAdmin(req.user, 'change the status of an activity');

  const note = optionalText(req.body?.note, 2000);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE activities
       SET status = $2::text,
           approved = CASE WHEN $2::text = ANY($3::text[]) THEN TRUE ELSE approved END,
           completed_at = CASE WHEN $2::text = 'Completed' THEN NOW() ELSE NULL END,
           accepted_at = CASE WHEN $2::text = 'Accepted' AND accepted_at IS NULL THEN NOW() ELSE accepted_at END,
           updated_at = NOW()
       WHERE id = $1`,
      [existing.id, status, APPROVED_STATUSES]
    );
    await logHistory(client, existing.id, req.user, [
      {
        action: managerAccept ? 'Activity accepted' : 'Status changed',
        field: 'status', oldValue: existing.status, newValue: status, note
      }
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
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
  if (!isAdmin(req.user) && req.user.sector !== existing.sector) {
    return res.status(403).json({ message: 'You can only submit activities in your own sector.' });
  }
  if (!WORKABLE_STATUSES.includes(existing.status)) {
    return res.status(400).json({ message: `A ${existing.status} activity cannot be submitted as finished.` });
  }
  const evidence = await pool.query('SELECT COUNT(*)::int AS total FROM activity_evidence WHERE activity_id = $1', [existing.id]);
  if (!evidence.rows[0].total) {
    return res.status(400).json({ message: 'Attach the receipts, invoices or photographs for this work before submitting it as finished.' });
  }

  const note = optionalText(req.body?.note, 2000);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE activities SET completion_submitted_at = NOW(), evidence_status = 'Complete', updated_at = NOW() WHERE id = $1`,
      [existing.id]
    );
    await logHistory(client, existing.id, req.user, [
      { action: 'Completion submitted', field: 'completionSubmittedAt', oldValue: existing.completion_submitted_at, newValue: 'submitted for review', note }
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
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
  const payload = req.body || {};

  const managerGiven = Object.prototype.hasOwnProperty.call(payload, 'assignedTo');
  const deadlineGiven = Object.prototype.hasOwnProperty.call(payload, 'deadline');
  const instructionsGiven = Object.prototype.hasOwnProperty.call(payload, 'instructions');
  if (!managerGiven && !deadlineGiven && !instructionsGiven) {
    return res.status(400).json({ message: 'Provide a manager, a deadline, or instructions.' });
  }

  let assignedTo = existing.assigned_to;
  if (managerGiven) {
    assignedTo = payload.assignedTo === null || payload.assignedTo === '' ? null : Number(payload.assignedTo);
    if (assignedTo) {
      const manager = await pool.query("SELECT id, sector, name FROM users WHERE id = $1 AND role = 'manager'", [assignedTo]);
      if (!manager.rowCount) return res.status(400).json({ message: 'The selected manager is invalid.' });
      if (manager.rows[0].sector !== existing.sector) {
        return res.status(400).json({ message: 'That manager works in a different area. Pick a manager from the same working area.' });
      }
    }
  }

  let deadline = toDateOnly(existing.deadline);
  if (deadlineGiven) {
    deadline = payload.deadline ? String(payload.deadline).slice(0, 10) : null;
    if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
      return res.status(400).json({ message: 'The deadline must be a date.' });
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
  if (instructionsGiven && instructions !== (existing.instructions || '')) {
    entries.push({ action: 'Instructions updated', field: 'instructions', oldValue: existing.instructions || null, newValue: instructions });
  }
  if (!entries.length) return res.status(400).json({ message: 'Nothing to change.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE activities
       SET assigned_to = $2, deadline = $3::date, instructions = $4,
           assigned_at = CASE WHEN $2::int IS DISTINCT FROM assigned_to THEN NOW() ELSE assigned_at END,
           accepted_at = CASE WHEN $2::int IS DISTINCT FROM assigned_to THEN NULL ELSE accepted_at END,
           updated_at = NOW()
       WHERE id = $1`,
      [existing.id, assignedTo, deadline, instructions]
    );
    await logHistory(client, existing.id, req.user, entries);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
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
router.post('/:id/budget-requests', asyncRoute(async (req, res) => {
  const existing = await loadActivity(req.params.id, req.user);
  if (!isAdmin(req.user) && req.user.sector !== existing.sector) {
    return res.status(403).json({ message: 'You can only ask about activities in your own working area.' });
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
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  res.status(201).json(mapBudgetRequest(saved));
}));

router.patch('/:id/budget-requests/:requestId', asyncRoute(async (req, res) => {
  requireAdmin(req.user, 'decide a budget change');
  const existing = await loadActivity(req.params.id, req.user);
  const { status, decisionNote } = req.body || {};
  if (!['Approved', 'Declined'].includes(status)) {
    return res.status(400).json({ message: 'Approve or decline the budget change.' });
  }
  if (status === 'Declined' && !requiredText(decisionNote)) {
    return res.status(400).json({ message: 'Say why the budget change is declined.' });
  }

  const found = await pool.query(
    "SELECT * FROM activity_budget_requests WHERE id = $1 AND activity_id = $2 AND status = 'Pending'",
    [Number(req.params.requestId) || 0, existing.id]
  );
  if (!found.rowCount) return res.status(404).json({ message: 'That budget change is not waiting for a decision.' });
  const request = found.rows[0];
  const note = optionalText(decisionNote, 2000);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE activity_budget_requests
       SET status = $2, decision_note = $3, decided_by = $4, decided_by_name = $5, decided_at = NOW()
       WHERE id = $1`,
      [request.id, status, note, req.user.id, req.user.name]
    );
    const entries = [{
      action: `Budget change ${status.toLowerCase()}`, field: 'budgetRequest',
      oldValue: round2(request.current_budget), newValue: round2(request.requested_amount), note
    }];
    if (status === 'Approved') {
      // Only the revised figure moves. requested_budget still holds the
      // original, so the activity carries both from here on.
      await client.query(
        `UPDATE activities
         SET approved_budget = $2, status = CASE WHEN status = 'Completed' THEN status ELSE 'Budget Adjusted' END,
             admin_note = $3, reviewed_by = $4, reviewed_at = NOW(), approved = TRUE, updated_at = NOW()
         WHERE id = $1`,
        [existing.id, round2(request.requested_amount), note || existing.admin_note, req.user.id]
      );
      entries.push({
        action: 'Budget decided', field: 'approvedBudget',
        oldValue: round2(request.current_budget), newValue: round2(request.requested_amount),
        note: note || request.reason
      });
      if (existing.status !== 'Completed' && existing.status !== 'Budget Adjusted') {
        entries.push({ action: 'Status changed', field: 'status', oldValue: existing.status, newValue: 'Budget Adjusted', note });
      }
    }
    await logHistory(client, existing.id, req.user, entries);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
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
  if (!isAdmin(req.user) && !(existing.created_by === req.user.id && existing.status === 'Pending Review')) {
    return res.status(403).json({ message: 'Only the Director can delete a reviewed activity.' });
  }
  const files = await pool.query('SELECT stored_name FROM activity_evidence WHERE activity_id = $1', [existing.id]);
  const result = await pool.query('DELETE FROM activities WHERE id = $1 RETURNING *', [existing.id]);
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

router.post('/:id/evidence', upload.array('files', 10), asyncRoute(async (req, res) => {
  // Nothing has been written anywhere yet -- the files are still in memory --
  // so a refused upload leaves no bytes behind and needs no cleanup.
  const existing = await loadActivity(req.params.id, req.user);
  if (!canAttachEvidence(req.user, existing)) {
    return res.status(403).json({ message: 'You cannot attach evidence to this activity.' });
  }
  if (!req.files?.length) return res.status(400).json({ message: 'Select at least one receipt, invoice or photograph to upload.' });

  const kind = EVIDENCE_KINDS.includes(req.body.kind) ? req.body.kind : 'Receipt';
  const amount = validNumber(req.body.amount || 0) ? round2(req.body.amount || 0) : 0;
  const note = optionalText(req.body.note, 500);

  // Stored first, recorded second. A file with no row is an orphan nobody sees;
  // a row with no file is a broken link in the evidence trail, so the write
  // that can fail goes first and its objects are removed if the rows fail.
  const stored = [];
  try {
    for (const file of req.files) {
      const storedName = storedFileName(file.originalname);
      await saveFile(EVIDENCE_FOLDER, storedName, file.buffer, file.mimetype);
      stored.push({ file, storedName });
    }
  } catch (error) {
    await Promise.all(stored.map((item) => deleteFile(EVIDENCE_FOLDER, item.storedName)));
    return res.status(502).json({ message: error.message });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const saved = [];
    for (const { file, storedName } of stored) {
      const result = await client.query(
        `INSERT INTO activity_evidence
           (activity_id, kind, original_name, stored_name, mime_type, size_bytes, amount, note, uploaded_by, uploaded_by_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [existing.id, kind, file.originalname.slice(0, 255), storedName, file.mimetype, file.size, amount, note, req.user.id, req.user.name]
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
    await client.query('ROLLBACK');
    await Promise.all(stored.map((item) => deleteFile(EVIDENCE_FOLDER, item.storedName)));
    throw error;
  } finally {
    client.release();
  }
}));

router.get('/:id/evidence/:evidenceId/file', asyncRoute(async (req, res) => {
  const existing = await loadActivity(req.params.id, req.user);
  const result = await pool.query(
    'SELECT * FROM activity_evidence WHERE id = $1 AND activity_id = $2',
    [Number(req.params.evidenceId) || 0, existing.id]
  );
  if (!result.rowCount) return res.status(404).json({ message: 'Evidence not found.' });

  const record = result.rows[0];
  const file = await readFile(EVIDENCE_FOLDER, record.stored_name);
  if (!file) return res.status(404).json({ message: 'The stored file is missing from the server.' });

  res.type(record.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${record.original_name.replace(/"/g, '')}"`);
  // The disk gives back a stream, remote storage a buffer already in hand.
  if (Buffer.isBuffer(file)) return res.send(file);
  return file.pipe(res);
}));

router.delete('/:id/evidence/:evidenceId', asyncRoute(async (req, res) => {
  const existing = await loadActivity(req.params.id, req.user);
  requireAdmin(req.user, 'remove evidence');

  const result = await pool.query(
    'DELETE FROM activity_evidence WHERE id = $1 AND activity_id = $2 RETURNING *',
    [Number(req.params.evidenceId) || 0, existing.id]
  );
  if (!result.rowCount) return res.status(404).json({ message: 'Evidence not found.' });

  await deleteFile(EVIDENCE_FOLDER, result.rows[0].stored_name);
  await logHistory(pool, existing.id, req.user, [
    { action: 'Evidence removed', field: 'evidence', oldValue: result.rows[0].original_name, newValue: null }
  ]);
  res.json({ message: 'Evidence removed.', deletedEvidence: mapEvidence(result.rows[0]) });
}));

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
      ? 'Each evidence file must be 10 MB or smaller.'
      : error.code === 'LIMIT_FILE_COUNT'
        ? 'Upload at most 10 evidence files at a time.'
        : 'The evidence upload was rejected.';
    return res.status(400).json({ message });
  }
  return next(error);
});

export default router;
