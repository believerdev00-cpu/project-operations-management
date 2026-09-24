// Partner comments to the Director: the reading both sides share.
//
// A partner sees only the threads they opened (partner_id = them). The
// Director sees every thread. Nobody else reaches the table at all -- the
// partner routes and the Director's router are the only two doors, and a
// manager has neither, whatever operations they cover.

import { pool } from '../db/database.js';

export const COMMENT_SUBJECTS = ['operation', 'activity', 'movement'];
export const MAX_COMMENT_LENGTH = 2000;
// A partner writes to the Director, not to a queue that can be flooded.
export const PARTNER_COMMENTS_PER_HOUR = 20;

export function commentBody(value) {
  const body = typeof value === 'string' ? value.trim() : '';
  if (!body) return { error: 'Write your comment before sending it.' };
  if (body.length > MAX_COMMENT_LENGTH) return { error: `A comment can be at most ${MAX_COMMENT_LENGTH} characters.` };
  return { body };
}

// Deliberately narrow: who wrote it as the account names them, in which role,
// what they said and when. No ids of internal people, no notes.
function mapMessage(row) {
  return {
    id: row.id,
    authorName: row.author_name,
    authorRole: row.author_role,
    body: row.body,
    createdAt: row.created_at
  };
}

// Threads with their replies, oldest reply first, newest conversation first.
// `partnerId` limits it to one partner's own threads -- the only reading a
// partner ever gets.
export async function loadThreads({ partnerId = null, threadId = null, limit = 100 } = {}) {
  const values = [];
  const filters = ['t.parent_id IS NULL'];
  if (partnerId !== null) {
    values.push(partnerId);
    filters.push(`t.partner_id = $${values.length}`);
  }
  if (threadId !== null) {
    values.push(threadId);
    filters.push(`t.id = $${values.length}`);
  }
  values.push(limit);
  const threads = await pool.query(
    `SELECT t.*, u.name AS partner_name,
            COALESCE(a.activity, m.purpose) AS subject_title,
            COALESCE((SELECT MAX(r.created_at) FROM partner_comments r WHERE r.parent_id = t.id), t.created_at) AS last_at
     FROM partner_comments t
     JOIN users u ON u.id = t.partner_id
     LEFT JOIN activities a ON t.subject_type = 'activity' AND a.id = t.subject_id
     LEFT JOIN movements m ON t.subject_type = 'movement' AND m.id = t.subject_id
     WHERE ${filters.join(' AND ')}
     ORDER BY last_at DESC, t.id DESC
     LIMIT $${values.length}`,
    values
  );
  if (!threads.rowCount) return [];

  const replies = await pool.query(
    'SELECT * FROM partner_comments WHERE parent_id = ANY($1::int[]) ORDER BY created_at, id',
    [threads.rows.map((row) => row.id)]
  );
  const byThread = new Map();
  for (const reply of replies.rows) {
    if (!byThread.has(reply.parent_id)) byThread.set(reply.parent_id, []);
    byThread.get(reply.parent_id).push(reply);
  }

  return threads.rows.map((row) => {
    const thread = [row, ...(byThread.get(row.id) || [])];
    return {
      id: row.id,
      partnerName: row.partner_name,
      operation: row.sector,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      subjectTitle: row.subject_title || null,
      createdAt: row.created_at,
      lastAt: row.last_at,
      messages: thread.map(mapMessage),
      // Counted from the reader's side: the Director has unread partner
      // messages, the partner has unread Director replies.
      unreadByDirector: thread.filter((item) => item.author_role === 'partner' && !item.read_by_director_at).length,
      unreadByPartner: thread.filter((item) => item.author_role === 'super-admin' && !item.read_by_partner_at).length
    };
  });
}

export async function unreadForDirector() {
  const result = await pool.query(
    "SELECT COUNT(*)::int AS total FROM partner_comments WHERE author_role = 'partner' AND read_by_director_at IS NULL"
  );
  return result.rows[0].total;
}
