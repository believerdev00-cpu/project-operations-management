import { blockers, compareMonth, plannedWrites, quantityToPost, rowCountedObjectives } from '../scripts/import/compare.mjs';
import { createCaller } from '../scripts/import/http.mjs';
import { createCredentialsFile, credentialsTarget } from '../scripts/import/credentials.mjs';
import { isSummaryRow, parseDate, parseDeliveryNotes, parseYearArgument, summaryReport } from '../scripts/import/workbookRules.mjs';
import { mkdtempSync, readFileSync as readFileForTest, rmSync, writeFileSync as writeFileForTest } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatWorkbookNote, parseWorkbookNote, readableNote } from '../shared/workbookNote.js';
// The rules that are pure functions, checked without a database.
//
// Every other suite here drives the live API over HTTP, because what they are
// proving -- CHECK constraints, the max-three-managers trigger, FOR UPDATE
// locking, SQL scoping -- only exists in Postgres. That is the right test for
// those things and the wrong one for these: `objectiveProgress` is arithmetic,
// `derive` reads a sentence, `formatUsd` places a sign. Reaching them through a
// plan, a manager account and three HTTP calls makes the slowest possible test
// of the code most likely to be edited, and a failure points at the route
// rather than at the rule.
//
// So this suite runs first, in about a second, and needs nothing running. A
// break in the arithmetic of the money or the progress figures is caught here
// before any container has to start.

import assert from 'node:assert/strict';
import {
  activityRemaining, cents, fitsBudget, fitsRemaining, fromCents,
  objectiveProgress, planProgress, uncommitted
} from '../server/lib/monthly.js';
import { derive, validate } from '../server/lib/objectiveForm.js';
import {
  PRIMARY_OPERATION_IDS, TRIPS_OPERATION, isPrimaryOperation,
  isSupportOperation, runsTrips
} from '../shared/businessOperations.js';
import { PAYMENT_METHODS } from '../shared/paymentMethods.js';
import { PAYMENT_METHODS as SCHEMA_PAYMENT_METHODS } from '../server/db/monthlySchema.js';
import { formatDate, formatUsd, todayLocal } from '../src/format.js';

let passed = 0;
let failed = 0;
const check = (label, run) => {
  try {
    run();
    passed += 1;
    console.log(`  PASS  ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${label}\n        ${error.message.split('\n')[0]}`);
  }
};

console.log('\n=== 1. money is counted in cents ===');
check('cents() rounds to the cent', () => {
  assert.equal(cents(10.555), 1056);
  assert.equal(cents(null), 0);
  assert.equal(cents('12.34'), 1234);
});
check('a spend of exactly the remaining budget fits', () => {
  assert.equal(fitsRemaining(40, 100, 60), true);
});
check('a spend one cent over the remaining budget does not', () => {
  assert.equal(fitsRemaining(40.01, 100, 60), false);
});
check('floating point does not refuse a spend that is exactly on budget', () => {
  // The reason every comparison goes through cents in the first place.
  assert.equal(fitsRemaining(0.3, 0.3, 0), true);
  assert.equal(fitsRemaining(0.3, 0.1 + 0.2, 0), true);
});
check('remaining is approved minus spent, to the cent', () => {
  assert.equal(activityRemaining(100, 60.5), 39.5);
  assert.equal(activityRemaining(0.3, 0.1), 0.2);
});
check('an overspent activity reports a negative remainder', () => {
  assert.equal(activityRemaining(100, 140), -40);
});
check('the month ceiling is a ceiling, not a running total', () => {
  assert.equal(fitsBudget(40, 100, 60), true);
  assert.equal(fitsBudget(40.01, 100, 60), false);
  assert.equal(uncommitted(100, 60), 40);
});
check('fromCents is the inverse of cents', () => {
  for (const value of [0, 1, 12.34, 999.99, 1000000.01]) {
    assert.equal(fromCents(cents(value)), value);
  }
});

console.log('\n=== 2. progress is calculated, and "not counted" is not zero ===');
check('an objective with no target has no percentage, not 0%', () => {
  const progress = objectiveProgress(null, 0);
  assert.equal(progress.percent, null);
  assert.equal(progress.target, null);
  assert.equal(progress.complete, false);
});
check('an objective with a zero target also has no percentage', () => {
  assert.equal(objectiveProgress(0, 0).percent, null);
});
check('percent is done over target', () => {
  assert.equal(objectiveProgress(500, 125).percent, 25);
  assert.equal(objectiveProgress(3, 1).percent, 33);
});
check('percent is capped at 100 when a target is lowered after the fact', () => {
  const progress = objectiveProgress(100, 140);
  assert.equal(progress.percent, 100);
  assert.equal(progress.complete, true);
});
check('remaining never goes below zero', () => {
  assert.equal(objectiveProgress(100, 140).remaining, 0);
});
check('an objective is complete the moment done reaches target', () => {
  assert.equal(objectiveProgress(50, 50).complete, true);
  assert.equal(objectiveProgress(50, 49.99).complete, false);
});
check('a month with no countable objective has no overall figure', () => {
  assert.equal(planProgress([{ percent: null }, { percent: null }]), null);
  assert.equal(planProgress([]), null);
});
check('uncountable objectives are left out of the average, not counted as zero', () => {
  // 100 and null must read as 100%, not 50%.
  assert.equal(planProgress([{ percent: 100 }, { percent: null }]), 100);
});
check('an unweighted month is the plain average', () => {
  assert.equal(planProgress([{ percent: 100 }, { percent: 50 }]), 75);
});
check('a weight on one objective does not erase the others', () => {
  // The unweighted one counts as 1: (3*100 + 1*0) / 4 = 75.
  assert.equal(planProgress([{ percent: 100, weight: 3 }, { percent: 0 }]), 75);
});
check('weights decide the month when every objective carries one', () => {
  assert.equal(planProgress([{ percent: 100, weight: 9 }, { percent: 0, weight: 1 }]), 90);
});

console.log('\n=== 3. the daily form is derived from the objective ===');
check('derive() answers without a network or an API key', () => {
  const form = derive({ title: 'Transport 50 trips of ore', targetQuantity: 50, targetUnit: 'trips' });
  assert.ok(form, 'no form returned');
  assert.equal(typeof form, 'object');
});
check('the form derive() writes is one validate() accepts', () => {
  const objective = { title: 'Plant 200 trees', targetQuantity: 200, targetUnit: 'trees' };
  const checked = validate(derive(objective), objective);
  assert.ok(checked, 'validate rejected the form derive produced');
});
check('validate() never throws on a malformed model answer', () => {
  // Every failure path has to leave the derived form standing, so this must
  // answer rather than raise, whatever the model sent back.
  const objective = { title: 'Plant 200 trees', targetQuantity: 200, targetUnit: 'trees' };
  for (const junk of [null, undefined, 'a string', 42, [], { quickAmounts: 'no' }]) {
    const result = validate(junk, objective);
    assert.ok(result === null || typeof result === 'object', `threw or returned junk for ${JSON.stringify(junk)}`);
  }
});

console.log('\n=== 4. the operations, and who runs the trips ===');
check('the three primary operations produce; the support one does not', () => {
  for (const id of PRIMARY_OPERATION_IDS) {
    assert.equal(isPrimaryOperation(id), true, id);
    assert.equal(isSupportOperation(id), false, id);
  }
});
check('an unknown id is neither primary nor support', () => {
  assert.equal(isPrimaryOperation('nonsense'), false);
  assert.equal(isSupportOperation('nonsense'), false);
});
check('a manager of the trips operation runs the register', () => {
  assert.equal(runsTrips({ role: 'manager', sector: TRIPS_OPERATION }), true);
});
check('a manager covering every operation runs it too', () => {
  assert.equal(runsTrips({ role: 'manager', coversAllSectors: true }), true);
});
check('a team member never runs it, even in that operation', () => {
  assert.equal(runsTrips({ role: 'staff', sector: TRIPS_OPERATION }), false);
  assert.equal(runsTrips(null), false);
});

console.log('\n=== 5. one list of payment methods, two consumers ===');
check('the form offers exactly what the CHECK constraint allows', () => {
  // These were two hand-written lists. If they drift, the dropdown offers a
  // method Postgres then refuses, with the expense already typed.
  assert.deepEqual(PAYMENT_METHODS, SCHEMA_PAYMENT_METHODS);
});
check('the list is not empty and has no duplicates', () => {
  assert.ok(PAYMENT_METHODS.length > 0);
  assert.equal(new Set(PAYMENT_METHODS).size, PAYMENT_METHODS.length);
});

console.log('\n=== 6. money and dates read the same on every screen ===');
check('a positive amount reads as $1,234.50', () => {
  assert.equal(formatUsd(1234.5), '$1,234.50');
});
check('a negative amount puts the sign before the symbol', () => {
  // "-$40.00", never "$-40.00": an over-budget remainder is read at a glance.
  assert.equal(formatUsd(-40), '-$40.00');
});
check('a missing amount reads as zero, not NaN', () => {
  assert.equal(formatUsd(null), '$0.00');
  assert.equal(formatUsd(undefined), '$0.00');
  assert.equal(formatUsd(''), '$0.00');
});
check('todayLocal() is the local date, not UTC', () => {
  const now = new Date();
  const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  assert.equal(todayLocal(), expected);
  assert.match(todayLocal(), /^\d{4}-\d{2}-\d{2}$/);
});
check('an unparseable date reads as an em dash, not "Invalid Date"', () => {
  assert.equal(formatDate(null, 'en'), '—');
  assert.equal(formatDate('', 'en'), '—');
  assert.equal(formatDate('not a date', 'en'), '—');
});
check('a date is written in the locale order the reader expects', () => {
  // The same day, ordered the way each reader expects it.
  assert.notEqual(formatDate('2026-04-05', 'en-US'), formatDate('2026-04-05', 'en-GB'));
});

console.log('\n=== 7. the workbook import, against a deployment it has already been run on ===');
//
// This is the arithmetic that decides whether a day of work is recorded twice.
// The import died half way once already -- four of twelve months in -- and
// everything below is what stops the re-run that finishes the job from
// doubling the four that landed. It is checked here rather than through the API
// because every case is a comparison of two lists, and the dangerous ones (two
// honestly identical days; a day whose note was trimmed) are a nuisance to set
// up over HTTP and trivial to state as data.

const workDay = (date, quantityDone, cost, notes = '') => ({ date, quantityDone, cost, notes });
// One month as the import file states it: one objective, two days, $300.
const fileMonth = (days = [workDay('2026-03-02', 10, 100), workDay('2026-03-03', 20, 200)]) => ({
  operation: 'mining',
  month: '2026-03',
  approvedBudget: 300,
  objectives: [{ title: 'Dig the pit', targetQuantity: 30, targetUnit: 'metres', days }]
});
// The same month as the deployment hands it back.
const liveRow = (changes = {}) => ({ id: 7, status: 'Confirmed', managerId: 4, approvedBudget: 300, ...changes });
const liveDetail = (dailyReports, objectives = [{ id: 11, title: 'Dig the pit', supportsOperation: null }]) =>
  ({ objectives, dailyReports });
const recordedDay = (date, quantityDone, cost, changes = {}) =>
  ({ objectiveId: 11, date, quantityDone, cost, notes: '', ...changes });

check('a month that is not there at all is created in full', () => {
  const verdict = compareMonth(fileMonth(), null, null);
  assert.equal(verdict.state, 'absent');
  assert.equal(verdict.fileDays, 2);
  assert.equal(verdict.fileMoney, 300);
});

check('a month whose every day is already recorded has nothing added', () => {
  const verdict = compareMonth(fileMonth(), liveRow(), liveDetail([
    recordedDay('2026-03-02', 10, 100),
    recordedDay('2026-03-03', 20, 200)
  ]));
  assert.equal(verdict.state, 'complete');
  assert.equal(verdict.missing.length, 0);
  assert.equal(verdict.extra, 0);
  assert.deepEqual(blockers(fileMonth(), verdict), []);
});

check('a half-recorded month offers exactly the days it is missing', () => {
  const verdict = compareMonth(fileMonth(), liveRow(), liveDetail([recordedDay('2026-03-02', 10, 100)]));
  assert.equal(verdict.state, 'partial');
  assert.equal(verdict.missing.length, 1);
  assert.equal(verdict.missing[0].day.date, '2026-03-03');
  // The objective id comes from the month as it was stored, because that is
  // what the day has to be posted against.
  assert.equal(verdict.missing[0].objectiveId, 11);
  assert.deepEqual(blockers(fileMonth(), verdict), []);
});

check('a day whose note reads differently is not recorded a second time', () => {
  // The server trims and caps the note, so the stored text and the file's text
  // can differ over the same day's work. Keying on the note would post it
  // again and double the figure.
  const verdict = compareMonth(fileMonth(), liveRow(), liveDetail([
    recordedDay('2026-03-02', 10, 100, { notes: 'FRW 120,000 (trimmed by the server)' }),
    recordedDay('2026-03-03', 20, 200, { notes: '' })
  ]));
  assert.equal(verdict.state, 'complete');
  assert.equal(verdict.missing.length, 0);
});

check('two honestly identical days are two days, and only the absent one is added', () => {
  // Two tanks of fuel at the same price on the same date. Counted as a set
  // rather than a multiset, the second one reads as already recorded and is
  // dropped -- the month then quietly loses a day and its money.
  const twice = fileMonth([workDay('2026-03-02', 10, 100), workDay('2026-03-02', 10, 100)]);
  const verdict = compareMonth(twice, liveRow({ approvedBudget: 200 }), liveDetail([recordedDay('2026-03-02', 10, 100)]));
  assert.equal(verdict.missing.length, 1);
  assert.equal(verdict.extra, 0);
  assert.equal(verdict.missing[0].day.date, '2026-03-02');
});

check('a month holding a day the file does not have is left alone, not read as complete', () => {
  const verdict = compareMonth(fileMonth(), liveRow(), liveDetail([
    recordedDay('2026-03-02', 10, 100),
    recordedDay('2026-03-03', 20, 200),
    recordedDay('2026-03-04', 5, 50)
  ]));
  assert.equal(verdict.extra, 1);
  // Not 'complete': nothing is missing, but this is not the month the file
  // describes, and reading it as complete would skip it with no reason shown.
  assert.equal(verdict.state, 'partial');
  assert.match(blockers(fileMonth(), verdict).join(' '), /1 day\(s\) recorded in the month that this file does not contain/);
});

check('an objective the stored month does not have is reported, never invented', () => {
  const verdict = compareMonth(fileMonth(), liveRow(), liveDetail([], [{ id: 11, title: 'Something else', supportsOperation: null }]));
  assert.equal(verdict.state, 'partial');
  assert.deepEqual(verdict.unknownObjectives, ['Dig the pit']);
  assert.match(blockers(fileMonth(), verdict).join(' '), /objectives this file has and the month does not/);
});

check('a stored month whose budget disagrees with the file is left alone', () => {
  const verdict = compareMonth(fileMonth(), liveRow({ approvedBudget: 250 }), liveDetail([recordedDay('2026-03-02', 10, 100)]));
  assert.equal(verdict.budgetMatches, false);
  assert.match(blockers(fileMonth(), verdict).join(' '), /\$250\.00 where this file says \$300\.00/);
});

check('a month that refuses a day is reported rather than attempted', () => {
  for (const status of ['Closed', 'Draft']) {
    const verdict = compareMonth(fileMonth(), liveRow({ status }), liveDetail([recordedDay('2026-03-02', 10, 100)]));
    assert.match(blockers(fileMonth(), verdict).join(' '), new RegExp(`the status ${status}`));
  }
});

check('the figures are matched in cents, so 12.1 and 12.10 are the same day', () => {
  const verdict = compareMonth(fileMonth([workDay('2026-03-02', 1.5, 12.1)]), liveRow({ approvedBudget: 300 }),
    liveDetail([recordedDay('2026-03-02', 1.50, 12.10)]));
  assert.equal(verdict.missing.length, 0);
  assert.equal(verdict.extra, 0);
});

check('a support objective is matched by the operation it supports, not the title alone', () => {
  // Movement & Facilitation writes the same commitment once per operation it
  // serves ("Transport trips", for Mining and for Agriculture). Keyed on the
  // title alone they are one objective, and one of them would be filled in
  // against the other's id.
  const plan = {
    operation: 'movement',
    month: '2026-03',
    approvedBudget: 100,
    objectives: [
      { title: 'Transport trips', supportsOperation: 'mining', days: [workDay('2026-03-02', 4, 40)] },
      { title: 'Transport trips', supportsOperation: 'agriculture', days: [workDay('2026-03-02', 6, 60)] }
    ]
  };
  const verdict = compareMonth(plan, liveRow({ approvedBudget: 100 }), liveDetail(
    [{ objectiveId: 21, date: '2026-03-02', quantityDone: 4, cost: 40, notes: '' }],
    [
      { id: 21, title: 'Transport trips', supportsOperation: 'mining' },
      { id: 22, title: 'Transport trips', supportsOperation: 'agriculture' }
    ]
  ));
  assert.equal(verdict.missing.length, 1);
  assert.equal(verdict.missing[0].objectiveId, 22);
  assert.equal(verdict.extra, 0);
});

// A day imported earlier with a counted quantity ("1 entries") is the same
// day when its date, cost and workbook row agree -- reported, not reposted.
const sourced = (row, file = 'rubaya report.xlsx') => `Mining — Advance deposited | Quantity: 64.8 | $8100 as recorded | [${file} / Mining Activities row ${row}]`;
check('a day recorded earlier with a different quantity but the same workbook row is the same day', () => {
  const plan = fileMonth([workDay('2026-03-02', 0, 8100, sourced(30, 'Rubaya & Gisuma Proiects (2).xlsx'))]);
  plan.approvedBudget = 8100;
  const verdict = compareMonth(plan, liveRow({ approvedBudget: 8100 }), liveDetail([recordedDay('2026-03-02', 1, 8100, { notes: sourced(30) })]));
  assert.equal(verdict.state, 'complete');
  assert.equal(verdict.missing.length, 0);
  assert.equal(verdict.extra, 0);
  assert.equal(verdict.differences.length, 1);
  assert.deepEqual([verdict.differences[0].recordedQuantity, verdict.differences[0].fileQuantity], [1, 0]);
});
check('two payments of the same amount on the same day from different rows are never taken for one', () => {
  const plan = fileMonth([workDay('2026-03-02', 0, 8100, sourced(31))]);
  plan.approvedBudget = 8100;
  const verdict = compareMonth(plan, liveRow({ approvedBudget: 8100 }), liveDetail([recordedDay('2026-03-02', 1, 8100, { notes: sourced(30) })]));
  assert.equal(verdict.state, 'partial');
  assert.equal(verdict.missing.length, 1);
  assert.equal(verdict.extra, 1);
  assert.equal(verdict.differences.length, 0);
});
check('a day with no workbook row still has to match exactly', () => {
  const verdict = compareMonth(fileMonth([workDay('2026-03-02', 0, 100)]), liveRow({ approvedBudget: 100 }), liveDetail([recordedDay('2026-03-02', 1, 100)]));
  assert.equal(verdict.state, 'partial');
  assert.equal(verdict.differences.length, 0);
});

console.log('\n=== 9. the workbook row a day came from ===');
check('what the import writes, the report reads back', () => {
  const row = {
    activity: 'Mining', description: 'Advance on coltan', location: 'Rubaya',
    quantityText: '108kg', source: '$13500 as recorded',
    file: 'rubaya report.xlsx', sheet: 'Mining Activities', row: 2
  };
  assert.deepEqual(parseWorkbookNote(formatWorkbookNote(row)), row);
});
check('the notes already imported still read, missing activity and all', () => {
  // Written before the activity column was carried: that field comes back
  // empty and every other one still lands. These are the rows that exist.
  const parsed = parseWorkbookNote(
    'Monthly internet packs @ Goma | Quantity: 1 month& 2sim cards | $33 as recorded'
    + ' | [rubaya report.xlsx / OPS Related to mining row 2]'
  );
  assert.equal(parsed.activity, '');
  assert.equal(parsed.description, 'Monthly internet packs');
  assert.equal(parsed.location, 'Goma');
  assert.equal(parsed.quantityText, '1 month& 2sim cards');
  assert.equal(parsed.source, '$33 as recorded');
  assert.equal(parsed.sheet, 'OPS Related to mining');
  assert.equal(parsed.row, 2);
});
check('the figure in the original currency survives the separator', () => {
  // The source tail has to swallow the "|" before it. Without that the last
  // field arrives as "975200 FRW at 1470.6/USD |", matches neither money
  // shape, and every converted figure in the report comes out blank.
  const parsed = parseWorkbookNote(
    'Trench fenching | Quantity: 424 meters | 975200 FRW at 1470.6/USD'
    + ' | [rubaya report.xlsx / Gisuma Farm Activities row 3]'
  );
  assert.equal(parsed.source, '975200 FRW at 1470.6/USD');
  assert.equal(parsed.description, 'Trench fenching');
});
check('a note a manager typed is not forced into columns', () => {
  // The report shows these columns where they exist and the note as it stands
  // everywhere else, so this has to answer null rather than guess.
  for (const note of ['we cultivated', '', null, undefined, 'Quantity: 3 | nothing else']) {
    assert.equal(parseWorkbookNote(note), null, JSON.stringify(note));
  }
});
check('a workbook row with an empty description keeps its other columns', () => {
  // Some rows state a quantity and a cost and nothing else. The description
  // has to come back empty rather than taking the quantity in its place.
  const parsed = parseWorkbookNote(
    'Quantity: 7 days | $70 as recorded | [rubaya report.xlsx / OPS Related to mining row 9]'
  );
  assert.equal(parsed.description, '');
  assert.equal(parsed.quantityText, '7 days');
  assert.equal(parsed.source, '$70 as recorded');
});

console.log('\n=== 10. the quantity a missing day is posted with ===');
const entryOf = (objectiveId, quantityDone) => ({ objectiveId, day: { date: '2026-08-10', quantityDone, cost: 5 } });
check('only objectives counted in entries or times count rows', () => {
  const counted = rowCountedObjectives({ objectives: [
    { id: 1, targetUnit: 'entries' }, { id: 2, targetUnit: 'times' }, { id: 3, targetUnit: 'kg' }, { id: 4, targetUnit: '' }
  ] });
  assert.deepEqual([...counted].sort(), [1, 2]);
  assert.equal(rowCountedObjectives(null).size, 0);
});
check('in a row-counted objective, a day with no figure is posted as 1', () => {
  const counted = new Set([7]);
  assert.equal(quantityToPost(counted, entryOf(7, 0)), 1);
  assert.equal(quantityToPost(counted, entryOf(7, null)), 1);
  assert.equal(quantityToPost(counted, entryOf(7, undefined)), 1);
});
check('a figure the workbook states is never changed, even in a row-counted objective', () => {
  const counted = new Set([7]);
  assert.equal(quantityToPost(counted, entryOf(7, 5)), 5);
  assert.equal(quantityToPost(counted, entryOf(7, 0.5)), 0.5);
});
check('outside row-counted objectives every quantity is posted as the file has it', () => {
  const counted = new Set([7]);
  assert.equal(quantityToPost(counted, entryOf(8, 0)), 0);
  assert.equal(quantityToPost(counted, entryOf(8, null)), null);
  assert.equal(quantityToPost(undefined, entryOf(7, 0)), 0);
  assert.equal(quantityToPost(new Set(), entryOf(7, null)), null);
});
check('the days a write run would add are counted the way --check reports them', () => {
  const plans = [
    { operation: 'farming', month: '2026-07', approvedBudget: 10 },
    { operation: 'farming', month: '2026-08', approvedBudget: 10 },
    { operation: 'farming', month: '2026-09', approvedBudget: 10 },
    { operation: 'mining', month: '2026-08', approvedBudget: 10 }
  ];
  const ok = { unknownObjectives: [], extra: 0, budgetMatches: true, existingBudget: 10, status: 'Confirmed' };
  const verdicts = new Map([
    ['farming/2026-07', { state: 'absent', fileDays: 4 }],
    ['farming/2026-08', { ...ok, state: 'partial', missing: [{}, {}, {}] }],
    ['farming/2026-09', { ...ok, state: 'complete', missing: [] }],
    // held back by a blocker: a run adds nothing to it
    ['mining/2026-08', { ...ok, budgetMatches: false, existingBudget: 9, state: 'partial', missing: [{}, {}] }]
  ]);
  assert.deepEqual(plannedWrites(plans, verdicts), { months: 1, days: 7 });
});

// 11. --check sends nothing but reads. These go through a fake fetch, so they
// are asynchronous; they are collected here and run (under their own heading)
// at the end of the file.
const asyncChecks = [];
const checkAsync = (label, run) => asyncChecks.push([label, run]);
const fakeFetch = () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, method: init.method }); return { status: 200, text: async () => '{"ok":true}' }; };
  return { calls, fetchImpl };
};
checkAsync('in check mode every write is refused before any request is made', async () => {
  const { calls, fetchImpl } = fakeFetch();
  const call = createCaller({ api: 'http://example.invalid', checkOnly: true, fetchImpl });
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    await assert.rejects(call(method, '/api/monthly-plans', { a: 1 }), /--check refused to send/);
  }
  assert.equal(calls.length, 0);
});
checkAsync('in check mode a read still goes through', async () => {
  const { calls, fetchImpl } = fakeFetch();
  const call = createCaller({ api: 'http://example.invalid/', checkOnly: true, fetchImpl });
  const answer = await call('GET', '/api/health');
  assert.equal(answer.status, 200);
  assert.deepEqual(calls, [{ url: 'http://example.invalid/api/health', method: 'GET' }]);
});
checkAsync('outside check mode a write is sent', async () => {
  const { calls, fetchImpl } = fakeFetch();
  const call = createCaller({ api: 'http://example.invalid', fetchImpl });
  await call('POST', '/api/x', {});
  assert.equal(calls[0].method, 'POST');
});
checkAsync('only a request that never reached the server is retried', async () => {
  let attempts = 0;
  const neverArrived = async () => { attempts += 1; if (attempts < 3) throw Object.assign(new Error('timeout'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }); return { status: 201, text: async () => '' }; };
  const call = createCaller({ api: 'http://example.invalid', fetchImpl: neverArrived, wait: async () => {}, log: () => {} });
  assert.equal((await call('POST', '/api/x', {})).status, 201);
  assert.equal(attempts, 3);
  let reset = 0;
  const mayHaveArrived = async () => { reset += 1; throw Object.assign(new Error('reset'), { cause: { code: 'ECONNRESET' } }); };
  const again = createCaller({ api: 'http://example.invalid', fetchImpl: mayHaveArrived, wait: async () => {}, log: () => {} });
  await assert.rejects(again('POST', '/api/x', {}), /reset/);
  assert.equal(reset, 1);
});

console.log('\n=== 12. generated passwords go to a new private file, never the console ===');
check('on Windows generating passwords is refused', () => {
  const answer = credentialsTarget('/somewhere/creds.txt', { platform: 'win32', exists: () => false });
  assert.equal(answer.ok, false);
  assert.match(answer.why, /refused on Windows/);
});
check('without --credentials-out nothing that generates a password runs', () => {
  const answer = credentialsTarget(undefined, { platform: 'linux', exists: () => false });
  assert.equal(answer.ok, false);
  assert.match(answer.why, /--credentials-out/);
});
check('a credentials file inside the repository is refused', () => {
  const answer = credentialsTarget('/work/POMS/creds.txt', { platform: 'linux', repoRoot: '/work/POMS', exists: () => false });
  assert.equal(answer.ok, false);
  assert.match(answer.why, /outside the repository/);
});
check('an existing file is refused, never overwritten', () => {
  const answer = credentialsTarget('/elsewhere/creds.txt', { platform: 'linux', repoRoot: '/work/POMS', exists: () => true });
  assert.equal(answer.ok, false);
  assert.match(answer.why, /never overwritten/);
});
check('a new file outside the repository is accepted', () => {
  const answer = credentialsTarget('/elsewhere/creds.txt', { platform: 'linux', repoRoot: '/work/POMS', exists: () => false });
  assert.equal(answer.ok, true);
});
check('creating the file never overwrites one that is already there', () => {
  const folder = mkdtempSync(join(tmpdir(), 'poms-credentials-test-'));
  try {
    const path = join(folder, 'existing.txt');
    writeFileForTest(path, 'keep me');
    assert.throws(() => createCredentialsFile(path, { platform: 'linux' }), /EEXIST/);
    assert.equal(readFileForTest(path, 'utf8'), 'keep me');
    assert.throws(() => createCredentialsFile(join(folder, 'new.txt'), { platform: 'win32' }), /not created on Windows/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

console.log('\n=== 13. reading the workbook: the year, the totals, the delivery notes ===');
check('--year is required and must be four digits', () => {
  assert.equal(parseYearArgument(undefined).ok, false);
  assert.equal(parseYearArgument('26').ok, false);
  assert.equal(parseYearArgument('20266').ok, false);
  assert.deepEqual(parseYearArgument('2026'), { ok: true, year: 2026 });
});
check('dates are read d/m/y and Excel-swapped cells are swapped back', () => {
  assert.equal(parseDate({ v: '26/07/2026', k: 'string' }, null, 2026).date, '2026-07-26');
  assert.equal(parseDate({ v: '2026-07-08', k: 'date' }, null, 2026).date, '2026-08-07');
  assert.equal(parseDate({ v: '2026-08-31', k: 'date' }, null, 2026).date, '2026-08-31');
  assert.equal(parseDate({ v: '10-11/8/2026', k: 'string' }, null, 2026).date, '2026-08-10');
  assert.equal(parseDate({ v: '07/082026', k: 'string' }, null, 2026).date, '2026-08-07');
  assert.equal(parseDate({ v: '28/02026', k: 'string' }, 8, 2026).date, '2026-08-28');
});
check('a date in another year is refused with its reason, never rewritten', () => {
  assert.deepEqual(parseDate({ v: '25/8/2028', k: 'string' }, null, 2026), { date: null, why: 'year 2028 is not 2026' });
  assert.deepEqual(parseDate({ v: '2027-03-15', k: 'date' }, null, 2026), { date: null, why: 'year 2027 is not 2026' });
  assert.equal(parseDate({ v: '25/8/2028', k: 'string' }, null, 2028).date, '2028-08-25');
});
check('an impossible date is refused', () => {
  assert.match(parseDate({ v: '31/6/2026', k: 'string' }, null, 2026).why, /no such day/);
  assert.match(parseDate({ v: '12/13/2026', k: 'string' }, null, 2026).why, /range/);
  assert.match(parseDate({ v: 'yesterday', k: 'string' }, null, 2026).why, /unparsed/);
  assert.throws(() => parseDate({ v: '1/1/2026', k: 'string' }, null, undefined), /expected year/);
});
check('totals and summaries are recognised, including the one with no space', () => {
  assert.equal(isSummaryRow('Mining', 'DELIVERY 2Total Ops related to Mining'), true);
  assert.equal(isSummaryRow('Mining', '30911-25000-212-2149-250'), true);
  assert.equal(isSummaryRow('DELIVERY 1 SUMMARY', ''), true);
  assert.equal(isSummaryRow('Movement', 'Fuel in Goma'), false);
});
check('every row set aside as a total is reported with its money', () => {
  const report = summaryReport([
    { sheet: 'Mining Activities', n: 12, label: 'Mining - Total Sale', usd: 30911 },
    { sheet: 'OPS Related to mining', n: 28, label: 'Mining - DELIVERY 2Total Ops', usd: 203.32999999999998, frw: 298717 },
    // a real cost that says "total" is set aside too -- and therefore shown
    { sheet: 'Movements & Facilitations', n: 50, label: 'Movement - total fuel for the week', frw: 6000 },
    { sheet: 'Mining Activities', n: 13, label: 'net profit' }
  ]);
  assert.equal(report.count, 4);
  assert.equal(report.usd, 31114.33);
  assert.match(report.lines[1], /\$203\.33 \/ 298717 FRW/);
  assert.match(report.lines[2], /6000 FRW -- "Movement - total fuel for the week"/);
  assert.match(report.lines[3], /no figure/);
});
check('delivery notes come only from the file given, keyed by operation and month', () => {
  const notes = parseDeliveryNotes('{"mining/2026-08": " Delivery 1: sold for $30,911. "}');
  assert.equal(notes.get('mining/2026-08'), 'Delivery 1: sold for $30,911.');
  assert.equal(notes.size, 1);
  assert.throws(() => parseDeliveryNotes('{"2026-08": "x"}'), /not operation\/YYYY-MM/);
  assert.throws(() => parseDeliveryNotes('{"mining/2026-13": "x"}'), /not operation\/YYYY-MM/);
  assert.throws(() => parseDeliveryNotes('{"mining/2026-08": ""}'), /non-empty/);
  assert.throws(() => parseDeliveryNotes('["x"]'), /JSON object/);
  assert.throws(() => parseDeliveryNotes('not json'), /not valid JSON/);
});

console.log('\n=== 11. --check sends nothing but reads (no network: a fake fetch) ===');
for (const [label, run] of asyncChecks) {
  try {
    await run();
    passed += 1;
    console.log(`  PASS  ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${label}\n        ${error.message.split('\n')[0]}`);
  }
}


check('readableNote leaves the import tail off and every other note alone', () => {
  const note = formatWorkbookNote({ activity: 'Advance on coltan', quantityText: '9.5', source: '$1188 as recorded', file: 'rubaya report.xlsx', sheet: 'Mining Activities', row: 51 });
  assert.equal(readableNote(note), 'Advance on coltan | Quantity: 9.5 | $1188 as recorded');
  assert.equal(readableNote('Planted [row 3 of trees] today'), 'Planted [row 3 of trees] today');
  assert.equal(readableNote('plain note'), 'plain note');
  assert.equal(readableNote(null), '');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
