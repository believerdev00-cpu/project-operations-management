// End-to-end check of account safety against the running API: passwords the
// Director sets are temporary, owners choose and change their own, internal
// accounts can be suspended, team members raise no requests, and evidence links
// never carry the session token.
//
// Accounts are created through the Director's own endpoint with `zz-sec-`
// usernames and deleted again at the end.

import jwt from 'jsonwebtoken';
import { pool } from '../server/db/database.js';
import { directorSession } from './director.mjs';
const API = process.env.API || 'http://localhost:5000';

let passed = 0;
let failed = 0;
const created = { users: [], movements: [] };

const check = (label, condition, detail = '') => {
  if (condition) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`); }
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

const login = (username, password) => api(null, '/api/auth/login', {
  method: 'POST', body: JSON.stringify({ username, password })
});

const changePassword = (token, currentPassword, newPassword) => api(token, '/api/auth/password', {
  method: 'POST', body: JSON.stringify({ currentPassword, newPassword })
});

async function createAccount(adminToken, account) {
  const result = await api(adminToken, '/api/users', { method: 'POST', body: JSON.stringify(account) });
  if (result.status === 201) created.users.push(result.body.id);
  return result;
}

try {
  section('setup');
  const { token: adminToken, id: directorId } = await directorSession();
  console.log(`  director #${directorId}`);

  // ---- temporary passwords -------------------------------------------------
  section('A password the Director sets is temporary');
  const tooShort = await createAccount(adminToken, {
    username: 'zz-sec-short', name: 'Short Password', password: 'abc1234', role: 'manager', sector: 'farming'
  });
  check('a password under 8 characters is refused', tooShort.status === 400, `${tooShort.status} ${tooShort.body.message}`);
  const sameAsUsername = await createAccount(adminToken, {
    username: 'zz-sec-sameuser', name: 'Same', password: 'zz-sec-sameuser', role: 'manager', sector: 'farming'
  });
  check('a password equal to the username is refused', sameAsUsername.status === 400, `${sameAsUsername.status}`);

  const manager = await createAccount(adminToken, {
    username: 'zz-sec-manager', name: 'Security Test Manager', password: 'temporary-123', role: 'manager', sector: 'farming'
  });
  check('the Director creates a manager', manager.status === 201, `${manager.status} ${manager.body.message}`);
  check('  the account is marked to choose its own password', manager.body.mustChangePassword === true);

  const firstLogin = await login('zz-sec-manager', 'temporary-123');
  check('the manager can sign in with the temporary password', firstLogin.status === 200, String(firstLogin.status));
  check('  and is told to choose their own', firstLogin.body.user?.mustChangePassword === true);
  const firstToken = firstLogin.body.token;
  check('  the token carries only the account id', Object.keys(jwt.decode(firstToken)).sort().join(',') === 'exp,iat,id',
    Object.keys(jwt.decode(firstToken) || {}).join(','));

  const blocked = await api(firstToken, '/api/summary');
  check('  everything else is refused until they do', blocked.status === 403 && blocked.body.code === 'PASSWORD_CHANGE_REQUIRED',
    `${blocked.status} ${blocked.body.code}`);
  const session = await api(firstToken, '/api/auth/session');
  check('  the session check still answers', session.status === 200 && session.body.user?.mustChangePassword === true);

  // ---- choosing your own ----------------------------------------------------
  section('The owner chooses their own password');
  const wrongCurrent = await changePassword(firstToken, 'not-the-password', 'my-own-password-1');
  check('a wrong current password is refused', wrongCurrent.status === 400 && wrongCurrent.body.code === 'CURRENT_PASSWORD_WRONG',
    `${wrongCurrent.status} ${wrongCurrent.body.code}`);
  const weak = await changePassword(firstToken, 'temporary-123', 'short');
  check('a weak new password is refused', weak.status === 400 && weak.body.code === 'PASSWORD_WEAK', `${weak.status} ${weak.body.code}`);
  const same = await changePassword(firstToken, 'temporary-123', 'temporary-123');
  check('the same password again is refused', same.status === 400 && same.body.code === 'PASSWORD_SAME', `${same.status} ${same.body.code}`);

  const chosen = await changePassword(firstToken, 'temporary-123', 'my-own-password-1');
  check('a good new password is accepted', chosen.status === 200 && Boolean(chosen.body.token), `${chosen.status} ${chosen.body.message}`);
  check('  the flag is cleared', chosen.body.user?.mustChangePassword === false);
  const afterChange = await api(chosen.body.token, '/api/summary');
  check('  the new session works straight away', afterChange.status === 200, String(afterChange.status));
  const oldSession = await api(firstToken, '/api/auth/session');
  check('  the session from before the change is ended', oldSession.status === 401 && oldSession.body.code === 'PASSWORD_CHANGED',
    `${oldSession.status} ${oldSession.body.code}`);
  const oldPassword = await login('zz-sec-manager', 'temporary-123');
  check('  the temporary password no longer signs in', oldPassword.status === 401, String(oldPassword.status));
  const ownPassword = await login('zz-sec-manager', 'my-own-password-1');
  check('  their own password signs in, with nothing more to do', ownPassword.status === 200 && ownPassword.body.user?.mustChangePassword === false);
  let managerToken = ownPassword.body.token;

  const reset = await api(adminToken, `/api/users/${manager.body.id}/password`, {
    method: 'PATCH', body: JSON.stringify({ password: 'reset-by-director-9' })
  });
  check('a Director reset makes the password temporary again', reset.status === 200 && reset.body.mustChangePassword === true,
    `${reset.status} ${reset.body.mustChangePassword}`);
  const afterReset = await login('zz-sec-manager', 'reset-by-director-9');
  check('  and the owner is asked to choose again', afterReset.body.user?.mustChangePassword === true);
  const reChosen = await changePassword(afterReset.body.token, 'reset-by-director-9', 'my-own-password-2');
  managerToken = reChosen.body.token;

  // ---- suspending ------------------------------------------------------------
  section('The Director can suspend and reactivate an internal account');
  const managerTries = await api(managerToken, `/api/users/${manager.body.id}/status`, {
    method: 'PATCH', body: JSON.stringify({ status: 'suspended' })
  });
  check('a manager cannot suspend accounts', managerTries.status === 403, String(managerTries.status));
  const selfSuspend = await api(adminToken, `/api/users/${directorId}/status`, {
    method: 'PATCH', body: JSON.stringify({ status: 'suspended' })
  });
  check('the Director cannot suspend their own account', selfSuspend.status === 400, String(selfSuspend.status));

  const suspended = await api(adminToken, `/api/users/${manager.body.id}/status`, {
    method: 'PATCH', body: JSON.stringify({ status: 'suspended' })
  });
  check('the Director suspends the manager', suspended.status === 200 && suspended.body.status === 'suspended',
    `${suspended.status} ${suspended.body.message}`);
  check('  the work they still hold is reported back', typeof suspended.body.heldWork?.approvals === 'number');
  const cutOff = await api(managerToken, '/api/summary');
  check('  their open session stops at once', cutOff.status === 403 && cutOff.body.code === 'ACCOUNT_INACTIVE',
    `${cutOff.status} ${cutOff.body.code}`);
  const suspendedLogin = await login('zz-sec-manager', 'my-own-password-2');
  check('  and they cannot sign in', suspendedLogin.status === 403 && suspendedLogin.body.code === 'ACCOUNT_INACTIVE',
    `${suspendedLogin.status} ${suspendedLogin.body.code}`);

  const restored = await api(adminToken, `/api/users/${manager.body.id}/status`, {
    method: 'PATCH', body: JSON.stringify({ status: 'active' })
  });
  check('the Director reactivates the manager', restored.status === 200 && restored.body.status === 'active', String(restored.status));
  const backIn = await login('zz-sec-manager', 'my-own-password-2');
  check('  who can sign in again', backIn.status === 200, String(backIn.status));

  // ---- team members raise nothing -------------------------------------------
  section('A team member raises no requests');
  const staff = await createAccount(adminToken, {
    username: 'zz-sec-staff', name: 'Security Test Staff', password: 'temporary-123', role: 'staff', sector: 'movement'
  });
  check('the Director creates a team member in Movements', staff.status === 201, `${staff.status} ${staff.body.message}`);
  const staffLogin = await login('zz-sec-staff', 'temporary-123');
  const staffToken = (await changePassword(staffLogin.body.token, 'temporary-123', 'staff-own-password')).body.token;

  const project = await pool.query("SELECT id FROM projects WHERE sector = 'movement' ORDER BY created_at DESC LIMIT 1");
  const staffActivity = await api(staffToken, '/api/activities', {
    method: 'POST',
    body: JSON.stringify({
      projectId: project.rows[0]?.id || 'none', sector: 'movement', category: 'Other', activity: 'ZZTEST staff request',
      quantity: 1, costUsd: 10
    })
  });
  check('a team member cannot add an activity', staffActivity.status === 403, `${staffActivity.status} ${staffActivity.body.message}`);
  const staffMovement = await api(staffToken, '/api/movements', {
    method: 'POST', body: JSON.stringify({ purpose: 'ZZTEST staff trip', origin: 'Kigali', destination: 'Goma' })
  });
  check('a team member cannot create a movement', staffMovement.status === 403, `${staffMovement.status} ${staffMovement.body.message}`);
  const staffReads = await api(staffToken, '/api/activities?limit=5');
  check('a team member can still follow their operation\'s work', staffReads.status === 200, String(staffReads.status));

  // A period report reads a whole business operation: every activity, what each
  // was given, what each spent, who ran it. Sector scoping answered "whose
  // data?" and was mistaken for an answer to "who may ask?", so a team member
  // could pull it -- and export it to Excel or PDF.
  const staffReport = await api(staffToken, '/api/reports/activities?period=monthly');
  check('a team member cannot run a report on their operation', staffReport.status === 403,
    `${staffReport.status} ${staffReport.body.message}`);
  const staffExport = await fetch(`${API}/api/reports/activities/export?period=monthly&format=xlsx`, {
    headers: { Authorization: `Bearer ${staffToken}` }
  });
  check('  nor export one', staffExport.status === 403, String(staffExport.status));
  const managerReport = await api(backIn.body.token, '/api/reports/activities?period=monthly');
  check('  but a manager still can', managerReport.status === 200, String(managerReport.status));

  // Running the movements operation is what earns the organisation-wide view of
  // it, and that is a job, not a location. This account is filed under
  // 'movement' and is a team member, so it sees its own area's trips like
  // anybody else -- not every trip in the organisation.
  const farmingTrip = await api(adminToken, '/api/movements', {
    method: 'POST',
    body: JSON.stringify({
      purpose: 'ZZTEST trip for another area', origin: 'Kigali', destination: 'Rubavu',
      relatedArea: 'farming', estimatedTotal: 50, currency: 'USD'
    })
  });
  if (farmingTrip.status === 201) created.movements.push(farmingTrip.body.id);
  const staffTrips = await api(staffToken, '/api/movements?limit=100');
  check('a team member in Movements does not see another area\'s trips',
    farmingTrip.status === 201 && Array.isArray(staffTrips.body)
      && !staffTrips.body.some((trip) => trip.id === farmingTrip.body.id),
    `${farmingTrip.status} / ${staffTrips.status}`);

  // ---- evidence links --------------------------------------------------------
  section('Evidence links never carry the session token');
  const filePath = '/api/activities/ACT-NOT-REAL/evidence/999999/file';
  const sessionInQuery = await api(null, `${filePath}?token=${encodeURIComponent(adminToken)}`);
  check('a session token in the link is refused', sessionInQuery.status === 401, String(sessionInQuery.status));

  const notAFile = await api(adminToken, '/api/auth/file-link', { method: 'POST', body: JSON.stringify({ path: '/api/users' }) });
  check('a file link is only issued for an evidence file', notAFile.status === 400, String(notAFile.status));

  const link = await api(adminToken, '/api/auth/file-link', { method: 'POST', body: JSON.stringify({ path: filePath }) });
  check('a file link is issued for an evidence file', link.status === 200 && link.body.url?.startsWith(`${filePath}?token=`), String(link.status));
  const fileToken = new URL(link.body.url, API).searchParams.get('token');
  check('  it expires within minutes', jwt.decode(fileToken).exp - jwt.decode(fileToken).iat <= 300);
  const opened = await api(null, link.body.url);
  check('  it gets past sign-in to the file route itself', opened.status === 404, `${opened.status} ${opened.body.message}`);
  const otherFile = await api(null, `/api/activities/ACT-OTHER/evidence/1/file?token=${encodeURIComponent(fileToken)}`);
  check('  it does not open a different file', otherFile.status === 401, String(otherFile.status));
  const asBearer = await api(fileToken, '/api/summary');
  check('  it is refused as a session anywhere else', asBearer.status === 401, String(asBearer.status));

  // ---- a manager sees their own project and no other ------------------------
  //
  // Scoping is by business operation, which is the same thing as "their project"
  // only while an operation has exactly one. Open a second project in the same
  // operation and, without this, every manager in it reads the other one's work,
  // budgets and spending. Responsibility is per project, so the filter is too.
  section('A project manager is confined to their own project');
  const mine = await createAccount(adminToken, {
    username: 'zz-sec-own', name: 'Own Project Manager', password: 'temporary-123', role: 'manager', sector: 'mining'
  });
  created.users.push(mine.body.id);
  const mineToken = (await changePassword(
    (await login('zz-sec-own', 'temporary-123')).body.token, 'temporary-123', 'own-project-pass-1'
  )).body.token;

  await pool.query(
    `INSERT INTO projects (id, name, sector, location, owner, status, progress, budget, spent, category, manager_id)
     VALUES ('ZZSEC-P1', 'ZZTEST Mine Project', 'mining', 'A', 'ZZTEST', 'On Track', 0, 0, 0, 'Other', $1),
            ('ZZSEC-P2', 'ZZTEST Not Mine Project', 'mining', 'B', 'ZZTEST', 'On Track', 0, 0, 0, 'Other', NULL)
     ON CONFLICT (id) DO NOTHING`,
    [mine.body.id]
  );
  await pool.query(
    `INSERT INTO activities (id, project_id, sector, category, activity, description, quantity,
       cost_usd, cost_rwf, cost_cdf, requested_budget, approved_budget, status, approved, created_by,
       approval_required, approval_status)
     VALUES ('ZZSEC-A2', 'ZZSEC-P2', 'mining', 'Extraction', 'ZZTEST other project work',
       'On a project this manager does not run.', 1, 50, 72500, 142500, 50, 50, 'Approved', TRUE, $1, FALSE, 'approved')`,
    [directorId]
  );

  const visibleProjects = await api(mineToken, '/api/projects');
  const projectIds = (visibleProjects.body.items || visibleProjects.body || []).map((project) => project.id);
  check('they see the project they are responsible for', projectIds.includes('ZZSEC-P1'), projectIds.join(','));
  check('  and not another project in the same operation', !projectIds.includes('ZZSEC-P2'), projectIds.join(','));
  const otherWork = await api(mineToken, '/api/activities?limit=100');
  check('  nor its work in their register',
    !(otherWork.body || []).some((item) => item.id === 'ZZSEC-A2'), String(otherWork.status));
  const openOther = await api(mineToken, '/api/activities/ZZSEC-A2');
  check('  nor by opening it directly', openOther.status === 404, String(openOther.status));
  const theirReport = await api(mineToken, '/api/reports/activities?period=monthly');
  check('  nor in their report', !JSON.stringify(theirReport.body).includes('ZZSEC-A2'), String(theirReport.status));
  const directorSees = await api(adminToken, '/api/activities/ZZSEC-A2');
  check('  while the Director still reads it', directorSees.status === 200, String(directorSees.status));

  // A manager responsible for no project keeps the whole operation, or somebody
  // covering an operation in general would be shown nothing at all.
  const general = await createAccount(adminToken, {
    username: 'zz-sec-general', name: 'General Manager', password: 'temporary-123', role: 'manager', sector: 'mining'
  });
  created.users.push(general.body.id);
  const generalToken = (await changePassword(
    (await login('zz-sec-general', 'temporary-123')).body.token, 'temporary-123', 'general-pass-12'
  )).body.token;
  const generalWork = await api(generalToken, '/api/activities/ZZSEC-A2');
  check('a manager who runs no project still sees their whole operation',
    generalWork.status === 200, String(generalWork.status));

  const unsigned = jwt.sign({ id: directorId }, '', { algorithm: 'none' });
  const noneAlg = await api(unsigned, '/api/summary');
  check('an unsigned token is refused', noneAlg.status === 401, String(noneAlg.status));
} catch (error) {
  failed += 1;
  console.error('\nUNCAUGHT:', error.message, '\n', error.stack);
} finally {
  section('cleanup');
  await pool.query("DELETE FROM activities WHERE project_id LIKE 'ZZSEC-%' OR id LIKE 'ZZSEC-%'");
  await pool.query("DELETE FROM projects WHERE id LIKE 'ZZSEC-%'");
  for (const id of created.movements) await pool.query('DELETE FROM movements WHERE id = $1', [id]);
  await pool.query("DELETE FROM movements WHERE purpose LIKE 'ZZTEST %'");
  for (const id of created.users) await pool.query('DELETE FROM users WHERE id = $1', [id]);
  await pool.query("DELETE FROM users WHERE username LIKE 'zz-sec-%'");
  console.log(`  removed ${created.users.length} accounts`);
  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
}
