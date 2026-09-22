import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initDatabase, pool } from './db/database.js';
import { sectors } from './data/seedData.js';
import { authMiddleware, jwtSecret, FILE_PATH, FILE_TOKEN_PURPOSE } from './lib/auth.js';
import { hashPassword, passwordMatches, passwordProblem } from './lib/passwords.js';
import { asyncRoute, hasFullScope, isAdmin, managerScope, parseId, projectScope, requiredText, validNumber, validateSector, withinScope } from './lib/http.js';
import { pendingForMeSql } from './lib/approvals.js';
import { getCurrentRate } from './lib/rates.js';
import { FINAL_CHECK_SQL, openWorkSql } from './lib/monthly.js';
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
    // Worked out from the project's activities, never typed. The Budget and
    // Spent a Director used to type by hand (in RWF) fed the dashboard and never
    // matched the real approved budgets and recorded expenses (in USD).
    approvedUsd: Number(row.approved_usd || 0),
    spentUsd: Number(row.spent_usd || 0),
    activityCount: Number(row.activity_count || 0),
    completedCount: Number(row.completed_count || 0),
    updatedAt: row.updated_at
  };
}

// The money and progress of each project, from its live activities: approved
// budgets of approved work, every expense recorded against it, and how much of
// the work is done. Refused and cancelled work counts towards none of it.
const PROJECT_FIGURES = `
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(SUM(a.approved_budget) FILTER (
        WHERE a.approval_status = 'approved' AND a.status NOT IN ('Rejected', 'Cancelled')), 0) AS approved_usd,
      COUNT(*) FILTER (WHERE a.status NOT IN ('Rejected', 'Cancelled')) AS activity_count,
      COUNT(*) FILTER (WHERE a.status = 'Completed') AS completed_count
    FROM activities a WHERE a.project_id = p.id
  ) work ON TRUE
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(e.amount), 0) AS spent_usd
    FROM activity_expenses e JOIN activities a ON a.id = e.activity_id
    WHERE a.project_id = p.id
  ) money ON TRUE`;

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

// A reverse proxy puts the client address in X-Forwarded-For, and without
// trusting that hop every request appears to come from the proxy. But with no
// proxy in front -- `node server/index.js` answering directly, which is how this
// app is deployed -- trusting it lets any caller write their own address into
// the header, and a fresh fake address per guess walked straight past the login
// limiter. So it is off unless TRUST_PROXY says how many proxies there are.
// Vercel always sits behind its own proxy, so the hop is trusted there without
// anyone having to remember the setting.
if (process.env.TRUST_PROXY || process.env.VERCEL) {
  const hops = Number(process.env.TRUST_PROXY || 1);
  app.set('trust proxy', Number.isInteger(hops) ? hops : process.env.TRUST_PROXY);
}

// Until this process also served the built client, helmet's policy only ever
// applied to JSON and the content policy did nothing. It now applies to the
// document itself. Every script, stylesheet, font and image the interface loads
// is same-origin, which the defaults already allow; the one default that has to
// go is below.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      // upgrade-insecure-requests only means anything behind HTTPS, where this
      // app has no http subresources for it to fix. On plain http it is
      // actively harmful: it rewrites same-origin asset requests to https, so a
      // LAN address opened on a phone, or a host that terminates TLS in front of
      // this process, loads a blank page.
      'upgrade-insecure-requests': null
    }
  }
}));
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '1mb' }));

// Slows password guessing. In-memory and per-process: behind more than one
// instance this needs a shared store.
//
// Two counters, because each alone was beatable. Keyed by address only, one
// insider could mix a guess at the Director's password with a successful
// sign-in of their own -- successes are not counted, so the budget never ran
// out. Keyed by account as well, guesses at one account are capped however
// they are spread out, and the address counter still stops one machine trying
// a password against many accounts. An office behind one shared address is
// why the address limit is the looser of the two.
const TOO_MANY_ATTEMPTS = { code: 'TOO_MANY_ATTEMPTS', message: 'Too many login attempts. Try again in a few minutes.' };
const addressLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: TOO_MANY_ATTEMPTS
});
const accountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: false,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `account:${String(req.body?.username || '').trim().toLowerCase()}`,
  message: TOO_MANY_ATTEMPTS
});
// Checking the current password is itself a guessable sign-in, so it is capped
// per signed-in account.
const passwordChangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: false,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `password-change:${req.user?.id}`,
  message: TOO_MANY_ATTEMPTS
});

// What the browser is told about the signed-in account. Built in one place so
// sign-in, the session check and a password change can never disagree.
function publicAccount(row) {
  return {
    id: row.id, username: row.username, name: row.name, role: row.role, sector: row.sector,
    email: row.email || null,
    status: row.status || 'active',
    accessLevel: row.access_level || 'internal',
    coversAllSectors: Boolean(row.covers_all_sectors),
    mustChangePassword: Boolean(row.must_change_password)
  };
}

// Only the account id and the issue time are trusted from a token --
// authMiddleware reads everything else back from the row -- so that is all a
// new token carries.
function sessionToken(account, issuedAt) {
  const claims = { id: account.id };
  if (issuedAt) claims.iat = issuedAt;
  return jwt.sign(claims, jwtSecret, { algorithm: 'HS256', expiresIn: '12h' });
}

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

// Everybody who can be handed work: the managers and the team members of the
// caller's operation. Kept apart from /api/managers deliberately -- that list
// answers "which manager runs this?" (a project, a month, who somebody reports
// to) and must not start offering team members for those. This one answers "who
// is doing this day's work?", which a team member is exactly the answer to.
//
// Suspended accounts are left out, because every route that accepts an assignee
// refuses one -- offering them would be offering a choice that cannot be saved.
app.get('/api/people', authMiddleware, asyncRoute(async (req, res) => {
  const values = [];
  let scope = '';
  if (!hasFullScope(req.user)) {
    values.push(req.user.sector);
    scope = ` AND (sector = $${values.length} OR covers_all_sectors)`;
  }
  const result = await pool.query(
    `SELECT id, username, name, role, sector, covers_all_sectors AS "coversAllSectors"
     FROM users
     WHERE role IN ('manager', 'staff') AND status = 'active'${scope}
     ORDER BY CASE role WHEN 'manager' THEN 0 ELSE 1 END, name`,
    values
  );
  res.json(result.rows);
}));

// The account register, the Director's user-management surface: the roster, the
// roles, who reports to whom, and the working areas. Password hashes never
// leave the database, so a password is reset, never read back.
app.use('/api/users', authMiddleware, userRouter);

const ACCOUNT_COLUMNS = 'id, username, name, role, sector, email, status, access_level, covers_all_sectors, must_change_password';

app.post('/api/auth/login', addressLimiter, accountLimiter, asyncRoute(async (req, res) => {
  const { username, password } = req.body || {};
  const result = await pool.query(
    `SELECT ${ACCOUNT_COLUMNS}, password_hash, password_changed_at FROM users WHERE username = $1`,
    [typeof username === 'string' ? username.trim() : '']
  );
  const user = result.rows[0];

  if (!(await passwordMatches(password, user?.password_hash))) {
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
        ? 'This account is suspended. Contact the Director.'
        : 'Access to this account has been revoked.'
    });
  }

  // authMiddleware refuses tokens issued before the second a password changed,
  // rounded up. Signing in during that same second -- straight after a reset --
  // produced a token already refused, so the issue time is never earlier.
  const changedAt = user.password_changed_at ? Math.ceil(new Date(user.password_changed_at).getTime() / 1000) : 0;
  const issuedAt = Math.max(Math.floor(Date.now() / 1000), changedAt);
  res.json({ token: sessionToken(user, issuedAt), user: publicAccount(user) });
}));

app.get('/api/auth/session', authMiddleware, asyncRoute(async (req, res) => {
  const result = await pool.query(`SELECT ${ACCOUNT_COLUMNS} FROM users WHERE id = $1`, [req.user.id]);
  res.json({ user: result.rowCount ? publicAccount(result.rows[0]) : null });
}));

// The owner choosing their own password: at the first sign-in after the Director
// set one, or whenever they like from their account menu. The current password
// is asked for even though the caller holds a session, so a session left open on
// a shared computer cannot be turned into a permanent takeover.
app.post('/api/auth/password', authMiddleware, passwordChangeLimiter, asyncRoute(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const found = await pool.query(`SELECT ${ACCOUNT_COLUMNS}, password_hash FROM users WHERE id = $1`, [req.user.id]);
  const account = found.rows[0];
  if (!account) return res.status(401).json({ code: 'ACCOUNT_GONE', message: 'Account no longer exists.' });

  if (!(await passwordMatches(currentPassword, account.password_hash))) {
    return res.status(400).json({ code: 'CURRENT_PASSWORD_WRONG', message: 'Your current password is not correct.' });
  }
  const problem = passwordProblem(newPassword, { username: account.username });
  if (problem) return res.status(400).json({ code: 'PASSWORD_WEAK', message: problem });
  if (await passwordMatches(newPassword, account.password_hash)) {
    return res.status(400).json({ code: 'PASSWORD_SAME', message: 'Choose a password different from the current one.' });
  }

  // Every other session on this account ends here: authMiddleware refuses tokens
  // issued before password_changed_at. The token handed back is issued at the
  // second that check rounds up to, so this one session carries on.
  const changedAt = new Date();
  await pool.query(
    'UPDATE users SET password_hash = $2, password_changed_at = $3, must_change_password = FALSE WHERE id = $1',
    [account.id, await hashPassword(newPassword), changedAt]
  );
  const updated = { ...account, must_change_password: false };
  res.json({
    token: sessionToken(updated, Math.ceil(changedAt.getTime() / 1000)),
    user: publicAccount(updated),
    message: 'Your password has been changed.'
  });
}));

// A short-lived link to one evidence file, for opening it in a new tab. See
// FILE_PATH in lib/auth.js for why the session token is never put in a URL.
// Nothing about the record is checked here: the file route itself runs the full
// permission check when the link is opened, with this account.
app.post('/api/auth/file-link', authMiddleware, (req, res) => {
  const filePath = typeof req.body?.path === 'string' ? req.body.path : '';
  if (!FILE_PATH.test(filePath)) return res.status(400).json({ message: 'That is not a file address.' });
  const fileToken = jwt.sign(
    { id: req.user.id, purpose: FILE_TOKEN_PURPOSE, path: filePath },
    jwtSecret,
    { algorithm: 'HS256', expiresIn: '5m' }
  );
  res.json({ url: `${filePath}?token=${encodeURIComponent(fileToken)}` });
});

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

  // The home screen's "what needs doing" counts, from the same predicates as the
  // lists they open, so a tile never promises more or fewer than the list holds.
  const workValues = [...scopeValues];
  const homeCounts = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM activities a WHERE ${openWorkSql(workValues, 'a', req.user.id)})::int AS my_open_work,
       (SELECT COUNT(*) FROM activities a WHERE ${FINAL_CHECK_SQL('a')}${scoped ? ' AND a.sector = $1' : ''})::int AS final_checks,
       (SELECT COUNT(*) FROM monthly_reports r JOIN monthly_plans p ON p.id = r.plan_id
         WHERE r.status = 'Submitted' AND p.status <> 'Closed'${scoped ? ' AND p.sector = $1' : ''})::int AS month_end_reports`,
    workValues
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
      COUNT(*) FILTER (WHERE status = 'Completed')::int AS completed_activities,
      COUNT(*) FILTER (WHERE status = 'Pending Approval' AND approval_status = 'pending')::int AS decisions_pending,
      COUNT(*) FILTER (WHERE ${FINAL_CHECK_SQL('activities')})::int AS final_checks
      FROM activities${whereSector} GROUP BY sector`, scopeValues),
    pool.query(`SELECT sector, COUNT(*)::int AS approvals_pending FROM approvals WHERE status = 'Pending'${andSector} GROUP BY sector`, scopeValues),
    // Per operation, a movement counts towards the operation it supported, and
    // a standalone one towards Facilitation itself.
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
        decisionsPending: a.decisions_pending || 0,
        finalChecks: a.final_checks || 0,
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
      myOpenWork: homeCounts.rows[0].my_open_work,
      finalChecksWaiting: homeCounts.rows[0].final_checks,
      monthEndReportsWaiting: homeCounts.rows[0].month_end_reports,
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
  // A manager responsible for particular projects sees those projects only.
  projectScope(req.user, 'p.id', values, filters);

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT p.*, u.name AS manager_name, work.approved_usd, work.activity_count, work.completed_count, money.spent_usd
     FROM projects p LEFT JOIN users u ON u.id = p.manager_id ${PROJECT_FIGURES} ${where} ORDER BY p.updated_at DESC`,
    values
  );
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
    return res.status(403).json({ message: 'Managers can only update projects in their own business operation.' });
  }
  // Anything left out of the body keeps its current value. Defaulting a missing
  // sector to 'agriculture' silently moved projects the Director edited.
  const { project, error } = readProjectPayload(payload, current);
  if (error) return res.status(400).json({ message: error });
  if (!withinScope(req.user, project.sector)) {
    return res.status(403).json({ message: 'Managers cannot move a project to another business operation.' });
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
    return res.status(403).json({ message: 'Only a manager can make a request for approval.' });
  }
  const sector = validateSector(payload.sector, req.user.sector);
  if (sector && !withinScope(req.user, sector)) return res.status(403).json({ message: 'Managers can only make requests in their own business operation.' });
  if (!sector || !requiredText(payload.title) || !requiredText(payload.owner)) {
    return res.status(400).json({ message: 'What is needed, the business operation and the owner are required.' });
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
    return res.status(403).json({ message: 'Managers cannot move a request to another business operation.' });
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

// An /api path nothing matched is answered in JSON, not by the SPA fallback
// below. Handing back index.html would give the client an HTML page where it
// parses a response body, so a mistyped route would surface as a parse error
// rather than a 404.
app.use('/api', (req, res) => {
  res.status(404).json({ message: 'Endpoint not found.' });
});

// ---------------------------------------------------------------------------
// The built interface, served by this same process.
//
// This is what makes one server on one port the whole deployment: `npm run
// build` writes dist/, and `node server/index.js` then answers both the API and
// the interface on PORT. Nothing else changes -- development still runs Vite on
// :5173 proxying /api here. When dist/ has not been built none of this is mounted,
// and the process behaves exactly as it did before.
const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const clientIndex = path.join(clientDir, 'index.html');

if (fs.existsSync(clientIndex)) {
  app.use(express.static(clientDir, {
    // index.html is served by the fallback below, which has to run for every
    // address the hash router can produce, not just '/'.
    index: false,
    setHeaders(response, filePath) {
      // Vite writes a content hash into every filename under dist/assets, so
      // those are safe to cache forever. Everything copied from public/ -- the
      // logos, the icons, the manifest -- keeps its name across releases, so a
      // long cache there would keep serving the previous logo until the browser
      // gave it up on its own.
      const hashed = filePath.includes(`${path.sep}assets${path.sep}`);
      response.setHeader('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
    }
  }));

  app.use((req, res, next) => {
    // Only a document request can be the SPA. A POST or PUT that matched no
    // route is a genuine 404, and answering it with the page would hide it.
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    // Never cached: this is the file that names the current bundle, and a cached
    // copy pins the browser to the release before last.
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(clientIndex, (error) => {
      if (error) next(error);
    });
  });
}


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
