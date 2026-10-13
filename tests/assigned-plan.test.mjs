// ADMIN CREATES PLAN -> ASSIGNS PLAN -> MANAGER RECEIVES PLAN -> MANAGER EXECUTES
// WORK -> MANAGER SUBMITS REPORT/EVIDENCE -> ADMIN REVIEWS -> APPROVE OR RETURN.
//
// The acceptance test for that workflow, driven over HTTP against the live API
// and database. Every step the brief lists is a section below, in its order:
// the Director writes and assigns a month, the named manager is told and sees
// it, a manager of another operation does not, work is started, recorded and
// evidenced, the month is submitted, returned with a reason, corrected,
// resubmitted and accepted, and the dashboard counts move with it. The same
// cycle is then run on a planned activity (start, progress, evidence, hand
// back, return, resubmit, approve) because the brief's "work" covers both.
//
// Nothing here is mocked: the scoping, the notifications and the status moves
// all live in Postgres, and a fake database would prove none of them.

import bcrypt from 'bcryptjs';
import { pool } from '../server/db/database.js';
import { directorSession } from './director.mjs';

const API = process.env.API || 'http://localhost:5000';
const MONTH = '2097-10';
const day = (n) => `${MONTH}-${String(n).padStart(2, '0')}`;

let passed = 0;
let failed = 0;
const created = { plans: [], projects: [] };

const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
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
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
const post = (token, path, body) => api(token, path, { method: 'POST', body: JSON.stringify(body || {}) });
const patch = (token, path, body) => api(token, path, { method: 'PATCH', body: JSON.stringify(body || {}) });

async function upload(token, path, extra = {}) {
  const form = new FormData();
  form.append('kind', 'Photograph');
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  form.append('files', new Blob(['ZZTEST proof'], { type: 'image/png' }), 'proof.png');
  const response = await fetch(`${API}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function login(username, password) {
  const { status, body } = await api(null, '/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  if (status !== 200) throw new Error(`login ${username}: ${status} ${body.message}`);
  return body.token;
}

async function seedManager(username, name, sector) {
  const row = await pool.query(
    `INSERT INTO users (username, password_hash, name, role, sector) VALUES ($1, $2, $3, 'manager', $4) RETURNING id`,
    [username, bcrypt.hashSync('test-pass-123', 10), name, sector]
  );
  return { id: row.rows[0].id, name, token: await login(username, 'test-pass-123') };
}

const notices = async (token) => (await api(token, '/api/notifications')).body;
const kinds = (list) => (list.items || []).map((item) => item.kind);

try {
  section('setup');
  const { id: directorId, token: admin } = await directorSession();
  await pool.query("DELETE FROM users WHERE username LIKE 'zz-ap-%'");
  await pool.query("DELETE FROM monthly_plans WHERE month = $1::date", [`${MONTH}-01`]);
  const managerA = await seedManager('zz-ap-mining-a', 'ZZ Mining Manager A', 'mining');
  const managerB = await seedManager('zz-ap-agri-b', 'ZZ Agriculture Manager B', 'agriculture');
  // A planned activity needs a project of its operation to hang off.
  await pool.query(
    `INSERT INTO projects (id, name, sector, location, owner, status, progress, budget, spent, category, manager_id)
     VALUES ('ZZAP-P1', 'ZZTEST Mining project', 'mining', 'Site', 'ZZ', 'On Track', 0, 0, 0, 'Extraction', $1)
     ON CONFLICT (id) DO NOTHING`,
    [managerA.id]
  );
  created.projects.push('ZZAP-P1');
  const directorUnreadBefore = (await notices(admin)).unread;

  // ---- 1 + 2. the Director creates and assigns the month -------------------
  section('1-2. Admin creates a monthly plan and assigns it to Manager A');
  const made = await post(admin, '/api/monthly-plans', {
    operation: 'mining', month: MONTH, managerId: managerA.id,
    approvedBudget: 2000, notes: 'Visit the ABC site first. Photograph every visit.',
    objectives: [
      { title: 'Site visits', targetQuantity: 10, targetUnit: 'visits', deadline: day(31) },
      { title: 'Production monitoring', targetQuantity: 500, targetUnit: 'tons', deadline: day(31) }
    ]
  });
  check('the plan is created', made.status === 201, made.body);
  if (made.status === 201) created.plans.push(made.body.id);
  const planId = made.body.id;
  check('it is Active (Confirmed) from the moment it is saved', made.body.status === 'Confirmed', made.body.status);
  check('it names the manager', Number(made.body.managerId) === managerA.id);
  check('it records who assigned it', Number(made.body.assignedBy) === directorId, made.body.assignedBy);
  check('  and when', Boolean(made.body.assignedAt));
  const detailA = await api(managerA.token, `/api/monthly-plans/${planId}`);
  check('each objective carries its deadline', detailA.body.objectives?.every((objective) => objective.deadline === day(31)),
    detailA.body.objectives?.map((objective) => objective.deadline));
  const bad = await post(admin, '/api/monthly-plans', {
    operation: 'agriculture', month: MONTH, objectives: [{ title: 'Bad date', targetQuantity: 1, targetUnit: 'x', deadline: '2097-02-30' }]
  });
  check('a deadline that is not a real date is refused', bad.status === 400, bad.status);
  const history = detailA.body.history || [];
  check('the audit trail says the plan was created and the manager assigned',
    history.some((entry) => entry.action === 'Plan created') && history.some((entry) => entry.action === 'Manager assigned'));

  // ---- 3. the manager receives it ------------------------------------------
  section('3. Manager A sees the plan under My plan, and is told about it');
  check('Manager A can open the plan', detailA.status === 200, detailA.status);
  check('  it says who assigned it', detailA.body.plan?.assignedByName && Number(detailA.body.plan?.assignedBy) === directorId, detailA.body.plan?.assignedByName);
  check('  with the Director\'s instructions', detailA.body.plan?.notes?.includes('ABC'));
  check('  and the approved budget', detailA.body.plan?.approvedBudget === 2000);
  const listA = await api(managerA.token, '/api/monthly-plans');
  check('it is in Manager A\'s list of plans', listA.body.some?.((plan) => plan.id === planId));
  const noticesA = await notices(managerA.token);
  check('Manager A has an unread "new plan assigned" notification', kinds(noticesA).includes('plan_assigned') && noticesA.unread >= 1, noticesA);
  const assignedNotice = noticesA.items.find((item) => item.kind === 'plan_assigned');
  check('  it links to the plan', assignedNotice?.link === `#/monthly/${planId}`, assignedNotice?.link);
  check('  and names the operation and month', assignedNotice?.params?.operation === 'mining' && assignedNotice?.params?.month === MONTH, assignedNotice?.params);
  const summaryA = await api(managerA.token, '/api/summary');
  check('  the unread count is on the summary too', summaryA.body.summary?.unreadNotifications >= 1, summaryA.body.summary?.unreadNotifications);
  const read = await patch(managerA.token, `/api/notifications/${assignedNotice.id}/read`);
  check('opening it marks it read', read.status === 200 && read.body.read === true);
  check('  and the count drops', (await notices(managerA.token)).unread === noticesA.unread - 1);

  // ---- 4. another manager does not ----------------------------------------
  section('4. Manager B (another operation) cannot see Manager A\'s plan');
  const detailB = await api(managerB.token, `/api/monthly-plans/${planId}`);
  check('Manager B is refused the plan', detailB.status === 404, detailB.status);
  const listB = await api(managerB.token, '/api/monthly-plans');
  check('  and it is not in their list', !listB.body.some?.((plan) => plan.id === planId));
  check('  and they were not told about it', !kinds(await notices(managerB.token)).includes('plan_assigned'));
  check('  nor can they mark A\'s notification read', (await patch(managerB.token, `/api/notifications/${assignedNotice.id}/read`)).status === 404);
  const reviewB = await api(managerB.token, `/api/monthly-plans/review?month=${MONTH}`);
  check('  the review for the month shows them nothing of Mining', !(reviewB.body.operations || []).some((plan) => plan.id === planId));

  // ---- 5 + 6. the manager works ---------------------------------------------
  section('5-6. Manager A starts the work and records progress');
  check('Manager B cannot start it', [403, 404].includes((await post(managerB.token, `/api/monthly-plans/${planId}/start`)).status));
  const started = await post(managerA.token, `/api/monthly-plans/${planId}/start`);
  check('Manager A starts the month', started.status === 200 && started.body.status === 'In Progress', started.body);
  const visits = detailA.body.objectives.find((objective) => objective.title === 'Site visits');
  const reported = await post(managerA.token, `/api/monthly-plans/${planId}/reports`, {
    date: day(12), objectiveId: visits.id, quantityDone: 4, notes: 'Visited ABC, XYZ and two more.'
  });
  check('a day of work is recorded against the planned objective', reported.status === 201, reported.body);
  const afterDay = (reported.body.objectives || []).find((objective) => objective.id === visits.id);
  check('  progress is calculated, 4 of 10 = 40%', afterDay?.percent === 40 && afterDay?.quantityDone === 4, afterDay);
  check('  the month\'s overall figure follows (40% and 0% -> 20%)', reported.body.plan?.overallProgress === 20, reported.body.plan?.overallProgress);
  check('Manager B cannot record a day on it', [403, 404].includes((await post(managerB.token, `/api/monthly-plans/${planId}/reports`, {
    date: day(13), objectiveId: visits.id, quantityDone: 1
  })).status));

  // ---- 7. evidence ------------------------------------------------------------
  section('7. Manager A attaches evidence to the day');
  const dayId = reported.body.day?.id;
  const proof = await upload(managerA.token, `/api/monthly-plans/${planId}/reports/${dayId}/evidence`);
  check('a photo is attached to the day of work', proof.status === 201, proof.body);
  const withProof = await api(managerA.token, `/api/monthly-plans/${planId}`);
  const theDay = (withProof.body.dailyReports || []).find((item) => item.id === dayId);
  check('  and shows inside that day\'s record', theDay?.evidence?.length === 1, theDay);
  const filePath = theDay?.evidence?.[0]?.path;
  const strangerFile = await fetch(`${API}${filePath}`, { headers: { Authorization: `Bearer ${managerB.token}` } });
  check('  Manager B cannot open the file', [403, 404].includes(strangerFile.status), strangerFile.status);
  const ownFile = await fetch(`${API}${filePath}`, { headers: { Authorization: `Bearer ${managerA.token}` } });
  check('  Manager A can', ownFile.status === 200, ownFile.status);

  // ---- 8 + 9. submission ------------------------------------------------------
  section('8-9. Manager A submits the month for review; the Director sees it');
  const submitted = await post(managerA.token, `/api/monthly-plans/${planId}/report`, {
    unusedBalanceExplanation: 'Visits are still under way; the balance is for the remaining six.'
  });
  check('the month-end report is submitted while the month is In Progress', submitted.status === 201 && submitted.body.status === 'Submitted', submitted.body);
  check('Manager B cannot submit it', [403, 404].includes((await post(managerB.token, `/api/monthly-plans/${planId}/report`, { unusedBalanceExplanation: 'x' })).status));
  const directorNotices = await notices(admin);
  check('the Director is told a report is waiting', kinds(directorNotices).includes('report_submitted'), kinds(directorNotices));
  check('  and did not get a notification for their own plan creation', directorNotices.unread >= directorUnreadBefore);
  const directorSummary = await api(admin, '/api/summary');
  check('the Director\'s dashboard counts the waiting report', directorSummary.body.summary?.monthEndReportsWaiting >= 1, directorSummary.body.summary?.monthEndReportsWaiting);
  const directorPlans = await api(admin, '/api/monthly-plans');
  const waiting = directorPlans.body.find((plan) => plan.id === planId);
  check('  and the plan list shows the report as Submitted', waiting?.report?.status === 'Submitted', waiting?.report);
  check('a manager cannot review their own submission', (await patch(managerA.token, `/api/monthly-plans/${planId}/report`, { status: 'Accepted' })).status === 403);

  // ---- 12 + 13. return for correction ------------------------------------------
  section('12-13. The Director returns it with a reason; Manager A sees the reason');
  const noReason = await patch(admin, `/api/monthly-plans/${planId}/report`, { status: 'Returned' });
  check('returning without a reason is refused', noReason.status === 400, noReason.body);
  const returned = await patch(admin, `/api/monthly-plans/${planId}/report`, {
    status: 'Returned', reviewNote: 'Please add evidence for the remaining site visits.'
  });
  check('the report is returned', returned.status === 200 && returned.body.report?.status === 'Returned', returned.body.report);
  const seen = await api(managerA.token, `/api/monthly-plans/${planId}`);
  check('Manager A sees it was returned', seen.body.report?.status === 'Returned');
  check('  with the Director\'s reason', seen.body.report?.reviewNote === 'Please add evidence for the remaining site visits.', seen.body.report?.reviewNote);
  const returnedNotice = (await notices(managerA.token)).items.find((item) => item.kind === 'report_returned');
  check('  and was notified, reason included', returnedNotice?.params?.reason?.includes('remaining site visits'), returnedNotice);
  check('  the plan is still open for them to correct', seen.body.plan?.status === 'In Progress', seen.body.plan?.status);
  check('the trail records the return', (seen.body.history || []).some((entry) => entry.action === 'Report returned'));

  // ---- 14. correct and resubmit -------------------------------------------------
  section('14. Manager A corrects and resubmits');
  const moreWork = await post(managerA.token, `/api/monthly-plans/${planId}/reports`, {
    date: day(20), objectiveId: visits.id, quantityDone: 6, notes: 'Remaining six visits done.'
  });
  check('more work is recorded', moreWork.status === 201, moreWork.body);
  const visitsNow = (moreWork.body.objectives || []).find((objective) => objective.id === visits.id);
  check('  the objective is now complete, 10 of 10', visitsNow?.complete === true && visitsNow?.percent === 100, visitsNow);
  const over = await post(managerA.token, `/api/monthly-plans/${planId}/reports`, { date: day(21), objectiveId: visits.id, quantityDone: 1 });
  check('  reporting past the target is refused', over.status === 400 && over.body.code === 'OVER_TARGET', over.body);
  const resubmitted = await post(managerA.token, `/api/monthly-plans/${planId}/report`, {
    unusedBalanceExplanation: 'All visits done; monitoring continues next month.'
  });
  check('the report is submitted again', resubmitted.status === 201 && resubmitted.body.status === 'Submitted', resubmitted.body);
  check('  and the Director is told again', kinds(await notices(admin)).filter((kind) => kind === 'report_submitted').length >= 2);

  // ---- a change request, on the record ----------------------------------------------
  section('The manager asks for a change rather than editing the targets');
  const changeDenied = await patch(managerA.token, `/api/monthly-plans/${planId}`, { approvedBudget: 5000 });
  check('a manager cannot edit the plan', changeDenied.status === 403, changeDenied.status);
  const objectiveEdit = await patch(managerA.token, `/api/monthly-plans/${planId}/objectives/${visits.id}`, { targetQuantity: 1 });
  check('  nor its targets', objectiveEdit.status === 403, objectiveEdit.status);
  const asked = await post(managerA.token, `/api/monthly-plans/${planId}/change-request`, { message: 'Rain closed the road; the monitoring target of 500 tons will not be reached.' });
  check('a change request is recorded', asked.status === 201, asked.body);
  check('  in the plan\'s history', (asked.body.history || []).some((entry) => entry.action === 'Change requested' && entry.note.includes('500 tons')));
  check('  and the Director is told', kinds(await notices(admin)).includes('change_requested'));
  check('  Manager B cannot ask about A\'s plan', [403, 404].includes((await post(managerB.token, `/api/monthly-plans/${planId}/change-request`, { message: 'x' })).status));
  check('  an empty request is refused', (await post(managerA.token, `/api/monthly-plans/${planId}/change-request`, { message: '' })).status === 400);

  // ---- the Director changes the plan and the manager hears of it -------------------------
  section('The Director changes the plan; the manager is told');
  const changed = await patch(admin, `/api/monthly-plans/${planId}/objectives/${detailA.body.objectives.find((objective) => objective.title === 'Production monitoring').id}`, {
    targetQuantity: 300, deadline: day(25)
  });
  check('the Director lowers the target and moves the deadline', changed.status === 200, changed.body);
  const monitoring = (changed.body.objectives || []).find((objective) => objective.title === 'Production monitoring');
  check('  the deadline is stored', monitoring?.deadline === day(25) && monitoring?.targetQuantity === 300, monitoring);
  check('  Manager A is notified of the change', kinds(await notices(managerA.token)).includes('plan_changed'));

  // ---- 15. dashboard progress ------------------------------------------------------
  section('15. Dashboard figures follow the work');
  const review = await api(admin, `/api/monthly-plans/review?month=${MONTH}`);
  const reviewed = (review.body.operations || []).find((plan) => plan.id === planId);
  check('the Director\'s review shows Mining at 50% (100% and 0%)', reviewed?.overallProgress === 50, reviewed?.overallProgress);
  const counts = (await api(admin, '/api/summary')).body.summary || {};
  check('the summary counts the plan as active', counts.activePlans >= 1, counts.activePlans);
  check('  one objective completed and one not started, at least', counts.objectivesCompleted >= 1 && counts.objectivesNotStarted >= 1, counts);
  check('  the approved budget is in the budget overview', counts.plansBudget >= 2000, counts.plansBudget);

  // ---- 10 + 11. approval ------------------------------------------------------------
  section('10-11. The Director approves; Manager A sees Approved');
  const accepted = await patch(admin, `/api/monthly-plans/${planId}/report`, { status: 'Accepted', reviewNote: 'Well done.' });
  check('the report is accepted', accepted.status === 200, accepted.body);
  check('  which closes the month', accepted.body.status === 'Closed', accepted.body.status);
  const closedA = await api(managerA.token, `/api/monthly-plans/${planId}`);
  check('Manager A sees the month Closed with the report Accepted', closedA.body.plan?.status === 'Closed' && closedA.body.report?.status === 'Accepted');
  check('  and was notified of the approval', kinds(await notices(managerA.token)).includes('report_accepted'));
  check('nothing more can be recorded on a closed month', (await post(managerA.token, `/api/monthly-plans/${planId}/reports`, { date: day(22), objectiveId: visits.id, quantityDone: 1 })).status === 400);
  check('the Director\'s summary now counts it as closed', ((await api(admin, '/api/summary')).body.summary?.plansClosed || 0) >= 1);

  // ---- the same cycle on a planned activity ----------------------------------------------
  section('Planned activity: start, progress, evidence, submit, return, resubmit, approve');
  const plan2 = await post(admin, '/api/monthly-plans', {
    operation: 'agriculture', month: MONTH, managerId: managerB.id,
    objectives: [{ title: 'Prepare land', targetQuantity: 2, targetUnit: 'hectares' }], approvedBudget: 1000
  });
  check('a second plan, for Manager B\'s operation', plan2.status === 201, plan2.body);
  if (plan2.status === 201) created.plans.push(plan2.body.id);
  await pool.query(
    `INSERT INTO projects (id, name, sector, location, owner, status, progress, budget, spent, category, manager_id)
     VALUES ('ZZAP-P2', 'ZZTEST Agriculture project', 'agriculture', 'Field', 'ZZ', 'On Track', 0, 0, 0, 'Planting and sowing', $1)
     ON CONFLICT (id) DO NOTHING`,
    [managerB.id]
  );
  created.projects.push('ZZAP-P2');
  const planned = await post(admin, `/api/monthly-plans/${plan2.body.id}/activities`, {
    activity: 'ZZTEST Clear the north field', category: 'Planting and sowing',
    description: 'Clear and plough the north field before planting.', approvedBudget: 200, priority: 'High', deadline: day(15)
  });
  check('the Director adds a planned activity to the month', planned.status === 201, planned.body);
  // The route answers with the month, not the activity; the activity is read
  // back from the plan the way the screen does.
  const plan2Detail = await api(admin, `/api/monthly-plans/${plan2.body.id}`);
  const activityId = (plan2Detail.body.activities || []).find((item) => item.activity === 'ZZTEST Clear the north field')?.id;
  check('  it appears on the plan, assigned to Manager B', Boolean(activityId)
    && Number((plan2Detail.body.activities || []).find((item) => item.id === activityId)?.assignedTo) === managerB.id, plan2Detail.body.activities);
  const seenB = await api(managerB.token, `/api/monthly-plans/${plan2.body.id}`);
  check('  Manager B sees it on their plan', (seenB.body.activities || []).some((item) => item.id === activityId));
  const mineOnly = await api(managerA.token, `/api/activities/${activityId}`);
  check('Manager A (Mining) cannot open Manager B\'s activity', mineOnly.status === 404, mineOnly.status);
  const progress = await patch(managerB.token, `/api/activities/${activityId}/progress`, { progress: 30, workPerformed: 'Half the field cleared.' });
  check('Manager B starts it by recording progress', progress.status === 200 && progress.body.status === 'In Progress', progress.body);
  const noProof = await post(managerB.token, `/api/activities/${activityId}/completion`, {});
  check('it cannot be submitted without evidence', noProof.status === 400, noProof.body);
  const activityProof = await upload(managerB.token, `/api/activities/${activityId}/evidence`, { evidenceType: 'activity' });
  check('a photo is attached', activityProof.status === 201, activityProof.body);
  const handedBack = await post(managerB.token, `/api/activities/${activityId}/completion`, { note: 'Done.' });
  check('the work is submitted for the Director\'s check', handedBack.status === 200 && Boolean(handedBack.body.completionSubmittedAt), handedBack.body);
  check('  the Director is told', kinds(await notices(admin)).includes('work_submitted'));
  check('  it counts in the Director\'s final checks', ((await api(admin, '/api/summary')).body.summary?.finalChecksWaiting || 0) >= 1);
  const selfApprove = await patch(managerB.token, `/api/activities/${activityId}/decision`, { status: 'Completed' });
  check('the manager cannot approve their own work', selfApprove.status === 403, selfApprove.status);
  const sentBack = await patch(admin, `/api/activities/${activityId}/decision`, { status: 'Needs Correction', adminNote: 'Add a photo of the ploughed field.' });
  check('the Director returns it for correction', sentBack.status === 200 && sentBack.body.status === 'Needs Correction', sentBack.body);
  check('  the reason is on the record', sentBack.body.adminNote === 'Add a photo of the ploughed field.');
  check('  and the hand-back is cleared so it can be resubmitted', sentBack.body.completionSubmittedAt === null);
  const workReturned = (await notices(managerB.token)).items.find((item) => item.kind === 'work_returned');
  check('  Manager B is told, with the reason', workReturned?.params?.reason?.includes('ploughed'), workReturned);
  const resumed = await patch(managerB.token, `/api/activities/${activityId}/status`, { status: 'In Progress' });
  check('Manager B picks the returned work up again', resumed.status === 200 && resumed.body.status === 'In Progress', resumed.body);
  const again = await post(managerB.token, `/api/activities/${activityId}/completion`, { note: 'Photo added.' });
  check('Manager B resubmits', again.status === 200 && Boolean(again.body.completionSubmittedAt), again.body);
  // The other way the Director can send work back: the plain status route. It
  // used to leave the hand-back timestamp in place, which stranded the record.
  const viaStatus = await patch(admin, `/api/activities/${activityId}/status`, { status: 'Needs Correction', note: 'One more photo.' });
  check('sending it back through the status route also clears the hand-back', viaStatus.status === 200 && viaStatus.body.completionSubmittedAt === null, viaStatus.body);
  const third = await post(managerB.token, `/api/activities/${activityId}/completion`, {});
  check('  so it can be handed back once more', third.status === 200, third.body);
  const done = await patch(admin, `/api/activities/${activityId}/decision`, { status: 'Completed' });
  check('the Director approves it', done.status === 200 && done.body.status === 'Completed', done.body);
  check('  Manager B is told it was approved', kinds(await notices(managerB.token)).includes('work_approved'));
  const trail = (await api(admin, `/api/activities/${activityId}/history`)).body;
  const actions = (Array.isArray(trail) ? trail : trail.history || []).map((entry) => entry.action);
  check('the activity\'s audit trail has start, submission, return and approval',
    actions.includes('Progress recorded') && actions.includes('Completion submitted') && actions.includes('Status changed'), actions);

  // ---- 16. the rest of the walls --------------------------------------------------------
  section('16. Unauthorized users cannot reach protected records');
  check('a manager cannot create a plan', (await post(managerA.token, '/api/monthly-plans', { operation: 'mining', month: '2097-11', objectives: [{ title: 'x' }] })).status === 403);
  check('a manager cannot review a report', (await patch(managerB.token, `/api/monthly-plans/${plan2.body.id}/report`, { status: 'Accepted' })).status === 403);
  check('a manager cannot change another manager\'s plan objectives', [403, 404].includes((await post(managerA.token, `/api/monthly-plans/${plan2.body.id}/objectives`, { title: 'x' })).status));
  check('nobody reaches notifications without a session', (await api(null, '/api/notifications')).status === 401);
  const markAll = await post(managerA.token, '/api/notifications/read-all');
  check('mark-all-read touches only the caller\'s rows', markAll.status === 200 && (await notices(managerA.token)).unread === 0 && (await notices(managerB.token)).unread > 0);
} catch (error) {
  failed += 1;
  console.error('\nUNCAUGHT:', error.message, '\n', error.stack);
} finally {
  section('cleanup');
  await pool.query("DELETE FROM activities WHERE activity LIKE 'ZZTEST %'");
  for (const id of created.plans) await pool.query('DELETE FROM monthly_plans WHERE id = $1', [id]);
  for (const id of created.projects) await pool.query('DELETE FROM projects WHERE id = $1', [id]);
  await pool.query("DELETE FROM users WHERE username LIKE 'zz-ap-%'");
  // The Director's own notifications from this run, so a real Director does not
  // open the app to a bell full of test months.
  await pool.query("DELETE FROM notifications WHERE params->>'month' = $1 OR params->>'activity' LIKE 'ZZTEST %'", [MONTH]);
  console.log(`  removed ${created.plans.length} plans`);
  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
}
