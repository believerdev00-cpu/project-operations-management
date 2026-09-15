import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { fill, useT } from './i18n.js';

// The pieces every record screen is built from, so an activity and a movement
// read the same way: where the record is in its journey, what happens next and
// who does it, where the money stands, and its details in sections a phone can
// fold away.
//
// None of this invents a state. Each record already carries a workflow status,
// a separate approval decision and a hand-back flag; four overlapping labels
// that readers were left to reconcile. The journey below is worked out from
// those fields, so nothing in the database or the API changes.

// ---- the journey ------------------------------------------------------------

// Activity: asked for -> approved -> under way -> sent for a final check -> done.
// Rejected, Cancelled and On Hold are not steps on the way; they are shown as
// what happened, beside the step the record had reached.
export function activityJourney(activity) {
  const steps = ['requested', 'approved', 'underway', 'handedBack', 'done'];
  const handedBack = Boolean(activity.completionSubmittedAt) && activity.status !== 'Completed';
  let current;
  let side = null;
  switch (activity.status) {
    case 'Draft': current = 0; side = 'draft'; break;
    case 'Pending Approval': current = 0; break;
    case 'Approved':
    case 'Budget Adjusted': current = handedBack ? 3 : 1; break;
    case 'In Progress': current = handedBack ? 3 : 2; break;
    case 'Needs Correction': current = 2; side = 'sentBack'; break;
    case 'Completed': current = 4; break;
    case 'Rejected': current = 0; side = 'refused'; break;
    case 'Cancelled': current = activity.approvalStatus === 'approved' ? 1 : 0; side = 'cancelled'; break;
    case 'On Hold': current = activity.approvalStatus === 'approved' ? 1 : 0; side = 'paused'; break;
    default: current = 0;
  }
  return { steps, current, side };
}

// Movement: asked for -> approved -> money handed over -> under way -> done.
export function movementJourney(movement) {
  const steps = ['requested', 'approved', 'fundsOut', 'underway', 'done'];
  const order = { Draft: 0, 'Pending Approval': 0, Approved: 1, 'Funds Released': 2, 'In Progress': 3, Completed: 4 };
  let current = order[movement.status] ?? 0;
  let side = null;
  if (movement.status === 'Draft') side = 'draft';
  if (movement.status === 'Rejected') side = 'refused';
  if (movement.status === 'Cancelled') {
    side = 'cancelled';
    current = movement.approvalStatus === 'approved' ? 1 : 0;
  }
  return { steps, current, side };
}

// The one-phrase answer to "where is this?", for lists and cards where there is
// no room for the whole journey.
export function journeyLabel(journey, t) {
  if (journey.side) return t(`journey.${journey.side}`);
  return t(`journey.${journey.steps[journey.current]}`);
}

export function journeyTone(journey) {
  if (journey.side === 'refused' || journey.side === 'cancelled') return 'tone-stopped';
  if (journey.side) return 'tone-waiting';
  if (journey.current === journey.steps.length - 1) return 'tone-done';
  // Waiting on somebody's decision or final check, versus work moving along.
  return journey.current === 0 || journey.steps[journey.current] === 'handedBack' ? 'tone-waiting' : 'tone-active';
}

export function Journey({ journey }) {
  const t = useT();
  const stopped = journey.side === 'refused' || journey.side === 'cancelled';
  return <div className={`journey${stopped ? ' journey-stopped' : ''}`}>
    <ol className="journey-steps" aria-label={t('journey.progress')}>
      {journey.steps.map((step, index) => {
        const state = index < journey.current ? 'done' : index === journey.current ? 'current' : 'todo';
        return <li key={step} className={`journey-step journey-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
          <span className="journey-dot" aria-hidden="true">{state === 'done' ? '✓' : index + 1}</span>
          <span className="journey-label">{t(`journey.${step}`)}</span>
        </li>;
      })}
    </ol>
    {journey.side && <p className={`journey-side journey-side-${journey.side}`}>{t(`journey.${journey.side}`)}</p>}
  </div>;
}

// ---- what happens next --------------------------------------------------------

// One box near the top of a record: who the record is waiting on, in a sentence,
// and the button for the next step when the reader is the one to take it.
export function NextStep({ tone = 'info', title, children, actions }) {
  return <section className={`next-step next-step-${tone}`} aria-live="polite">
    <div className="next-step-text">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
    {actions && <div className="next-step-actions">{actions}</div>}
  </section>;
}

// ---- money ----------------------------------------------------------------------

// Approved, spent and left, side by side with a bar: the three numbers the
// budget questions are always about, never on different parts of the screen.
// Before a budget is decided there is nothing to measure spending against, so
// the bar shows what was asked for instead of an empty "left".
export function MoneyBar({ approved, spent, requested, format, label, extra }) {
  const t = useT();
  const hasBudget = approved !== null && approved !== undefined;
  const left = hasBudget ? Math.round((Number(approved) - Number(spent || 0)) * 100) / 100 : null;
  const over = hasBudget && left < 0;
  const share = hasBudget && Number(approved) > 0 ? Math.min(100, Math.round((Number(spent || 0) / Number(approved)) * 100)) : 0;
  return <div className={`money-bar${over ? ' money-over' : ''}`}>
    {label && <span className="money-title">{label}</span>}
    {hasBudget
      ? <div className="money-figures">
        <div><span>{t('money.approved')}</span><strong>{format(approved)}</strong></div>
        <div><span>{t('money.spent')}</span><strong>{format(spent || 0)}</strong></div>
        <div className="money-left"><span>{over ? t('money.over') : t('money.left')}</span><strong>{format(Math.abs(left))}</strong></div>
      </div>
      : <div className="money-figures">
        <div><span>{t('money.askedForLabel')}</span><strong>{format(requested || 0)}</strong></div>
        <div><span>{t('money.approved')}</span><strong className="muted-cell">{t('money.notDecided')}</strong></div>
      </div>}
    {hasBudget && <div className="money-track" role="img" aria-label={fill(t('money.usedShare'), { share })}>
      <span style={{ width: `${over ? 100 : share}%` }} />
    </div>}
    {extra}
  </div>;
}

// ---- sections -------------------------------------------------------------------

// A part of a record that can be folded away. A native <details>, so it opens
// with the keyboard and a screen reader announces it without extra wiring.
export function Section({ id, title, count, defaultOpen = false, children }) {
  return <details id={id} className="record-section" open={defaultOpen || undefined}>
    <summary>
      <span className="record-section-title">{title}</span>
      {count !== undefined && count !== null && <span className="record-section-count">{count}</span>}
    </summary>
    <div className="record-section-body">{children}</div>
  </details>;
}

// Opens a section and brings it into view, for "Record an expense" and similar
// buttons that point further down the record.
export function goToSection(id) {
  const element = document.getElementById(id);
  if (!element) return;
  if (element.tagName === 'DETAILS') element.open = true;
  element.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- choosing files and photos --------------------------------------------------

// The same list the API accepts (server/routes/activities.js, movements.js).
// Offering image/* let a phone pick formats the server then refused.
export const EVIDENCE_ACCEPT = 'image/jpeg,image/png,image/gif,image/webp,image/heic,image/heif,application/pdf';
const ACCEPTED = new Set(EVIDENCE_ACCEPT.split(','));
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 10;

// Two ways in, because on a phone they are different jobs: "Take a photo" opens
// the camera straight away (capture), "Choose files" opens the gallery or file
// manager. Chosen files are listed with a preview and can be removed one by one,
// and anything the server would refuse is caught here first, in plain words.
export function FilePicker({ files, onChange, disabled = false, single = false }) {
  const t = useT();
  const cameraInput = useRef(null);
  const fileInput = useRef(null);
  const hintId = useId();
  const [problem, setProblem] = useState('');

  const previews = useMemo(() => files.map((file) => ({
    file,
    url: file.type.startsWith('image/') && !/heic|heif/.test(file.type) ? URL.createObjectURL(file) : null
  })), [files]);
  useEffect(() => () => previews.forEach((item) => item.url && URL.revokeObjectURL(item.url)), [previews]);

  const add = (list) => {
    const incoming = Array.from(list || []);
    if (!incoming.length) return;
    const refused = incoming.find((file) => !ACCEPTED.has(file.type));
    const tooBig = incoming.find((file) => file.size > MAX_BYTES);
    if (refused) { setProblem(fill(t('files.wrongType'), { name: refused.name })); return; }
    if (tooBig) { setProblem(fill(t('files.tooBig'), { name: tooBig.name })); return; }
    const next = single ? incoming.slice(0, 1) : [...files, ...incoming];
    if (next.length > MAX_FILES) { setProblem(t('files.tooMany')); return; }
    setProblem('');
    onChange(next);
  };

  return <div className="file-picker">
    <div className="file-picker-buttons">
      <button type="button" className="secondary-btn camera-btn" disabled={disabled} onClick={() => cameraInput.current?.click()}>
        <span aria-hidden="true">📷</span> {t('files.takePhoto')}
      </button>
      <button type="button" className="secondary-btn" disabled={disabled} onClick={() => fileInput.current?.click()}>
        {single ? t('files.chooseFile') : t('files.chooseFiles')}
      </button>
    </div>
    <input ref={cameraInput} className="sr-only" type="file" accept="image/*" capture="environment" tabIndex={-1}
      aria-describedby={hintId} onChange={(event) => { add(event.target.files); event.target.value = ''; }} />
    <input ref={fileInput} className="sr-only" type="file" accept={EVIDENCE_ACCEPT} multiple={!single} tabIndex={-1}
      aria-describedby={hintId} onChange={(event) => { add(event.target.files); event.target.value = ''; }} />
    <p id={hintId} className="field-hint">{t('files.hint')}</p>
    {problem && <p className="dialog-error" role="alert">{problem}</p>}
    {previews.length > 0 && <ul className="file-previews">
      {previews.map(({ file, url }, index) => <li key={`${file.name}-${index}`}>
        {url ? <img src={url} alt="" /> : <span className="file-icon" aria-hidden="true">{file.type === 'application/pdf' ? 'PDF' : 'IMG'}</span>}
        <span className="file-preview-name">{file.name}<small>{Math.max(1, Math.round(file.size / 1024))} KB</small></span>
        <button type="button" className="text-btn" disabled={disabled}
          aria-label={fill(t('files.removeNamed'), { name: file.name })}
          onClick={() => onChange(files.filter((_, position) => position !== index))}>{t('action.remove')}</button>
      </li>)}
    </ul>}
  </div>;
}
