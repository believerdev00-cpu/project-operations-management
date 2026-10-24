// The rules `plans-from-workbook.mjs` reads the operations workbook by, on
// their own so they can be tested without a workbook. Every one of them is
// specific to how the Rubaya & Gisuma sheets were kept; read them before
// importing a different workbook.

// ROWS THAT ARE ARITHMETIC ABOUT OTHER ROWS, not work that cost money.
//
// Each consignment is closed with its own sums -- "DELIVERY 2 SUMMARY", "Total
// kgs Received", "Total Sale", "net profit", and bare sums like
// "30911-25000-212-2149-250". Counted as costs they double the month.
//
// "total" is matched as a bare substring with no word boundary on purpose: one
// line reads "DELIVERY 2Total Ops related to Mining", where the missing space
// leaves \btotal\b nothing to anchor to and let $203 of double spending back in.
// The price of that is that a real cost described with the word "total" is
// set aside too -- which is why every row set aside this way is REPORTED with
// its money (summaryReport), never dropped silently.
export const SUMMARY = /summary|total|net profit|sale-invest|^\s*[\d,.\s]+-[\d,.\s-]+=?\s*$/i;
export const isSummaryRow = (activity, description) => SUMMARY.test(String(description || '')) || SUMMARY.test(String(activity || ''));

// The rows set aside as totals/summaries, with what they would have cost, for
// the person reviewing the import: each one is either arithmetic (right to
// leave out) or a real cost that happens to say "total" (wrong to leave out).
export function summaryReport(rows) {
  const lines = rows.map((row) => {
    const usd = row.usd ? `$${Math.round(Number(row.usd) * 100) / 100}` : '';
    const money = [usd, row.frw ? `${row.frw} FRW` : '', row.fco ? `${row.fco} FCO` : ''].filter(Boolean).join(' / ') || 'no figure';
    return `   ${row.sheet} r${row.n}: ${money} -- "${row.label}"`;
  });
  const usd = rows.reduce((sum, row) => sum + (Number(row.usd) || 0), 0);
  return { count: rows.length, usd: Math.round(usd * 100) / 100, lines };
}

// THE DATES ARE NOT ALL THE SAME SHAPE.
//
// The workbooks are typed d/m/y. Anything with a day above 12 stayed text
// ("26/07/2026") and is plainly d/m/y. Anything whose first two numbers were
// both 12 or under, Excel swallowed as a real date in m/d/y -- so the cell that
// reads 2026-07-08 was typed 7/8/2026 and means 7 AUGUST. Reading those as
// written scatters August's work back into July and breaks every monthly total,
// which is why a date cell is swapped back and a text cell is read as d/m/y.
//
// THE YEAR IS GIVEN, NOT ASSUMED. Every row must fall in `year` (the required
// --year argument). A row in any other year -- "25/8/2028" in the 2026
// workbook was a typo -- is refused with its reason and set aside for a person
// to decide, never quietly rewritten into the expected year.
//
//   cell           { v, k } from the workbook (k = 'date' for a real date cell)
//   fallbackMonth  the month of the row above, for "28/02026" where it was lost
//   year           the year every date must be in
export function parseDate(cell, fallbackMonth, year) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('parseDate needs the expected year (a four-digit number)');
  if (!cell || cell.v === '') return { date: null, why: 'empty' };
  let day;
  let month;
  let found;
  let why;
  if (cell.k === 'date') {
    const [y, m, d] = String(cell.v).split('-').map(Number);
    found = y;
    // Only ambiguous when both are 12 or under; a day of 31 could never have
    // been read as a month, so that cell is already right.
    if (d >= 1 && d <= 12) { day = m; month = d; why = 'swapped'; } else { day = d; month = m; why = 'kept'; }
  } else {
    let text = String(cell.v).trim().replace(/\/{2,}/g, '/').replace(/\s+/g, ' ');
    text = text.replace(/^(\d{1,2})\s*[-–]\s*\d{1,2}([/ .-])/, '$1$2'); // "10-11/8/2026" -> the 10th
    const parts = text.split(/[/ .-]+/).filter(Boolean);
    if (parts.length === 3) [day, month, found] = parts.map(Number);
    else if (parts.length === 2 && /^\d{6}$/.test(parts[1])) {        // "07/082026"
      day = Number(parts[0]);
      month = Number(parts[1].slice(0, 2));
      found = Number(parts[1].slice(2));
    } else if (parts.length === 2 && /^0?\d{4,5}$/.test(parts[1])) {  // "28/02026" -- the month was lost
      day = Number(parts[0]);
      month = fallbackMonth;
      found = Number(parts[1].slice(-4));
    } else return { date: null, why: `unparsed:${text}` };
    if (found < 100) found += 2000;
    why = 'text';
  }
  if (found !== year) return { date: null, why: `year ${found} is not ${year}` };
  if (!month || month < 1 || month > 12 || !day || day < 1 || day > 31) return { date: null, why: `range:${cell.v}` };
  // A day the month does not have (31 June) is refused rather than rolled over.
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > last) return { date: null, why: `no such day:${cell.v}` };
  return { date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, why };
}

// The --year argument: required, four digits.
export function parseYearArgument(raw) {
  if (raw === undefined) return { ok: false, why: 'give --year=<YYYY>: the year every row of the workbook must fall in' };
  if (!/^\d{4}$/.test(String(raw))) return { ok: false, why: `--year must be a four-digit year, not "${raw}"` };
  const year = Number(raw);
  if (year < 2000 || year > 2100) return { ok: false, why: `--year ${raw} is out of range` };
  return { ok: true, year };
}

// SALES AND PROFITS have no field in POMS (it records money going out), so a
// consignment's delivery summary is kept as words in the month's notes. They
// used to be hard-coded for August and September 2026; now they come only from
// an optional JSON file (--delivery-notes=<file>):
//
//   { "mining/2026-08": "Delivery 1: ...", "mining/2026-09": "..." }
//
// Keys are operation/YYYY-MM, values non-empty text. Without the file, no
// month gets any delivery notes.
export function parseDeliveryNotes(json) {
  let data;
  try { data = JSON.parse(json); } catch (error) { throw new Error(`--delivery-notes is not valid JSON: ${error.message}`); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('--delivery-notes must be a JSON object of "operation/YYYY-MM": "text"');
  const notes = new Map();
  for (const [key, value] of Object.entries(data)) {
    if (!/^[a-z]+\/\d{4}-(0[1-9]|1[0-2])$/.test(key)) throw new Error(`--delivery-notes key "${key}" is not operation/YYYY-MM`);
    if (typeof value !== 'string' || !value.trim()) throw new Error(`--delivery-notes "${key}" must be non-empty text`);
    notes.set(key, value.trim());
  }
  return notes;
}
