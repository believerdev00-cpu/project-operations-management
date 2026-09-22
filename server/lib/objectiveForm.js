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

function titleCase(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// A step small enough for the unit. Counting things (inspections, trips, cases,
// systems) steps by one, because half an inspection is not a thing anybody
// records; measured quantities (hectares, tonnes) step by a hundredth.
const WHOLE_UNITS = [
  'inspection', 'inspections', 'trip', 'trips', 'case', 'cases', 'visit', 'visits',
  'session', 'sessions', 'system', 'systems', 'machine', 'machines', 'activity',
  'activities', 'report', 'reports', 'person', 'people', 'unit', 'units',
  'delivery', 'deliveries', 'movement', 'movements', 'service', 'services'
];

function stepFor(unit) {
  return WHOLE_UNITS.includes(String(unit || '').trim().toLowerCase()) ? 1 : 0.01;
}

// The form anybody gets without a model involved.
//
// Deliberately plain: it uses the Director's own unit and title rather than
// inventing vocabulary, because a wrong guess reads worse than a neutral
// question. Claude's job below is to do better than this, not to replace it.
export function derive(objective) {
  const unit = String(objective?.targetUnit || '').trim();
  const title = String(objective?.title || '').trim();
  const counted = objective?.targetQuantity !== null && objective?.targetQuantity !== undefined;

  return {
    // "Hectares done today" / "Done today" when the month is not counted.
    amountLabel: unit ? `${titleCase(unit)} done today` : 'Done today',
    amountHint: counted && unit
      ? `Only what was actually finished today, in ${unit}.`
      : 'Only what was actually finished today.',
    placeholder: '0',
    step: stepFor(unit),
    notesLabel: 'What happened today?',
    notesHint: title ? `Anything worth knowing about "${title}" today.` : 'Anything worth knowing about today.',
    evidenceLabel: 'Photos',
    evidenceExpected: false,
    quickAmounts: []
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

  return {
    amountLabel: amountLabel || base.amountLabel,
    amountHint: cleanText(candidate.amountHint, TEXT_LIMITS.amountHint) || base.amountHint,
    placeholder: cleanText(candidate.placeholder, TEXT_LIMITS.placeholder) || base.placeholder,
    step: safeStep,
    notesLabel: notesLabel || base.notesLabel,
    notesHint: cleanText(candidate.notesHint, TEXT_LIMITS.notesHint) || base.notesHint,
    evidenceLabel: cleanText(candidate.evidenceLabel, TEXT_LIMITS.evidenceLabel) || base.evidenceLabel,
    evidenceExpected: candidate.evidenceExpected === true,
    quickAmounts
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
