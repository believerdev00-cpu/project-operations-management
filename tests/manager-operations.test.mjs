// End-to-end check that one manager can run more than one business operation
// (Mining and Agriculture at once), against the running API:
//
//   1. the Director creates a manager with several operations, and only a
//      manager may have more than one -- a team member sits in exactly one;
//   2. that manager reads and works in every one of them, and in no other;
//   3. they are listed as a manager of each, so a team member in either can
//      report to them;
//   4. their operations can be widened, set to "all", and narrowed -- and a
//      narrowing that would strand open work waits until the work is handed on;
//   5. the three-managers-per-operation limit counts a manager's every
//      operation, and refuses the whole account rather than half of it.
//
// Like the other suites it drives the live API against a real database and
// removes everything it creates. Fixtures use the zz- / ZZTEST prefixes.

import { pool } from '../server/db/database.js';
import { directorSession } from './director.mjs';
import { PROJECT_IDS, createProject, removeProject } from './fixtures.mjs';

const API = process.env.API || 'http://localhost:5000';
const TEMPORARY = 'test-pass-123';
const OWN_PASSWORD = 'manager-own-pass-456';

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

// Creates an account through the Director's own route -- the thing under test
// -- and remembers it for cleanup whatever the answer.
async function createAccount(adminToken, fields) {
  const result = await send(adminToken, 'POST', '/api/users', { password: TEMPORARY, ...fields });
  if (result.status === 201) created.users.push(result.body.id);
  return result;
}

// Every account the Director makes starts on a temporary password; the owner
// chooses their own before anything else answers.
async function signInFirstTime(username) {
  const first = await send(null, 'POST', '/api/auth/login', { username, password: TEMPORARY });
  if (first.status !== 200) throw new Error(`login ${username} failed: ${first.status} ${first.body.message}`);
  const chosen = await send(first.body.token, 'POST', '/api/auth/password', { currentPassword: TEMPORARY, newPassword: OWN_PASSWORD });
  if (chosen.status !== 200) throw new Error(`password change for ${username} failed: ${chosen.status} ${chosen.body.message}`);
  return chosen.body.token;
}

async function raise(token, operation) {
  const result = await send(token, 'POST', '/api/activities', {
    projectId: PROJECT_IDS[operation], sector: operation, category: 'ZZTEST',
    activity: `ZZTEST multi-operation ${operation}`, description: 'Automated test record.',
    quantity: 1, costUsd: 10, costRwf: 14500, costCdf: 28500
  });
  if (result.status === 201) created.activities.push(result.body.id);
  return result;
}

const OPERATIONS = ['mining', 'agriculture', 'farming'];

async function cleanup() {
  for (const id of created.activities) await pool.query('DELETE FROM activities WHERE id = $1', [id]);
  for (const id of created.users) {
    await pool.query(
      `UPDATE activities SET created_by = NULL, assigned_to = NULL, approval_required_from = NULL,
       approved_by = NULL, reviewed_by = NULL
       WHERE created_by = $1 OR assigned_to = $1 OR approval_required_from = $1 OR approved_by = $1 OR reviewed_by = $1`,
      [id]
    );
    await pool.query('UPDATE users SET manager_id = NULL WHERE manager_id = $1', [id]);
  }
  // manager_operations and notifications go with the account (ON DELETE CASCADE).
  for (const id of created.users) await pool.query('DELETE FROM users WHERE id = $1', [id]);
  for (const operation of OPERATIONS) await removeProject(operation);
}

try {
  section('setup');
  const { token: adminToken } = await directorSession();
  for (const operation of OPERATIONS) await createProject(operation);

  // ---- 1. creating a manager of two operations ------------------------------
  section('The Director creates a manager of Mining and Agriculture');
  const made = await createAccount(adminToken, {
    username: 'zz-multi-mgr', name: 'ZZTEST Multi Manager', role: 'manager', sectors: ['mining', 'agriculture']
  });
  check('the account is created', made.status === 201, made.body);
  check('  with both operations', [...(made.body.operations || [])].sort().join() === 'agriculture,mining', made.body.operations);
  check('  and the first of them on the row', made.body.sector === 'mining', made.body.sector);
  check('  and not as an all-operations manager', made.body.coversAllSectors === false);
  const managerId = made.body.id;

  const staffTwo = await createAccount(adminToken, {
    username: 'zz-multi-staff-two', name: 'ZZTEST Staff Two', role: 'staff', sectors: ['mining', 'agriculture']
  });
  check('a team member cannot be given two operations', staffTwo.status === 400, `${staffTwo.status} ${staffTwo.body.message}`);
  const noOperation = await createAccount(adminToken, {
    username: 'zz-multi-none', name: 'ZZTEST None', role: 'manager', sectors: []
  });
  check('a manager cannot be created with no operation', noOperation.status === 400, String(noOperation.status));
  const unknown = await createAccount(adminToken, {
    username: 'zz-multi-unknown', name: 'ZZTEST Unknown', role: 'manager', sectors: ['mining', 'quarrying']
  });
  check('an unknown operation in the list is refused outright', unknown.status === 400, String(unknown.status));
  const single = await createAccount(adminToken, {
    username: 'zz-multi-single', name: 'ZZTEST Single', role: 'manager', sector: 'farming'
  });
  check('the single-operation form still works', single.status === 201 && single.body.operations?.join() === 'farming', single.body);

  // ---- 2. working in both, and only both ------------------------------------
  section('The manager works in both operations, and no other');
  const managerToken = await signInFirstTime('zz-multi-mgr');
  const session = await api(managerToken, '/api/auth/session');
  check('the session lists both operations',
    [...(session.body.user?.operations || [])].sort().join() === 'agriculture,mining', session.body.user);

  const mining = await raise(managerToken, 'mining');
  check('they can add work in Mining', mining.status === 201, `${mining.status} ${mining.body.message}`);
  const agriculture = await raise(managerToken, 'agriculture');
  check('  and in Agriculture -- the second operation is not lost behind the first',
    agriculture.status === 201, `${agriculture.status} ${agriculture.body.message}`);
  const farming = await raise(managerToken, 'farming');
  check('  but not in Farming, which they do not run', farming.status === 403 || farming.status === 404, `${farming.status} ${farming.body.message}`);

  const register = await api(managerToken, '/api/activities?limit=200');
  const rows = Array.isArray(register.body) ? register.body : (register.body.items || []);
  const ids = new Set(rows.map((row) => row.id));
  check('their register shows the Mining work', ids.has(mining.body.id));
  check('  and the Agriculture work', ids.has(agriculture.body.id));
  check('  and nothing from another operation', rows.every((row) => ['mining', 'agriculture'].includes(row.sector)),
    [...new Set(rows.map((row) => row.sector))]);

  const agricultureRecord = await api(managerToken, `/api/activities/${agriculture.body.id}`);
  check('they can open a record in the second operation', agricultureRecord.status === 200, String(agricultureRecord.status));

  const summary = await api(managerToken, '/api/summary');
  const breakdown = (summary.body.sectorBreakdown || []).map((row) => row.id).sort().join();
  check('their dashboard compares both operations', breakdown === 'agriculture,mining', breakdown);

  const monthly = await api(managerToken, '/api/monthly-plans');
  check('the monthly plan list answers with only their operations',
    monthly.status === 200 && (monthly.body || []).every((plan) => ['mining', 'agriculture'].includes(plan.operation)), String(monthly.status));
  const farmingPlans = await api(managerToken, '/api/monthly-plans?operation=farming');
  check('  and asking for another operation\'s months returns none of them',
    farmingPlans.status !== 200 || (farmingPlans.body || []).length === 0, String(farmingPlans.status));

  // ---- 3. listed as a manager of each ---------------------------------------
  section('They are a manager of each operation for everyone else');
  const managers = await api(adminToken, '/api/managers');
  const listed = (managers.body || []).find((row) => row.id === managerId);
  check('the manager list carries both operations', [...(listed?.operations || [])].sort().join() === 'agriculture,mining', listed);

  const teamMember = await createAccount(adminToken, {
    username: 'zz-multi-team', name: 'ZZTEST Team Member', role: 'staff', sector: 'agriculture', managerId
  });
  check('a team member in their SECOND operation can report to them', teamMember.status === 201 && teamMember.body.managerId === managerId,
    `${teamMember.status} ${teamMember.body.message}`);
  const outsider = await createAccount(adminToken, {
    username: 'zz-multi-outsider', name: 'ZZTEST Outsider', role: 'staff', sector: 'farming', managerId
  });
  check('  but one in an operation they do not run cannot', outsider.status === 400, `${outsider.status} ${outsider.body.message}`);

  // ---- 4. changing the set ---------------------------------------------------
  section('The Director changes the operations later');
  const widened = await send(adminToken, 'PATCH', `/api/users/${managerId}/assignment`, { sectors: ['mining', 'agriculture', 'farming'] });
  check('a third operation can be added', widened.status === 200 && widened.body.operations?.length === 3, widened.body);
  const farmingNow = await raise(managerToken, 'farming');
  check('  and takes effect on their very next request', farmingNow.status === 201, `${farmingNow.status} ${farmingNow.body.message}`);

  // Open work in Farming now stands in the way of taking Farming off them.
  const strands = await send(adminToken, 'PATCH', `/api/users/${managerId}/assignment`, { sectors: ['mining', 'agriculture'] });
  check('taking an operation away while they hold open work there is refused', strands.status === 409, `${strands.status} ${strands.body.message}`);
  await pool.query('UPDATE activities SET assigned_to = NULL, approval_required_from = NULL WHERE id = $1', [farmingNow.body.id]);
  const narrowed = await send(adminToken, 'PATCH', `/api/users/${managerId}/assignment`, { sectors: ['mining', 'agriculture'] });
  check('  and allowed once that work is handed on', narrowed.status === 200 && narrowed.body.operations?.length === 2, `${narrowed.status} ${narrowed.body.message}`);
  check('  keeping the team member in an operation they still run', narrowed.body.detachedTeamMembers === 0, narrowed.body);
  const farmingAgain = await raise(managerToken, 'farming');
  check('  and the removed operation is refused at once', farmingAgain.status === 403 || farmingAgain.status === 404, String(farmingAgain.status));

  const everything = await send(adminToken, 'PATCH', `/api/users/${managerId}/assignment`, { sectors: ['all'] });
  check('they can be made an all-operations manager', everything.status === 200 && everything.body.coversAllSectors === true, everything.body);
  const rowsLeft = await pool.query('SELECT COUNT(*)::int AS n FROM manager_operations WHERE manager_id = $1', [managerId]);
  check('  which holds no per-operation rows -- the flag says "every one"', rowsLeft.rows[0].n === 0, rowsLeft.rows[0]);
  // Back to the two operations they hold open work in; dropping Mining here
  // would strand their Mining activity, which the 409 above already proves.
  const back = await send(adminToken, 'PATCH', `/api/users/${managerId}/assignment`, { sectors: ['agriculture', 'mining'] });
  check('  and brought back to their two operations', back.status === 200
    && [...(back.body.operations || [])].sort().join() === 'agriculture,mining' && back.body.coversAllSectors === false, back.body);
  check('  with the first one chosen on the row', back.body.sector === 'agriculture', back.body.sector);

  // ---- 5. three managers per operation, counting every operation -----------
  section('The three-managers limit counts a manager\'s every operation');
  // Fill Farming to its limit with managers whose operation is Farming, then try
  // to add a fourth who has Farming only as a second operation.
  const holding = await pool.query(
    `SELECT COUNT(*)::int AS n FROM users u
      WHERE u.role = 'manager' AND (u.sector = 'farming'
        OR EXISTS (SELECT 1 FROM manager_operations mo WHERE mo.manager_id = u.id AND mo.sector = 'farming'))`
  );
  const room = 3 - holding.rows[0].n;
  for (let index = 0; index < room; index += 1) {
    const filler = await createAccount(adminToken, { username: `zz-multi-fill-${index}`, name: `ZZTEST Filler ${index}`, role: 'manager', sector: 'farming' });
    if (filler.status !== 201) throw new Error(`could not fill Farming: ${filler.status} ${filler.body.message}`);
  }
  const fourth = await createAccount(adminToken, {
    username: 'zz-multi-fourth', name: 'ZZTEST Fourth', role: 'manager', sectors: ['mining', 'farming']
  });
  check('a fourth Farming manager is refused even as a second operation', fourth.status === 400, `${fourth.status} ${fourth.body.message}`);
  const halfMade = await pool.query("SELECT id FROM users WHERE username = 'zz-multi-fourth'");
  check('  and no half-made account is left behind', halfMade.rowCount === 0);
  const addFarming = await send(adminToken, 'PATCH', `/api/users/${managerId}/assignment`, { sectors: ['agriculture', 'mining', 'farming'] });
  check('  nor can an existing manager take Farming on as an extra', addFarming.status === 400, `${addFarming.status} ${addFarming.body.message}`);
  const unchanged = await api(adminToken, '/api/users');
  const still = (unchanged.body.users || []).find((row) => row.id === managerId);
  check('  and the refused change leaves their operations as they were',
    [...(still?.operations || [])].sort().join() === 'agriculture,mining', still?.operations);
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
