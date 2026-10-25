// The Director's control over external business partner access.
//
// Invite a partner, grant them one or more business operations, change the
// grants, suspend or revoke their access. Partners are ordinary rows in `users` with role
// 'partner', so they authenticate, have their password reset and appear in the
// register through the paths that already exist -- this router is only the
// management surface the Director works from.
//
// Every route here is Director-only. A partner cannot reach this file at all:
// authMiddleware refuses them anything outside /api/partner before a handler
// runs.

import express from 'express';
import { pool, safeRollback } from '../db/database.js';
import { asyncRoute, isAdmin, parseId, requiredText, sectorIds } from '../lib/http.js';
import { hashPassword, passwordProblem } from '../lib/passwords.js';
import { TRIPS_OPERATION, operationById } from '../../shared/businessOperations.js';
import { partnerProjectSql, recordOrganization } from '../lib/organization.js';
import { notify } from '../lib/notifications.js';

const router = express.Router();

export const PARTNER_STATUSES = ['active', 'suspended', 'revoked'];

router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ message: 'Authentication required.' });
  if (!isAdmin(req.user)) {
    return res.status(403).json({ message: 'Only the Director can manage external partner access.' });
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
  const operations = row.operations?.length ? row.operations : [row.sector];
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    email: row.email || '',
    // The organisation the partner speaks for, and the member of staff who
    // looks after the relationship.
    organization: row.organization || '',
    contactId: row.partner_contact_id ?? null,
    contactName: row.contact_name || null,
    // Projects shared one by one. Empty means every operation they hold is
    // shared whole, exactly as before project sharing existed.
    projects: row.projects || [],
    // The partner's first operation, for the callers that read one, and
    // `operations`: everything they may follow. Named as well as keyed, so the
    // register never shows a bare id.
    operation: row.sector,
    operationName: operation?.name || row.sector,
    operations,
    operationNames: operations.map((id) => operationById(id)?.name || id),
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

// The grants, with the account's own operation standing in when there are
// none -- the same reading authMiddleware makes, so the register and the
// partner agree on what the partner can see.
const PARTNER_GRANTS = `COALESCE((SELECT array_agg(po.sector::text ORDER BY po.sector)
                                  FROM partner_operations po WHERE po.partner_id = u.id), ARRAY[u.sector::text])`;

// The counts mirror activityVisibility/movementVisibility in partner.js. The
// trips register belongs to TRIPS_OPERATION (see shared/businessOperations.js);
// this used to compare against the literal 'movement', so a Farming partner's
// count left out the unlinked trips they can in fact read.
const PARTNER_SELECT = `
  SELECT u.id, u.username, u.name, u.email, u.sector, u.status, u.access_level,
         u.created_at, u.password_changed_at, u.organization, u.partner_contact_id,
         (SELECT c.name FROM users c WHERE c.id = u.partner_contact_id) AS contact_name,
         ${PARTNER_GRANTS} AS operations,
         COALESCE((SELECT json_agg(json_build_object('id', p.id, 'name', p.name, 'sector', p.sector) ORDER BY p.name)
                     FROM partner_projects pp JOIN projects p ON p.id = pp.project_id WHERE pp.partner_id = u.id), '[]'::json) AS projects,
         (SELECT COUNT(*) FROM activities a
           WHERE a.sector = ANY(${PARTNER_GRANTS}) AND ${partnerProjectSql('u.id', 'a.sector', 'a.project_id')}
             AND a.approval_status = 'approved'
             AND a.externally_visible = TRUE
             AND a.status NOT IN ('Draft', 'Cancelled', 'Rejected'))::int AS visible_activities,
         (SELECT COUNT(*) FROM movements m
           WHERE (m.related_area = ANY(${PARTNER_GRANTS})
                  OR (m.related_area IS NULL AND '${TRIPS_OPERATION}' = ANY(${PARTNER_GRANTS})))
             AND ${partnerProjectSql('u.id', `COALESCE(m.related_area, '${TRIPS_OPERATION}')`, 'm.project_id')}
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

// The set of operations a request asks for: `operations` as a list, or the
// older single `operation`. Duplicates are dropped; an unknown id or an empty
// set makes the whole request invalid rather than quietly granting less.
function requestedOperations(body) {
  const list = Array.isArray(body?.operations) ? body.operations : (body?.operation ? [body.operation] : []);
  const unique = [...new Set(list)];
  if (!unique.length || !unique.every(validOperation)) return null;
  return unique;
}

const OPERATIONS_MESSAGE = 'Choose at least one business operation: Mining, Agriculture, Farming, or Movement & Facilitation.';

// Replace a partner's grants with exactly this set, in the caller's
// transaction. users.sector becomes the first of them, so the account row
// always names an operation the partner actually holds.
async function setGrants(client, partnerId, operations, grantedBy) {
  await client.query("UPDATE users SET sector = $2 WHERE id = $1 AND role = 'partner'", [partnerId, operations[0]]);
  await client.query('DELETE FROM partner_operations WHERE partner_id = $1 AND NOT (sector = ANY($2::text[]))', [partnerId, operations]);
  await client.query(
    `INSERT INTO partner_operations (partner_id, sector, granted_by)
     SELECT $1, UNNEST($2::text[]), $3
     ON CONFLICT DO NOTHING`,
    [partnerId, operations, grantedBy]
  );
  // A project shared in an operation the partner no longer holds is not
  // shared any more: the operation grant is the outer fence.
  await client.query(
    `DELETE FROM partner_projects pp USING projects p
      WHERE pp.partner_id = $1 AND p.id = pp.project_id AND NOT (p.sector = ANY($2::text[]))`,
    [partnerId, operations]
  );
}

async function replaceGrants(partnerId, operations, grantedBy) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setGrants(client, partnerId, operations, grantedBy);
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }
}

router.get('/', asyncRoute(async (req, res) => {
  const result = await pool.query(`${PARTNER_SELECT} ORDER BY u.name`);
  const partners = result.rows.map(mapPartner);
  res.json({
    total: partners.length,
    // A partner following two operations counts towards both.
    byOperation: partners.reduce((counts, partner) => {
      for (const operation of partner.operations) counts[operation] = (counts[operation] || 0) + 1;
      return counts;
    }, {}),
    active: partners.filter((partner) => partner.status === 'active').length,
    partners
  });
}));

// Invite a partner: an account, the business operations they may follow,
// view-only.
router.post('/', asyncRoute(async (req, res) => {
  const { name, email, username, password } = req.body || {};
  const operations = requestedOperations(req.body);

  if (!requiredText(name)) return res.status(400).json({ message: 'The partner\'s name is required.' });
  if (!requiredText(username)) return res.status(400).json({ message: 'A username is required for the partner to sign in with.' });
  if (!requiredText(email) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    return res.status(400).json({ message: 'A valid email address is required.' });
  }
  const weak = passwordProblem(password, { username });
  if (weak) return res.status(400).json({ message: weak });
  if (!operations) return res.status(400).json({ message: OPERATIONS_MESSAGE });
  // View-only is the only level an external partner is given. Anything else in
  // the request is refused outright rather than quietly downgraded, so a
  // mistaken call is visible instead of silently doing something else.
  const accessLevel = req.body?.accessLevel || 'view-only';
  if (accessLevel !== 'view-only') {
    return res.status(400).json({ message: 'An external partner can only be given View Only access.' });
  }

  const passwordHash = await hashPassword(password);
  const client = await pool.connect();
  let partnerId;
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      // Temporary, like every password the Director sets: the partner chooses
      // their own at first sign-in.
      `INSERT INTO users (username, password_hash, name, email, role, sector, status, access_level, must_change_password)
       VALUES ($1, $2, $3, $4, 'partner', $5, 'active', 'view-only', TRUE) RETURNING id`,
      [username.trim(), passwordHash, name.trim(), email.trim(), operations[0]]
    );
    partnerId = inserted.rows[0].id;
    await setGrants(client, partnerId, operations, req.user.id);
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    if (error?.code === '23505') return res.status(400).json({ message: 'That username is already taken.' });
    throw error;
  } finally {
    client.release();
  }
  // Read back once the connection is in the pool again: on Vercel the pool
  // holds exactly one.
  res.status(201).json(await loadPartner(partnerId));
}));

// Change which business operations a partner may see: the whole set at once.
// It moves everything they can read on their very next request -- the grants
// are read on every call, so there is no cached access to expire.
router.patch('/:id/operations', asyncRoute(async (req, res) => {
  const operations = requestedOperations(req.body);
  if (!operations) return res.status(400).json({ message: OPERATIONS_MESSAGE });
  if (!(await loadPartner(req.params.id))) return res.status(404).json({ message: 'External partner not found.' });

  await replaceGrants(req.params.id, operations, req.user.id);

  const partner = await loadPartner(req.params.id);
  res.json({ ...partner, message: `${partner.name} now sees ${partner.operationNames.join(', ')}.` });
}));

// The older single-operation form: replaces every grant with this one.
router.patch('/:id/operation', asyncRoute(async (req, res) => {
  const { operation } = req.body || {};
  if (!validOperation(operation)) {
    return res.status(400).json({ message: 'Choose one project: Mining, Agriculture, Farming, or Movement & Facilitation.' });
  }
  if (!(await loadPartner(req.params.id))) return res.status(404).json({ message: 'External partner not found.' });
  await replaceGrants(req.params.id, [operation], req.user.id);

  const partner = await loadPartner(req.params.id);
  res.json({ ...partner, message: `${partner.name} now sees ${partner.operationName} only.` });
}));

// The partner as an organisation: who they speak for, and which member of
// staff looks after them. The contact must be an active internal account --
// a partner is never another partner's contact.
router.patch('/:id/profile', asyncRoute(async (req, res) => {
  const payload = req.body || {};
  const partner = await loadPartner(req.params.id);
  if (!partner) return res.status(404).json({ message: 'External partner not found.' });
  const organization = payload.organization === undefined
    ? partner.organization
    : String(payload.organization || '').trim().slice(0, 200);
  let contactId = partner.contactId;
  if (payload.contactId !== undefined) {
    contactId = payload.contactId === null || payload.contactId === '' ? null : parseId(payload.contactId);
    if (payload.contactId !== null && payload.contactId !== '' && !contactId) {
      return res.status(400).json({ message: 'Choose an active member of staff as the contact.' });
    }
    if (contactId) {
      const contact = await pool.query(
        "SELECT id FROM users WHERE id = $1 AND status = 'active' AND role IN ('super-admin', 'general-manager', 'manager')",
        [contactId]
      );
      if (!contact.rowCount) return res.status(400).json({ message: 'Choose an active member of staff as the contact.' });
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "UPDATE users SET organization = $2, partner_contact_id = $3 WHERE id = $1 AND role = 'partner'",
      [partner.id, organization, contactId]
    );
    await recordOrganization(client, req.user, 'partner_profile_changed', {
      subjectUserId: partner.id, subjectName: partner.name, detail: { organization, contactId }
    });
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }
  res.json(await loadPartner(partner.id));
}));

// Share particular projects with a partner: the whole set at once. Each must
// sit in an operation the partner already holds -- sharing a project narrows
// what an operation grant shows, and is never a back door into an operation
// they were not given. An empty list goes back to the whole operations.
router.put('/:id/projects', asyncRoute(async (req, res) => {
  const list = Array.isArray(req.body?.projectIds) ? req.body.projectIds : null;
  if (!list || !list.every((id) => typeof id === 'string' && id)) {
    return res.status(400).json({ message: 'Send the projects to share as a list.' });
  }
  const partner = await loadPartner(req.params.id);
  if (!partner) return res.status(404).json({ message: 'External partner not found.' });
  const wanted = [...new Set(list)];
  const found = wanted.length
    ? await pool.query('SELECT id, name, sector FROM projects WHERE id = ANY($1::text[])', [wanted])
    : { rows: [] };
  if (found.rows.length !== wanted.length) return res.status(400).json({ message: 'One of those projects does not exist.' });
  if (found.rows.some((project) => !partner.operations.includes(project.sector))) {
    return res.status(400).json({ message: 'A project can be shared only if the partner already follows it.' });
  }
  const before = new Set(partner.projects.map((project) => project.id));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM partner_projects WHERE partner_id = $1 AND NOT (project_id = ANY($2::text[]))', [partner.id, wanted]);
    if (wanted.length) {
      await client.query(
        `INSERT INTO partner_projects (partner_id, project_id, granted_by)
         SELECT $1, UNNEST($2::text[]), $3 ON CONFLICT DO NOTHING`,
        [partner.id, wanted, req.user.id]
      );
    }
    await recordOrganization(client, req.user, 'partner_projects_changed', {
      subjectUserId: partner.id, subjectName: partner.name, detail: { projectIds: wanted }
    });
    // The partner is told about each project newly shared with them, under
    // the bell in their own portal. Nothing is said about one taken away.
    for (const project of found.rows.filter((row) => !before.has(row.id))) {
      await notify(client, {
        userId: partner.id, kind: 'partner_shared', params: { project: project.name }, link: '#/overview', actor: req.user
      });
    }
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }
  res.json(await loadPartner(partner.id));
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
  const weak = passwordProblem(password);
  if (weak) return res.status(400).json({ message: weak });
  // Stamped from the Node clock for the same reason as the account register:
  // this value is compared against a JWT `iat` minted by this process.
  const result = await pool.query(
    "UPDATE users SET password_hash = $2, password_changed_at = $3, must_change_password = TRUE WHERE id = $1 AND role = 'partner' RETURNING id",
    [req.params.id, await hashPassword(password), new Date()]
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
