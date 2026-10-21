// The columns of a day of work, in the order a manager fills them in -- and the
// order every place that shows a day prints them: the form a manager records
// through, the plan's day table, the report screen, the spreadsheet and the
// PDF. One list, read by all of them, so the sheet the Director exports has
// exactly the headers, in exactly the order, of the form the day was typed
// into; before this the form said "Notes" where the export said "What was
// written", and the two put the columns in different orders.
//
// Each id is also its header's key, `day.<id>` in shared/strings.js. The
// `activity` column is the objective the day counted towards (the manager's
// word for it on paper); `description` is the `notes` field, which always held
// "what happened today"; `status` is the manager's own words about where the
// work stands, never an approval. Photos come last because they are attached
// after the day's figures, below the form.
//
// Imported by the browser and by server/routes/reports.js, so it must stay
// free of React and of anything Node-only.
export const DAY_COLUMNS = ['date', 'activity', 'description', 'quantity', 'cost', 'status', 'remarks', 'photos'];
