// The note an imported day carries, and how to read it back apart.
//
// A day recorded from the operations workbook keeps the row it came from, in
// the row's own words: the activity and description as typed, the place, the
// quantity exactly as written ("424 meters to 10 labourers", "1 month& 2sim
// cards"), the figure in the currency it was actually paid in, and the sheet
// and row it can be checked against.
//
// There is nowhere else for any of that to go. plan_daily_reports holds a date,
// a quantity, a cost and one free-text `notes` column -- so the workbook's
// other columns live inside that one cell, and a report that wants to show them
// as columns again has to read them back out.
//
// WHO USES IT. Only the import tooling and its tests: plans-from-workbook.mjs
// writes the note, compare.mjs reads the sheet and row back to recognise a day
// already imported, and tests/pure-logic.test.mjs checks both. The application
// itself (server/ and src/) does not import this file; a report shows an
// imported day's note as the text it is.
//
// WHY THIS IS ONE FILE. The writer and the reader never call each other, so the
// format is a contract between them. Two hand-written copies of it would drift
// the first time a separator changed, and the failure would be silent -- an
// import that no longer recognises its own days and posts them again. So it is
// written once here and both sides use it.
//
// IT IS NOT A DATABASE. parse() answers null for anything that is not a note
// this format wrote, which is every note a manager has ever typed by hand;
// nothing is ever mangled into a column it does not belong in.

const FIELD = ' | ';
const WHERE = ' @ ';
const WHAT = ' — ';
const QUANTITY = 'Quantity: ';

// The tail every imported note ends with, and the reason parse() can be sure:
// the optional "|" is swallowed with it, or slicing the tail off leaves the
// separator stuck to the last field and the figure stops being recognised.
// "[rubaya report.xlsx / Mining Activities row 12]". Nothing else writes it.
const SOURCE = /(?:\s*\|)?\s*\[([^[\]/]+?)\s*\/\s*(.+?)\s+row\s+(\d+)\]\s*$/;

// The figure as the workbook stated it: "$33 as recorded", or the local amount
// with the rate it was converted at, "43000 FRW at 1470.6/USD".
const AS_RECORDED = /^\$[\d.,]+ as recorded$/;
const CONVERTED = /^[\d.,]+ (?:FRW|FCO) at [\d.]+\/USD$/;

const clean = (value) => String(value ?? '').trim();

// Build the note for one workbook row.
//
// The order is fixed because it is also the order a person reads: what was
// done, where, how much of it, what it cost, and where to check it.
export function formatWorkbookNote(row = {}, limit = 4000) {
  const what = [clean(row.activity), clean(row.description)].filter(Boolean).join(WHAT);
  return [
    [what, clean(row.location)].filter(Boolean).join(WHERE),
    clean(row.quantityText) ? `${QUANTITY}${clean(row.quantityText)}` : '',
    clean(row.source),
    clean(row.file) && clean(row.sheet) && row.row
      ? `[${clean(row.file)} / ${clean(row.sheet)} row ${row.row}]`
      : ''
  ].filter(Boolean).join(FIELD).slice(0, limit);
}

// Read one back, or null when it was not written by formatWorkbookNote.
//
// `activity` is absent from notes written before the activity column was kept,
// and those notes still parse -- the field simply comes back empty. A reader
// showing columns has to cope with that, because the rows already imported are
// the rows that matter.
export function parseWorkbookNote(note) {
  const text = clean(note);
  const tail = SOURCE.exec(text);
  if (!tail) return null;

  const [file, sheet, row] = [tail[1].trim(), tail[2].trim(), Number(tail[3])];
  const fields = text.slice(0, tail.index).split(FIELD).map(clean).filter(Boolean);

  let quantityText = '';
  let source = '';
  let where = '';
  for (const field of fields) {
    if (field.startsWith(QUANTITY)) quantityText = field.slice(QUANTITY.length).trim();
    else if (AS_RECORDED.test(field) || CONVERTED.test(field)) source = field;
    else if (!where) where = field;
  }

  // "activity — description @ location". The place is split off first because a
  // description may itself contain a dash, while " @ " only ever separates the
  // location the import put there.
  const at = where.indexOf(WHERE);
  const location = at < 0 ? '' : where.slice(at + WHERE.length).trim();
  const what = at < 0 ? where : where.slice(0, at).trim();
  const dash = what.indexOf(WHAT);

  return {
    activity: dash < 0 ? '' : what.slice(0, dash).trim(),
    description: dash < 0 ? what : what.slice(dash + WHAT.length).trim(),
    location,
    quantityText,
    // The figure in the currency the workbook stated it in. Deliberately the
    // text and not a number: it is evidence of what was written, and the day's
    // own `cost` is the figure every total is built from.
    source,
    file,
    sheet,
    row: Number.isFinite(row) ? row : null
  };
}
