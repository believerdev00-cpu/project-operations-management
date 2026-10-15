// What a month's work is counted in.
//
// One list, three consumers: the unit box in the Director's plan form offers
// these words (src/MonthlyPlans.jsx), the daily form the manager records
// through is shaped by which kind of word it is (server/lib/objectiveForm.js),
// and both step their number box by the same rule. It is in shared/ for the
// same reason shared/categories.js is: three hand-written copies of "is this
// countable?" would answer differently within a month of each other.
//
// Classification is by English word, deliberately. The suggestions below are
// English and the Director may type anything at all, including a word in their
// own language; an unrecognised word is not a failure -- it falls to the plain
// "How many {unit} today?", which is true of every unit there is. Only the
// labour and journey wordings and the whole-number step need recognising.

// Units that MEASURE rather than count, and so the only ones a fraction of
// makes sense for. Everything else -- labourers, sacks, trips, meals, bottles
// -- is a whole thing.
//
// Measured units are a closed set and countable ones are not, which is why the
// default below belongs on counting. It used to run the other way round: 26
// named countable words stepped by one and everything else fell through to
// 0.01. The first real month of imported work put 45 of its 61 objectives on
// the wrong side of that -- a decimal spinner for "how many labourers" -- for
// no better reason than that the sheet's words were not on a list that could
// never be long enough.
export const MEASURED_UNITS = [
  'kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms', 'g', 'gram', 'grams',
  't', 'ton', 'tons', 'tonne', 'tonnes',
  'l', 'ltr', 'litre', 'litres', 'liter', 'liters', 'ml',
  'm', 'metre', 'metres', 'meter', 'meters', 'cm', 'km',
  'm2', 'm3', 'sqm', 'square metre', 'square metres', 'square meter', 'square meters',
  'ha', 'hectare', 'hectares', 'acre', 'acres',
  'hour', 'hours', 'hr', 'hrs', 'usd', 'dollar', 'dollars', 'percent'
];

// People putting in a day's work. The question for these is about the people,
// not about a quantity of them: "How many people worked today?" and not
// "Labourers done today", which reads as though ten labourers were finished.
//
// 'people' and 'person' are deliberately NOT here. A target of "3 people" is as
// often attendance as labour -- "Mining meetings, 3 people" is three people at
// a meeting, who did not work the day -- so those fall through to the plain
// "How many people today?", which is true either way.
export const LABOUR_UNITS = [
  'labourer', 'labourers', 'labour', 'labours', 'laborer', 'laborers',
  'worker', 'workers', 'workman', 'workmen', 'staff', 'team', 'teams',
  'casual', 'casuals', 'employee', 'employees'
];

// Journeys. Separate only because "How many trips today?" needs no unit
// inserted into it, and so reads naturally in all four languages.
export const TRIP_UNITS = [
  'trip', 'trips', 'journey', 'journeys', 'delivery', 'deliveries', 'run', 'runs'
];

// Words that are not units of anything -- what a sheet leaves behind when it
// states a quantity with nothing to measure it in ("3 times", "15 days",
// "1 house"). Repeating one back produces "How many times today?", which asks
// the manager to decode the bookkeeping, so the question drops the word and
// just asks how many. The target still reads "3 times", which is how a person
// says it.
export const FILLER_UNITS = [
  'entry', 'entries', 'time', 'times', 'item', 'items', 'record', 'records',
  'day', 'days', 'week', 'weeks', 'month', 'months', 'house', 'houses'
];

const normalise = (unit) => String(unit || '').trim().toLowerCase();

// Which of the four shapes of question this unit wants. 'unit' is the ordinary
// one and keeps the word; 'count' drops it.
export function unitClass(unit) {
  const word = normalise(unit);
  if (!word) return 'count';
  if (LABOUR_UNITS.includes(word)) return 'people';
  if (TRIP_UNITS.includes(word)) return 'trips';
  if (FILLER_UNITS.includes(word)) return 'count';
  return 'unit';
}

export function isMeasured(unit) {
  return MEASURED_UNITS.includes(normalise(unit));
}

// The smallest amount the number box will accept, for a unit and the target
// that was set in it.
//
// A fractional target has to stay reachable whatever its unit: 2.5 sacks on a
// step of 1 is a number the browser refuses, which would leave the manager
// unable to record the target their own month was set.
export function stepForUnit(unit, targetQuantity) {
  const target = Number(targetQuantity);
  if (Number.isFinite(target) && !Number.isInteger(target)) return 0.01;
  return isMeasured(unit) ? 0.01 : 1;
}

// What the unit box offers the Director, commonest first.
//
// These are the words this organisation's own months are actually counted in,
// taken from three months of the operations workbook, rather than a plausible
// list: 'labourers' is the single most common unit in the real work and was
// missing, while 'chickens', 'trees' and 'acres' were offered and have never
// once been used. The box stays free text -- a suggestion list is not a
// closed set -- but what it suggests should be what the work is measured in.
export const UNIT_SUGGESTIONS = [
  'labourers', 'kg', 'litres', 'people', 'trips', 'metres', 'sacks', 'bags',
  'pieces', 'bottles', 'meals', 'tonnes', 'hectares', 'days', 'times'
];
