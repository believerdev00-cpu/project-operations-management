// The month's money, the planned amounts, and how far the work has got.
//
//   1. an objective may carry a planned amount in USD, optional, validated,
//      saved and read back -- and never added to the approved budget;
//   2. the three figures: Approved Budget is the Director's ceiling, Actual
//      Spent is what was recorded, Remaining = Approved − Spent and goes
//      NEGATIVE (not zero) when spending passes the budget;
//   3. across several months, Remaining is taken only over the months with a
//      budget, and the spending of months with none is named separately --
//      on the review page and in the period report alike;
//   4. a project's completion comes from the objectives of the plans filed
//      under it, by the month rule (plain average, or weighted), leaves out
//      what cannot be counted, and says what is missing when nothing can be;
//   5. the project list is scoped: a team member is refused, a manager sees
//      only their own projects;
//   6. the month-by-month trend agrees with the period report for each month.
//
// Drives the live API against a real database and removes what it creates.

import bcrypt from 'bcryptjs';
import { pool } from '../server/db/database.js';
import { directorSession } from './director.mjs';
import { createProject, removeProject, PROJECT_IDS } from './fixtures.mjs';

const API = process.env.API || 'http://localhost:5000';
const MONTH = '2094-06';
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
const patch = (token, path, body) => api(token, path, { method: 'PATCH', body: JSON.stringify(body || {}) });
const get = (token, path) => api(token, path);

const created = { plans: [], users: [] };

async function account(username, name, role, sector) {
  const row = await pool.query(
    'INSERT INTO users (username, password_hash, name, role, sector) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [username, bcrypt.hashSync('test-pass-123', 10), name, role, sector]
  );
  created.users.push(row.rows[0].id);
  const login = await post(null, '/api/auth/login', { username, password: 'test-pass-123' });
  if (login.status !== 200) throw new Error(`login ${username}: ${login.status} ${login.body.message}`);
  return { id: row.rows[0].id, token: login.body.token };
}

try {
  section('setup');
  const { token: admin } = await directorSession();
  const farmer = await account('zz-pm-farm', 'ZZ Plan Money Farming Manager', 'manager', 'farming');
  const miner = await account('zz-pm-mine', 'ZZ Plan Money Mining Manager', 'manager', 'mining');
  const worker = await account('zz-pm-staff', 'ZZ Plan Money Worker', 'staff', 'farming');
  const farmProject = await createProject('farming', { managerId: farmer.id, name: 'ZZTEST Plan money farming' });
  const mineProject = await createProject('mining', { managerId: miner.id, name: 'ZZTEST Plan money mining' });
  await pool.query("DELETE FROM monthly_plans WHERE month = $1::date AND sector IN ('farming', 'agriculture')", [`${MONTH}-01`]);

  section('1. A planned amount per objective');
  const plan = await post(admin, '/api/monthly-plans', {
    operation: 'farming', month: MONTH, managerId: farmer.id, projectId: farmProject, approvedBudget: 1000,
    objectives: [
      { title: 'ZZTEST Train 20 young people', targetQuantity: 20, targetUnit: 'people', plannedAmount: 200 },
      { title: 'ZZTEST Visit 10 farms', targetQuantity: 10, targetUnit: 'visits' },
      { title: 'ZZTEST Provide the agreed support' }
    ]
  });
  check('a month is created with a planned amount on one objective', plan.status === 201, plan.body);
  created.plans.push(plan.body.id);
  const planId = plan.body.id;
  const read = async () => (await get(admin, `/api/monthly-plans/${planId}`)).body;
  let detail = await read();
  const [train, visit, support] = detail.objectives;
  check('  it is saved and read back in USD', train.plannedAmount === 200, train);
  check('  an objective that needs no money has none', visit.plannedAmount === null && support.plannedAmount === null);
  check('  the target and "counted in" keep their meaning', train.targetQuantity === 20 && train.targetUnit === 'people', train);
  check('  the planned amount is not added to the approved budget', detail.plan.approvedBudget === 1000, detail.plan.approvedBudget);
  const negative = await post(admin, `/api/monthly-plans/${planId}/objectives`, { title: 'ZZTEST bad', plannedAmount: -5 });
  check('a negative planned amount is refused', negative.status === 400, negative.body);
  const words = await post(admin, `/api/monthly-plans/${planId}/objectives`, { title: 'ZZTEST bad', plannedAmount: 'lots' });
  check('  so is one that is not a number', words.status === 400, words.body);
  const changed = await patch(admin, `/api/monthly-plans/${planId}/objectives/${train.id}`, { plannedAmount: 250 });
  detail = await read();
  check('the Director changes it to 250 and only it changes', changed.status === 200
    && detail.objectives[0].plannedAmount === 250 && detail.objectives[0].targetUnit === 'people' && detail.objectives[0].targetQuantity === 20, detail.objectives[0]);

  section('2. Approved, spent, remaining');
  await post(farmer.token, `/api/monthly-plans/${planId}/start`);
  const day1 = await post(farmer.token, `/api/monthly-plans/${planId}/reports`, { date: `${MONTH}-03`, objectiveId: train.id, quantityDone: 12, cost: 300, notes: 'ZZTEST first group trained' });
  check('a day of work costing $300 is recorded', day1.status === 201, day1.body);
  detail = await read();
  check('  spent is 300 and remaining 700', detail.plan.totalSpent === 300 && detail.plan.remainingBalance === 700, detail.plan);
  const over = await post(farmer.token, `/api/monthly-plans/${planId}/reports`, { date: `${MONTH}-04`, objectiveId: visit.id, quantityDone: 5, cost: 850, notes: 'ZZTEST visits' });
  check('a cost past the remaining budget is refused', over.status === 400 || over.status === 409, over.body);
  const fits = await post(farmer.token, `/api/monthly-plans/${planId}/reports`, { date: `${MONTH}-04`, objectiveId: visit.id, quantityDone: 5, cost: 700, notes: 'ZZTEST visits' });
  detail = await read();
  check('  exactly the remaining 700 is allowed, leaving 0', fits.status === 201 && detail.plan.remainingBalance === 0, detail.plan);
  // A month can still end overspent -- a cost recorded before a budget was
  // lowered, a correction -- so the figure must show it rather than hide it.
  await pool.query(
    "INSERT INTO plan_daily_reports (plan_id, objective_id, report_date, quantity_done, cost, notes) VALUES ($1, $2, $3, 0, 150, 'ZZTEST late invoice')",
    [planId, support.id, `${MONTH}-05`]
  );
  detail = await read();
  check('overspent by 150: remaining is −150, not 0', detail.plan.totalSpent === 1150 && detail.plan.remainingBalance === -150, detail.plan);

  section('3. Several months: remaining only over budgeted months');
  const loose = await post(admin, '/api/monthly-plans', { operation: 'agriculture', month: MONTH, approvedBudget: 0, objectives: [{ title: 'ZZTEST unbudgeted work' }] });
  created.plans.push(loose.body.id);
  await pool.query("INSERT INTO plan_daily_reports (plan_id, report_date, quantity_done, cost, notes) VALUES ($1, $2, 0, 40, 'ZZTEST')", [loose.body.id, `${MONTH}-06`]);
  const review = (await get(admin, `/api/monthly-plans/review?month=${MONTH}`)).body.totals;
  check('the overview: approved 1000, spent 1190', review.approvedBudget === 1000 && review.totalSpent === 1190, review);
  check('  remaining −150, from the budgeted month only', review.remainingBalance === -150, review.remainingBalance);
  check('  and the 40 spent with no budget is named', review.spentWithoutBudget === 40 && review.monthsWithoutBudget === 1, review);
  const report = (await get(admin, `/api/reports/activities?period=monthly&month=${MONTH}`)).body.monthlyWork.money;
  check('the period report says the same', report.budget === 1000 && report.spent === 1190 && report.remaining === -150 && report.spentWithoutBudget === 40, report);

  section('4. How far the project has got');
  let projects = (await get(admin, `/api/reports/projects?project=${farmProject}`)).body.projects;
  let mine = projects?.[0];
  check('the project reads 55%: 12/20 = 60% and 5/10 = 50%, the uncountable one left out',
    mine?.percent === 55 && mine.countable === 2 && mine.objectives === 3 && mine.plans === 1, mine);
  check('  each objective keeps its real figures', mine?.items?.find((i) => i.objectiveId === train.id)?.done === 12, mine?.items);
  check('  no money in it', !('spent' in (mine || {})) && !('budget' in (mine || {})));
  await patch(admin, `/api/monthly-plans/${planId}/objectives/${train.id}`, { weight: 3 });
  mine = (await get(admin, `/api/reports/projects?project=${farmProject}`)).body.projects[0];
  check('with a weight of 3 on training it reads 58% ((3×60 + 50) ÷ 4)', mine.percent === 58 && mine.weighted === true, mine);
  const empty = (await get(admin, `/api/reports/projects?project=${mineProject}`)).body.projects[0];
  check('a project with no plan has no percentage, and says why', empty?.percent === null && empty.missing === 'no_plans', empty);

  section('5. Who may read it');
  check('a team member is refused', (await get(worker.token, '/api/reports/projects')).status === 403);
  const minersView = (await get(miner.token, '/api/reports/projects')).body.projects || [];
  check('a manager sees only their own project', minersView.length >= 1 && minersView.every((p) => p.operation === 'mining') && !minersView.some((p) => p.id === farmProject), minersView.map((p) => p.id));
  const asked = await get(miner.token, `/api/reports/projects?project=${farmProject}`);
  check('  and asking for another operation’s project is refused', asked.status === 403, asked.status);

  section('6. Month by month agrees with the report');
  const trend = (await get(admin, '/api/reports/trends?months=3')).body.months || [];
  let agrees = trend.length === 3;
  for (const point of trend) {
    const month = (await get(admin, `/api/reports/activities?period=monthly&month=${point.month}`)).body.monthlyWork;
    if (month.summary.percent !== point.percent || month.money.budget !== point.approved || month.money.spent !== point.spent) agrees = false;
  }
  check('each of the last three months matches its own period report', agrees, trend);
  check('a team member cannot read the trend', (await get(worker.token, '/api/reports/trends')).status === 403);
} catch (error) {
  failed += 1;
  console.log(`  FAIL  unexpected error -- ${error.stack || error.message}`);
} finally {
  section('cleanup');
  for (const id of created.plans) await pool.query('DELETE FROM monthly_plans WHERE id = $1', [id]);
  await removeProject('farming');
  await removeProject('mining');
  if (created.users.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [created.users]);
  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
}
