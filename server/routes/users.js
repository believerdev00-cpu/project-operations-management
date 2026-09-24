import express from 'express';
import { pool, safeRollback } from '../db/database.js';
import { ALL_OPERATIONS, asyncRoute, isAdmin, operationsSql, parseId, requiredText, sectorIds, withinScope } from '../lib/http.js';
import { hashPassword, passwordProblem } from '../lib/passwords.js';

const router = express.Router();

// Accounts the Director can create. 'super-admin' is deliberately absent: the
// Director account is seeded, never minted through the API.
export const assignableRoles = new Set(['manager', 'staff']);

function adminOnly(message) {
  return (req, res, next) => {
    if (!isAdmin(req.user)) return res.status(403).json({ message });
    next();
  };
}

function mapAccount(row) {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role,
    sector: row.sector,
    operations: row.operations || (row.sector ? [row.sector] : []),
    coversAllSectors: Boolean(row.covers_all_sectors),
    managerId: row.manager_id ?? null,
    managerName: row.manager_name ?? null,
    managerSector: row.manager_sector ?? null,
    assignedProjects: row.assigned_projects ?? 0,
    teamSize: row.team_size ?? 0,
    createdAt: row.created_at,
    passwordChangedAt: row.password_changed_at ?? null,
    status: row.status || 'active',
    mustChangePassword: Boolean(row.must_change_password)
  };
}

// Password hashes are never selected into any response built from this list.
const ACCOUNT_SELECT = `
  SELECT u.id, u.username, u.name, u.role, u.sector, u.covers_all_sectors, u.manager_id, u.created_at, u.password_changed_at,
         ${operationsSql('u')} AS operations,
         u.status, u.must_change_password,
         m.name AS manager_name, m.sector AS manager_sector,
         (SELECT COUNT(*) FROM projects p WHERE p.manager_id = u.id)::int AS assigned_projects,
         (SELECT COUNT(*) FROM users t WHERE t.manager_id = u.id)::int AS team_size
  FROM users u
  LEFT JOIN users m ON m.id = u.manager_id
`;

router.param('id', (req, res, next, value) => {
  if (!parseId(value)) return res.status(404).json({ message: 'Account not found.' });
  next();
});

async function loadAccount(id) {
  const result = await pool.query(`${ACCOUNT_SELECT} WHERE u.id = $1`, [id]);
  return result.rowCount ? mapAccount(result.rows[0]) : null;
}

// A sector manager may report to a senior manager, so the chain has to be
// walked: pointing A at B while B already reports to A would orphan both.
async function createsReportingLoop(targetId, managerId) {
  const seen = new Set([Number(targetId)]);
  let current = Number(managerId);
  while (current) {
    if (seen.has(current)) return true;
    seen.add(current);
    const result = await pool.query('SELECT manager_id FROM users WHERE id = $1', [current]);
    current = result.rows[0]?.manager_id || null;
  }
  return false;
}

// The manager-per-sector trigger and the unique username index both surface as
// database errors that are the caller's fault, not the server's.
function translateConstraintError(error) {
  if (error?.code === '23505') return 'That username is already taken.';
  if (error?.code === 'P0001') return error.message;
  if (error?.code === '23514' && /users_manager_not_self/.test(error.message || '')) {
    return 'An account cannot report to itself.';
  }
  return null;
}

// The operations an account form asks for. A manager may run several -- Mining
// and Agriculture at once -- sent as `sectors`; the older single `sector` is
// still read, so a client that predates the list keeps working. 'all' (alone)
// is the all-operations manager. A team member always sits in exactly one
// operation: their manager and their work are in it. An unknown id or an empty
// list makes the request invalid rather than quietly saving less.
function requestedOperations(body, role) {
  const list = Array.isArray(body?.sectors) ? body.sectors : (body?.sector ? [body.sector] : []);
  const unique = [...new Set(list)];
  if (role === 'manager' && unique.length === 1 && unique[0] === ALL_OPERATIONS) {
    return { coversAll: true, operations: [] };
  }
  if (!unique.length || !unique.every((id) => sectorIds.has(id))) {
    return { error: 'Choose a project.' };
  }
  if (role !== 'manager' && unique.length > 1) {
    return { error: 'A team member works in one project. Choose one.' };
  }
  return { coversAll: false, operations: unique };
}

// Replace a manager's operations with exactly this set, in the caller's
// transaction. users.sector is written by the caller as the first of them, so
// the row always names an operation the manager actually runs. An
// all-operations manager holds no rows: the flag already says "every one".
async function setManagerOperations(client, managerId, operations, grantedBy) {
  await client.query('DELETE FROM manager_operations WHERE manager_id = $1 AND NOT (sector = ANY($2::text[]))', [managerId, operations]);
  if (!operations.length) return;
  await client.query(
    `INSERT INTO manager_operations (manager_id, sector, granted_by)
     SELECT $1, UNNEST($2::text[]), $3
     ON CONFLICT DO NOTHING`,
    [managerId, operations, grantedBy]
  );
}

// May this manager hold somebody who works in these operations? Every one of
// them, or the person would be on a team whose lead cannot open their work.
function coversEvery(manager, operations) {
  return operations.every((operation) => withinScope(manager, operation));
}

// The full account register, for the Director only: every user, their role, the
// manager they report to, and the working area they cover.
router.get('/', adminOnly('Only the Director can view the account register.'), asyncRoute(async (req, res) => {
  // External partners are managed from their own register, with their own
  // controls; listed here they were offered a manager and a working area that
  // mean nothing for an outside, view-only account.
  const result = await pool.query(
    `${ACCOUNT_SELECT} WHERE u.role <> 'partner'
     ORDER BY CASE WHEN u.role = 'super-admin' THEN 0 WHEN u.role = 'manager' THEN 1 ELSE 2 END, u.name`
  );
  const users = result.rows.map(mapAccount);

  res.json({
    total: users.length,
    roleCounts: users.reduce((counts, account) => ({ ...counts, [account.role]: (counts[account.role] || 0) + 1 }), {}),
    unassigned: users.filter((account) => account.role === 'staff' && !account.managerId).length,
    users
  });
}));

router.post('/', adminOnly('Only the Director can create accounts.'), asyncRoute(async (req, res) => {
  const { username, name, password, role } = req.body || {};

  if (!requiredText(username) || !requiredText(name)) {
    return res.status(400).json({ message: 'A username and a full name are required.' });
  }
  const weak = passwordProblem(password, { username });
  if (weak) return res.status(400).json({ message: weak });
  if (!assignableRoles.has(role)) {
    return res.status(400).json({ message: 'Choose a role: manager or team member.' });
  }
  // Every non-Director account is scoped to at least one operation; without it
  // their own scoped queries would read back nothing. A manager may run
  // several; one marked as covering all of them is scoped by the flag instead.
  const requested = requestedOperations(req.body, role);
  if (requested.error) return res.status(400).json({ message: requested.error });
  const { coversAll, operations } = requested;
  const storedSector = coversAll ? null : operations[0];

  const managerId = req.body?.managerId ? parseId(req.body.managerId) : null;
  if (req.body?.managerId && !managerId) return res.status(400).json({ message: 'The selected manager is invalid.' });
  if (managerId) {
    const manager = await pool.query(
      `SELECT id, sector, role, covers_all_sectors AS "coversAllSectors", ${operationsSql('users')} AS operations FROM users WHERE id = $1 AND role = 'manager'`,
      [managerId]
    );
    if (!manager.rowCount) return res.status(400).json({ message: 'The selected manager is invalid.' });
    // A manager covering every operation may hold staff from any of them.
    if (!coversAll && !coversEvery(manager.rows[0], operations)) {
      return res.status(400).json({ message: 'That manager works in a different project. Pick a manager from the same one.' });
    }
  }

  const passwordHash = await hashPassword(password);
  const client = await pool.connect();
  let createdId;
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      // The password the Director typed is temporary: the new user chooses their
      // own at first sign-in, so the Director never knows it.
      `INSERT INTO users (username, password_hash, name, role, sector, manager_id, covers_all_sectors, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE) RETURNING id`,
      [username.trim(), passwordHash, name.trim(), role, storedSector, managerId, coversAll]
    );
    createdId = inserted.rows[0].id;
    // In the same transaction, so the three-managers limit on a second
    // operation refuses the whole account rather than leaving half of it.
    if (role === 'manager') await setManagerOperations(client, createdId, operations, req.user.id);
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    const message = translateConstraintError(error);
    if (!message) throw error;
    return res.status(400).json({ message });
  } finally {
    client.release();
  }
  res.status(201).json(await loadAccount(createdId));
}));

// Reset only. The stored value is a bcrypt hash and is never read back, so a
// forgotten password is replaced rather than recovered.
router.patch('/:id/password', adminOnly('Only the Director can change a password.'), asyncRoute(async (req, res) => {
  const { password } = req.body || {};
  const weak = passwordProblem(password);
  if (weak) return res.status(400).json({ message: weak });

  // Stamped from the Node clock, not NOW(): this value is compared against a
  // JWT `iat`, which is minted here. The database clock runs a couple of
  // seconds ahead, which was enough to invalidate the fresh token the user got
  // when they signed in again straight after a reset.
  const result = await pool.query(
    // A reset password is temporary too: the owner chooses their own next time.
    // Only internal accounts: partners are reset from their own register.
    "UPDATE users SET password_hash = $2, password_changed_at = $3, must_change_password = TRUE WHERE id = $1 AND role <> 'partner' RETURNING id",
    [req.params.id, await hashPassword(password), new Date()]
  );
  if (!result.rowCount) return res.status(404).json({ message: 'Account not found.' });

  const account = await loadAccount(req.params.id);
  res.json({ ...account, message: 'Password updated. That user must sign in again.' });
}));

// Suspend or reactivate a manager or team member. Before this there was no way
// to stop an internal account at all: someone who had left kept signing in until
// the Director thought to reset their password. authMiddleware reads the status
// on every request, so a suspension ends every open session at once.
//
// The suspension is never blocked by work the person still holds -- locking out
// someone who has left cannot wait -- but that work is reported back, because
// approvals naming them wait on an account that can no longer act.
router.patch('/:id/status', adminOnly('Only the Director can suspend or reactivate an account.'), asyncRoute(async (req, res) => {
  const { status } = req.body || {};
  if (!['active', 'suspended'].includes(status)) {
    return res.status(400).json({ message: 'Status must be active or suspended.' });
  }
  if (Number(req.params.id) === Number(req.user.id)) {
    return res.status(400).json({ message: 'You cannot suspend your own account.' });
  }
  const result = await pool.query(
    "UPDATE users SET status = $2 WHERE id = $1 AND role IN ('manager', 'staff') RETURNING id",
    [req.params.id, status]
  );
  if (!result.rowCount) return res.status(404).json({ message: 'Account not found.' });

  const account = await loadAccount(req.params.id);
  if (status === 'active') return res.json({ ...account, message: `${account.name} can sign in again.` });

  const held = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM activities WHERE approval_required_from = $1 AND approval_status = 'pending'
          AND status NOT IN ('Draft', 'Cancelled', 'On Hold'))::int
     + (SELECT COUNT(*) FROM movements WHERE approval_required_from = $1 AND approval_status = 'pending'
          AND status NOT IN ('Draft', 'Cancelled', 'On Hold'))::int AS approvals,
       (SELECT COUNT(*) FROM activities WHERE assigned_to = $1
          AND status NOT IN ('Completed', 'Rejected', 'Cancelled'))::int AS activities,
       (SELECT COUNT(*) FROM monthly_plans WHERE manager_id = $1 AND status <> 'Closed')::int AS plans`,
    [account.id]
  );
  const { approvals, activities, plans } = held.rows[0];
  res.json({
    ...account,
    heldWork: { approvals, activities, plans },
    message: `${account.name} is suspended and signed out everywhere.`
  });
}));

// Requirements 6 and 7: the Director moves a user between managers and between
// working areas. Both travel on this route because the pair has to stay
// consistent -- a user parked under a manager who covers another sector would
// be listed on a team whose records they cannot see.
router.patch('/:id/assignment', adminOnly('Only the Director can change an assignment.'), asyncRoute(async (req, res) => {
  const payload = req.body || {};
  const existing = await pool.query(
    `SELECT id, role, sector, manager_id, covers_all_sectors, ${operationsSql('users')} AS operations FROM users WHERE id = $1`,
    [req.params.id]
  );
  if (!existing.rowCount) return res.status(404).json({ message: 'Account not found.' });

  const target = existing.rows[0];
  if (target.role === 'super-admin') {
    return res.status(403).json({ message: 'The Director oversees every area and reports to nobody.' });
  }
  if (target.role === 'partner') {
    return res.status(403).json({ message: 'Change an external partner\'s project from External Partners.' });
  }

  // An absent key means "leave as is"; an explicit null means "clear it".
  const sectorGiven = Object.prototype.hasOwnProperty.call(payload, 'sector')
    || Object.prototype.hasOwnProperty.call(payload, 'sectors');
  const managerGiven = Object.prototype.hasOwnProperty.call(payload, 'managerId');
  if (!sectorGiven && !managerGiven) {
    return res.status(400).json({ message: 'Choose a project, a manager, or both.' });
  }

  // 'all' is only meaningful for a manager. Left unspecified, an account keeps
  // exactly what it covers -- every operation, or each of its operations --
  // rather than silently collapsing to the first one.
  const currentOperations = target.covers_all_sectors ? [] : (target.operations || []);
  const requested = sectorGiven
    ? requestedOperations(payload, target.role)
    : { coversAll: Boolean(target.covers_all_sectors), operations: currentOperations };
  if (requested.error) return res.status(400).json({ message: requested.error });
  const { coversAll, operations } = requested;
  const sector = coversAll ? null : operations[0];

  let managerId = managerGiven
    ? (payload.managerId === null || payload.managerId === '' ? null : parseId(payload.managerId))
    : target.manager_id;
  if (managerGiven && payload.managerId !== null && payload.managerId !== '' && !managerId) {
    return res.status(400).json({ message: 'The selected manager is invalid.' });
  }

  if (managerId) {
    if (!Number.isInteger(managerId)) return res.status(400).json({ message: 'The selected manager is invalid.' });
    if (managerId === target.id) return res.status(400).json({ message: 'An account cannot report to itself.' });

    const manager = await pool.query(
      `SELECT id, sector, role, covers_all_sectors AS "coversAllSectors", ${operationsSql('users')} AS operations
       FROM users WHERE id = $1 AND role = 'manager'`,
      [managerId]
    );
    if (!manager.rowCount) return res.status(400).json({ message: 'The selected manager is invalid.' });
    if (!coversAll && !coversEvery(manager.rows[0], operations)) {
      return res.status(400).json({
        message: 'That manager works in a different area. Move the user to the manager\'s area, or pick a manager from this one.'
      });
    }
    if (await createsReportingLoop(target.id, managerId)) {
      return res.status(400).json({ message: 'That assignment would create a reporting loop.' });
    }
  }

  // A manager whose scope narrows -- taken off one of their operations, or no
  // longer covering every operation -- loses sight of everything outside the
  // new set, so work they still hold there would be stranded: expenses nobody
  // can record, a month-end report nobody can file, approvals nobody else can
  // give. The change waits until that work has been handed to somebody else.
  // Adding an operation, or widening to every one, strands nothing.
  const narrows = target.role === 'manager' && !coversAll
    && (target.covers_all_sectors || currentOperations.some((operation) => !operations.includes(operation)));
  if (narrows) {
    // "Outside the new set" includes work with no operation at all, which the
    // old IS DISTINCT FROM comparison counted too.
    const held = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM activities
           WHERE NOT (COALESCE(sector, '') = ANY($2::text[])) AND assigned_to = $1
             AND status NOT IN ('Completed', 'Rejected', 'Cancelled'))::int AS activities,
         (SELECT COUNT(*) FROM activities
           WHERE NOT (COALESCE(sector, '') = ANY($2::text[])) AND approval_required_from = $1 AND approval_status = 'pending'
             AND status NOT IN ('Draft', 'Cancelled', 'On Hold'))::int AS approvals,
         (SELECT COUNT(*) FROM monthly_plans
           WHERE NOT (COALESCE(sector, '') = ANY($2::text[])) AND manager_id = $1 AND status <> 'Closed')::int AS plans`,
      [target.id, operations]
    );
    const { activities, approvals, plans } = held.rows[0];
    if (activities || approvals || plans) {
      const parts = [
        activities && `${activities} open ${activities === 1 ? 'activity' : 'activities'}`,
        approvals && `${approvals} pending ${approvals === 1 ? 'approval' : 'approvals'}`,
        plans && `${plans} open monthly ${plans === 1 ? 'plan' : 'plans'}`
      ].filter(Boolean);
      return res.status(409).json({
        message: `Hand this manager's work in their current area to someone else first: ${parts.join(', ')}.`
      });
    }
  }

  // The account row and its operations move together, so the three-managers
  // limit on any one of them refuses the whole change rather than half of it.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE users SET sector = $2, manager_id = $3, covers_all_sectors = $4 WHERE id = $1',
      [target.id, sector, managerId, coversAll]
    );
    if (target.role === 'manager') await setManagerOperations(client, target.id, operations, req.user.id);
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    const message = translateConstraintError(error);
    if (!message) throw error;
    return res.status(400).json({ message });
  } finally {
    client.release();
  }

  // Taking a manager off an operation strands the team that reported to them
  // there, so the link is dropped rather than left inconsistent. A manager who
  // now covers every area strands nobody: their team is in scope whichever
  // area each member sits in.
  let detached = 0;
  if (narrows) {
    const cleared = await pool.query(
      'UPDATE users SET manager_id = NULL WHERE manager_id = $1 AND NOT (COALESCE(sector, \'\') = ANY($2::text[])) RETURNING id',
      [target.id, operations]
    );
    detached = cleared.rowCount;
  }

  const account = await loadAccount(target.id);
  res.json({
    ...account,
    detachedTeamMembers: detached,
    message: detached
      ? `Assignment updated. ${detached} team member${detached === 1 ? '' : 's'} left without a manager by the move.`
      : 'Assignment updated.'
  });
}));

export default router;
