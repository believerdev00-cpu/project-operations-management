// Turn a Rubaya & Gisuma operations workbook into monthly plans this system can
// hold. Reads the .xlsx, writes a JSON file that `load-plans.mjs` then posts to
// the API. Nothing here touches a database or a network.
//
//   node scripts/import/plans-from-workbook.mjs <workbook.xlsx> <plans.json> --year=2026 \
//     [--rate-frw=N --rate-fco=N] [--ranges=first-day] [--delivery-notes=<file.json>] [--exclude=op/YYYY-MM,...]
//
// The workbooks are a hand-kept record, not an export, so most of this file is
// about reading them honestly rather than about the schema. Three things in
// particular are not what they appear to be -- the dates, the money, and the
// rows that are arithmetic about other rows -- and each is handled with the
// reason it has to be. The rules are specific to the Rubaya & Gisuma sheets
// (workbookRules.mjs); review them before reading any other workbook.
import ExcelJS from 'exceljs';
import { readFileSync, writeFileSync } from 'node:fs';
import { formatWorkbookNote } from '../../shared/workbookNote.js';
import { isSummaryRow, parseDate, parseDeliveryNotes, parseYearArgument, summaryReport } from './workbookRules.mjs';

const [workbookPath, outPath] = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
if (!workbookPath || !outPath) {
  console.error('usage: node scripts/import/plans-from-workbook.mjs <workbook.xlsx> <plans.json> --year=<YYYY> [options]');
  process.exit(1);
}
const option = (name) => process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
// The year every row must fall in. Required: it used to be forced to 2026,
// which rewrote any other year without a word.
const yearArgument = parseYearArgument(option('year'));
if (!yearArgument.ok) { console.error(yearArgument.why); process.exit(1); }
const YEAR = yearArgument.year;
// Mining's delivery summaries (sales and profit, which POMS has no field for),
// as words for the month's notes -- only from a file given on purpose.
const deliveryNotesPath = option('delivery-notes');
const DELIVERY_NOTES = deliveryNotesPath ? parseDeliveryNotes(readFileSync(deliveryNotesPath, 'utf8')) : new Map();

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

// Rows that are arithmetic about other rows (delivery summaries, totals, bare
// sums) are set aside by isSummaryRow in workbookRules.mjs -- and reported,
// with their money, at the end of the run.

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

// Dates (d/m/y, cells Excel swapped, and the required --year) are read by
// parseDate in workbookRules.mjs.

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
const implied = { frw: median(ratios.frw), fco: median(ratios.fco) };
console.log(`rates the workbook implies: 1 USD = ${implied.frw?.toFixed(1)} FRW (${ratios.frw.length} rows), ${implied.fco?.toFixed(1)} FCO (${ratios.fco.length} rows)`);
// THE RATES THE DIRECTOR APPROVED for this import, when given: --rate-frw and
// --rate-fco, both or neither. They replace the implied ones exactly -- no
// mix of the two, no live market rate. FRW is the workbook's word for the
// Rwandan franc (RWF in POMS) and FCO its word for the Congolese franc (CDF
// in POMS); the notes keep the workbook's own words, nothing is renamed.
const flag = (name) => process.argv.find((argument) => argument.startsWith(`--${name}=`))?.split('=')[1];
const approved = { frw: Number(flag('rate-frw')), fco: Number(flag('rate-fco')) };
const given = [flag('rate-frw'), flag('rate-fco')].filter((value) => value !== undefined).length;
if (given === 1) throw new Error('give both --rate-frw and --rate-fco, or neither');
if (given === 2 && !(approved.frw > 0 && approved.fco > 0)) throw new Error('--rate-frw and --rate-fco must be numbers above zero');
const rate = given === 2 ? approved : implied;
if (!rate.frw || !rate.fco) throw new Error('no rates given and none can be derived from the workbook');
console.log(`rates USED: 1 USD = ${rate.frw} FRW, ${rate.fco} FCO (${given === 2 ? 'approved, given on the command line' : 'implied by the workbook'})`);
const rateText = (value) => (Number.isInteger(value) ? String(value) : value.toFixed(1));

const rows = [];
const skipped = [];
const held = [];
const totals = [];
// Rows whose date was a range, recorded on their first day: sheet#row -> the range as written.
const rangeNote = new Map();
let lastMonth = null;
for (const row of raw) {
  const text = (index) => (index === undefined || !row.cells[index] ? '' : String(row.cells[index].v || '').trim());
  const activity = text(row.columns.act);
  const description = text(row.columns.desc);
  const usd = num(row.cells[row.columns.usd]);
  const frw = num(row.cells[row.columns.frw]);
  const fco = num(row.cells[row.columns.fco]);
  const { date, why } = parseDate(row.cells[row.columns.date], lastMonth, YEAR);
  if (date) lastMonth = Number(date.slice(5, 7));

  // A DATE RANGE ("10-11/8/2026", "9-24/9/2026") is one figure for several days.
  // By default the row is HELD for the Director to decide -- putting it on the
  // first day says something the workbook does not, and POMS records days, not
  // periods -- and its money stays in the month's budget (the source total) as
  // the part not yet recorded. --ranges=first-day records it instead (below).
  const dateText = row.cells[row.columns.date]?.k === 'date' ? '' : String(row.cells[row.columns.date]?.v || '');
  const isRange = /^\s*\d{1,2}\s*-\s*\d{1,2}\s*[/ ]/.test(dateText);
  const summary = isSummaryRow(activity, description);
  const reason = summary ? 'summary/arithmetic row'
    : !date ? `no usable date (${why})`
      : (!usd && !frw && !fco) ? 'no cost in any currency' : null;
  // Kept apart so they are reported with their money: a real cost that says
  // "total" lands here too, and a reviewer has to be able to see it.
  if (summary) totals.push({ sheet: row.sheet, n: row.n, label: [activity, description].filter(Boolean).join(' - '), usd, frw, fco });
  // --ranges=first-day (the Director's decision of 24 October 2026): the
  // payment is recorded on the first day of its range, whole -- never split --
  // and the range as written goes into the day's description.
  const rangeOnFirstDay = process.argv.includes('--ranges=first-day');
  if (!reason && isRange && date && rangeOnFirstDay) rangeNote.set(`${row.sheet}#${row.n}`, dateText.trim());
  if (!reason && isRange && date && !rangeOnFirstDay) {
    const cost = usd && usd > 0 ? usd : frw && frw > 0 ? frw / rate.frw : fco / rate.fco;
    held.push({ sheet: row.sheet, n: row.n, month: date.slice(0, 7), dateText: dateText.trim(), label: [activity, description].filter(Boolean).join(' - '),
      usd: Math.round(cost * 100) / 100, operation: SHEET_OPERATION[row.sheet].operation });
    continue;
  }
  if (reason) {
    skipped.push({ sheet: row.sheet, n: row.n, label: [activity, description].filter(Boolean).join(' - '), reason });
    continue;
  }

  // The USD column when the workbook states one, otherwise converted. Both the
  // figure and where it came from are carried, so the day can say so.
  const money = usd && usd > 0 ? { usd, from: `$${usd} as recorded` }
    : frw && frw > 0 ? { usd: frw / rate.frw, from: `${frw} FRW at ${rateText(rate.frw)}/USD` }
      : { usd: fco / rate.fco, from: `${fco} FCO at ${rateText(rate.fco)}/USD` };

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
    // objective gets NO TARGET: counting its rows into "N times" (or "N
    // entries", as the first import did) made up a commitment the workbook
    // never states. Such an objective has no percentage ("not counted"), its
    // days carry no quantity, and the month completes on the objectives that
    // do carry a measured quantity -- a month of none never completes by itself.
    const stated = parsed.filter(Boolean);
    const units = new Set(stated.map((quantity) => quantity.unit).filter(Boolean));
    const countable = units.size === 1 && stated.length * 3 >= parsed.length * 2;
    const unit = countable ? [...units][0] : '';
    const target = countable ? stated.reduce((sum, quantity) => sum + quantity.value, 0) : null;
    objectives.push({
      title: objective.title,
      supportsOperation: objective.supports,
      targetQuantity: target === null ? null : Math.round(target * 100) / 100,
      targetUnit: unit,
      days: objective.days.map((day) => ({
        date: day.date,
        // Null where the row stated no figure: it still carries its cost, its
        // note and its day, and contributes nothing to a target it never
        // claimed. The server stores that as 0 and compare.mjs reads both the
        // same way, so a re-run cannot post the day twice.
        quantityDone: countable ? (day.parsed ? day.parsed.value : null) : null,
        cost: day.usd,
        // The row as it was written, so the day keeps the words, the place, the
        // headcount and the figure in the currency it was actually paid in.
        // Built by shared/workbookNote.js, which compare.mjs reads back for the
        // sheet and row. The source file is named as given on the command line.
        // The activity column is carried from here on; days imported before it
        // was stay as they are, because a re-run matches a recorded day on its
        // objective, date, quantity and cost and never on its note.
        notes: formatWorkbookNote({
          activity: day.activity,
          description: rangeNote.has(`${day.sheet}#${day.n}`)
            ? `${day.description} (dates ${rangeNote.get(`${day.sheet}#${day.n}`)}, recorded on the first day)`
            : day.description,
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
  // Rows held for review (date ranges) are part of what the month used, so
  // they are in its budget; until they are decided, that is what remains.
  const heldHere = held.filter((h) => h.operation === plan.operation && h.month === plan.month);
  const heldMoney = heldHere.reduce((sum, h) => sum + h.usd, 0);
  const approvedBudget = Math.round((objectives.reduce((sum, objective) => sum + spentOn(objective), 0) + heldMoney) * 100) / 100;
  const dayCount = objectives.reduce((sum, objective) => sum + objective.days.length, 0);
  out.push({
    operation: plan.operation,
    month: plan.month,
    approvedBudget,
    heldForReview: heldHere,
    objectives,
    notes: [
      `Recorded from the Rubaya & Gisuma workbook (${[...plan.sheets].join('; ')}): ${dayCount} days, $${approvedBudget.toFixed(2)}.`,
      `Figures given only in local currency were converted at 1 USD = ${rateText(rate.frw)} FRW and ${rateText(rate.fco)} FCO (${given === 2 ? 'the rates approved for this import' : 'the rates the workbook implies'}); each day keeps its original figure.`,
      // The Director's decisions of 24 October 2026, stated on the plan itself.
      'Targets are the quantities the workbook records as done -- a historical record, not necessarily an originally approved target; an objective whose rows state no measured quantity has no target.',
      'Where a row gave both FRW and FCO and no USD, the FRW figure was used.',
      heldHere.length ? `Held for review, not yet recorded as days (dated with a range of days): ${heldHere.map((h) => `${h.sheet} row ${h.n} "${h.dateText}" ${h.usd.toFixed(2)}`).join('; ')}.` : '',
      DELIVERY_NOTES.get(`${plan.operation}/${plan.month}`) || ''
    ].filter(Boolean).join(' ').slice(0, 2000)
  });
}

// --exclude=mining/2026-08,mining/2026-09: months left out of the file
// entirely, so no run built from it can create, fill in or touch them --
// whatever a comparison with the deployment finds.
const excluded = new Set((process.argv.find((a) => a.startsWith('--exclude='))?.slice('--exclude='.length) || '').split(',').filter(Boolean));
for (const plan of out.filter((p) => excluded.has(`${p.operation}/${p.month}`))) {
  console.log(`EXCLUDED from this file: ${plan.operation}/${plan.month} ($${plan.approvedBudget.toFixed(2)}, ${plan.objectives.reduce((s, o) => s + o.days.length, 0)} days) -- nothing in it can be written`);
}
for (const key of excluded) if (!out.some((p) => `${p.operation}/${p.month}` === key)) console.log(`--exclude names ${key}, which is not in this workbook`);
out.splice(0, out.length, ...out.filter((p) => !excluded.has(`${p.operation}/${p.month}`)));
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
    console.log(`   - ${objective.title.padEnd(38)}${String(objective.targetQuantity ?? 'no target').padStart(9)} ${objective.targetUnit.padEnd(10)}${String(objective.days.length).padStart(3)}d  $${spent.toFixed(2).padStart(10)}${objective.supportsOperation ? `  [supports ${objective.supportsOperation}]` : ''}`);
  }
}
console.log(`\n${out.length} monthly plans, ${totalDays} days, $${totalMoney.toFixed(2)} -> ${outPath}`);
console.log(`${held.length} rows HELD FOR REVIEW (a range of days, not one day) -- in the month's budget, not recorded:`);
for (const h of held) console.log(`   ${h.sheet} r${h.n}: "${h.dateText}" -> ${h.operation}/${h.month} ${h.usd.toFixed(2)} -- "${h.label}"`);
console.log(`${skipped.length} rows set aside:`);
for (const row of skipped) console.log(`   ${row.sheet} r${row.n}: ${row.reason}${row.label ? ` -- "${row.label}"` : ''}`);
// The rows set aside as totals/summaries, again, with their money: check each
// one is arithmetic and not a real cost that happens to say "total".
const totalsSetAside = summaryReport(totals);
console.log(`${totalsSetAside.count} of those were set aside as totals/summaries (USD column $${totalsSetAside.usd.toFixed(2)}) -- check none is a real cost:`);
for (const line of totalsSetAside.lines) console.log(line);
for (const key of DELIVERY_NOTES.keys()) if (!out.some((p) => `${p.operation}/${p.month}` === key)) console.log(`--delivery-notes names ${key}, which is not in this file -- not used`);
if (DELIVERY_NOTES.size) console.log(`delivery notes from ${deliveryNotesPath}: ${[...DELIVERY_NOTES.keys()].filter((key) => out.some((p) => `${p.operation}/${p.month}` === key)).join(', ') || 'none used'}`);
// A month cannot carry more than MAX_OBJECTIVES (40) in monthlyPlans.js.
for (const plan of out) {
  if (plan.objectives.length > 40) console.log(`OVER THE 40-OBJECTIVE LIMIT: ${plan.operation}/${plan.month}`);
}
