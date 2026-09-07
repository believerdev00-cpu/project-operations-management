import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { initDatabase, pool } from './db/database.js';
import { sectors } from './data/seedData.js';
import { authMiddleware, jwtSecret } from './lib/auth.js';
import { asyncRoute, isAdmin, managerScope, requiredText, sectorIds, validNumber, validateSector } from './lib/http.js';
import movementRouter from './routes/movements.js';
import rateRouter from './routes/rates.js';

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

function mapActivity(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    sector: row.sector,
    category: row.category,
    activity: row.activity,
    description: row.description,
    quantity: Number(row.quantity),
    costUsd: Number(row.cost_usd),
    costRwf: Number(row.cost_rwf),
    costCdf: Number(row.cost_cdf),
    signed: row.signed,
    approved: row.approved,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

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
  message: { message: 'Too many login attempts. Try again in a few minutes.' }
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
  if (!isAdmin(req.user)) {
    values.push(req.user.sector);
    scope = ` AND sector = $${values.length}`;
  }
  const result = await pool.query(`SELECT id, username, name, role, sector FROM users WHERE role = 'manager'${scope} ORDER BY name`, values);
  res.json(result.rows);
}));

app.post('/api/managers', authMiddleware, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ message: 'Only the administrator can add managers.' });
  const { username, name, password, sector } = req.body || {};
  if (!requiredText(username) || !requiredText(name) || !requiredText(password) || password.length < 6 || !sectorIds.has(sector)) {
    return res.status(400).json({ message: 'Manager username, name, password, and sector are required.' });
  }

  const result = await pool.query(
    'INSERT INTO users (username, password_hash, name, role, sector) VALUES ($1, $2, $3, $4, $5) RETURNING id, username, name, role, sector',
    [username.trim(), bcrypt.hashSync(password, 10), name.trim(), 'manager', sector]
  );
  res.status(201).json(result.rows[0]);
}));

app.post('/api/auth/login', loginLimiter, asyncRoute(async (req, res) => {
  const { username, password } = req.body || {};
  const result = await pool.query(
    'SELECT id, username, password_hash, name, role, sector FROM users WHERE username = $1',
    [username]
  );
  const user = result.rows[0];

  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ message: 'Invalid username or password.' });
  }

  const publicUser = { id: user.id, username: user.username, name: user.name, role: user.role, sector: user.sector };
  const token = jwt.sign(publicUser, jwtSecret, { expiresIn: '12h' });
  res.json({ token, user: publicUser });
}));

app.get('/api/auth/session', authMiddleware, asyncRoute(async (req, res) => {
  const result = await pool.query(
    'SELECT id, username, name, role, sector FROM users WHERE id = $1',
    [req.user.id]
  );
  res.json({ user: result.rows[0] || null });
}));

app.get('/api/summary', authMiddleware, asyncRoute(async (req, res) => {
  // Parameterized rather than interpolated: every other query in this file binds
  // its values, and the sector should be no different.
  const scoped = !isAdmin(req.user);
  const scopeValues = scoped ? [req.user.sector] : [];
  const whereSector = scoped ? ' WHERE sector = $1' : '';
  const andSector = scoped ? ' AND sector = $1' : '';

  const [projectStats, approvalStats, movementStats, activityStats, operationsStats] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total_projects, COALESCE(SUM(budget), 0) AS total_budget, COALESCE(SUM(spent), 0) AS total_spent, COALESCE(AVG(progress), 0) AS completion_rate FROM projects${whereSector}`, scopeValues),
    pool.query(`SELECT COUNT(*)::int AS pending_approvals FROM approvals WHERE status = 'Pending'${andSector}`, scopeValues),
    pool.query(`SELECT COALESCE(SUM(cost), 0) AS movement_spend FROM movements${whereSector}`, scopeValues),
    pool.query(`SELECT COUNT(*)::int AS total_activities,
      COUNT(*) FILTER (WHERE status = 'Completed')::int AS completed_activities,
      COUNT(*) FILTER (WHERE approved = TRUE)::int AS approved_activities,
      COUNT(*) FILTER (WHERE signed = TRUE)::int AS signed_activities
      FROM activities${whereSector}`, scopeValues),
    pool.query(`SELECT COUNT(*)::int AS active_operations FROM activities WHERE status = 'In Progress'${andSector}`, scopeValues)
  ]);

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
    pool.query(`SELECT sector, COALESCE(SUM(cost), 0) AS movement_spend FROM movements${whereSector} GROUP BY sector`, scopeValues)
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

app.post('/api/projects', authMiddleware, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ message: 'Only the super-admin can create projects.' });
  const payload = req.body || {};
  const sector = validateSector(payload.sector, 'agriculture');
  if (!sector || !requiredText(payload.name) || !requiredText(payload.location) || !requiredText(payload.owner)) {
    return res.status(400).json({ message: 'Project name, sector, location, and owner are required.' });
  }
  const managerId = payload.managerId ? Number(payload.managerId) : null;
  if (managerId && !(await pool.query("SELECT id FROM users WHERE id = $1 AND role = 'manager'", [managerId])).rowCount) {
    return res.status(400).json({ message: 'Selected manager is invalid.' });
  }
  if (!validNumber(payload.progress, { minimum: 0, maximum: 100 }) || !validNumber(payload.budget) || !validNumber(payload.spent)) {
    return res.status(400).json({ message: 'Progress must be 0-100, and budget/spent must be valid non-negative numbers.' });
  }

  const id = payload.id || `PRJ-${Date.now()}`;
  const result = await pool.query(
    `INSERT INTO projects (id, name, sector, manager_id, location, owner, status, progress, budget, spent, category)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [id, payload.name, sector, managerId, payload.location, payload.owner, payload.status || 'On Track', Number(payload.progress || 0), Number(payload.budget || 0), Number(payload.spent || 0), payload.category || 'General']
  );
  res.status(201).json(mapProject(result.rows[0]));
}));

app.put('/api/projects/:id', authMiddleware, asyncRoute(async (req, res) => {
  const payload = req.body || {};
  const sector = validateSector(payload.sector, 'agriculture');
  if (!sector) {
    return res.status(400).json({ message: 'A valid sector is required.' });
  }
  const existingProject = await pool.query('SELECT sector FROM projects WHERE id = $1', [req.params.id]);
  if (!existingProject.rowCount) return res.status(404).json({ message: 'Project not found.' });

  // Authorize against the sector the project is in now, not the one the caller
  // sent, and refuse to let a manager move a project out of their own sector.
  if (!isAdmin(req.user) && existingProject.rows[0].sector !== req.user.sector) {
    return res.status(403).json({ message: 'Managers can only update projects in their assigned sector.' });
  }
  if (!isAdmin(req.user) && sector !== req.user.sector) {
    return res.status(403).json({ message: 'Managers cannot move a project to another sector.' });
  }

  const managerId = payload.managerId ? Number(payload.managerId) : null;
  if (managerId && !(await pool.query("SELECT id FROM users WHERE id = $1 AND role = 'manager'", [managerId])).rowCount) {
    return res.status(400).json({ message: 'Selected manager is invalid.' });
  }
  const result = await pool.query(
    `UPDATE projects
     SET name = $2, sector = $3, manager_id = $4, location = $5, owner = $6, status = $7, progress = $8,
       budget = $9, spent = $10, category = $11, updated_at = NOW()
     WHERE id = $1${isAdmin(req.user) ? '' : ' AND sector = $12'}
     RETURNING *`,
    isAdmin(req.user)
      ? [req.params.id, payload.name, sector, managerId, payload.location, payload.owner, payload.status, Number(payload.progress || 0), Number(payload.budget || 0), Number(payload.spent || 0), payload.category || 'General']
      : [req.params.id, payload.name, sector, managerId, payload.location, payload.owner, payload.status, Number(payload.progress || 0), Number(payload.budget || 0), Number(payload.spent || 0), payload.category || 'General', req.user.sector]
  );

  if (!result.rowCount) return res.status(404).json({ message: 'Project not found.' });
  res.json(mapProject(result.rows[0]));
}));

app.patch('/api/projects/:id/manager', authMiddleware, asyncRoute(async (req, res) => {
  if (req.user.role !== 'super-admin') return res.status(403).json({ message: 'Only the administrator can assign managers.' });
  const managerId = req.body?.managerId ? Number(req.body.managerId) : null;
  if (managerId && !(await pool.query("SELECT id FROM users WHERE id = $1 AND role = 'manager'", [managerId])).rowCount) {
    return res.status(400).json({ message: 'Selected manager is invalid.' });
  }

  const result = await pool.query(
    `UPDATE projects SET manager_id = $2, updated_at = NOW() WHERE id = $1
     RETURNING *, (SELECT name FROM users WHERE id = manager_id) AS manager_name`,
    [req.params.id, managerId]
  );
  if (!result.rowCount) return res.status(404).json({ message: 'Project not found.' });
  res.json(mapProject(result.rows[0]));
}));

app.delete('/api/projects/:id', authMiddleware, asyncRoute(async (req, res) => {
  if (req.user.role !== 'super-admin') return res.status(403).json({ message: 'Only the administrator can delete projects.' });
  const result = await pool.query(`DELETE FROM projects WHERE id = $1${isAdmin(req.user) ? '' : ' AND sector = $2'} RETURNING *`, isAdmin(req.user) ? [req.params.id] : [req.params.id, req.user.sector]);
  if (!result.rowCount) return res.status(404).json({ message: 'Project not found.' });
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
  const sector = validateSector(payload.sector, 'agriculture');
  if (!isAdmin(req.user) && sector !== req.user.sector) return res.status(403).json({ message: 'Managers can only submit approvals in their assigned sector.' });
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
  const existing = await pool.query(`SELECT * FROM approvals WHERE id = $1${isAdmin(req.user) ? '' : ' AND sector = $2'}`, isAdmin(req.user) ? [req.params.id] : [req.params.id, req.user.sector]);
  if (!existing.rowCount) return res.status(404).json({ message: 'Approval not found.' });

  const current = existing.rows[0];
  const sector = validateSector(payload.sector, current.sector);
  const nextStatus = payload.status ?? current.status;

  if (!['Pending', 'Approved', 'Rejected'].includes(nextStatus)) {
    return res.status(400).json({ message: 'Approval status is invalid.' });
  }
  const decides = nextStatus !== current.status && nextStatus !== 'Pending';
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
  if (!isAdmin(req.user) && sector !== req.user.sector) {
    return res.status(403).json({ message: 'Managers cannot move an approval to another sector.' });
  }

  // Reopening a request to Pending clears the previous decision, so a stale
  // decider and timestamp cannot linger against an undecided request.
  const reopened = nextStatus === 'Pending' && current.status !== 'Pending';
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
  const result = await pool.query(`DELETE FROM approvals WHERE id = $1${isAdmin(req.user) ? '' : ' AND sector = $2'} RETURNING *`, isAdmin(req.user) ? [req.params.id] : [req.params.id, req.user.sector]);
  if (!result.rowCount) return res.status(404).json({ message: 'Approval not found.' });
  res.json({ message: 'Approval deleted successfully.', deletedApproval: mapApproval(result.rows[0]) });
}));

// Logistics & Facilitation is a module of its own (mockup sections 1-9).
app.use('/api/movements', movementRouter);
app.use('/api/rates', rateRouter);

app.get('/api/activities', authMiddleware, asyncRoute(async (req, res) => {
  const { projectId, sector, status, search, limit } = req.query;
  const values = [];
  const filters = [];

  if (projectId && projectId !== 'All') {
    values.push(projectId);
    filters.push(`project_id = $${values.length}`);
  }
  if (sector && sector !== 'All') {
    values.push(sector);
    filters.push(`sector = $${values.length}`);
  }
  if (status && status !== 'All') {
    values.push(status);
    filters.push(`status = $${values.length}`);
  }
  if (search) {
    values.push(`%${search}%`);
    filters.push(`(activity ILIKE $${values.length} OR description ILIKE $${values.length} OR category ILIKE $${values.length})`);
  }
  managerScope(req.user, 'sector', values, filters);

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const requestedLimit = Number(limit || 5);
  const safeLimit = Number.isInteger(requestedLimit) && requestedLimit > 0 && requestedLimit <= 100 ? requestedLimit : 5;
  values.push(safeLimit);
  const result = await pool.query(`SELECT * FROM activities ${where} ORDER BY created_at DESC LIMIT $${values.length}`, values);
  res.json(result.rows.map(mapActivity));
}));

app.get('/api/reports/activities', authMiddleware, asyncRoute(async (req, res) => {
  if (req.user.role !== 'super-admin') return res.status(403).json({ message: 'Only the administrator can request reports.' });

  const period = req.query.period === 'monthly' ? 'monthly' : 'weekly';
  const interval = period === 'monthly' ? '1 month' : '7 days';
  const result = await pool.query(
    `SELECT a.*, p.name AS project_name
     FROM activities a
     JOIN projects p ON p.id = a.project_id
    WHERE a.created_at >= NOW() - $1::interval${isAdmin(req.user) ? '' : ' AND a.sector = $2'}
     ORDER BY a.created_at DESC`,
    isAdmin(req.user) ? [interval] : [interval, req.user.sector]
  );
  const activities = result.rows.map((row) => ({ ...mapActivity(row), projectName: row.project_name }));

  res.json({
    period,
    generatedAt: new Date().toISOString(),
    totalActivities: activities.length,
    completedActivities: activities.filter((activity) => activity.status === 'Completed').length,
    approvedActivities: activities.filter((activity) => activity.approved).length,
    signedActivities: activities.filter((activity) => activity.signed).length,
    totalUsd: activities.reduce((total, activity) => total + activity.costUsd, 0),
    totalRwf: activities.reduce((total, activity) => total + activity.costRwf, 0),
    totalCdf: activities.reduce((total, activity) => total + activity.costCdf, 0),
    activities
  });
}));

app.post('/api/activities', authMiddleware, asyncRoute(async (req, res) => {
  const payload = req.body || {};
  if (!payload.projectId || !payload.category || !payload.activity) {
    return res.status(400).json({ message: 'Project, category, and activity are required.' });
  }
  if (!requiredText(payload.category) || !requiredText(payload.activity) || !validNumber(payload.quantity, { minimum: 0.01 }) || !validNumber(payload.costUsd) || !validNumber(payload.costRwf) || !validNumber(payload.costCdf ?? payload.costFco)) {
    return res.status(400).json({ message: 'Category, activity, quantity, USD, RWF, and CDF values must be valid. Quantity must be greater than zero.' });
  }
  if (!['Pending', 'In Progress', 'Completed', 'Cancelled'].includes(payload.status || 'Pending')) {
    return res.status(400).json({ message: 'Activity status is invalid.' });
  }

  const projectResult = await pool.query(`SELECT id, sector FROM projects WHERE id = $1${isAdmin(req.user) ? '' : ' AND sector = $2'}`, isAdmin(req.user) ? [payload.projectId] : [payload.projectId, req.user.sector]);
  if (!projectResult.rowCount) return res.status(404).json({ message: 'Select an existing project before assigning an activity.' });

  // The activity carries its own sector, defaulting to the project's. A sector
  // manager stays confined to their own sector, otherwise they would file
  // records that their own sector-scoped queries can never read back.
  const sector = validateSector(payload.sector, projectResult.rows[0].sector);
  if (!sector) return res.status(400).json({ message: 'Activity sector is invalid.' });
  if (!isAdmin(req.user) && sector !== req.user.sector) {
    return res.status(403).json({ message: 'You can only record activities in your own sector.' });
  }

  const id = payload.id || `ACT-${Date.now()}`;
  const result = await pool.query(
    `INSERT INTO activities
      (id, project_id, sector, category, activity, description, quantity, cost_usd, cost_rwf, cost_cdf, signed, approved, status)
         SELECT $1, p.id, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
     FROM projects p WHERE p.id = $13
     RETURNING *`,
    [id, sector, payload.category, payload.activity, payload.description || '', Number(payload.quantity || 0), Number(payload.costUsd || 0), Number(payload.costRwf || 0), Number(payload.costCdf ?? payload.costFco ?? 0), Boolean(payload.signed), Boolean(payload.approved), payload.status || 'Pending', payload.projectId]
  );

  if (!result.rowCount) return res.status(404).json({ message: 'Project not found.' });
  res.status(201).json(mapActivity(result.rows[0]));
}));

app.put('/api/activities/:id', authMiddleware, asyncRoute(async (req, res) => {
  const payload = req.body || {};
  if (!payload.projectId || !payload.category || !payload.activity) {
    return res.status(400).json({ message: 'Project, category, and activity are required.' });
  }
  if (!requiredText(payload.category) || !requiredText(payload.activity) || !validNumber(payload.quantity, { minimum: 0.01 }) || !validNumber(payload.costUsd) || !validNumber(payload.costRwf) || !validNumber(payload.costCdf ?? payload.costFco)) {
    return res.status(400).json({ message: 'Category, activity, quantity, USD, RWF, and CDF values must be valid. Quantity must be greater than zero.' });
  }
  if (!['Pending', 'In Progress', 'Completed', 'Cancelled'].includes(payload.status || 'Pending')) {
    return res.status(400).json({ message: 'Activity status is invalid.' });
  }

  const projectResult = await pool.query(`SELECT id, sector FROM projects WHERE id = $1${isAdmin(req.user) ? '' : ' AND sector = $2'}`, isAdmin(req.user) ? [payload.projectId] : [payload.projectId, req.user.sector]);
  if (!projectResult.rowCount) return res.status(404).json({ message: 'Select an existing project before assigning an activity.' });

  const sector = validateSector(payload.sector, projectResult.rows[0].sector);
  if (!sector) return res.status(400).json({ message: 'Activity sector is invalid.' });
  if (!isAdmin(req.user) && sector !== req.user.sector) {
    return res.status(403).json({ message: 'You can only record activities in your own sector.' });
  }

  const result = await pool.query(
    `UPDATE activities
     SET project_id = $2, sector = $3, category = $4, activity = $5, description = $6,
         quantity = $7, cost_usd = $8, cost_rwf = $9, cost_cdf = $10,
         signed = $11, approved = $12, status = $13, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [req.params.id, payload.projectId, sector, payload.category, payload.activity, payload.description || '', Number(payload.quantity || 0), Number(payload.costUsd || 0), Number(payload.costRwf || 0), Number(payload.costCdf ?? payload.costFco ?? 0), Boolean(payload.signed), Boolean(payload.approved), payload.status || 'Pending']
  );

  if (!result.rowCount) return res.status(404).json({ message: 'Activity not found.' });
  res.json(mapActivity(result.rows[0]));
}));

app.patch('/api/activities/:id/status', authMiddleware, asyncRoute(async (req, res) => {
  const allowedStatuses = ['Pending', 'In Progress', 'Completed', 'Cancelled'];
  const { status } = req.body || {};
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ message: 'Activity status is invalid.' });
  }

  const result = await pool.query(
    `UPDATE activities SET status = $2, approved = CASE WHEN $2 = 'Completed' THEN TRUE ELSE approved END, updated_at = NOW()
     WHERE id = $1${isAdmin(req.user) ? '' : ' AND sector = $3'} RETURNING *`,
    isAdmin(req.user) ? [req.params.id, status] : [req.params.id, status, req.user.sector]
  );

  if (!result.rowCount) return res.status(404).json({ message: 'Activity not found.' });
  res.json(mapActivity(result.rows[0]));
}));

app.delete('/api/activities/:id', authMiddleware, asyncRoute(async (req, res) => {
  const result = await pool.query(`DELETE FROM activities WHERE id = $1${isAdmin(req.user) ? '' : ' AND sector = $2'} RETURNING *`, isAdmin(req.user) ? [req.params.id] : [req.params.id, req.user.sector]);
  if (!result.rowCount) return res.status(404).json({ message: 'Activity not found.' });
  res.json({ message: 'Activity deleted successfully.', deletedActivity: mapActivity(result.rows[0]) });
}));

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ message: 'Server or database error.' });
});

await initDatabase();
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
