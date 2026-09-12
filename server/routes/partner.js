// External Business Partner / Business Operation Access.
//
// A read-only window onto ONE business operation, for someone outside the
// organisation who needs to follow how that operation is working.
//
// Three rules hold for every query in this file, without exception:
//
//   1. The operation comes from req.user.sector -- the account row -- and never
//      from anything the caller sends. There is no operation parameter to
//      tamper with, so a Mining partner asking for Farming has nothing to ask
//      with; and even if a filter were added later, the WHERE clause below is
//      what actually decides.
//   2. Only approved records are returned. approval_status = 'approved' is read
//      at query time, so a record reopened for correction stops being visible
//      by itself.
//   3. Only records the Director has left externally visible are returned.
//
// What a partner never sees, by construction rather than by hiding a menu:
// internal administration, the account register, private internal notes,
// rejection reasons, the audit trail, evidence files, approval controls, or any
// other operation. Nothing here writes, so a partner cannot approve, reject, or
// change anything.

import express from 'express';
import { pool } from '../db/database.js';
import { asyncRoute } from '../lib/http.js';
import { operationById } from '../../shared/businessOperations.js';
import { round2 } from '../lib/rates.js';

const router = express.Router();

// The single clause that every query in this file is built on. It takes the
// operation from the authenticated account and nowhere else.
function activityVisibility(user, values) {
  values.push(user.sector);
  return `a.sector = $${values.length}
    AND a.approval_status = 'approved'
    AND a.externally_visible = TRUE
    AND a.status NOT IN ('Draft', 'Cancelled', 'Rejected')`;
}

// A movement belongs to the operation it supports; a Logistics partner also
// sees the movements that are not linked to another operation, because those
// are Movements & Facilitation's own work.
//
// Linkage is decided by related_area alone. movements.sector is 'movement' on
// every row, so testing it here once let a Logistics partner read movements
// that support Mining, Farming or Agriculture.
function movementVisibility(user, values) {
  values.push(user.sector);
  const operation = `$${values.length}`;
  const belongs = user.sector === 'movement'
    ? `(m.related_area IS NULL OR m.related_area = ${operation})`
    : `m.related_area = ${operation}`;
  return `${belongs}
    AND m.approval_status = 'approved'
    AND m.externally_visible = TRUE
    AND m.status NOT IN ('Draft', 'Cancelled', 'Rejected')`;
}

// Only ever a partner. An internal account that reached this router would get
// its own sector's data, which is not wrong, but this surface exists for one
// audience and saying so keeps the contract unambiguous.
router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ message: 'Authentication required.' });
  if (req.user.role !== 'partner') {
    return res.status(403).json({ message: 'This view is for external business partners.' });
  }
  next();
});

// Deliberately narrow. An external reader gets what the work is, where it
// stands and what it was approved at -- not who raised it, not the internal
// note, not the rejection reason, not the evidence, not the audit trail.
function publicActivity(row) {
  return {
    id: row.id,
    activity: row.activity,
    description: row.description || '',
    category: row.category,
    operation: row.sector,
    projectName: row.project_name || null,
    status: row.status,
    quantity: Number(row.quantity),
    approvedBudget: row.approved_budget === null ? null : Number(row.approved_budget),
    deadline: toDateOnly(row.deadline),
    approvedAt: row.approved_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at
  };
}

function publicMovement(row) {
  return {
    id: row.id,
    ref: row.ref,
    purpose: row.purpose,
    movementType: row.movement_type,
    operation: row.related_area || row.sector,
    origin: row.origin || '',
    destination: row.destination,
    departureDate: toDateOnly(row.departure_date),
    returnDate: toDateOnly(row.return_date),
    currency: row.currency,
    estimatedTotal: Number(row.cost),
    status: row.status,
    approvedAt: row.approved_at,
    completedAt: row.completed_at
  };
}

function toDateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

function safeLimit(value, fallback = 50, max = 200) {
  const requested = Number(value || fallback);
  return Number.isInteger(requested) && requested > 0 && requested <= max ? requested : fallback;
}

// ---- the operation at a glance --------------------------------------------

router.get('/overview', asyncRoute(async (req, res) => {
  const operation = operationById(req.user.sector);

  const activityValues = [];
  const activityWhere = activityVisibility(req.user, activityValues);
  const movementValues = [];
  const movementWhere = movementVisibility(req.user, movementValues);

  const [activities, movements, recent] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE a.status = 'In Progress')::int AS in_progress,
              COUNT(*) FILTER (WHERE a.status = 'Completed')::int AS completed,
              COALESCE(SUM(a.approved_budget), 0) AS approved_budget
       FROM activities a WHERE ${activityWhere}`,
      activityValues
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE m.status = 'Completed')::int AS completed
       FROM movements m WHERE ${movementWhere}`,
      movementValues
    ),
    pool.query(
      `SELECT a.*, p.name AS project_name FROM activities a
       LEFT JOIN projects p ON p.id = a.project_id
       WHERE ${activityWhere} ORDER BY a.updated_at DESC LIMIT 5`,
      activityValues
    )
  ]);

  const activityStats = activities.rows[0];
  const total = activityStats.total;
  res.json({
    operation: {
      id: req.user.sector,
      name: operation?.name || req.user.sector,
      translations: operation?.translations || null
    },
    accessLevel: req.user.accessLevel,
    activities: {
      total,
      inProgress: activityStats.in_progress,
      completed: activityStats.completed,
      // Progress is what has actually been finished out of what has been
      // approved -- the honest reading for someone following the operation
      // from outside.
      completionRate: total ? Math.round((activityStats.completed / total) * 100) : 0,
      approvedBudget: round2(Number(activityStats.approved_budget))
    },
    movements: {
      total: movements.rows[0].total,
      completed: movements.rows[0].completed
    },
    recentActivities: recent.rows.map(publicActivity)
  });
}));

// ---- the operation's approved activities ----------------------------------

router.get('/activities', asyncRoute(async (req, res) => {
  const values = [];
  const filters = [activityVisibility(req.user, values)];

  // A partner may narrow what they are already entitled to see. They cannot
  // widen it: the visibility clause above is always present, and these filters
  // are ANDed onto it.
  if (req.query.status && req.query.status !== 'All') {
    values.push(req.query.status);
    filters.push(`a.status = $${values.length}`);
  }
  if (req.query.search) {
    values.push(`%${req.query.search}%`);
    filters.push(`(a.activity ILIKE $${values.length} OR a.category ILIKE $${values.length})`);
  }

  values.push(safeLimit(req.query.limit));
  const result = await pool.query(
    `SELECT a.*, p.name AS project_name FROM activities a
     LEFT JOIN projects p ON p.id = a.project_id
     WHERE ${filters.join(' AND ')}
     ORDER BY a.updated_at DESC LIMIT $${values.length}`,
    values
  );
  res.json(result.rows.map(publicActivity));
}));

// ---- the operation's approved movements -----------------------------------

router.get('/movements', asyncRoute(async (req, res) => {
  const values = [];
  const filters = [movementVisibility(req.user, values)];

  if (req.query.status && req.query.status !== 'All') {
    values.push(req.query.status);
    filters.push(`m.status = $${values.length}`);
  }

  values.push(safeLimit(req.query.limit));
  const result = await pool.query(
    `SELECT m.* FROM movements m
     WHERE ${filters.join(' AND ')}
     ORDER BY COALESCE(m.departure_date, m.created_at::date) DESC LIMIT $${values.length}`,
    values
  );
  res.json(result.rows.map(publicMovement));
}));

// ---- a period report over the same visible records ------------------------

router.get('/report', asyncRoute(async (req, res) => {
  const months = Number(req.query.months);
  const window = Number.isInteger(months) && months > 0 && months <= 24 ? months : 3;

  const values = [];
  const where = activityVisibility(req.user, values);
  values.push(window);
  // An activity belongs to the month its work was approved (or, failing that,
  // handed out or raised). updated_at moved every time the record was touched --
  // a visibility toggle, an upload -- and dragged old work into this month.
  const day = 'COALESCE(a.approved_at, a.assigned_at, a.created_at)';
  // Both tables read the same window, so they describe the same activities.
  const inWindow = `${day} >= date_trunc('month', NOW()) - ($${values.length}::int - 1) * INTERVAL '1 month'`;

  const [byMonth, byCategory] = await Promise.all([
    pool.query(
      `SELECT to_char(date_trunc('month', ${day}), 'YYYY-MM') AS period,
              COUNT(*)::int AS activities,
              COUNT(*) FILTER (WHERE a.status = 'Completed')::int AS completed,
              COALESCE(SUM(a.approved_budget), 0) AS approved_budget
       FROM activities a
       WHERE ${where} AND ${inWindow}
       GROUP BY 1 ORDER BY 1`,
      values
    ),
    pool.query(
      `SELECT a.category, COUNT(*)::int AS activities,
              COALESCE(SUM(a.approved_budget), 0) AS approved_budget
       FROM activities a WHERE ${where} AND ${inWindow}
       GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
      values
    )
  ]);

  res.json({
    operation: req.user.sector,
    months: window,
    byMonth: byMonth.rows.map((row) => ({
      period: row.period,
      activities: row.activities,
      completed: row.completed,
      approvedBudget: round2(Number(row.approved_budget))
    })),
    byCategory: byCategory.rows.map((row) => ({
      category: row.category,
      activities: row.activities,
      approvedBudget: round2(Number(row.approved_budget))
    }))
  });
}));

// ---- what has moved recently ----------------------------------------------

// Progress updates, drawn from the audit trail but reduced to the milestones an
// outside reader can act on: approved, started, completed. The trail's actor
// names, notes and budget arguments are internal and are not carried across.
router.get('/updates', asyncRoute(async (req, res) => {
  const values = [];
  const where = activityVisibility(req.user, values);
  values.push(safeLimit(req.query.limit, 25, 100));

  const result = await pool.query(
    `SELECT h.id, h.action, h.new_value, h.created_at, a.activity, a.sector, a.status
     FROM activity_history h
     JOIN activities a ON a.id = h.activity_id
     WHERE ${where}
       AND h.field = 'status'
       AND h.new_value IN ('Approved', 'In Progress', 'Completed')
     ORDER BY h.created_at DESC LIMIT $${values.length}`,
    values
  );

  res.json(result.rows.map((row) => ({
    id: row.id,
    activity: row.activity,
    operation: row.sector,
    milestone: row.new_value,
    currentStatus: row.status,
    at: row.created_at
  })));
}));

// Handed on to the application's error handler, which tells bad input apart
// from a genuine server fault.
router.use((error, req, res, next) => next(error));

export default router;
