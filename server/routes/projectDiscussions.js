// A project's discussion with its external partners, from the inside.
//
// The partners' side is /api/partner/projects/:id/discussion (partner.js);
// this is the same threads read by the people responsible for the projects:
//
//   * the Director: every project, reads, answers, marks a question answered;
//   * the General Manager: every project, reads only -- answering a partner is
//     not theirs (partner messages are the Director's, CLAUDE.md);
//   * a manager: the projects in their scope -- managerScope and projectScope,
//     exactly the rule that decides which projects' reports they read --
//     reads, answers and marks answered;
//   * a team member: nothing. Partners cannot reach this file at all (the
//     allowlist in auth.js).
//
// Every thread is found by its id AND a project in the reader's scope, so an
// id from a project they do not cover answers 404.

import express from 'express';
import { pool, safeRollback } from '../db/database.js';
import { asyncRoute, isAdmin, isGeneralManager, managerScope, parseId, projectScope } from '../lib/http.js';
import { commentBody, loadThreads, threadPartnerIds } from '../lib/partnerComments.js';
import { notifyMany } from '../lib/notifications.js';

const router = express.Router();

const reads = (user) => isAdmin(user) || isGeneralManager(user) || user.role === 'manager';
const answers = (user) => isAdmin(user) || user.role === 'manager';

router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ message: 'Authentication required.' });
  if (!reads(req.user)) return res.status(403).json({ message: 'Partner discussions are read by the people responsible for the project.' });
  next();
});

// The projects whose discussion this person reads.
async function projectsInScope(user) {
  const values = [];
  const filters = [];
  managerScope(user, 'p.sector', values, filters);
  projectScope(user, 'p.id', values, filters);
  const result = await pool.query(
    `SELECT p.id, p.name FROM projects p ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''} ORDER BY p.name`,
    values
  );
  return result.rows;
}

async function threadInScope(user, id) {
  const threadId = parseId(id);
  if (!threadId) return null;
  const thread = await pool.query('SELECT * FROM partner_comments WHERE id = $1 AND parent_id IS NULL AND project_id IS NOT NULL', [threadId]);
  if (!thread.rowCount) return null;
  const allowed = (await projectsInScope(user)).map((project) => project.id);
  return allowed.includes(thread.rows[0].project_id) ? thread.rows[0] : null;
}

router.get('/', asyncRoute(async (req, res) => {
  const projects = await projectsInScope(req.user);
  const ids = projects.map((project) => project.id);
  const wanted = typeof req.query.project === 'string' && req.query.project ? req.query.project : null;
  if (wanted && !ids.includes(wanted)) return res.status(404).json({ message: 'Project not found.' });
  const status = ['open', 'resolved'].includes(req.query.status) ? req.query.status : null;
  const threads = ids.length
    ? await loadThreads({ projectIds: wanted ? [wanted] : ids, discussions: 'only', status, limit: 200 })
    : [];
  res.json({
    canAnswer: answers(req.user),
    waiting: threads.filter((thread) => thread.needsReply).length,
    threads
  });
}));

router.post('/:id/replies', asyncRoute(async (req, res) => {
  if (!answers(req.user)) return res.status(403).json({ message: 'The Director and the project’s manager answer partners.' });
  const thread = await threadInScope(req.user, req.params.id);
  if (!thread) return res.status(404).json({ message: 'Comment not found.' });
  const text = commentBody(req.body?.body);
  if (text.error) return res.status(400).json({ message: text.error });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO partner_comments (partner_id, sector, project_id, subject_type, subject_id, parent_id, author_id, author_name, author_role, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [thread.partner_id, thread.sector, thread.project_id, thread.subject_type, thread.subject_id, thread.id,
        req.user.id, req.user.name, isAdmin(req.user) ? 'super-admin' : 'manager', text.body]
    );
    // An answer is read by the partners in the conversation, and tells them.
    await notifyMany(client, await threadPartnerIds(client, thread.id), {
      kind: 'partner_reply', params: { reason: text.body.slice(0, 140) }, link: '#/projects', actor: req.user
    });
    await client.query('COMMIT');
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }
  const [updated] = await loadThreads({ threadId: thread.id, discussions: 'only' });
  res.status(201).json(updated);
}));

// "Answered" is a judgement, so it is somebody's: who and when are kept on
// the thread. A partner writing again opens it again (partner.js).
router.post('/:id/resolve', asyncRoute(async (req, res) => {
  if (!answers(req.user)) return res.status(403).json({ message: 'The Director and the project’s manager answer partners.' });
  const thread = await threadInScope(req.user, req.params.id);
  if (!thread) return res.status(404).json({ message: 'Comment not found.' });
  const resolved = req.body?.resolved !== false;
  await pool.query(
    resolved
      ? 'UPDATE partner_comments SET resolved_at = NOW(), resolved_by = $2, resolved_by_name = $3 WHERE id = $1'
      : "UPDATE partner_comments SET resolved_at = NULL, resolved_by = NULL, resolved_by_name = '' WHERE id = $1",
    resolved ? [thread.id, req.user.id, req.user.name] : [thread.id]
  );
  const [updated] = await loadThreads({ threadId: thread.id, discussions: 'only' });
  res.json(updated);
}));

router.use((error, req, res, next) => next(error));

export default router;
