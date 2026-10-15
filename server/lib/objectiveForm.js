// The daily form a manager records an objective through.
//
// The Director agrees "Ore extraction, 500 tonnes" with the Mining manager and
// types that in. The manager should then be asked "Tonnes extracted today",
// with a hint in their own trade's words -- not a generic "Work done" box that
// makes them stop and work out what the system wants. There is a different
// right question for every objective in every operation, and nobody is going to
// hand-write them, so the form is generated from the objective itself.
//
// TWO GENERATORS, ONE SHAPE:
//
//   derive()   reads the objective's own words and unit. Deterministic, instant,
//              needs nothing configured, and is what every objective gets the
//              moment it is written.
//   improve()  asks Claude to write the same shape better, using the operation
//              and the trade's vocabulary. Runs afterwards, in the background.
//
// The second is an improvement on the first and never a prerequisite for it. A
// missing API key, no network, a rate limit or a malformed answer all leave the
// derived form in place, and the manager never sees a difference except in the
// wording. That is the whole reason the derived form is stored first rather
// than generated on demand.
//
// WHAT A FORM CAN AND CANNOT DO: it decides the words, the placeholder, the step
// and whether a photo is asked for. It cannot decide a figure. Progress is
// summed from plan_daily_reports exactly as before -- see objectiveProgress in
// monthly.js -- so nothing generated here can move a percentage. That boundary
// is what makes generating this safe at all.

import Anthropic from '@anthropic-ai/sdk';
// The unit lists and the step rule, shared with the Director's plan form so the
// box the unit is typed into and the box it is recorded through cannot disagree
// about whether half of one is a thing.
import { stepForUnit, unitClass } from '../../shared/units.js';

// Opus 5. The skill's rule is to use the most capable model unless the operator
// asks for another, and this runs a handful of times a month per operation --
// once per objective, in the background -- so the cost is negligible and the
// wording is what the manager lives with all month.
const DEFAULT_MODEL = 'claude-opus-5';

// Every field the rest of the system will read. Anything outside this list is
// dropped, whoever produced it.
const TEXT_LIMITS = {
  amountLabel: 60,
  amountHint: 160,
  placeholder: 20,
  notesLabel: 60,
  notesHint: 160,
  evidenceLabel: 60
};

// ---- the deterministic reading -------------------------------------------

// The question is generated as a KEY, never as a sentence.
//
// shared/strings.js holds all four languages; a sentence written here would be
// English, and the client reads a stored label in preference to a translated
// one. That is exactly what went wrong: every label on the daily form was
// translated except the one the manager typed into. Only improve() -- which a
// deployment opts into by configuring a key -- stores wording of its own.
const ASK_KEYS = {
  people: 'form.ask.people',
  trips: 'form.ask.trips',
  unit: 'form.ask.unit',
  count: 'form.ask.count'
};

// One-tap amounts, so an ordinary day is a button and not typing.
//
// Derived rather than left to the model, because without ANTHROPIC_API_KEY
// improve() never runs and quickAmounts was hard-coded empty -- the buttons on
// the daily form were unreachable code on every deployment that runs with no
// external service, which is the deployment this is built for.
//
// Snapped to a round rung so the buttons read like amounts a person would say:
// a quarter and a half of the month's target, plus 1 for the day that only
// managed one of something.
const LADDER = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

function roundDown(value) {
  let best = 0;
  for (const rung of LADDER) if (rung <= value) best = rung;
  return best;
}

function quickAmountsFor(targetQuantity) {
  const target = Number(targetQuantity);
  if (!Number.isFinite(target) || target <= 0) return [];
  return [...new Set([1, roundDown(target / 4), roundDown(target / 2)])]
    .filter((amount) => amount > 0 && amount <= target)
    .sort((left, right) => left - right)
    .slice(0, 3);
}

// The form anybody gets without a model involved.
//
// It decides the shape of the question and leaves the words to the reader's own
// language. Claude's job below is to do better than this, not to replace it.
export function derive(objective) {
  const unit = String(objective?.targetUnit || '').trim();
  const counted = objective?.targetQuantity !== null && objective?.targetQuantity !== undefined;

  return {
    // Translated on the client, with {unit} filled in where the question needs
    // it. No English sentence is stored.
    amountKey: ASK_KEYS[unitClass(unit)],
    amountHintKey: 'form.hint.onlyToday',
    placeholder: '0',
    step: stepForUnit(unit, objective?.targetQuantity),
    // notesLabel, notesHint and evidenceLabel are deliberately absent. The
    // client already falls back to plan.dayNotes, plan.dayNotesHint and
    // plan.dayProof, which are translated, so storing an English copy of them
    // here would only shadow four languages with one.
    evidenceExpected: false,
    quickAmounts: counted ? quickAmountsFor(objective.targetQuantity) : []
  };
}

// ---- validation ------------------------------------------------------------

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  // Collapsed and cut: this goes straight into a label, and a model that
  // returns a paragraph must not be able to stretch the form.
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

// Whatever a model returns is treated as a suggestion, not as data.
//
// Every field is re-validated against the derived form and anything missing,
// wrong-typed, empty or out of range falls back to it. A model cannot introduce
// a field, blank a label, or set a step of zero that would make the input
// unusable -- the worst it can do is fail to improve on what was already there.
export function validate(candidate, objective) {
  const base = derive(objective);
  if (!candidate || typeof candidate !== 'object') return base;

  const amountLabel = cleanText(candidate.amountLabel, TEXT_LIMITS.amountLabel);
  const notesLabel = cleanText(candidate.notesLabel, TEXT_LIMITS.notesLabel);

  // A step must be a positive number a browser will accept; anything else is
  // the derived one.
  const step = Number(candidate.step);
  const safeStep = Number.isFinite(step) && step > 0 && step <= 1000 ? step : base.step;

  // Quick amounts are a convenience, so they are held to the target: offering
  // "500" on an objective with 12 left is worse than offering nothing. At most
  // three, positive, sorted, de-duplicated.
  const ceiling = objective?.targetQuantity === null || objective?.targetQuantity === undefined
    ? null
    : Number(objective.targetQuantity);
  const quickAmounts = Array.isArray(candidate.quickAmounts)
    ? [...new Set(candidate.quickAmounts
      .map(Number)
      .filter((value) => Number.isFinite(value) && value > 0 && (ceiling === null || value <= ceiling)))]
      .sort((left, right) => left - right)
      .slice(0, 3)
    : [];

  const amountHint = cleanText(candidate.amountHint, TEXT_LIMITS.amountHint);
  const notesHint = cleanText(candidate.notesHint, TEXT_LIMITS.notesHint);
  const evidenceLabel = cleanText(candidate.evidenceLabel, TEXT_LIMITS.evidenceLabel);

  return {
    // The derived keys always travel with the form. A model that returns
    // nothing usable therefore leaves the manager a translated question rather
    // than an empty label.
    amountKey: base.amountKey,
    amountHintKey: base.amountHintKey,
    // A model's own wording wins over the key where it gave any -- that is what
    // improve() is for. Each of these is written only when it is non-empty, so
    // an absent one falls through to the translated string on the client
    // instead of shadowing it with "".
    ...(amountLabel ? { amountLabel } : {}),
    ...(amountHint ? { amountHint } : {}),
    ...(notesLabel ? { notesLabel } : {}),
    ...(notesHint ? { notesHint } : {}),
    ...(evidenceLabel ? { evidenceLabel } : {}),
    placeholder: cleanText(candidate.placeholder, TEXT_LIMITS.placeholder) || base.placeholder,
    step: safeStep,
    evidenceExpected: candidate.evidenceExpected === true,
    // Offering none is a model declining to guess, not an instruction to take
    // the buttons away: the derived amounts stand.
    quickAmounts: quickAmounts.length ? quickAmounts : base.quickAmounts
  };
}

// ---- the model ------------------------------------------------------------

// Configured, or not. The system is self-hosted and runs with no external
// service at all (see CLAUDE.md), so this stays entirely optional: without a
// key nothing is sent anywhere and every objective keeps its derived form.
export function aiConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

const FORM_SCHEMA = {
  type: 'object',
  properties: {
    amountLabel: { type: 'string', description: 'The question asking how much was done today, in this trade\'s words. E.g. "Tonnes extracted today", "Inspections completed today".' },
    amountHint: { type: 'string', description: 'One short sentence under the amount field telling the manager to record only today\'s actual work.' },
    placeholder: { type: 'string', description: 'Placeholder for the amount box. Usually "0".' },
    step: { type: 'number', description: 'Smallest sensible increment. 1 for things that are counted, 0.01 for measured quantities.' },
    notesLabel: { type: 'string', description: 'The question asking what happened today.' },
    notesHint: { type: 'string', description: 'One short sentence suggesting what is worth noting for this kind of work.' },
    evidenceLabel: { type: 'string', description: 'What the photos would show for this work. E.g. "Photos of the cleared land".' },
    evidenceExpected: { type: 'boolean', description: 'True only when a photograph is the natural proof for this kind of work.' },
    quickAmounts: {
      type: 'array',
      items: { type: 'number' },
      description: 'Up to three common amounts for one day of this work, to offer as one-tap buttons. Empty when no amount is typical.'
    }
  },
  required: [
    'amountLabel', 'amountHint', 'placeholder', 'step',
    'notesLabel', 'notesHint', 'evidenceLabel', 'evidenceExpected', 'quickAmounts'
  ],
  additionalProperties: false
};

const SYSTEM = `You write the one daily form a field manager fills in to record work.

The organisation runs three primary operations -- Mining, Agriculture, Farming --
and a coordination function, Movement & Facilitation, which handles transport and
logistics for the other three.

Before each month the Director and the managers agree what each operation will
achieve. The Director types that in as objectives, each with a target and a unit.
Your job is to turn ONE objective into the form its manager fills in at the end of
a working day.

Rules:
- Ask for the amount in the words of that trade. "Tonnes extracted today" beats
  "Work done". Never invent a unit -- use the one the Director set.
- The manager records ONLY what they actually did that day. Never ask for a
  percentage, a total, a forecast, or anything the system can work out itself.
- Keep every label under about six words and every hint to one short sentence.
- Write plainly, for somebody typing on a phone at the end of a long day. No
  jargon the manager would not use themselves, no encouragement, no exclamation.
- quickAmounts are one-tap buttons for a typical day of this work. Offer them
  only when a typical day really has a usual size, and never more than the
  target.`;

function prompt(objective, operationName) {
  const target = objective?.targetQuantity === null || objective?.targetQuantity === undefined
    ? 'no countable target -- the manager records what they did in words'
    : `${objective.targetQuantity} ${objective.targetUnit || ''}`.trim();
  const supports = objective?.supportsOperation
    ? `\nThis is coordination work supporting: ${objective.supportsOperation}`
    : '';
  return `Operation: ${operationName}
Objective: ${objective?.title || ''}
Target for the month: ${target}${supports}

Write the daily form for this objective.`;
}

// Ask Claude for a better form than the derived one.
//
// Returns null rather than throwing on any failure -- no key, no network, a rate
// limit, a refusal, a malformed answer. The caller keeps whatever it had. This
// runs in the background after the plan is already saved, so there is nothing
// for an error to interrupt and nobody waiting on it.
export async function improve(objective, operationName, options = {}) {
  if (!aiConfigured()) return null;

  const client = options.client || new Anthropic();
  try {
    const response = await client.messages.create({
      model: process.env.GISUMA_AI_MODEL || DEFAULT_MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      // Structured outputs: the answer is the form, already shaped, so there is
      // no prose to parse and no chance of a stray sentence around the JSON.
      output_config: {
        format: { type: 'json_schema', schema: FORM_SCHEMA },
        // A form is a small, well-specified piece of writing; low effort keeps
        // it quick and cheap without costing anything that shows up in a label.
        effort: 'low'
      },
      messages: [{ role: 'user', content: prompt(objective, operationName) }]
    });

    // A safety decline is a normal outcome to handle, not an exception.
    if (response.stop_reason === 'refusal') return null;

    const block = response.content.find((item) => item.type === 'text');
    if (!block) return null;
    let parsed;
    try { parsed = JSON.parse(block.text); } catch { return null; }
    return validate(parsed, objective);
  } catch (error) {
    // Logged, never surfaced: the Director's month saved a long time ago.
    console.warn('[objective-form] could not generate a form:', error?.message || error);
    return null;
  }
}
