// Suspending, recovering and deleting an account, end to end.
//
//   1. only the Director deletes, never their own account, and only an
//      account that has been suspended first -- that two-step order is the
//      protection against a stray click, with nothing to type;
//   2. suspending and recovering are one call each, and both are on the trail;
//   3. an account with no history at all is REMOVED: the row is gone;
//   4. an account with history is CLOSED: it can never sign in again, old
//      sessions die, it leaves every list, its name stays on its records, and
//      it cannot be recovered;
//   5. work the deleted person was still running WAITS -- the delete is never
//      refused for it and asks nobody -- and the next account the Director
//      adds with the same role, working where that work is, takes all of it
//      over: the month, the project, the team member reporting to them;
//      somebody added in another operation does not;
//   6. a manager in an operation already over the three-manager limit can
//      still be deleted;
//   7. an open till is the one thing still to close first.
//
// The "last active Director" refusal is not reachable from here on purpose:
// a Director cannot be suspended, so cannot be deleted. The server checks it
// anyway, under a lock.
//
// Drives the live API against a real database and removes what it creates.

import bcrypt from 'bcryptjs';
import { pool } from '../server/db/database.js';
import { directorSession } from './director.mjs';
import { createProject, removeProject } from './fixtures.mjs';

const API = process.env.API || 'http://localhost:5000';
let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` -- ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}` : ''}`); }
};
const section = (title) => console.log(`\n=== ${title} ===`);

async function api(token, path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) }
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
const post = (token, path, body) => api(token, path, { method: 'POST', body: JSON.stringify(body || {}) });
const del = (token, path, body) => api(token, path, { method: 'DELETE', body: JSON.stringify(body || {}) });
const patch = (token, path, body) => api(token, path, { method: 'PATCH', body: JSON.stringify(body || {}) });
const get = (token, path) => api(token, path);

const PASSWORD = 'test-pass-123';
const created = [];
const plansMade = [];
let projectMade = null;

async function account(username, name, role, sector, managerId = null, status = 'active') {
  const row = await pool.query(
    `INSERT INTO users (username, password_hash, name, role, sector, manager_id, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [username, bcrypt.hashSync(PASSWORD, 4), name, role, sector, managerId, status]
  );
  created.push(row.rows[0].id);
  if (status !== 'active') return { id: row.rows[0].id, username };
  const login = await post(null, '/api/auth/login', { username, password: PASSWORD });
  if (login.status !== 200) throw new Error(`login ${username}: ${login.status} ${login.body.message}`);
  return { id: row.rows[0].id, username, token: login.body.token };
}
const statusOf = async (id) => (await pool.query('SELECT status FROM users WHERE id = $1', [id])).rows[0]?.status;

try {
  section('setup');
  const { token: admin } = await directorSession();
  const boss = await account('zz-del-boss', 'ZZ Del Boss', 'manager', 'mining');
  const worker = await account('zz-del-worker', 'ZZ Del Worker', 'staff', 'mining', boss.id);
  const director = (await pool.query("SELECT id, username FROM users WHERE role = 'super-admin' ORDER BY id LIMIT 1")).rows[0];

  section('1. Who may delete, and when');
  check('a manager cannot delete an account', (await del(boss.token, `/api/users/${worker.id}`)).status === 403);
  const self = await del(admin, `/api/users/${director.id}`);
  check('the Director cannot delete their own account', self.status === 400 && self.body.code === 'SELF_DELETE', self.body);
  const active = await del(admin, `/api/users/${worker.id}`);
  check('an active account is not deleted: suspend it first', active.status === 409 && active.body.code === 'SUSPEND_FIRST', active.body);
  check('  it is still active', await statusOf(worker.id) === 'active');

  section('2. Suspend and recover: one press each');
  const suspended = await patch(admin, `/api/users/${worker.id}/status`, { status: 'suspended' });
  check('suspending needs nothing but the press', suspended.status === 200 && await statusOf(worker.id) === 'suspended', suspended.body);
  check('  their session ends at once', [401, 403].includes((await get(worker.token, '/api/auth/session')).status));
  const recovered = await patch(admin, `/api/users/${worker.id}/status`, { status: 'active' });
  check('recovering brings them back', recovered.status === 200 && await statusOf(worker.id) === 'active', recovered.body);
  check('  both are on the trail', (await pool.query(
    "SELECT COUNT(*)::int AS n FROM organization_history WHERE subject_user_id = $1 AND action IN ('account_suspended', 'account_reactivated')", [worker.id]
  )).rows[0].n === 2);

  section('3. No history: removed');
  // Suspended straight in the table, so not even a suspension is on record.
  const fresh = await account('zz-del-fresh', 'ZZ Del Fresh', 'staff', 'mining', null, 'suspended');
  const removed = await del(admin, `/api/users/${fresh.id}`);
  check('an account that never did anything is permanently deleted', removed.status === 200 && removed.body.outcome === 'removed', removed.body);
  check('  the row is gone', (await pool.query('SELECT 1 FROM users WHERE id = $1', [fresh.id])).rowCount === 0);

  section('4. With history: closed');
  await patch(admin, `/api/users/${worker.id}/status`, { status: 'suspended' });
  const closed = await del(admin, `/api/users/${worker.id}`);
  check('a suspended account with history is deleted by closing it', closed.status === 200 && closed.body.outcome === 'closed' && closed.body.records >= 1, closed.body);
  check('  the answer does not claim it was erased', !/permanently/.test(closed.body.message || ''), closed.body.message);
  const row = (await pool.query('SELECT status, username, password_hash, deleted_at, deleted_by, name FROM users WHERE id = $1', [worker.id])).rows[0];
  check('  the row is marked deleted, by whom and when', row?.status === 'deleted' && row.deleted_at && row.deleted_by === director.id, row);
  check('  its name stays for the records it made', row?.name === 'ZZ Del Worker');
  check('  the old username is freed and no password works', row?.username !== worker.username && row?.password_hash === '!deleted');
  check('  signing in with the old username fails', (await post(null, '/api/auth/login', { username: worker.username, password: PASSWORD })).status === 401);
  const register = (await get(admin, '/api/users')).body.users || [];
  check('  it is gone from the account register', !register.some((u) => u.id === worker.id));
  check('  and from the list work is handed to', !((await get(admin, '/api/people')).body || []).some((u) => u.id === worker.id));
  check('  and from the organisation chart', !((await get(admin, '/api/organization')).body.people || []).some((p) => p.id === worker.id));
  check('  a deleted account cannot be recovered', (await patch(admin, `/api/users/${worker.id}/status`, { status: 'active' })).status === 404);
  check('  nor deleted a second time', (await del(admin, `/api/users/${worker.id}`)).status === 404);

  section('5. Their work waits, and the next person with the same role takes it over');
  // The manager runs a month, leads a project and has a team member under them.
  const crew = await account('zz-del-crew', 'ZZ Del Crew', 'staff', 'mining', boss.id);
  projectMade = await createProject('mining', { managerId: boss.id, name: 'ZZTEST hand-over project' });
  await pool.query("DELETE FROM monthly_plans WHERE sector = 'mining' AND month = '2093-02-01'");
  const month = await post(admin, '/api/monthly-plans', { operation: 'mining', month: '2093-02', managerId: boss.id, objectives: [{ title: 'ZZTEST hand-over objective', targetQuantity: 4, targetUnit: 'trips' }] });
  if (month.status !== 201) throw new Error(`plan: ${month.status} ${month.body.message}`);
  plansMade.push(month.body.id);
  await patch(admin, `/api/users/${boss.id}/status`, { status: 'suspended' });
  const gone = await del(admin, `/api/users/${boss.id}`);
  check('a manager still running a month is deleted without being asked anything', gone.status === 200 && gone.body.outcome === 'closed', gone.body);
  check('  and the answer says their work waits', gone.body.waitingWork?.plans === 1 && gone.body.waitingWork?.reports === 1 && gone.body.waitingWork?.leads === 1, gone.body.waitingWork);
  const waitingList = (await get(admin, '/api/users')).body.waiting || [];
  const bossWaiting = waitingList.find((w) => w.id === boss.id);
  check('People lists it as waiting for a replacement in Mining', bossWaiting?.role === 'manager' && bossWaiting.operations.includes('mining'), waitingList);
  const elsewhere = await post(admin, '/api/users', { username: 'zz-del-agri', name: 'ZZ Del Agriculture', password: 'Temp-pass-123', role: 'manager', sectors: ['agriculture'] });
  if (elsewhere.body.id) created.push(elsewhere.body.id);
  check('a new manager in Agriculture does not take Mining’s work', elsewhere.status === 201 && !elsewhere.body.tookOver, elsewhere.body);
  const heir = await post(admin, '/api/users', { username: 'zz-del-heir', name: 'ZZ Del Heir', password: 'Temp-pass-123', role: 'manager', sectors: ['mining'] });
  if (heir.body.id) created.push(heir.body.id);
  check('a new manager added in Mining takes it over by themselves', heir.status === 201 && heir.body.tookOver?.from?.id === boss.id, heir.body);
  const after = (await pool.query(
    `SELECT (SELECT manager_id FROM monthly_plans WHERE id = $1) AS plan_manager,
            (SELECT assigned_by FROM monthly_plans WHERE id = $1) AS plan_assigned_by,
            (SELECT manager_id FROM projects WHERE id = $2) AS project_manager,
            (SELECT manager_id FROM users WHERE id = $3) AS crew_line`, [month.body.id, projectMade, crew.id])).rows[0];
  check('  the month is now theirs, handed by the Director', after.plan_manager === heir.body.id && after.plan_assigned_by === director.id, after);
  check('  so is the project', after.project_manager === heir.body.id, after);
  check('  and the team member now reports to them', after.crew_line === heir.body.id, after);
  check('  nothing waits any more', !((await get(admin, '/api/users')).body.waiting || []).some((w) => w.id === boss.id));
  const heirNotices = await pool.query("SELECT params FROM notifications WHERE user_id = $1 AND kind = 'work_handed_over'", [heir.body.id]);
  check('  and they are told the work is theirs', heirNotices.rows.some((n) => n.params?.title === 'ZZ Del Boss'), heirNotices.rows);
  const another = await post(admin, '/api/users', { username: 'zz-del-third', name: 'ZZ Del Third', password: 'Temp-pass-123', role: 'manager', sectors: ['mining'] });
  if (another.body.id) created.push(another.body.id);
  check('the next Mining manager added takes nothing: it was already taken', another.status === 201 && !another.body.tookOver, another.body);

  section('6. In an operation already over the manager limit');
  // Data from before the three-per-operation rule. The rule used to fire on
  // every update of a manager's row, so none of them could be deleted.
  const crowd = [];
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query('ALTER TABLE users DISABLE TRIGGER manager_sector_limit');
    for (let n = 1; n <= 4; n += 1) {
      const inserted = await tx.query(
        "INSERT INTO users (username, password_hash, name, role, sector, status) VALUES ($1, '!test', $2, 'manager', 'movement', 'suspended') RETURNING id",
        [`zz-del-crowd-${n}`, `ZZ Del Crowd ${n}`]
      );
      crowd.push(inserted.rows[0].id);
      created.push(inserted.rows[0].id);
    }
    await tx.query('ALTER TABLE users ENABLE TRIGGER manager_sector_limit');
    await tx.query('COMMIT');
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
  await pool.query("INSERT INTO organization_history (action, subject_user_id, subject_name, detail) VALUES ('account_suspended', $1, 'ZZ Del Crowd 1', '{}')", [crowd[0]]);
  const crowded = await del(admin, `/api/users/${crowd[0]}`);
  check('a manager there can still be deleted', crowded.status === 200 && crowded.body.outcome === 'closed', crowded.body);

  section('7. An open till is the one thing to close first');
  const cashier = await account('zz-del-cashier', 'ZZ Del Cashier', 'staff', 'boutique', null, 'suspended');
  await pool.query('INSERT INTO boutique_cash_sessions (opened_by, opening_cash) VALUES ($1, 0)', [cashier.id]);
  const tillOpen = await del(admin, `/api/users/${cashier.id}`);
  check('a cashier with an open till is not deleted until it is closed', tillOpen.status === 409 && tillOpen.body.code === 'OPEN_TILL', tillOpen.body);
  await pool.query("UPDATE boutique_cash_sessions SET status = 'closed', closed_at = NOW() WHERE opened_by = $1", [cashier.id]);
  const tillClosed = await del(admin, `/api/users/${cashier.id}`);
  check('  once it is closed, the account is deleted', tillClosed.status === 200 && tillClosed.body.outcome === 'closed', tillClosed.body);
} catch (error) {
  failed += 1;
  console.log(`  FAIL  unexpected error -- ${error.stack || error.message}`);
} finally {
  // Everything this suite wrote, under any username it ended up with.
  for (const id of plansMade) await pool.query('DELETE FROM monthly_plans WHERE id = $1', [id]);
  if (projectMade) await removeProject('mining');
  if (created.length) {
    await pool.query('DELETE FROM boutique_cash_sessions WHERE opened_by = ANY($1::int[])', [created]);
    await pool.query("DELETE FROM organization_history WHERE subject_user_id = ANY($1::int[]) OR subject_name LIKE 'ZZ Del %'", [created]);
    await pool.query('UPDATE users SET manager_id = NULL WHERE id = ANY($1::int[])', [created]);
    await pool.query('DELETE FROM manager_operations WHERE manager_id = ANY($1::int[])', [created]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [created]);
  }
  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
