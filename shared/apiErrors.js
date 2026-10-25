// The refusals the API names with a `code` that the browser shows in the
// reader's own language (`apiError.<CODE>` in shared/strings.js).
//
// Before this, every refusal reached the screen as the server's English
// `message`, so a manager writing in Kinyarwanda or Swahili was told why a day
// could not be saved in a language they may not read. The server still sends
// its English message beside the code -- it is the fallback for any refusal not
// listed here, and what the logs and the tests read -- and nothing about what
// is refused, or when, changes: only the words on the screen.
//
// Values a sentence needs (the month, how much is left, which product) travel
// with the refusal as plain fields, and the browser fills them in.
//
// Imported by the browser (useApi in src/App.jsx) and by the language test,
// which checks that every code has its sentence in all four languages.
export const API_ERROR_CODES = [
  // The global error handler: input the database refused.
  'INVALID_JSON', 'TOO_LARGE', 'BAD_FORMAT', 'BAD_DATE', 'NUMBER_TOO_LARGE', 'TOO_LONG',
  'DUPLICATE', 'IN_USE', 'NOT_ALLOWED_VALUE', 'TRY_AGAIN', 'SERVER_ERROR',
  // Recording a day on a monthly plan, and correcting it.
  'NOT_YOUR_PLAN', 'PLAN_NOT_CONFIRMED', 'PLAN_CLOSED', 'DAY_REQUIRED', 'DAY_OUTSIDE_MONTH',
  'BAD_QUANTITY', 'BAD_COST', 'EMPTY_REPORT', 'OBJECTIVE_REQUIRED', 'OVER_TARGET',
  'OVER_BUDGET', 'OVER_MONTHLY_BUDGET', 'OVER_ACTIVITY_BUDGET',
  // The shop's stock.
  'INSUFFICIENT_STOCK', 'COUNT_ABOVE_SHELF', 'PRODUCT_EXISTS', 'DIRECTOR_ONLY'
];

// The refusals whose `remaining` is money, shown as dollars.
export const MONEY_ERROR_CODES = ['OVER_BUDGET', 'OVER_MONTHLY_BUDGET', 'OVER_ACTIVITY_BUDGET'];
