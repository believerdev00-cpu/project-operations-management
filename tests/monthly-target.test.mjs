// The month IS the work.
//
// The Director writes one objective for a business operation -- "prepare 1
// hectare and plant potatoes" -- with a target and a budget, and nothing else.
// No activity is assigned to anybody. The manager of that operation sees it in
// their portal because of the sector on their account, starts it, and reports
// each working day against the same record until the target is reached.
//
// This suite is the specification's own acceptance test, driven over HTTP.

import bcrypt from 'bcryptjs';
import { pool } from '../server/db/database.js';
import { directorSession } from './director.mjs';

const API = process.env.API || 'http://localhost:5000';
const MONTH = '2096-09';
const day = (n) => `${MONTH}-${String(n).padStart(2, '0')}`;

let passed = 0;
let failed = 0;
const created = { users: [], plans: [] };

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
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
const post = (token, path, body) => api(token, path, { method: 'POST', body: JSON.stringify(body || {}) });

async function login(username, password) {
  const { status, body } = await api(null, '/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username, password })
  });
  if (status !== 200) throw new Error(`login ${username}: ${status} ${body.message}`);
  return body.token;
}

try {
  section('setup');
  const { token: admin } = await directorSession();
  // A manager of Agriculture. Nothing links them to the plan except the sector
  // on their account -- which is the whole point of the workflow.
  const row = await pool.query(
    `INSERT INTO users (username, password_hash, name, role, sector)
     VALUES ($1, $2, $3, 'manager', 'agriculture') RETURNING id`,
    ['zz-tgt-agri', bcrypt.hashSync('test-pass-123', 10), 'ZZ Agriculture Manager']
  );
  created.users.push(row.rows[0].id);
  const manager = { id: row.rows[0].id, token: await login('zz-tgt-agri', 'test-pass-123') };
  // A manager of another operation, to prove the month is not theirs.
  const otherRow = await pool.query(
    `INSERT INTO users (username, password_hash, name, role, sector)
     VALUES ($1, $2, $3, 'manager', 'mining') RETURNING id`,
    ['zz-tgt-mining', bcrypt.hashSync('test-pass-123', 10), 'ZZ Mining Manager']
  );
  created.users.push(otherRow.rows[0].id);
  const otherManager = { id: otherRow.rows[0].id, token: await login('zz-tgt-mining', 'test-pass-123') };

  // ---- the Director writes the month ---------------------------------------
  section('The Director sets the month, and assigns nothing to anybody');
  await pool.query("DELETE FROM monthly_plans WHERE sector = 'agriculture' AND month = $1::date", [`${MONTH}-01`]);
  const plan = await post(admin, '/api/monthly-plans', {
    operation: 'agriculture', month: MONTH,
    objective: 'Prepare 1 hectare of land and plant potatoes.',
    targetQuantity: 1, targetUnit: 'hectare',
    expectedOutput: '1 hectare planted with potatoes',
    approvedBudget: 500
  });
  check('the month is created without naming a manager', plan.status === 201, JSON.stringify(plan.body).slice(0, 200));
  created.plans.push(plan.body.id);
  const planId = plan.body.id;
  check('  it carries the objective', plan.body.objectiveText.startsWith('Prepare 1 hectare'), plan.body.objectiveText);
  check('  the target and its unit', plan.body.targetQuantity === 1 && plan.body.targetUnit === 'hectare',
    `${plan.body.targetQuantity} ${plan.body.targetUnit}`);
  check('  the expected output', plan.body.expectedOutput === '1 hectare planted with potatoes', plan.body.expectedOutput);
  check('  the budget', plan.body.approvedBudget === 500, String(plan.body.approvedBudget));
  check('  nothing done yet', plan.body.quantityDone === 0 && plan.body.progressPercent === 0,
    `${plan.body.quantityDone} / ${plan.body.progressPercent}`);

  const badTarget = await post(admin, '/api/monthly-plans', {
    operation: 'mining', month: MONTH, targetQuantity: 5, approvedBudget: 10
  });
  check('a target with no unit is refused', badTarget.status === 400, badTarget.body.message);

  // No confirmation step: a month with a target and no activities is already the
  // manager's the moment the Director saves it.
  const live = await api(admin, `/api/monthly-plans/${planId}`);
  check('the month is live with no activities and no named manager',
    live.body.plan.status === 'Confirmed', `${live.status} ${live.body.plan?.status}`);
  check('  and reads as ready for the manager', live.body.plan.status === 'Confirmed', live.body.plan.status);

  // ---- the manager sees it, because of their sector -------------------------
  section('The Agriculture manager sees it automatically');
  const mine = await api(manager.token, `/api/monthly-plans?month=${MONTH}`);
  check('it is in their own month list', mine.status === 200 && mine.body.some((p) => p.id === planId),
    `${mine.status} ${JSON.stringify(mine.body.map((p) => p.operation))}`);
  const opened = await api(manager.token, `/api/monthly-plans/${planId}`);
  check('  and they can open it', opened.status === 200, String(opened.status));
  check('  with the target, the budget and nothing done',
    opened.body.plan.targetQuantity === 1 && opened.body.plan.quantityRemaining === 1
      && opened.body.plan.approvedBudget === 500,
    JSON.stringify(opened.body.plan).slice(0, 160));
  const notTheirs = await api(otherManager.token, `/api/monthly-plans/${planId}`);
  check('a manager of another operation cannot', [403, 404].includes(notTheirs.status), String(notTheirs.status));

  // ---- start, then report each day ------------------------------------------
  section('The manager starts, then reports day by day');
  const started = await post(manager.token, `/api/monthly-plans/${planId}/start`);
  check('they start the month', started.status === 200 && started.body.status === 'In Progress',
    `${started.status} ${started.body.status}`);
  const startedTwice = await post(manager.token, `/api/monthly-plans/${planId}/start`);
  check('  and cannot start it twice', startedTwice.status === 409, String(startedTwice.status));
  const notMyMonth = await post(otherManager.token, `/api/monthly-plans/${planId}/start`, {});
  check('  another operation\'s manager cannot start it', [403, 404].includes(notMyMonth.status), String(notMyMonth.status));

  const d1 = await post(manager.token, `/api/monthly-plans/${planId}/reports`, {
    date: day(1), quantityDone: 0.2, cost: 50, notes: 'Land preparation started.'
  });
  check('1 September: 0.2 hectare, $50', d1.status === 201, JSON.stringify(d1.body).slice(0, 200));
  check('  progress 20%, spent $50, 0.8 hectare left',
    d1.body.plan.progressPercent === 20 && d1.body.plan.totalSpent === 50 && d1.body.plan.quantityRemaining === 0.8,
    `${d1.body.plan.progressPercent}% / ${d1.body.plan.totalSpent} / ${d1.body.plan.quantityRemaining}`);

  // The rule the whole design turns on: a working day need not cost anything.
  const d2 = await post(manager.token, `/api/monthly-plans/${planId}/reports`, {
    date: day(2), quantityDone: 0.3, cost: 0, notes: 'Continued land preparation.'
  });
  check('2 September: 0.3 hectare, $0 -- a day with no cost is a valid day', d2.status === 201,
    JSON.stringify(d2.body).slice(0, 200));
  check('  progress 50%, still $50 spent, 0.5 hectare left',
    d2.body.plan.progressPercent === 50 && d2.body.plan.totalSpent === 50 && d2.body.plan.quantityRemaining === 0.5,
    `${d2.body.plan.progressPercent}% / ${d2.body.plan.totalSpent} / ${d2.body.plan.quantityRemaining}`);
  check('  and it is still In Progress, not finished', d2.body.plan.status === 'In Progress', d2.body.plan.status);

  // A day may also be nothing but a note -- "rained, no work" -- but a report
  // with nothing in it at all records nothing.
  const empty = await post(manager.token, `/api/monthly-plans/${planId}/reports`, { date: day(2), quantityDone: 0, cost: 0 });
  check('an entirely empty day is refused', empty.status === 400, empty.body.message);
  const noteOnly = await post(manager.token, `/api/monthly-plans/${planId}/reports`, {
    date: day(2), quantityDone: 0, cost: 0, notes: 'Rained all day, no work possible.'
  });
  check('a day of no work with a note is accepted', noteOnly.status === 201, noteOnly.body.message);

  // Over-completion cannot happen by accident.
  const tooMuch = await post(manager.token, `/api/monthly-plans/${planId}/reports`, {
    date: day(3), quantityDone: 0.9, cost: 0
  });
  check('reporting past the target is refused', tooMuch.status === 400, String(tooMuch.status));
  check('  and the refusal names what is left', /0\.5 hectare/.test(tooMuch.body.message || ''), tooMuch.body.message);

  // And so does spending past the budget.
  const tooDear = await post(manager.token, `/api/monthly-plans/${planId}/reports`, {
    date: day(3), quantityDone: 0.1, cost: 5000
  });
  check('spending past the month\'s budget is refused', tooDear.status === 400, tooDear.body.message);

  const outside = await post(manager.token, `/api/monthly-plans/${planId}/reports`, {
    date: '2096-10-03', quantityDone: 0.1, cost: 0
  });
  check('a day outside the month is refused', outside.status === 400, outside.body.message);

  const d3 = await post(manager.token, `/api/monthly-plans/${planId}/reports`, {
    date: day(3), quantityDone: 0.5, cost: 100, notes: 'Land preparation completed.'
  });
  check('3 September: 0.5 hectare, $100', d3.status === 201, JSON.stringify(d3.body).slice(0, 200));
  check('  progress 100%, spent $150, nothing left',
    d3.body.plan.progressPercent === 100 && d3.body.plan.totalSpent === 150 && d3.body.plan.quantityRemaining === 0,
    `${d3.body.plan.progressPercent}% / ${d3.body.plan.totalSpent} / ${d3.body.plan.quantityRemaining}`);
  check('  and reaching the target completes the month', d3.body.plan.status === 'Completed', d3.body.plan.status);

  // ---- proof of a particular day --------------------------------------------
  section('Proof belongs to the day it was taken on');
  const firstDay = d3.body.dailyReports.find((r) => r.date === day(1));
  const form = new FormData();
  form.append('kind', 'Photograph');
  form.append('files', new Blob(['ZZTEST field photo'], { type: 'image/png' }), 'field.png');
  const uploaded = await fetch(`${API}/api/monthly-plans/${planId}/reports/${firstDay.id}/evidence`, {
    method: 'POST', headers: { Authorization: `Bearer ${manager.token}` }, body: form
  });
  check('the manager attaches a photo to 1 September', uploaded.status === 201, String(uploaded.status));
  const withProof = await api(manager.token, `/api/monthly-plans/${planId}`);
  const dayOne = withProof.body.dailyReports.find((r) => r.date === day(1));
  check('  it is attached to that day, not to the month in general',
    dayOne.evidence.length === 1 && dayOne.evidence[0].originalName === 'field.png',
    JSON.stringify(dayOne.evidence).slice(0, 160));
  const file = await fetch(`${API}${dayOne.evidence[0].path}`, { headers: { Authorization: `Bearer ${manager.token}` } });
  check('  and it can be read back', file.status === 200, String(file.status));
  const stranger = await fetch(`${API}${dayOne.evidence[0].path}`, { headers: { Authorization: `Bearer ${otherManager.token}` } });
  check('  but not by another operation\'s manager', [403, 404].includes(stranger.status), String(stranger.status));

  // ---- what the Director sees -----------------------------------------------
  section('The Director reviews the same month');
  const review = await api(admin, `/api/monthly-plans/${planId}`);
  const seen = review.body.plan;
  check('target 1 hectare', seen.targetQuantity === 1 && seen.targetUnit === 'hectare', String(seen.targetQuantity));
  check('completed 1 hectare', seen.quantityDone === 1, String(seen.quantityDone));
  check('progress 100%', seen.progressPercent === 100, String(seen.progressPercent));
  check('days worked 4', seen.daysWorked === 4, String(seen.daysWorked));
  check('total spent $150', seen.totalSpent === 150, String(seen.totalSpent));
  check('budget remaining $350', seen.remainingBalance === 350, String(seen.remainingBalance));
  check('status Completed', seen.status === 'Completed', seen.status);

  const history = review.body.dailyReports;
  check('the Director can read every day the manager reported', history.length === 4, String(history.length));
  const first = history.find((r) => r.date === day(1));
  check('  with the work, the cost and the note of each',
    first.quantityDone === 0.2 && first.cost === 50 && first.notes.startsWith('Land preparation started'),
    JSON.stringify(first).slice(0, 160));
  check('  and who submitted it', first.submittedByName === 'ZZ Agriculture Manager', first.submittedByName);

  // Only the Director removes a day, and the month's figures follow it back.
  const managerRemoves = await api(manager.token, `/api/monthly-plans/${planId}/reports/${first.id}`, { method: 'DELETE' });
  check('a manager cannot remove a day they reported', managerRemoves.status === 403, String(managerRemoves.status));
  const directorRemoves = await api(admin, `/api/monthly-plans/${planId}/reports/${first.id}`, {
    method: 'DELETE', body: JSON.stringify({ reason: 'Reported twice by mistake.' })
  });
  check('the Director can', directorRemoves.status === 200, String(directorRemoves.status));
  check('  and the month falls back to 0.8 hectare and $100',
    directorRemoves.body.plan.quantityDone === 0.8 && directorRemoves.body.plan.totalSpent === 100,
    `${directorRemoves.body.plan.quantityDone} / ${directorRemoves.body.plan.totalSpent}`);

  // ---- a month with no countable target still works -------------------------
  section('A month without a countable target');
  await pool.query("DELETE FROM monthly_plans WHERE sector = 'mining' AND month = $1::date", [`${MONTH}-01`]);
  const loose = await post(admin, '/api/monthly-plans', {
    operation: 'mining', month: MONTH, objective: 'Keep the haulage road usable.', approvedBudget: 200
  });
  check('it is created without a target', loose.status === 201, JSON.stringify(loose.body).slice(0, 160));
  created.plans.push(loose.body.id);
  check('  and has no percentage to show', loose.body.progressPercent === null, String(loose.body.progressPercent));
  await post(admin, `/api/monthly-plans/${loose.body.id}/confirm`);
  const looseDay = await post(otherManager.token, `/api/monthly-plans/${loose.body.id}/reports`, {
    date: day(4), quantityDone: 0, cost: 30, notes: 'Filled the worst of the potholes.'
  });
  check('  a day can still be reported against it', looseDay.status === 201, JSON.stringify(looseDay.body).slice(0, 160));
  check('  and it stays In Progress rather than completing itself',
    looseDay.body.plan.status === 'In Progress', looseDay.body.plan.status);
} catch (error) {
  failed += 1;
  console.error('\nUNCAUGHT:', error.message, '\n', error.stack);
} finally {
  section('cleanup');
  for (const id of created.plans) await pool.query('DELETE FROM monthly_plans WHERE id = $1', [id]);
  await pool.query("DELETE FROM users WHERE username LIKE 'zz-tgt-%'");
  console.log(`  removed ${created.plans.length} plans`);
  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
}
