// The Farming Management rules: what the API and the browser must agree on
// about animal types, production, farm expenses, sales and the figures and
// alerts built from them.
//
// Everything here is a pure function over plain objects: no database, no React, no clock unless
// one is passed in. The tables they guard are created by
// server/db/farmingSchema.js; the routes in server/routes/farming.js and the
// screen in src/Farming.jsx both call these functions, so the form and the API
// can only disagree by not calling them, and the arithmetic is proved by
// tests/farming-logic.test.mjs without a database.
//
// WHAT THIS FILE REFUSES TO DO, ON PURPOSE:
//   - It never turns a missing day into a zero. A day nobody recorded is "no
//     record", and every total says how many such days it is missing. Treating
//     an unrecorded day as zero production would both understate the farm and
//     read as somebody's failure.
//   - It never allocates a shared expense to an animal. A bag of feed bought
//     for the whole farm stays "shared" until the business documents how to
//     split it; per-animal figures are labelled as before shared costs.
//   - It never calls revenue minus expenses "net profit". The farm's books
//     leave out depreciation, the value of the herd and stock on hand, so the
//     figure is an OPERATING RESULT, and per animal type it is a DIRECT
//     operating result.
//   - Validators answer with codes, never sentences. The screen translates a
//     code in the reader's language, the way notifications carry a kind.
//
// Imported by the API and the browser, so it must stay free of React and of
// anything Node-only.

// ---- reference lists -----------------------------------------------------

// The currencies a farm expense or sale may be typed in. These are the
// currencies of the exchange-rate register (CURRENCIES in server/lib/rates.js);
// they are restated here only because shared/ cannot import from server/, and
// tests/farming-logic.test.mjs fails the moment the two lists differ. The rate
// itself is never chosen here: the API freezes the current reference rate onto
// the row with convertAmount, exactly as a trip does, and every figure below
// reads the frozen USD amount.
export const FARM_CURRENCIES = ['RWF', 'USD', 'CDF'];

// What a production measure counts. A `product` is something the animals give
// that can be sold, lost or kept (milk, eggs); a `herd` measure is the animals
// themselves (births, purchases, deaths, sales).
export const MEASURE_KINDS = ['product', 'herd'];

// The ways a herd changes, and which way each one moves the head count.
export const HERD_EVENT_KINDS = ['birth', 'purchase', 'death', 'sale', 'transfer_in', 'transfer_out', 'count'];
export const HERD_ADDING = ['birth', 'purchase', 'transfer_in'];
// A death is the event an alert must never miss: it is an animal-welfare
// question first and a figure second.
export const HERD_LOSSES = ['death'];

// Where an expense belongs: one animal type, or the farm as a whole.
export const SHARED_SCOPE = 'shared';

// The expense categories every farm starts with. Configurable per animal type
// on top of these (an animal type can name its own), but these are always
// offered, so a cost never has nowhere to go.
export const FARM_EXPENSE_CATEGORIES = [
  'animal_feed', 'veterinary', 'medicine_vaccines', 'labour', 'transport',
  'equipment_maintenance', 'water_electricity', 'other'
];

export const FARM_PERIODS = ['daily', 'weekly', 'monthly'];

// A production entry, a herd change and a sale are facts once recorded: they
// are corrected with a reason or voided with one, never deleted.
export const RECORD_STATUSES = ['recorded', 'voided'];

// An expense a team member submits waits for the Farming Manager. One the
// manager (or the Director) records is theirs to answer for and is approved as
// it is recorded -- the audit row says so. An approved expense is never edited;
// it is voided with a reason and entered again.
export const EXPENSE_STATUSES = ['pending', 'approved', 'rejected', 'voided'];

// What a team member can raise when something stands in the way of the work.
// `animal_welfare` is always urgent; the others are urgent only when the
// person raising them says so.
export const ISSUE_KINDS = ['animal_welfare', 'missing_supply', 'equipment', 'blocker', 'other'];
export const ISSUE_STATUSES = ['open', 'resolved'];

// The same floor as MIN_CORRECTION_NOTE in server/routes/activities.js: a
// correction says why, in more than a word.
export const FARM_CORRECTION_MIN = 10;

export const NAME_MAX = 60;
export const UNIT_MAX = 30;
export const TEXT_MAX = 1000;
// The same NUMERIC-safe ceiling validNumber uses in server/lib/http.js.
const LARGEST_AMOUNT = 1e15;

// The three animal types the farm keeps today, as the migration will seed
// them. They are DATA, not code: once seeded, nothing anywhere branches on
// 'cows' or 'chickens', and a fourth type added from the screen is handled by
// exactly the same functions. The measures are what the spec lists as
// examples; each is a row the Farming Manager can switch off, because not
// every cow gives milk and not every hen lays.
export const DEFAULT_ANIMAL_TYPES = [
  {
    key: 'cows',
    name: 'Cows',
    measures: [
      { key: 'milk', name: 'Milk', kind: 'product', unit: 'litres', sellable: true, perishable: true, dailyExpected: true },
      { key: 'cattle', name: 'Cattle', kind: 'herd', unit: 'head' }
    ]
  },
  {
    key: 'chickens',
    name: 'Chickens',
    measures: [
      { key: 'eggs', name: 'Eggs', kind: 'product', unit: 'pieces', sellable: true, perishable: true, dailyExpected: true },
      { key: 'birds', name: 'Birds', kind: 'herd', unit: 'birds' }
    ]
  },
  {
    key: 'goats',
    name: 'Goats',
    measures: [
      { key: 'goats', name: 'Goats', kind: 'herd', unit: 'head' }
    ]
  }
];

// ---- small helpers ---------------------------------------------------------

// A date-only 'YYYY-MM-DD' that names a real day. Mirrors isValidDate in
// server/lib/http.js (the test holds them together); parsed by hand rather
// than by `new Date(string)`, which reads it as UTC midnight and moves it a day
// in Kigali.
export function isDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// Money is added in hundredths, as everywhere else in the system.
export function toCents(value) {
  return Math.round(Number(value || 0) * 100);
}

export function fromCents(value) {
  return Number(value || 0) / 100;
}

// How two names are compared for "that already exists": case, surrounding
// spaces and repeated spaces do not make a second animal type. "Sheep", " sheep " and
// "SHEEP" are one.
export function normaliseName(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// A count or an amount: a finite number, not negative, under the ceiling.
// Returns null for anything else, including a blank -- which is "not typed",
// never zero.
function quantity(value, { allowZero = true, maximum = LARGEST_AMOUNT } = {}) {
  if (value === '' || value === null || value === undefined) return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < 0 || number > maximum) return null;
  if (!allowZero && number === 0) return null;
  return number;
}

function wholeNumber(value) {
  return Number.isInteger(value);
}

// The day after `day`, both date-only strings.
export function addDays(day, count) {
  const [year, month, date] = day.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, date + count));
  return next.toISOString().slice(0, 10);
}

// Inclusive count of days from `from` to `to`.
export function daysBetween(from, to) {
  const toUtc = (day) => {
    const [year, month, date] = day.split('-').map(Number);
    return Date.UTC(year, month - 1, date);
  };
  return Math.round((toUtc(to) - toUtc(from)) / 86400000) + 1;
}

// The bucket a day falls in for a daily, weekly or monthly summary. A week
// starts on Monday and is named by that Monday, so a week spanning two months
// is still one week.
export function periodKey(day, period) {
  if (period === 'monthly') return day.slice(0, 7);
  if (period === 'weekly') {
    const [year, month, date] = day.split('-').map(Number);
    const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
    return addDays(day, -((weekday + 6) % 7));
  }
  return day;
}

// ---- animal types ----------------------------------------------------------

// A new or edited animal type. `existing` is every type already saved, active
// or not: a deactivated "Sheep" still owns its name, because reactivating it is
// the right answer to "we keep sheep again", not a second Sheep whose history
// starts from nothing. `editingId` lets a type keep its own name.
export function validateAnimalType(input, { existing = [], editingId = null } = {}) {
  const errors = [];
  const name = text(input?.name).replace(/\s+/g, ' ');
  if (!name) errors.push('NAME_REQUIRED');
  else if (name.length > NAME_MAX) errors.push('NAME_TOO_LONG');
  else if (existing.some((type) => type.id !== editingId && normaliseName(type.name) === normaliseName(name))) {
    errors.push('NAME_EXISTS');
  }

  const measures = Array.isArray(input?.measures) ? input.measures : [];
  const cleanMeasures = [];
  measures.forEach((measure) => {
    const result = validateMeasure(measure);
    if (result.errors.length) {
      errors.push(...result.errors.map((code) => `MEASURE_${code}`));
      return;
    }
    if (cleanMeasures.some((other) => normaliseName(other.name) === normaliseName(result.value.name))) {
      errors.push('MEASURE_NAME_EXISTS');
      return;
    }
    cleanMeasures.push(result.value);
  });

  const categories = Array.isArray(input?.expenseCategories) ? input.expenseCategories.map(text).filter(Boolean) : [];
  if (categories.some((category) => category.length > NAME_MAX)) errors.push('CATEGORY_TOO_LONG');

  return {
    errors,
    value: errors.length ? null : {
      name,
      active: input?.active !== false,
      measures: cleanMeasures,
      expenseCategories: [...new Set(categories)]
    }
  };
}

// One thing an animal type is measured by. The unit is the measure's, fixed:
// a production entry never chooses its own, so a month of milk is never part
// litres and part jerrycans.
export function validateMeasure(input) {
  const errors = [];
  const name = text(input?.name).replace(/\s+/g, ' ');
  const unit = text(input?.unit);
  const kind = input?.kind;
  if (!name) errors.push('NAME_REQUIRED');
  else if (name.length > NAME_MAX) errors.push('NAME_TOO_LONG');
  if (!MEASURE_KINDS.includes(kind)) errors.push('KIND_INVALID');
  if (!unit) errors.push('UNIT_REQUIRED');
  else if (unit.length > UNIT_MAX) errors.push('UNIT_TOO_LONG');
  return {
    errors,
    value: errors.length ? null : {
      name,
      kind,
      unit,
      // Only a product is sold or spoils; a herd is sold through a herd event.
      sellable: kind === 'product' && input?.sellable !== false,
      perishable: kind === 'product' && input?.perishable === true,
      dailyExpected: kind === 'product' && input?.dailyExpected === true,
      active: input?.active !== false
    }
  };
}

// The types a NEW record may name: the active ones. A record already saved
// against a type that has since been deactivated keeps it -- deactivation hides
// a type from the forms and from nothing else.
export function selectableTypes(types) {
  return (types || []).filter((type) => type.active !== false);
}

// Why an animal type cannot be removed outright. Removal is offered only for a
// type with no records at all (a typo caught the same day); anything with
// history is deactivated instead, so no record ever points at nothing.
export function removalBlocked(recordCounts) {
  const total = Object.values(recordCounts || {}).reduce((sum, count) => sum + Number(count || 0), 0);
  return total > 0 ? 'HAS_RECORDS_DEACTIVATE_INSTEAD' : null;
}

// ---- production ------------------------------------------------------------

// A day's production of one product (milk, eggs), as typed: how much was
// produced and how much was lost or spoiled. What was SOLD is not typed here:
// it is the sales recorded against the product (validateSale), which carry the
// money -- typing the quantity on both forms was two records of one fact that
// could disagree. `openingStock` is what was on hand before this entry, read
// by the API from the earlier rows, so `remaining` is worked out, never typed.
//
// A blank `lost` is "none recorded"; a blank `produced` is refused, because a
// production entry is the statement of how much was produced.
export function validateProduction(input, { type, measure, today, openingStock = 0 } = {}) {
  const errors = [];
  const date = input?.date;
  if (!isDateOnly(date)) errors.push('DATE_INVALID');
  else if (today && date > today) errors.push('DATE_IN_FUTURE');

  if (!type) errors.push('TYPE_REQUIRED');
  else if (type.active === false) errors.push('TYPE_INACTIVE');
  if (!measure) errors.push('MEASURE_REQUIRED');
  else {
    if (type && measure.animalTypeId !== undefined && measure.animalTypeId !== type.id) errors.push('MEASURE_NOT_FOR_TYPE');
    if (measure.kind !== 'product') errors.push('MEASURE_NOT_PRODUCT');
    if (measure.active === false) errors.push('MEASURE_INACTIVE');
  }

  const produced = quantity(input?.produced);
  const lost = input?.lost === '' || input?.lost === undefined || input?.lost === null ? 0 : quantity(input.lost);
  if (produced === null) errors.push('PRODUCED_INVALID');
  if (lost === null) errors.push('LOST_INVALID');

  const notes = text(input?.notes);
  if (notes.length > TEXT_MAX) errors.push('NOTES_TOO_LONG');

  let remaining = null;
  if (produced !== null && lost !== null) {
    const opening = Math.max(0, Number(openingStock) || 0);
    // Hundredths, so 12.3 litres in and 12.3 out leaves 0 and not 1e-15.
    const left = toCents(opening) + toCents(produced) - toCents(lost);
    if (left < 0) errors.push('MORE_OUT_THAN_AVAILABLE');
    else remaining = fromCents(left);
  }

  return {
    errors,
    value: errors.length ? null : { date, produced, lost, remaining, unit: measure.unit, notes }
  };
}

// The stock (or head count) after every row, in date order, and the lowest it
// ever falls. Rows are { date, delta }.
//
// A DAY IS ONE STEP. Within a day, everything that adds counts before
// everything that takes away, whatever order it was typed in: a farm hand who
// writes down the morning's milk sale at 10:00 and the milking itself in the
// evening has done nothing wrong, and ordering by the moment of typing refused
// the sale as "less than nothing". So a sale is checked against the whole of
// its day's production, never against part of it.
//
// WHY THE WHOLE HISTORY AND NOT JUST "THE LATEST BALANCE": an entry can be
// backdated, corrected or voided, and each of those changes every balance
// after it. Selling 30 litres on the 10th is fine on its own; voiding the
// milking of the 9th that made those 30 litres would leave the 10th selling
// milk that never existed. The API runs this over the measure's rows with the
// change applied, under a lock on the measure, and refuses the change if the
// lowest point goes below zero.
export function runningBalance(rows) {
  const ordered = [...(rows || [])].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (Number(a.delta) < 0 ? 1 : 0) - (Number(b.delta) < 0 ? 1 : 0);
  });
  let balance = 0;
  let lowest = 0;
  let lowestDate = null;
  for (const row of ordered) {
    balance += toCents(row.delta);
    if (balance < lowest) { lowest = balance; lowestDate = row.date; }
  }
  return { balance: fromCents(balance), lowest: fromCents(lowest), lowestDate };
}

// What each row does to a product's stock: production adds what was produced
// less what was lost; a sale takes its quantity away. Voided rows do nothing.
export function productDeltas({ production = [], sales = [] }) {
  return [
    ...production.filter((row) => row.status !== 'voided')
      .map((row) => ({ date: row.date, delta: fromCents(toCents(row.produced) - toCents(row.lost)) })),
    ...sales.filter((row) => row.status !== 'voided')
      .map((row) => ({ date: row.date, delta: -Number(row.quantity || 0) }))
  ];
}

// The issue a team member raises: what is wrong, how urgent, and -- when it
// is about one kind of animal -- which. An animal-welfare issue is urgent
// whatever was ticked.
export function validateIssue(input, { types = [] } = {}) {
  const errors = [];
  const kind = input?.kind;
  if (!ISSUE_KINDS.includes(kind)) errors.push('KIND_INVALID');
  const description = text(input?.description);
  if (!description) errors.push('DESCRIPTION_REQUIRED');
  else if (description.length > TEXT_MAX) errors.push('DESCRIPTION_TOO_LONG');
  let animalTypeId = null;
  if (input?.animalTypeId !== undefined && input?.animalTypeId !== null && input?.animalTypeId !== '') {
    const type = types.find((candidate) => String(candidate.id) === String(input.animalTypeId));
    if (!type) errors.push('SCOPE_INVALID');
    else animalTypeId = type.id;
  }
  return {
    errors,
    value: errors.length ? null : { kind, description, animalTypeId, urgent: kind === 'animal_welfare' || input?.urgent === true }
  };
}

// The alert thresholds the Farming Manager may change. Every key must be one
// DEFAULT_ALERT_THRESHOLDS knows and a whole number in a sensible range;
// anything else is refused rather than silently ignored.
export const THRESHOLD_LIMITS = {
  declinePercent: [5, 90],
  recentDays: [3, 31],
  baselineDays: [7, 120],
  minRecentRecords: [1, 31],
  minBaselineRecords: [1, 120],
  expenseRisePercent: [10, 500],
  expenseMinimumUsd: [0, 1000000],
  budgetWarnPercent: [50, 100],
  noRecordDays: [1, 60]
};

export function validateThresholds(input) {
  const errors = [];
  const value = {};
  for (const [key, raw] of Object.entries(input || {})) {
    const limits = THRESHOLD_LIMITS[key];
    if (!limits) { errors.push('THRESHOLD_UNKNOWN'); continue; }
    const number = Number(raw);
    if (!Number.isInteger(number) || number < limits[0] || number > limits[1]) { errors.push('THRESHOLD_INVALID'); continue; }
    value[key] = number;
  }
  const merged = { ...DEFAULT_ALERT_THRESHOLDS, ...value };
  if (merged.minRecentRecords > merged.recentDays || merged.minBaselineRecords > merged.baselineDays) errors.push('THRESHOLD_INVALID');
  return { errors: [...new Set(errors)], value: errors.length ? null : value };
}

// A change to a herd: births, purchases, deaths, sales, a count. Animals are
// whole; a death or sale cannot take the herd below nothing; a death must say
// what happened, because "two goats died" with no cause is the record an
// alert has to chase.
export function validateHerdEvent(input, { type, measure, today, headCount = 0 } = {}) {
  const errors = [];
  const date = input?.date;
  if (!isDateOnly(date)) errors.push('DATE_INVALID');
  else if (today && date > today) errors.push('DATE_IN_FUTURE');
  if (!type) errors.push('TYPE_REQUIRED');
  else if (type.active === false) errors.push('TYPE_INACTIVE');
  if (!measure || measure.kind !== 'herd') errors.push('MEASURE_NOT_HERD');
  else if (measure.active === false) errors.push('MEASURE_INACTIVE');

  const kind = input?.kind;
  if (!HERD_EVENT_KINDS.includes(kind)) errors.push('KIND_INVALID');

  const count = quantity(input?.count, { allowZero: kind === 'count' });
  if (count === null || !wholeNumber(count)) errors.push('COUNT_INVALID');

  const reason = text(input?.reason);
  if (HERD_LOSSES.includes(kind) && !reason) errors.push('REASON_REQUIRED');
  if (reason.length > TEXT_MAX) errors.push('REASON_TOO_LONG');

  let delta = null;
  let after = null;
  if (!errors.includes('KIND_INVALID') && !errors.includes('COUNT_INVALID')) {
    const before = Math.max(0, Number(headCount) || 0);
    // A count REPLACES the figure; the change it makes is recorded as a delta
    // like every other event, so the herd ledger alone explains today's number.
    delta = kind === 'count' ? count - before : (HERD_ADDING.includes(kind) ? count : -count);
    after = before + delta;
    if (after < 0) errors.push('HERD_BELOW_ZERO');
  }

  return {
    errors,
    value: errors.length ? null : { date, kind, count, delta, after, reason }
  };
}

// "You may already have recorded this." Production is one entry per product
// per day, so a second one the same day is almost always the first typed
// twice -- but the answer is a warning the person confirms, not a refusal: a
// second milking recorded separately is legitimate.
export function possibleDuplicateProduction(entry, existing) {
  return (existing || []).filter((other) => other.id !== entry.id
    && other.date === entry.date
    && other.measureId === entry.measureId
    && other.status !== 'voided');
}

// ---- expenses and sales ----------------------------------------------------

// A farm expense, as typed. `scope` is an active animal type's id or 'shared';
// a shared cost stays shared. `categories` is what the form offers for that
// scope (the farm's list plus the type's own). Every amount is positive and is
// converted to USD by the API at the rate it freezes onto the row.
export function validateExpense(input, { types = [], categories = FARM_EXPENSE_CATEGORIES, today } = {}) {
  const errors = [];
  const date = input?.date;
  if (!isDateOnly(date)) errors.push('DATE_INVALID');
  else if (today && date > today) errors.push('DATE_IN_FUTURE');

  const amount = quantity(input?.amount, { allowZero: false });
  if (amount === null) errors.push('AMOUNT_INVALID');
  if (!FARM_CURRENCIES.includes(input?.currency)) errors.push('CURRENCY_INVALID');

  const scope = input?.scope;
  let animalTypeId = null;
  if (scope === SHARED_SCOPE) animalTypeId = null;
  else {
    const type = (types || []).find((candidate) => String(candidate.id) === String(scope));
    if (!type) errors.push('SCOPE_INVALID');
    else if (type.active === false) errors.push('TYPE_INACTIVE');
    else animalTypeId = type.id;
  }

  const category = text(input?.category);
  if (!categories.includes(category)) errors.push('CATEGORY_INVALID');

  const description = text(input?.description);
  if (!description) errors.push('DESCRIPTION_REQUIRED');
  else if (description.length > TEXT_MAX) errors.push('DESCRIPTION_TOO_LONG');

  const payee = text(input?.payee);
  const receiptRef = text(input?.receiptRef);
  if (payee.length > NAME_MAX * 2) errors.push('PAYEE_TOO_LONG');
  if (receiptRef.length > NAME_MAX * 2) errors.push('RECEIPT_TOO_LONG');

  return {
    errors,
    value: errors.length ? null : {
      date, amount, currency: input.currency, shared: animalTypeId === null, animalTypeId,
      category, description, payee, receiptRef
    }
  };
}

// The same cost typed twice: same day, same amount and currency, same category,
// same scope and the same payee. Feed bought every Monday is NOT a duplicate --
// the day differs -- so recurring purchases are never caught by this. The API
// answers 409 with the matches and accepts the expense on a second send that
// says `confirmDuplicate: true`.
export function possibleDuplicateExpense(expense, existing) {
  return (existing || []).filter((other) => other.id !== expense.id
    && other.status !== 'voided'
    && other.date === expense.date
    && toCents(other.amount) === toCents(expense.amount)
    && other.currency === expense.currency
    && other.category === expense.category
    && (other.animalTypeId ?? null) === (expense.animalTypeId ?? null)
    && normaliseName(other.payee) === normaliseName(expense.payee));
}

// A sale: what was actually received, recorded apart from the production that
// made it. Selling 40 litres does not change how much was milked, and a
// production entry never carries a price, so revenue can never be counted from
// both sides.
export function validateSale(input, { type, measure, today } = {}) {
  const errors = [];
  const date = input?.date;
  if (!isDateOnly(date)) errors.push('DATE_INVALID');
  else if (today && date > today) errors.push('DATE_IN_FUTURE');
  if (!type) errors.push('TYPE_REQUIRED');
  else if (type.active === false) errors.push('TYPE_INACTIVE');
  if (!measure) errors.push('MEASURE_REQUIRED');
  else if (measure.kind === 'product' && measure.sellable === false) errors.push('NOT_SELLABLE');

  const count = quantity(input?.quantity, { allowZero: false });
  if (count === null) errors.push('QUANTITY_INVALID');
  else if (measure?.kind === 'herd' && !wholeNumber(count)) errors.push('QUANTITY_INVALID');
  const amount = quantity(input?.amount, { allowZero: false });
  if (amount === null) errors.push('AMOUNT_INVALID');
  if (!FARM_CURRENCIES.includes(input?.currency)) errors.push('CURRENCY_INVALID');
  const buyer = text(input?.buyer);
  if (buyer.length > NAME_MAX * 2) errors.push('BUYER_TOO_LONG');

  return {
    errors,
    value: errors.length ? null : { date, quantity: count, amount, currency: input.currency, buyer }
  };
}

// A correction to something already saved says why. An approved expense is
// never changed in place: the correction is a new version with the reason, and
// the old figures stay in the history.
export function correctionReasonValid(reason) {
  return text(reason).length >= FARM_CORRECTION_MIN;
}

// ---- the figures -----------------------------------------------------------

function inPeriod(day, from, to) {
  return (!from || day >= from) && (!to || day <= to);
}

// Everything the dashboard and the reports show, from the recorded rows and
// nothing else. Inputs are the rows as the API reads them, already filtered by
// what the reader may see:
//
//   production  { date, animalTypeId, measureId, produced, lost, status }
//   herdEvents  { date, animalTypeId, measureId, kind, delta, status }
//   sales       { date, animalTypeId, measureId, quantity, amountUsd, status }
//   expenses    { date, animalTypeId (null = shared), category, amountUsd, status }
//
// Voided rows are left out everywhere. Amounts are in USD at the rate frozen on
// each row, summed in cents.
//
// The answer has one block per animal type that appears in the rows or in
// `types`, plus `farm` for the whole operation. Per type, `directResult` is
// revenue less that type's own expenses -- labelled DIRECT because shared costs
// are not in it -- and `unitCost` is given only when it can be honest (see
// unitCostFor). The farm's `operatingResult` is all revenue less all expenses,
// shared included.
export function farmSummary({ types = [], measures = [], production = [], herdEvents = [], sales = [], expenses = [], from = null, to = null, budgetUsd = null } = {}) {
  const live = (row) => row.status !== 'voided' && inPeriod(row.date, from, to);
  const blocks = new Map();
  const block = (typeId) => {
    if (!blocks.has(typeId)) {
      blocks.set(typeId, {
        animalTypeId: typeId,
        production: new Map(),
        herd: new Map(),
        revenueCents: 0,
        expenseCents: 0,
        expensesByCategory: new Map(),
        recordedDays: new Set()
      });
    }
    return blocks.get(typeId);
  };
  for (const type of types) block(type.id);

  const measureOf = new Map(measures.map((measure) => [measure.id, measure]));
  const productLine = (target, measureId) => {
    if (!target.production.has(measureId)) {
      const measure = measureOf.get(measureId) || {};
      target.production.set(measureId, { measureId, unit: measure.unit || '', produced: 0, sold: 0, lost: 0, entries: 0, days: new Set() });
    }
    return target.production.get(measureId);
  };

  for (const row of production.filter(live)) {
    const target = block(row.animalTypeId);
    const line = productLine(target, row.measureId);
    line.produced += toCents(row.produced);
    line.lost += toCents(row.lost);
    line.entries += 1;
    line.days.add(row.date);
    target.recordedDays.add(row.date);
  }

  for (const row of herdEvents.filter(live)) {
    const target = block(row.animalTypeId);
    const herd = target.herd.get(row.measureId) || { measureId: row.measureId, births: 0, purchases: 0, deaths: 0, sales: 0, otherChange: 0, netChange: 0 };
    const delta = Number(row.delta) || 0;
    if (row.kind === 'birth') herd.births += delta;
    else if (row.kind === 'purchase') herd.purchases += delta;
    else if (row.kind === 'death') herd.deaths += -delta;
    else if (row.kind === 'sale') herd.sales += -delta;
    else herd.otherChange += delta;
    herd.netChange += delta;
    target.herd.set(row.measureId, herd);
    target.recordedDays.add(row.date);
  }

  // Sold comes from the sales, never from production: a production entry
  // carries no sale. A herd sale's head count is in the herd events.
  for (const row of sales.filter(live)) {
    const target = block(row.animalTypeId);
    target.revenueCents += toCents(row.amountUsd);
    const measure = measureOf.get(row.measureId);
    if (!measure || measure.kind === 'product') productLine(target, row.measureId).sold += toCents(row.quantity);
  }

  let sharedCents = 0;
  const sharedByCategory = new Map();
  for (const row of expenses.filter(live)) {
    const amount = toCents(row.amountUsd);
    if (row.animalTypeId === null || row.animalTypeId === undefined) {
      sharedCents += amount;
      sharedByCategory.set(row.category, (sharedByCategory.get(row.category) || 0) + amount);
      continue;
    }
    const target = block(row.animalTypeId);
    target.expenseCents += amount;
    target.expensesByCategory.set(row.category, (target.expensesByCategory.get(row.category) || 0) + amount);
  }

  const periodDays = from && to ? daysBetween(from, to) : null;
  const categoryList = (map) => [...map.entries()]
    .map(([category, total]) => ({ category, amountUsd: fromCents(total) }))
    .sort((a, b) => b.amountUsd - a.amountUsd);

  const animalTypes = [...blocks.values()].map((entry) => {
    const products = [...entry.production.values()].map((line) => ({
      measureId: line.measureId,
      unit: line.unit,
      produced: fromCents(line.produced),
      sold: fromCents(line.sold),
      lost: fromCents(line.lost),
      entries: line.entries,
      daysRecorded: line.days.size,
      // "No record" is counted, never filled in. Null when the period is open.
      daysWithoutRecord: periodDays === null ? null : Math.max(0, periodDays - line.days.size)
    }));
    return {
      animalTypeId: entry.animalTypeId,
      products,
      herd: [...entry.herd.values()],
      revenueUsd: fromCents(entry.revenueCents),
      directExpensesUsd: fromCents(entry.expenseCents),
      directResultUsd: fromCents(entry.revenueCents - entry.expenseCents),
      expensesByCategory: categoryList(entry.expensesByCategory),
      unitCost: unitCostFor({ products, directExpensesUsd: fromCents(entry.expenseCents), sharedExpensesUsd: fromCents(sharedCents) }),
      hasRecords: entry.recordedDays.size > 0 || entry.revenueCents > 0 || entry.expenseCents > 0
    };
  });

  const revenueCents = [...blocks.values()].reduce((sum, entry) => sum + entry.revenueCents, 0);
  const directCents = [...blocks.values()].reduce((sum, entry) => sum + entry.expenseCents, 0);
  const expenseCents = directCents + sharedCents;
  const allCategories = new Map(sharedByCategory);
  for (const entry of blocks.values()) {
    for (const [category, total] of entry.expensesByCategory) allCategories.set(category, (allCategories.get(category) || 0) + total);
  }

  return {
    from,
    to,
    animalTypes,
    farm: {
      revenueUsd: fromCents(revenueCents),
      directExpensesUsd: fromCents(directCents),
      sharedExpensesUsd: fromCents(sharedCents),
      expensesUsd: fromCents(expenseCents),
      // Revenue less every recorded expense. Not net profit: see the top of
      // this file for what it leaves out.
      operatingResultUsd: fromCents(revenueCents - expenseCents),
      expensesByCategory: categoryList(allCategories),
      sharedByCategory: categoryList(sharedByCategory),
      budget: budgetLine(budgetUsd, fromCents(expenseCents))
    }
  };
}

// Budget against actual, only when a budget exists. No budget is no ceiling,
// as on a monthly plan: `null`, never "0 of 0".
export function budgetLine(budgetUsd, spentUsd) {
  const budget = Number(budgetUsd);
  if (!Number.isFinite(budget) || budget <= 0) return null;
  const remaining = toCents(budget) - toCents(spentUsd);
  return {
    budgetUsd: fromCents(toCents(budget)),
    spentUsd: fromCents(toCents(spentUsd)),
    remainingUsd: fromCents(remaining),
    over: remaining < 0,
    percentUsed: Math.round((toCents(spentUsd) / toCents(budget)) * 1000) / 10
  };
}

// The cost of one unit of what an animal type produces -- only when the
// figure means something:
//   - exactly ONE product measure produced anything (the cost of a herd that
//     gives milk and calves cannot be split between them without a rule
//     nobody has written down), and
//   - something was produced (no division by an unrecorded month).
// When shared costs exist in the period the figure leaves them out, and says
// so: `excludesShared: true`, `estimate: true`.
export function unitCostFor({ products, directExpensesUsd, sharedExpensesUsd = 0 }) {
  const producing = (products || []).filter((line) => line.produced > 0);
  if (producing.length === 0) return { available: false, reason: 'NO_PRODUCTION' };
  if (producing.length > 1) return { available: false, reason: 'SEVERAL_PRODUCTS' };
  if (!(directExpensesUsd > 0)) return { available: false, reason: 'NO_DIRECT_COSTS' };
  const line = producing[0];
  const excludesShared = sharedExpensesUsd > 0;
  return {
    available: true,
    measureId: line.measureId,
    unit: line.unit,
    usdPerUnit: Math.round((directExpensesUsd / line.produced) * 10000) / 10000,
    excludesShared,
    estimate: excludesShared
  };
}

// One figure per period bucket, for the trend lines: produced per day/week/
// month for one measure. Buckets with no entry are ABSENT, not zero, so a line
// chart shows a gap where nobody recorded rather than a fall to nothing.
export function productionTrend(production, { measureId, period = 'daily', from = null, to = null } = {}) {
  const buckets = new Map();
  for (const row of production || []) {
    if (row.status === 'voided' || row.measureId !== measureId || !inPeriod(row.date, from, to)) continue;
    const key = periodKey(row.date, period);
    const entry = buckets.get(key) || { period: key, produced: 0, days: new Set() };
    entry.produced += toCents(row.produced);
    entry.days.add(row.date);
    buckets.set(key, entry);
  }
  return [...buckets.values()]
    .sort((a, b) => (a.period < b.period ? -1 : 1))
    .map((entry) => ({ period: entry.period, produced: fromCents(entry.produced), daysRecorded: entry.days.size }));
}

// ---- alerts ----------------------------------------------------------------

// Defaults the Farming Manager may change per farm. Each threshold is written
// so an alert needs real evidence: enough recorded days on both sides of a
// comparison, a change large enough to matter, an amount large enough to be
// worth a look.
export const DEFAULT_ALERT_THRESHOLDS = {
  declinePercent: 20,          // recent average this far below the usual one
  recentDays: 7,
  baselineDays: 28,
  minRecentRecords: 4,         // fewer recorded days than this: no comparison
  minBaselineRecords: 14,
  expenseRisePercent: 50,      // a category this far above its usual month
  expenseMinimumUsd: 50,       // and at least this much, so $3 -> $6 is not an alert
  budgetWarnPercent: 90,
  noRecordDays: 3              // a daily product with nothing recorded this long
};

// Every alert is { kind, key, severity, params }. `key` is stable for the same
// unresolved issue, so the API raises it once and not again while it stands
// (newAlerts). `params` carries the figures that explain it; the screen words
// it as "why this appeared". `severity` is 'urgent' only for animal welfare --
// a death with no cause, an overdue critical task -- and 'normal' otherwise.
//
// `noRecord` is deliberately worded and graded as a gap in the records, not a
// shortfall: nothing here concludes that a missing day means poor work.
export function farmAlerts({
  today, production = [], expenses = [], herdEvents = [], measures = [], tasks = [],
  budgetUsd = null, monthSpentUsd = 0, expenseHistory = [], thresholds = {}
} = {}) {
  const rules = { ...DEFAULT_ALERT_THRESHOLDS, ...thresholds };
  const alerts = [];
  const live = (row) => row.status !== 'voided';

  for (const measure of measures.filter((item) => item.kind === 'product' && item.active !== false)) {
    const rows = production.filter((row) => live(row) && row.measureId === measure.id);

    // Production decline: recorded days only, on both sides.
    const recentFrom = addDays(today, -(rules.recentDays - 1));
    const baselineTo = addDays(recentFrom, -1);
    const baselineFrom = addDays(baselineTo, -(rules.baselineDays - 1));
    const daily = (from, to) => {
      const byDay = new Map();
      for (const row of rows) {
        if (!inPeriod(row.date, from, to)) continue;
        byDay.set(row.date, (byDay.get(row.date) || 0) + toCents(row.produced));
      }
      return byDay;
    };
    const recent = daily(recentFrom, today);
    const baseline = daily(baselineFrom, baselineTo);
    if (recent.size >= rules.minRecentRecords && baseline.size >= rules.minBaselineRecords) {
      const average = (map) => [...map.values()].reduce((sum, value) => sum + value, 0) / map.size;
      const recentAverage = average(recent);
      const baselineAverage = average(baseline);
      if (baselineAverage > 0) {
        const change = ((recentAverage - baselineAverage) / baselineAverage) * 100;
        if (change <= -rules.declinePercent) {
          alerts.push({
            kind: 'production_decline',
            key: `production_decline:${measure.id}:${recentFrom}`,
            severity: 'normal',
            params: {
              measureId: measure.id, unit: measure.unit,
              recentAverage: Math.round(recentAverage) / 100, baselineAverage: Math.round(baselineAverage) / 100,
              changePercent: Math.round(change * 10) / 10,
              recentDaysRecorded: recent.size, baselineDaysRecorded: baseline.size
            }
          });
        }
      }
    }

    // A product expected every day with nothing recorded for a while. Today
    // is not counted: the day is not over, and an entry made this evening is
    // not late.
    if (measure.dailyExpected) {
      const last = rows.reduce((latest, row) => (row.date > latest ? row.date : latest), '');
      const gap = last && last < today ? daysBetween(last, addDays(today, -1)) - 1 : 0;
      if (last && gap >= rules.noRecordDays) {
        alerts.push({
          kind: 'no_recent_record',
          key: `no_recent_record:${measure.id}:${last}`,
          severity: 'normal',
          params: { measureId: measure.id, lastRecorded: last, daysWithoutRecord: gap }
        });
      }
    }
  }

  // A death recorded without a cause is the one record that must be followed
  // up, whoever typed it.
  for (const event of herdEvents.filter((row) => live(row) && HERD_LOSSES.includes(row.kind))) {
    if (!text(event.reason)) {
      alerts.push({
        kind: 'unexplained_loss',
        key: `unexplained_loss:${event.id}`,
        severity: 'urgent',
        params: { eventId: event.id, date: event.date, animalTypeId: event.animalTypeId, count: Math.abs(Number(event.delta) || 0) }
      });
    }
  }

  // An expense category well above its usual month. `expenseHistory` is the
  // category's totals for earlier months, oldest first; at least two are needed
  // before "usual" means anything.
  const month = today.slice(0, 7);
  const thisMonth = new Map();
  for (const row of expenses.filter((item) => live(item) && item.date.slice(0, 7) === month)) {
    thisMonth.set(row.category, (thisMonth.get(row.category) || 0) + toCents(row.amountUsd));
  }
  for (const [category, total] of thisMonth) {
    const earlier = expenseHistory.filter((item) => item.category === category && item.month < month);
    if (earlier.length < 2) continue;
    const usual = earlier.reduce((sum, item) => sum + toCents(item.amountUsd), 0) / earlier.length;
    if (usual <= 0) continue;
    const rise = ((total - usual) / usual) * 100;
    if (rise >= rules.expenseRisePercent && fromCents(total - usual) >= rules.expenseMinimumUsd) {
      alerts.push({
        kind: 'expense_rise',
        key: `expense_rise:${category}:${month}`,
        severity: 'normal',
        params: { category, month, amountUsd: fromCents(total), usualUsd: Math.round(usual) / 100, risePercent: Math.round(rise * 10) / 10, monthsCompared: earlier.length }
      });
    }
  }

  // Budget: a warning as it nears, and an overrun once past.
  const line = budgetLine(budgetUsd, monthSpentUsd);
  if (line && (line.over || line.percentUsed >= rules.budgetWarnPercent)) {
    alerts.push({
      kind: line.over ? 'budget_over' : 'budget_near',
      key: `${line.over ? 'budget_over' : 'budget_near'}:${month}`,
      severity: 'normal',
      params: { month, ...line }
    });
  }

  // Only tasks someone marked critical: an ordinary task running late is not
  // an alert, and nothing here nags about it.
  for (const task of tasks.filter((item) => item.critical && item.dueOn && item.dueOn < today && !['done', 'cancelled'].includes(item.status))) {
    alerts.push({
      kind: 'critical_task_overdue',
      key: `critical_task_overdue:${task.id}`,
      severity: 'urgent',
      params: { taskId: task.id, dueOn: task.dueOn, daysOverdue: daysBetween(task.dueOn, today) - 1 }
    });
  }

  return alerts;
}

// The alerts not already raised. `openKeys` is the keys of the alerts still
// standing; the same unresolved issue is told once, not every time the
// dashboard loads.
export function newAlerts(alerts, openKeys) {
  const open = new Set(openKeys || []);
  return (alerts || []).filter((alert) => !open.has(alert.key));
}

// ---- the refusals, by code -------------------------------------------------

// Every code a validator above or a route in server/routes/farming.js can
// answer with. The screen shows `farm.err.<CODE>` in the reader's language
// (and the server's English message only for a code missing here), so a team
// member who reads little gets "Sold more than there was", not a status number.
// tests/farming-logic.test.mjs fails if a validator pushes a code not listed,
// and tests/translations.test.mjs if one has no words.
export const FARM_ERROR_CODES = [
  'AMOUNT_INVALID', 'BUYER_TOO_LONG', 'CATEGORY_INVALID', 'CATEGORY_TOO_LONG', 'COUNT_INVALID', 'CURRENCY_INVALID',
  'DATE_IN_FUTURE', 'DATE_INVALID', 'DESCRIPTION_REQUIRED', 'DESCRIPTION_TOO_LONG', 'HERD_BELOW_ZERO', 'KIND_INVALID',
  'LOST_INVALID', 'MEASURE_INACTIVE', 'MEASURE_NOT_FOR_TYPE', 'MEASURE_NOT_HERD', 'MEASURE_NOT_PRODUCT', 'MEASURE_REQUIRED',
  'MEASURE_NAME_EXISTS', 'MEASURE_NAME_REQUIRED', 'MEASURE_NAME_TOO_LONG', 'MEASURE_KIND_INVALID', 'MEASURE_UNIT_REQUIRED',
  'MEASURE_UNIT_TOO_LONG', 'MORE_OUT_THAN_AVAILABLE', 'NAME_EXISTS', 'NAME_REQUIRED', 'NAME_TOO_LONG', 'NOT_SELLABLE',
  'NOTES_TOO_LONG', 'PAYEE_TOO_LONG', 'PRODUCED_INVALID', 'QUANTITY_INVALID', 'REASON_REQUIRED', 'REASON_TOO_LONG',
  'RECEIPT_TOO_LONG', 'SCOPE_INVALID', 'THRESHOLD_INVALID', 'THRESHOLD_UNKNOWN', 'TYPE_INACTIVE', 'TYPE_REQUIRED',
  'UNIT_REQUIRED', 'UNIT_TOO_LONG',
  // Answered by the routes, not by a validator here.
  'FARM_ACCESS', 'NOT_ALLOWED', 'NOT_FOUND', 'STOCK_BELOW_ZERO', 'POSSIBLE_DUPLICATE', 'CORRECTION_REASON',
  'NOT_EDITABLE', 'ALREADY_DECIDED', 'HAS_RECORDS_DEACTIVATE_INSTEAD', 'BUDGET_INVALID', 'MONTH_INVALID'
];

