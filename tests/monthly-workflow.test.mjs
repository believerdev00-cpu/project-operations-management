// End-to-end check of the monthly planning workflow, across all four business
// operations. Creates throwaway managers, drives the whole cycle over HTTP,
// then removes everything it made.

import bcrypt from 'bcryptjs';
import { pool } from '../server/db/database.js';
import { BUSINESS_OPERATIONS } from '../shared/businessOperations.js';
import { directorSession } from './director.mjs';
const API = process.env.API || 'http://localhost:5000';
const MONTH = '2099-09';

let passed = 0;
let failed = 0;
const created = { users: [], plans: [], activities: [] };

const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`); }
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

async function login(username, password) {
  const { status, body } = await api(null, '/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username, password })
  });
  if (status !== 200) throw new Error(`login ${username}: ${status} ${body.message}`);
  return body.token;
}

async function cleanup() {
  for (const id of created.plans) await pool.query('DELETE FROM monthly_plans WHERE id = $1', [id]);
  for (const id of created.activities) await pool.query('DELETE FROM activities WHERE id = $1', [id]);
  await pool.query("DELETE FROM activities WHERE activity LIKE 'ZZTEST %'");
  for (const id of created.users) {
    await pool.query(
      `UPDATE activities SET created_by=NULL, assigned_to=NULL, approval_required_from=NULL,
       approved_by=NULL, reviewed_by=NULL WHERE created_by=$1 OR assigned_to=$1
       OR approval_required_from=$1 OR approved_by=$1 OR reviewed_by=$1`, [id]);
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
  }
}

try {
  section('setup');
  const { token: adminToken } = await directorSession();
  const managers = {};
  for (const operation of BUSINESS_OPERATIONS) {
    const row = await pool.query(
      `INSERT INTO users (username, password_hash, name, role, sector)
       VALUES ($1, $2, $3, 'manager', $4) RETURNING id`,
      [`zz-mgr-${operation.id}`, bcrypt.hashSync('test-pass-123', 10), `ZZ ${operation.name} Manager`, operation.id]
    );
    created.users.push(row.rows[0].id);
    managers[operation.id] = { id: row.rows[0].id, token: await login(`zz-mgr-${operation.id}`, 'test-pass-123') };
  }
  // A team member in Farming. The manager assigns the day-by-day work to
  // people like this, which is the level the work actually happens at.
  const staffRow = await pool.query(
    `INSERT INTO users (username, password_hash, name, role, sector, manager_id)
     VALUES ($1, $2, $3, 'staff', 'farming', $4) RETURNING id`,
    [
      'zz-staff-farming', bcrypt.hashSync('test-pass-123', 10), 'ZZ Farming Field Worker',
      managers.farming.id
    ]
  );
  created.users.push(staffRow.rows[0].id);
  const farmingStaff = {
    id: staffRow.rows[0].id,
    token: await login('zz-staff-farming', 'test-pass-123')
  };
  console.log(`  four managers and one team member seeded for ${MONTH}`);

  // ---- 1 & 2: planning and confirmation, for all four operations ----------
  section('1-2. Monthly planning and confirmation, all four operations');
  const plans = {};
  // The Farming example from the specification, verbatim.
  const FARMING_PLAN = [
    ['Prepare 2 hectares of land', 800, 'High', '2099-09-15'],
    ['Buy fertilizer', 1200, 'High', '2099-09-20'],
    ['Buy farming tools', 500, 'Medium', '2099-09-22'],
    ['Transport materials', 500, 'Low', '2099-09-25']
  ];

  for (const operation of BUSINESS_OPERATIONS) {
    const created1 = await api(adminToken, '/api/monthly-plans', {
      method: 'POST',
      body: JSON.stringify({
        operation: operation.id, month: MONTH, managerId: managers[operation.id].id,
        // The Director states the budget they approve for the month. It used to
        // be worked out from the activities at confirmation, so nobody ever set
        // one and the month could not be over it.
        approvedBudget: operation.id === 'farming' ? 4000 : 1000,
        category: 'Planned work',
        objective: `ZZTEST objectives for ${operation.name}.`
      })
    });
    check(`create a ${operation.name} plan`, created1.status === 201, JSON.stringify(created1.body).slice(0, 160));
    if (created1.status !== 201) continue;
    plans[operation.id] = created1.body;
    created.plans.push(created1.body.id);
    check(`  status is Draft`, created1.body.status === 'Draft', created1.body.status);
    check(`  names the manager`, created1.body.managerId === managers[operation.id].id);
    check(`  carries the budget the Director approved`,
      created1.body.approvedBudget === (operation.id === 'farming' ? 4000 : 1000),
      String(created1.body.approvedBudget));
    check(`  and what the month is for`, created1.body.objective.startsWith('ZZTEST objectives'), created1.body.objective);

    const rows = operation.id === 'farming'
      ? FARMING_PLAN
      : [[`ZZTEST ${operation.name} task A`, 600, 'High', '2099-09-15'], [`ZZTEST ${operation.name} task B`, 400, 'Medium', null]];
    for (const [name, budget, priority, deadline] of rows) {
      const added = await api(adminToken, `/api/monthly-plans/${created1.body.id}/activities`, {
        method: 'POST',
        body: JSON.stringify({
          activity: operation.id === 'farming' ? `ZZTEST ${name}` : name,
          category: 'Planned work', description: 'Automated monthly-plan test.',
          approvedBudget: budget, priority, deadline, adminNote: 'From the planning meeting.'
        })
      });
      if (added.status !== 201) check(`  add "${name}"`, false, JSON.stringify(added.body).slice(0, 160));
    }
  }

  const duplicate = await api(adminToken, '/api/monthly-plans', {
    method: 'POST', body: JSON.stringify({ operation: 'farming', month: MONTH, managerId: managers.farming.id })
  });
  check('a second plan for the same operation+month is refused', duplicate.status === 409,
    `${duplicate.status} ${duplicate.body.message}`);

  const farmingId = plans.farming.id;
  const beforeConfirm = (await api(adminToken, `/api/monthly-plans/${farmingId}`)).body;
  check('the four Farming activities are listed', beforeConfirm.activities.length === 4,
    String(beforeConfirm.activities.length));
  check('the planned total is $3,000 (800+1200+500+500)', beforeConfirm.plan.plannedBudget === 3000,
    String(beforeConfirm.plan.plannedBudget));
  check('  $3,000 of the $4,000 is committed', beforeConfirm.plan.committedBudget === 3000,
    String(beforeConfirm.plan.committedBudget));
  check('  leaving $1,000 uncommitted', beforeConfirm.plan.uncommittedBudget === 1000,
    String(beforeConfirm.plan.uncommittedBudget));

  // The ceiling, at the planning stage: $1,000 is free, so $1,500 of new work
  // does not fit and the refusal names the figure.
  const tooBig = await api(adminToken, `/api/monthly-plans/${farmingId}/activities`, {
    method: 'POST',
    body: JSON.stringify({
      activity: 'ZZTEST oversized', category: 'Planned work', description: 'More than the month has.',
      approvedBudget: 1500, priority: 'Low'
    })
  });
  check('work beyond the approved budget is refused', tooBig.status === 400, String(tooBig.status));
  check('  and the message names what is left',
    tooBig.body.message === 'This activity exceeds the remaining monthly budget of $1,000.00.',
    tooBig.body.message);
  check('  a description is required on a planned activity',
    (await api(adminToken, `/api/monthly-plans/${farmingId}/activities`, {
      method: 'POST',
      body: JSON.stringify({ activity: 'ZZTEST no description', category: 'Planned work', approvedBudget: 10 })
    })).status === 400);

  const confirmed = await api(adminToken, `/api/monthly-plans/${farmingId}/confirm`, { method: 'POST' });
  check('the Director can confirm the plan', confirmed.status === 200, JSON.stringify(confirmed.body).slice(0, 160));
  check('  status becomes Confirmed', confirmed.body.status === 'Confirmed', confirmed.body.status);
  check('  the approved allocation is the Director\'s $4,000', confirmed.body.approvedBudget === 4000,
    String(confirmed.body.approvedBudget));
  check('  confirming does not rewrite it from the activities', confirmed.body.committedBudget === 3000,
    String(confirmed.body.committedBudget));
  check('  it is not confirmable twice', (await api(adminToken, `/api/monthly-plans/${farmingId}/confirm`, { method: 'POST' })).status === 409);

  // Confirm the rest so every operation is exercised end to end.
  for (const operation of BUSINESS_OPERATIONS) {
    if (operation.id === 'farming') continue;
    const result = await api(adminToken, `/api/monthly-plans/${plans[operation.id].id}/confirm`, { method: 'POST' });
    check(`confirm the ${operation.name} plan ($1,000)`, result.status === 200 && result.body.approvedBudget === 1000,
      `${result.status} ${result.body.approvedBudget}`);
  }

  section('NO money movement anywhere in the workflow');
  const planShape = JSON.stringify(confirmed.body).toLowerCase();
  const banned = ['transaction', 'transfer', 'wallet', 'gateway', 'payout', 'disburse'];
  check('the confirmed plan exposes no payment concepts',
    !banned.some((word) => planShape.includes(word)),
    banned.filter((w) => planShape.includes(w)).join(', '));
  const history = (await api(adminToken, `/api/monthly-plans/${farmingId}`)).body.history;
  const confirmEntry = history.find((entry) => entry.action === 'Plan confirmed');
  check('the trail records an allocation, not a payment',
    confirmEntry && /outside the platform/i.test(confirmEntry.note), confirmEntry?.note);

  // ---- 3: the manager sees only their own month --------------------------
  section('3. The manager sees only their own activities');
  const farmingManager = managers.farming;
  const managerView = await api(farmingManager.token, `/api/monthly-plans/${farmingId}`);
  check('the Farming manager can open their plan', managerView.status === 200, String(managerView.status));
  check('  sees four activities', managerView.body.activities.length === 4, String(managerView.body.activities.length));
  check('  the manager sees the budget the Director approved, $4,000',
    managerView.body.plan.approvedBudget === 4000, String(managerView.body.plan.approvedBudget));
  check('  and how much of it is already committed, $3,000',
    managerView.body.plan.committedBudget === 3000, String(managerView.body.plan.committedBudget));
  check('  every activity is assigned to them',
    managerView.body.activities.every((a) => a.assignedTo === farmingManager.id));

  const otherPlan = await api(managers.mining.token, `/api/monthly-plans/${farmingId}`);
  check('a Mining manager cannot open the Farming plan', [403, 404].includes(otherPlan.status),
    `${otherPlan.status} ${otherPlan.body.message}`);
  const managerList = await api(farmingManager.token, `/api/monthly-plans?month=${MONTH}`);
  check('a manager\'s plan list holds only their own operation',
    managerList.body.every((plan) => plan.operation === 'farming'),
    [...new Set(managerList.body.map((p) => p.operation))].join(','));

  // ---- 4: the manager works from the plan, and only from it ---------------
  section('4. The manager assigns the day-by-day work inside the approved plan');
  const managerAdd = await api(farmingManager.token, `/api/monthly-plans/${farmingId}/activities`, {
    method: 'POST',
    body: JSON.stringify({ activity: 'ZZTEST sneaky', category: 'X', description: 'x', approvedBudget: 5000 })
  });
  check('a manager cannot add a planned activity of their own', managerAdd.status === 403,
    `${managerAdd.status} ${managerAdd.body.message}`);

  // What they CAN do: break a planned activity into the days that will finish it.
  const landPrep = managerView.body.activities.find((a) => a.activity.includes('Prepare 2 hectares'));
  check('the planned activity is $800 with nothing committed to work yet',
    landPrep.approvedBudget === 800 && landPrep.committedToWork === 0 && landPrep.workCount === 0,
    `${landPrep.approvedBudget} / ${landPrep.committedToWork} / ${landPrep.workCount}`);

  const workUrl = `/api/monthly-plans/${farmingId}/activities/${landPrep.id}/work`;
  const day1 = await api(farmingManager.token, workUrl, {
    method: 'POST',
    body: JSON.stringify({
      activity: 'ZZTEST clear the north half', description: 'Clear and burn the scrub on the north half.',
      scheduledFor: '2099-09-03', assignedTo: farmingStaff.id, budget: 300, notes: 'Start at first light.'
    })
  });
  check('the manager assigns a day of work to a team member', day1.status === 201,
    JSON.stringify(day1.body).slice(0, 200));
  const dayIds = [day1.body.id];
  const plannedAfterDay1 = day1.body.activities.find((a) => a.id === landPrep.id);
  check('  it hangs under the planned activity', plannedAfterDay1.work.length === 1,
    String(plannedAfterDay1.work.length));
  check('  with its day, its description and the person doing it',
    plannedAfterDay1.work[0].scheduledFor === '2099-09-03'
      && plannedAfterDay1.work[0].description === 'Clear and burn the scrub on the north half.'
      && plannedAfterDay1.work[0].assignedTo === farmingStaff.id,
    JSON.stringify(plannedAfterDay1.work[0]).slice(0, 200));
  check('  $300 of the planned activity\'s $800 is now committed',
    plannedAfterDay1.committedToWork === 300 && plannedAfterDay1.uncommitted === 500,
    `${plannedAfterDay1.committedToWork} / ${plannedAfterDay1.uncommitted}`);
  check('  and the planned activity is under way', plannedAfterDay1.status === 'In Progress',
    plannedAfterDay1.status);
  check('  the month\'s committed total is unchanged at $3,000',
    day1.body.plan.committedBudget === 3000, String(day1.body.plan.committedBudget));

  const day2 = await api(farmingManager.token, workUrl, {
    method: 'POST',
    body: JSON.stringify({
      activity: 'ZZTEST plough the south half', description: 'Ox plough, two passes.',
      scheduledFor: '2099-09-05', assignedTo: farmingStaff.id, budget: 500, evidenceRequired: false
    })
  });
  check('a second day fills the planned activity exactly', day2.status === 201, String(day2.status));
  if (day2.status === 201) dayIds.push(day2.body.id);

  // The refusal the specification asks for, one level down.
  const day3 = await api(farmingManager.token, workUrl, {
    method: 'POST',
    body: JSON.stringify({
      activity: 'ZZTEST one day too many', description: 'Nothing left to pay for it.',
      scheduledFor: '2099-09-08', assignedTo: farmingStaff.id, budget: 1
    })
  });
  check('work beyond what the planned activity has left is refused', day3.status === 400, String(day3.status));
  check('  and the message names the $0.00 left',
    day3.body.message === 'This work exceeds the remaining budget of $0.00 on this planned activity.',
    day3.body.message);

  const noDescription = await api(farmingManager.token, workUrl, {
    method: 'POST',
    body: JSON.stringify({ activity: 'ZZTEST silent', scheduledFor: '2099-09-09', budget: 0 })
  });
  check('a day of work without a description is refused', noDescription.status === 400, noDescription.body.message);
  const noDay = await api(farmingManager.token, workUrl, {
    method: 'POST',
    body: JSON.stringify({ activity: 'ZZTEST undated', description: 'When?', budget: 0 })
  });
  check('a day of work without a date is refused', noDay.status === 400, noDay.body.message);
  const wrongMonth = await api(farmingManager.token, workUrl, {
    method: 'POST',
    body: JSON.stringify({ activity: 'ZZTEST next month', description: 'Outside the month.', scheduledFor: '2099-10-03', budget: 0 })
  });
  check('a day outside the month is refused', wrongMonth.status === 400, wrongMonth.body.message);
  const otherManagerWork = await api(managers.mining.token, workUrl, {
    method: 'POST',
    body: JSON.stringify({ activity: 'ZZTEST not mine', description: 'Another operation.', scheduledFor: '2099-09-04', budget: 0 })
  });
  check('a manager from another operation cannot assign work here',
    [403, 404].includes(otherManagerWork.status), String(otherManagerWork.status));

  // The team member carries it: it is theirs to start and to spend against.
  const staffWork = await api(farmingStaff.token, '/api/activities?limit=50');
  check('the team member sees the work assigned to them',
    staffWork.body.some((a) => a.id === day1.body.id), String(staffWork.status));
  const staffStart = await api(farmingStaff.token, `/api/activities/${day1.body.id}/status`, {
    method: 'PATCH', body: JSON.stringify({ status: 'In Progress' })
  });
  check('  and can start it', staffStart.status === 200, `${staffStart.status} ${staffStart.body.message}`);
  const staffSpend = await api(farmingStaff.token, `/api/activities/${day1.body.id}/expenses`, {
    method: 'POST',
    body: JSON.stringify({ amount: 280, spentOn: '2099-09-03', paymentMethod: 'Cash', description: 'Casual labour, four people.' })
  });
  check('  and record what it cost', staffSpend.status === 201, JSON.stringify(staffSpend.body).slice(0, 160));
  const staffOverspend = await api(farmingStaff.token, `/api/activities/${day1.body.id}/expenses`, {
    method: 'POST',
    body: JSON.stringify({ amount: 100, spentOn: '2099-09-03', paymentMethod: 'Cash', description: 'Over the day\'s budget.' })
  });
  check('  but not past the day\'s own budget', staffOverspend.status === 400, String(staffOverspend.status));

  // The Director watches the planned activity through the days underneath it.
  const oversight = (await api(adminToken, `/api/monthly-plans/${farmingId}`)).body;
  const watched = oversight.activities.find((a) => a.id === landPrep.id);
  check('the Director sees the work under each planned activity',
    watched.work.length === 2 && watched.workCount === 2, String(watched.work.length));
  check('  with progress towards finishing it', watched.workProgress === 0, String(watched.workProgress));
  check('  and the spend rolled up from the days', watched.spent === 280, String(watched.spent));
  check('  who each day is assigned to', watched.work.every((day) => day.assignedToName), '');
  const parentSpend = await api(adminToken, `/api/activities/${landPrep.id}/expenses`, {
    method: 'POST',
    body: JSON.stringify({ amount: 10, spentOn: '2099-09-04', paymentMethod: 'Cash', description: 'On the heading itself.' })
  });
  check('money is recorded on the day, not on the planned activity above it',
    parentSpend.status === 400, `${parentSpend.status} ${parentSpend.body.message}`);
  const deletePlanned = await api(adminToken, `/api/activities/${landPrep.id}`, { method: 'DELETE' });
  check('a planned activity with work under it cannot be deleted', deletePlanned.status === 409,
    `${deletePlanned.status} ${deletePlanned.body.message}`);

  // An activity a manager raises stays off-plan and spends none of the month.
  const raised = await api(farmingManager.token, '/api/activities', {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'PRJ-GISUMA', sector: 'farming', category: 'Tools', activity: 'ZZTEST off-plan request',
      description: 'Raised by the manager.', quantity: 1, costUsd: 400, costRwf: 580000, costCdf: 1140000
    })
  });
  created.activities.push(raised.body.id);
  check('a manager may still raise an off-plan request', raised.status === 201, String(raised.status));
  check('  it carries no monthly plan', raised.body.monthlyPlanId === null, String(raised.body.monthlyPlanId));
  const afterRaise = (await api(adminToken, `/api/monthly-plans/${farmingId}`)).body;
  check('  the approved allocation is unchanged at $4,000', afterRaise.plan.approvedBudget === 4000,
    String(afterRaise.plan.approvedBudget));
  check('  it is not in the plan\'s activities', !afterRaise.activities.some((a) => a.id === raised.body.id));

  // Attaching it is the Director's deliberate act, and it moves the total.
  const attachUnapproved = await api(adminToken, `/api/monthly-plans/${farmingId}/attach/${raised.body.id}`, { method: 'POST' });
  check('an unapproved activity cannot be attached', attachUnapproved.status === 400,
    `${attachUnapproved.status} ${attachUnapproved.body.message}`);
  await api(adminToken, `/api/activities/${raised.body.id}/approval`, {
    method: 'PATCH', body: JSON.stringify({ action: 'approve' })
  });
  const attached = await api(adminToken, `/api/monthly-plans/${farmingId}/attach/${raised.body.id}`, {
    method: 'POST', body: JSON.stringify({ reason: 'Agreed at mid-month review.' })
  });
  check('the Director can attach an approved off-plan activity', attached.status === 200, String(attached.status));
  check('  the approved budget is untouched at $4,000', attached.body.approvedBudget === 4000,
    String(attached.body.approvedBudget));
  check('  what grows is the committed figure, to $3,400', attached.body.committedBudget === 3400,
    String(attached.body.committedBudget));

  // ---- 5, 6, 8: expenses, evidence and the budget block ------------------
  section('5-6. Recording an actual expense');
  const fertilizer = managerView.body.activities.find((a) => a.activity.includes('fertilizer'));
  check('the fertilizer activity is budgeted at $1,200', fertilizer.approvedBudget === 1200, String(fertilizer.approvedBudget));

  const spend = await api(farmingManager.token, `/api/activities/${fertilizer.id}/expenses`, {
    method: 'POST',
    body: JSON.stringify({
      amount: 1050, spentOn: '2099-09-18', paymentMethod: 'Cash',
      description: 'Fertilizer for the two hectares.'
    })
  });
  check('the manager can record the expense', spend.status === 201, JSON.stringify(spend.body).slice(0, 200));
  check('  approved $1,200', spend.body.approvedBudget === 1200, String(spend.body.approvedBudget));
  check('  spent $1,050', spend.body.totalSpent === 1050, String(spend.body.totalSpent));
  check('  remaining $150 (automatically calculated)', spend.body.remaining === 150, String(spend.body.remaining));
  check('  the payment method is stored', spend.body.expense.paymentMethod === 'Cash', spend.body.expense.paymentMethod);
  check('  the date spent is stored', spend.body.expense.spentOn === '2099-09-18', spend.body.expense.spentOn);

  const missingFields = await api(farmingManager.token, `/api/activities/${fertilizer.id}/expenses`, {
    method: 'POST', body: JSON.stringify({ amount: 10 })
  });
  check('an expense without a date is refused', missingFields.status === 400, missingFields.body.message);

  section('8. The budget block');
  const overspend = await api(farmingManager.token, `/api/activities/${fertilizer.id}/expenses`, {
    method: 'POST',
    body: JSON.stringify({ amount: 300, spentOn: '2099-09-19', paymentMethod: 'Cash', description: 'Too much' })
  });
  check('an expense over the remaining budget is blocked', overspend.status === 400, String(overspend.status));
  check('  with the exact message the specification asks for',
    overspend.body.message === 'Expense exceeds the remaining approved budget. Submit a budget change request to Admin.',
    overspend.body.message);
  check('  and reports the remaining balance', overspend.body.remaining === 150, String(overspend.body.remaining));

  const exact = await api(farmingManager.token, `/api/activities/${fertilizer.id}/expenses`, {
    method: 'POST',
    body: JSON.stringify({ amount: 150, spentOn: '2099-09-19', paymentMethod: 'Mobile Money', description: 'The rest.' })
  });
  check('an expense of exactly the remaining balance is allowed', exact.status === 201, String(exact.status));
  check('  remaining is now $0', exact.body.remaining === 0, String(exact.body.remaining));
  const onePastZero = await api(farmingManager.token, `/api/activities/${fertilizer.id}/expenses`, {
    method: 'POST',
    body: JSON.stringify({ amount: 0.01, spentOn: '2099-09-19', paymentMethod: 'Cash', description: 'One cent over' })
  });
  check('  one cent past zero is blocked', onePastZero.status === 400, String(onePastZero.status));

  section('13. Security around expenses');
  const otherManagerSpend = await api(managers.mining.token, `/api/activities/${fertilizer.id}/expenses`, {
    method: 'POST', body: JSON.stringify({ amount: 10, spentOn: '2099-09-19', paymentMethod: 'Cash', description: 'x' })
  });
  check('another manager cannot record an expense', [403, 404].includes(otherManagerSpend.status),
    `${otherManagerSpend.status} ${otherManagerSpend.body.message}`);
  const managerDelete = await api(farmingManager.token, `/api/activities/${fertilizer.id}/expenses/${spend.body.expense.id}`, {
    method: 'DELETE'
  });
  check('a manager cannot delete a financial record', managerDelete.status === 403,
    `${managerDelete.status} ${managerDelete.body.message}`);
  const managerBudgetChange = await api(farmingManager.token, `/api/monthly-plans/${farmingId}`, {
    method: 'PATCH', body: JSON.stringify({ approvedBudget: 99999, reason: 'more please' })
  });
  check('a manager cannot change the approved allocation', managerBudgetChange.status === 403,
    `${managerBudgetChange.status} ${managerBudgetChange.body.message}`);

  // ---- 7: the two kinds of evidence --------------------------------------
  section('7. Payment evidence and activity evidence are separate');
  const upload = async (activityId, evidenceType, expenseId, name) => {
    const form = new FormData();
    form.append('kind', evidenceType === 'activity' ? 'Photograph' : 'Receipt');
    form.append('evidenceType', evidenceType);
    if (expenseId) form.append('expenseId', String(expenseId));
    form.append('note', name);
    form.append('files', new Blob([`test ${name}`], { type: 'image/png' }), `${name}.png`);
    const response = await fetch(`${API}/api/activities/${activityId}/evidence`, {
      method: 'POST', headers: { Authorization: `Bearer ${farmingManager.token}` }, body: form
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };

  const paymentEvidence = await upload(fertilizer.id, 'payment', spend.body.expense.id, 'receipt');
  check('payment evidence uploads against the expense', paymentEvidence.status === 201, JSON.stringify(paymentEvidence.body).slice(0, 160));
  check('  it is typed as payment', paymentEvidence.body[0]?.evidenceType === 'payment', paymentEvidence.body[0]?.evidenceType);
  check('  it names the expense', paymentEvidence.body[0]?.expenseId === spend.body.expense.id, String(paymentEvidence.body[0]?.expenseId));

  const hectares = managerView.body.activities.find((a) => a.activity.includes('hectares'));
  const activityEvidence = await upload(hectares.id, 'activity', null, 'after-photo');
  check('activity evidence uploads against the activity', activityEvidence.status === 201, String(activityEvidence.status));
  check('  it is typed as activity', activityEvidence.body[0]?.evidenceType === 'activity', activityEvidence.body[0]?.evidenceType);

  const badLink = await upload(hectares.id, 'activity', spend.body.expense.id, 'bad');
  check('activity evidence cannot be attached to an expense', badLink.status === 400, String(badLink.status));

  // ---- 9: the Director's monthly review ----------------------------------
  section('9. The Director\'s monthly review');
  const review = await api(adminToken, `/api/monthly-plans/review?month=${MONTH}`);
  check('the review loads', review.status === 200, String(review.status));
  check('  it covers all four business operations', review.body.operations.length === 4,
    String(review.body.operations.length));
  const farmingRow = review.body.operations.find((row) => row.operation === 'farming');
  check('  Farming shows the manager', Boolean(farmingRow.managerName), farmingRow.managerName);
  check('  approved $4,000', farmingRow.approvedBudget === 4000, String(farmingRow.approvedBudget));
  check('  committed $3,400', farmingRow.committedBudget === 3400, String(farmingRow.committedBudget));
  check('  spent $1,480', farmingRow.totalSpent === 1480, String(farmingRow.totalSpent));
  check('  remaining $2,520', farmingRow.remainingBalance === 2520, String(farmingRow.remainingBalance));
  check('  counts planned activities, not the days under them', farmingRow.activityCount === 5,
    String(farmingRow.activityCount));
  check('  and counts the days of work separately', farmingRow.workCount === 2, String(farmingRow.workCount));
  check('  flags expenses with no payment evidence', farmingRow.expensesWithoutEvidence === 2,
    String(farmingRow.expensesWithoutEvidence));
  check('  the four operations total correctly',
    review.body.totals.approvedBudget === 4000 + 1000 * 3, String(review.body.totals.approvedBudget));

  const managerReview = await api(managers.mining.token, `/api/monthly-plans/review?month=${MONTH}`);
  check('a manager\'s review shows only their own operation',
    managerReview.body.operations.length === 1 && managerReview.body.operations[0].operation === 'mining',
    managerReview.body.operations.map((o) => o.operation).join(','));

  // ---- 10: the Director changes the plan, with an audit trail ------------
  section('10. Changing the plan keeps an audit history');
  const tools = managerView.body.activities.find((a) => a.activity.includes('tools'));
  const noNote = await api(adminToken, `/api/activities/${tools.id}/decision`, {
    method: 'PATCH', body: JSON.stringify({ approvedBudget: 300 })
  });
  check('changing an activity budget without a reason is refused', noNote.status === 400, noNote.body.message);
  const changed = await api(adminToken, `/api/activities/${tools.id}/decision`, {
    method: 'PATCH',
    body: JSON.stringify({ approvedBudget: 300, adminNote: 'Reduce tool purchase.' })
  });
  check('the Director can change an activity budget', changed.status === 200, String(changed.status));
  check('  the new budget is $300', changed.body.approvedBudget === 300, String(changed.body.approvedBudget));
  const trail = (await api(adminToken, `/api/activities/${tools.id}/history`)).body;
  const budgetEntry = trail.find((entry) => entry.field === 'approvedBudget' && entry.oldValue === '500');
  check('  the old figure of $500 is kept in the trail', Boolean(budgetEntry),
    trail.map((e) => `${e.field}:${e.oldValue}->${e.newValue}`).join(' | ').slice(0, 200));
  check('  the reason is recorded', budgetEntry?.note === 'Reduce tool purchase.', budgetEntry?.note);

  const planChangeNoReason = await api(adminToken, `/api/monthly-plans/${farmingId}`, {
    method: 'PATCH', body: JSON.stringify({ approvedBudget: 3000 })
  });
  check('changing the allocation without a reason is refused', planChangeNoReason.status === 400,
    planChangeNoReason.body.message);
  // The tools activity was cut from $500 to $300 just above, so $3,200 is
  // committed. The allocation cannot be taken below that.
  const belowCommitted = await api(adminToken, `/api/monthly-plans/${farmingId}`, {
    method: 'PATCH', body: JSON.stringify({ approvedBudget: 1000, reason: 'Too low.' })
  });
  check('the allocation cannot go below what is already committed', belowCommitted.status === 400,
    belowCommitted.body.message);
  const planChanged = await api(adminToken, `/api/monthly-plans/${farmingId}`, {
    method: 'PATCH', body: JSON.stringify({ approvedBudget: 3600, reason: 'Trimmed after the tools change.' })
  });
  check('the allocation can be changed with a reason', planChanged.status === 200 && planChanged.body.approvedBudget === 3600,
    `${planChanged.status} ${planChanged.body.approvedBudget}`);
  const planTrail = (await api(adminToken, `/api/monthly-plans/${farmingId}`)).body.history;
  check('  the old allocation is kept in the plan trail',
    planTrail.some((e) => e.field === 'approvedBudget' && e.oldValue === '4000' && e.newValue === '3600'),
    planTrail.map((e) => `${e.field}:${e.oldValue}->${e.newValue}`).join(' | ').slice(0, 200));

  // ---- 11: the month-end report ------------------------------------------
  section('11. Month-end report');
  const noExplanation = await api(farmingManager.token, `/api/monthly-plans/${farmingId}/report`, {
    method: 'POST', body: JSON.stringify({})
  });
  check('a report with an unexplained balance is refused', noExplanation.status === 400, noExplanation.body.message);

  const report = await api(farmingManager.token, `/api/monthly-plans/${farmingId}/report`, {
    method: 'POST',
    body: JSON.stringify({
      unusedBalanceExplanation: 'Tools were cheaper than planned and transport is not yet done.',
      budgetDifferenceExplanation: 'Fertilizer came in at the budgeted figure.'
    })
  });
  check('the manager can submit the month-end report', report.status === 201, JSON.stringify(report.body).slice(0, 200));
  check('  it snapshots the approved budget', report.body.approvedBudget === 3600, String(report.body.approvedBudget));
  check('  it snapshots the spend', report.body.totalSpent === 1480, String(report.body.totalSpent));
  check('  it snapshots the remaining balance', report.body.remainingBalance === 2120, String(report.body.remainingBalance));
  check('  it counts both kinds of evidence',
    report.body.paymentEvidenceCount === 1 && report.body.activityEvidenceCount === 1,
    `payment ${report.body.paymentEvidenceCount}, activity ${report.body.activityEvidenceCount}`);

  const otherReport = await api(managers.mining.token, `/api/monthly-plans/${farmingId}/report`, {
    method: 'POST', body: JSON.stringify({ unusedBalanceExplanation: 'x' })
  });
  check('another manager cannot report on this plan', [403, 404].includes(otherReport.status),
    `${otherReport.status} ${otherReport.body.message}`);

  const returned = await api(adminToken, `/api/monthly-plans/${farmingId}/report`, {
    method: 'PATCH', body: JSON.stringify({ status: 'Returned', reviewNote: 'Attach the missing receipt.' })
  });
  check('the Director can return the report', returned.status === 200, String(returned.status));
  check('  the month is still open', returned.body.status === 'Confirmed', returned.body.status);

  await api(farmingManager.token, `/api/monthly-plans/${farmingId}/report`, {
    method: 'POST', body: JSON.stringify({ unusedBalanceExplanation: 'Corrected and resubmitted.' })
  });
  const accepted = await api(adminToken, `/api/monthly-plans/${farmingId}/report`, {
    method: 'PATCH', body: JSON.stringify({ status: 'Accepted', reviewNote: 'Accepted.' })
  });
  check('accepting the report closes the month', accepted.status === 200 && accepted.body.status === 'Closed',
    `${accepted.status} ${accepted.body.status}`);

  const spendAfterClose = await api(farmingManager.token, `/api/activities/${hectares.id}/expenses`, {
    method: 'POST', body: JSON.stringify({ amount: 5, spentOn: '2099-09-30', paymentMethod: 'Cash', description: 'late' })
  });
  check('no expense can be recorded against a closed month', spendAfterClose.status === 400,
    `${spendAfterClose.status} ${spendAfterClose.body.message}`);
  const editAfterClose = await api(adminToken, `/api/monthly-plans/${farmingId}/activities`, {
    method: 'POST', body: JSON.stringify({ activity: 'ZZTEST late', category: 'X', approvedBudget: 1 })
  });
  check('no activity can be added to a closed month', editAfterClose.status === 400,
    `${editAfterClose.status} ${editAfterClose.body.message}`);

  const reopened = await api(adminToken, `/api/monthly-plans/${farmingId}/reopen`, {
    method: 'POST', body: JSON.stringify({ reason: 'A late receipt arrived.' })
  });
  check('the Director can reopen a closed month', reopened.status === 200 && reopened.body.status === 'Confirmed',
    `${reopened.status} ${reopened.body.status}`);
  check('  reopening keeps the confirmed allocation', reopened.body.approvedBudget === 3600,
    String(reopened.body.approvedBudget));

  // ---- 12/14: no duplicate systems, no money movement ---------------------
  section('12/14. Data model and business model');
  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);
  const names = tables.rows.map((r) => r.table_name);
  check('the planned activities live in the existing activities table',
    names.includes('activities') && !names.some((n) => /planned_activit/.test(n)),
    names.filter((n) => n.includes('activit')).join(', '));
  check('no second user or manager table', !names.some((n) => /^(managers|admins|staff_users)$/.test(n)),
    names.join(', ').slice(0, 160));
  check('no payment, wallet or transaction table',
    !names.some((n) => /(payment|wallet|transaction|transfer|payout|gateway)/i.test(n)),
    names.filter((n) => /(payment|wallet|transaction|transfer|payout|gateway)/i.test(n)).join(', '));
  check('the new tables are the ones asked for',
    ['monthly_plans', 'monthly_reports', 'activity_expenses', 'monthly_plan_history'].every((n) => names.includes(n)));
  check('budget change requests reuse the existing table', names.includes('activity_budget_requests'));

  // ---- nothing else broke -------------------------------------------------
  section('Existing functionality still works');
  for (const [label, path] of [
    ['summary', '/api/summary'], ['activities', '/api/activities?limit=50'],
    ['approval queue', '/api/approval-queue'], ['movements', '/api/movements'],
    ['partners', '/api/partners'], ['sectors', '/api/sectors']
  ]) {
    const result = await api(adminToken, path);
    check(`the Director can still read ${label}`, result.status === 200, String(result.status));
  }
} catch (error) {
  failed += 1;
  console.error('\nUNCAUGHT:', error.message, '\n', error.stack);
} finally {
  section('cleanup');
  await cleanup();
  console.log(`  removed ${created.plans.length} plans, ${created.users.length} managers`);
  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
}
