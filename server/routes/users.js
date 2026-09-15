import express from 'express';
import { pool } from '../db/database.js';
import { ALL_OPERATIONS, asyncRoute, isAdmin, parseId, requiredText, sectorIds, withinScope } from '../lib/http.js';
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
  const { username, name, password, role, sector } = req.body || {};

  if (!requiredText(username) || !requiredText(name)) {
    return res.status(400).json({ message: 'A username and a full name are required.' });
  }
  const weak = passwordProblem(password, { username });
  if (weak) return res.status(400).json({ message: weak });
  if (!assignableRoles.has(role)) {
    return res.status(400).json({ message: 'Choose a role: manager or team member.' });
  }
  // Every non-Director account is scoped to one sector; without it their own
  // sector-scoped queries would read back nothing. The one exception is a
  // manager marked as covering all of them, which is scoped by the flag instead.
  const coversAll = role === 'manager' && sector === ALL_OPERATIONS;
  if (!coversAll && !sectorIds.has(sector)) {
    return res.status(400).json({ message: 'Choose a business operation.' });
  }
  const storedSector = coversAll ? null : sector;

  const managerId = req.body?.managerId ? parseId(req.body.managerId) : null;
  if (req.body?.managerId && !managerId) return res.status(400).json({ message: 'The selected manager is invalid.' });
  if (managerId) {
    const manager = await pool.query(
      "SELECT id, sector, role, covers_all_sectors AS \"coversAllSectors\" FROM users WHERE id = $1 AND role = 'manager'",
      [managerId]
    );
    if (!manager.rowCount) return res.status(400).json({ message: 'The selected manager is invalid.' });
    // A manager covering every operation may hold staff from any of them.
    if (!coversAll && !withinScope(manager.rows[0], sector)) {
      return res.status(400).json({ message: 'That manager works in a different business operation. Pick a manager from the same one.' });
    }
  }

  try {
    const inserted = await pool.query(
      // The password the Director typed is temporary: the new user chooses their
      // own at first sign-in, so the Director never knows it.
      `INSERT INTO users (username, password_hash, name, role, sector, manager_id, covers_all_sectors, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE) RETURNING id`,
      [username.trim(), await hashPassword(password), name.trim(), role, storedSector, managerId, coversAll]
    );
    res.status(201).json(await loadAccount(inserted.rows[0].id));
  } catch (error) {
    const message = translateConstraintError(error);
    if (!message) throw error;
    res.status(400).json({ message });
  }
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
  const existing = await pool.query('SELECT id, role, sector, manager_id, covers_all_sectors FROM users WHERE id = $1', [req.params.id]);
  if (!existing.rowCount) return res.status(404).json({ message: 'Account not found.' });

  const target = existing.rows[0];
  if (target.role === 'super-admin') {
    return res.status(403).json({ message: 'The Director oversees every area and reports to nobody.' });
  }
  if (target.role === 'partner') {
    return res.status(403).json({ message: 'Change an external partner\'s business operation from External Partners.' });
  }

  // An absent key means "leave as is"; an explicit null means "clear it".
  const sectorGiven = Object.prototype.hasOwnProperty.call(payload, 'sector');
  const managerGiven = Object.prototype.hasOwnProperty.call(payload, 'managerId');
  if (!sectorGiven && !managerGiven) {
    return res.status(400).json({ message: 'Choose a business operation, a manager, or both.' });
  }

  // 'all' is only meaningful for a manager. Left unspecified, an account that
  // already covers everything keeps doing so rather than silently collapsing to
  // a single area.
  const requestedSector = sectorGiven
    ? payload.sector
    : (target.covers_all_sectors ? ALL_OPERATIONS : target.sector);
  const coversAll = target.role === 'manager' && requestedSector === ALL_OPERATIONS;
  if (!coversAll && !sectorIds.has(requestedSector)) {
    return res.status(400).json({ message: 'Choose a business operation.' });
  }
  const sector = coversAll ? null : requestedSector;

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
      "SELECT id, sector, role, covers_all_sectors AS \"coversAllSectors\" FROM users WHERE id = $1 AND role = 'manager'",
      [managerId]
    );
    if (!manager.rowCount) return res.status(400).json({ message: 'The selected manager is invalid.' });
    if (!coversAll && !withinScope(manager.rows[0], sector)) {
      return res.status(400).json({
        message: 'That manager works in a different area. Move the user to the manager\'s area, or pick a manager from this one.'
      });
    }
    if (await createsReportingLoop(target.id, managerId)) {
      return res.status(400).json({ message: 'That assignment would create a reporting loop.' });
    }
  }

  // A manager whose scope narrows -- moved to another area, or no longer
  // covering every area -- loses sight of everything outside the new one, so
  // work they still hold there would be stranded: expenses nobody can record, a
  // month-end report nobody can file, approvals nobody else can give. The move
  // waits until that work has been handed to somebody else. Widening to every
  // area strands nothing.
  const narrows = target.role === 'manager' && !coversAll
    && (target.covers_all_sectors || sector !== target.sector);
  if (narrows) {
    const held = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM activities
           WHERE sector IS DISTINCT FROM $2 AND assigned_to = $1
             AND status NOT IN ('Completed', 'Rejected', 'Cancelled'))::int AS activities,
         (SELECT COUNT(*) FROM activities
           WHERE sector IS DISTINCT FROM $2 AND approval_required_from = $1 AND approval_status = 'pending'
             AND status NOT IN ('Draft', 'Cancelled', 'On Hold'))::int AS approvals,
         (SELECT COUNT(*) FROM monthly_plans
           WHERE sector IS DISTINCT FROM $2 AND manager_id = $1 AND status <> 'Closed')::int AS plans`,
      [target.id, sector]
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

  try {
    await pool.query(
      'UPDATE users SET sector = $2, manager_id = $3, covers_all_sectors = $4 WHERE id = $1',
      [target.id, sector, managerId, coversAll]
    );
  } catch (error) {
    const message = translateConstraintError(error);
    if (!message) throw error;
    return res.status(400).json({ message });
  }

  // Moving a manager to another area strands the team that reported to them in
  // the area they left, so the link is dropped rather than left inconsistent.
  // A manager who now covers every area strands nobody: their team is in scope
  // whichever area each member sits in.
  let detached = 0;
  if (target.role === 'manager' && !coversAll && sector !== target.sector) {
    const cleared = await pool.query('UPDATE users SET manager_id = NULL WHERE manager_id = $1 AND sector <> $2 RETURNING id', [target.id, sector]);
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
