// The Farming Management rules (shared/farming.js), checked without a database.
//
// Like pure-logic, this suite needs nothing running and writes nothing: every
// input is a plain object built here. It proves the arithmetic and the
// refusals before the farm tables exist, so the routes that will call these
// functions inherit rules that are already known to hold.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_ANIMAL_TYPES, FARM_CURRENCIES, FARM_ERROR_CODES, FARM_EXPENSE_CATEGORIES, SHARED_SCOPE,
  productDeltas, runningBalance, validateIssue, validateThresholds,
  addDays, budgetLine, correctionReasonValid, daysBetween, farmAlerts, farmSummary,
  isDateOnly, newAlerts, normaliseName, periodKey, possibleDuplicateExpense,
  possibleDuplicateProduction, productionTrend, removalBlocked, selectableTypes,
  unitCostFor, validateAnimalType, validateExpense, validateHerdEvent,
  validateMeasure, validateProduction, validateSale
} from '../shared/farming.js';
import { CURRENCIES } from '../server/lib/rates.js';
import { isValidDate } from '../server/lib/http.js';

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

const TODAY = '2026-10-25';
const cows = { id: 1, name: 'Cows', active: true };
const chickens = { id: 2, name: 'Chickens', active: true };
const goats = { id: 3, name: 'Goats', active: true };
const sheep = { id: 4, name: 'Sheep', active: false };
const milk = { id: 11, animalTypeId: 1, name: 'Milk', kind: 'product', unit: 'litres', sellable: true, active: true, dailyExpected: true };
const eggs = { id: 12, animalTypeId: 2, name: 'Eggs', kind: 'product', unit: 'pieces', sellable: true, active: true, dailyExpected: true };
const herd = { id: 13, animalTypeId: 3, name: 'Goats', kind: 'herd', unit: 'head', active: true };
const types = [cows, chickens, goats, sheep];

console.log('\n=== 1. what the farm agrees with the rest of the system ===');
check('the farm currencies are the exchange-rate register\'s', () => {
  assert.deepEqual([...FARM_CURRENCIES].sort(), [...CURRENCIES].sort());
});
check('a date is read the way the API reads one', () => {
  for (const value of ['2026-02-28', '2026-02-29', '2024-02-29', '2026-13-01', '2026-1-1', '', null, '2026-10-25T00:00']) {
    assert.equal(isDateOnly(value), isValidDate(value), String(value));
  }
});
check('date arithmetic does not move a day across timezones or months', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(daysBetween('2026-10-01', '2026-10-31'), 31);
});
check('a week is named by its Monday, a month by its YYYY-MM', () => {
  assert.equal(periodKey('2026-10-25', 'weekly'), '2026-10-19'); // a Sunday
  assert.equal(periodKey('2026-10-19', 'weekly'), '2026-10-19'); // a Monday
  assert.equal(periodKey('2026-11-01', 'weekly'), '2026-10-26'); // a week across two months
  assert.equal(periodKey('2026-10-25', 'monthly'), '2026-10');
  assert.equal(periodKey('2026-10-25', 'daily'), '2026-10-25');
});

console.log('\n=== 2. animal types are data, not code ===');
check('the three starting types are seeded data, each with valid measures', () => {
  assert.deepEqual(DEFAULT_ANIMAL_TYPES.map((type) => type.key), ['cows', 'chickens', 'goats']);
  for (const type of DEFAULT_ANIMAL_TYPES) {
    const result = validateAnimalType(type);
    assert.deepEqual(result.errors, [], type.key);
  }
});
check('goats are not assumed to give milk, nor every type a product', () => {
  const goatsSeed = DEFAULT_ANIMAL_TYPES.find((type) => type.key === 'goats');
  assert.equal(goatsSeed.measures.some((measure) => measure.kind === 'product'), false);
});
check('a new type is accepted with its own measures and categories', () => {
  const result = validateAnimalType({
    name: '  Pigs ', measures: [{ name: 'Piglets', kind: 'herd', unit: 'head' }], expenseCategories: ['Pig feed', 'Pig feed']
  }, { existing: types });
  assert.deepEqual(result.errors, []);
  assert.equal(result.value.name, 'Pigs');
  assert.deepEqual(result.value.expenseCategories, ['Pig feed']);
  assert.equal(result.value.measures[0].sellable, false, 'a herd measure is sold through a herd event, not as a product');
});
check('a duplicate name is refused whatever its case or spacing, even against a deactivated type', () => {
  assert.deepEqual(validateAnimalType({ name: 'COWS' }, { existing: types }).errors, ['NAME_EXISTS']);
  assert.deepEqual(validateAnimalType({ name: ' sheep  ' }, { existing: types }).errors, ['NAME_EXISTS']);
  assert.equal(normaliseName('  Guinea   Fowl '), 'guinea fowl');
});
check('a type may keep its own name when edited', () => {
  assert.deepEqual(validateAnimalType({ name: 'Cows' }, { existing: types, editingId: 1 }).errors, []);
});
check('blank and over-long names are refused', () => {
  assert.deepEqual(validateAnimalType({ name: '   ' }).errors, ['NAME_REQUIRED']);
  assert.deepEqual(validateAnimalType({ name: 'x'.repeat(61) }).errors, ['NAME_TOO_LONG']);
});
check('a measure needs a name, a known kind and a unit; two of the same name are refused', () => {
  assert.deepEqual(validateMeasure({ name: 'Wool', kind: 'fleece', unit: '' }).errors, ['KIND_INVALID', 'UNIT_REQUIRED']);
  const twice = validateAnimalType({ name: 'Ducks', measures: [{ name: 'Eggs', kind: 'product', unit: 'pieces' }, { name: 'eggs', kind: 'product', unit: 'trays' }] });
  assert.deepEqual(twice.errors, ['MEASURE_NAME_EXISTS']);
});
check('a deactivated type disappears from new-record forms only', () => {
  assert.deepEqual(selectableTypes(types).map((type) => type.id), [1, 2, 3]);
});
check('a type with history cannot be removed, only deactivated', () => {
  assert.equal(removalBlocked({ production: 0, expenses: 3 }), 'HAS_RECORDS_DEACTIVATE_INSTEAD');
  assert.equal(removalBlocked({ production: 0, expenses: 0 }), null);
});
check('historical records of a deactivated type still count in the figures', () => {
  const summary = farmSummary({
    types: [sheep],
    expenses: [{ date: '2026-10-01', animalTypeId: 4, category: 'animal_feed', amountUsd: 20 }]
  });
  const block = summary.animalTypes.find((entry) => entry.animalTypeId === 4);
  assert.equal(block.directExpensesUsd, 20);
  assert.equal(summary.farm.expensesUsd, 20);
});

console.log('\n=== 3. production ===');
const produce = (input, extra = {}) => validateProduction(input, { type: cows, measure: milk, today: TODAY, ...extra });
check('a day of milk works out what is left; it is never typed', () => {
  const result = produce({ date: TODAY, produced: 42.5, lost: 2.5 }, { openingStock: 5 });
  assert.deepEqual(result.errors, []);
  assert.equal(result.value.remaining, 45);
  assert.equal(result.value.unit, 'litres', 'the unit is the measure\'s');
});
check('a blank loss is "none", but a blank production is refused', () => {
  assert.equal(produce({ date: TODAY, produced: 10 }).value.remaining, 10);
  assert.deepEqual(produce({ date: TODAY, produced: '' }).errors, ['PRODUCED_INVALID']);
});
check('losing more than there was is refused, to the hundredth', () => {
  assert.deepEqual(produce({ date: TODAY, produced: 10, lost: 10.01 }).errors, ['MORE_OUT_THAN_AVAILABLE']);
  assert.equal(produce({ date: TODAY, produced: 12.3, lost: 12.3 }).value.remaining, 0);
});
check('stock is checked over the whole history, so a backdated change cannot strand a later sale', () => {
  const made = [{ date: '2026-10-09', order: 1, produced: 30, lost: 0 }];
  const sold = [{ date: '2026-10-10', order: 2, quantity: 30 }];
  assert.deepEqual(runningBalance(productDeltas({ production: made, sales: sold })), { balance: 0, lowest: 0, lowestDate: null });
  const voided = runningBalance(productDeltas({ production: [{ ...made[0], status: 'voided' }], sales: sold }));
  assert.deepEqual(voided, { balance: -30, lowest: -30, lowestDate: '2026-10-10' });
  const late = runningBalance(productDeltas({ production: [{ date: '2026-10-11', order: 3, produced: 30, lost: 0 }], sales: sold }));
  assert.equal(late.lowest, -30, 'selling before producing is caught');
});
check('within a day, what came in counts before what went out, whatever was typed first', () => {
  const morningSaleTypedFirst = productDeltas({ sales: [{ date: TODAY, quantity: 30 }], production: [{ date: TODAY, produced: 40, lost: 0 }] });
  assert.equal(runningBalance(morningSaleTypedFirst).lowest, 0);
  assert.equal(runningBalance([{ date: TODAY, delta: -5 }, { date: TODAY, delta: 5 }]).lowest, 0);
  assert.equal(runningBalance([{ date: TODAY, delta: -6 }, { date: TODAY, delta: 5 }]).lowest, -1, 'the day as a whole still cannot go below zero');
});
check('negative, non-numeric, future-dated and impossible dates are refused', () => {
  assert.ok(produce({ date: TODAY, produced: -1 }).errors.includes('PRODUCED_INVALID'));
  assert.ok(produce({ date: TODAY, produced: 'lots' }).errors.includes('PRODUCED_INVALID'));
  assert.ok(produce({ date: '2026-10-26', produced: 1 }).errors.includes('DATE_IN_FUTURE'));
  assert.ok(produce({ date: '2026-02-30', produced: 1 }).errors.includes('DATE_INVALID'));
});
check('only the selected type\'s own active product measures are accepted', () => {
  assert.ok(produce({ date: TODAY, produced: 1 }, { measure: eggs }).errors.includes('MEASURE_NOT_FOR_TYPE'));
  assert.ok(produce({ date: TODAY, produced: 1 }, { type: goats, measure: herd }).errors.includes('MEASURE_NOT_PRODUCT'));
  assert.ok(produce({ date: TODAY, produced: 1 }, { measure: { ...milk, active: false } }).errors.includes('MEASURE_INACTIVE'));
  assert.ok(produce({ date: TODAY, produced: 1 }, { type: { ...cows, active: false } }).errors.includes('TYPE_INACTIVE'));
});
check('a second entry the same day is a warning to confirm, not a refusal', () => {
  const existing = [{ id: 1, date: TODAY, measureId: 11 }, { id: 2, date: TODAY, measureId: 11, status: 'voided' }, { id: 3, date: '2026-10-24', measureId: 11 }];
  assert.deepEqual(possibleDuplicateProduction({ date: TODAY, measureId: 11 }, existing).map((row) => row.id), [1]);
  assert.deepEqual(possibleDuplicateProduction({ id: 1, date: TODAY, measureId: 11 }, existing), [], 'an entry is not its own duplicate');
});

console.log('\n=== 4. herd changes ===');
const event = (input, headCount = 10) => validateHerdEvent(input, { type: goats, measure: herd, today: TODAY, headCount });
check('births and purchases add, deaths and sales take away', () => {
  assert.equal(event({ date: TODAY, kind: 'birth', count: 2 }).value.after, 12);
  assert.equal(event({ date: TODAY, kind: 'sale', count: 3 }).value.after, 7);
});
check('a count replaces the figure and records the difference', () => {
  const result = event({ date: TODAY, kind: 'count', count: 8 });
  assert.equal(result.value.delta, -2);
  assert.equal(result.value.after, 8);
});
check('the herd cannot go below nothing, and animals are whole', () => {
  assert.ok(event({ date: TODAY, kind: 'sale', count: 11 }).errors.includes('HERD_BELOW_ZERO'));
  assert.ok(event({ date: TODAY, kind: 'birth', count: 1.5 }).errors.includes('COUNT_INVALID'));
});
check('a death must say what happened', () => {
  assert.ok(event({ date: TODAY, kind: 'death', count: 1 }).errors.includes('REASON_REQUIRED'));
  assert.deepEqual(event({ date: TODAY, kind: 'death', count: 1, reason: 'Illness, vet called' }).errors, []);
});

console.log('\n=== 5. expenses and sales ===');
const spend = (input) => validateExpense(input, { types, today: TODAY });
const feed = { date: TODAY, amount: 120000, currency: 'RWF', scope: '1', category: 'animal_feed', description: 'Dairy meal, 4 bags', payee: 'Agro shop' };
check('an expense for one animal type is accepted', () => {
  const result = spend(feed);
  assert.deepEqual(result.errors, []);
  assert.equal(result.value.animalTypeId, 1);
  assert.equal(result.value.shared, false);
});
check('a shared expense stays shared and is never allocated', () => {
  const result = spend({ ...feed, scope: SHARED_SCOPE, category: 'water_electricity' });
  assert.equal(result.value.shared, true);
  assert.equal(result.value.animalTypeId, null);
});
check('amount, currency, scope, category and description are all checked', () => {
  const result = spend({ date: TODAY, amount: 0, currency: 'EUR', scope: '99', category: 'holiday', description: ' ' });
  assert.deepEqual(result.errors, ['AMOUNT_INVALID', 'CURRENCY_INVALID', 'SCOPE_INVALID', 'CATEGORY_INVALID', 'DESCRIPTION_REQUIRED']);
});
check('a new expense cannot be charged to a deactivated type', () => {
  assert.ok(spend({ ...feed, scope: '4' }).errors.includes('TYPE_INACTIVE'));
});
check('every starting category is accepted', () => {
  for (const category of FARM_EXPENSE_CATEGORIES) assert.deepEqual(spend({ ...feed, category }).errors, [], category);
});
check('the same cost typed twice is caught; the same purchase next week is not', () => {
  const saved = [{ id: 7, ...feed, animalTypeId: 1 }];
  assert.equal(possibleDuplicateExpense({ ...feed, animalTypeId: 1 }, saved).length, 1);
  assert.equal(possibleDuplicateExpense({ ...feed, animalTypeId: 1, payee: '  AGRO   shop' }, saved).length, 1);
  assert.equal(possibleDuplicateExpense({ ...feed, animalTypeId: 1, date: addDays(TODAY, -7) }, saved).length, 0);
  assert.equal(possibleDuplicateExpense({ ...feed, animalTypeId: null }, saved).length, 0, 'shared is a different scope');
  assert.equal(possibleDuplicateExpense({ ...feed, animalTypeId: 1 }, [{ ...saved[0], status: 'voided' }]).length, 0);
});
check('a sale records money received, apart from production', () => {
  const result = validateSale({ date: TODAY, quantity: 30, amount: 15000, currency: 'RWF' }, { type: cows, measure: milk, today: TODAY });
  assert.deepEqual(result.errors, []);
  assert.ok(validateSale({ date: TODAY, quantity: 1.5, amount: 1, currency: 'USD' }, { type: goats, measure: herd, today: TODAY }).errors.includes('QUANTITY_INVALID'));
  assert.ok(validateSale({ date: TODAY, quantity: 1, amount: 0, currency: 'USD' }, { type: cows, measure: milk, today: TODAY }).errors.includes('AMOUNT_INVALID'));
});
check('a problem report: an animal-welfare issue is always urgent', () => {
  assert.equal(validateIssue({ kind: 'animal_welfare', description: 'Calf not feeding', urgent: false }).value.urgent, true);
  assert.equal(validateIssue({ kind: 'missing_supply', description: 'Out of layer mash' }).value.urgent, false);
  assert.deepEqual(validateIssue({ kind: 'party', description: '', animalTypeId: 99 }, { types }).errors, ['KIND_INVALID', 'DESCRIPTION_REQUIRED', 'SCOPE_INVALID']);
});
check('alert thresholds: known keys, whole numbers, sensible ranges', () => {
  assert.deepEqual(validateThresholds({ declinePercent: 30 }).value, { declinePercent: 30 });
  assert.deepEqual(validateThresholds({ declinePercent: 1 }).errors, ['THRESHOLD_INVALID']);
  assert.deepEqual(validateThresholds({ nagEveryHour: 1 }).errors, ['THRESHOLD_UNKNOWN']);
  assert.deepEqual(validateThresholds({ recentDays: 3, minRecentRecords: 5 }).errors, ['THRESHOLD_INVALID']);
});
check('every code a validator can answer is listed, so the screen has words for it', () => {
  const source = readFileSync(new URL('../shared/farming.js', import.meta.url), 'utf8');
  const pushed = [...source.matchAll(/push\('([A-Z_]+)'\)/g)].map((match) => match[1]);
  const measureCodes = ['NAME_REQUIRED', 'NAME_TOO_LONG', 'KIND_INVALID', 'UNIT_REQUIRED', 'UNIT_TOO_LONG'].map((code) => `MEASURE_${code}`);
  assert.deepEqual([...new Set([...pushed, ...measureCodes])].filter((code) => !FARM_ERROR_CODES.includes(code)), []);
  assert.equal(new Set(FARM_ERROR_CODES).size, FARM_ERROR_CODES.length, 'no code listed twice');
});
check('a correction must say why in more than a word', () => {
  assert.equal(correctionReasonValid('typo'), false);
  assert.equal(correctionReasonValid('Receipt showed 12,000 not 21,000'), true);
});

console.log('\n=== 6. the figures ===');
const production = [
  { date: '2026-10-01', animalTypeId: 1, measureId: 11, produced: 40, lost: 1 },
  { date: '2026-10-02', animalTypeId: 1, measureId: 11, produced: 38.5, lost: 0 },
  { date: '2026-10-02', animalTypeId: 1, measureId: 11, produced: 999, lost: 0, status: 'voided' },
  { date: '2026-10-01', animalTypeId: 2, measureId: 12, produced: 300, lost: 6 },
  { date: '2026-11-01', animalTypeId: 2, measureId: 12, produced: 280, lost: 0 }
];
const sales = [
  { date: '2026-10-01', animalTypeId: 1, measureId: 11, quantity: 60, amountUsd: 24.6 },
  { date: '2026-10-01', animalTypeId: 2, measureId: 12, quantity: 270, amountUsd: 30.1 }
];
const expenses = [
  { date: '2026-10-01', animalTypeId: 1, category: 'animal_feed', amountUsd: 10.1 },
  { date: '2026-10-02', animalTypeId: 1, category: 'veterinary', amountUsd: 5.2 },
  { date: '2026-10-02', animalTypeId: null, category: 'labour', amountUsd: 20 },
  { date: '2026-10-02', animalTypeId: 2, category: 'animal_feed', amountUsd: 7, status: 'voided' }
];
const herdEvents = [
  { date: '2026-10-02', animalTypeId: 3, measureId: 13, kind: 'birth', delta: 2 },
  { date: '2026-10-02', animalTypeId: 3, measureId: 13, kind: 'death', delta: -1, reason: 'Snake bite' }
];
const summary = farmSummary({ types: [cows, chickens, goats], measures: [milk, eggs, herd], production, sales, expenses, herdEvents, from: '2026-10-01', to: '2026-10-31', budgetUsd: 30 });
const block = (id) => summary.animalTypes.find((entry) => entry.animalTypeId === id);
check('produced and lost add up per product, sold comes from the sales, voided rows left out', () => {
  assert.deepEqual(
    { produced: block(1).products[0].produced, sold: block(1).products[0].sold, lost: block(1).products[0].lost },
    { produced: 78.5, sold: 60, lost: 1 }
  );
  assert.equal(block(2).products[0].produced, 300, 'November is outside the period');
});
check('days nobody recorded are counted as missing, not as zero', () => {
  assert.equal(block(1).products[0].daysRecorded, 2);
  assert.equal(block(1).products[0].daysWithoutRecord, 29);
});
check('herd changes are summed by kind', () => {
  assert.deepEqual(block(3).herd[0], { measureId: 13, births: 2, purchases: 0, deaths: 1, sales: 0, otherChange: 0, netChange: 1 });
});
check('revenue comes from sales, not from production', () => {
  assert.equal(block(1).revenueUsd, 24.6);
  assert.equal(summary.farm.revenueUsd, 54.7);
});
check('per type is a DIRECT result; shared costs appear only at farm level', () => {
  assert.equal(block(1).directExpensesUsd, 15.3);
  assert.equal(block(1).directResultUsd, 9.3);
  assert.equal(summary.farm.sharedExpensesUsd, 20);
  assert.equal(summary.farm.expensesUsd, 35.3);
  assert.equal(summary.farm.operatingResultUsd, 19.4);
  assert.equal('netProfitUsd' in summary.farm, false, 'never called net profit');
});
check('expenses by category include shared ones and are summed in cents', () => {
  assert.deepEqual(summary.farm.expensesByCategory, [
    { category: 'labour', amountUsd: 20 }, { category: 'animal_feed', amountUsd: 10.1 }, { category: 'veterinary', amountUsd: 5.2 }
  ]);
});
check('budget against actual, and no budget means no line', () => {
  assert.deepEqual(summary.farm.budget, { budgetUsd: 30, spentUsd: 35.3, remainingUsd: -5.3, over: true, percentUsed: 117.7 });
  assert.equal(budgetLine(0, 10), null);
  assert.equal(budgetLine(null, 10), null);
});
check('unit cost is given only when honest, and flagged when shared costs are left out', () => {
  assert.deepEqual(block(1).unitCost, { available: true, measureId: 11, unit: 'litres', usdPerUnit: 0.1949, excludesShared: true, estimate: true });
  assert.deepEqual(block(3).unitCost, { available: false, reason: 'NO_PRODUCTION' });
  assert.deepEqual(unitCostFor({ products: [{ produced: 1 }, { produced: 2 }], directExpensesUsd: 5 }), { available: false, reason: 'SEVERAL_PRODUCTS' });
  assert.deepEqual(unitCostFor({ products: [{ produced: 1 }], directExpensesUsd: 0 }), { available: false, reason: 'NO_DIRECT_COSTS' });
});
check('a date range narrows every figure', () => {
  const oneDay = farmSummary({ production, sales, expenses, from: '2026-10-02', to: '2026-10-02' });
  assert.equal(oneDay.animalTypes.find((entry) => entry.animalTypeId === 1).products[0].produced, 38.5);
  assert.equal(oneDay.farm.revenueUsd, 0);
  assert.equal(oneDay.farm.expensesUsd, 25.2);
});
check('a trend leaves gaps where nothing was recorded', () => {
  assert.deepEqual(productionTrend(production, { measureId: 12, period: 'monthly' }), [
    { period: '2026-10', produced: 300, daysRecorded: 1 }, { period: '2026-11', produced: 280, daysRecorded: 1 }
  ]);
  assert.equal(productionTrend(production, { measureId: 11, period: 'daily' }).length, 2);
});

console.log('\n=== 7. alerts explain themselves and are raised once ===');
const days = (from, count, produced) => Array.from({ length: count }, (_, index) => ({ date: addDays(from, index), measureId: 11, produced }));
const usual = days('2026-09-21', 28, 40);
check('a real decline on enough recorded days raises one alert with its figures', () => {
  const alerts = farmAlerts({ today: TODAY, measures: [milk], production: [...usual, ...days('2026-10-19', 7, 30)] });
  const decline = alerts.find((alert) => alert.kind === 'production_decline');
  assert.equal(decline.params.changePercent, -25);
  assert.equal(decline.params.baselineAverage, 40);
  assert.equal(decline.severity, 'normal');
});
check('too few recorded days is not evidence of a decline', () => {
  const alerts = farmAlerts({ today: TODAY, measures: [milk], production: [...usual, ...days('2026-10-23', 3, 10)] });
  assert.equal(alerts.some((alert) => alert.kind === 'production_decline'), false);
});
check('a small dip is not a decline', () => {
  const alerts = farmAlerts({ today: TODAY, measures: [milk], production: [...usual, ...days('2026-10-19', 7, 35)] });
  assert.equal(alerts.some((alert) => alert.kind === 'production_decline'), false);
});
check('a gap in the records is reported as a gap, and only for daily products', () => {
  const alerts = farmAlerts({ today: TODAY, measures: [milk, { ...eggs, dailyExpected: false }], production: [{ date: '2026-10-20', measureId: 11, produced: 40 }, { date: '2026-10-01', measureId: 12, produced: 5 }] });
  const gaps = alerts.filter((alert) => alert.kind === 'no_recent_record');
  assert.equal(gaps.length, 1);
  assert.deepEqual(gaps[0].params, { measureId: 11, lastRecorded: '2026-10-20', daysWithoutRecord: 4 });
});
check('today is never counted as a missed day', () => {
  const alerts = farmAlerts({ today: TODAY, measures: [milk], production: [{ date: '2026-10-22', measureId: 11, produced: 40 }] });
  assert.equal(alerts.some((alert) => alert.kind === 'no_recent_record'), false, '23 and 24 missing is two days, under the threshold');
});
check('a death with no cause is urgent; one with a cause is not an alert', () => {
  const alerts = farmAlerts({ today: TODAY, herdEvents: [
    { id: 1, date: TODAY, animalTypeId: 3, kind: 'death', delta: -2, reason: '' },
    { id: 2, date: TODAY, animalTypeId: 3, kind: 'death', delta: -1, reason: 'Old age' }
  ] });
  assert.deepEqual(alerts.map((alert) => [alert.kind, alert.severity, alert.params.count]), [['unexplained_loss', 'urgent', 2]]);
});
check('an expense rise needs history, a real rise and a real amount', () => {
  const history = [{ category: 'veterinary', month: '2026-08', amountUsd: 100 }, { category: 'veterinary', month: '2026-09', amountUsd: 100 }];
  const spike = farmAlerts({ today: TODAY, expenseHistory: history, expenses: [{ date: '2026-10-03', category: 'veterinary', amountUsd: 180 }] });
  assert.equal(spike[0].kind, 'expense_rise');
  assert.equal(spike[0].params.risePercent, 80);
  assert.equal(farmAlerts({ today: TODAY, expenseHistory: history.slice(1), expenses: [{ date: '2026-10-03', category: 'veterinary', amountUsd: 500 }] }).length, 0, 'one month of history is not "usual"');
  const tiny = [{ category: 'transport', month: '2026-08', amountUsd: 3 }, { category: 'transport', month: '2026-09', amountUsd: 3 }];
  assert.equal(farmAlerts({ today: TODAY, expenseHistory: tiny, expenses: [{ date: '2026-10-03', category: 'transport', amountUsd: 9 }] }).length, 0, 'tripling $3 is not worth an alert');
});
check('budget: a warning near the ceiling, an overrun past it, nothing without one', () => {
  assert.equal(farmAlerts({ today: TODAY, budgetUsd: 100, monthSpentUsd: 92 })[0].kind, 'budget_near');
  assert.equal(farmAlerts({ today: TODAY, budgetUsd: 100, monthSpentUsd: 101 })[0].kind, 'budget_over');
  assert.equal(farmAlerts({ today: TODAY, budgetUsd: 0, monthSpentUsd: 101 }).length, 0);
});
check('only critical tasks raise an overdue alert', () => {
  const alerts = farmAlerts({ today: TODAY, tasks: [
    { id: 1, critical: true, dueOn: '2026-10-23', status: 'open' },
    { id: 2, critical: false, dueOn: '2026-10-01', status: 'open' },
    { id: 3, critical: true, dueOn: '2026-10-01', status: 'done' }
  ] });
  assert.deepEqual(alerts.map((alert) => [alert.kind, alert.params.taskId, alert.params.daysOverdue]), [['critical_task_overdue', 1, 2]]);
});
check('the same unresolved issue is not raised twice', () => {
  const alerts = farmAlerts({ today: TODAY, budgetUsd: 100, monthSpentUsd: 101 });
  assert.equal(newAlerts(alerts, [alerts[0].key]).length, 0);
  assert.equal(newAlerts(alerts, []).length, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
