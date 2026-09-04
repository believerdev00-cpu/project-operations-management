import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { initDatabase, pool } from './db/database.js';
import { sectors } from './data/seedData.js';

const app = express();
const port = process.env.PORT || 5000;
const jwtSecret = process.env.JWT_SECRET;

if (!jwtSecret) {
  throw new Error('JWT_SECRET is required. Configure it before starting the API.');
}

const sectorIds = new Set(sectors.map((sector) => sector.id));

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
    createdAt: row.created_at
  };
}

function mapMovement(row) {
  return {
    id: row.id,
    ref: row.ref,
    sector: row.sector,
    purpose: row.purpose,
    destination: row.destination,
    status: row.status,
    cost: Number(row.cost),
    category: row.category
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

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  try {
    req.user = jwt.verify(token, jwtSecret);
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Token is invalid or expired.' });
  }
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function validateSector(sector, fallback) {
  const value = sector || fallback;
  return sectorIds.has(value) ? value : null;
}

function requiredText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validNumber(value, { minimum = 0, maximum } = {}) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && (maximum === undefined || number <= maximum);
}

function isAdmin(user) {
  return user.role === 'super-admin';
}

function managerScope(user, column, values, filters) {
  if (!isAdmin(user)) {
    values.push(user.sector);
    filters.push(`${column} = $${values.length}`);
  }
}

app.use(cors());
app.use(express.json());

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

app.post('/api/auth/login', asyncRoute(async (req, res) => {
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
  const sectorFilter = isAdmin(req.user) ? '' : ` WHERE sector = '${req.user.sector}'`;
  const [projectStats, approvalStats, movementStats, activityStats, operationsStats] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total_projects, COALESCE(SUM(budget), 0) AS total_budget, COALESCE(SUM(spent), 0) AS total_spent, COALESCE(AVG(progress), 0) AS completion_rate FROM projects${sectorFilter}`),
    pool.query(`SELECT COUNT(*)::int AS pending_approvals FROM approvals WHERE status = 'Pending'${isAdmin(req.user) ? '' : ` AND sector = '${req.user.sector}'`}`),
    pool.query(`SELECT COALESCE(SUM(cost), 0) AS movement_spend FROM movements${sectorFilter}`),
    pool.query(`SELECT COUNT(*)::int AS total_activities,
      COUNT(*) FILTER (WHERE status = 'Completed')::int AS completed_activities,
      COUNT(*) FILTER (WHERE approved = TRUE)::int AS approved_activities,
      COUNT(*) FILTER (WHERE signed = TRUE)::int AS signed_activities
      FROM activities${sectorFilter}`),
    pool.query(`SELECT COUNT(*)::int AS active_operations FROM activities WHERE status = 'In Progress'${isAdmin(req.user) ? '' : ` AND sector = '${req.user.sector}'`}`)
  ]);

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
    sectors,
    panels: ['Dashboard', 'Projects', 'Activities', 'Finance', 'Movement & Facilitation']
  });
}));

app.get('/api/projects', authMiddleware, asyncRoute(async (req, res) => {
  const { status, category, sector, search } = req.query;
  const values = [];
  const filters = [];

  if (status && status !== 'All') {
    values.push(status);
    filters.push(`status = $${values.length}`);
  }
  if (category && category !== 'All') {
    values.push(category);
    filters.push(`category = $${values.length}`);
  }
  if (sector && sector !== 'All') {
    values.push(sector);
    filters.push(`sector = $${values.length}`);
  }
  if (search) {
    values.push(`%${search}%`);
    filters.push(`(p.name ILIKE $${values.length} OR p.location ILIKE $${values.length} OR p.owner ILIKE $${values.length})`);
  }
  managerScope(req.user, 'p.sector', values, filters);

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const result = await pool.query(`SELECT p.*, u.name AS manager_name FROM projects p LEFT JOIN users u ON u.id = p.manager_id ${where.replace(/\b(status|category|sector)\b/g, 'p.$1')} ORDER BY p.updated_at DESC`, values);
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
  if (!isAdmin(req.user) && sector !== req.user.sector) return res.status(403).json({ message: 'Managers can only update projects in their assigned sector.' });

  const managerId = payload.managerId ? Number(payload.managerId) : null;
  if (managerId && !(await pool.query("SELECT id FROM users WHERE id = $1 AND role = 'manager'", [managerId])).rowCount) {
    return res.status(400).json({ message: 'Selected manager is invalid.' });
  }
  const result = await pool.query(
    `UPDATE projects
     SET name = $2, sector = $3, manager_id = $4, location = $5, owner = $6, status = $7, progress = $8,
       budget = $9, spent = $10, category = $11, updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [req.params.id, payload.name, sector, managerId, payload.location, payload.owner, payload.status, Number(payload.progress || 0), Number(payload.budget || 0), Number(payload.spent || 0), payload.category || 'General']
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
    filters.push(`status = $${values.length}`);
  }
  if (sector && sector !== 'All') {
    values.push(sector);
    filters.push(`sector = $${values.length}`);
  }
  if (search) {
    values.push(`%${search}%`);
    filters.push(`(title ILIKE $${values.length} OR owner ILIKE $${values.length} OR requested_by ILIKE $${values.length})`);
  }
  managerScope(req.user, 'sector', values, filters);

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const result = await pool.query(`SELECT * FROM approvals ${where} ORDER BY created_at DESC`, values);
  res.json(result.rows.map(mapApproval));
}));

app.post('/api/approvals', authMiddleware, asyncRoute(async (req, res) => {
  const payload = req.body || {};
  const sector = validateSector(payload.sector, 'agriculture');
  if (!isAdmin(req.user) && sector !== req.user.sector) return res.status(403).json({ message: 'Managers can only submit approvals in their assigned sector.' });
  if (!sector || !requiredText(payload.title) || !requiredText(payload.owner) || !requiredText(payload.requestedBy)) {
    return res.status(400).json({ message: 'Approval title, sector, and owner are required.' });
  }
  if (!validNumber(payload.amount)) return res.status(400).json({ message: 'Approval amount must be a valid non-negative number.' });
  if (!['Low', 'Medium', 'High'].includes(payload.priority || 'Medium')) return res.status(400).json({ message: 'Approval priority is invalid.' });

  const id = payload.id || `APP-${Date.now()}`;
  const result = await pool.query(
    `INSERT INTO approvals (id, title, sector, amount, owner, priority, status, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [id, payload.title, sector, Number(payload.amount || 0), payload.owner, payload.priority || 'Medium', payload.status || 'Pending', payload.requestedBy || 'Operations Team']
  );
  res.status(201).json(mapApproval(result.rows[0]));
}));

app.patch('/api/approvals/:id', authMiddleware, asyncRoute(async (req, res) => {
  const payload = req.body || {};
  const existing = await pool.query(`SELECT * FROM approvals WHERE id = $1${isAdmin(req.user) ? '' : ' AND sector = $2'}`, isAdmin(req.user) ? [req.params.id] : [req.params.id, req.user.sector]);
  if (!existing.rowCount) return res.status(404).json({ message: 'Approval not found.' });

  const current = existing.rows[0];
  const sector = validateSector(payload.sector, current.sector);
  const result = await pool.query(
    `UPDATE approvals
     SET title = $2, sector = $3, amount = $4, owner = $5, priority = $6, status = $7, requested_by = $8
     WHERE id = $1
     RETURNING *`,
    [req.params.id, payload.title ?? current.title, sector, Number(payload.amount ?? current.amount), payload.owner ?? current.owner, payload.priority ?? current.priority, payload.status ?? current.status, payload.requestedBy ?? current.requested_by]
  );
  res.json(mapApproval(result.rows[0]));
}));

app.delete('/api/approvals/:id', authMiddleware, asyncRoute(async (req, res) => {
  const result = await pool.query(`DELETE FROM approvals WHERE id = $1${isAdmin(req.user) ? '' : ' AND sector = $2'} RETURNING *`, isAdmin(req.user) ? [req.params.id] : [req.params.id, req.user.sector]);
  if (!result.rowCount) return res.status(404).json({ message: 'Approval not found.' });
  res.json({ message: 'Approval deleted successfully.', deletedApproval: mapApproval(result.rows[0]) });
}));

app.get('/api/movements', authMiddleware, asyncRoute(async (req, res) => {
  const values = [];
  let filter = '';
  if (!isAdmin(req.user)) { values.push(req.user.sector); filter = ` WHERE sector = $1`; }
  const result = await pool.query(`SELECT * FROM movements${filter} ORDER BY id DESC`, values);
  res.json(result.rows.map(mapMovement));
}));

app.post('/api/movements', authMiddleware, asyncRoute(async (req, res) => {
  const payload = req.body || {};
  const sector = validateSector(payload.sector, 'movement');
  if (!isAdmin(req.user) && sector !== req.user.sector) return res.status(403).json({ message: 'Managers can only submit movements in their assigned sector.' });
  if (!sector || !requiredText(payload.purpose) || !requiredText(payload.destination)) {
    return res.status(400).json({ message: 'Movement sector, purpose, and destination are required.' });
  }
  if (!validNumber(payload.cost)) return res.status(400).json({ message: 'Movement cost must be a valid non-negative number.' });

  const id = payload.id || `MOV-${Date.now()}`;
  const ref = payload.ref || `MF-${new Date().getFullYear()}-${Date.now().toString().slice(-4)}`;
  const result = await pool.query(
    `INSERT INTO movements (id, ref, sector, purpose, destination, status, cost, category)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [id, ref, sector, payload.purpose, payload.destination, payload.status || 'Pending', Number(payload.cost || 0), payload.category || 'Movement']
  );
  res.status(201).json(mapMovement(result.rows[0]));
}));

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
  const sector = projectResult.rows[0].sector;

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
  const sector = projectResult.rows[0].sector;

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
