// End-to-end check of the administrator feedback round against the running API:
//
//   1. a partner may follow several business operations, and only those;
//   2. an activity belongs to its project's business operation;
//   3. work sent back for correction must say what to fix, the manager is
//      told and sees it, and the manager may correct only what was sent back;
//   4. the Director's Home can list the newest records managers added;
//   5. a partner's comment reaches the Director and nobody else, and the
//      Director's answer reaches only that partner.
//
// Like the other suites it drives the live API against a real database and
// removes everything it creates. Fixtures use the zz- / ZZTEST prefixes.

import bcrypt from 'bcryptjs';
import { pool } from '../server/db/database.js';
import { directorSession } from './director.mjs';
import { PROJECT_IDS, createProject, removeProject } from './fixtures.mjs';

const API = process.env.API || 'http://localhost:5000';
const PARTNER_OWN_PASSWORD = 'partner-own-pass-789';

let passed = 0;
let failed = 0;
const created = { users: [], activities: [] };

const check = (label, condition, detail = '') => {
  if (condition) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` -- ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 200)}` : ''}`); }
};
const section = (title) => console.log(`\n=== ${title} ===`);

async function api(token, path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}
const send = (token, method, path, body) => api(token, path, { method, body: JSON.stringify(body ?? {}) });

async function login(username, password) {
  const { status, body } = await send(null, 'POST', '/api/auth/login', { username, password });
  if (status !== 200) throw new Error(`login ${username} failed: ${status} ${body.message}`);
  return body.token;
}

// Invites a partner through the Director's endpoint and signs them in with a
// password of their own, as the app insists on at first sign-in.
async function invitePartner(adminToken, username, grant) {
  const invited = await send(adminToken, 'POST', '/api/partners', {
    name: `ZZTEST ${username}`, email: `${username}@example.test`, username, password: 'test-pass-123', ...grant
  });
  if (invited.status !== 201) return { invited };
  created.users.push(invited.body.id);
  const first = await login(username, 'test-pass-123');
  const chosen = await send(first, 'POST', '/api/auth/password', { currentPassword: 'test-pass-123', newPassword: PARTNER_OWN_PASSWORD });
  return { invited, token: chosen.body.token };
}

async function cleanup() {
  for (const id of created.activities) await pool.query('DELETE FROM activities WHERE id = $1', [id]);
  for (const id of created.users) {
    await pool.query(
      `UPDATE activities SET created_by = NULL, assigned_to = NULL, approval_required_from = NULL,
       approved_by = NULL, reviewed_by = NULL
       WHERE created_by = $1 OR assigned_to = $1 OR approval_required_from = $1 OR approved_by = $1 OR reviewed_by = $1`,
      [id]
    );
    // A partner's comment notifies the real Director, and that row belongs to
    // the Director: deleting the partner only nulls its actor_id (ON DELETE SET
    // NULL), so without this every run left two ZZTEST notices in the
    // Director's bell. Removed by actor before the account goes.
    await pool.query('DELETE FROM notifications WHERE actor_id = $1', [id]);
    // partner_operations and partner_comments go with the account (ON DELETE CASCADE).
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
  }
  await removeProject('mining');
  await removeProject('farming');
}

async function raiseMining(token, overrides = {}) {
  const result = await send(token, 'POST', '/api/activities', {
    projectId: PROJECT_IDS.mining, sector: 'mining', category: 'Extraction',
    activity: 'ZZTEST feedback workflow', description: 'Automated test record.',
    quantity: 1, costUsd: 100, costRwf: 145000, costCdf: 285000,
    ...overrides
  });
  if (result.status === 201) created.activities.push(result.body.id);
  return result;
}

const editBody = (overrides = {}) => ({
  projectId: PROJECT_IDS.mining, sector: 'mining', category: 'Extraction', activity: 'ZZTEST edited',
  description: 'Automated test record.', quantity: 1, costUsd: 100, costRwf: 145000, costCdf: 285000,
  ...overrides
});

try {
  section('setup');
  const { token: adminToken, id: directorId } = await directorSession();
  await createProject('mining');
  await createProject('farming');

  const manager = await pool.query(
    `INSERT INTO users (username, password_hash, name, role, sector)
     VALUES ('zz-fb-mining-mgr', $1, 'ZZTEST Feedback Manager', 'manager', 'mining') RETURNING id`,
    [bcrypt.hashSync('test-pass-123', 10)]
  );
  created.users.push(manager.rows[0].id);
  const managerToken = await login('zz-fb-mining-mgr', 'test-pass-123');

  // ---- 1. a partner following several operations ---------------------------
  section('A partner may follow several business operations, and only those');
  const two = await invitePartner(adminToken, 'zz-fb-partner-two', { operations: ['mining', 'farming'] });
  check('a partner can be invited with two operations',
    two.invited.status === 201 && two.invited.body.operations?.length === 2, two.invited.body);
  const agri = await invitePartner(adminToken, 'zz-fb-partner-agri', { operation: 'agriculture' });
  check('the single-operation invite still works', agri.invited.status === 201 && agri.invited.body.operation === 'agriculture', agri.invited.body);

  const none = await send(adminToken, 'POST', '/api/partners', {
    name: 'ZZTEST none', email: 'zz-none@example.test', username: 'zz-fb-partner-none', password: 'test-pass-123', operations: []
  });
  check('a partner cannot be invited with no operation', none.status === 400, String(none.status));
  const unknown = await send(adminToken, 'POST', '/api/partners', {
    name: 'ZZTEST unknown', email: 'zz-unknown@example.test', username: 'zz-fb-partner-unknown', password: 'test-pass-123', operations: ['mining', 'sector-5']
  });
  check('an unknown operation in the set is refused outright', unknown.status === 400, String(unknown.status));

  const overview = await api(two.token, '/api/partner/overview');
  check('the overview lists both operations', overview.status === 200
    && ['farming', 'mining'].every((id) => overview.body.operations?.includes(id)), overview.body.operations);
  const both = await api(two.token, '/api/partner/activities?limit=200');
  check('every activity returned is in one of the two operations',
    both.status === 200 && both.body.every((item) => ['mining', 'farming'].includes(item.operation)));
  const narrowed = await api(two.token, '/api/partner/activities?operation=farming&limit=200');
  check('narrowing to one granted operation returns only that one',
    narrowed.status === 200 && narrowed.body.every((item) => item.operation === 'farming'));
  const outside = await api(two.token, '/api/partner/activities?operation=agriculture&limit=200');
  check('asking for an operation outside the grants is refused', outside.status === 403, String(outside.status));
  for (const param of ['sector', 'department', 'relatedArea']) {
    const attempt = await api(two.token, `/api/partner/activities?${param}=agriculture&limit=200`);
    check(`  ?${param}=agriculture widens nothing`,
      attempt.status === 200 && attempt.body.every((item) => ['mining', 'farming'].includes(item.operation)));
  }
  const regrant = await send(adminToken, 'PATCH', `/api/partners/${two.invited.body.id}/operations`, { operations: ['farming'] });
  check('the Director can change the set', regrant.status === 200 && regrant.body.operations?.join() === 'farming', regrant.body);
  const afterRegrant = await api(two.token, '/api/partner/activities?operation=mining&limit=200');
  check('a removed operation is refused on the very next request', afterRegrant.status === 403, String(afterRegrant.status));
  await send(adminToken, 'PATCH', `/api/partners/${two.invited.body.id}/operations`, { operations: ['mining', 'farming'] });

  // ---- 2. activities belong to their project's operation -------------------
  section('An activity belongs to its project’s business operation');
  const mismatched = await raiseMining(managerToken, { sector: 'farming' });
  check('a manager naming another operation than the project is refused',
    mismatched.status === 400 || mismatched.status === 403, `${mismatched.status} ${mismatched.body.message}`);
  const directorMismatch = await raiseMining(adminToken, { projectId: PROJECT_IDS.farming, sector: 'mining', assignedTo: manager.rows[0].id });
  check('  and so is the Director', directorMismatch.status === 400, `${directorMismatch.status} ${directorMismatch.body.message}`);

  // ---- 3. sending work back for correction ---------------------------------
  section('Work sent back must say what to fix, and only then reopens to the manager');
  const raised = await raiseMining(managerToken);
  check('a manager raises a Mining activity', raised.status === 201, raised.body);
  const activityId = raised.body.id;

  const editPending = await send(managerToken, 'PUT', `/api/activities/${activityId}`, editBody({ activity: 'ZZTEST edited while pending' }));
  check('a request waiting on the Director is locked to the manager', editPending.status === 403, `${editPending.status} ${editPending.body.message}`);

  const approved = await send(adminToken, 'PATCH', `/api/activities/${activityId}/approval`, { action: 'approve' });
  check('the Director approves it', approved.status === 200, approved.body);
  const editApproved = await send(managerToken, 'PUT', `/api/activities/${activityId}`, editBody());
  check('an approved record is locked to the manager', editApproved.status === 403, String(editApproved.status));

  const noNote = await send(adminToken, 'PATCH', `/api/activities/${activityId}/decision`, { status: 'Needs Correction' });
  check('a return with no note is refused (decision)', noNote.status === 400, noNote.body);
  const shortNote = await send(adminToken, 'PATCH', `/api/activities/${activityId}/decision`, { status: 'Needs Correction', adminNote: 'fix' });
  check('a return with a token note is refused', shortNote.status === 400, shortNote.body);
  const statusNoNote = await send(adminToken, 'PATCH', `/api/activities/${activityId}/status`, { status: 'Needs Correction' });
  check('a return with no note is refused (status route)', statusNoNote.status === 400, statusNoNote.body);

  // The record's standing note does not count as the reason for this return.
  await send(adminToken, 'PATCH', `/api/activities/${activityId}/decision`, { adminNote: 'Standing note from the planning meeting.' });
  const stale = await send(adminToken, 'PATCH', `/api/activities/${activityId}/decision`, { status: 'Needs Correction' });
  check('with no new note, the record’s existing note is not accepted as the reason', stale.status === 400, stale.body);
  const repeated = await send(adminToken, 'PATCH', `/api/activities/${activityId}/decision`, {
    status: 'Needs Correction', adminNote: 'Standing note from the planning meeting.'
  });
  check('  nor is the same sentence sent again', repeated.status === 400, repeated.body);

  const reason = 'The quantity is wrong: the site needs 3 loads, not 1.';
  const returned = await send(adminToken, 'PATCH', `/api/activities/${activityId}/status`, { status: 'Needs Correction', note: reason });
  check('a return with a real reason is accepted (status route)', returned.status === 200 && returned.body.status === 'Needs Correction', returned.body);

  const managerView = await api(managerToken, `/api/activities/${activityId}`);
  check('the manager sees what needs fixing', managerView.body.activity?.adminNote === reason, managerView.body.activity?.adminNote);
  check('  with who sent it back and when', Boolean(managerView.body.activity?.reviewedByName && managerView.body.activity?.reviewedAt));
  check('  and the return is in the trail with its reason',
    (managerView.body.history || []).some((entry) => entry.newValue === 'Needs Correction' && entry.note === reason));
  const notices = await api(managerToken, '/api/notifications?limit=40');
  check('the manager is told, with the reason',
    (notices.body.items || []).some((item) => item.kind === 'work_returned' && item.params?.reason === reason), notices.body.items?.map((item) => item.kind));

  const moneyMoved = await send(managerToken, 'PUT', `/api/activities/${activityId}`, editBody({ activity: 'ZZTEST corrected', quantity: 3, costUsd: 300, costRwf: 435000, costCdf: 855000 }));
  check('a correction cannot move the money', moneyMoved.status === 400, moneyMoved.body);
  const projectMoved = await send(managerToken, 'PUT', `/api/activities/${activityId}`, editBody({ projectId: PROJECT_IDS.farming, sector: 'farming' }));
  check('  nor move the work to another project', projectMoved.status === 400 || projectMoved.status === 404, `${projectMoved.status}`);
  const corrected = await send(managerToken, 'PUT', `/api/activities/${activityId}`, editBody({
    activity: 'ZZTEST corrected', quantity: 3, correctionNote: 'Quantity set to 3 loads.'
  }));
  check('the manager corrects work sent back to them', corrected.status === 200 && corrected.body.quantity === 3, corrected.body);
  const trail = await api(managerToken, `/api/activities/${activityId}/history`);
  const entries = Array.isArray(trail.body) ? trail.body : trail.body.history || [];
  check('  the correction is recorded as the answer to the return',
    entries.some((entry) => entry.action === 'Correction made' && entry.note === 'Quantity set to 3 loads.'));
  const resumed = await send(managerToken, 'PATCH', `/api/activities/${activityId}/status`, { status: 'In Progress' });
  check('the manager resumes the corrected work', resumed.status === 200, resumed.body);
  const lockedAgain = await send(managerToken, 'PUT', `/api/activities/${activityId}`, editBody({ activity: 'ZZTEST after resuming' }));
  check('  after which it is locked to them again', lockedAgain.status === 403, String(lockedAgain.status));

  // ---- 4. the newest records managers added ---------------------------------
  section('The Director can list the newest records managers added');
  const latest = await api(adminToken, '/api/activities?raisedBy=managers&limit=5');
  check('the list answers, newest first, at most five', latest.status === 200 && latest.body.length <= 5, String(latest.status));
  check('  it includes this manager’s record', latest.body.some((item) => item.id === activityId));
  check('  and none the Director created', latest.body.every((item) => Number(item.createdBy) !== Number(directorId)));

  // ---- 5. comments from a partner to the Director --------------------------
  section('A partner’s comment reaches the Director, and nobody else');
  const comment = await send(two.token, 'POST', '/api/partner/comments', { operation: 'mining', body: 'ZZTEST When will the Mining site report be published?' });
  check('a partner comments on an operation they follow', comment.status === 201, comment.body);
  const threadId = comment.body.id;

  const outsideComment = await send(two.token, 'POST', '/api/partner/comments', { operation: 'agriculture', body: 'ZZTEST outside' });
  check('a comment on an operation outside the grants is refused', outsideComment.status === 403, String(outsideComment.status));
  const probe = await send(two.token, 'POST', '/api/partner/comments', {
    operation: 'mining', subjectType: 'activity', subjectId: 'ACT-DOES-NOT-EXIST', body: 'ZZTEST probe'
  });
  check('a comment on a record they cannot see is refused', probe.status === 404, String(probe.status));
  const blank = await send(two.token, 'POST', '/api/partner/comments', { operation: 'mining', body: '   ' });
  check('an empty comment is refused', blank.status === 400, String(blank.status));

  // A comment on what happened, from the update itself: the update names its
  // activity, and that is what the comment is about.
  await pool.query("UPDATE activities SET approval_status = 'approved', externally_visible = TRUE WHERE id = $1", [activityId]);
  const partnerUpdates = await api(two.token, '/api/partner/updates?limit=100');
  const happened = (partnerUpdates.body || []).find((update) => update.activityId === activityId);
  check('a partner\'s update names the activity it is about', Boolean(happened), partnerUpdates.body);
  const onUpdate = await send(two.token, 'POST', '/api/partner/comments', {
    operation: happened?.operation, subjectType: 'activity', subjectId: happened?.activityId, body: 'ZZTEST How many loads are left?'
  });
  check('  and the partner comments on it', onUpdate.status === 201 && onUpdate.body.subjectId === activityId, onUpdate.body);
  await pool.query('UPDATE activities SET externally_visible = FALSE WHERE id = $1', [activityId]);

  const inbox = await api(adminToken, '/api/partner-comments');
  const inInbox = (inbox.body.threads || []).find((thread) => thread.id === threadId);
  check('the Director sees it, unread', inbox.status === 200 && inInbox?.unreadByDirector === 1, inInbox);
  const directorNotices = await api(adminToken, '/api/notifications?limit=40');
  check('  and is notified', (directorNotices.body.items || []).some((item) => item.kind === 'partner_comment'));

  check('a manager cannot read partner comments', (await api(managerToken, '/api/partner-comments')).status === 403);
  check('a partner cannot reach the Director’s inbox', (await api(two.token, '/api/partner-comments')).status === 403);
  const otherPartner = await api(agri.token, '/api/partner/comments');
  check('another partner does not see the thread', otherPartner.status === 200 && !otherPartner.body.some((thread) => thread.id === threadId));
  const hijack = await send(agri.token, 'POST', `/api/partner/comments/${threadId}/replies`, { body: 'ZZTEST hijack' });
  check('another partner cannot reply into it', hijack.status === 404, String(hijack.status));

  const answer = 'ZZTEST It will be published by the end of the month.';
  const replied = await send(adminToken, 'POST', `/api/partner-comments/${threadId}/replies`, { body: answer });
  check('the Director replies', replied.status === 201 && replied.body.thread?.messages?.length === 2, replied.body);
  check('  replying marks the thread read', replied.body.thread?.unreadByDirector === 0);
  const partnerThreads = await api(two.token, '/api/partner/comments');
  const seen = (partnerThreads.body || []).find((thread) => thread.id === threadId);
  check('the partner sees the Director’s answer',
    Boolean(seen?.messages?.some((message) => message.body === answer && message.authorRole === 'super-admin')));
  check('the answer is not visible to the other partner',
    !((await api(agri.token, '/api/partner/comments')).body || []).some((thread) => thread.messages.some((message) => message.body === answer)));

  // ---- isolation: nothing internal reaches a partner -----------------------
  section('Internal notes never reach a partner');
  const partnerActivities = await api(two.token, '/api/partner/activities?limit=200');
  const keys = new Set((partnerActivities.body || []).flatMap((item) => Object.keys(item)));
  for (const internal of ['adminNote', 'rejectionReason', 'history', 'createdByName', 'reviewedByName', 'instructions']) {
    check(`  no ${internal} in a partner’s activity`, !keys.has(internal));
  }
  const everything = JSON.stringify([partnerActivities.body, partnerThreads.body, overview.body]);
  check('the correction note given to the manager appears nowhere a partner reads', !everything.includes(reason));
} catch (error) {
  failed += 1;
  console.error('\nUNCAUGHT:', error.message, '\n', error.stack);
} finally {
  section('cleanup');
  await cleanup();
  console.log(`  removed ${created.activities.length} activities, ${created.users.length} accounts`);
  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
}
