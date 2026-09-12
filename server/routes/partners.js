// The Director's control over external business partner access.
//
// Invite a partner, assign them one business operation, change it, suspend or
// revoke their access. Partners are ordinary rows in `users` with role
// 'partner', so they authenticate, have their password reset and appear in the
// register through the paths that already exist -- this router is only the
// management surface the Director works from.
//
// Every route here is Director-only. A partner cannot reach this file at all:
// authMiddleware refuses them anything outside /api/partner before a handler
// runs.

import express from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db/database.js';
import { asyncRoute, isAdmin, parseId, requiredText, sectorIds } from '../lib/http.js';
import { operationById } from '../../shared/businessOperations.js';

const router = express.Router();

const MINIMUM_PASSWORD_LENGTH = 6;
export const PARTNER_STATUSES = ['active', 'suspended', 'revoked'];

router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ message: 'Authentication required.' });
  if (!isAdmin(req.user)) {
    return res.status(403).json({ message: 'Only the administrator can manage external partner access.' });
  }
  next();
});

// Every /:id here is a users.id. Anything that is not one is simply not a
// partner, rather than an integer cast Postgres refuses with a server error.
router.param('id', (req, res, next, value) => {
  if (!parseId(value)) return res.status(404).json({ message: 'External partner not found.' });
  next();
});

function mapPartner(row) {
  const operation = operationById(row.sector);
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    email: row.email || '',
    // The one business operation this partner may see. Named as well as keyed,
    // so the register never shows a bare id.
    operation: row.sector,
    operationName: operation?.name || row.sector,
    accessLevel: row.access_level || 'view-only',
    status: row.status || 'active',
    createdAt: row.created_at,
    passwordChangedAt: row.password_changed_at ?? null,
    // What the partner can actually see right now, which is the figure that
    // tells the Director whether the access is doing anything.
    visibleActivities: row.visible_activities ?? 0,
    visibleMovements: row.visible_movements ?? 0
  };
}

const PARTNER_SELECT = `
  SELECT u.id, u.username, u.name, u.email, u.sector, u.status, u.access_level,
         u.created_at, u.password_changed_at,
         (SELECT COUNT(*) FROM activities a
           WHERE a.sector = u.sector AND a.approval_status = 'approved'
             AND a.externally_visible = TRUE
             AND a.status NOT IN ('Draft', 'Cancelled', 'Rejected'))::int AS visible_activities,
         (SELECT COUNT(*) FROM movements m
           WHERE (CASE WHEN u.sector = 'movement'
                       THEN (m.related_area IS NULL OR m.related_area = u.sector)
                       ELSE m.related_area = u.sector END)
             AND m.approval_status = 'approved' AND m.externally_visible = TRUE
             AND m.status NOT IN ('Draft', 'Cancelled', 'Rejected'))::int AS visible_movements
  FROM users u
  WHERE u.role = 'partner'
`;

async function loadPartner(id) {
  const result = await pool.query(`${PARTNER_SELECT} AND u.id = $1`, [id]);
  return result.rowCount ? mapPartner(result.rows[0]) : null;
}

// A partner's operation must be one of the four, and must be spelled with the
// id the rest of the database uses.
function validOperation(value) {
  return typeof value === 'string' && sectorIds.has(value);
}

router.get('/', asyncRoute(async (req, res) => {
  const result = await pool.query(`${PARTNER_SELECT} ORDER BY u.name`);
  const partners = result.rows.map(mapPartner);
  res.json({
    total: partners.length,
    byOperation: partners.reduce(
      (counts, partner) => ({ ...counts, [partner.operation]: (counts[partner.operation] || 0) + 1 }),
      {}
    ),
    active: partners.filter((partner) => partner.status === 'active').length,
    partners
  });
}));

// Invite a partner: an account, one business operation, view-only.
router.post('/', asyncRoute(async (req, res) => {
  const { name, email, username, password, operation } = req.body || {};

  if (!requiredText(name)) return res.status(400).json({ message: 'The partner\'s name is required.' });
  if (!requiredText(username)) return res.status(400).json({ message: 'A username is required for the partner to sign in with.' });
  if (!requiredText(email) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    return res.status(400).json({ message: 'A valid email address is required.' });
  }
  if (typeof password !== 'string' || password.trim().length < MINIMUM_PASSWORD_LENGTH) {
    return res.status(400).json({ message: `The password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.` });
  }
  if (!validOperation(operation)) {
    return res.status(400).json({ message: 'Choose one business operation: Farming, Agriculture, Mining, or Movements & Facilitation.' });
  }
  // View-only is the only level an external partner is given. Anything else in
  // the request is refused outright rather than quietly downgraded, so a
  // mistaken call is visible instead of silently doing something else.
  const accessLevel = req.body?.accessLevel || 'view-only';
  if (accessLevel !== 'view-only') {
    return res.status(400).json({ message: 'An external partner can only be given View Only access.' });
  }

  try {
    const inserted = await pool.query(
      `INSERT INTO users (username, password_hash, name, email, role, sector, status, access_level)
       VALUES ($1, $2, $3, $4, 'partner', $5, 'active', 'view-only') RETURNING id`,
      [username.trim(), bcrypt.hashSync(password.trim(), 10), name.trim(), email.trim(), operation]
    );
    res.status(201).json(await loadPartner(inserted.rows[0].id));
  } catch (error) {
    if (error?.code === '23505') return res.status(400).json({ message: 'That username is already taken.' });
    throw error;
  }
}));

// Change which business operation a partner may see. This is the whole of their
// access: moving it moves everything they can read, at once, on their next
// request -- there is no cached grant to expire.
router.patch('/:id/operation', asyncRoute(async (req, res) => {
  const { operation } = req.body || {};
  if (!validOperation(operation)) {
    return res.status(400).json({ message: 'Choose one business operation: Farming, Agriculture, Mining, or Movements & Facilitation.' });
  }
  const result = await pool.query(
    "UPDATE users SET sector = $2 WHERE id = $1 AND role = 'partner' RETURNING id",
    [req.params.id, operation]
  );
  if (!result.rowCount) return res.status(404).json({ message: 'External partner not found.' });

  const partner = await loadPartner(req.params.id);
  res.json({ ...partner, message: `${partner.name} now sees ${partner.operationName} only.` });
}));

// Suspend, restore, or revoke. authMiddleware reads the status from the row on
// every request, so a suspension bites on the partner's very next call rather
// than whenever their token happens to expire.
router.patch('/:id/status', asyncRoute(async (req, res) => {
  const { status } = req.body || {};
  if (!PARTNER_STATUSES.includes(status)) {
    return res.status(400).json({ message: 'Status must be active, suspended, or revoked.' });
  }
  const result = await pool.query(
    "UPDATE users SET status = $2 WHERE id = $1 AND role = 'partner' RETURNING id",
    [req.params.id, status]
  );
  if (!result.rowCount) return res.status(404).json({ message: 'External partner not found.' });

  const partner = await loadPartner(req.params.id);
  const wording = {
    active: 'Access restored.',
    suspended: 'Access suspended. They cannot sign in or read anything until it is restored.',
    revoked: 'Access revoked.'
  };
  res.json({ ...partner, message: `${partner.name}: ${wording[status]}` });
}));

router.patch('/:id/password', asyncRoute(async (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== 'string' || password.trim().length < MINIMUM_PASSWORD_LENGTH) {
    return res.status(400).json({ message: `The new password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.` });
  }
  // Stamped from the Node clock for the same reason as the account register:
  // this value is compared against a JWT `iat` minted by this process.
  const result = await pool.query(
    "UPDATE users SET password_hash = $2, password_changed_at = $3 WHERE id = $1 AND role = 'partner' RETURNING id",
    [req.params.id, bcrypt.hashSync(password.trim(), 10), new Date()]
  );
  if (!result.rowCount) return res.status(404).json({ message: 'External partner not found.' });

  const partner = await loadPartner(req.params.id);
  res.json({ ...partner, message: 'Password updated. That partner must sign in again.' });
}));

// Removing the account entirely. Revoking is usually the right move -- it keeps
// the record of who had access -- so this is the deliberate, separate action.
router.delete('/:id', asyncRoute(async (req, res) => {
  const result = await pool.query(
    "DELETE FROM users WHERE id = $1 AND role = 'partner' RETURNING name",
    [req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ message: 'External partner not found.' });
  res.json({ message: `${result.rows[0].name} removed. Their access is gone.` });
}));

export default router;
