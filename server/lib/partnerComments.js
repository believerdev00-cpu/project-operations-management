// Partner comments: the reading every side shares.
//
// Two kinds of thread live in partner_comments:
//
//   * A MESSAGE TO THE DIRECTOR (project_id NULL) -- the original kind: a
//     partner writes about an operation, an activity or a trip, and only the
//     Director reads and answers it. A partner sees only the ones they opened.
//   * A PROJECT DISCUSSION (project_id set) -- about a project the Director
//     shared with the partner, or one of its monthly plans or activities. It
//     belongs to the project: the partner who opened it and colleagues from
//     the same organisation read it and may reply (partnerSeesThreadSql), and
//     so do the internal people responsible for the project
//     (server/routes/projectDiscussions.js). It stays open until somebody
//     internal marks it answered.
//
// The two are kept apart by every reader below, so a message written to the
// Director privately never appears in a project's discussion, and a project's
// discussion is never readable through the old one-partner inbox once the
// project stops being shared.

import { pool } from '../db/database.js';

export const COMMENT_SUBJECTS = ['operation', 'activity', 'movement'];
// What a project discussion may be about.
export const PROJECT_SUBJECTS = ['project', 'plan', 'activity'];
export const MAX_COMMENT_LENGTH = 2000;
// A partner writes to people, not to a queue that can be flooded.
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
//
//   partnerId     one partner's own threads (their messages to the Director)
//   projectIds    the discussions of these projects
//   discussions   'none' (default: messages to the Director only), 'only'
//                 (project discussions only)
//   viewer        a partner reading a project's discussion: { id, organization }
//                 -- see partnerSeesThreadSql
export async function loadThreads({ partnerId = null, threadId = null, projectIds = null, discussions = 'none', status = null, viewer = null, limit = 100 } = {}) {
  const values = [];
  const filters = ['t.parent_id IS NULL'];
  filters.push(discussions === 'only' ? 't.project_id IS NOT NULL' : 't.project_id IS NULL');
  if (partnerId !== null) {
    values.push(partnerId);
    filters.push(`t.partner_id = $${values.length}`);
  }
  if (threadId !== null) {
    values.push(threadId);
    filters.push(`t.id = $${values.length}`);
  }
  if (projectIds !== null) {
    values.push(projectIds);
    filters.push(`t.project_id = ANY($${values.length}::varchar[])`);
  }
  if (viewer) filters.push(partnerSeesThreadSql(values, viewer, 't', 'u'));
  if (status === 'open') filters.push('t.resolved_at IS NULL');
  if (status === 'resolved') filters.push('t.resolved_at IS NOT NULL');
  values.push(limit);
  const threads = await pool.query(
    `SELECT t.*, u.name AS partner_name, pj.name AS project_name,
            COALESCE(a.activity, m.purpose, to_char(pl.month, 'YYYY-MM')) AS subject_title,
            COALESCE((SELECT MAX(r.created_at) FROM partner_comments r WHERE r.parent_id = t.id), t.created_at) AS last_at
     FROM partner_comments t
     JOIN users u ON u.id = t.partner_id
     LEFT JOIN projects pj ON pj.id = t.project_id
     LEFT JOIN activities a ON t.subject_type = 'activity' AND a.id = t.subject_id
     LEFT JOIN movements m ON t.subject_type = 'movement' AND m.id = t.subject_id
     LEFT JOIN monthly_plans pl ON t.subject_type = 'plan' AND pl.id::text = t.subject_id
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
    const last = thread[thread.length - 1];
    return {
      id: row.id,
      partnerName: row.partner_name,
      operation: row.sector,
      projectId: row.project_id || null,
      projectName: row.project_name || null,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      subjectTitle: row.subject_title || null,
      createdAt: row.created_at,
      lastAt: row.last_at,
      messages: thread.map(mapMessage),
      resolvedAt: row.resolved_at || null,
      resolvedByName: row.resolved_by_name || '',
      // A question is waiting while it is open and a partner spoke last.
      needsReply: !row.resolved_at && last.author_role === 'partner',
      // Counted from the reader's side: the Director has unread partner
      // messages, the partner has unread Director replies.
      unreadByDirector: thread.filter((item) => item.author_role === 'partner' && !item.read_by_director_at).length,
      unreadByPartner: thread.filter((item) => item.author_role === 'super-admin' && !item.read_by_partner_at).length
    };
  });
}

// WHICH OF A PROJECT'S CONVERSATIONS A PARTNER READS.
//
// A project may be shared with partners from different organisations -- a
// buyer and a lender, say -- who must not read each other's questions. So a
// partner reads the conversations they opened, and those opened by a partner
// of THEIR OWN organisation (users.organization, compared without case or
// surrounding spaces), with every answer given inside them. A partner whose
// organisation is blank shares with nobody: an unset field is not an
// organisation. Used by the read and by the reply route, so a conversation a
// partner cannot read is one they cannot write into either.
//
// `thread` and `starter` are the aliases of the thread row and of the users
// row of the partner who opened it.
export function partnerSeesThreadSql(values, viewer, thread = 't', starter = 'u') {
  values.push(viewer.id);
  const me = `$${values.length}`;
  values.push(String(viewer.organization || '').trim().toLowerCase());
  const org = `$${values.length}`;
  return `(${thread}.partner_id = ${me} OR (${org} <> '' AND lower(btrim(${starter}.organization)) = ${org}))`;
}

export async function viewerOf(db, partnerId) {
  const row = await db.query('SELECT id, organization FROM users WHERE id = $1', [partnerId]);
  return { id: partnerId, organization: row.rows[0]?.organization || '' };
}

export async function unreadForDirector() {
  const result = await pool.query(
    "SELECT COUNT(*)::int AS total FROM partner_comments WHERE author_role = 'partner' AND read_by_director_at IS NULL AND project_id IS NULL"
  );
  return result.rows[0].total;
}

// Who is told that a partner wrote on a project: the project's own manager
// when it has one, otherwise every active manager working in the project's
// operation; never the person who wrote. (The Directors are told as well, by
// the caller, with the kind they always had.)
export async function projectManagerIds(db, projectId) {
  const result = await db.query(
    `SELECT u.id FROM users u JOIN projects p ON p.id = $1
      WHERE u.status = 'active' AND u.role = 'manager'
        AND (u.id = p.manager_id
             OR (p.manager_id IS NULL AND (u.sector = p.sector
                 OR EXISTS (SELECT 1 FROM manager_operations mo WHERE mo.manager_id = u.id AND mo.sector = p.sector))))`,
    [projectId]
  );
  return result.rows.map((row) => row.id);
}

// The partners in a conversation: whoever opened it and whoever has written
// in it since, still able to read the project. They are the ones told about
// an answer -- not every partner of the project, who would be told about
// conversations they never joined.
export async function threadPartnerIds(db, threadId) {
  const result = await db.query(
    `SELECT DISTINCT u.id FROM partner_comments c
       JOIN partner_comments t ON t.id = $1
       JOIN users u ON u.id = COALESCE(c.author_id, c.partner_id)
      WHERE (c.id = $1 OR c.parent_id = $1) AND c.author_role = 'partner' AND u.status = 'active'
        AND EXISTS (SELECT 1 FROM partner_projects pp WHERE pp.partner_id = u.id AND pp.project_id = t.project_id)`,
    [threadId]
  );
  return result.rows.map((row) => row.id);
}
