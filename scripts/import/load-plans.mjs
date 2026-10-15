// Load the monthly plans built by `plans-from-workbook.mjs` into a running
// deployment, THROUGH THE API, as the people who would have typed them: the
// Director writes each month and its approved budget, and the operation's own
// manager records every day against it.
//
//   node scripts/import/load-plans.mjs plans.json                    # local
//   node scripts/import/load-plans.mjs plans.json https://host       # a deployment
//   node scripts/import/load-plans.mjs plans.json https://host --check   # writes nothing
//
// Nothing is written straight to the tables. Every row that lands has passed
// the checks a live entry passes -- the budget ceiling under a FOR UPDATE lock,
// the objective's remaining target, the month a day belongs to, and who is
// allowed to record it at all. An import that bypassed those would prove
// nothing about whether the data is enterable, which is the point of loading it
// this way rather than with INSERTs.
//
// Reads DATABASE_URL's neighbours from the environment: JWT_SECRET to mint the
// sessions and ADMIN_PASSWORD for a first sign-in. Locally those come from
// .env.local; for a deployment, pull them with
//   npx vercel env pull <somewhere outside the repo> --environment=production
// and point ENV_FILE at that file. Never pull them into .env.local itself --
// that is your local database configuration and the pull overwrites it.
import jwt from 'jsonwebtoken';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { blockers, compareMonth } from './compare.mjs';

// --check reads the deployment and WRITES NOTHING: it says, month by month,
// what is already in there and what this file would add. Run it before an
// import that may have been run before, and after one that died half way.
const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');
const [plansPath, apiArgument] = argv.filter((argument) => !argument.startsWith('--'));
if (!plansPath) {
  console.error('usage: node scripts/import/load-plans.mjs <plans.json> [api-base-url] [--check]');
  process.exit(1);
}
const API = (apiArgument || process.env.API || 'http://localhost:5000').replace(/\/$/, '');
const plans = JSON.parse(readFileSync(plansPath, 'utf8'));

const env = { ...process.env };
for (const line of readFileSync(process.env.ENV_FILE || '.env.local', 'utf8').split(/\r?\n/)) {
  const match = /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(line);
  if (match && !env[match[1]]) env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
}
if (!env.JWT_SECRET) throw new Error('JWT_SECRET is not set; see the note at the top of this file');

const OPERATION_NAME = {
  farming: 'Farming & Movement',
  agriculture: 'Agriculture',
  mining: 'Mining',
  movement: 'Movement & Facilitation'
};

// One project per operation, named from the places the workbooks record. A
// project is optional on a monthly plan; these exist so every operation has one
// with its manager on it.
const PROJECTS = {
  farming: { name: 'Gisuma Farm', location: 'Gisuma', owner: 'Gisuma Operations', category: 'Infrastructure' },
  agriculture: { name: 'Gisuma Agriculture', location: 'Gisuma', owner: 'Gisuma Operations', category: 'Crop production' },
  mining: { name: 'Rubaya Mining', location: 'Rubaya', owner: 'Gisuma Operations', category: 'Extraction' },
  movement: { name: 'Rubaya & Gisuma Facilitation', location: 'Goma, Rubavu, Rubaya, Gisuma', owner: 'Gisuma Operations', category: 'Logistics' }
};

// A manager for any operation that has none. Only the missing ones are created,
// so this is a no-op against a database that already has them. All four are
// listed because a fresh deployment has none at all -- the first migration
// seeds the Director and nobody else.
//
// The password is temporary in the product's own sense: the account is reset at
// the end of the run so the person who takes it over chooses their own.
const NEW_MANAGERS = {
  mining: { username: 'Believer00', name: 'NDAYISHIMIYE BELIEVER' },
  farming: { username: 'sammy00', name: 'samy uwimana' },
  agriculture: { username: 'agri00', name: 'Agriculture Manager' },
  movement: { username: 'move00', name: 'Facilitation Manager' }
};

const password = () => `Gs${randomBytes(9).toString('base64url')}`;

// A month of the workbook is several hundred round trips, and against a
// deployment rather than localhost an ordinary connection drops one sooner or
// later: this import died twice on UND_ERR_CONNECT_TIMEOUT, once before it had
// written anything and once with four of the twelve months in, which is the
// worst of the two because the rest then has to be worked out by hand.
//
// Only connect-phase failures are retried, and that distinction is the whole
// point. A connection that was never established carries no request, so
// sending it again cannot record a second day's work. A socket that dies with
// the request already on its way might have been answered, and repeating a
// POST on that guess is how an import quietly doubles a figure -- those are
// left to fail loudly instead.
const NEVER_ARRIVED = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

async function call(method, path, body, token, attempt = 1) {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (networkError) {
    const code = networkError.cause?.code || networkError.code;
    if (!NEVER_ARRIVED.has(code) || attempt >= 5) throw networkError;
    const pause = 500 * 2 ** (attempt - 1);
    console.warn(`${method} ${path} never reached the server (${code}); trying again in ${pause}ms`);
    await new Promise((resolve) => setTimeout(resolve, pause));
    return call(method, path, body, token, attempt + 1);
  }
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 300) }; }
  return { status: response.status, body: parsed };
}

const fail = (what, result) => {
  throw new Error(`${what} -> ${result.status} ${JSON.stringify(result.body).slice(0, 400)}`);
};

const health = await call('GET', '/api/health');
if (health.status !== 200) throw new Error(`the API is not answering on ${API}: ${JSON.stringify(health.body)}`);

// THE DIRECTOR'S SESSION, TWO WAYS.
//
// On a database that has been used, the Director's password is their own and
// was changed long ago; resetting it to run an import would end their sessions
// and lock them out, so the session is minted from the server's own JWT_SECRET
// instead, carrying nothing but the account id exactly as a sign-in would.
//
// On a FRESH database -- a first deployment -- that does not work: the seeded
// Director is held at must_change_password, and authMiddleware answers every
// route except the session and the password with 403 PASSWORD_CHANGE_REQUIRED.
// A minted token is refused the same as any other. So the first sign-in happens
// here, with the ADMIN_PASSWORD the migration seeded, and a password is chosen
// the way the real Director would choose one -- which is also what clears the
// flag. That password is printed at the end and nobody else holds it.
let admin = jwt.sign({ id: Number(process.env.ADMIN_ID || 1) }, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '2h' });
let session = await call('GET', '/api/auth/session', undefined, admin);
let directorPassword = null;
// The session route is one of the few authMiddleware lets through while the
// flag is set -- that is what lets the client draw ChoosePasswordScreen -- so a
// fresh deployment answers 200 here and 403 PASSWORD_CHANGE_REQUIRED on every
// route this script actually needs. Keyed on the status alone, the import read
// that 200 as "a database in use", skipped the sign-in below, and died on the
// first real call with the accounts unread. The flag the route hands back is
// the thing to ask.
if (session.status === 401 || session.status === 403 || session.body?.code === 'PASSWORD_CHANGE_REQUIRED'
  || session.body?.user?.mustChangePassword) {
  // Choosing the Director's password is a write, and --check does not write.
  // There is nothing to compare either: a deployment still holding the seeded
  // password has never had an import run against it.
  if (CHECK_ONLY) {
    console.log(`${API} is a new deployment -- nothing has been imported into it yet.`);
    console.log('every month in this file would be created in full:\n');
    for (const plan of plans) {
      const days = plan.objectives.reduce((sum, objective) => sum + objective.days.length, 0);
      console.log(`  ${OPERATION_NAME[plan.operation]} / ${plan.month}: `
        + `${plan.objectives.length} objectives, ${days} days, $${plan.approvedBudget.toFixed(2)}`);
    }
    process.exit(0);
  }
  if (!env.ADMIN_PASSWORD) fail('the Director session (and no ADMIN_PASSWORD to sign in with)', session);
  const first = await call('POST', '/api/auth/login', { username: 'admin', password: env.ADMIN_PASSWORD });
  if (first.status !== 200) fail('the Director first sign-in', first);
  directorPassword = password();
  const chosen = await call('POST', '/api/auth/password',
    { currentPassword: env.ADMIN_PASSWORD, newPassword: directorPassword }, first.body.token);
  if (chosen.status !== 200) fail('choosing the Director password', chosen);
  admin = chosen.body.token;
  session = await call('GET', '/api/auth/session', undefined, admin);
  console.log('this database is new: signed the Director in and chose a password');
}
if (session.status !== 200) fail('the Director session', session);
if (session.body.user?.role !== 'super-admin') {
  throw new Error(`account ${process.env.ADMIN_ID || 1} is ${session.body.user?.role}, not the Director`);
}
console.log(`acting as the Director (${session.body.user.username}) on ${API}`);

// ------------------------------------------- what is already in this database
//
// Every month in the file is read back before anything is written and compared
// with it day by day, so the run adds only what is absent and nothing already
// recorded is posted a second time. The comparison itself is in compare.mjs,
// with a test that needs no database -- it is what decides whether a figure is
// recorded twice.
const verdicts = new Map();
for (const plan of plans) {
  const found = await call('GET',
    `/api/monthly-plans?operation=${encodeURIComponent(plan.operation)}&month=${encodeURIComponent(plan.month)}`,
    undefined, admin);
  if (found.status !== 200) fail(`looking for ${plan.operation}/${plan.month}`, found);
  const existing = (found.body || []).find((row) => row.month === plan.month && row.operation === plan.operation);
  let detail = null;
  if (existing) {
    const read = await call('GET', `/api/monthly-plans/${existing.id}`, undefined, admin);
    if (read.status !== 200) fail(`reading back ${plan.operation}/${plan.month}`, read);
    detail = read.body;
  }
  verdicts.set(`${plan.operation}/${plan.month}`, compareMonth(plan, existing || null, detail));
}

if (CHECK_ONLY) {
  console.log(`\nnothing was written. ${plans.length} months in this file, against ${API}:\n`);
  let absent = 0;
  let fillable = 0;
  let settled = 0;
  let held = 0;
  for (const plan of plans) {
    const verdict = verdicts.get(`${plan.operation}/${plan.month}`);
    const head = `${OPERATION_NAME[plan.operation]} / ${plan.month}`;
    if (verdict.state === 'absent') {
      absent += 1;
      console.log(`  ${head}: NOT THERE -- would be created with ${plan.objectives.length} objectives, `
        + `${verdict.fileDays} days, $${verdict.fileMoney.toFixed(2)}`);
      continue;
    }
    if (verdict.state === 'complete') {
      settled += 1;
      console.log(`  ${head}: all ${verdict.fileDays} days already recorded (plan ${verdict.planId}) -- nothing to add`);
      continue;
    }
    const reasons = blockers(plan, verdict);
    if (reasons.length) {
      held += 1;
      console.log(`  ${head}: NOT WHAT THIS FILE SAYS, SO LEFT ALONE (plan ${verdict.planId}, `
        + `${verdict.recordedDays} days recorded, ${verdict.missing.length} of ${verdict.fileDays} missing)`);
      for (const reason of reasons) console.log(`      it has ${reason}`);
      continue;
    }
    fillable += 1;
    console.log(`  ${head}: HALF RECORDED (plan ${verdict.planId}, ${verdict.recordedDays} days recorded) -- `
      + `a run would add the ${verdict.missing.length} missing day(s), `
      + `$${verdict.missing.reduce((sum, entry) => sum + Number(entry.day.cost || 0), 0).toFixed(2)}`);
    const byObjective = new Map();
    for (const entry of verdict.missing) {
      if (!byObjective.has(entry.title)) byObjective.set(entry.title, []);
      byObjective.get(entry.title).push(entry.day.date);
    }
    for (const [title, dates] of byObjective) {
      console.log(`      ${title}: ${dates.join(', ')}`);
    }
  }
  console.log(`\n${absent} month(s) to create, ${fillable} to fill in, ${settled} already complete, ${held} left alone`);
  if (held) console.log('a month left alone has to be looked at by hand -- read the reasons above before importing it');
  process.exit(0);
}

// ---------------------------------------------------------------- managers
const people = await call('GET', '/api/users', undefined, admin);
if (people.status !== 200) fail('reading the accounts', people);
const managerFor = {};
const credentials = [];
for (const account of people.body.users) {
  if (account.role === 'manager' && account.sector) managerFor[account.sector] = account;
}
for (const [operation, who] of Object.entries(NEW_MANAGERS)) {
  if (managerFor[operation]) continue;
  const temporary = password();
  const created = await call('POST', '/api/users', {
    username: who.username, name: who.name, password: temporary, role: 'manager', sector: operation
  }, admin);
  if (created.status !== 201) fail(`creating the ${operation} manager`, created);
  managerFor[operation] = created.body;
  credentials.push({ operation, ...who, id: created.body.id, temporary });
  console.log(`created ${who.username} as the ${OPERATION_NAME[operation]} manager`);
}

// A session for each manager. Only the operation's own manager may record a day
// -- the route refuses the Director outright, because the progress figure must
// not be partly the Director's typing. A manager created just now signs in and
// chooses a password, which is what clears must_change_password; one that
// already existed gets a minted session, so a real person's password is never
// touched by an import.
const sessions = {};
for (const [operation, manager] of Object.entries(managerFor)) {
  const fresh = credentials.find((entry) => entry.id === manager.id);
  if (fresh) {
    const first = await call('POST', '/api/auth/login', { username: fresh.username, password: fresh.temporary });
    if (first.status !== 200) fail(`signing in as ${fresh.username}`, first);
    const working = password();
    const chosen = await call('POST', '/api/auth/password',
      { currentPassword: fresh.temporary, newPassword: working }, first.body.token);
    if (chosen.status !== 200) fail(`choosing a password for ${fresh.username}`, chosen);
    sessions[operation] = chosen.body.token;
  } else {
    sessions[operation] = jwt.sign({ id: manager.id }, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '2h' });
  }
}
console.log(`managers ready: ${Object.entries(managerFor).map(([operation, manager]) => `${operation}=${manager.username}`).join(', ')}`);

// A day is posted by the manager the month was ASSIGNED to: canWorkPlan reads
// the plan's own manager_id, not whoever manages the operation today, so a
// half-recorded month that was handed to somebody else is filled in as them.
const mintedFor = new Map();
async function tokenForManager(managerId, operation) {
  const theirs = sessions[operation];
  if (managerId === null) {
    return theirs ? { ok: true, token: theirs } : { ok: false, why: `no session for the ${operation} manager` };
  }
  if (managerFor[operation] && Number(managerFor[operation].id) === Number(managerId) && theirs) {
    return { ok: true, token: theirs };
  }
  if (mintedFor.has(managerId)) return mintedFor.get(managerId);
  const token = jwt.sign({ id: Number(managerId) }, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '2h' });
  const who = await call('GET', '/api/auth/session', undefined, token);
  let answer;
  if (who.status !== 200) {
    answer = { ok: false, why: `the session for manager ${managerId} was refused (${who.status})` };
  } else if (who.body.user?.mustChangePassword) {
    // Their password is NOT reset to get past this. It belongs to a real
    // person, and an import that chose one for them would hand their account
    // to whoever reads this console.
    answer = { ok: false, why: `${who.body.user.username} has not chosen a password yet, so they cannot record a day -- they sign in once first` };
  } else {
    answer = { ok: true, token };
  }
  mintedFor.set(managerId, answer);
  return answer;
}

// ---------------------------------------------------------------- projects
const existing = await call('GET', '/api/projects', undefined, admin);
if (existing.status !== 200) fail('reading the projects', existing);
const projectFor = {};
for (const project of existing.body) if (!projectFor[project.sector]) projectFor[project.sector] = project.id;
for (const [operation, project] of Object.entries(PROJECTS)) {
  if (projectFor[operation]) continue;
  const budget = plans.filter((plan) => plan.operation === operation).reduce((sum, plan) => sum + plan.approvedBudget, 0);
  const created = await call('POST', '/api/projects', {
    ...project,
    sector: operation,
    managerId: managerFor[operation]?.id ?? null,
    budget: Math.round(budget * 100) / 100,
    spent: 0,
    progress: 0
  }, admin);
  if (created.status !== 201) fail(`creating the ${operation} project`, created);
  projectFor[operation] = created.body.id;
  console.log(`created project ${created.body.id} "${project.name}" for ${OPERATION_NAME[operation]}`);
  // The id is minted from the clock, so two created in the same millisecond
  // would collide on the primary key.
  await new Promise((resolve) => setTimeout(resolve, 5));
}

// ---------------------------------------------------- the months, and the days
let plansMade = 0;
let daysMade = 0;
let moneyMade = 0;
const problems = [];

for (const plan of plans) {
  const manager = managerFor[plan.operation];
  if (!manager) { problems.push(`${plan.operation}/${plan.month}: no manager, skipped`); continue; }

  // What the survey above found for this month. Only an absent month is
  // created; a complete one is left exactly as it is, and a half-recorded one
  // has its missing days added against the plan that is already there.
  const verdict = verdicts.get(`${plan.operation}/${plan.month}`);
  if (verdict.state === 'complete') {
    console.log(`${OPERATION_NAME[plan.operation]} / ${plan.month}: already recorded in full -- nothing added`);
    continue;
  }
  if (verdict.state === 'partial') {
    const reasons = blockers(plan, verdict);
    if (reasons.length) {
      problems.push(`${plan.operation}/${plan.month}: left untouched -- it has ${reasons.join(', ')}. `
        + `Read plan ${verdict.planId} before importing this month.`);
      continue;
    }
    const session = await tokenForManager(verdict.managerId, plan.operation);
    if (!session.ok) { problems.push(`${plan.operation}/${plan.month}: ${session.why}`); continue; }
    let filled = 0;
    let filledMoney = 0;
    for (const entry of verdict.missing) {
      const posted = await call('POST', `/api/monthly-plans/${verdict.planId}/reports`, {
        date: entry.day.date, objectiveId: entry.objectiveId,
        quantityDone: entry.day.quantityDone, cost: entry.day.cost, notes: entry.day.notes
      }, session.token);
      if (posted.status !== 201 && posted.status !== 200) {
        problems.push(`${plan.operation}/${plan.month} ${entry.day.date} "${entry.title}": `
          + `${posted.status} ${JSON.stringify(posted.body).slice(0, 220)}`);
        continue;
      }
      filled += 1;
      filledMoney += Number(entry.day.cost || 0);
      daysMade += 1;
      moneyMade += Number(entry.day.cost || 0);
    }
    console.log(`${OPERATION_NAME[plan.operation]} / ${plan.month}: was half recorded -- `
      + `added the ${filled} missing day(s), $${filledMoney.toFixed(2)}`);
    continue;
  }

  const created = await call('POST', '/api/monthly-plans', {
    operation: plan.operation,
    month: plan.month,
    managerId: manager.id,
    approvedBudget: plan.approvedBudget,
    projectId: projectFor[plan.operation],
    notes: plan.notes,
    objectives: plan.objectives.map((objective) => ({
      title: objective.title,
      targetQuantity: objective.targetQuantity,
      targetUnit: objective.targetUnit,
      supportsOperation: objective.supportsOperation || undefined
    }))
  }, admin);
  if (created.status !== 201) {
    problems.push(`${plan.operation}/${plan.month}: ${created.status} ${JSON.stringify(created.body)}`);
    continue;
  }
  plansMade += 1;

  // Read the month back so each day is filed against the objective the server
  // actually stored, matched on the words the Director typed.
  const saved = await call('GET', `/api/monthly-plans/${created.body.id}`, undefined, admin);
  if (saved.status !== 200) fail(`reading back ${plan.operation}/${plan.month}`, saved);
  const idOf = new Map();
  for (const objective of saved.body.objectives || []) {
    idOf.set(`${objective.title}|${objective.supportsOperation || ''}`, objective.id);
  }

  let planDays = 0;
  let planMoney = 0;
  for (const objective of plan.objectives) {
    const objectiveId = idOf.get(`${objective.title}|${objective.supportsOperation || ''}`);
    if (!objectiveId) {
      problems.push(`${plan.operation}/${plan.month}: objective "${objective.title}" came back without an id`);
      continue;
    }
    for (const day of objective.days) {
      const posted = await call('POST', `/api/monthly-plans/${created.body.id}/reports`, {
        date: day.date, objectiveId, quantityDone: day.quantityDone, cost: day.cost, notes: day.notes
      }, sessions[plan.operation]);
      if (posted.status !== 201 && posted.status !== 200) {
        problems.push(`${plan.operation}/${plan.month} ${day.date} "${objective.title}": ${posted.status} ${JSON.stringify(posted.body).slice(0, 220)}`);
        continue;
      }
      planDays += 1;
      planMoney += day.cost;
      daysMade += 1;
      moneyMade += day.cost;
    }
  }
  console.log(`${OPERATION_NAME[plan.operation]} / ${plan.month}: budget $${plan.approvedBudget.toFixed(2)}, `
    + `${plan.objectives.length} objectives, ${planDays} days recorded, $${planMoney.toFixed(2)} spent`);
}

// ------------------------------------------------- reset the new accounts
// Back to a temporary password, so the person who takes the account over
// chooses their own at first sign-in -- the rule for every password somebody
// else set. These are the ones to hand over.
for (const entry of credentials) {
  const temporary = password();
  const reset = await call('PATCH', `/api/users/${entry.id}/password`, { password: temporary }, admin);
  if (reset.status !== 200) { problems.push(`resetting ${entry.username}: ${reset.status}`); continue; }
  entry.handover = temporary;
}

console.log(`\n${plansMade} monthly plans, ${daysMade} days, $${moneyMade.toFixed(2)} recorded`);
if (directorPassword) {
  console.log(`\nthe Director's password was set during this run (nobody else holds it): ${directorPassword}`);
}
if (credentials.length) {
  console.log('\nnew accounts -- temporary password, must be changed at first sign-in:');
  for (const entry of credentials) {
    console.log(`  ${entry.username}  (${entry.name}, ${OPERATION_NAME[entry.operation]})  ${entry.handover || 'RESET FAILED'}`);
  }
}
if (problems.length) {
  console.log(`\n${problems.length} problems:`);
  for (const problem of problems) console.log(`  ${problem}`);
} else {
  console.log('\nno refusals from the API');
}
