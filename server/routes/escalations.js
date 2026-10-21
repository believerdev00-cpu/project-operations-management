// Issues that travel up the reporting line.
//
//   GET  /api/escalations                 ?box=waiting|raised|all  &state=open|settled
//   GET  /api/escalations/:id             one issue and its whole trail
//   POST /api/escalations                 raise an issue (or ask for a decision)
//   POST /api/escalations/:id/escalate    pass it to the next desk up
//   POST /api/escalations/:id/resolve     settle it (an approval, when one was asked for)
//   POST /api/escalations/:id/reject      refuse it -- with a reason, which goes back to the raiser
//   POST /api/escalations/:id/comments    add to the conversation
//
// A team member raises to their project manager, a project manager to the
// General Manager, the General Manager to the Director (nextDeskFor in
// server/lib/organization.js has the exact order). Whoever holds an issue may
// settle it or pass it up; nobody may settle an issue they raised themselves,
// so it always takes a second person. Nothing is ever deleted: an issue is
// open until settled, and every step is a row in escalation_events.
//
// WHAT THIS IS NOT. It is not a second approval system for activities and
// trips -- those are still approved through approval_required_from. An issue
// may point at an activity, a project or a team so the reader has the context,
// but settling it changes nothing on that record by itself.

import express from 'express';
import { pool, safeRollback } from '../db/database.js';
import { asyncRoute, isAdmin, managerScope, parseId, projectScope, requiredText } from '../lib/http.js';
import {
  ESCALATION_KINDS, ESCALATION_PRIORITIES
} from '../db/organizationSchema.js';
import {
  escalationVisibilitySql, escalationsHeldBySql, holdsEscalation, nextDeskFor, personRow
} from '../lib/organization.js';
import { notify, notifyDirectors } from '../lib/notifications.js';
import { MIN_CORRECTION_NOTE } from './activities.js';

const router = express.Router();

class EscalationError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ message: 'Authentication required.' });
  next();
});

router.param('id', (req, res, next, value) => {
  if (!parseId(value)) return res.status(404).json({ message: 'Issue not found.' });
  next();
});

const NOTE_LIMIT = 4000;
// A refusal is a reason the raiser has to be able to act on, so it has the
// same floor as sending work back for correction.
const MIN_REASON = MIN_CORRECTION_NOTE;

function note(value) {
  return typeof value === 'string' ? value.trim().slice(0, NOTE_LIMIT) : '';
}

const SELECT_ESCALATION = `
  SELECT e.*, holder.name AS holder_name, settler.name AS settled_by_name,
         p.name AS project_name, a.activity AS activity_name, t.name AS team_name
    FROM escalations e
    LEFT JOIN users holder ON holder.id = e.holder_id
    LEFT JOIN users settler ON settler.id = e.settled_by
    LEFT JOIN projects p ON p.id = e.project_id
    LEFT JOIN activities a ON a.id = e.activity_id
    LEFT JOIN teams t ON t.id = e.team_id`;

function mapEscalation(row, user) {
  const holds = holdsEscalation(user, row);
  const raisedIt = row.raised_by !== null && Number(row.raised_by) === Number(user.id);
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body || '',
    priority: row.priority,
    sector: row.sector,
    projectId: row.project_id,
    projectName: row.project_name || null,
    activityId: row.activity_id,
    activityName: row.activity_name || null,
    teamId: row.team_id,
    teamName: row.team_name || null,
    raisedById: row.raised_by,
    raisedByName: row.raised_by_name || '',
    holderId: row.holder_id,
    holderName: row.holder_role === 'director' ? null : (row.holder_name || null),
    holderRole: row.holder_role,
    status: row.status,
    resolution: row.resolution || '',
    settledByName: row.settled_by_name || null,
    settledAt: row.settled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // What the reader may do, by the same rules the routes below enforce.
    can: {
      settle: holds && !raisedIt,
      escalate: holds && row.holder_role !== 'director',
      comment: row.status === 'open' && (holds || raisedIt)
    }
  };
}

async function readEscalation(db, id, user, { lock = false } = {}) {
  const values = [id];
  const visible = escalationVisibilitySql(user, values, 'e');
  const result = await db.query(
    `${SELECT_ESCALATION} WHERE e.id = $1 AND ${visible}${lock ? ' FOR UPDATE OF e' : ''}`,
    values
  );
  if (!result.rowCount) throw new EscalationError(404, 'Issue not found.');
  return result.rows[0];
}

async function addEvent(db, escalationId, actor, action, { fromHolderId = null, to = null, text = '' } = {}) {
  await db.query(
    `INSERT INTO escalation_events (escalation_id, action, actor_id, actor_name, from_holder_id, to_holder_id, to_holder_name, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [escalationId, action, actor.id, actor.name || '', fromHolderId, to?.id ?? null,
      to ? (to.role === 'director' ? '' : to.name || '') : '', text]
  );
}

// Tells whoever now holds the issue. The Director's office is every active
// Director; anybody else is the one named person.
async function tellHolder(db, desk, event) {
  if (desk.role === 'director') return notifyDirectors(db, event);
  return notify(db, { ...event, userId: desk.id });
}

// ---- reading ---------------------------------------------------------------

router.get('/', asyncRoute(async (req, res) => {
  const box = ['waiting', 'raised', 'all'].includes(req.query.box) ? req.query.box : 'waiting';
  const values = [];
  const filters = [escalationVisibilitySql(req.user, values, 'e')];
  if (box === 'waiting') filters.push(escalationsHeldBySql(req.user, values, 'e'));
  if (box === 'raised') {
    values.push(req.user.id);
    filters.push(`e.raised_by = $${values.length}`);
  }
  if (req.query.state === 'open') filters.push("e.status = 'open'");
  if (req.query.state === 'settled') filters.push("e.status <> 'open'");
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
  values.push(limit);
  const result = await pool.query(
    `${SELECT_ESCALATION} WHERE ${filters.join(' AND ')}
      ORDER BY e.status = 'open' DESC,
               CASE e.priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END,
               e.updated_at DESC
      LIMIT $${values.length}`,
    values
  );
  res.json(result.rows.map((row) => mapEscalation(row, req.user)));
}));

router.get('/:id', asyncRoute(async (req, res) => {
  const row = await readEscalation(pool, req.params.id, req.user);
  const events = await pool.query(
    'SELECT * FROM escalation_events WHERE escalation_id = $1 ORDER BY created_at, id',
    [row.id]
  );
  res.json({
    ...mapEscalation(row, req.user),
    events: events.rows.map((event) => ({
      id: event.id,
      action: event.action,
      actorName: event.actor_name,
      toHolderName: event.to_holder_name || null,
      toDirector: event.to_holder_id !== null && event.to_holder_name === '',
      note: event.note || '',
      createdAt: event.created_at
    }))
  });
}));

// ---- raising -----------------------------------------------------------------

// The record an issue points at must be one the raiser can already read, so
// raising an issue is never a way to learn that a record exists.
async function resolveContext(user, payload) {
  let projectId = null;
  let activityId = null;
  let teamId = null;
  let sector = null;

  if (payload.activityId) {
    const values = [String(payload.activityId)];
    const filters = [];
    managerScope(user, 'a.sector', values, filters);
    projectScope(user, 'a.project_id', values, filters, { assignedColumn: 'a.assigned_to' });
    values.push(user.id);
    const mine = `a.assigned_to = $${values.length}`;
    const scope = filters.length ? ` AND (${filters.join(' AND ')} OR ${mine})` : '';
    const found = await pool.query(`SELECT a.id, a.project_id, a.sector FROM activities a WHERE a.id = $1${scope}`, values);
    if (!found.rowCount) throw new EscalationError(404, 'Activity not found.');
    activityId = found.rows[0].id;
    projectId = found.rows[0].project_id;
    sector = found.rows[0].sector;
  }
  if (payload.teamId) {
    const id = parseId(payload.teamId);
    const found = id ? await pool.query(
      `SELECT t.id, t.project_id, p.sector, p.manager_id, t.supervisor_id,
              EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = t.id AND tm.user_id = $2) AS is_member
         FROM teams t JOIN projects p ON p.id = t.project_id WHERE t.id = $1`,
      [id, user.id]
    ) : { rowCount: 0, rows: [] };
    const team = found.rows[0];
    const related = team && (isAdmin(user) || user.role === 'general-manager' || team.is_member
      || Number(team.manager_id) === Number(user.id) || Number(team.supervisor_id) === Number(user.id));
    if (!related) throw new EscalationError(404, 'Team not found.');
    if (projectId && team.project_id !== projectId) {
      throw new EscalationError(400, 'That team works on a different project from the activity.');
    }
    teamId = team.id;
    projectId = projectId || team.project_id;
    sector = sector || team.sector;
  }
  if (payload.projectId && !projectId) {
    const values = [String(payload.projectId)];
    const filters = [];
    managerScope(user, 'p.sector', values, filters);
    projectScope(user, 'p.id', values, filters);
    const found = await pool.query(
      `SELECT p.id, p.sector FROM projects p WHERE p.id = $1${filters.length ? ` AND ${filters.join(' AND ')}` : ''}`,
      values
    );
    if (!found.rowCount) throw new EscalationError(404, 'Project not found.');
    projectId = found.rows[0].id;
    sector = found.rows[0].sector;
  } else if (payload.projectId && payload.projectId !== projectId) {
    throw new EscalationError(400, 'The project does not match the activity or team.');
  }
  return { projectId, activityId, teamId, sector };
}

router.post('/', asyncRoute(async (req, res) => {
  const payload = req.body || {};
  if (isAdmin(req.user)) {
    // The Director's office is the top of the line: there is nobody to raise to.
    return res.status(403).json({ message: 'The Director settles issues; there is nobody above to raise one to.' });
  }
  if (!requiredText(payload.title)) return res.status(400).json({ message: 'Say in a few words what the issue is.' });
  const kind = payload.kind === undefined ? 'issue' : payload.kind;
  if (!ESCALATION_KINDS.includes(kind)) return res.status(400).json({ message: 'Choose whether this is an issue or a decision request.' });
  const priority = payload.priority === undefined ? 'Medium' : payload.priority;
  if (!ESCALATION_PRIORITIES.includes(priority)) return res.status(400).json({ message: 'Priority is Low, Medium or High.' });

  const context = await resolveContext(req.user, payload);
  const raiser = await personRow(pool, req.user.id);
  const desk = await nextDeskFor(pool, raiser, context.projectId);
  if (!desk || (desk.role === 'director' && !desk.id)) {
    return res.status(409).json({ message: 'There is nobody above you to raise this to yet. Ask the Director to set your reporting line.' });
  }

  const title = String(payload.title).trim().slice(0, 200);
  const body = note(payload.body);
  const client = await pool.connect();
  let id;
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO escalations (kind, title, body, priority, sector, project_id, activity_id, team_id,
                                raised_by, raised_by_name, holder_id, holder_role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [kind, title, body, priority, context.sector || req.user.sector || null, context.projectId, context.activityId,
        context.teamId, req.user.id, req.user.name, desk.id, desk.role]
    );
    id = inserted.rows[0].id;
    await addEvent(client, id, req.user, 'raised', { to: desk, text: body });
    await tellHolder(client, desk, {
      kind: 'escalation_raised',
      params: { name: req.user.name, title },
      link: `#/escalations/${id}`,
      actor: req.user
    });
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }
  const row = await readEscalation(pool, id, req.user);
  res.status(201).json(mapEscalation(row, req.user));
}));

// ---- moving it on ------------------------------------------------------------

router.post('/:id/escalate', asyncRoute(async (req, res) => {
  const text = note(req.body?.note);
  const client = await pool.connect();
  let desk;
  try {
    await client.query('BEGIN');
    const row = await readEscalation(client, req.params.id, req.user, { lock: true });
    if (!holdsEscalation(req.user, row)) throw new EscalationError(403, 'Only the person holding this issue can pass it on.');
    if (row.holder_role === 'director') throw new EscalationError(409, 'This issue is with the Director, the top of the line.');
    const holder = await personRow(client, req.user.id);
    desk = await nextDeskFor(client, holder, row.project_id);
    if (!desk || (desk.role === 'director' && !desk.id)) throw new EscalationError(409, 'There is nobody above you to pass this to.');
    const moved = await client.query(
      `UPDATE escalations SET holder_id = $2, holder_role = $3, updated_at = NOW()
        WHERE id = $1 AND status = 'open' AND holder_id = $4`,
      [row.id, desk.id, desk.role, row.holder_id]
    );
    if (!moved.rowCount) throw new EscalationError(409, 'This issue has just been moved by somebody else. Reload it.');
    await addEvent(client, row.id, req.user, 'escalated', { fromHolderId: row.holder_id, to: desk, text });
    await tellHolder(client, desk, {
      kind: 'escalation_escalated',
      params: { name: req.user.name, title: row.title },
      link: `#/escalations/${row.id}`,
      actor: req.user
    });
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }
  const row = await readEscalation(pool, req.params.id, req.user).catch(() => null);
  res.json(row ? mapEscalation(row, req.user) : { id: Number(req.params.id), moved: true });
}));

// Resolve and reject share everything but the outcome and the reason rule.
function settle(outcome) {
  return asyncRoute(async (req, res) => {
    const text = note(req.body?.note);
    if (outcome === 'rejected' && text.length < MIN_REASON) {
      return res.status(400).json({
        message: `Say why this is refused, in at least ${MIN_REASON} characters, so the person who raised it knows what to do.`,
        code: 'REASON_REQUIRED'
      });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = await readEscalation(client, req.params.id, req.user, { lock: true });
      if (!holdsEscalation(req.user, row)) throw new EscalationError(403, 'Only the person holding this issue can settle it.');
      // Separation of duties: the person who raised an issue never settles it.
      if (row.raised_by !== null && Number(row.raised_by) === Number(req.user.id)) {
        throw new EscalationError(403, 'You cannot settle an issue you raised yourself.', 'OWN_ESCALATION');
      }
      const settled = await client.query(
        `UPDATE escalations SET status = $2, resolution = $3, settled_by = $4, settled_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status = 'open'`,
        [row.id, outcome, text, req.user.id]
      );
      if (!settled.rowCount) throw new EscalationError(409, 'This issue has already been settled.');
      await addEvent(client, row.id, req.user, outcome, { fromHolderId: row.holder_id, text });
      if (row.raised_by && Number(row.raised_by) !== Number(req.user.id)) {
        await notify(client, {
          userId: row.raised_by,
          kind: outcome === 'resolved' ? 'escalation_resolved' : 'escalation_rejected',
          params: { name: req.user.name, title: row.title, reason: text },
          link: `#/escalations/${row.id}`,
          actor: req.user
        });
      }
      await client.query('COMMIT');
    } catch (error) {
      await safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
    const row = await readEscalation(pool, req.params.id, req.user);
    res.json(mapEscalation(row, req.user));
  });
}

router.post('/:id/resolve', settle('resolved'));
router.post('/:id/reject', settle('rejected'));

router.post('/:id/comments', asyncRoute(async (req, res) => {
  const text = note(req.body?.note);
  if (!text) return res.status(400).json({ message: 'Write something first.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await readEscalation(client, req.params.id, req.user, { lock: true });
    const raisedIt = row.raised_by !== null && Number(row.raised_by) === Number(req.user.id);
    if (row.status !== 'open') throw new EscalationError(409, 'This issue is settled.');
    if (!holdsEscalation(req.user, row) && !raisedIt) {
      throw new EscalationError(403, 'Only the person who raised this issue and the person holding it can write on it.');
    }
    await addEvent(client, row.id, req.user, 'commented', { text });
    await client.query('UPDATE escalations SET updated_at = NOW() WHERE id = $1', [row.id]);
    const event = {
      kind: 'escalation_comment',
      params: { name: req.user.name, title: row.title, reason: text.slice(0, 200) },
      link: `#/escalations/${row.id}`,
      actor: req.user
    };
    if (raisedIt) {
      await tellHolder(client, { id: row.holder_id, role: row.holder_role }, event);
    } else if (row.raised_by) {
      await notify(client, { ...event, userId: row.raised_by });
    }
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }
  res.status(201).json({ id: Number(req.params.id), commented: true });
}));

router.use((error, req, res, next) => {
  if (error instanceof EscalationError) {
    return res.status(error.status).json({ message: error.message, ...(error.code ? { code: error.code } : {}) });
  }
  next(error);
});

export default router;
