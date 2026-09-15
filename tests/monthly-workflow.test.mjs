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
  console.log(`  four managers seeded for ${MONTH}`);

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
      body: JSON.stringify({ operation: operation.id, month: MONTH, managerId: managers[operation.id].id })
    });
    check(`create a ${operation.name} plan`, created1.status === 201, JSON.stringify(created1.body).slice(0, 160));
    if (created1.status !== 201) continue;
    plans[operation.id] = created1.body;
    created.plans.push(created1.body.id);
    check(`  status is Draft`, created1.body.status === 'Draft', created1.body.status);
    check(`  names the manager`, created1.body.managerId === managers[operation.id].id);

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

  const confirmed = await api(adminToken, `/api/monthly-plans/${farmingId}/confirm`, { method: 'POST' });
  check('the Director can confirm the plan', confirmed.status === 200, JSON.stringify(confirmed.body).slice(0, 160));
  check('  status becomes Confirmed', confirmed.body.status === 'Confirmed', confirmed.body.status);
  check('  the approved allocation is $3,000', confirmed.body.approvedBudget === 3000, String(confirmed.body.approvedBudget));
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
  check('  total approved budget is $3,000', managerView.body.plan.approvedBudget === 3000, String(managerView.body.plan.approvedBudget));
  check('  every activity is assigned to them',
    managerView.body.activities.every((a) => a.assignedTo === farmingManager.id));

  const otherPlan = await api(managers.mining.token, `/api/monthly-plans/${farmingId}`);
  check('a Mining manager cannot open the Farming plan', [403, 404].includes(otherPlan.status),
    `${otherPlan.status} ${otherPlan.body.message}`);
  const managerList = await api(farmingManager.token, `/api/monthly-plans?month=${MONTH}`);
  check('a manager\'s plan list holds only their own operation',
    managerList.body.every((plan) => plan.operation === 'farming'),
    [...new Set(managerList.body.map((p) => p.operation))].join(','));

  // ---- 4: managers cannot create plan activities -------------------------
  section('4. A manager cannot add activities to the approved plan');
  const managerAdd = await api(farmingManager.token, `/api/monthly-plans/${farmingId}/activities`, {
    method: 'POST', body: JSON.stringify({ activity: 'ZZTEST sneaky', category: 'X', approvedBudget: 5000 })
  });
  check('adding a plan activity is refused for a manager', managerAdd.status === 403,
    `${managerAdd.status} ${managerAdd.body.message}`);

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
  check('  the approved allocation is unchanged at $3,000', afterRaise.plan.approvedBudget === 3000,
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
  check('  the allocation grows to $3,400', attached.body.approvedBudget === 3400, String(attached.body.approvedBudget));

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
  check('  approved $3,400', farmingRow.approvedBudget === 3400, String(farmingRow.approvedBudget));
  check('  spent $1,200', farmingRow.totalSpent === 1200, String(farmingRow.totalSpent));
  check('  remaining $2,200', farmingRow.remainingBalance === 2200, String(farmingRow.remainingBalance));
  check('  counts activities', farmingRow.activityCount === 5, String(farmingRow.activityCount));
  check('  flags expenses with no payment evidence', farmingRow.expensesWithoutEvidence === 1,
    String(farmingRow.expensesWithoutEvidence));
  check('  the four operations total correctly',
    review.body.totals.approvedBudget === 3400 + 1000 * 3, String(review.body.totals.approvedBudget));

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
  const planChanged = await api(adminToken, `/api/monthly-plans/${farmingId}`, {
    method: 'PATCH', body: JSON.stringify({ approvedBudget: 3200, reason: 'Trimmed after the tools change.' })
  });
  check('the allocation can be changed with a reason', planChanged.status === 200 && planChanged.body.approvedBudget === 3200,
    `${planChanged.status} ${planChanged.body.approvedBudget}`);
  const planTrail = (await api(adminToken, `/api/monthly-plans/${farmingId}`)).body.history;
  check('  the old allocation is kept in the plan trail',
    planTrail.some((e) => e.field === 'approvedBudget' && e.oldValue === '3400' && e.newValue === '3200'),
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
  check('  it snapshots the approved budget', report.body.approvedBudget === 3200, String(report.body.approvedBudget));
  check('  it snapshots the spend', report.body.totalSpent === 1200, String(report.body.totalSpent));
  check('  it snapshots the remaining balance', report.body.remainingBalance === 2000, String(report.body.remainingBalance));
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
  check('  reopening keeps the confirmed allocation', reopened.body.approvedBudget === 3200,
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
