// Deleting an account (DELETE /api/users/:id), end to end.
//
//   1. only the Director deletes, never their own account, and only with the
//      account's username typed as confirmation;
//   2. an account that still holds work -- here, somebody reporting to it --
//      is refused until that work is handed over;
//   3. an account with no history at all is REMOVED: the row is gone;
//   4. an account with history (a suspended team member, whose suspension is
//      on the organisation trail) is CLOSED: it can never sign in again, old
//      sessions die, it leaves every list, its name stays on its records, and
//      it cannot be reactivated;
//   5. the answer says which of the two happened.
//
// The "last active Director" refusal is not reachable from here on purpose:
// the caller is always an active Director other than the target, so through
// the API there is always one left. The server checks it anyway, under a lock.
//
// Drives the live API against a real database and removes what it creates.

import bcrypt from 'bcryptjs';
import { pool } from '../server/db/database.js';
import { directorSession } from './director.mjs';

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

async function account(username, name, role, sector, managerId = null) {
  const row = await pool.query(
    `INSERT INTO users (username, password_hash, name, role, sector, manager_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [username, bcrypt.hashSync(PASSWORD, 10), name, role, sector, managerId]
  );
  created.push(row.rows[0].id);
  const login = await post(null, '/api/auth/login', { username, password: PASSWORD });
  if (login.status !== 200) throw new Error(`login ${username}: ${login.status} ${login.body.message}`);
  return { id: row.rows[0].id, username, token: login.body.token };
}

try {
  section('setup');
  const { token: admin } = await directorSession();
  const boss = await account('zz-del-boss', 'ZZ Del Boss', 'manager', 'mining');
  const worker = await account('zz-del-worker', 'ZZ Del Worker', 'staff', 'mining', boss.id);
  const fresh = await account('zz-del-fresh', 'ZZ Del Fresh', 'staff', 'mining');
  const director = (await pool.query("SELECT id, username FROM users WHERE role = 'super-admin' ORDER BY id LIMIT 1")).rows[0];

  section('1. Who may delete, and how');
  check('a manager cannot delete an account', (await del(boss.token, `/api/users/${fresh.id}`, { confirmUsername: fresh.username })).status === 403);
  const self = await del(admin, `/api/users/${director.id}`, { confirmUsername: director.username });
  check('the Director cannot delete their own account', self.status === 400 && self.body.code === 'SELF_DELETE', self.body);
  const unconfirmed = await del(admin, `/api/users/${fresh.id}`, {});
  check('without the username typed, nothing is deleted', unconfirmed.status === 400 && unconfirmed.body.code === 'CONFIRM_REQUIRED', unconfirmed.body);
  const wrong = await del(admin, `/api/users/${fresh.id}`, { confirmUsername: 'zz-del-someone-else' });
  check('  nor with the wrong username', wrong.status === 400, wrong.body);
  check('  the account is still there', (await pool.query('SELECT 1 FROM users WHERE id = $1', [fresh.id])).rowCount === 1);

  section('2. Somebody still reports to them');
  const holding = await del(admin, `/api/users/${boss.id}`, { confirmUsername: boss.username });
  check('a manager with a team member under them is refused', holding.status === 409 && holding.body.code === 'HOLDS_WORK' && holding.body.heldWork?.reports === 1, holding.body);
  check('  and the message says what to hand over', /reporting to them/.test(holding.body.message || ''), holding.body.message);

  section('3. No history: removed');
  const removed = await del(admin, `/api/users/${fresh.id}`, { confirmUsername: 'ZZ-DEL-FRESH' });
  check('an account that never did anything is permanently deleted', removed.status === 200 && removed.body.outcome === 'removed', removed.body);
  check('  the row is gone', (await pool.query('SELECT 1 FROM users WHERE id = $1', [fresh.id])).rowCount === 0);
  check('  and the trail says so, without the account', (await pool.query(
    "SELECT 1 FROM organization_history WHERE action = 'account_deleted' AND subject_name = 'ZZ Del Fresh' AND detail->>'outcome' = 'removed'"
  )).rowCount === 1);

  section('4. With history: closed');
  const suspended = await patch(admin, `/api/users/${worker.id}/status`, { status: 'suspended' });
  check('the team member is suspended first', suspended.status === 200);
  check('  the suspension is on the trail', (await pool.query(
    "SELECT 1 FROM organization_history WHERE action = 'account_suspended' AND subject_user_id = $1", [worker.id]
  )).rowCount === 1);
  const closed = await del(admin, `/api/users/${worker.id}`, { confirmUsername: worker.username });
  check('a suspended account with history is deleted by closing it', closed.status === 200 && closed.body.outcome === 'closed' && closed.body.records >= 1, closed.body);
  check('  the answer does not claim it was erased', !/permanently/.test(closed.body.message || ''), closed.body.message);
  const row = (await pool.query('SELECT status, username, password_hash, deleted_at, deleted_by, name FROM users WHERE id = $1', [worker.id])).rows[0];
  check('  the row is marked deleted, by whom and when', row?.status === 'deleted' && row.deleted_at && row.deleted_by === director.id, row);
  check('  its name stays for the records it made', row?.name === 'ZZ Del Worker');
  check('  the old username is freed and no password works', row?.username !== worker.username && row?.password_hash === '!deleted');
  const login = await post(null, '/api/auth/login', { username: worker.username, password: PASSWORD });
  check('  signing in with the old username fails', login.status === 401, login.status);
  const oldSession = await get(worker.token, '/api/auth/session');
  check('  a session opened before the delete is refused', oldSession.status === 401 || oldSession.status === 403, oldSession.status);
  const register = (await get(admin, '/api/users')).body.users || [];
  check('  it is gone from the account register', !register.some((u) => u.id === worker.id));
  const people = (await get(admin, '/api/people')).body || [];
  check('  and from the list work is handed to', !people.some((u) => u.id === worker.id));
  const chart = (await get(admin, '/api/organization')).body.people || [];
  check('  and from the organisation chart', !chart.some((p) => p.id === worker.id));
  const back = await patch(admin, `/api/users/${worker.id}/status`, { status: 'active' });
  check('  a deleted account cannot be reactivated', back.status === 404, back.body);
  const twice = await del(admin, `/api/users/${worker.id}`, { confirmUsername: row?.username });
  check('  nor deleted a second time', twice.status === 404, twice.body);

  section('4b. Typed as a name, and in a crowded operation');
  // The Director types the name they can see, not the username.
  const byName = await account('zz-del-byname', 'ZZ Del By Name', 'staff', 'mining');
  const named = await del(admin, `/api/users/${byName.id}`, { confirmUsername: '  zz del   BY name ' });
  check('typing the person’s name (any case, extra spaces) confirms it too', named.status === 200, named.body);
  // An operation holding more managers than the three-per-operation rule
  // allows -- data from before the rule. The rule fired on every update of a
  // manager's row, so closing one of them was refused by the very rule it
  // would have helped satisfy.
  const crowd = [];
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query('ALTER TABLE users DISABLE TRIGGER manager_sector_limit');
    for (let n = 1; n <= 4; n += 1) {
      const row = await tx.query(
        "INSERT INTO users (username, password_hash, name, role, sector) VALUES ($1, $2, $3, 'manager', 'movement') RETURNING id",
        [`zz-del-crowd-${n}`, bcrypt.hashSync(PASSWORD, 4), `ZZ Del Crowd ${n}`]
      );
      crowd.push(row.rows[0].id);
      created.push(row.rows[0].id);
    }
    await tx.query('ALTER TABLE users ENABLE TRIGGER manager_sector_limit');
    await tx.query('COMMIT');
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
  // History, so the account is closed (an UPDATE) rather than removed.
  await pool.query("INSERT INTO organization_history (action, subject_user_id, subject_name, detail) VALUES ('account_suspended', $1, 'ZZ Del Crowd 1', '{}')", [crowd[0]]);
  const crowded = await del(admin, `/api/users/${crowd[0]}`, { confirmUsername: 'zz-del-crowd-1' });
  check('a manager in an operation with too many managers can still be closed', crowded.status === 200 && crowded.body.outcome === 'closed', crowded.body);

  section('5. Once the work is handed over');
  const freed = await del(admin, `/api/users/${boss.id}`, { confirmUsername: boss.username });
  check('the manager can be deleted once nobody reports to them', freed.status === 200 && ['removed', 'closed'].includes(freed.body.outcome), freed.body);
  check('  and a closed manager no longer counts towards the three per operation', freed.body.outcome === 'removed' || (await pool.query(
    "SELECT 1 FROM manager_operations WHERE manager_id = $1", [boss.id]
  )).rowCount === 0);
} catch (error) {
  failed += 1;
  console.log(`  FAIL  unexpected error -- ${error.stack || error.message}`);
} finally {
  // Accounts this suite made, under any username they ended up with.
  if (created.length) {
    await pool.query("DELETE FROM organization_history WHERE subject_user_id = ANY($1::int[]) OR subject_name LIKE 'ZZ Del %'", [created]);
    await pool.query('UPDATE users SET manager_id = NULL WHERE id = ANY($1::int[])', [created]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [created]);
  }
  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
