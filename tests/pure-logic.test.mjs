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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
