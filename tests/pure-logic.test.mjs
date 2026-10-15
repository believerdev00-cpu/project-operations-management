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
import { FILLER_UNITS, UNIT_SUGGESTIONS, stepForUnit, unitClass } from '../shared/units.js';
import {
  PRIMARY_OPERATION_IDS, TRIPS_OPERATION, isPrimaryOperation,
  isSupportOperation, runsTrips
} from '../shared/businessOperations.js';
import { PAYMENT_METHODS } from '../shared/paymentMethods.js';
import { PAYMENT_METHODS as SCHEMA_PAYMENT_METHODS } from '../server/db/monthlySchema.js';
import { formatDate, formatUsd, todayLocal } from '../src/format.js';
// The workbook import's one piece of arithmetic: what a deployment already
// holds, against what the import file says. It lives next to the script that
// reads it and needs no database, which is why it is checked here.
import { blockers, compareMonth } from '../scripts/import/compare.mjs';
// The note an imported day carries. The import writes it and the report reads
// it back apart into the workbook's own columns, so the two have to agree on
// the format exactly -- and neither ever calls the other.
import { formatWorkbookNote, parseWorkbookNote } from '../shared/workbookNote.js';

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
check('every unit the Director is offered is one the daily form understands', () => {
  // The suggestion list and the classification are one file for this reason.
  // A suggested word that classifies as filler would be offered to the Director
  // and then dropped out of the manager's question; one that is spelled
  // differently from what MEASURED_UNITS knows ("kilograms" offered, "kg"
  // recognised) would step a weight in whole numbers.
  for (const unit of UNIT_SUGGESTIONS) {
    assert.ok(unitClass(unit), unit);
    const step = stepForUnit(unit, 10);
    assert.ok(step === 1 || step === 0.01, `${unit} steps by ${step}`);
  }
  const fillers = UNIT_SUGGESTIONS.filter((unit) => unitClass(unit) === 'count' && !FILLER_UNITS.includes(unit));
  assert.deepEqual(fillers, [], `suggested but unclassifiable: ${fillers.join(', ')}`);
});
check('the weights and measures among them step finely', () => {
  for (const unit of ['kg', 'litres', 'metres', 'tonnes', 'hectares']) {
    assert.ok(UNIT_SUGGESTIONS.includes(unit), `${unit} is not offered`);
    assert.equal(stepForUnit(unit, 10), 0.01, unit);
  }
  // The commonest unit in three months of this organisation's real work, and
  // the one the suggestion list used to leave out altogether.
  assert.ok(UNIT_SUGGESTIONS.includes('labourers'));
  assert.equal(stepForUnit('labourers', 10), 1);
});
check('the question is a translation key and never an English sentence', () => {
  // The client reads a stored label in preference to a translated one, so an
  // English sentence here is an English label on the one field a manager has to
  // type into -- on a screen whose every other word is in their language.
  for (const objective of [
    { title: 'Potato garden preparation', targetQuantity: 17, targetUnit: 'labourers' },
    { title: 'Coltan purchases', targetQuantity: 313.7, targetUnit: 'kg' },
    { title: 'Garden organisation', targetQuantity: 1, targetUnit: 'entries' },
    { title: 'Something uncounted', targetQuantity: null, targetUnit: '' }
  ]) {
    const form = derive(objective);
    assert.ok(form.amountKey, `no amountKey for ${objective.targetUnit}`);
    assert.ok(form.amountKey.startsWith('form.ask.'), form.amountKey);
    assert.equal(form.amountLabel, undefined, 'derive() stored a sentence');
    assert.equal(form.amountHint, undefined, 'derive() stored a hint sentence');
    // Left absent so the client falls back to plan.dayNotes and plan.dayProof,
    // which are translated.
    assert.equal(form.notesLabel, undefined);
    assert.equal(form.evidenceLabel, undefined);
  }
});
check('countable work steps by one, measured work by a hundredth', () => {
  // This ran the other way round once: a list of 26 countable words stepped by
  // one and everything else fell through to 0.01, which put 45 of the first
  // real month's 61 objectives on a decimal spinner for whole things.
  for (const unit of ['labourers', 'sacks', 'pieces', 'bottles', 'meals', 'trips', 'entries', 'people']) {
    assert.equal(derive({ targetQuantity: 10, targetUnit: unit }).step, 1, unit);
  }
  for (const unit of ['kg', 'litres', 'metres', 'tonnes', 'ha']) {
    assert.equal(derive({ targetQuantity: 10, targetUnit: unit }).step, 0.01, unit);
  }
});
check('a fractional target stays reachable whatever its unit', () => {
  // 2.5 on a step of 1 is a number the browser refuses, so the manager could
  // not record the target their own month was set.
  assert.equal(derive({ targetQuantity: 2.5, targetUnit: 'sacks' }).step, 0.01);
  assert.equal(derive({ targetQuantity: 4.5, targetUnit: 'labourers' }).step, 0.01);
});
check('every counted objective offers one-tap amounts', () => {
  // quickAmounts was hard-coded empty and only ever filled by the model, so the
  // buttons were unreachable on any deployment without ANTHROPIC_API_KEY.
  for (const target of [1, 2, 3, 17, 120, 313.7, 424]) {
    const amounts = derive({ targetQuantity: target, targetUnit: 'kg' }).quickAmounts;
    assert.ok(amounts.length > 0, `no amounts for a target of ${target}`);
    assert.ok(amounts.length <= 3, `${amounts.length} amounts for ${target}`);
    assert.ok(amounts.every((amount) => amount > 0 && amount <= target), JSON.stringify(amounts));
    assert.deepEqual([...amounts].sort((a, b) => a - b), amounts, 'not sorted');
  }
});
check('an objective with nothing to count offers none', () => {
  assert.deepEqual(derive({ title: 'Keep the site in order', targetQuantity: null }).quickAmounts, []);
});
check('a model that answers nothing leaves the derived form standing', () => {
  const objective = { title: 'Fuel bought', targetQuantity: 40, targetUnit: 'litres' };
  const base = derive(objective);
  const checked = validate({ quickAmounts: [] }, objective);
  // The keys survive, so the question is still translated, and declining to
  // suggest amounts is not an instruction to remove the buttons.
  assert.equal(checked.amountKey, base.amountKey);
  assert.deepEqual(checked.quickAmounts, base.quickAmounts);
  assert.equal(checked.amountLabel, undefined);
});
check('a model that writes wording wins over the key', () => {
  const objective = { title: 'Fuel bought', targetQuantity: 40, targetUnit: 'litres' };
  const checked = validate({ amountLabel: 'Litres of fuel bought today', quickAmounts: [5, 10] }, objective);
  assert.equal(checked.amountLabel, 'Litres of fuel bought today');
  assert.equal(checked.amountKey, derive(objective).amountKey, 'the fallback key was dropped');
  assert.deepEqual(checked.quickAmounts, [5, 10]);
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
