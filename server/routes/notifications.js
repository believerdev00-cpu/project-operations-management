// A person's own notifications, and nothing else.
//
// Every route here reads and writes rows WHERE user_id = the signed-in account.
// There is no "list somebody else's" and no Director override: what the system
// told a manager is theirs, and the Director has their own list. Partners never
// reach this router -- authMiddleware's allowlist stops them before it.

import express from 'express';
import { pool } from '../db/database.js';
import { asyncRoute, parseId } from '../lib/http.js';
import { mapNotification } from '../lib/notifications.js';

const router = express.Router();

router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ message: 'Authentication required.' });
  next();
});

// Newest first, with the unread count beside the list so the bell and the list
// come from one request and cannot disagree.
router.get('/', asyncRoute(async (req, res) => {
  const limit = Math.min(Math.max(parseId(req.query.limit) || 30, 1), 100);
  const [items, unread] = await Promise.all([
    pool.query(
      `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [req.user.id, limit]
    ),
    pool.query('SELECT COUNT(*)::int AS unread FROM notifications WHERE user_id = $1 AND read_at IS NULL', [req.user.id])
  ]);
  res.json({ items: items.rows.map(mapNotification), unread: unread.rows[0].unread });
}));

// Opening one marks it read. Idempotent: a second press changes nothing.
router.patch('/:id/read', asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).json({ message: 'Notification not found.' });
  const updated = await pool.query(
    `UPDATE notifications SET read_at = COALESCE(read_at, NOW())
     WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, req.user.id]
  );
  if (!updated.rowCount) return res.status(404).json({ message: 'Notification not found.' });
  res.json(mapNotification(updated.rows[0]));
}));

router.post('/read-all', asyncRoute(async (req, res) => {
  const updated = await pool.query(
    'UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL',
    [req.user.id]
  );
  res.json({ marked: updated.rowCount });
}));

export default router;
