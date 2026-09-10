import express from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db/database.js';
import { ALL_OPERATIONS, asyncRoute, isAdmin, requiredText, sectorIds, withinScope } from '../lib/http.js';

const router = express.Router();

// Accounts the Director can create. 'super-admin' is deliberately absent: the
// Director account is seeded, never minted through the API.
export const assignableRoles = new Set(['manager', 'staff']);

const MINIMUM_PASSWORD_LENGTH = 6;

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
    passwordChangedAt: row.password_changed_at ?? null
  };
}

// Password hashes are never selected into any response built from this list.
const ACCOUNT_SELECT = `
  SELECT u.id, u.username, u.name, u.role, u.sector, u.covers_all_sectors, u.manager_id, u.created_at, u.password_changed_at,
         m.name AS manager_name, m.sector AS manager_sector,
         (SELECT COUNT(*) FROM projects p WHERE p.manager_id = u.id)::int AS assigned_projects,
         (SELECT COUNT(*) FROM users t WHERE t.manager_id = u.id)::int AS team_size
  FROM users u
  LEFT JOIN users m ON m.id = u.manager_id
`;

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
router.get('/', adminOnly('Only the administrator can view the account register.'), asyncRoute(async (req, res) => {
  const result = await pool.query(
    `${ACCOUNT_SELECT} ORDER BY CASE WHEN u.role = 'super-admin' THEN 0 WHEN u.role = 'manager' THEN 1 ELSE 2 END, u.name`
  );
  const users = result.rows.map(mapAccount);

  res.json({
    total: users.length,
    roleCounts: users.reduce((counts, account) => ({ ...counts, [account.role]: (counts[account.role] || 0) + 1 }), {}),
    unassigned: users.filter((account) => account.role === 'staff' && !account.managerId).length,
    users
  });
}));

router.post('/', adminOnly('Only the administrator can create accounts.'), asyncRoute(async (req, res) => {
  const { username, name, password, role, sector } = req.body || {};

  if (!requiredText(username) || !requiredText(name)) {
    return res.status(400).json({ message: 'A username and a full name are required.' });
  }
  if (typeof password !== 'string' || password.trim().length < MINIMUM_PASSWORD_LENGTH) {
    return res.status(400).json({ message: `The password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.` });
  }
  if (!assignableRoles.has(role)) {
    return res.status(400).json({ message: 'Choose a role: sector manager or team member.' });
  }
  // Every non-Director account is scoped to one sector; without it their own
  // sector-scoped queries would read back nothing. The one exception is a
  // manager marked as covering all of them, which is scoped by the flag instead.
  const coversAll = role === 'manager' && sector === ALL_OPERATIONS;
  if (!coversAll && !sectorIds.has(sector)) {
    return res.status(400).json({ message: 'A valid working area is required.' });
  }
  const storedSector = coversAll ? null : sector;

  const managerId = req.body?.managerId ? Number(req.body.managerId) : null;
  if (managerId) {
    const manager = await pool.query(
      "SELECT id, sector, role, covers_all_sectors AS \"coversAllSectors\" FROM users WHERE id = $1 AND role = 'manager'",
      [managerId]
    );
    if (!manager.rowCount) return res.status(400).json({ message: 'The selected manager is invalid.' });
    // A manager covering every operation may hold staff from any of them.
    if (!coversAll && !withinScope(manager.rows[0], sector)) {
      return res.status(400).json({ message: 'The manager works in a different area. Pick a manager from the same working area.' });
    }
  }

  try {
    const inserted = await pool.query(
      `INSERT INTO users (username, password_hash, name, role, sector, manager_id, covers_all_sectors)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [username.trim(), bcrypt.hashSync(password.trim(), 10), name.trim(), role, storedSector, managerId, coversAll]
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
router.patch('/:id/password', adminOnly('Only the administrator can change a password.'), asyncRoute(async (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== 'string' || password.trim().length < MINIMUM_PASSWORD_LENGTH) {
    return res.status(400).json({ message: `The new password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.` });
  }

  // Stamped from the Node clock, not NOW(): this value is compared against a
  // JWT `iat`, which is minted here. The database clock runs a couple of
  // seconds ahead, which was enough to invalidate the fresh token the user got
  // when they signed in again straight after a reset.
  const result = await pool.query(
    'UPDATE users SET password_hash = $2, password_changed_at = $3 WHERE id = $1 RETURNING id',
    [req.params.id, bcrypt.hashSync(password.trim(), 10), new Date()]
  );
  if (!result.rowCount) return res.status(404).json({ message: 'Account not found.' });

  const account = await loadAccount(req.params.id);
  res.json({ ...account, message: 'Password updated. That user must sign in again.' });
}));

// Requirements 6 and 7: the Director moves a user between managers and between
// working areas. Both travel on this route because the pair has to stay
// consistent -- a user parked under a manager who covers another sector would
// be listed on a team whose records they cannot see.
router.patch('/:id/assignment', adminOnly('Only the administrator can change an assignment.'), asyncRoute(async (req, res) => {
  const payload = req.body || {};
  const existing = await pool.query('SELECT id, role, sector, manager_id, covers_all_sectors FROM users WHERE id = $1', [req.params.id]);
  if (!existing.rowCount) return res.status(404).json({ message: 'Account not found.' });

  const target = existing.rows[0];
  if (target.role === 'super-admin') {
    return res.status(403).json({ message: 'The Director oversees every area and reports to nobody.' });
  }

  // An absent key means "leave as is"; an explicit null means "clear it".
  const sectorGiven = Object.prototype.hasOwnProperty.call(payload, 'sector');
  const managerGiven = Object.prototype.hasOwnProperty.call(payload, 'managerId');
  if (!sectorGiven && !managerGiven) {
    return res.status(400).json({ message: 'Provide a working area, a manager, or both.' });
  }

  // 'all' is only meaningful for a manager. Left unspecified, an account that
  // already covers everything keeps doing so rather than silently collapsing to
  // a single area.
  const requestedSector = sectorGiven
    ? payload.sector
    : (target.covers_all_sectors ? ALL_OPERATIONS : target.sector);
  const coversAll = target.role === 'manager' && requestedSector === ALL_OPERATIONS;
  if (!coversAll && !sectorIds.has(requestedSector)) {
    return res.status(400).json({ message: 'A valid working area is required.' });
  }
  const sector = coversAll ? null : requestedSector;

  let managerId = managerGiven
    ? (payload.managerId === null || payload.managerId === '' ? null : Number(payload.managerId))
    : target.manager_id;

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
