// External Business Partner / Business Operation Access.
//
// A read-only window onto the business operations the Director granted a
// partner -- one or several -- for someone outside the organisation who needs
// to follow how that work is going.
//
// Three rules hold for every query in this file, without exception:
//
//   1. The operations come from req.user.operations -- the partner's grants,
//      read from partner_operations on every request -- and never from
//      anything else the caller sends. A partner may NARROW to one of their own
//      operations with ?operation=; naming one they were not granted is refused,
//      and every other parameter name is ignored. A Mining partner asking for
//      Farming has nothing to ask with: the WHERE clause below is what decides.
//   2. Only approved records are returned. approval_status = 'approved' is read
//      at query time, so a record reopened for correction stops being visible
//      by itself.
//   3. Only records the Director has left externally visible are returned.
//
// What a partner never sees, by construction rather than by hiding a menu:
// internal administration, the account register, private internal notes,
// rejection reasons, the audit trail, evidence files, approval controls, or any
// other operation. The only write here is a comment to the Director (at the
// end of this file), into a table of its own; a partner cannot approve, reject, or
// change anything.

import express from 'express';
import { pool, safeRollback } from '../db/database.js';
import { asyncRoute, contentDisposition, parseId } from '../lib/http.js';
import { TRIPS_OPERATION, operationById } from '../../shared/businessOperations.js';
import { round2 } from '../lib/rates.js';
import { objectiveProgress, planProgress } from '../lib/monthly.js';
import {
  COMMENT_SUBJECTS, PARTNER_COMMENTS_PER_HOUR, PROJECT_SUBJECTS, commentBody, loadThreads, partnerSeesThreadSql, projectManagerIds, viewerOf
} from '../lib/partnerComments.js';
import { activeDirectorIds, notifyDirectors, notifyMany } from '../lib/notifications.js';
import { readFile } from '../lib/storage.js';
import { partnerProjectSql } from '../lib/organization.js';
import { ReportError, buildReport, resolvePeriod, sectorName, sendReportFile } from './reports.js';

const router = express.Router();

class PartnerScopeError extends Error {}

// Which of the partner's operations this request reads: all of them, or the
// one named in ?operation= when it is one of theirs. Anything else is refused
// rather than silently answered with the full set, so a wrong link is visible.
function scopeFor(req) {
  const granted = req.user.operations || [req.user.sector];
  const asked = typeof req.query.operation === 'string' ? req.query.operation : '';
  if (!asked || asked === 'All') return granted;
  if (!granted.includes(asked)) throw new PartnerScopeError('That project is not part of your access.');
  return [asked];
}

// The single clause that every query in this file is built on. It takes the
// operations from the authenticated account's grants and nowhere else.
//
// Within an operation, a partner the Director has shared particular projects
// with sees those projects only (partnerProjectSql); the partner's id comes
// from the authenticated account like the operations do.
function activityVisibility(operations, values, partnerId) {
  values.push(operations);
  const granted = `$${values.length}::text[]`;
  values.push(partnerId);
  const me = `$${values.length}::int`;
  return `a.sector = ANY(${granted})
    AND ${partnerProjectSql(me, 'a.sector', 'a.project_id')}
    AND a.approval_status = 'approved'
    AND a.externally_visible = TRUE
    AND a.status NOT IN ('Draft', 'Cancelled', 'Rejected')`;
}

// A movement belongs to the operation it supports; a partner of the operation
// that RUNS the trips (Movement & Facilitation) also sees the movements that are not
// linked to another operation, because those are that operation's own work.
//
// Linkage is decided by related_area alone. movements.sector is 'movement' on
// every row, so testing it here once let a Logistics partner read movements
// that support Mining, Farming or Agriculture.
function movementVisibility(operations, values, partnerId) {
  values.push(operations);
  const granted = `$${values.length}::text[]`;
  values.push(partnerId);
  const me = `$${values.length}::int`;
  const belongs = operations.includes(TRIPS_OPERATION)
    ? `(m.related_area IS NULL OR m.related_area = ANY(${granted}))`
    : `m.related_area = ANY(${granted})`;
  // A trip narrowed to shared projects is judged by the operation it supports
  // (the trips operation itself when it supports none).
  const supports = `COALESCE(m.related_area, '${TRIPS_OPERATION}')`;
  return `${belongs}
    AND ${partnerProjectSql(me, supports, 'm.project_id')}
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
  const scope = scopeFor(req);
  // The operation the overview is headed with: the one asked for, or the
  // partner's first. `operations` below lists everything they may follow.
  const headline = scope.length === 1 ? scope[0] : req.user.operations[0];
  const operation = operationById(headline);

  const activityValues = [];
  const activityWhere = activityVisibility(scope, activityValues, req.user.id);
  const movementValues = [];
  const movementWhere = movementVisibility(scope, movementValues, req.user.id);

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

  // The projects the Director shared with this partner one by one, so the
  // partner can see what their view has been narrowed to. Names only, and only
  // their own shares.
  const shared = await pool.query(
    `SELECT p.id, p.name, p.sector FROM partner_projects pp JOIN projects p ON p.id = pp.project_id
      WHERE pp.partner_id = $1 AND p.sector = ANY($2::text[]) ORDER BY p.name`,
    [req.user.id, scope]
  );

  const activityStats = activities.rows[0];
  const total = activityStats.total;
  res.json({
    operation: {
      id: headline,
      name: operation?.name || headline,
      translations: operation?.translations || null
    },
    // Every operation this partner may follow, and which of them this answer
    // covers -- all of them unless one was asked for.
    operations: req.user.operations,
    scope,
    sharedProjects: shared.rows.map((row) => ({ id: row.id, name: row.name, operation: row.sector })),
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
  const filters = [activityVisibility(scopeFor(req), values, req.user.id)];

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
  const filters = [movementVisibility(scopeFor(req), values, req.user.id)];

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

  const scope = scopeFor(req);
  const values = [];
  const where = activityVisibility(scope, values, req.user.id);
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
    operation: scope.length === 1 ? scope[0] : req.user.operations[0],
    scope,
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
  const where = activityVisibility(scopeFor(req), values, req.user.id);
  values.push(safeLimit(req.query.limit, 25, 100));

  const result = await pool.query(
    `SELECT h.id, h.action, h.new_value, h.created_at, a.id AS activity_id, a.activity, a.sector, a.status
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
    // So the partner can comment on the activity the update is about.
    activityId: row.activity_id,
    activity: row.activity,
    operation: row.sector,
    milestone: row.new_value,
    currentStatus: row.status,
    at: row.created_at
  })));
}));

// ---- comments to the Director ---------------------------------------------
//
// The one thing a partner may write, and it goes to the Director only: a
// comment on an operation they follow, or on a record they can already see
// here. It lands in partner_comments, which holds nothing internal and which no
// manager route reads, and it reaches the Director through the same in-app
// notifications every other "this is waiting for you" uses. Every check below
// is made with the same visibility clauses as the reads above, so a partner can
// only comment on what they can see.

async function canSeeSubject(partnerId, operation, subjectType, subjectId) {
  const values = [];
  const [table, where] = subjectType === 'activity'
    ? ['activities a', activityVisibility([operation], values, partnerId)]
    : ['movements m', movementVisibility([operation], values, partnerId)];
  values.push(subjectId);
  const alias = subjectType === 'activity' ? 'a' : 'm';
  const result = await pool.query(`SELECT 1 FROM ${table} WHERE ${where} AND ${alias}.id = $${values.length}`, values);
  return result.rowCount > 0;
}

// Counted in the database rather than in memory, so the limit holds across
// serverless instances, which the in-memory rate limiter does not.
async function underHourlyLimit(partnerId) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total FROM partner_comments
     WHERE partner_id = $1 AND author_role = 'partner' AND created_at > NOW() - INTERVAL '1 hour'`,
    [partnerId]
  );
  return result.rows[0].total < PARTNER_COMMENTS_PER_HOUR;
}

const TOO_MANY = 'You have sent a lot of comments in the last hour. Please wait before sending more.';

// Writes one partner message and tells the Director, in one transaction, so a
// notification never points at a comment that failed to save.
async function savePartnerMessage(req, { operation, subjectType, subjectId, parentId, body }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO partner_comments (partner_id, sector, subject_type, subject_id, parent_id, author_id, author_name, author_role, body)
       VALUES ($1, $2, $3, $4, $5, $1, $6, 'partner', $7) RETURNING id`,
      [req.user.id, operation, subjectType, subjectId, parentId, req.user.name, body]
    );
    await notifyDirectors(client, {
      kind: 'partner_comment',
      // The sentence is written by the browser in the Director's language
      // (notice.kind.partner_comment): the partner's name comes from the
      // actor, and `reason` carries the opening of what they wrote.
      params: { operation, reason: body.slice(0, 140) },
      link: '#/partners',
      actor: req.user
    });
    await client.query('COMMIT');
    return parentId || inserted.rows[0].id;
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }
}

router.get('/comments', asyncRoute(async (req, res) => {
  const threads = await loadThreads({ partnerId: req.user.id });
  // Opening the list is reading the Director's replies.
  await pool.query(
    `UPDATE partner_comments SET read_by_partner_at = NOW()
     WHERE partner_id = $1 AND author_role = 'super-admin' AND read_by_partner_at IS NULL`,
    [req.user.id]
  );
  res.json(threads);
}));

router.post('/comments', asyncRoute(async (req, res) => {
  const { operation, subjectType = 'operation', subjectId = null } = req.body || {};
  if (!req.user.operations.includes(operation)) {
    return res.status(403).json({ message: 'That project is not part of your access.' });
  }
  if (!COMMENT_SUBJECTS.includes(subjectType)) {
    return res.status(400).json({ message: 'A comment is about the project, an activity or a trip.' });
  }
  const subject = subjectType === 'operation' ? null : String(subjectId || '');
  if (subjectType !== 'operation' && (!subject || !(await canSeeSubject(req.user.id, operation, subjectType, subject)))) {
    // The same answer whether the record does not exist or is not theirs to
    // see, so the reply cannot be used to probe for records.
    return res.status(404).json({ message: 'That record is not one you can see.' });
  }
  const text = commentBody(req.body?.body);
  if (text.error) return res.status(400).json({ message: text.error });
  if (!(await underHourlyLimit(req.user.id))) return res.status(429).json({ message: TOO_MANY });

  const threadId = await savePartnerMessage(req, {
    operation, subjectType, subjectId: subject, parentId: null, body: text.body
  });
  const [thread] = await loadThreads({ partnerId: req.user.id, threadId });
  res.status(201).json(thread);
}));

router.post('/comments/:id/replies', asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).json({ message: 'Comment not found.' });
  // Only a thread this partner opened, and only while they still follow the
  // operation it is about.
  const thread = await pool.query(
    // A project's discussion is answered under the project, where the share
    // is checked; this door is for messages to the Director only.
    'SELECT id, sector, subject_type, subject_id FROM partner_comments WHERE id = $1 AND partner_id = $2 AND parent_id IS NULL AND project_id IS NULL',
    [id, req.user.id]
  );
  if (!thread.rowCount) return res.status(404).json({ message: 'Comment not found.' });
  const row = thread.rows[0];
  if (!req.user.operations.includes(row.sector)) {
    return res.status(403).json({ message: 'That project is not part of your access.' });
  }
  const text = commentBody(req.body?.body);
  if (text.error) return res.status(400).json({ message: text.error });
  if (!(await underHourlyLimit(req.user.id))) return res.status(429).json({ message: TOO_MANY });

  await savePartnerMessage(req, {
    operation: row.sector, subjectType: row.subject_type, subjectId: row.subject_id, parentId: row.id, body: text.body
  });
  const [updated] = await loadThreads({ partnerId: req.user.id, threadId: row.id });
  res.status(201).json(updated);
}));

// ---- the projects shared with this partner: the full report, and its export ----
//
// THE ONE PLACE A PARTNER READS AS THE DIRECTOR DOES. The Director decided that
// a partner should see a project they are a partner to the way the Director
// sees it -- every monthly plan filed under it, every objective, every recorded
// day, the progress and the money -- and take the report away as a PDF or a
// spreadsheet. Read only: nothing here writes, and the comment to the Director
// is still a partner's only write.
//
// "Their project" means a row in partner_projects, which only the Director
// creates (PUT /api/partners/:id/projects). It does NOT fall back to every
// project in a granted operation the way the activity lists above do: nothing
// is opened in full until the Director has shared it by name. And the project
// must still be in one of the partner's operations, read on this request --
// dropping an operation drops its shares, but the check does not rely on that.
//
// The report is buildReport itself -- the function behind the Director's own
// report screen and export -- asked for that one project, so what the partner
// reads and downloads is exactly what the Director would for the same dates,
// and can never be a second, drifting copy. A report names nobody, so no
// internal person is exposed by it.
async function sharedProject(req, projectId) {
  const found = await pool.query(
    `SELECT p.id, p.name, p.sector FROM projects p
       JOIN partner_projects pp ON pp.project_id = p.id AND pp.partner_id = $1
      WHERE p.id = $2 AND p.sector = ANY($3::text[])`,
    [req.user.id, String(projectId || '').slice(0, 50), req.user.operations]
  );
  // 404 rather than 403, so a partner cannot learn which project ids exist.
  return found.rowCount ? found.rows[0] : null;
}

function projectChoice(project) {
  return { operation: project.sector, operationName: sectorName(project.sector), projectId: project.id, projectName: project.name };
}

router.get('/projects', asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT p.id, p.name, p.sector,
            (SELECT to_char(MAX(mp.month), 'YYYY-MM') FROM monthly_plans mp WHERE mp.project_id = p.id) AS latest_month
       FROM projects p
       JOIN partner_projects pp ON pp.project_id = p.id AND pp.partner_id = $1
      WHERE p.sector = ANY($2::text[])
      ORDER BY p.sector, p.name`,
    [req.user.id, req.user.operations]
  );
  // latestMonth: the newest month with a plan filed under the project, so the
  // partner's report opens on work rather than on an empty current month.
  const projects = result.rows.map((row) => ({ id: row.id, name: row.name, operation: row.sector, latestMonth: row.latest_month || null }));
  if (!projects.length) return res.json([]);
  const ids = projects.map((project) => project.id);

  // What the partner's first page shows for each shared project, from the same
  // definitions the Director's reports use, so the two never disagree: progress
  // is planProgress over every objective of every month filed under the
  // project (as GET /api/reports/projects), and spend is each month's days plus
  // its activities' expenses (as PLAN_TOTALS). The budget is summed only over
  // months that have one -- a month with none is "no limit", not zero.
  const [objectives, money, days, photos] = await Promise.all([
    pool.query(
      `SELECT mp.project_id, o.target_quantity, o.weight,
              COALESCE((SELECT SUM(d.quantity_done) FROM plan_daily_reports d WHERE d.objective_id = o.id), 0) AS done
         FROM monthly_plans mp JOIN plan_objectives o ON o.plan_id = mp.id
        WHERE mp.project_id = ANY($1::varchar[])`, [ids]),
    pool.query(
      `SELECT mp.project_id, COUNT(*)::int AS months,
              COALESCE(SUM(mp.approved_budget) FILTER (WHERE mp.approved_budget > 0), 0) AS budget,
              COALESCE(SUM((SELECT COALESCE(SUM(r.cost), 0) FROM plan_daily_reports r WHERE r.plan_id = mp.id)
                         + (SELECT COALESCE(SUM(e.amount), 0) FROM activity_expenses e JOIN activities ea ON ea.id = e.activity_id
                             WHERE ea.monthly_plan_id = mp.id)), 0) AS spent
         FROM monthly_plans mp WHERE mp.project_id = ANY($1::varchar[]) GROUP BY mp.project_id`, [ids]),
    pool.query(
      `SELECT * FROM (
         SELECT mp.project_id, r.report_date::text AS day, r.quantity_done, r.notes, o.title, o.target_unit,
                COUNT(*) OVER (PARTITION BY mp.project_id)::int AS total,
                ROW_NUMBER() OVER (PARTITION BY mp.project_id ORDER BY r.report_date DESC, r.id DESC) AS n
           FROM plan_daily_reports r JOIN monthly_plans mp ON mp.id = r.plan_id
           LEFT JOIN plan_objectives o ON o.id = r.objective_id
          WHERE mp.project_id = ANY($1::varchar[])) x WHERE n <= 3`, [ids]),
    pool.query(
      `SELECT mp.project_id, COUNT(*)::int AS files
         FROM plan_report_evidence e JOIN plan_daily_reports r ON r.id = e.report_id JOIN monthly_plans mp ON mp.id = r.plan_id
        WHERE mp.project_id = ANY($1::varchar[]) GROUP BY mp.project_id`, [ids])
  ]);
  res.json(projects.map((project) => {
    const own = objectives.rows.filter((row) => row.project_id === project.id)
      .map((row) => ({ ...objectiveProgress(row.target_quantity, row.done), weight: row.weight }));
    const sums = money.rows.find((row) => row.project_id === project.id);
    const recent = days.rows.filter((row) => row.project_id === project.id);
    return {
      ...project,
      summary: {
        percent: planProgress(own),
        objectives: own.length,
        objectivesDone: own.filter((objective) => objective.complete).length,
        months: sums?.months || 0,
        budget: round2(sums?.budget || 0),
        spent: round2(sums?.spent || 0),
        daysRecorded: recent[0]?.total || 0,
        files: photos.rows.find((row) => row.project_id === project.id)?.files || 0,
        latestDays: recent.map((row) => ({
          day: row.day, title: row.title || '', quantity: Number(row.quantity_done), unit: row.target_unit || '', notes: row.notes || ''
        }))
      }
    };
  }));
}));

router.get('/projects/:id/report', asyncRoute(async (req, res) => {
  const project = await sharedProject(req, req.params.id);
  if (!project) return res.status(404).json({ message: 'Project not found.' });
  const period = resolvePeriod(req.query);
  res.json(await buildReport(req.user, period, projectChoice(project)));
}));

router.get('/projects/:id/report/export', asyncRoute(async (req, res) => {
  const project = await sharedProject(req, req.params.id);
  if (!project) return res.status(404).json({ message: 'Project not found.' });
  const format = String(req.query.format || '').toLowerCase();
  if (!['xlsx', 'pdf'].includes(format)) return res.status(400).json({ message: 'The export format must be xlsx or pdf.' });
  const period = resolvePeriod(req.query);
  const choice = projectChoice(project);
  const report = await buildReport(req.user, period, choice);
  return sendReportFile(req, res, report, { format, period, choice });
}));

// ---- the project's documents ---------------------------------------------------
//
// The files behind a shared project: the photos and papers attached to its
// recorded days, and the receipts and evidence on its activities. Listed and
// streamed through here only -- with the partner's own session, never a link
// that could be passed on -- and only for a project sharedProject() lets
// through. A file is found by its id AND the project it belongs to, so an id
// from another project is "not found", not somebody else's file.
const DOCUMENT_SOURCES = {
  day: {
    folder: 'plan-reports',
    list: `SELECT e.id, e.kind, e.original_name, e.mime_type, e.size_bytes, e.created_at,
                  r.report_date::text AS record_date, o.title AS record_title
             FROM plan_report_evidence e
             JOIN plan_daily_reports r ON r.id = e.report_id
             JOIN monthly_plans p ON p.id = r.plan_id
             LEFT JOIN plan_objectives o ON o.id = r.objective_id
            WHERE p.project_id = $1`,
    one: `SELECT e.* FROM plan_report_evidence e
            JOIN plan_daily_reports r ON r.id = e.report_id
            JOIN monthly_plans p ON p.id = r.plan_id
           WHERE e.id = $2 AND p.project_id = $1`
  },
  activity: {
    folder: 'activities',
    list: `SELECT e.id, e.kind, e.original_name, e.mime_type, e.size_bytes, e.created_at,
                  a.created_at::date::text AS record_date, a.activity AS record_title
             FROM activity_evidence e
             JOIN activities a ON a.id = e.activity_id
            WHERE a.project_id = $1`,
    one: `SELECT e.* FROM activity_evidence e
            JOIN activities a ON a.id = e.activity_id
           WHERE e.id = $2 AND a.project_id = $1`
  }
};

router.get('/projects/:id/files', asyncRoute(async (req, res) => {
  const project = await sharedProject(req, req.params.id);
  if (!project) return res.status(404).json({ message: 'Project not found.' });
  const lists = await Promise.all(Object.entries(DOCUMENT_SOURCES).map(async ([source, spec]) => {
    const rows = (await pool.query(`${spec.list} ORDER BY e.created_at DESC LIMIT 500`, [project.id])).rows;
    return rows.map((row) => ({
      source,
      id: row.id,
      kind: row.kind,
      name: row.original_name,
      mimeType: row.mime_type,
      size: row.size_bytes,
      recordDate: row.record_date,
      recordTitle: row.record_title || '',
      uploadedAt: row.created_at
    }));
  }));
  res.json(lists.flat().sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1)));
}));

router.get('/projects/:id/files/:source/:fileId', asyncRoute(async (req, res) => {
  const project = await sharedProject(req, req.params.id);
  const spec = DOCUMENT_SOURCES[req.params.source];
  const fileId = parseId(req.params.fileId);
  if (!project || !spec || !fileId) return res.status(404).json({ message: 'That file was not found.' });
  const found = await pool.query(spec.one, [project.id, fileId]);
  if (!found.rowCount) return res.status(404).json({ message: 'That file was not found.' });
  const record = found.rows[0];
  const file = await readFile(spec.folder, record.stored_name);
  if (!file) return res.status(404).json({ message: 'The stored file is missing from the server.' });
  res.type(record.mime_type);
  res.setHeader('Content-Disposition', contentDisposition(record.original_name, 'attachment'));
  res.setHeader('Cache-Control', 'private, no-store');
  file.once('error', () => (res.headersSent ? res.destroy() : res.status(500).json({ message: 'The stored file could not be read.' })));
  return file.pipe(res);
}));

// ---- the project's discussion ----------------------------------------------------
//
// Comments on a shared project -- the project as a whole, one of its monthly
// plans (the month's report) or one of its activities -- and the replies to
// them. A partner reads, and may take part in, the conversations they or a
// colleague from their own organisation opened (partnerSeesThreadSql) -- two
// organisations sharing a project never read each other; the internal side
// reads them all and answers through /api/project-discussions. What
// a comment is about is checked against the project itself, so a partner
// cannot attach a comment to a record of another project by naming its id.
async function projectSubject(projectId, subjectType, subjectId) {
  if (!PROJECT_SUBJECTS.includes(subjectType)) return { error: 400 };
  if (subjectType === 'project') return { subjectId: null };
  const id = String(subjectId || '').slice(0, 50);
  if (!id) return { error: 404 };
  const found = subjectType === 'plan'
    ? await pool.query('SELECT 1 FROM monthly_plans WHERE id::text = $1 AND project_id = $2', [id, projectId])
    : await pool.query('SELECT 1 FROM activities WHERE id = $1 AND project_id = $2', [id, projectId]);
  return found.rowCount ? { subjectId: id } : { error: 404 };
}

// The people told that a partner wrote: the project's manager(s) and every
// Director, once each, never the writer.
async function tellProjectSide(client, req, project, threadId, body) {
  const managers = await projectManagerIds(client, project.id);
  const directors = await activeDirectorIds(client);
  const params = { project: project.name, reason: body.slice(0, 140) };
  await notifyMany(client, managers.filter((id) => !directors.includes(id)), {
    kind: 'project_comment', params, link: '#/dashboard', actor: req.user
  });
  await notifyMany(client, directors, {
    kind: 'partner_comment', params: { operation: project.sector, reason: params.reason }, link: '#/partners', actor: req.user
  });
  return threadId;
}

router.get('/projects/:id/discussion', asyncRoute(async (req, res) => {
  const project = await sharedProject(req, req.params.id);
  if (!project) return res.status(404).json({ message: 'Project not found.' });
  const [threads, plans, activities] = await Promise.all([
    loadThreads({ projectIds: [project.id], discussions: 'only', viewer: await viewerOf(pool, req.user.id), limit: 200 }),
    pool.query("SELECT id, to_char(month, 'YYYY-MM') AS month FROM monthly_plans WHERE project_id = $1 ORDER BY month DESC LIMIT 60", [project.id]),
    pool.query('SELECT id, activity FROM activities WHERE project_id = $1 ORDER BY created_at DESC LIMIT 200', [project.id])
  ]);
  res.json({
    threads,
    // What a new comment may be about, so the form offers only real choices.
    subjects: {
      plans: plans.rows.map((row) => ({ id: String(row.id), month: row.month })),
      activities: activities.rows.map((row) => ({ id: row.id, title: row.activity }))
    }
  });
}));

router.post('/projects/:id/discussion', asyncRoute(async (req, res) => {
  const project = await sharedProject(req, req.params.id);
  if (!project) return res.status(404).json({ message: 'Project not found.' });
  const subject = await projectSubject(project.id, req.body?.subjectType || 'project', req.body?.subjectId);
  if (subject.error === 400) return res.status(400).json({ message: 'A comment is about the project, a month or an activity.' });
  if (subject.error) return res.status(404).json({ message: 'That record is not part of this project.' });
  const text = commentBody(req.body?.body);
  if (text.error) return res.status(400).json({ message: text.error });
  if (!(await underHourlyLimit(req.user.id))) return res.status(429).json({ message: TOO_MANY });

  const client = await pool.connect();
  let threadId;
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO partner_comments (partner_id, sector, project_id, subject_type, subject_id, author_id, author_name, author_role, body)
       VALUES ($1, $2, $3, $4, $5, $1, $6, 'partner', $7) RETURNING id`,
      [req.user.id, project.sector, project.id, req.body?.subjectType || 'project', subject.subjectId, req.user.name, text.body]
    );
    threadId = await tellProjectSide(client, req, project, inserted.rows[0].id, text.body);
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }
  const [thread] = await loadThreads({ threadId, discussions: 'only' });
  res.status(201).json(thread);
}));

router.post('/projects/:id/discussion/:threadId/replies', asyncRoute(async (req, res) => {
  const project = await sharedProject(req, req.params.id);
  const threadId = parseId(req.params.threadId);
  if (!project || !threadId) return res.status(404).json({ message: 'Comment not found.' });
  // Only a conversation this partner can read (partnerSeesThreadSql): one
  // they opened, or one opened by their own organisation.
  const values = [threadId, project.id];
  const sees = partnerSeesThreadSql(values, await viewerOf(pool, req.user.id), 't', 'u');
  const thread = await pool.query(
    `SELECT t.id, t.partner_id, t.sector, t.subject_type, t.subject_id
       FROM partner_comments t JOIN users u ON u.id = t.partner_id
      WHERE t.id = $1 AND t.parent_id IS NULL AND t.project_id = $2 AND ${sees}`,
    values
  );
  if (!thread.rowCount) return res.status(404).json({ message: 'Comment not found.' });
  const text = commentBody(req.body?.body);
  if (text.error) return res.status(400).json({ message: text.error });
  if (!(await underHourlyLimit(req.user.id))) return res.status(429).json({ message: TOO_MANY });

  const row = thread.rows[0];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO partner_comments (partner_id, sector, project_id, subject_type, subject_id, parent_id, author_id, author_name, author_role, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'partner', $9)`,
      [row.partner_id, row.sector, project.id, row.subject_type, row.subject_id, row.id, req.user.id, req.user.name, text.body]
    );
    // A partner writing again re-opens a conversation marked answered: there
    // is a new question in it.
    await client.query('UPDATE partner_comments SET resolved_at = NULL, resolved_by = NULL, resolved_by_name = \'\' WHERE id = $1', [row.id]);
    await tellProjectSide(client, req, project, row.id, text.body);
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }
  const [updated] = await loadThreads({ threadId: row.id, discussions: 'only' });
  res.status(201).json(updated);
}));

// Handed on to the application's error handler, which tells bad input apart
// from a genuine server fault.
router.use((error, req, res, next) => {
  if (error instanceof PartnerScopeError) return res.status(403).json({ message: error.message });
  if (error instanceof ReportError) return res.status(error.status).json({ message: error.message });
  return next(error);
});

export default router;
