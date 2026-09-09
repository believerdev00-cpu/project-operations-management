// End-to-end check of the approval workflow against the running API.
//
// Seeds two throwaway manager accounts directly in the database (there is no
// account-delete endpoint), drives every scenario over HTTP exactly as the
// browser would, then removes everything it created.

import bcrypt from 'bcryptjs';
import { pool } from '../server/db/database.js';
const API = process.env.API || 'http://localhost:5000';

let passed = 0;
let failed = 0;
const created = { users: [], activities: [], movements: [] };

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

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

async function login(username, password) {
  const { status, body } = await api(null, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
  if (status !== 200) throw new Error(`login ${username} failed: ${status} ${body.message}`);
  return body.token;
}

async function seedManager(username, name, sector) {
  const hash = bcrypt.hashSync('test-pass-123', 10);
  const result = await pool.query(
    `INSERT INTO users (username, password_hash, name, role, sector)
     VALUES ($1, $2, $3, 'manager', $4) RETURNING id`,
    [username, hash, name, sector]
  );
  created.users.push(result.rows[0].id);
  return result.rows[0].id;
}

async function cleanup() {
  for (const id of created.activities) {
    await pool.query('DELETE FROM activities WHERE id = $1', [id]);
  }
  for (const id of created.movements) {
    await pool.query('DELETE FROM movements WHERE id = $1', [id]);
  }
  for (const id of created.users) {
    await pool.query('UPDATE activities SET created_by = NULL, assigned_to = NULL, approval_required_from = NULL, approved_by = NULL, reviewed_by = NULL WHERE created_by = $1 OR assigned_to = $1 OR approval_required_from = $1 OR approved_by = $1 OR reviewed_by = $1', [id]);
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
  }
}

// A fresh activity payload. costRwf/costCdf mirror what the browser computes.
function activityPayload(overrides = {}) {
  const usd = overrides.costUsd ?? 100;
  return {
    projectId: 'PRJ-GISUMA',
    sector: 'farming',
    category: 'Meetings',
    activity: 'TEST Farming meeting',
    description: 'Automated approval-workflow test record.',
    quantity: 1,
    costUsd: usd,
    costRwf: usd * 1450,
    costCdf: usd * 2850,
    ...overrides
  };
}

try {
  section('setup');
  const farmingManagerId = await seedManager('zz-test-farming', 'Test Farming Manager', 'farming');
  const agriManagerId = await seedManager('zz-test-agri', 'Test Agriculture Manager', 'agriculture');
  const adminToken = await login('admin', process.env.ADMIN_PASSWORD || 'admin123');
  const farmingToken = await login('zz-test-farming', 'test-pass-123');
  const agriToken = await login('zz-test-agri', 'test-pass-123');
  const directorId = (await pool.query("SELECT id FROM users WHERE role = 'super-admin' ORDER BY id LIMIT 1")).rows[0].id;
  console.log(`  seeded farming manager #${farmingManagerId}, agriculture manager #${agriManagerId}, director #${directorId}`);

  const baselineFarming = (await api(farmingToken, '/api/summary')).body.summary.approvalsAwaitingMe;
  const baselineDirector = (await api(adminToken, '/api/summary')).body.summary.approvalsAwaitingMe;
  console.log(`  baseline badges -- farming manager: ${baselineFarming}, director: ${baselineDirector}`);

  // ---- 3. Admin -> Manager -------------------------------------------------
  section('3. Admin assigns to a Manager');
  const created1 = await api(adminToken, '/api/activities', {
    method: 'POST',
    body: JSON.stringify(activityPayload({ assignedTo: farmingManagerId, instructions: 'Chair the monthly meeting.' }))
  });
  check('admin can create an assigned activity', created1.status === 201, JSON.stringify(created1.body).slice(0, 200));
  const act1 = created1.body;
  created.activities.push(act1.id);
  check("status is 'Pending Approval'", act1.status === 'Pending Approval', act1.status);
  check("approval_status is 'pending'", act1.approvalStatus === 'pending', act1.approvalStatus);
  check('approval_required_from is the assigned manager', act1.approvalRequiredFrom === farmingManagerId, String(act1.approvalRequiredFrom));
  check("approval_required_role is 'manager'", act1.approvalRequiredRole === 'manager', act1.approvalRequiredRole);
  check('created_by is the admin', act1.createdBy === directorId, String(act1.createdBy));
  check('assigned_to is the manager', act1.assignedTo === farmingManagerId, String(act1.assignedTo));
  check('department is carried', act1.department === 'farming', act1.department);
  check('approved_by is not set yet', act1.approvedBy === null, String(act1.approvedBy));

  // ---- 5. the queue is built from the current user -------------------------
  section('5. "What I Need to Approve" is filtered by the signed-in user');
  const farmingQueue = (await api(farmingToken, '/api/approval-queue')).body;
  check('the assigned manager sees it in their queue',
    farmingQueue.activities.some((item) => item.id === act1.id));
  const agriQueue = (await api(agriToken, '/api/approval-queue')).body;
  check('a different manager does NOT see it',
    !agriQueue.activities.some((item) => item.id === act1.id));
  const directorQueue = (await api(adminToken, '/api/approval-queue')).body;
  check('the Director does NOT see a manager-required record',
    !directorQueue.activities.some((item) => item.id === act1.id));
  check('every row in the queue names its approver',
    farmingQueue.activities.every((item) => item.approvalRequiredFrom !== null || item.approvalRequiredRole !== null));
  check('every row in the queue is pending',
    farmingQueue.activities.every((item) => item.approvalStatus === 'pending'));

  // ---- 9. security ---------------------------------------------------------
  section('9. Only the named approver may decide');
  const stolen = await api(agriToken, `/api/activities/${act1.id}/approval`, {
    method: 'PATCH', body: JSON.stringify({ action: 'approve' })
  });
  check('another manager cannot approve it (403/404)', [403, 404].includes(stolen.status),
    `${stolen.status} ${stolen.body.message}`);
  const directorSteal = await api(adminToken, `/api/activities/${act1.id}/approval`, {
    method: 'PATCH', body: JSON.stringify({ action: 'approve' })
  });
  check('even the Director cannot approve what names a manager', directorSteal.status === 403,
    `${directorSteal.status} ${directorSteal.body.message}`);
  const stillPending = (await api(adminToken, `/api/activities/${act1.id}`)).body.activity;
  check('the record is untouched after the refused attempts', stillPending.approvalStatus === 'pending');

  // ---- 3 (cont). the manager approves --------------------------------------
  section('3. The Manager approves');
  const approved1 = await api(farmingToken, `/api/activities/${act1.id}/approval`, {
    method: 'PATCH', body: JSON.stringify({ action: 'approve', adminNote: 'Happy to run this.' })
  });
  check('the named manager can approve', approved1.status === 200, JSON.stringify(approved1.body).slice(0, 200));
  const act1b = approved1.body;
  check("approval_status is 'approved'", act1b.approvalStatus === 'approved', act1b.approvalStatus);
  check("status is 'Approved'", act1b.status === 'Approved', act1b.status);
  check('approved_by is the manager', act1b.approvedBy === farmingManagerId, String(act1b.approvedBy));
  check('approved_at is stamped', Boolean(act1b.approvedAt), String(act1b.approvedAt));

  // ---- 8. it leaves the queue ---------------------------------------------
  section('8. Approved records leave the queue');
  const farmingQueue2 = (await api(farmingToken, '/api/approval-queue')).body;
  check('the approved record has left the queue',
    !farmingQueue2.activities.some((item) => item.id === act1.id));
  const farmingBadge2 = (await api(farmingToken, '/api/summary')).body.summary.approvalsAwaitingMe;
  check('the badge count matches the queue length',
    farmingBadge2 === farmingQueue2.activities.length + farmingQueue2.movements.length,
    `badge ${farmingBadge2} vs queue ${farmingQueue2.activities.length + farmingQueue2.movements.length}`);

  // then the work can start
  const started = await api(farmingToken, `/api/activities/${act1.id}/status`, {
    method: 'PATCH', body: JSON.stringify({ status: 'In Progress' })
  });
  check('an approved activity can move to In Progress', started.status === 200 && started.body.status === 'In Progress',
    `${started.status} ${started.body.status || started.body.message}`);

  // ---- 4. Manager -> Director ---------------------------------------------
  section('4. Manager raises work needing Director approval');
  const created2 = await api(farmingToken, '/api/activities', {
    method: 'POST',
    body: JSON.stringify(activityPayload({ activity: 'TEST Buy farming tools', category: 'Tools', costUsd: 100 }))
  });
  check('a manager can raise an activity', created2.status === 201, JSON.stringify(created2.body).slice(0, 200));
  const act2 = created2.body;
  created.activities.push(act2.id);
  check("status is 'Pending Approval'", act2.status === 'Pending Approval', act2.status);
  check("approval_status is 'pending'", act2.approvalStatus === 'pending', act2.approvalStatus);
  check("approval_required_role is 'director'", act2.approvalRequiredRole === 'director', act2.approvalRequiredRole);
  check('approval_required_from is the Director', act2.approvalRequiredFrom === directorId, String(act2.approvalRequiredFrom));
  check('requested budget is $100', act2.requestedBudget === 100, String(act2.requestedBudget));

  const directorQueue2 = (await api(adminToken, '/api/approval-queue')).body;
  check('the Director sees it in their queue',
    directorQueue2.activities.some((item) => item.id === act2.id));
  const agriQueue2 = (await api(agriToken, '/api/approval-queue')).body;
  check('an unrelated manager does not see it',
    !agriQueue2.activities.some((item) => item.id === act2.id));
  const raiserQueue = (await api(farmingToken, '/api/approval-queue')).body;
  check('the manager who raised it does not see it in their own queue',
    !raiserQueue.activities.some((item) => item.id === act2.id));

  const managerSelfApprove = await api(farmingToken, `/api/activities/${act2.id}/approval`, {
    method: 'PATCH', body: JSON.stringify({ action: 'approve' })
  });
  check('a manager cannot approve their own director-bound request', managerSelfApprove.status === 403,
    `${managerSelfApprove.status} ${managerSelfApprove.body.message}`);

  // budget change without a note is refused
  const noNote = await api(adminToken, `/api/activities/${act2.id}/approval`, {
    method: 'PATCH', body: JSON.stringify({ action: 'approve', approvedBudget: 50 })
  });
  check('trimming a budget without a note is refused', noNote.status === 400,
    `${noNote.status} ${noNote.body.message}`);

  const approved2 = await api(adminToken, `/api/activities/${act2.id}/approval`, {
    method: 'PATCH',
    body: JSON.stringify({
      action: 'approve',
      approvedBudget: 50,
      adminNote: 'We will purchase the remaining items next month.'
    })
  });
  check('the Director can approve with a changed budget', approved2.status === 200, JSON.stringify(approved2.body).slice(0, 200));
  const act2b = approved2.body;
  check("status is 'Approved'", act2b.status === 'Approved', act2b.status);
  check("approval_status is 'approved'", act2b.approvalStatus === 'approved', act2b.approvalStatus);
  check('the requested $100 is preserved', act2b.requestedBudget === 100, String(act2b.requestedBudget));
  check('the approved budget is $50', act2b.approvedBudget === 50, String(act2b.approvedBudget));
  check('the adjustment is -$50', act2b.budgetAdjustment === -50, String(act2b.budgetAdjustment));
  check('the admin note is recorded',
    act2b.adminNote === 'We will purchase the remaining items next month.', act2b.adminNote);
  check('approved_by is the Director', act2b.approvedBy === directorId, String(act2b.approvedBy));

  const directorQueue3 = (await api(adminToken, '/api/approval-queue')).body;
  check('it has left the Director\'s queue',
    !directorQueue3.activities.some((item) => item.id === act2.id));

  // a decided record cannot be decided twice
  const twice = await api(adminToken, `/api/activities/${act2.id}/approval`, {
    method: 'PATCH', body: JSON.stringify({ action: 'reject', rejectionReason: 'changed my mind' })
  });
  check('an already-decided record cannot be decided again', twice.status === 409,
    `${twice.status} ${twice.body.message}`);

  // ---- 5/9. rejection ------------------------------------------------------
  section('5. Rejection');
  const created3 = await api(farmingToken, '/api/activities', {
    method: 'POST',
    body: JSON.stringify(activityPayload({ activity: 'TEST Rejected request', category: 'Tools', costUsd: 900 }))
  });
  const act3 = created3.body;
  created.activities.push(act3.id);
  check('the request was raised', created3.status === 201);

  const noReason = await api(adminToken, `/api/activities/${act3.id}/approval`, {
    method: 'PATCH', body: JSON.stringify({ action: 'reject' })
  });
  check('rejecting without a reason is refused', noReason.status === 400, `${noReason.status} ${noReason.body.message}`);

  const rejected = await api(adminToken, `/api/activities/${act3.id}/approval`, {
    method: 'PATCH',
    body: JSON.stringify({ action: 'reject', rejectionReason: 'The budget is not available this quarter.' })
  });
  check('the Director can reject', rejected.status === 200, JSON.stringify(rejected.body).slice(0, 200));
  check("approval_status is 'rejected'", rejected.body.approvalStatus === 'rejected', rejected.body.approvalStatus);
  check("status is 'Rejected'", rejected.body.status === 'Rejected', rejected.body.status);
  check('the reason is stored',
    rejected.body.rejectionReason === 'The budget is not available this quarter.', rejected.body.rejectionReason);
  check('rejected_by is recorded', rejected.body.approvedBy === directorId, String(rejected.body.approvedBy));

  section('9. Rejected records leave the queue');
  const directorQueue4 = (await api(adminToken, '/api/approval-queue')).body;
  check('the rejected record has left the queue',
    !directorQueue4.activities.some((item) => item.id === act3.id));
  const directorBadge = (await api(adminToken, '/api/summary')).body.summary.approvalsAwaitingMe;
  check('the Director badge matches their queue length',
    directorBadge === directorQueue4.activities.length + directorQueue4.movements.length,
    `badge ${directorBadge} vs queue ${directorQueue4.activities.length + directorQueue4.movements.length}`);

  // ---- 7. badge arithmetic -------------------------------------------------
  section('7. The badge tracks the queue as records are added and decided');
  const before = (await api(adminToken, '/api/summary')).body.summary.approvalsAwaitingMe;
  const created4 = await api(farmingToken, '/api/activities', {
    method: 'POST', body: JSON.stringify(activityPayload({ activity: 'TEST Badge counter', category: 'Tools', costUsd: 5 }))
  });
  created.activities.push(created4.body.id);
  const during = (await api(adminToken, '/api/summary')).body.summary.approvalsAwaitingMe;
  check('the badge goes up by one when work arrives', during === before + 1, `${before} -> ${during}`);
  await api(adminToken, `/api/activities/${created4.body.id}/approval`, {
    method: 'PATCH', body: JSON.stringify({ action: 'approve' })
  });
  const after = (await api(adminToken, '/api/summary')).body.summary.approvalsAwaitingMe;
  check('the badge goes down by one when it is decided', after === before, `${during} -> ${after}`);

  // ---- movements -----------------------------------------------------------
  section('Movements follow the same routing');
  const movementCreated = await api(adminToken, '/api/movements', {
    method: 'POST',
    body: JSON.stringify({
      purpose: 'TEST supply run', origin: 'Kigali', destination: 'Rubavu',
      movementType: 'Materials', currency: 'RWF', relatedArea: 'farming',
      costs: { transport: 50000, fuel: 20000, accommodation: 0, meals: 0, handling: 0, other: 0 },
      status: 'Pending Approval'
    })
  });
  check('a movement can be created', movementCreated.status === 201, JSON.stringify(movementCreated.body).slice(0, 200));
  const mov = movementCreated.body;
  created.movements.push(mov.id);
  check("movement status is 'Pending Approval'", mov.status === 'Pending Approval', mov.status);
  check("movement approval_status is 'pending'", mov.approvalStatus === 'pending', mov.approvalStatus);
  check('the movement names the Director as approver', mov.approvalRequiredFrom === directorId, String(mov.approvalRequiredFrom));
  check('the movement carries a department', mov.department === 'farming', mov.department);

  const movQueue = (await api(adminToken, '/api/approval-queue')).body;
  check('it is in the Director\'s movement queue', movQueue.movements.some((item) => item.id === mov.id));
  const movStolen = await api(farmingToken, `/api/movements/${mov.id}/approval`, {
    method: 'PATCH', body: JSON.stringify({ action: 'approve' })
  });
  check('a manager cannot approve a director-bound movement', [403, 404].includes(movStolen.status),
    `${movStolen.status} ${movStolen.body.message}`);

  const movApproved = await api(adminToken, `/api/movements/${mov.id}/approval`, {
    method: 'PATCH', body: JSON.stringify({ action: 'approve', adminNote: 'Approved as estimated.' })
  });
  check('the Director can approve the movement', movApproved.status === 200, JSON.stringify(movApproved.body).slice(0, 200));
  check("movement status is 'Approved'", movApproved.body.status === 'Approved', movApproved.body.status);
  check('movement approved_by is the Director', movApproved.body.approvedBy === directorId, String(movApproved.body.approvedBy));
  const movQueue2 = (await api(adminToken, '/api/approval-queue')).body;
  check('the approved movement left the queue', !movQueue2.movements.some((item) => item.id === mov.id));

  // ---- 10. nothing else broke ---------------------------------------------
  section('10. Existing functionality still works');
  const summary = await api(adminToken, '/api/summary');
  check('summary loads', summary.status === 200 && typeof summary.body.summary.totalProjects === 'number');
  const projects = await api(adminToken, '/api/projects');
  check('projects load', projects.status === 200 && Array.isArray(projects.body));
  const register = await api(adminToken, '/api/activities?limit=100');
  check('the activity register loads', register.status === 200 && Array.isArray(register.body));
  check('every register row carries its approval fields',
    register.body.every((item) => 'approvalStatus' in item && 'approvalRequiredFrom' in item));
  const movements = await api(adminToken, '/api/movements');
  check('the movement register loads', movements.status === 200 && Array.isArray(movements.body));
  const movementSummary = await api(adminToken, '/api/movements/summary');
  check('the movement summary loads', movementSummary.status === 200 && movementSummary.body.counts);
  const report = await api(adminToken, '/api/reports/activities?period=monthly&month=' + new Date().toISOString().slice(0, 7));
  check('the activity report generates', report.status === 200 && report.body.activitySummary,
    `${report.status} ${report.body.message || ''}`);
  const approvalsList = await api(adminToken, '/api/approvals');
  check('the separate approvals register still loads', approvalsList.status === 200 && Array.isArray(approvalsList.body));
  const managerRegister = await api(farmingToken, '/api/activities?limit=100');
  check('a manager still reads only their own area',
    managerRegister.status === 200 && managerRegister.body.every((item) => item.sector === 'farming'));
} catch (error) {
  failed += 1;
  console.error('\nUNCAUGHT:', error.message, '\n', error.stack);
} finally {
  section('cleanup');
  await cleanup();
  console.log(`  removed ${created.activities.length} activities, ${created.movements.length} movements, ${created.users.length} users`);
  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
}
