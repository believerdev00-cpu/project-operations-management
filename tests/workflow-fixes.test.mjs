// End-to-end check of the workflows the usability audit found broken: dead ends
// nobody on screen could get out of, and money moves that were refused or
// silently lost. Each section reproduces the original failure and proves the
// way through now works.
//
// Accounts use `zz-wf-` usernames, records `ZZTEST` names and the month 2099-10;
// everything is removed again at the end.

import bcrypt from 'bcryptjs';
import { pool } from '../server/db/database.js';
import { directorSession } from './director.mjs';
const API = process.env.API || 'http://localhost:5000';
const MONTH = '2099-10';

let passed = 0;
let failed = 0;
const created = { users: [], plans: [], activities: [], movements: [] };

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

const patch = (token, path, body) => api(token, path, { method: 'PATCH', body: JSON.stringify(body) });
const post = (token, path, body) => api(token, path, { method: 'POST', body: JSON.stringify(body || {}) });

async function seedManager(username, sector) {
  const row = await pool.query(
    `INSERT INTO users (username, password_hash, name, role, sector) VALUES ($1, $2, $3, 'manager', $4) RETURNING id`,
    [username, bcrypt.hashSync('test-pass-123', 10), `ZZ ${username}`, sector]
  );
  created.users.push(row.rows[0].id);
  const login = await post(null, '/api/auth/login', { username, password: 'test-pass-123' });
  return { id: row.rows[0].id, token: login.body.token };
}

async function uploadEvidence(token, activityId) {
  const form = new FormData();
  form.append('kind', 'Photograph');
  form.append('evidenceType', 'activity');
  form.append('files', new Blob(['ZZTEST proof'], { type: 'image/png' }), 'proof.png');
  const response = await fetch(`${API}/api/activities/${activityId}/evidence`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form
  });
  return response.status;
}

const activity = async (token, id) => (await api(token, `/api/activities/${id}`)).body.activity;

async function cleanup() {
  for (const id of created.plans) await pool.query('DELETE FROM monthly_plans WHERE id = $1', [id]);
  for (const id of created.activities) await pool.query('DELETE FROM activities WHERE id = $1', [id]);
  await pool.query("DELETE FROM activities WHERE activity LIKE 'ZZTEST %'");
  for (const id of created.movements) await pool.query('DELETE FROM movements WHERE id = $1', [id]);
  await pool.query("DELETE FROM movements WHERE purpose LIKE 'ZZTEST %'");
  for (const id of created.users) {
    await pool.query(
      `UPDATE activities SET created_by = NULL, assigned_to = NULL, approval_required_from = NULL, approved_by = NULL, reviewed_by = NULL
       WHERE created_by = $1 OR assigned_to = $1 OR approval_required_from = $1 OR approved_by = $1 OR reviewed_by = $1`, [id]);
    await pool.query('UPDATE movements SET created_by = NULL, approval_required_from = NULL, approved_by = NULL WHERE created_by = $1 OR approval_required_from = $1 OR approved_by = $1', [id]);
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
  }
}

try {
  section('setup');
  const { token: admin } = await directorSession();
  const farming = await seedManager('zz-wf-farming', 'farming');
  const logistics = await seedManager('zz-wf-movement', 'movement');
  console.log(`  farming manager #${farming.id}, movements manager #${logistics.id}`);

  // ---- a manager's own request can be spent against once approved -----------
  section('A manager\'s approved request can carry its expenses');
  const request = await post(farming.token, '/api/activities', {
    projectId: 'PRJ-GISUMA', sector: 'farming', category: 'Meetings', activity: 'ZZTEST own request',
    quantity: 1, costUsd: 100, costRwf: 145000, costCdf: 285000, id: 'ZZTEST-CHOSEN-ID'
  });
  check('the manager raises a request', request.status === 201, `${request.status} ${request.body.message}`);
  created.activities.push(request.body.id);
  check('  its id is minted by the API, not taken from the request', request.body.id !== 'ZZTEST-CHOSEN-ID', request.body.id);
  check('  it is carried by the manager who raised it', request.body.assignedTo === farming.id, String(request.body.assignedTo));
  const approved = await patch(admin, `/api/activities/${request.body.id}/approval`, { action: 'approve' });
  check('the Director approves it', approved.status === 200, `${approved.status} ${approved.body.message}`);
  const spend = await post(farming.token, `/api/activities/${request.body.id}/expenses`, {
    amount: 40, spentOn: '2026-01-10', paymentMethod: 'Cash', description: 'ZZTEST venue'
  });
  check('  the manager records an expense against it', spend.status === 201, `${spend.status} ${spend.body.message}`);

  // The home screen's "Your work" tile and the list it opens use one rule.
  const workList = await api(farming.token, '/api/activities?awaiting=work&limit=50');
  const workCount = (await api(farming.token, '/api/summary')).body.summary.myOpenWork;
  check('  it is in the manager\'s "Your work" list', workList.body.some((item) => item.id === request.body.id));
  check('  and the home count matches that list', workCount === workList.body.length, `${workCount} vs ${workList.body.length}`);
  const deleteWithMoney = await api(admin, `/api/activities/${request.body.id}`, { method: 'DELETE' });
  check('an activity with expenses cannot be deleted', deleteWithMoney.status === 409, `${deleteWithMoney.status} ${deleteWithMoney.body.message}`);

  // ---- reopened work can be handed back again ---------------------------------
  section('Reopened work can be handed back again');
  check('  evidence is attached', await uploadEvidence(farming.token, request.body.id) === 201);
  const handBack = await post(farming.token, `/api/activities/${request.body.id}/completion`, { note: 'Done.' });
  check('the manager hands the work back', handBack.status === 200, `${handBack.status} ${handBack.body.message}`);
  const afterHandBack = await api(farming.token, '/api/activities?awaiting=work&limit=50');
  check('  it leaves "Your work"', !afterHandBack.body.some((item) => item.id === request.body.id));
  const checks = await api(admin, '/api/activities?awaiting=final-check&limit=50');
  const checkCount = (await api(admin, '/api/summary')).body.summary.finalChecksWaiting;
  check('  it is waiting for the Director\'s final check', checks.body.some((item) => item.id === request.body.id));
  check('  and the Director\'s home count matches that list', checkCount === checks.body.length, `${checkCount} vs ${checks.body.length}`);
  const twice = await post(farming.token, `/api/activities/${request.body.id}/completion`, {});
  check('  it cannot be handed back twice', twice.status === 409, String(twice.status));
  const completed = await patch(admin, `/api/activities/${request.body.id}/decision`, { status: 'Completed' });
  check('the Director completes it', completed.status === 200, `${completed.status} ${completed.body.message}`);
  const reopened = await patch(admin, `/api/activities/${request.body.id}/decision`, { status: 'In Progress', adminNote: 'One more visit.' });
  check('the Director reopens it', reopened.status === 200, `${reopened.status} ${reopened.body.message}`);
  const afterReopen = await activity(farming.token, request.body.id);
  check('  the earlier hand-back is cleared', afterReopen.completionSubmittedAt === null, String(afterReopen.completionSubmittedAt));
  const handBackAgain = await post(farming.token, `/api/activities/${request.body.id}/completion`, { note: 'Done again.' });
  check('  and the manager can hand it back again', handBackAgain.status === 200, `${handBackAgain.status} ${handBackAgain.body.message}`);

  // ---- no reopening into a draft nobody can send ------------------------------
  section('Refused work reopens to a decision, not a dead-end draft');
  const refusable = await post(farming.token, '/api/activities', {
    projectId: 'PRJ-GISUMA', sector: 'farming', category: 'Meetings', activity: 'ZZTEST refused request',
    quantity: 1, costUsd: 10, costRwf: 14500, costCdf: 28500
  });
  check('the manager raises a second request', refusable.status === 201, `${refusable.status} ${refusable.body.message}`);
  created.activities.push(refusable.body.id);
  await patch(admin, `/api/activities/${refusable.body.id}/approval`, { action: 'reject', rejectionReason: 'Not now.' });
  const toDraft = await patch(admin, `/api/activities/${refusable.body.id}/decision`, { status: 'Draft' });
  check('a rejected request cannot be moved to Draft', toDraft.status === 400, String(toDraft.status));
  const reconsider = await patch(admin, `/api/activities/${refusable.body.id}/decision`, { status: 'Pending Approval' });
  check('  it can be reopened for a decision', reconsider.status === 200, `${reconsider.status} ${reconsider.body.message}`);
  const managerQueue = (await api(admin, '/api/approval-queue')).body;
  check('  and it is back in the Director\'s queue', managerQueue.activities.some((item) => item.id === refusable.body.id));

  // ---- planned work: month confirmation, refusal and deletion -----------------
  section('Planned work follows its month');
  const plan = await post(admin, '/api/monthly-plans', { operation: 'farming', month: MONTH, managerId: farming.id });
  check('the Director creates a plan', plan.status === 201, `${plan.status} ${plan.body.message}`);
  created.plans.push(plan.body.id);
  const withActivity = await post(admin, `/api/monthly-plans/${plan.body.id}/activities`, {
    activity: 'ZZTEST planned work', category: 'Planned work', approvedBudget: 300, priority: 'High'
  });
  check('  a planned activity is added', withActivity.status === 201, `${withActivity.status} ${withActivity.body.message}`);
  await post(admin, `/api/monthly-plans/${plan.body.id}/activities`, {
    activity: 'ZZTEST planned extra', category: 'Planned work', approvedBudget: 200, priority: 'Low'
  });
  const planActivities = (await api(admin, `/api/monthly-plans/${plan.body.id}`)).body.activities || [];
  const planned = planActivities.find((item) => item.activity === 'ZZTEST planned work');
  const extra = planActivities.find((item) => item.activity === 'ZZTEST planned extra');

  const earlyStart = await patch(farming.token, `/api/activities/${planned.id}/status`, { status: 'In Progress' });
  check('work in an unconfirmed month cannot be started', earlyStart.status === 409, `${earlyStart.status} ${earlyStart.body.message}`);

  const confirmed = await post(admin, `/api/monthly-plans/${plan.body.id}/confirm`);
  check('the Director confirms the month', confirmed.status === 200, `${confirmed.status} ${confirmed.body.message}`);
  const allocation = Number(confirmed.body.approvedBudget);
  const start = await patch(farming.token, `/api/activities/${planned.id}/status`, { status: 'In Progress' });
  check('  now the manager can start it', start.status === 200, `${start.status} ${start.body.message}`);

  const removed = await api(admin, `/api/activities/${extra.id}`, { method: 'DELETE' });
  check('deleting a planned activity in a confirmed month works', removed.status === 200, `${removed.status} ${removed.body.message}`);
  const afterDelete = (await api(admin, `/api/monthly-plans/${plan.body.id}`)).body;
  check('  and gives its budget back to the month', Number(afterDelete.plan?.approvedBudget) === allocation - 200,
    `${allocation} -> ${afterDelete.plan?.approvedBudget}`);
  check('  which the month\'s history records', afterDelete.history.some((entry) => /Activity deleted/.test(entry.note || '')));

  const refusePlanned = await patch(admin, `/api/activities/${planned.id}/decision`, { status: 'Rejected', adminNote: 'Dropped.' });
  check('the Director can refuse planned work', refusePlanned.status === 200, `${refusePlanned.status} ${refusePlanned.body.message}`);
  const plannedToPending = await patch(admin, `/api/activities/${planned.id}/decision`, { status: 'Pending Approval' });
  check('  it is not sent for an approval nobody could give', plannedToPending.status === 400, String(plannedToPending.status));
  const plannedBack = await patch(admin, `/api/activities/${planned.id}/decision`, { status: 'Approved', adminNote: 'Back on.' });
  check('  it reopens as Approved instead', plannedBack.status === 200 && plannedBack.body.status === 'Approved',
    `${plannedBack.status} ${plannedBack.body.message || plannedBack.body.status}`);

  const report = await post(farming.token, `/api/monthly-plans/${plan.body.id}/report`, {
    budgetDifferenceExplanation: 'ZZTEST the work was dropped and restarted.'
  });
  check('a month-end explanation in either box is accepted', report.status === 200 || report.status === 201,
    `${report.status} ${report.body.message}`);

  // ---- movements -----------------------------------------------------------------
  section('Movements: the person who raised one is never stuck');
  const trip = await post(logistics.token, '/api/movements', {
    purpose: 'ZZTEST supply trip', origin: 'Kigali', destination: 'Musanze', currency: 'RWF',
    costs: { transport: 1000, fuel: 0, accommodation: 0, meals: 0, handling: 0, other: 0 }, status: 'Pending Approval'
  });
  check('the movements manager raises a trip', trip.status === 201, `${trip.status} ${trip.body.message}`);
  created.movements.push(trip.body.id);
  const withdraw = await patch(logistics.token, `/api/movements/${trip.body.id}/status`, { status: 'Draft' });
  check('  they can take it back to correct it', withdraw.status === 200, `${withdraw.status} ${withdraw.body.message}`);
  const figuresOnDraft = await patch(admin, `/api/movements/${trip.body.id}/finance`, { fundsReleased: 500 });
  check('money cannot be recorded on a draft', figuresOnDraft.status === 409, String(figuresOnDraft.status));
  const resend = await patch(logistics.token, `/api/movements/${trip.body.id}/status`, { status: 'Pending Approval' });
  check('  they send it again', resend.status === 200, String(resend.status));
  await patch(admin, `/api/movements/${trip.body.id}/approval`, { action: 'reject', rejectionReason: 'Too early.' });
  const reopenRefused = await patch(logistics.token, `/api/movements/${trip.body.id}/status`, { status: 'Draft' });
  check('  a refused trip can be reopened as a draft by its author', reopenRefused.status === 200, `${reopenRefused.status} ${reopenRefused.body.message}`);
  check('  and the old refusal is cleared', reopenRefused.body.rejectionReason === '', reopenRefused.body.rejectionReason);

  const funded = await post(logistics.token, '/api/movements', {
    purpose: 'ZZTEST funded trip', origin: 'Kigali', destination: 'Huye', currency: 'RWF',
    costs: { transport: 2000, fuel: 0, accommodation: 0, meals: 0, handling: 0, other: 0 }, status: 'Pending Approval'
  });
  created.movements.push(funded.body.id);
  await patch(admin, `/api/movements/${funded.body.id}/approval`, { action: 'approve' });
  const figures = await patch(admin, `/api/movements/${funded.body.id}/finance`, { fundsReleased: 2000 });
  check('money can be recorded on an approved trip', figures.status === 200, `${figures.status} ${figures.body.message}`);
  const deleteFunded = await api(admin, `/api/movements/${funded.body.id}`, { method: 'DELETE' });
  check('  a trip with money released cannot be deleted', deleteFunded.status === 409, String(deleteFunded.status));
  const deleteDraft = await api(admin, `/api/movements/${trip.body.id}`, { method: 'DELETE' });
  check('  a draft trip can', deleteDraft.status === 200, `${deleteDraft.status} ${deleteDraft.body.message}`);
} catch (error) {
  failed += 1;
  console.error('\nUNCAUGHT:', error.message, '\n', error.stack);
} finally {
  section('cleanup');
  await cleanup();
  console.log(`  removed ${created.activities.length} activities, ${created.movements.length} movements, ${created.plans.length} plans, ${created.users.length} accounts`);
  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
}
