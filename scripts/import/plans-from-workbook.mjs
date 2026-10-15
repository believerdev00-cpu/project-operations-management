// Turn a Rubaya & Gisuma operations workbook into monthly plans this system can
// hold. Reads the .xlsx, writes a JSON file that `load-plans.mjs` then posts to
// the API. Nothing here touches a database or a network.
//
//   node scripts/import/plans-from-workbook.mjs "rubaya report.xlsx" plans.json
//
// The workbooks are a hand-kept record, not an export, so most of this file is
// about reading them honestly rather than about the schema. Three things in
// particular are not what they appear to be -- the dates, the money, and the
// rows that are arithmetic about other rows -- and each is handled below with
// the reason it has to be.
import ExcelJS from 'exceljs';
import { writeFileSync } from 'node:fs';
import { formatWorkbookNote } from '../../shared/workbookNote.js';

const [workbookPath, outPath] = process.argv.slice(2);
if (!workbookPath || !outPath) {
  console.error('usage: node scripts/import/plans-from-workbook.mjs <workbook.xlsx> <plans.json>');
  process.exit(1);
}

// Which column holds what, per sheet. The sheets do not agree: the farm sheet
// carries a Category and starts a column later than the rest.
const SHEETS = {
  'Gisuma Farm Activities': { date: 1, cat: 2, act: 3, desc: 4, qty: 5, usd: 6, frw: 7, fco: 8 },
  'Movements & Facilitations': { date: 0, act: 1, desc: 2, loc: 3, qty: 4, usd: 5, frw: 6, fco: 7 },
  'Mining Activities': { date: 0, act: 1, desc: 2, qty: 3, usd: 4, frw: 5, fco: 6 },
  'OPS Related to mining': { date: 0, act: 1, desc: 2, loc: 3, qty: 4, usd: 5, frw: 6, fco: 7 },
  'Agriculture Activities': { date: 0, act: 1, desc: 2, qty: 3, usd: 4, frw: 5, fco: 6 }
};

// WHICH OPERATION EACH SHEET BELONGS TO.
//
// Movement & Facilitation is the support layer for all three primary
// operations, so it carries BOTH facilitation sheets: its own mixed work
// (shared across the three, supports: null) and the transport, fuel, security
// and airtime spent on behalf of mining (supports: 'mining'). One plan exists
// per operation per month -- monthly_plans is unique on (sector, month) -- so
// they merge into one month rather than standing as two plans.
const SHEET_OPERATION = {
  'Gisuma Farm Activities': { operation: 'farming', supports: null },
  'Agriculture Activities': { operation: 'agriculture', supports: null },
  'Mining Activities': { operation: 'mining', supports: null },
  'Movements & Facilitations': { operation: 'movement', supports: null },
  'OPS Related to mining': { operation: 'movement', supports: 'mining' }
};

// ROWS THAT ARE ARITHMETIC ABOUT OTHER ROWS, not work that cost money.
//
// Each consignment is closed with its own sums -- "DELIVERY 2 SUMMARY", "Total
// kgs Received", "Total Sale", "net profit", and bare sums like
// "30911-25000-212-2149-250". Counted as costs they double the month.
//
// "total" is matched as a bare substring with no word boundary on purpose: one
// line reads "DELIVERY 2Total Ops related to Mining", where the missing space
// leaves \btotal\b nothing to anchor to and let $203 of double spending back in.
const SUMMARY = /summary|total|net profit|sale-invest|^\s*[\d,.\s]+-[\d,.\s-]+=?\s*$/i;

const cellValue = (cell) => {
  let value = cell.value;
  let kind = typeof value;
  if (value instanceof Date) {
    kind = 'date';
    value = value.toISOString().slice(0, 10);
  } else if (value && typeof value === 'object') {
    if (value.richText) { kind = 'rich'; value = value.richText.map((part) => part.text).join(''); }
    else if (value.result !== undefined) { kind = 'formula'; value = value.result; }
    else if (value.text !== undefined) { kind = 'link'; value = value.text; }
    else { kind = 'object'; value = ''; }
  }
  if (value === null || value === undefined) value = '';
  return { v: typeof value === 'string' ? value.trim() : value, k: kind };
};

const num = (cell) => {
  if (!cell) return null;
  if (typeof cell.v === 'number') return cell.v;
  if (!/\d/.test(String(cell.v))) return null;
  const parsed = Number(String(cell.v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
};

// THE DATES ARE NOT ALL THE SAME SHAPE.
//
// The workbooks are typed d/m/y. Anything with a day above 12 stayed text
// ("26/07/2026") and is plainly d/m/y. Anything whose first two numbers were
// both 12 or under, Excel swallowed as a real date in m/d/y -- so the cell that
// reads 2026-07-08 was typed 7/8/2026 and means 7 AUGUST. Reading those as
// written scatters August's work back into July and breaks every monthly total,
// which is why a date cell is swapped back and a text cell is read as d/m/y.
//
// Confirmed by row order: the swapped cells always sit between neighbours that
// bracket the swapped reading, never the literal one.
function parseDate(cell, fallbackMonth) {
  if (!cell || cell.v === '') return { date: null, why: 'empty' };
  if (cell.k === 'date') {
    const [year, month, day] = String(cell.v).split('-').map(Number);
    // Only ambiguous when both are 12 or under; a day of 31 could never have
    // been read as a month, so that cell is already right.
    if (day >= 1 && day <= 12) {
      return { date: `${year}-${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}`, why: 'swapped' };
    }
    return { date: String(cell.v), why: 'kept' };
  }
  let text = String(cell.v).trim().replace(/\/{2,}/g, '/').replace(/\s+/g, ' ');
  text = text.replace(/^(\d{1,2})\s*[-–]\s*\d{1,2}([/ .-])/, '$1$2'); // "10-11/8/2026" -> the 10th
  const parts = text.split(/[/ .-]+/).filter(Boolean);
  let day;
  let month;
  let year;
  if (parts.length === 3) [day, month, year] = parts.map(Number);
  else if (parts.length === 2 && /^\d{6}$/.test(parts[1])) {        // "07/082026"
    day = Number(parts[0]);
    month = Number(parts[1].slice(0, 2));
    year = Number(parts[1].slice(2));
  } else if (parts.length === 2 && /^0?\d{4,5}$/.test(parts[1])) {  // "28/02026" -- the month was lost
    day = Number(parts[0]);
    month = fallbackMonth;
    year = Number(parts[1].slice(-4));
  } else return { date: null, why: `unparsed:${text}` };
  if (year < 100) year += 2000;
  if (year !== 2026) year = 2026;                                    // "25/8/2028" is a typo
  if (!month || month < 1 || month > 12 || !day || day < 1 || day > 31) return { date: null, why: `range:${text}` };
  return { date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, why: 'text' };
}

// ONE OBJECTIVE PER KIND OF WORK. The sheets name the same work a dozen ways
// ("fuel", "Buying fuel", "Full tank Fuel"), and a month of twenty near-
// duplicate lines is not a list of commitments anybody agreed to. The row's own
// wording is kept verbatim on the day, so nothing is lost. First match wins, so
// specific rules come before general ones.
const BUCKETS = {
  'Gisuma Farm Activities': [
    [/trench/, 'Trench fencing'],
    [/bush clearing/, 'Bush clearing'],
    [/structure|roof|renovation|closing openings/, 'Main structure and roof renovation'],
    [/medicine/, 'Animal health and medicine'],
    [/salary|for monthly/, 'Labourers salary'],
    [/imivure|ubwato|umunyu/, 'Farm equipment'],
    [/arrangment|arrangement/, 'Farm arrangement work']
  ],
  'Agriculture Activities': [
    [/buying seedling|buying irish seed|buying.*seed/, 'Seeds and seedlings bought'],
    [/potato seedling|irish plantation|plantation/, 'Planting'],
    [/potato garden/, 'Potato garden preparation'],
    [/irish garden/, 'Irish potato garden preparation'],
    [/maize/, 'Maize garden preparation'],
    [/fenc/, 'Garden fencing'],
    [/removing bushes|bush/, 'Bush clearing around gardens'],
    [/tpt|transport/, 'Transport for agriculture'],
    [/organisation|around garden space|around building/, 'Garden organisation'],
    [/garden preparation|preparation/, 'General garden preparation']
  ],
  'Mining Activities': [
    [/mangano/, 'Mangano purchases'],
    [/advance deposited/, 'Advance deposits'],
    [/coltan/, 'Coltan purchases and advances'],
    [/carte de negotiant|other expense/, 'Trading licence and other charges']
  ],
  'OPS Related to mining': [
    [/security/, 'Coltan security'],
    [/coltan transport|adaelivery|delivery made|coltan pick up|kg delivery|kgs delivery|coltan \d+kg/, 'Coltan transport and delivery'],
    [/airtime|data|internet|comunication|communication/, 'Mining communication'],
    [/fuel|motor oil|garage/, 'Mining transport fuel'],
    [/meeting/, 'Mining meetings'],
    [/lunch|dinner|meal|drink|breakfast/, 'Mining site meals'],
    [/transport|tpt|facilitation|walking stick/, 'Mining staff transport']
  ],
  'Movements & Facilitations': [
    [/rent/, 'Accommodation'],
    [/airtime|data|internet|communication/, 'Communication'],
    [/fuel/, 'Fuel'],
    [/cash to/, 'Cash advances to staff'],
    [/jacket|boots|repair|torch|walking stick|book|ruler|high lighter/, 'Equipment and personal supplies'],
    [/shopping|posho|soap|package|buying/, 'Shopping and supplies'],
    [/meal|lunch|dinner|drink|breakfast|break fast|fruit|cigarette|water/, 'Meals and drinks'],
    [/transport|tpt|movement|trip|clearance|boarder/, 'Staff transport']
  ]
};

const FALLBACK = {
  'Gisuma Farm Activities': 'Other farm work',
  'Agriculture Activities': 'Other agriculture work',
  'Mining Activities': 'Other mining purchases',
  'OPS Related to mining': 'Other mining support',
  'Movements & Facilitations': 'Other facilitation'
};

function bucketOf(sheet, activity, description) {
  const text = `${activity} ${description}`.toLowerCase();
  for (const [pattern, title] of BUCKETS[sheet] || []) if (pattern.test(text)) return title;
  return FALLBACK[sheet];
}

// A TARGET IS ONLY A TARGET IF IT COUNTS SOMETHING. The quantity column is free
// text, so a leading number is taken with the word that follows it ("10
// Labours", "424 meters", "108kg"). Anything that does not start with a number
// is not guessed at.
const UNITS = {
  labour: 'labourers', labours: 'labourers', labourer: 'labourers', labourers: 'labourers', labors: 'labourers',
  person: 'people', people: 'people', persons: 'people', p: 'people', contractor: 'labourers',
  trip: 'trips', trips: 'trips', pc: 'pieces', pcs: 'pieces', piece: 'pieces', pieces: 'pieces',
  meter: 'metres', meters: 'metres', metre: 'metres', metres: 'metres',
  kg: 'kg', kgs: 'kg', day: 'days', days: 'days', night: 'nights', nights: 'nights',
  bottle: 'bottles', bottles: 'bottles', sac: 'sacks', sacs: 'sacks', suck: 'sacks', sucks: 'sacks', sack: 'sacks',
  litre: 'litres', litres: 'litres', liter: 'litres', liters: 'litres',
  month: 'months', months: 'months', pair: 'pairs', pairs: 'pairs', time: 'times', times: 'times',
  meal: 'meals', meals: 'meals', pack: 'packs', packs: 'packs', package: 'packs', round: 'rounds', rounds: 'rounds'
};

function quantityOf(text) {
  const match = /^\s*([\d]+(?:\.[\d]+)?)\s*([A-Za-z]*)/.exec(String(text || ''));
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const word = (match[2] || '').toLowerCase();
  return { value, unit: UNITS[word] || (word || null) };
}

// The delivery arithmetic the platform cannot hold: it records money going out
// and has no concept of a sale or a profit. Kept as the month's notes, where it
// stays readable without pretending to be spending. Edit these when a workbook
// with new consignments is imported.
const DELIVERY_NOTES = {
  '2026-08': 'From the workbook delivery summaries. Delivery 1: 200kg delivered at 125 = $25,000 invested, $212 mining OPS, $250 trading licence, total sale $30,911, net profit $3,300. Delivery 2: 214.2kg received for $27,025, $204 OPS, $2,471 charges, total cost $29,700, total sale $34,778, net profit $5,078 (settled 4 Sep).',
  '2026-09': 'From the workbook delivery summaries. Delivery 3: 197.7kg received for $25,250, $150 OPS, $1,020 charges, total cost $26,420, total sale $27,116.50, net profit $696.50. Delivery 4 was still open when the workbook was written.'
};

const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile(workbookPath);

// ---- every costed row, with its date resolved and its money in USD ----------
const raw = [];
for (const sheet of workbook.worksheets) {
  const columns = SHEETS[sheet.name];
  if (!columns) {
    console.log(`skipping unknown sheet "${sheet.name}"`);
    continue;
  }
  sheet.eachRow({ includeEmpty: false }, (row, number) => {
    if (number === 1) return;
    const cells = [];
    row.eachCell({ includeEmpty: true }, (cell, column) => { cells[column - 1] = cellValue(cell); });
    if (!cells.some((cell) => cell && cell.v !== '')) return;
    raw.push({ sheet: sheet.name, n: number, cells, columns });
  });
}

// THE RATE THE WORKBOOK ITSELF IMPLIES, from every row that states both
// currencies. Median, not mean, so one typo cannot move it. Taken from the data
// rather than hard-coded because the workbook is the only record of what the
// money was actually changed at on the day.
const ratios = { frw: [], fco: [] };
for (const row of raw) {
  const usd = num(row.cells[row.columns.usd]);
  if (!usd || usd <= 0) continue;
  for (const currency of ['frw', 'fco']) {
    const local = num(row.cells[row.columns[currency]]);
    if (local && local > 0) ratios[currency].push(local / usd);
  }
}
const median = (list) => {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};
const rate = { frw: median(ratios.frw), fco: median(ratios.fco) };
if (!rate.frw || !rate.fco) throw new Error('no row states both USD and a local currency, so no rate can be derived');
console.log(`implied rates: 1 USD = ${rate.frw.toFixed(1)} FRW (${ratios.frw.length} rows), ${rate.fco.toFixed(1)} FCO (${ratios.fco.length} rows)`);

const rows = [];
const skipped = [];
let lastMonth = null;
for (const row of raw) {
  const text = (index) => (index === undefined || !row.cells[index] ? '' : String(row.cells[index].v || '').trim());
  const activity = text(row.columns.act);
  const description = text(row.columns.desc);
  const usd = num(row.cells[row.columns.usd]);
  const frw = num(row.cells[row.columns.frw]);
  const fco = num(row.cells[row.columns.fco]);
  const { date, why } = parseDate(row.cells[row.columns.date], lastMonth);
  if (date) lastMonth = Number(date.slice(5, 7));

  const reason = SUMMARY.test(description) || SUMMARY.test(activity) ? 'summary/arithmetic row'
    : !date ? `no usable date (${why})`
      : (!usd && !frw && !fco) ? 'no cost in any currency' : null;
  if (reason) {
    skipped.push({ sheet: row.sheet, n: row.n, label: [activity, description].filter(Boolean).join(' - '), reason });
    continue;
  }

  // The USD column when the workbook states one, otherwise converted. Both the
  // figure and where it came from are carried, so the day can say so.
  const money = usd && usd > 0 ? { usd, from: `$${usd} as recorded` }
    : frw && frw > 0 ? { usd: frw / rate.frw, from: `${frw} FRW at ${rate.frw.toFixed(1)}/USD` }
      : { usd: fco / rate.fco, from: `${fco} FCO at ${rate.fco.toFixed(1)}/USD` };

  rows.push({
    sheet: row.sheet, n: row.n, date, month: date.slice(0, 7),
    activity, description, location: text(row.columns.loc), category: text(row.columns.cat),
    quantityText: text(row.columns.qty), parsed: quantityOf(text(row.columns.qty)),
    usd: Math.round(money.usd * 100) / 100, source: money.from
  });
}

// ---- group each operation's month into objectives ---------------------------
const plans = new Map();
for (const row of rows) {
  const { operation, supports } = SHEET_OPERATION[row.sheet];
  const planKey = `${operation}|${row.month}`;
  if (!plans.has(planKey)) plans.set(planKey, { operation, month: row.month, objectives: new Map(), sheets: new Set() });
  const plan = plans.get(planKey);
  plan.sheets.add(row.sheet);
  const title = bucketOf(row.sheet, row.activity, row.description);
  const objectiveKey = `${title}|${supports || ''}`;
  if (!plan.objectives.has(objectiveKey)) plan.objectives.set(objectiveKey, { title, supports, days: [] });
  plan.objectives.get(objectiveKey).days.push(row);
}

const out = [];
for (const plan of [...plans.values()].sort((a, b) => a.operation.localeCompare(b.operation) || a.month.localeCompare(b.month))) {
  const objectives = [];
  for (const objective of plan.objectives.values()) {
    const parsed = objective.days.map((day) => day.parsed);
    // A figure typed without its unit takes the unit of the rows beside it: the
    // coltan column reads "4kg", "8kg", "65kg", "24". Letting that one bare 24
    // disagree turned a month of 221kg of coltan into "12 entries", which is
    // the one thing the Director cannot act on.
    //
    // A row that states NO figure at all used to do the same damage, because
    // the whole bucket had to parse: September's "Coltan transport and
    // delivery" reads "60kgs Delivery", "66kgs", "20kgs", "51.7kgs", "52kgs"
    // and then one row with nothing in the quantity column, and that one row
    // turned 249.7kg of coltan moved into "6 entries". So the unit now stands
    // on the rows that state one, as long as they are at least two thirds of
    // them: a silent row is a row nobody wrote a figure on, not a
    // contradiction of the five that agree.
    //
    // Two thirds and not half, which was tried first and is too generous. At
    // half, two rows reading "1Tech,1Carp&1Helper" out of four made a month of
    // roof renovation a target of "2 tech", and one row reading "2bottles" out
    // of two made "Meals and drinks" a target of "2 bottles". A unit has to be
    // what the work is actually measured in, and a bare majority of a short
    // column is not evidence of that.
    //
    // Below that, the rows are not describing one countable thing (August's
    // shopping reads "Posho(25kg),Torch,Rice(2kg)&2 Big fant"), and the
    // objective counts the times it was done instead.
    const stated = parsed.filter(Boolean);
    const units = new Set(stated.map((quantity) => quantity.unit).filter(Boolean));
    const countable = units.size === 1 && stated.length * 3 >= parsed.length * 2;
    // "times" and not "entries": the Director reads these targets and then
    // writes next month from what they read, so the word has to be one they
    // would use themselves. "3 times" is how somebody says it; "3 entries" is
    // the bookkeeping showing through, and it is the word the manager would
    // then be asked to record against.
    const unit = countable ? [...units][0] : 'times';
    const target = countable
      ? stated.reduce((sum, quantity) => sum + quantity.value, 0)
      : objective.days.length;
    objectives.push({
      title: objective.title,
      supportsOperation: objective.supports,
      targetQuantity: Math.round(target * 100) / 100,
      targetUnit: unit,
      days: objective.days.map((day) => ({
        date: day.date,
        // Null where the row stated no figure: it still carries its cost, its
        // note and its day, and contributes nothing to a target it never
        // claimed. The server stores that as 0 and compare.mjs reads both the
        // same way, so a re-run cannot post the day twice.
        quantityDone: countable ? (day.parsed ? day.parsed.value : null) : 1,
        cost: day.usd,
        // The row as it was written, so the day keeps the words, the place, the
        // headcount and the figure in the currency it was actually paid in.
        // Built by shared/workbookNote.js, which the report reads back apart so
        // it can print these as the workbook's own columns again. The activity
        // column is carried from here on; days imported before it was stay as
        // they are, because a re-run matches a recorded day on its objective,
        // date, quantity and cost and never on its note.
        notes: formatWorkbookNote({
          activity: day.activity,
          description: day.description,
          location: day.location,
          quantityText: day.quantityText,
          source: day.source,
          file: workbookPath.split(/[\/]/).pop(),
          sheet: day.sheet,
          row: day.n
        })
      })).sort((a, b) => a.date.localeCompare(b.date))
    });
  }
  const spentOn = (objective) => objective.days.reduce((sum, day) => sum + day.cost, 0);
  objectives.sort((a, b) => spentOn(b) - spentOn(a));
  // THE MONTH'S APPROVED BUDGET IS WHAT THE MONTH COST. Summed from the same
  // rounded figures the days carry, so the budget is consumed exactly: a spend
  // of precisely the remaining budget is allowed, one cent over is refused.
  const approvedBudget = Math.round(objectives.reduce((sum, objective) => sum + spentOn(objective), 0) * 100) / 100;
  const dayCount = objectives.reduce((sum, objective) => sum + objective.days.length, 0);
  out.push({
    operation: plan.operation,
    month: plan.month,
    approvedBudget,
    objectives,
    notes: [
      `Recorded from the Rubaya & Gisuma workbook (${[...plan.sheets].join('; ')}): ${dayCount} days, $${approvedBudget.toFixed(2)}.`,
      `Figures given only in local currency were converted at the workbook's own implied rates, 1 USD = ${rate.frw.toFixed(1)} FRW and ${rate.fco.toFixed(1)} FCO; each day keeps its original figure.`,
      plan.operation === 'mining' ? DELIVERY_NOTES[plan.month] || '' : ''
    ].filter(Boolean).join(' ').slice(0, 2000)
  });
}

writeFileSync(outPath, JSON.stringify(out, null, 1));

let totalDays = 0;
let totalMoney = 0;
for (const plan of out) {
  const days = plan.objectives.reduce((sum, objective) => sum + objective.days.length, 0);
  totalDays += days;
  totalMoney += plan.approvedBudget;
  console.log(`\n${plan.operation.toUpperCase()} / ${plan.month}   budget $${plan.approvedBudget.toFixed(2)}   ${days} days   ${plan.objectives.length} objectives`);
  for (const objective of plan.objectives) {
    const spent = objective.days.reduce((sum, day) => sum + day.cost, 0);
    console.log(`   - ${objective.title.padEnd(38)}${String(objective.targetQuantity).padStart(8)} ${objective.targetUnit.padEnd(10)}${String(objective.days.length).padStart(3)}d  $${spent.toFixed(2).padStart(10)}${objective.supportsOperation ? `  [supports ${objective.supportsOperation}]` : ''}`);
  }
}
console.log(`\n${out.length} monthly plans, ${totalDays} days, $${totalMoney.toFixed(2)} -> ${outPath}`);
console.log(`${skipped.length} rows set aside:`);
for (const row of skipped) console.log(`   ${row.sheet} r${row.n}: ${row.reason}${row.label ? ` -- "${row.label}"` : ''}`);
// A month cannot carry more than MAX_OBJECTIVES (40) in monthlyPlans.js.
for (const plan of out) {
  if (plan.objectives.length > 40) console.log(`OVER THE 40-OBJECTIVE LIMIT: ${plan.operation}/${plan.month}`);
}
