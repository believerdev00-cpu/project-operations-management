// The Boutique Management System (Project 5): what the API and the browser
// must agree on.
//
// The boutique is the fifth business operation (RETAIL_OPERATION in
// ./businessOperations.js) and one `projects` row, PRJ-BOUTIQUE, seeded by the
// migration so it appears on the Director's Projects page like any other
// project. Everything below is a list that is BOTH a database CHECK constraint
// (server/db/boutiqueSchema.js) AND the options a form offers, kept here for
// the same reason PAYMENT_METHODS is in ./paymentMethods.js: two copies of a
// list are a constraint and a form that can disagree.
//
// MONEY. The boutique trades in Rwandan francs. Every amount is a NUMERIC(18,2)
// column in RWF -- the same column type and the same currency code the trips
// register already uses for RWF -- and every sum in the API is done in integer
// minor units (`toMinor`/`fromMinor`) so a total of three lines can never be
// off by a floating-point rounding. The platform records money, it never
// moves it: a "payment" here is the cashier writing down how the customer
// paid, nothing is settled anywhere.

import { CATEGORIES } from './categories.js';

export const BOUTIQUE_PROJECT_ID = 'PRJ-BOUTIQUE';
export const BOUTIQUE_WORKSPACE = 'boutique';
export const BOUTIQUE_CURRENCY = 'RWF';

// What the shop sells. The boutique is a LOCAL SHOP -- everyday goods, not
// fashion -- so these are the categories a form offers, in the order a
// shopkeeper thinks of them, with `other` last for anything that fits none.
// This list is the only place they are named: the CHECK constraint, the
// product form, the filters and the translation test all read it.
export const PRODUCT_CATEGORIES = [
  'groceries', 'bread_snacks', 'drinks', 'dairy_eggs', 'fresh_produce',
  'cleaning', 'personal_care', 'household', 'stationery', 'other'
];

// The categories the shop was first built with, when it was planned as a
// clothes boutique. Products already saved under them keep them -- nothing is
// rewritten -- so they stay valid in the database and are still shown by name,
// but no form offers them for a new product.
export const LEGACY_PRODUCT_TYPES = ['clothing', 'shoes', 'bags', 'accessories'];

// Every value boutique_products.product_type may hold.
export const PRODUCT_TYPES = [...PRODUCT_CATEGORIES, ...LEGACY_PRODUCT_TYPES];

// How a customer pays. The first four are the methods the shop can configure
// on or off (boutique_payment_methods); 'Exchange credit' is never offered on
// its own -- it is the value of returned goods applied to a new sale during an
// exchange, written as a payment line so the new sale balances. It is not
// money received, and the finance figures leave it out.
export const BOUTIQUE_PAYMENT_METHODS = ['Cash', 'Mobile Money', 'Card', 'Bank Transfer'];
export const EXCHANGE_CREDIT = 'Exchange credit';
export const ALL_BOUTIQUE_PAYMENT_METHODS = [...BOUTIQUE_PAYMENT_METHODS, EXCHANGE_CREDIT];

// Every way a variant's stock can change, as the ledger records it. Each row
// of boutique_stock_movements carries one of these and the balance after it,
// so the ledger alone explains today's figure.
export const STOCK_MOVEMENT_KINDS = [
  'opening',           // the first count, when the variant is created
  'purchase_receipt',  // goods received against a purchase order
  'sale',              // sold at the till (negative)
  'sale_return',       // a customer brought it back and it went back on the shelf
  'void',              // a voided sale put its goods back
  'damaged',           // written off (negative)
  'missing',           // could not be found at a count (negative)
  'count',             // a physical count corrected the figure either way
  'supplier_return',   // sent back to the supplier (negative)
  'transfer_out',      // moved to another shop or store (negative)
  'transfer_in',       // received from another shop or store
  'received'           // new stock arrived without a purchase order
];

// The adjustments a manager asks for and the Director approves. Each is a
// stock movement kind above; a sale, a purchase-order receipt and the opening
// figure are recorded by the work itself and never asked for here.
//
// `received` is the everyday case first: "10 more bags of sugar came in". A
// small shop is often restocked from the market with no purchase order, and
// without this kind the only way to put those goods on the shelf was a
// "physical count", which REPLACES the figure -- one wrong number there and
// stock was silently lost. Received ADDS. It still waits for the Director
// when the manager records it, like every other change with nothing sold.
export const ADJUSTMENT_KINDS = ['received', 'damaged', 'missing', 'count', 'supplier_return', 'transfer_out', 'transfer_in'];

// The adjustments that ADD to the shelf; every other kind except a count
// takes away. Read by the API's delta and by the form's "stock after" preview,
// so the two can never disagree about which way a kind goes.
export const ADDING_ADJUSTMENTS = ['received', 'transfer_in'];

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'];

export const PURCHASE_STATUSES = ['ordered', 'partially_received', 'received', 'cancelled'];

// A sale is completed the moment it is rung up. It is never deleted: a mistake
// is undone by a void, which the Director approves when the manager asks for
// it (void_requested) and which puts the goods back and takes the sale out of
// every figure.
export const SALE_STATUSES = ['completed', 'void_requested', 'voided'];

export const RETURN_KINDS = ['return', 'exchange'];

export const SESSION_STATUSES = ['open', 'closed'];

// Till movements that are not sales and not expenses: a float put in, cash
// taken out to the bank or the owner.
export const CASH_MOVEMENT_KINDS = ['cash_in', 'payout'];

export const EXPENSE_STATUSES = ['active', 'voided'];

// The boutique's expense categories are its operation's categories.
export const EXPENSE_CATEGORIES = CATEGORIES.boutique;

// The periods a report can be asked for.
export const REPORT_PERIODS = ['daily', 'weekly', 'monthly', 'custom'];

// ---- money -----------------------------------------------------------------

// RWF has no coin in use, but the columns are NUMERIC(18,2) like every other
// money column in the system, so arithmetic is done in hundredths: integers,
// which add exactly.
export function toMinor(amount) {
  return Math.round(Number(amount || 0) * 100);
}

export function fromMinor(minor) {
  return Number(minor || 0) / 100;
}

// The figures a sale line produces, from what the cashier typed. One function,
// read by the till on screen (to show the total before sending) and by the API
// (to decide it), so the two cannot disagree by a franc.
export function lineTotals(line) {
  const quantity = Math.max(0, Math.trunc(Number(line.quantity || 0)));
  const unitPrice = toMinor(line.unitPrice);
  const discount = Math.max(0, toMinor(line.discount));
  const gross = unitPrice * quantity;
  const total = Math.max(0, gross - discount);
  return { quantity, unitPrice, discount: Math.min(discount, gross), gross, total };
}

export function saleTotals(lines, saleDiscount = 0) {
  const subtotal = lines.reduce((sum, line) => sum + lineTotals(line).total, 0);
  const discount = Math.min(subtotal, Math.max(0, toMinor(saleDiscount)));
  return { subtotal, discount, total: subtotal - discount };
}
