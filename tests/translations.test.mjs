// Checks the interface translations are complete and actually used.
//
//   1. Every key is translated into all four languages.
//   2. Every t('key') the app calls exists in the dictionary.
//   3. Every key in the dictionary is used somewhere (an unused key is either
//      dead weight or a sign a replacement was missed).
//   4. No user-visible English is left hard-coded in the JSX.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The dictionary itself, from shared/ -- where it lives because the API reads
// it too (an exported report is written in its reader's language). Imported
// from there rather than through src/i18n.js, which is the browser's React
// layer over it and would pull React into this test for nothing.
import * as i18n from '../shared/strings.js';
import * as ops from '../shared/businessOperations.js';
import { DAY_COLUMNS } from '../shared/dailyReport.js';
import * as boutique from '../shared/boutique.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};

// ui.jsx holds the shared error boundary and dialogs; left off this list, every
// key only they use was reported as unused, and their JSX went unchecked.
const FILES = ['App.jsx', 'ui.jsx', 'journey.jsx', 'Home.jsx', 'MovementModule.jsx', 'ActivityReview.jsx', 'PartnerPortal.jsx', 'ExternalPartners.jsx', 'MonthlyPlans.jsx', 'ExpensePanel.jsx', 'Organization.jsx', 'Boutique.jsx', 'Progress.jsx']
  .map((name) => path.join(root, 'src', name));

const sources = Object.fromEntries(FILES.map((file) => [path.basename(file), fs.readFileSync(file, 'utf8')]));

// The API reads the same dictionary (shared/strings.js): a report exported as a
// PDF or a spreadsheet is written in the language its reader chose, so those
// files call translate() with keys of their own. They are scanned for the key
// checks -- a key only the exports use would otherwise be reported as unused,
// and a typo in one would be caught by nobody -- but NOT for the hard-coded
// English check below, which is about JSX.
const SERVER_FILES = ['routes/reports.js'].map((name) => path.join(root, 'server', name));
const serverSources = Object.fromEntries(
  SERVER_FILES.map((file) => [path.basename(file), fs.readFileSync(file, 'utf8')])
);
const allSource = [...Object.values(sources), ...Object.values(serverSources)].join('\n');

console.log('\n=== 1. every key is translated into all four languages ===');
const gaps = i18n.missingTranslations();
check(`all ${i18n.translationKeys().length} keys have en/rw/fr/sw`, gaps.length === 0,
  gaps.slice(0, 10).map((g) => `${g.key}: missing ${g.missing.join(',')}`).join('\n        '));

console.log('\n=== 2. every key the app calls exists ===');
const defined = new Set(i18n.translationKeys());
// Literal calls: t('some.key')
const literal = [...allSource.matchAll(/\bt\('([^']+)'\)/g)].map((m) => m[1]);
const undefinedKeys = [...new Set(literal)].filter((key) => !defined.has(key));
check(`${new Set(literal).size} literal keys all defined`, undefinedKeys.length === 0, undefinedKeys.join(', '));

// Template keys: t(`prefix.${expr}`), and the same thing built into a variable
// first (`const key = \`trail.${field}\``), which a t(...)-anchored pattern
// would miss and report as an unused family.
const templates = [...allSource.matchAll(/`([a-zA-Z][a-zA-Z.]*)\.\$\{/g)].map((m) => m[1]);
// Keys built by gluing a value straight onto a dotted name, with no dot
// between: t(`form.priority${level}`) reaches form.priorityLow/Medium/High.
// Missing this pattern let three keys still in use be reported -- and
// deleted -- as unused, and the screen printed "form.priorityMedium".
const gluedTemplates = [...allSource.matchAll(/`([a-zA-Z]+\.[a-zA-Z.]*[a-zA-Z])\$\{/g)].map((m) => m[1]);
const badPrefixes = [...new Set(templates)].filter(
  (prefix) => !i18n.translationKeys().some((key) => key.startsWith(`${prefix}.`))
);
check(`${new Set(templates).size} template prefixes all resolve`, badPrefixes.length === 0, badPrefixes.join(', '));

// The dynamic families must cover every value the app can produce.
const FAMILIES = {
  'status.': ['Draft', 'Pending Approval', 'Approved', 'Rejected', 'In Progress', 'Completed', 'Cancelled',
    'Budget Adjusted', 'Needs Correction', 'On Hold', 'Funds Released', 'On Track', 'In Review', 'Delayed', 'Healthy'],
  'role.': ['super-admin', 'general-manager', 'manager', 'staff', 'partner'],
  'approval.': ['pending', 'approved', 'rejected'],
  'partners.': ['active', 'suspended', 'revoked'],
  'mtype.': ['Staff', 'Equipment', 'Materials', 'Field Operation', 'Other'],
  'ekind.': ['Receipt', 'Invoice', 'Fuel Slip', 'Delivery Note', 'Hotel Receipt', 'Transport Ticket', 'Payment Proof', 'Photograph', 'Other'],
  'estatus.': ['Pending', 'Partial', 'Complete'],
  'cost.': ['transport', 'fuel', 'accommodation', 'meals', 'handling', 'other'],
  'pmethod.': ['Cash', 'Bank Transfer', 'Mobile Money', 'Cheque', 'Credit', 'Other'],
  // Glued, not dotted: t(`form.priority${level}`) in MonthlyPlans.jsx.
  'form.priority': ['Low', 'Medium', 'High'],
  'monthly.planStatus.': ['Draft', 'Confirmed', 'In Progress', 'Completed', 'Closed'],
  'day.': DAY_COLUMNS,
  'monthend.status.': ['Submitted', 'Accepted', 'Returned'],
  // Every event the server can write a notification for (NOTIFICATION_KINDS in
  // server/db/monthlySchema.js) needs a sentence in every language.
  'notice.kind.': ['plan_assigned', 'plan_changed', 'change_requested', 'report_submitted', 'report_accepted',
    'report_returned', 'work_submitted', 'work_to_check', 'work_approved', 'work_returned', 'partner_comment',
    'team_added', 'partner_shared', 'boutique_approval_requested', 'boutique_approval_decided',
    'boutique_report_submitted', 'boutique_issue_raised', 'boutique_submission_decided', 'boutique_low_stock'],
  // The Boutique Manager's submissions to the Director.
  'btq.subKind.': ['report', 'incident'],
  'btq.subStatus.': ['submitted', 'accepted', 'returned'],
  // The boutique (shared/boutique.js): every list a screen renders through a
  // template key, so a value added there without its words fails here.
  'btq.tab.': ['overview', 'sell', 'sales', 'products', 'stock', 'count', 'suppliers', 'cash', 'expenses', 'books', 'reports', 'approvals', 'history'],
  'btq.type.': boutique.PRODUCT_TYPES,
  'btq.method.': boutique.ALL_BOUTIQUE_PAYMENT_METHODS,
  'btq.kind.': boutique.STOCK_MOVEMENT_KINDS,
  'btq.approval.': boutique.APPROVAL_STATUSES,
  'btq.poStatus.': boutique.PURCHASE_STATUSES,
  'btq.saleStatus.': boutique.SALE_STATUSES,
  'btq.returnKind.': boutique.RETURN_KINDS,
  'btq.sessionStatus.': boutique.SESSION_STATUSES,
  'btq.cashKind.': boutique.CASH_MOVEMENT_KINDS,
  'btq.expenseStatus.': boutique.EXPENSE_STATUSES,
  'btq.itemStatus.': ['active', 'archived'],
  'btq.kindHint.': boutique.ADJUSTMENT_KINDS,
  'btq.reasonExample.': boutique.ADJUSTMENT_KINDS,
  'btq.stockState.': ['ok', 'low', 'out'],
  'btq.countStatus.': boutique.SHELF_COUNT_STATUSES,
  // UNIT_SUGGESTIONS in src/Boutique.jsx, offered by the 'Counted in' box.
  'btq.unit.': ['kg', 'g', 'litres', 'pieces', 'bottles', 'packets', 'bags', 'boxes', 'dozens', 'sacks', 'trays'],
  'btq.period.': boutique.REPORT_PERIODS,
  'btq.outcome.': ['approved', 'refused', 'accepted', 'returned'],
  // The organisation (server/db/organizationSchema.js): every trail action.
  'org.action.': ['team_created', 'team_updated', 'team_archived', 'team_restored', 'member_added', 'member_removed',
    'leader_changed', 'reporting_changed', 'partner_profile_changed', 'partner_projects_changed',
    'account_suspended', 'account_reactivated', 'account_deleted'],
  'progress.missing.': ['no_plans', 'no_objectives', 'no_countable'],
  'plan.objectiveState.': ['notStarted', 'inProgress', 'done', 'overdue']
};
for (const [prefix, values] of Object.entries(FAMILIES)) {
  const missing = values.filter((value) => !defined.has(`${prefix}${value}`));
  check(`  ${prefix}* covers every value the app produces`, missing.length === 0, missing.join(', '));
}

console.log('\n=== 3. every defined key is used ===');
const usedSomewhere = (key) => {
  if (allSource.includes(`'${key}'`)) return true;
  // Reached through a template: t(`status.${...}`) covers every status.* key.
  const prefix = key.slice(0, key.lastIndexOf('.') + 1);
  if (templates.some((template) => `${template}.` === prefix)) return true;
  return gluedTemplates.some((template) => key.startsWith(template) && key.length > template.length);
};
const unused = i18n.translationKeys().filter((key) => !usedSomewhere(key));
check(`no unused keys`, unused.length === 0, unused.join(', '));

console.log('\n=== 4. no hard-coded English left in the interface ===');
// Places a user-visible string can hide in this codebase.
const PATTERNS = [
  [/<th>[A-Za-z][^<{]{2,}<\/th>/g, 'table header'],
  [/placeholder="[A-Za-z][^"]{3,}"/g, 'placeholder'],
  [/\blabel="[A-Za-z][^"]{2,}"/g, 'Field/Metric label'],
  [/\btitle="[A-Za-z][^"]{2,}"/g, 'panel title'],
  [/\bsubtitle="[A-Za-z][^"]{2,}"/g, 'panel subtitle'],
  [/\bempty="[A-Za-z][^"]{2,}"/g, 'empty state'],
  [/\baction="[A-Za-z][^"]{2,}"/g, 'panel action'],
  [/<span>[A-Z][a-z][^<{]{3,}<\/span>/g, 'field caption'],
  [/>[A-Z][a-z][^<>{}]{3,}<\/button>/g, 'button']
];
// Legitimately untranslated: currency codes, the brand, and file-format names.
const ALLOWED = /^(RWF|USD|CDF|Gisuma|JPG|PNG|PDF|Excel)\b/;
for (const [name, source] of Object.entries(sources)) {
  const hits = [];
  for (const [pattern, kind] of PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const text = match[0].replace(/<[^>]*>/g, '').replace(/^\w+="|"$/g, '').trim();
      if (text && !ALLOWED.test(text)) hits.push(`${kind}: ${text}`);
    }
  }
  check(`${name} has no hard-coded UI strings`, hits.length === 0, hits.slice(0, 8).join('\n        '));
}

console.log('\n=== 5. the four business operations translate ===');
for (const operation of ops.BUSINESS_OPERATIONS) {
  const names = i18n.LANGUAGE_CODES.map((code) => ops.operationName(operation.id, code));
  check(`  ${operation.name}: ${names.join(' / ')}`,
    names.every(Boolean) && new Set(names).size >= 3);
}

console.log('\n=== 6. a sample renders in every language ===');
for (const code of i18n.LANGUAGE_CODES) {
  const sample = ['nav.approvalQueue', 'form.addProject', 'movement.costBreakdown', 'report.budgetSummary']
    .map((key) => i18n.translate(code, key));
  check(`  ${code}: ${sample.join(' | ')}`, sample.every((text) => text && !text.includes('.')));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
