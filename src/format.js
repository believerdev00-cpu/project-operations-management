// Display formatting shared by every screen.
//
// `formatUsd` and `todayLocal` were each written out twice -- the same function
// body in ActivityReview.jsx and MonthlyPlans.jsx, and in Home.jsx and
// MonthlyPlans.jsx respectively. Identical copies are the state just before a
// drift: somebody fixes the rounding or the timezone in one screen, the other
// keeps the old answer, and the same figure reads differently depending on
// which page you opened. The rule everywhere else in this codebase -- one
// definition, read by every caller -- applies to money and dates too.
//
// `formatDate` is deliberately NOT here. There are four of them and they do
// not agree: ActivityReview's takes (value), MonthlyPlans' and PartnerPortal's
// take (value, language). Merging them is a behaviour change per screen, not a
// move, so they stay where they are until each is checked.

// Money is held and shown in USD, to the cent, with the sign in front of the
// symbol so a negative balance reads "-$40.00" and not "$-40.00".
export function formatUsd(value) {
  const amount = Number(value || 0);
  const digits = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(amount));
  return `${amount < 0 ? '-' : ''}$${digits}`;
}

// Rwandan francs, whole: "RWF 15,000". The boutique (Project 5) trades in
// RWF and shows every figure this way; App.jsx keeps a private copy for the
// trips register's RWF column, which predates this one.
export function formatRwf(value) {
  const amount = Number(value || 0);
  const digits = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.abs(amount));
  return `${amount < 0 ? '-' : ''}RWF ${digits}`;
}

// Today as the `yyyy-mm-dd` a date input expects, in the reader's OWN
// timezone. `new Date().toISOString().slice(0, 10)` is UTC, which hands a
// manager in Kigali (UTC+2) yesterday's date every evening after 22:00 -- and
// a day of work filed against the wrong date is a day the month-end report
// cannot explain.
export function todayLocal() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// A date written for a reader, in their own language: "05/04/2098" in the
// locale's own order, so nobody has to guess whether 4/5 is April 5th or May
// 4th. An unparseable value reads as an em dash rather than "Invalid Date".
//
// There are two other `formatDate`s in this codebase, in ActivityReview.jsx
// and PartnerPortal.jsx, and they are NOT this function: ActivityReview's
// takes no language, and PartnerPortal's echoes the raw text back when it
// cannot parse it instead of an em dash. Those differences are behaviour per
// screen, so they were left where they are rather than quietly merged here.
// One way to write a date on every screen: "23 Oct 2026", day first, the
// month as a word in the reader's language. Screens used to mix "10/21/2026",
// "October 23, 2026" and "23 Oct 2026" -- and an all-number date reads as the
// 10th of the 21st month to anybody used to day-first dates, which is how
// dates are written in Rwanda. English is given the day-first form for the
// same reason; the other three languages write it that way already.
export const DATE_STYLE = { day: 'numeric', month: 'short', year: 'numeric' };

export function dateLocale(language) {
  return language === 'en' ? 'en-GB' : language;
}

// A moment as people say it: "25 Oct 2026, 23:55" -- the same day format as
// formatDate, the time without seconds. Used wherever a screen said when
// something happened; toLocaleString(language) printed "10/25/2026, 11:55:27
// PM" in English and differently ordered digits in every other language.
export function formatDateTime(value, language) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(dateLocale(language), { ...DATE_STYLE, hour: '2-digit', minute: '2-digit' });
}

// The time of day alone, for a line that already names the date.
export function formatTime(value, language) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(dateLocale(language), { hour: '2-digit', minute: '2-digit' });
}

export function formatDate(value, language) {
  if (!value) return '—';
  const [year, month, day] = String(value).slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return '—';
  return new Date(year, month - 1, day).toLocaleDateString(dateLocale(language), DATE_STYLE);
}
