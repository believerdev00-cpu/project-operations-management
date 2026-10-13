// In-app notifications: the one place a "tell this person" is written.
//
// WHAT THIS IS. A row in `notifications` per person per event, read back by
// GET /api/notifications and shown under the bell in the app. The manager
// learns a month was handed to them, that their report came back and why, and
// that their finished work was accepted; the Director learns a report or a
// piece of work is waiting for them.
//
// WHAT THIS IS NOT. There is no email, SMS or push behind it, and nothing here
// claims there is. A notification is "written" the moment the row lands and
// "read" when the person opens it, and those are the only two states the app
// shows. Adding an outbound channel later means adding it here, once, behind
// `notify` -- the routes only say what happened and to whom.
//
// `notify` takes the transaction client when it is called inside one, so the
// notification commits with the change it describes and never survives a
// rollback on its own. Called with the pool after a commit it works the same.

import { NOTIFICATION_KINDS } from '../db/monthlySchema.js';

// Writes one notification. `params` is whatever the sentence for that kind needs
// in the reader's language (operation id, month key, reason, record title);
// the browser does the wording. Returns the new row's id.
export async function notify(db, {
  userId, kind, params = {}, link = '', planId = null, activityId = null, actor = null
}) {
  if (!userId) return null;
  if (!NOTIFICATION_KINDS.includes(kind)) throw new Error(`Unknown notification kind: ${kind}`);
  const inserted = await db.query(
    `INSERT INTO notifications (user_id, kind, params, link, plan_id, activity_id, actor_id, actor_name)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8) RETURNING id`,
    [
      userId, kind, JSON.stringify(params || {}), link || '',
      planId, activityId, actor?.id ?? null, actor?.name ?? ''
    ]
  );
  return inserted.rows[0].id;
}

// The same event to several people -- the Director's office is every active
// super-admin account, since any of them may answer what is waiting.
export async function notifyMany(db, userIds, event) {
  const unique = [...new Set((userIds || []).filter(Boolean).map(Number))];
  for (const userId of unique) {
    await notify(db, { ...event, userId });
  }
}

export async function activeDirectorIds(db) {
  const result = await db.query(
    "SELECT id FROM users WHERE role = 'super-admin' AND status = 'active' ORDER BY id"
  );
  return result.rows.map((row) => row.id);
}

export async function notifyDirectors(db, event) {
  const ids = await activeDirectorIds(db);
  // The person who caused the event is never told about their own action.
  await notifyMany(db, ids.filter((id) => Number(id) !== Number(event.actor?.id)), event);
}

export function mapNotification(row) {
  return {
    id: row.id,
    kind: row.kind,
    params: row.params || {},
    link: row.link || '',
    planId: row.plan_id ?? null,
    activityId: row.activity_id ?? null,
    actorName: row.actor_name || '',
    read: Boolean(row.read_at),
    readAt: row.read_at ?? null,
    createdAt: row.created_at
  };
}
