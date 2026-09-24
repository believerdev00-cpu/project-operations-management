// The Director's inbox of comments from external partners.
//
// Director only, checked with isAdmin rather than hasFullScope: a manager
// covering every operation sees every operation's records, but a partner's
// comment is addressed to the Director and is not a record of any operation.
// A partner cannot reach this file at all -- /api/partner-comments is outside
// the partner allowlist in authMiddleware (/api/partner/ needs the slash).

import express from 'express';
import { pool } from '../db/database.js';
import { asyncRoute, isAdmin, parseId } from '../lib/http.js';
import { commentBody, loadThreads, unreadForDirector } from '../lib/partnerComments.js';

const router = express.Router();

router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ message: 'Authentication required.' });
  if (!isAdmin(req.user)) {
    return res.status(403).json({ message: 'Comments from external partners are addressed to the Director.' });
  }
  next();
});

router.get('/', asyncRoute(async (req, res) => {
  const [threads, unread] = await Promise.all([loadThreads({ limit: 200 }), unreadForDirector()]);
  res.json({ unread, threads });
}));

async function markRead(threadId) {
  await pool.query(
    `UPDATE partner_comments SET read_by_director_at = NOW()
     WHERE (id = $1 OR parent_id = $1) AND author_role = 'partner' AND read_by_director_at IS NULL`,
    [threadId]
  );
}

// Reading a thread marks the partner's messages in it as read.
router.patch('/:id/read', asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).json({ message: 'Comment not found.' });
  await markRead(id);
  res.json({ unread: await unreadForDirector() });
}));

// The Director's answer goes to the one partner whose thread it is and to
// nobody else: replies are read only through that partner's own threads.
router.post('/:id/replies', asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const thread = id
    ? await pool.query('SELECT id FROM partner_comments WHERE id = $1 AND parent_id IS NULL', [id])
    : { rowCount: 0 };
  if (!thread.rowCount) return res.status(404).json({ message: 'Comment not found.' });
  const text = commentBody(req.body?.body);
  if (text.error) return res.status(400).json({ message: text.error });

  await pool.query(
    `INSERT INTO partner_comments (partner_id, sector, subject_type, subject_id, parent_id, author_id, author_name, author_role, body)
     SELECT partner_id, sector, subject_type, subject_id, id, $2, $3, 'super-admin', $4 FROM partner_comments WHERE id = $1`,
    [id, req.user.id, req.user.name, text.body]
  );
  // Answering a thread is reading it.
  await markRead(id);
  const [updated] = await loadThreads({ threadId: id });
  res.status(201).json({ thread: updated, unread: await unreadForDirector() });
}));

// Handed on to the application's error handler.
router.use((error, req, res, next) => next(error));

export default router;
