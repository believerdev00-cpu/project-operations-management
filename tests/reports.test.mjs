// WHAT A PERIOD REPORT SAYS, and what it must never say.
//
// The report is the one thing in this system that leaves the building: it is
// printed, carried to a meeting, handed to a partner. Three things had gone
// wrong with it, and this suite is what keeps them from coming back.
//
//   1. THE MONTH'S WORK WENT MISSING. A month is worked through objectives and
//      daily records now; the report was built around the older activity
//      register. With no activities in the period the screen printed "No work
//      in those dates" and stopped -- while the PDF of the very same query
//      printed every recorded day. A Director who had set four objectives and
//      watched a manager record ten days against them was told on screen that
//      nothing had happened.
//
//   2. AN UNTOUCHED COMMITMENT WAS INVISIBLE. The month's half of the report
//      started from the daily records, so an objective nobody had worked on
//      simply did not appear -- indistinguishable from an objective that does
//      not exist. "Nothing has been recorded against this" is the single most
//      useful line a monthly report carries.
//
//   3. IT WAS FULL OF NAMES, AND ONLY IN ENGLISH. Who recorded a day, who
//      raised an activity, who asked for a budget change and who answered it,
//      plus a per-manager table -- all noise to readers who know who runs each
//      operation. And the exported file, the copy that actually gets printed,
//      was English only in a system whose interface is in four languages.
//
// Everything here creates its own fixtures (zz- accounts, ZZTEST names) and
// removes them in `finally`, so it depends on no seeded project or plan.

import bcrypt from 'bcryptjs';
import zlib from 'node:zlib';
import { pool } from '../server/db/database.js';
import { directorSession } from './director.mjs';
import { LANGUAGE_CODES, translate } from '../shared/strings.js';

const API = process.env.API || 'http://localhost:5000';
// Far enough out that no real plan can share the month, and the dates are
// stable whenever the suite is run.
const MONTH = '2095-04';
const day = (n) => `${MONTH}-${String(n).padStart(2, '0')}`;

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
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
const post = (token, path, body) => api(token, path, { method: 'POST', body: JSON.stringify(body || {}) });

// An export, as bytes: what the file actually is, not a JSON view of it.
async function exportFile(token, query) {
  const response = await fetch(`${API}/api/reports/activities/export?${query}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  return { status: response.status, type: response.headers.get('content-type') || '', buffer };
}

// The words inside a PDF, without a parser library.
//
// pdfkit compresses each page's content stream, so the text is nowhere in the
// raw bytes -- searching those finds nothing and proves nothing. Every stream
// is inflated, and the strings are read out of its text-showing operators:
// pdfkit writes them as hex runs inside a `[ ... ] TJ` array, split wherever it
// kerns a pair, so the runs of one array are joined back together before being
// searched.
//
// Decoded as WinAnsi (cp1252), which is what a PDF standard font encodes: one
// byte per character for all four of this system's languages, but NOT latin1 --
// in WinAnsi the curly apostrophe of "Ingengo y'imari" is 0x92, which latin1
// reads as a control character and the comparison then fails on a file that is
// perfectly correct.
const WINANSI = new TextDecoder('windows-1252');

function pdfText(buffer) {
  const out = [];
  let index = 0;
  for (;;) {
    const start = buffer.indexOf('stream', index);
    if (start < 0) break;
    let from = start + 6;
    if (buffer[from] === 13) from += 1;
    if (buffer[from] === 10) from += 1;
    const end = buffer.indexOf('endstream', from);
    if (end < 0) break;
    index = end + 9;
    let content;
    try {
      content = zlib.inflateSync(buffer.subarray(from, end)).toString('latin1');
    } catch {
      continue;
    }
    for (const block of content.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      let line = '';
      for (const hex of block[1].matchAll(/<([0-9a-fA-F]+)>/g)) {
        line += WINANSI.decode(Buffer.from(hex[1], 'hex'));
      }
      if (line.trim()) out.push(line);
    }
  }
  return out.join('\n');
}

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

  const seat = async (username, name, role, sector) => {
    const row = await pool.query(
      `INSERT INTO users (username, password_hash, name, role, sector)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [username, bcrypt.hashSync('test-pass-123', 10), name, role, sector]
    );
    created.users.push(row.rows[0].id);
    return { id: row.rows[0].id, token: await login(username, 'test-pass-123') };
  };
  const miner = await seat('zz-rep-mining', 'ZZ Mining Manager', 'manager', 'mining');
  const farmer = await seat('zz-rep-farming', 'ZZ Farming Manager', 'manager', 'farming');
  const hand = await seat('zz-rep-staff', 'ZZ Team Member', 'staff', 'mining');
  console.log('  two managers and one team member seeded');

  // One month, three objectives: two that get worked on and one that nobody
  // touches. The untouched one is the point of half this suite.
  await pool.query("DELETE FROM monthly_plans WHERE sector = 'mining' AND month = $1::date", [`${MONTH}-01`]);
  const plan = await post(admin, '/api/monthly-plans', {
    operation: 'mining', month: MONTH, managerId: miner.id, approvedBudget: 1000,
    objectives: [
      { title: 'ZZTEST ore washed', targetQuantity: 100, targetUnit: 'tonnes' },
      { title: 'ZZTEST site inspections', targetQuantity: 4, targetUnit: 'inspections' },
      { title: 'ZZTEST nobody touches this one', targetQuantity: 9, targetUnit: 'visits' }
    ]
  });
  check('a month with three objectives is created', plan.status === 201, JSON.stringify(plan.body).slice(0, 200));
  created.plans.push(plan.body.id);
  const planId = plan.body.id;

  const detail = await api(miner.token, `/api/monthly-plans/${planId}`);
  const objectives = detail.body.objectives || [];
  const washed = objectives.find((item) => item.title.includes('ore washed'));
  const inspections = objectives.find((item) => item.title.includes('inspections'));
  const untouched = objectives.find((item) => item.title.includes('nobody touches'));
  check('  all three are on the plan', Boolean(washed && inspections && untouched), objectives.length);

  // Two days inside one week, and a third outside it, so "in these dates" and
  // "in total" cannot be the same number by accident.
  const days = [
    { date: day(6), objectiveId: washed.id, quantityDone: 30, cost: 120, notes: 'ZZTEST washed 30 tonnes.' },
    { date: day(7), objectiveId: inspections.id, quantityDone: 2, cost: 0, notes: 'ZZTEST two inspections, no cost.' },
    { date: day(20), objectiveId: washed.id, quantityDone: 20, cost: 80, notes: 'ZZTEST washed 20 more.' }
  ];
  for (const entry of days) {
    const recorded = await post(miner.token, `/api/monthly-plans/${planId}/reports`, entry);
    check(`  ${entry.date}: a day is recorded`, recorded.status === 201, JSON.stringify(recorded.body).slice(0, 160));
  }

  // ---- 1. a month of objectives IS a report --------------------------------
  //
  // No activity exists anywhere in this period. Before, that alone made the
  // report read as empty.
  section('1. A month worked through objectives reports as a full month');
  const monthly = await api(admin, `/api/reports/activities?period=monthly&month=${MONTH}`);
  check('the report generates', monthly.status === 200, JSON.stringify(monthly.body).slice(0, 200));
  const work = monthly.body.monthlyWork || {};
  check('the activity register is empty for this period', monthly.body.activitySummary.total === 0,
    String(monthly.body.activitySummary.total));
  check('  and the report is NOT empty: it carries the month\'s work',
    work.summary?.records === 3 && work.objectives?.length === 3,
    `${work.summary?.records} days / ${work.objectives?.length} objectives`);
  check('  the days are there, newest to oldest by date', (work.days || []).length === 3,
    String((work.days || []).length));
  check('  with the manager\'s own words on each', (work.days || []).every((entry) => entry.notes.startsWith('ZZTEST')));

  // ---- 2. an objective nobody touched still appears ------------------------
  section('2. A commitment nobody worked on says so');
  const reported = (work.objectives || []).find((item) => item.title.includes('nobody touches'));
  check('the untouched objective is in the report', Boolean(reported), (work.objectives || []).map((o) => o.title));
  check('  flagged as not worked, not as zero progress',
    reported?.worked === false && reported?.doneInPeriod === 0 && reported?.percent === 0,
    JSON.stringify(reported));
  const washedRow = (work.objectives || []).find((item) => item.title.includes('ore washed'));
  check('a worked objective carries its lifetime figure, not the period\'s',
    washedRow?.doneOverall === 50 && washedRow?.percent === 50,
    `${washedRow?.doneOverall} / ${washedRow?.percent}%`);
  check('  and what these dates added', washedRow?.doneInPeriod === 50, String(washedRow?.doneInPeriod));

  // Progress is the monthly module's definition, never recomputed in the
  // report: 50% + 50% + 0% over three countable objectives.
  check('the month\'s overall figure is the plan\'s own calculation', work.summary?.percent === 33,
    String(work.summary?.percent));

  // ---- a narrower period: same objectives, different "in these dates" ------
  section('3. A week inside the month counts the week, and stands the month');
  const weekly = await api(admin, `/api/reports/activities?period=weekly&start=${day(7)}`);
  const weekWork = weekly.body.monthlyWork || {};
  check('the week has its own two days', weekWork.summary?.records === 2, String(weekWork.summary?.records));
  check('  all three objectives are still listed', weekWork.objectives?.length === 3,
    String(weekWork.objectives?.length));
  const weekWashed = (weekWork.objectives || []).find((item) => item.title.includes('ore washed'));
  check('  the week added 30 tonnes', weekWashed?.doneInPeriod === 30, String(weekWashed?.doneInPeriod));
  check('  while the objective still stands at 50 of 100 overall',
    weekWashed?.doneOverall === 50 && weekWashed?.percent === 50,
    `${weekWashed?.doneOverall} / ${weekWashed?.percent}`);
  const weekUntouched = (weekWork.objectives || []).find((item) => item.title.includes('nobody touches'));
  check('  and an objective worked outside the week reads as not worked in it',
    weekUntouched?.worked === false, JSON.stringify(weekUntouched));

  // ---- 4. the money is the month's, and says which money it is -------------
  section('4. The month\'s money, kept apart from the register\'s');
  check('the ceiling is the Director\'s figure', work.money?.budget === 1000, String(work.money?.budget));
  check('  spent is what the days cost', work.money?.spent === 200, String(work.money?.spent));
  check('  and what is left is derived', work.money?.remaining === 800, String(work.money?.remaining));
  check('the register\'s own figures are a separate reading',
    monthly.body.budgetSummary.spent === 0, String(monthly.body.budgetSummary.spent));

  // ---- 5. no report names anybody -----------------------------------------
  section('5. A report never says who typed it');
  const asText = JSON.stringify(monthly.body);
  const NAMES = ['recordedBy', 'submittedByName', 'assignedToName', 'raisedBy', 'requestedBy',
    'decidedBy', 'changedBy', 'managerName'];
  const leaked = NAMES.filter((field) => asText.includes(`"${field}"`));
  check('the payload carries no name field', leaked.length === 0, leaked.join(', '));
  check('  and no per-manager table', monthly.body.managers === undefined);
  check('  the manager\'s own name is nowhere in it', !asText.includes('ZZ Mining Manager'));
  // The one person-fact worth reporting is whether anybody holds the work at
  // all -- never who.
  check('an activity row says whether it is assigned, not to whom',
    (monthly.body.activities || []).every((item) => 'assigned' in item && !('assignedToName' in item)));

  // ---- 6. the exports say the same thing, in the reader's language ---------
  section('6. The exported file is the report, in the reader\'s language');
  const pdf = await exportFile(admin, `format=pdf&period=monthly&month=${MONTH}`);
  check('the PDF exports', pdf.status === 200 && pdf.type.includes('pdf') && pdf.buffer.length > 1000,
    `${pdf.status} ${pdf.type} ${pdf.buffer.length}`);
  check('  and is a PDF', pdf.buffer.slice(0, 5).toString() === '%PDF-', pdf.buffer.slice(0, 5).toString());
  const xlsx = await exportFile(admin, `format=xlsx&period=monthly&month=${MONTH}`);
  check('the spreadsheet exports', xlsx.status === 200 && xlsx.buffer.length > 1000,
    `${xlsx.status} ${xlsx.buffer.length}`);
  // A zip, which is what an xlsx is.
  check('  and is a workbook', xlsx.buffer.slice(0, 2).toString() === 'PK', xlsx.buffer.slice(0, 2).toString());

  // Every language produces a different file, and none of them fails. A
  // translation that throws (a missing key, an Intl locale the runtime does not
  // have) would show up as a 500 here rather than as a file somebody cannot
  // read.
  const sizes = new Map();
  for (const code of LANGUAGE_CODES) {
    const file = await exportFile(admin, `format=pdf&period=monthly&month=${MONTH}&language=${code}`);
    check(`  the PDF exports in ${code}`, file.status === 200 && file.buffer.length > 1000,
      `${file.status} ${file.buffer.length}`);
    sizes.set(code, file.buffer.length);
    // The words really are in the file, in that language: its first section
    // heading and the label on the month's budget. A 200 with a plausible size
    // would pass just as happily on an English file.
    const text = pdfText(file.buffer);
    for (const key of ['report.whatWasDone', 'report.monthBudget', 'report.daysWritten']) {
      const phrase = translate(code, key);
      check(`    ${code}: the file says "${phrase}"`, text.includes(phrase), key);
    }
    if (code !== 'en') {
      // And NOT the English it used to be written in, whatever language was
      // asked for.
      check(`    ${code}: and not the English "${translate('en', 'report.whatWasDone')}"`,
        !text.includes(translate('en', 'report.whatWasDone')));
    }
  }
  check('the four languages produce four different files', new Set(sizes.values()).size > 1,
    JSON.stringify([...sizes]));
  const nonsense = await exportFile(admin, `format=pdf&period=monthly&month=${MONTH}&language=zz-not-a-language`);
  check('a language the system does not have falls back to English rather than failing',
    nonsense.status === 200 && nonsense.buffer.length > 1000, String(nonsense.status));

  // ---- 7. who may read one ------------------------------------------------
  section('7. A report is a manager\'s and the Director\'s, and stays in scope');
  const staffRead = await api(hand.token, `/api/reports/activities?period=monthly&month=${MONTH}`);
  check('a team member cannot run a report', staffRead.status === 403, String(staffRead.status));
  const staffExport = await exportFile(hand.token, `format=xlsx&period=monthly&month=${MONTH}`);
  check('  nor export one', staffExport.status === 403, String(staffExport.status));
  const mine = await api(miner.token, `/api/reports/activities?period=monthly&month=${MONTH}`);
  check('the operation\'s own manager reads their month', mine.status === 200
    && (mine.body.monthlyWork.objectives || []).length === 3, String(mine.status));
  const theirs = await api(farmer.token, `/api/reports/activities?period=monthly&month=${MONTH}`);
  check('another operation\'s manager reads none of it',
    theirs.status === 200 && !JSON.stringify(theirs.body).includes('ZZTEST'), String(theirs.status));
  const reachOver = await api(farmer.token, `/api/reports/activities?period=monthly&month=${MONTH}&operation=mining`);
  check('  and asking for somebody else\'s operation is refused, not answered empty',
    reachOver.status === 403, `${reachOver.status} ${reachOver.body.message}`);

  // ---- 8. a period with nothing in it says so, once -----------------------
  section('8. A period with nothing in it');
  const quiet = await api(admin, '/api/reports/activities?period=monthly&month=2094-01');
  const quietWork = quiet.body.monthlyWork || {};
  check('an empty month reports no commitments and no days',
    quiet.status === 200 && quietWork.objectives?.length === 0 && quietWork.days?.length === 0,
    JSON.stringify(quietWork.summary));
  check('  with months counted as none rather than missing', quietWork.months?.length === 0);
  check('  and it still exports', (await exportFile(admin, 'format=pdf&period=monthly&month=2094-01')).status === 200);
} catch (error) {
  failed += 1;
  console.error('\nUNCAUGHT:', error.message, '\n', error.stack);
} finally {
  section('cleanup');
  for (const id of created.activities) {
    await pool.query('DELETE FROM activity_expenses WHERE activity_id = $1', [id]);
    await pool.query('DELETE FROM activity_history WHERE activity_id = $1', [id]);
    await pool.query('DELETE FROM activities WHERE id = $1', [id]);
  }
  // The plan takes its objectives and daily records with it (ON DELETE CASCADE).
  for (const id of created.plans) await pool.query('DELETE FROM monthly_plans WHERE id = $1', [id]);
  await pool.query("DELETE FROM notifications WHERE user_id = ANY($1::int[])", [created.users]);
  await pool.query("DELETE FROM users WHERE username LIKE 'zz-rep-%'");
  console.log(`  removed ${created.plans.length} plans, ${created.users.length} accounts`);
  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
}
