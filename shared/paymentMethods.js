// How money left the Director's hands, recorded for the audit trail. The
// platform neither performs nor settles any of them.
//
// This list is a database CHECK constraint (`plan_expenses.payment_method`, in
// server/db/monthlySchema.js) AND the options in the expense form. It was
// written out twice -- once in the schema, once in the client -- which is a
// constraint and a form that can disagree: add a method to the dropdown only
// and the manager picks something Postgres then refuses, with the work already
// typed. Both sides import it from here, the way the business operations and
// the category presets already are.
export const PAYMENT_METHODS = ['Cash', 'Bank Transfer', 'Mobile Money', 'Cheque', 'Credit', 'Other'];
