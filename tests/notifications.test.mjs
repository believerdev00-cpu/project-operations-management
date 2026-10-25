// Everything between the Director and a manager reaches the other side.
//
//   1. a month handed to a manager tells the manager;
//   2. a day the manager records, and a day they correct, tells the Director;
//      a day the Director removes tells whoever recorded it, with the reason;
//   3. work the Director adds to the month, or hands to a manager, tells the
//      manager -- once, even when the manager must also accept it;
//   4. an approval asked for tells the approver, and the answer tells whoever
//      asked; the same for a budget change and for a trip;
//   5. nobody is told about their own act, and every notice links to where it
//      happened.
//
// Drives the live API against a real database. Its rows are ZZTEST accounts, a
// farming project, a plan for 2096-04, its activities and a trip -- all
// removed in `finally`.

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
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

async function call(token, method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const MONTH = '2096-04';
const day = (n) => `${MONTH}-${String(n).padStart(2, '0')}`;
const created = { users: [], activities: [], movements: [] };
let planId = null;

async function account(username, name, role, sector, managerId = null) {
  const row = await pool.query(
    'INSERT INTO users (username, password_hash, name, role, sector, manager_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [username, bcrypt.hashSync('zz-notify-unused-1', 4), name, role, sector, managerId]
  );
  created.users.push(row.rows[0].id);
  return { id: row.rows[0].id, token: jwt.sign({ id: row.rows[0].id }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' }) };
}
// The notices a person holds of one kind, caused by one actor.
const notices = async (userId, kind, actorId) => (await pool.query(
  'SELECT * FROM notifications WHERE user_id = $1 AND kind = $2 AND ($3::int IS NULL OR actor_id = $3) ORDER BY id', [userId, kind, actorId ?? null]
)).rows;

try {
  section('setup');
  const { id: directorId, token: director } = await directorSession();
  const manager = await account('zz-notify-manager', 'ZZTEST Notify Manager', 'manager', 'farming');
  const tripsManager = await account('zz-notify-trips', 'ZZTEST Notify Trips Manager', 'manager', 'movement');
  const project = await createProject('farming', { managerId: manager.id, name: 'ZZTEST Notify farm' });
  await pool.query("DELETE FROM monthly_plans WHERE sector = 'farming' AND month = $1::date", [`${MONTH}-01`]);

  section('1. a month handed to a manager');
  const plan = await call(director, 'POST', '/api/monthly-plans', {
    operation: 'farming', month: MONTH, managerId: manager.id, projectId: project, approvedBudget: 1000,
    objectives: [{ title: 'ZZTEST Plant 30 trees', targetQuantity: 30, targetUnit: 'trees' }]
  });
  planId = plan.body.id;
  check('the Director writes the month', plan.status === 201, plan.body);
  const assigned = await notices(manager.id, 'plan_assigned', directorId);
  check('the manager is told the month is theirs', assigned.length === 1 && assigned[0].link === `#/monthly/${planId}`, assigned);

  section('2. days: recorded, corrected, removed');
  const detail = await call(manager.token, 'GET', `/api/monthly-plans/${planId}`);
  const objectiveId = (detail.body.objectives || detail.body.plan?.objectives || [])[0]?.id;
  const recorded = await call(manager.token, 'POST', `/api/monthly-plans/${planId}/reports`, { date: day(3), objectiveId, quantityDone: 5, cost: 10, notes: 'ZZTEST five trees' });
  check('the manager records a day', recorded.status === 201, recorded.body);
  const dayRecorded = await notices(directorId, 'day_recorded', manager.id);
  check('the Director is told, with the objective the day counted towards', dayRecorded.length === 1
    && dayRecorded[0].params.title === 'ZZTEST Plant 30 trees' && dayRecorded[0].params.operation === 'farming' && dayRecorded[0].params.month === MONTH
    && dayRecorded[0].link === `#/monthly/${planId}`, dayRecorded.map((row) => row.params));
  check('  the manager is not told about their own day', (await notices(manager.id, 'day_recorded')).length === 0);
  const dayId = recorded.body.day.id;
  const corrected = await call(manager.token, 'PUT', `/api/monthly-plans/${planId}/reports/${dayId}`, { quantityDone: 6, cost: 10, notes: 'ZZTEST six trees' });
  check('the manager corrects the day', corrected.status === 200, corrected.body);
  const dayCorrected = await notices(directorId, 'day_corrected', manager.id);
  check('  and the Director is told, with the day', dayCorrected.length === 1 && dayCorrected[0].params.detail === day(3), dayCorrected.map((row) => row.params));
  const removed = await call(director, 'DELETE', `/api/monthly-plans/${planId}/reports/${dayId}`, { reason: 'ZZTEST counted twice' });
  check('the Director removes the day', removed.status === 200, removed.body);
  const dayRemoved = await notices(manager.id, 'day_removed', directorId);
  check('  and the manager who recorded it is told why', dayRemoved.length === 1 && dayRemoved[0].params.reason === 'ZZTEST counted twice', dayRemoved.map((row) => row.params));

  section('3. work handed to the manager');
  const planned = await call(director, 'POST', `/api/monthly-plans/${planId}/activities`, {
    activity: 'ZZTEST Dig the planting holes', category: 'Planned work', description: 'ZZTEST holes for the trees', approvedBudget: 100, priority: 'Low'
  });
  check('the Director adds work to the month', planned.status === 201, planned.body);
  const plannedId = (await pool.query("SELECT id FROM activities WHERE monthly_plan_id = $1 AND activity = 'ZZTEST Dig the planting holes'", [planId])).rows[0]?.id;
  if (plannedId) created.activities.push(plannedId);
  const assignedWork = await notices(manager.id, 'work_assigned', directorId);
  check('  and the manager is told what was added', assignedWork.length === 1 && assignedWork[0].params.activity === 'ZZTEST Dig the planting holes', assignedWork.map((row) => row.params));
  const handed = await call(director, 'POST', '/api/activities', {
    projectId: project, sector: 'farming', category: 'Meetings', activity: 'ZZTEST Chair the farm meeting', description: 'ZZTEST meeting',
    quantity: 1, costUsd: 20, costRwf: 20 * 1450, costCdf: 20 * 2850, assignedTo: manager.id
  });
  if (handed.body?.id) created.activities.push(handed.body.id);
  const handedNotices = (await pool.query("SELECT kind FROM notifications WHERE user_id = $1 AND activity_id = $2", [manager.id, handed.body?.id])).rows.map((row) => row.kind);
  check('work handed to the manager tells them once, even though they must accept it', handed.status === 201 && handedNotices.join() === 'work_assigned', handedNotices);

  section('4. approvals and budget changes, asked and answered');
  const asked = await call(manager.token, 'POST', '/api/activities', {
    projectId: project, sector: 'farming', category: 'Fertilizer and inputs', activity: 'ZZTEST Buy compost', description: 'ZZTEST compost for the holes',
    quantity: 1, costUsd: 50, costRwf: 50 * 1450, costCdf: 50 * 2850
  });
  if (asked.body?.id) created.activities.push(asked.body.id);
  check('the manager asks for new work', asked.status === 201 && asked.body.approvalRequiredRole === 'director', asked.body);
  const approvalAsked = await notices(directorId, 'approval_requested', manager.id);
  check('  and the Director is asked, with a link to the record', approvalAsked.length === 1 && approvalAsked[0].link === `#/activities/${asked.body.id}`, approvalAsked.map((row) => row.link));
  const approved = await call(director, 'PATCH', `/api/activities/${asked.body.id}/approval`, { action: 'approve' });
  check('the Director approves', approved.status === 200, approved.body);
  const answered = await notices(manager.id, 'approval_decided', directorId);
  check('  and the manager is told it was approved', answered.length === 1 && answered[0].params.outcome === 'approved' && answered[0].params.activity === 'ZZTEST Buy compost', answered.map((row) => row.params));
  const budgetAsk = await call(manager.token, 'POST', `/api/activities/${asked.body.id}/budget-requests`, { amount: 80, reason: 'ZZTEST compost costs more this season' });
  check('the manager asks for a different budget', budgetAsk.status === 201, budgetAsk.body);
  const budgetAsked = await notices(directorId, 'budget_change_requested', manager.id);
  check('  and the Director is told, with the figures', budgetAsked.length === 1 && budgetAsked[0].params.detail === '$50.00 → $80.00', budgetAsked.map((row) => row.params));
  const budgetNo = await call(director, 'PATCH', `/api/activities/${asked.body.id}/budget-requests/${budgetAsk.body.id}`, { status: 'Declined', decisionNote: 'ZZTEST not this month' });
  check('the Director declines', budgetNo.status === 200, budgetNo.body);
  const budgetAnswered = await notices(manager.id, 'budget_change_decided', directorId);
  check('  and the manager is told why', budgetAnswered.length === 1 && budgetAnswered[0].params.outcome === 'refused' && budgetAnswered[0].params.reason === 'ZZTEST not this month', budgetAnswered.map((row) => row.params));

  const trip = await call(tripsManager.token, 'POST', '/api/movements', {
    purpose: 'ZZTEST seedlings run', origin: 'Kigali', destination: 'Rubavu', movementType: 'Materials', currency: 'RWF', relatedArea: 'farming',
    costs: { transport: 50000, fuel: 20000, accommodation: 0, meals: 0, handling: 0, other: 0 }, status: 'Pending Approval'
  });
  if (trip.body?.id) created.movements.push(trip.body.id);
  check('a manager asks for a trip', trip.status === 201 && trip.body.approvalStatus === 'pending', trip.body);
  const tripAsked = await notices(directorId, 'approval_requested', tripsManager.id);
  check('  and the Director is asked', tripAsked.length === 1 && tripAsked[0].params.activity === 'ZZTEST seedlings run' && tripAsked[0].link === `#/movements/${trip.body.id}`, tripAsked.map((row) => row.params));
  const tripDecided = await call(director, 'PATCH', `/api/movements/${trip.body.id}/approval`, { action: 'reject', rejectionReason: 'ZZTEST use the farm truck instead' });
  check('the Director refuses the trip', tripDecided.status === 200, tripDecided.body);
  const tripAnswered = await notices(tripsManager.id, 'approval_decided', directorId);
  check('  and the manager is told why', tripAnswered.length === 1 && tripAnswered[0].params.outcome === 'refused' && tripAnswered[0].params.reason === 'ZZTEST use the farm truck instead', tripAnswered.map((row) => row.params));

  section('5. nobody is told about their own act');
  const selfNotices = (await pool.query('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = actor_id AND user_id = ANY($1::int[])', [[...created.users, directorId]])).rows[0].n;
  check('no notice was sent to the person who acted', selfNotices === 0, selfNotices);
} catch (error) {
  failed += 1;
  console.log(`  FAIL  the suite stopped: ${error.stack || error.message}`);
} finally {
  const ids = created.users;
  await pool.query('DELETE FROM notifications WHERE user_id = ANY($1::int[]) OR actor_id = ANY($1::int[])', [ids]);
  await pool.query("DELETE FROM notifications WHERE plan_id = $1", [planId]);
  if (planId) {
    const planned = (await pool.query('SELECT id FROM activities WHERE monthly_plan_id = $1', [planId])).rows.map((row) => row.id);
    created.activities.push(...planned);
  }
  await pool.query('DELETE FROM notifications WHERE activity_id = ANY($1::varchar[])', [created.activities]);
  await pool.query('DELETE FROM activities WHERE id = ANY($1::varchar[])', [created.activities]);
  await pool.query('DELETE FROM movements WHERE id = ANY($1::varchar[])', [created.movements]);
  if (planId) await pool.query('DELETE FROM monthly_plans WHERE id = $1', [planId]);
  await removeProject('farming');
  await pool.query('DELETE FROM organization_history WHERE subject_user_id = ANY($1::int[]) OR actor_id = ANY($1::int[])', [ids]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [ids]);
  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
