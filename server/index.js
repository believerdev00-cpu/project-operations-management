import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { pathToFileURL } from 'node:url';
import { initDatabase, pool } from './db/database.js';
import { sectors } from './data/seedData.js';
import { authMiddleware, jwtSecret } from './lib/auth.js';
import { asyncRoute, hasFullScope, isAdmin, managerScope, parseId, requiredText, validNumber, validateSector, withinScope } from './lib/http.js';
import { pendingForMeSql } from './lib/approvals.js';
import { getCurrentRate } from './lib/rates.js';
import { deleteFile } from './lib/storage.js';
import movementRouter, { mapMovement } from './routes/movements.js';
import rateRouter from './routes/rates.js';
import userRouter from './routes/users.js';
import activityRouter, { mapActivity } from './routes/activities.js';
import reportRouter from './routes/reports.js';
import partnerRouter from './routes/partner.js';
import partnersRouter from './routes/partners.js';
import monthlyPlanRouter from './routes/monthlyPlans.js';

const app = express();
const port = process.env.PORT || 5000;

// Same-origin in production (a proxy or this process serves the Vite build), so
// nothing is allowed unless CORS_ORIGIN names an origin. Default covers dev.
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

function mapProject(row) {
  return {
    id: row.id,
    name: row.name,
    sector: row.sector,
    managerId: row.manager_id,
    managerName: row.manager_name || null,
    location: row.location,
    owner: row.owner,
    status: row.status,
    progress: Number(row.progress),
    budget: Number(row.budget),
    spent: Number(row.spent),
    category: row.category,
    updatedAt: row.updated_at
  };
}

function mapApproval(row) {
  return {
    id: row.id,
    title: row.title,
    sector: row.sector,
    amount: Number(row.amount),
    owner: row.owner,
    priority: row.priority,
    status: row.status,
    requestedBy: row.requested_by,
    justification: row.justification || '',
    decisionNote: row.decision_note || '',
    decidedBy: row.decided_by_name || null,
    decidedAt: row.decided_at || null,
    createdAt: row.created_at
  };
}

// Vercel (and any reverse proxy) puts the client address in X-Forwarded-For.
// Without trusting the first hop, every request appears to come from the proxy,
// so the login limiter counted the whole organisation as one caller and ten
// mistyped passwords anywhere locked everybody out.
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '1mb' }));

// Slows credential stuffing. In-memory and per-process: behind more than one
// instance this needs a shared store.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many login attempts. Try again in a few minutes.' }
});

app.get('/api/health', asyncRoute(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok', service: 'project-ops-api', database: 'PostgreSQL connected' });
}));

app.get('/api/db-status', authMiddleware, asyncRoute(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ databaseEnabled: true, mode: 'postgres' });
}));

app.get('/api/sectors', authMiddleware, (req, res) => {
  res.json(sectors);
});

app.get('/api/managers', authMiddleware, asyncRoute(async (req, res) => {
  const values = [];
  let scope = '';
  if (!hasFullScope(req.user)) {
    values.push(req.user.sector);
    // An all-operations manager belongs to every list, so a scoped caller sees
    // them alongside their own operation's managers rather than missing the one
    // account that can actually take the work.
    scope = ` AND (sector = $${values.length} OR covers_all_sectors)`;
  }
  const result = await pool.query(
    `SELECT id, username, name, role, sector, covers_all_sectors AS "coversAllSectors"
     FROM users WHERE role = 'manager'${scope} ORDER BY name`,
    values
  );
  res.json(result.rows);
}));

// The account register, the Director's user-management surface: the roster, the
// roles, who reports to whom, and the working areas. Password hashes never
// leave the database, so a password is reset, never read back.
app.use('/api/users', authMiddleware, userRouter);

app.post('/api/auth/login', loginLimiter, asyncRoute(async (req, res) => {
  const { username, password } = req.body || {};
  const result = await pool.query(
    'SELECT id, username, password_hash, name, role, sector, status, access_level, covers_all_sectors FROM users WHERE username = $1',
    [typeof username === 'string' ? username.trim() : '']
  );
  const user = result.rows[0];

  // Accounts have been created with the password trimmed, so a password typed
  // with a stray trailing space was hashed without it. Checking the exact text
  // first and the trimmed text second lets both sign in.
  const typed = typeof password === 'string' ? password : '';
  const matches = Boolean(user) && (bcrypt.compareSync(typed, user.password_hash)
    || (typed.trim() !== typed && bcrypt.compareSync(typed.trim(), user.password_hash)));
  if (!matches) {
    return res.status(401).json({ code: 'BAD_CREDENTIALS', message: 'Invalid username or password.' });
  }
  // A suspended or revoked account is refused at the door, so no token is ever
  // minted for one. authMiddleware checks the same thing again on every
  // request, which is what makes a suspension bite on an already-issued token.
  if ((user.status || 'active') !== 'active') {
    return res.status(403).json({
      code: 'ACCOUNT_INACTIVE',
      status: user.status,
      message: user.status === 'suspended'
        ? 'This account is suspended. Contact the administrator.'
        : 'Access to this account has been revoked.'
    });
  }

  const publicUser = {
    id: user.id, username: user.username, name: user.name, role: user.role, sector: user.sector,
    accessLevel: user.access_level || 'internal',
    coversAllSectors: Boolean(user.covers_all_sectors)
  };
  const token = jwt.sign(publicUser, jwtSecret, { expiresIn: '12h' });
  res.json({ token, user: publicUser });
}));

app.get('/api/auth/session', authMiddleware, asyncRoute(async (req, res) => {
  const result = await pool.query(
    'SELECT id, username, name, role, sector, email, status, access_level, covers_all_sectors FROM users WHERE id = $1',
    [req.user.id]
  );
  const row = result.rows[0];
  res.json({
    user: row
      ? {
          id: row.id, username: row.username, name: row.name, role: row.role,
          sector: row.sector, email: row.email || null,
          status: row.status || 'active', accessLevel: row.access_level || 'internal',
          coversAllSectors: Boolean(row.covers_all_sectors)
        }
      : null
  });
}));

app.get('/api/summary', authMiddleware, asyncRoute(async (req, res) => {
  // Parameterized rather than interpolated: every other query in this file binds
  // its values, and the sector should be no different.
  const scoped = !hasFullScope(req.user);
  const scopeValues = scoped ? [req.user.sector] : [];
  const whereSector = scoped ? ' WHERE sector = $1' : '';
  const andSector = scoped ? ' AND sector = $1' : '';

  // Movement spend is reported in RWF, so every movement is converted from its
  // own currency at the rate frozen onto it (the current reference rate when it
  // has none). Summing the raw column added USD and CDF amounts to RWF ones.
  // Scope follows the Movements module: a Logistics manager sees every movement,
  // anyone else the movements that supported their own operation -- every row's
  // sector is 'movement', so filtering on it showed other managers nothing.
  const rate = await getCurrentRate(pool);
  const movementValues = [rate.rwfPerUsd, rate.cdfPerUsd];
  const movementScope = scoped && req.user.sector !== 'movement'
    ? (movementValues.push(req.user.sector), ` WHERE m.related_area = $${movementValues.length}`)
    : '';
  const movementRwf = `CASE m.currency
      WHEN 'USD' THEN m.cost * COALESCE(NULLIF(m.fx_rwf_per_usd, 0), $1)
      WHEN 'CDF' THEN m.cost / COALESCE(NULLIF(m.fx_cdf_per_usd, 0), $2) * COALESCE(NULLIF(m.fx_rwf_per_usd, 0), $1)
      ELSE m.cost END`;

  const [projectStats, approvalStats, movementStats, activityStats, operationsStats] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total_projects, COALESCE(SUM(budget), 0) AS total_budget, COALESCE(SUM(spent), 0) AS total_spent, COALESCE(AVG(progress), 0) AS completion_rate FROM projects${whereSector}`, scopeValues),
    pool.query(`SELECT COUNT(*)::int AS pending_approvals FROM approvals WHERE status = 'Pending'${andSector}`, scopeValues),
    pool.query(`SELECT COALESCE(SUM(${movementRwf}), 0) AS movement_spend FROM movements m${movementScope}`, movementValues),
    pool.query(`SELECT COUNT(*)::int AS total_activities,
      COUNT(*) FILTER (WHERE status = 'Completed')::int AS completed_activities,
      COUNT(*) FILTER (WHERE approved = TRUE)::int AS approved_activities,
      COUNT(*) FILTER (WHERE signed = TRUE)::int AS signed_activities
      FROM activities${whereSector}`, scopeValues),
    pool.query(`SELECT COUNT(*)::int AS active_operations FROM activities WHERE status = 'In Progress'${andSector}`, scopeValues)
  ]);

  // The headcount is the Director's figure: a sector manager sees the records of
  // their own area, not the size of the organisation.
  const registeredUsers = isAdmin(req.user)
    ? (await pool.query('SELECT COUNT(*)::int AS total FROM users')).rows[0].total
    : null;

  // What is waiting on a decision. A manager sees the same two counts for their
  // own area, so they can tell what is still with the Director.
  const reviewQueue = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'Pending Approval')::int AS activity_reviews_pending,
            COUNT(*) FILTER (WHERE completion_submitted_at IS NOT NULL AND status <> 'Completed')::int AS completions_awaiting_review,
            COUNT(*) FILTER (WHERE assigned_to = $${scopeValues.length + 1} AND status IN ('Pending Approval', 'Needs Correction'))::int AS assigned_to_me
     FROM activities${whereSector}`,
    [...scopeValues, req.user.id]
  );

  // "What I Need to Approve" as a single number for the sidebar badge. Built
  // from the signed-in user's id, not from their role, so it is exactly the
  // work this account is personally holding up -- and it is the same predicate
  // the queue itself runs, so the badge and the list can never disagree.
  const approvalValues = [];
  const activityPending = pendingForMeSql(req.user, approvalValues, 'a');
  const movementPending = pendingForMeSql(req.user, approvalValues, 'm');
  const approvalQueue = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM activities a WHERE ${activityPending})::int AS activities,
       (SELECT COUNT(*) FROM movements m WHERE ${movementPending})::int AS movements`,
    approvalValues
  );

  // Budget changes a manager has asked for and nobody has answered yet.
  const budgetQueue = await pool.query(
    `SELECT COUNT(*)::int AS budget_changes_pending
     FROM activity_budget_requests b JOIN activities a ON a.id = b.activity_id
     WHERE b.status = 'Pending'${scoped ? ' AND a.sector = $1' : ''}`,
    scopeValues
  );

  // Same figures again, split per sector, so the director can compare farming,
  // mining, agriculture and logistics side by side. A sector manager is scoped
  // as everywhere else and simply gets a single row back.
  const [projectsBySector, activitiesBySector, approvalsBySector, movementsBySector] = await Promise.all([
    pool.query(`SELECT sector, COUNT(*)::int AS projects, COALESCE(SUM(budget), 0) AS budget, COALESCE(SUM(spent), 0) AS spent, COALESCE(AVG(progress), 0) AS progress FROM projects${whereSector} GROUP BY sector`, scopeValues),
    pool.query(`SELECT sector, COUNT(*)::int AS activities,
      COUNT(*) FILTER (WHERE status = 'In Progress')::int AS active_activities,
      COUNT(*) FILTER (WHERE status = 'Completed')::int AS completed_activities
      FROM activities${whereSector} GROUP BY sector`, scopeValues),
    pool.query(`SELECT sector, COUNT(*)::int AS approvals_pending FROM approvals WHERE status = 'Pending'${andSector} GROUP BY sector`, scopeValues),
    // Per operation, a movement counts towards the operation it supported, and
    // a standalone one towards Movements & Facilitation itself.
    pool.query(`SELECT COALESCE(m.related_area, 'movement') AS sector, COALESCE(SUM(${movementRwf}), 0) AS movement_spend
      FROM movements m${movementScope} GROUP BY COALESCE(m.related_area, 'movement')`, movementValues)
  ]);

  const byId = (result) => new Map(result.rows.map((row) => [row.sector, row]));
  const projectsFor = byId(projectsBySector);
  const activitiesFor = byId(activitiesBySector);
  const approvalsFor = byId(approvalsBySector);
  const movementsFor = byId(movementsBySector);

  // Built from the sector list, not from the rows, so a sector with no records
  // still shows up as a zero row rather than vanishing from the comparison.
  const sectorBreakdown = sectors
    .filter((sector) => !scoped || sector.id === req.user.sector)
    .map((sector) => {
      const p = projectsFor.get(sector.id) || {};
      const a = activitiesFor.get(sector.id) || {};
      const budget = Number(p.budget || 0);
      const spent = Number(p.spent || 0);
      return {
        id: sector.id,
        name: sector.name,
        shortName: sector.shortName,
        projects: p.projects || 0,
        budget,
        spent,
        remaining: budget - spent,
        progress: Math.round(Number(p.progress || 0)),
        activities: a.activities || 0,
        activeActivities: a.active_activities || 0,
        completedActivities: a.completed_activities || 0,
        approvalsPending: approvalsFor.get(sector.id)?.approvals_pending || 0,
        movementSpend: Number(movementsFor.get(sector.id)?.movement_spend || 0)
      };
    });

  const project = projectStats.rows[0];
  const approval = approvalStats.rows[0];
  const movement = movementStats.rows[0];
  const activity = activityStats.rows[0];
  const totalBudget = Number(project.total_budget);
  const totalSpent = Number(project.total_spent);

  res.json({
    title: 'Project Operations Management System',
    status: 'online',
    org: 'Rwanda Operations Group',
    summary: {
      registeredUsers,
      // The badge on "What I Need to Approve".
      approvalsAwaitingMe: approvalQueue.rows[0].activities + approvalQueue.rows[0].movements,
      approvalsAwaitingMeActivities: approvalQueue.rows[0].activities,
      approvalsAwaitingMeMovements: approvalQueue.rows[0].movements,
      activityReviewsPending: reviewQueue.rows[0].activity_reviews_pending,
      completionsAwaitingReview: reviewQueue.rows[0].completions_awaiting_review,
      budgetChangesPending: budgetQueue.rows[0].budget_changes_pending,
      activitiesAssignedToMe: reviewQueue.rows[0].assigned_to_me,
      totalProjects: project.total_projects,
      activeOperations: operationsStats.rows[0].active_operations,
      approvalsPending: approval.pending_approvals,
      currentBudget: `RWF ${(totalBudget / 1000000).toFixed(1)}M`,
      spent: `RWF ${(totalSpent / 1000000).toFixed(1)}M`,
      cashFlow: `RWF ${((totalBudget - totalSpent) / 1000000).toFixed(1)}M`,
      movementSpend: `RWF ${(Number(movement.movement_spend) / 1000000).toFixed(1)}M`,
      completionRate: Math.round(Number(project.completion_rate)),
      adminPerformance: {
        totalActivities: activity.total_activities,
        completedActivities: activity.completed_activities,
        signedActivities: activity.signed_activities,
        approvedActivities: activity.approved_activities,
        completionRate: activity.total_activities ? Math.round((activity.completed_activities / activity.total_activities) * 100) : 0,
        approvalRate: activity.total_activities ? Math.round((activity.approved_activities / activity.total_activities) * 100) : 0
      }
    },
    sectorBreakdown,
    sectors,
    panels: ['Dashboard', 'Projects', 'Activities', 'Finance', 'Logistics & Facilitation']
  });
}));

// "What I Need to Approve": every activity and movement waiting on THIS user,
// in one request so the screen and the sidebar badge come from one source.
//
// The list is derived from the signed-in account, never from a hard-coded role:
// a manager sees only what names them, the Director sees only what names the
// Director's office, and anybody who approves nothing gets an empty queue.
app.get('/api/approval-queue', authMiddleware, asyncRoute(async (req, res) => {
  const activityValues = [];
  const activityWhere = pendingForMeSql(req.user, activityValues, 'a');
  const movementValues = [];
  const movementWhere = pendingForMeSql(req.user, movementValues, 'm');

  const [activities, movements] = await Promise.all([
    pool.query(
      `SELECT a.*, p.name AS project_name, m.name AS assigned_to_name,
              req.name AS approval_required_from_name, req.role AS approval_required_from_role,
              req.sector AS approval_required_from_sector, app.name AS approved_by_name
       FROM activities a
       LEFT JOIN projects p ON p.id = a.project_id
       LEFT JOIN users m ON m.id = a.assigned_to
       LEFT JOIN users req ON req.id = a.approval_required_from
       LEFT JOIN users app ON app.id = a.approved_by
       WHERE ${activityWhere}
       ORDER BY a.created_at DESC LIMIT 200`,
      activityValues
    ),
    pool.query(
      `SELECT m.*, creator.name AS created_by_name, approver.name AS approved_by_name,
              req.name AS approval_required_from_name, req.role AS approval_required_from_role,
              req.sector AS approval_required_from_sector, holder.name AS assigned_to_name
       FROM movements m
       LEFT JOIN users creator ON creator.id = m.created_by
       LEFT JOIN users approver ON approver.id = m.approved_by
       LEFT JOIN users req ON req.id = m.approval_required_from
       LEFT JOIN users holder ON holder.id = m.assigned_to
       WHERE ${movementWhere}
       ORDER BY m.created_at DESC LIMIT 200`,
      movementValues
    )
  ]);

  res.json({
    activities: activities.rows.map(mapActivity),
    movements: movements.rows.map(mapMovement),
    total: activities.rowCount + movements.rowCount
  });
}));

app.get('/api/projects', authMiddleware, asyncRoute(async (req, res) => {
  const { status, category, sector, search } = req.query;
  const values = [];
  const filters = [];

  if (status && status !== 'All') {
    values.push(status);
    filters.push(`p.status = $${values.length}`);
  }
  if (category && category !== 'All') {
    values.push(category);
    filters.push(`p.category = $${values.length}`);
  }
  if (sector && sector !== 'All') {
    values.push(sector);
    filters.push(`p.sector = $${values.length}`);
  }
  if (search) {
    values.push(`%${search}%`);
    filters.push(`(p.name ILIKE $${values.length} OR p.location ILIKE $${values.length} OR p.owner ILIKE $${values.length})`);
  }
  managerScope(req.user, 'p.sector', values, filters);

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const result = await pool.query(`SELECT p.*, u.name AS manager_name FROM projects p LEFT JOIN users u ON u.id = p.manager_id ${where} ORDER BY p.updated_at DESC`, values);
  res.json(result.rows.map(mapProject));
}));

const PROJECT_STATUSES = ['On Track', 'In Review', 'Delayed', 'Healthy'];

// One reading of a project body for create and edit, so the two cannot drift.
// Every value the table is strict about -- the NOT NULL text, INTEGER progress,
// NUMERIC money -- is checked here and answered with a 400, rather than being
// discovered by Postgres and reported as a server error. Money that failed
// Number() used to be stored as NaN and turned the dashboard into "RWF NaNM".
function readProjectPayload(payload, current = null) {
  const pick = (field, fallback) => (payload[field] === undefined ? fallback : payload[field]);
  const project = {
    name: pick('name', current?.name),
    sector: validateSector(payload.sector, current?.sector || 'agriculture'),
    location: pick('location', current?.location),
    owner: pick('owner', current?.owner),
    status: pick('status', current?.status || 'On Track'),
    progress: pick('progress', current?.progress ?? 0),
    budget: pick('budget', current?.budget ?? 0),
    spent: pick('spent', current?.spent ?? 0),
    category: pick('category', current?.category || 'General')
  };
  if (!project.sector) return { error: 'A valid business operation is required.' };
  if (!requiredText(project.name) || !requiredText(project.location) || !requiredText(project.owner)) {
    return { error: 'Project name, business operation, location, and owner are required.' };
  }
  if (project.name.trim().length > 200 || project.location.trim().length > 200 || project.owner.trim().length > 200) {
    return { error: 'Project name, location and owner can be at most 200 characters.' };
  }
  if (!PROJECT_STATUSES.includes(project.status)) return { error: 'Project status is invalid.' };
  const progress = Number(project.progress === '' ? 0 : project.progress);
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) {
    return { error: 'Progress must be a whole number from 0 to 100.' };
  }
  if (!validNumber(project.budget === '' ? 0 : project.budget) || !validNumber(project.spent === '' ? 0 : project.spent)) {
    return { error: 'Budget and spent must be valid non-negative numbers.' };
  }
  return {
    project: {
      name: project.name.trim(),
      sector: project.sector,
      location: project.location.trim(),
      owner: project.owner.trim(),
      status: project.status,
      progress,
      budget: Number(project.budget || 0),
      spent: Number(project.spent || 0),
      category: (typeof project.category === 'string' && project.category.trim()) ? project.category.trim().slice(0, 100) : 'General'
    }
  };
}

// A project's manager has to work the project's own operation; named on a
// project they cannot see, they would be responsible for work they cannot open.
async function checkProjectManager(rawManagerId, sector) {
  if (rawManagerId === null || rawManagerId === undefined || rawManagerId === '') return { managerId: null };
  const managerId = parseId(rawManagerId);
  if (!managerId) return { error: 'Selected manager is invalid.' };
  const found = await pool.query(
    "SELECT id, sector, role, covers_all_sectors AS \"coversAllSectors\" FROM users WHERE id = $1 AND role = 'manager' AND status = 'active'",
    [managerId]
  );
  if (!found.rowCount) return { error: 'Selected manager is invalid.' };
  // A manager covering every operation may manage a project in any of them.
  if (!withinScope(found.rows[0], sector)) return { error: 'That manager works in a different business operation.' };
  return { managerId };
}

app.post('/api/projects', authMiddleware, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ message: 'Only the Director can create projects.' });
  const payload = req.body || {};
  const { project, error } = readProjectPayload(payload);
  if (error) return res.status(400).json({ message: error });
  const manager = await checkProjectManager(payload.managerId, project.sector);
  if (manager.error) return res.status(400).json({ message: manager.error });

  const id = `PRJ-${Date.now()}`;
  const result = await pool.query(
    `INSERT INTO projects (id, name, sector, manager_id, location, owner, status, progress, budget, spent, category)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [id, project.name, project.sector, manager.managerId, project.location, project.owner, project.status, project.progress, project.budget, project.spent, project.category]
  );
  res.status(201).json(mapProject(result.rows[0]));
}));

app.put('/api/projects/:id', authMiddleware, asyncRoute(async (req, res) => {
  const payload = req.body || {};
  const existingProject = await pool.query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
  if (!existingProject.rowCount) return res.status(404).json({ message: 'Project not found.' });
  const current = existingProject.rows[0];

  // Authorize against the sector the project is in now, not the one the caller
  // sent, and refuse to let a manager move a project out of their own sector.
  if (!isAdmin(req.user) && (req.user.role !== 'manager' || !withinScope(req.user, current.sector))) {
    return res.status(403).json({ message: 'Managers can only update projects in their assigned sector.' });
  }
  // Anything left out of the body keeps its current value. Defaulting a missing
  // sector to 'agriculture' silently moved projects the Director edited.
  const { project, error } = readProjectPayload(payload, current);
  if (error) return res.status(400).json({ message: error });
  if (!withinScope(req.user, project.sector)) {
    return res.status(403).json({ message: 'Managers cannot move a project to another sector.' });
  }

  // Who manages a project is the Director's call, exactly as on PATCH /manager.
  let managerId = current.manager_id;
  if (Object.prototype.hasOwnProperty.call(payload, 'managerId')) {
    const manager = await checkProjectManager(payload.managerId, project.sector);
    if (manager.error) return res.status(400).json({ message: manager.error });
    if (manager.managerId !== current.manager_id && !isAdmin(req.user)) {
      return res.status(403).json({ message: 'Only the Director can assign a project manager.' });
    }
    managerId = manager.managerId;
  } else if (project.sector !== current.sector) {
    managerId = null;
  }

  const result = await pool.query(
    `UPDATE projects
     SET name = $2, sector = $3, manager_id = $4, location = $5, owner = $6, status = $7, progress = $8,
       budget = $9, spent = $10, category = $11, updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [current.id, project.name, project.sector, managerId, project.location, project.owner, project.status, project.progress, project.budget, project.spent, project.category]
  );
  res.json(mapProject(result.rows[0]));
}));

app.patch('/api/projects/:id/manager', authMiddleware, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ message: 'Only the Director can assign managers.' });
  const existing = await pool.query('SELECT sector FROM projects WHERE id = $1', [req.params.id]);
  if (!existing.rowCount) return res.status(404).json({ message: 'Project not found.' });
  const manager = await checkProjectManager(req.body?.managerId, existing.rows[0].sector);
  if (manager.error) return res.status(400).json({ message: manager.error });

  const result = await pool.query(
    `UPDATE projects SET manager_id = $2, updated_at = NOW() WHERE id = $1
     RETURNING *, (SELECT name FROM users WHERE id = manager_id) AS manager_name`,
    [req.params.id, manager.managerId]
  );
  if (!result.rowCount) return res.status(404).json({ message: 'Project not found.' });
  res.json(mapProject(result.rows[0]));
}));

app.delete('/api/projects/:id', authMiddleware, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ message: 'Only the Director can delete projects.' });
  // Deleting a project cascades to its activities and their evidence rows. The
  // stored files are read first so they are removed too, instead of being left
  // in storage with nothing pointing at them.
  const files = await pool.query(
    `SELECT e.stored_name FROM activity_evidence e JOIN activities a ON a.id = e.activity_id WHERE a.project_id = $1`,
    [req.params.id]
  );
  const result = await pool.query('DELETE FROM projects WHERE id = $1 RETURNING *', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ message: 'Project not found.' });
  await Promise.all(files.rows.map((file) => deleteFile('activities', file.stored_name)));
  res.json({ message: 'Project deleted successfully.', deletedProject: mapProject(result.rows[0]) });
}));

app.get('/api/approvals', authMiddleware, asyncRoute(async (req, res) => {
  const { status, sector, search } = req.query;
  const values = [];
  const filters = [];

  if (status && status !== 'All') {
    values.push(status);
    filters.push(`a.status = $${values.length}`);
  }
  if (sector && sector !== 'All') {
    values.push(sector);
    filters.push(`a.sector = $${values.length}`);
  }
  if (search) {
    values.push(`%${search}%`);
    filters.push(`(a.title ILIKE $${values.length} OR a.owner ILIKE $${values.length} OR a.requested_by ILIKE $${values.length})`);
  }
  // Columns are qualified because the join brings in users.sector too.
  managerScope(req.user, 'a.sector', values, filters);

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT a.*, u.name AS decided_by_name
     FROM approvals a LEFT JOIN users u ON u.id = a.decided_by_id
     ${where} ORDER BY a.created_at DESC`,
    values
  );
  res.json(result.rows.map(mapApproval));
}));

app.post('/api/approvals', authMiddleware, asyncRoute(async (req, res) => {
  const payload = req.body || {};
  // A request is raised by a sector manager and decided by the Director. A team
  // member works under a manager and goes through them; the Director has nobody
  // above them to decide their own request, since self-decisions are refused.
  if (req.user.role !== 'manager') {
    return res.status(403).json({ message: 'Only a sector manager can raise a request for approval.' });
  }
  const sector = validateSector(payload.sector, req.user.sector);
  if (sector && !withinScope(req.user, sector)) return res.status(403).json({ message: 'Managers can only submit approvals in their assigned sector.' });
  if (!sector || !requiredText(payload.title) || !requiredText(payload.owner)) {
    return res.status(400).json({ message: 'Approval title, sector, and owner are required.' });
  }
  if (!validNumber(payload.amount)) return res.status(400).json({ message: 'Approval amount must be a valid non-negative number.' });
  if (!['Low', 'Medium', 'High'].includes(payload.priority || 'Medium')) return res.status(400).json({ message: 'Approval priority is invalid.' });

  const id = payload.id || `APP-${Date.now()}`;
  // Always born Pending: letting the caller post status 'Approved' was
  // self-approval in a single request.
  const result = await pool.query(
    `INSERT INTO approvals (id, title, sector, amount, owner, priority, status, requested_by, requested_by_id, justification)
     VALUES ($1, $2, $3, $4, $5, $6, 'Pending', $7, $8, $9)
     RETURNING *`,
    [id, payload.title, sector, Number(payload.amount || 0), payload.owner, payload.priority || 'Medium', payload.requestedBy || req.user.name, req.user.id, (payload.justification || '').trim()]
  );
  res.status(201).json(mapApproval(result.rows[0]));
}));

app.patch('/api/approvals/:id', authMiddleware, asyncRoute(async (req, res) => {
  const payload = req.body || {};
  const existing = await pool.query(`SELECT * FROM approvals WHERE id = $1${hasFullScope(req.user) ? '' : ' AND sector = $2'}`, hasFullScope(req.user) ? [req.params.id] : [req.params.id, req.user.sector]);
  if (!existing.rowCount) return res.status(404).json({ message: 'Approval not found.' });

  const current = existing.rows[0];
  const sector = validateSector(payload.sector, current.sector);
  const nextStatus = payload.status ?? current.status;

  if (!['Pending', 'Approved', 'Rejected'].includes(nextStatus)) {
    return res.status(400).json({ message: 'Approval status is invalid.' });
  }
  if (payload.amount !== undefined && !validNumber(payload.amount)) {
    return res.status(400).json({ message: 'Approval amount must be a valid non-negative number.' });
  }
  if (payload.priority !== undefined && !['Low', 'Medium', 'High'].includes(payload.priority)) {
    return res.status(400).json({ message: 'Approval priority is invalid.' });
  }
  const decides = nextStatus !== current.status && nextStatus !== 'Pending';
  const reopens = nextStatus === 'Pending' && current.status !== 'Pending';
  // Outside the Director's office, a request is its requester's to edit, and
  // only while it is still undecided. Without this a manager could leave the
  // status untouched and rewrite the amount under an approval the Director had
  // already given, or reopen a decided request and wipe who decided it.
  if (!isAdmin(req.user)) {
    if (reopens) {
      return res.status(403).json({ message: 'Only the Director can reopen a decided request.' });
    }
    if (current.status !== 'Pending') {
      return res.status(403).json({ message: 'A decided request can no longer be changed.' });
    }
    if (current.requested_by_id !== req.user.id) {
      return res.status(403).json({ message: 'Only the person who raised this request can change it.' });
    }
    if (payload.decisionNote !== undefined) {
      return res.status(403).json({ message: 'Only the Director can write the decision note.' });
    }
  }
  // The Director alone approves or declines. A manager raises the request and
  // watches the outcome; without this a sector manager could clear a colleague's
  // request, since the self-approval guard below only stops the requester.
  if (decides && !isAdmin(req.user)) {
    return res.status(403).json({ message: 'Only the Director can approve or decline a request.' });
  }
  // Separation of duties: whoever raised the request cannot be the one who
  // decides it. The super-admin is the second pair of eyes.
  if (decides && current.requested_by_id === req.user.id) {
    return res.status(403).json({ message: 'You cannot approve or reject an approval you requested yourself.' });
  }
  if (!withinScope(req.user, sector)) {
    return res.status(403).json({ message: 'Managers cannot move an approval to another sector.' });
  }

  // Reopening a request to Pending clears the previous decision, so a stale
  // decider and timestamp cannot linger against an undecided request.
  const reopened = reopens;
  const result = await pool.query(
    `UPDATE approvals
     SET title = $2, sector = $3, amount = $4, owner = $5, priority = $6, status = $7, requested_by = $8,
         justification = $9,
         decision_note = CASE WHEN $10 THEN '' ELSE $11 END,
         decided_by_id = CASE WHEN $10 THEN NULL WHEN $12 THEN $13 ELSE decided_by_id END,
         decided_at = CASE WHEN $10 THEN NULL WHEN $12 THEN NOW() ELSE decided_at END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      req.params.id, payload.title ?? current.title, sector, Number(payload.amount ?? current.amount),
      payload.owner ?? current.owner, payload.priority ?? current.priority, nextStatus,
      payload.requestedBy ?? current.requested_by, payload.justification ?? current.justification,
      reopened, (payload.decisionNote ?? current.decision_note ?? '').trim(), decides, req.user.id
    ]
  );

  const decided = await pool.query(
    'SELECT a.*, u.name AS decided_by_name FROM approvals a LEFT JOIN users u ON u.id = a.decided_by_id WHERE a.id = $1',
    [req.params.id]
  );
  res.json(mapApproval(decided.rows[0] || result.rows[0]));
}));

app.delete('/api/approvals/:id', authMiddleware, asyncRoute(async (req, res) => {
  // The Director may remove any request. Anyone else may only withdraw their
  // own, and only before it is decided: a decision is a record, not a draft.
  const result = isAdmin(req.user)
    ? await pool.query('DELETE FROM approvals WHERE id = $1 RETURNING *', [req.params.id])
    : await pool.query(
      `DELETE FROM approvals WHERE id = $1 AND requested_by_id = $2 AND status = 'Pending' RETURNING *`,
      [req.params.id, req.user.id]
    );
  if (!result.rowCount) return res.status(404).json({ message: 'Approval not found, or it can no longer be withdrawn.' });
  res.json({ message: 'Approval deleted successfully.', deletedApproval: mapApproval(result.rows[0]) });
}));

// Logistics & Facilitation is a module of its own (mockup sections 1-9).
app.use('/api/movements', movementRouter);
app.use('/api/rates', rateRouter);

// The activity register and its review workflow: requests, the Director's
// decision, evidence and the audit trail.
app.use('/api/activities', authMiddleware, activityRouter);

// Period reporting -- weekly, monthly, or an exact custom range -- over the
// activity register, with the spreadsheet and PDF exports of the same figures.
// A manager may now ask for a report and is scoped to their own working area
// rather than refused outright; the Director sees every area. Screen and export
// share one query, so an export can never show more than the screen does.
app.use('/api/reports', authMiddleware, reportRouter);

// External Business Partner / Business Operation Access: a read-only window
// onto ONE business operation, for someone outside the organisation. The
// operation is taken from the account, never from the request, and only
// approved records the Director has left visible are returned.
//
// authMiddleware refuses a partner account everything outside this prefix, so
// the restriction does not depend on any handler below remembering to check.
app.use('/api/partner', authMiddleware, partnerRouter);

// The Director's side of the same thing: invite a partner, assign or change
// their business operation, suspend or revoke their access.
app.use('/api/partners', authMiddleware, partnersRouter);

// Monthly planning: the Director plans and confirms a month per business
// operation, the manager works it and records what was spent, and the month is
// reported and closed. No money moves through the platform at any point -- the
// confirmed allocation is handed over outside it, and these records exist for
// accountability.
app.use('/api/monthly-plans', authMiddleware, monthlyPlanRouter);


// What the caller did wrong is told to the caller; only what went wrong on this
// side is a 500. Malformed JSON, an oversized body, and values the database
// refused (a non-numeric id, an impossible date, a duplicate, text too long for
// its column) all used to surface as "Server or database error".
const DATABASE_INPUT_ERRORS = {
  '22P02': [400, 'One of the values sent is not in the expected format.'],
  '22007': [400, 'One of the dates sent is not a valid date.'],
  '22008': [400, 'One of the dates sent is out of range.'],
  '22003': [400, 'One of the numbers sent is too large.'],
  '22001': [400, 'One of the values sent is too long.'],
  '23505': [409, 'A record with those details already exists.'],
  '23503': [409, 'This record is linked to something that no longer exists, or is still in use elsewhere.'],
  '23514': [400, 'One of the values sent is not allowed.']
};

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'The request body is not valid JSON.' });
  }
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ message: 'The request is too large.' });
  }
  const known = DATABASE_INPUT_ERRORS[error?.code];
  if (known) {
    return res.status(known[0]).json({ message: known[1] });
  }
  // A RAISE EXCEPTION from a trigger -- the three-managers-per-sector rule -- is
  // a business rule speaking, and its message is written for people.
  if (error?.code === 'P0001') {
    return res.status(400).json({ message: error.message });
  }
  console.error(error);
  res.status(500).json({ message: 'Server or database error.' });
});

// Listen only when this file is the process entry point -- `node server/index.js`,
// which is what local development and any ordinary host do. Imported instead,
// which is how a serverless function reaches it, this module just hands the app
// back: no socket is opened, and no DDL runs.
//
// That second part matters. A serverless module is evaluated again on every cold
// start, so migrating here would race several instances through ALTER TABLE at
// once. There the schema is brought up to date by `npm run migrate` as a
// deployment step instead.
//
// The test is "am I the entry point", not "am I on Vercel", so this holds on any
// host rather than depending on one provider's environment variable.
const runDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (runDirectly) {
  await initDatabase();
  app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
  });
}

// An Express app is itself a (req, res) handler, which is all a Vercel function
// has to export.
export default app;
