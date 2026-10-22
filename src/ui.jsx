import { Component, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { fill, storedLanguage, translate, useT } from './i18n.js';
import { BUSINESS_OPERATIONS, operationName } from '../shared/businessOperations.js';

// Shared interface pieces every screen uses: the error boundary, the page
// address, the dialog that replaces the browser's prompt/confirm, the detail
// view that becomes a full-screen sheet on a phone, and busy tracking.

// ---- error boundary ---------------------------------------------------------

// A rendering error anywhere below this used to unmount the entire React tree
// and leave a white page with no way back short of a reload. Now the failure is
// contained: the reader is told, and can try again or reload.
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error, info) {
    console.error('The interface failed to render:', error, info?.componentStack);
  }

  componentDidUpdate(previous) {
    // Moving to another page is a fresh start for the page that failed.
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    // Rendered outside the language context on purpose -- the context itself may
    // be what failed -- so the stored choice is read directly.
    const language = storedLanguage();
    return <div className="empty-state crash-state" role="alert">
      <strong>{translate(language, 'app.crashed')}</strong>
      <span>{translate(language, 'app.crashedHint')}</span>
      <div className="button-row">
        <button className="secondary-btn" type="button" onClick={() => this.setState({ failed: false })}>
          {translate(language, 'action.retry')}
        </button>
        <button className="primary-btn" type="button" onClick={() => window.location.reload()}>
          {translate(language, 'action.reload')}
        </button>
      </div>
    </div>;
  }
}

// ---- the page address -------------------------------------------------------

// The page lives in the URL hash -- #/activities/ACT-123 -- so the phone's back
// button moves between pages instead of leaving the app, a refresh keeps the
// reader where they were, and a link can be shared. A hash needs no server
// rewrite and no router library; Vercel's SPA fallback is untouched.
function readHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  return { view: parts[0] || '', id: parts[1] || null, rest: parts.slice(2), query: new URLSearchParams(query) };
}

export function buildHash(view, ...parts) {
  const segments = [view, ...parts].filter((part) => part !== null && part !== undefined && part !== '');
  return `#/${segments.map((part) => encodeURIComponent(String(part))).join('/')}`;
}

export function useHashRoute() {
  const [route, setRoute] = useState(readHash);

  useEffect(() => {
    const update = () => setRoute(readHash());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);

  // replace: true swaps the current entry instead of adding one, for moves the
  // back button should skip -- correcting an address that named a page this
  // account cannot open, for instance.
  const navigate = useCallback((hash, { replace = false } = {}) => {
    if (window.location.hash === hash) return;
    if (replace) {
      window.history.replaceState(null, '', hash);
      setRoute(readHash());
    } else {
      window.location.hash = hash;
    }
  }, []);

  return [route, navigate];
}

// ---- viewport ---------------------------------------------------------------

export const PHONE_QUERY = '(max-width: 900px)';

export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false));
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener?.('change', update);
    return () => list.removeEventListener?.('change', update);
  }, [query]);
  return matches;
}

// While an overlay is open the page underneath must not scroll with the
// finger. Counted, so a dialog opened over the drawer does not unlock early.
let scrollLocks = 0;
export function useScrollLock(active) {
  useEffect(() => {
    if (!active) return undefined;
    scrollLocks += 1;
    document.body.classList.add('scroll-locked');
    return () => {
      scrollLocks -= 1;
      if (scrollLocks <= 0) {
        scrollLocks = 0;
        document.body.classList.remove('scroll-locked');
      }
    };
  }, [active]);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Tab and Shift+Tab stay inside an open overlay, and Escape closes it -- the
// behaviour a keyboard or screen-reader user expects of a modal.
export function trapFocus(event, container, onEscape) {
  if (event.key === 'Escape' && onEscape) {
    event.stopPropagation();
    onEscape();
    return;
  }
  if (event.key !== 'Tab' || !container) return;
  const items = [...container.querySelectorAll(FOCUSABLE)].filter((element) => element.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

// ---- dialogs ------------------------------------------------------------------

// The browser's own prompt() and confirm() were used for rejection reasons,
// notes, deletions and -- worst -- new passwords, typed in clear text. Several
// in-app browsers suppress them, which silently cancelled the action. This is
// the same three questions asked in the page itself: a confirmation, a line of
// text, or a new password typed twice and masked.
const DialogContext = createContext(null);

export function DialogProvider({ children }) {
  const [dialog, setDialog] = useState(null);
  const resolver = useRef(null);

  const open = useCallback((options) => new Promise((resolve) => {
    // A second request while one is showing answers the first as cancelled.
    resolver.current?.(options.kind === 'confirm' ? false : null);
    resolver.current = resolve;
    setDialog(options);
  }), []);

  const close = useCallback((value) => {
    resolver.current?.(value);
    resolver.current = null;
    setDialog(null);
  }, []);

  const api = useMemo(() => ({
    confirm: (options) => open({ ...options, kind: 'confirm' }),
    prompt: (options) => open({ ...options, kind: 'prompt' }),
    password: (options) => open({ ...options, kind: 'password' })
  }), [open]);

  return <DialogContext.Provider value={api}>
    {children}
    {dialog && <Dialog key={dialog.title + dialog.kind} dialog={dialog} onClose={close} />}
  </DialogContext.Provider>;
}

export function useDialog() {
  const api = useContext(DialogContext);
  if (!api) throw new Error('useDialog must be used inside DialogProvider.');
  return api;
}

// What an account form sends for a manager who carries every business
// operation. The API translates it into covers_all_sectors (server/lib/http.js).
export const ALL_OPERATIONS = 'all';

// The operations ticked, with one toggled, in the catalogue's order.
// [ALL_OPERATIONS] stands for every operation and is exclusive: ticking it
// clears the others, ticking an operation clears it. With `keepOne` the last
// tick cannot be taken away -- for a saved account, which the API refuses to
// leave with no operation.
export function toggledOperations(selected, id, keepOne) {
  if (id === ALL_OPERATIONS) {
    if (!selected.includes(ALL_OPERATIONS)) return [ALL_OPERATIONS];
    return keepOne ? selected : [];
  }
  const current = selected.filter((item) => item !== ALL_OPERATIONS);
  if (current.includes(id)) return keepOne && current.length === 1 ? selected : current.filter((item) => item !== id);
  return BUSINESS_OPERATIONS.map((operation) => operation.id).filter((item) => item === id || current.includes(item));
}

// One checkbox per business operation, plus "All operations" when `allLabel`
// is given (managers only). Used for a partner's grants and for the operations
// a manager runs -- one person can manage Mining and Agriculture at once.
export function OperationChecks({ selected, language, disabled, label, onChange, allLabel, keepOne = true }) {
  const locked = (id) => keepOne && selected.length === 1 && selected.includes(id);
  return <div className="operation-checks" role="group" aria-label={label}>
    {allLabel && <label className="check-field">
      <input type="checkbox" checked={selected.includes(ALL_OPERATIONS)} disabled={disabled || locked(ALL_OPERATIONS)}
        onChange={() => onChange(toggledOperations(selected, ALL_OPERATIONS, keepOne))} />
      <span>{allLabel}</span>
    </label>}
    {BUSINESS_OPERATIONS.map((operation) => <label key={operation.id} className="check-field">
      <input type="checkbox" checked={selected.includes(operation.id)}
        disabled={disabled || locked(operation.id)}
        onChange={() => onChange(toggledOperations(selected, operation.id, keepOne))} />
      <span>{operationName(operation.id, language)}</span>
    </label>)}
  </div>;
}

// The same minimum the API enforces (server/lib/passwords.js), checked here too
// so the reader hears about it before sending anything.
export const MINIMUM_PASSWORD_LENGTH = 8;

function Dialog({ dialog, onClose }) {
  const t = useT();
  const panel = useRef(null);
  const returnFocus = useRef(typeof document !== 'undefined' ? document.activeElement : null);
  const [value, setValue] = useState(dialog.initialValue || '');
  const [repeat, setRepeat] = useState('');
  // Asked for only when the reader is changing their own password.
  const [current, setCurrent] = useState('');
  const [touched, setTouched] = useState(false);
  const cancelValue = dialog.kind === 'confirm' ? false : null;

  useScrollLock(true);

  useEffect(() => {
    // A text field takes focus when there is one. Otherwise the safe choice
    // does: Enter on a destructive confirmation must not delete anything.
    const target = panel.current?.querySelector('input, textarea')
      || panel.current?.querySelector(dialog.danger ? '.dialog-actions .secondary-btn' : '.dialog-actions .primary-btn');
    target?.focus();
    const previous = returnFocus.current;
    return () => { if (previous && typeof previous.focus === 'function') previous.focus(); };
  }, []);

  const text = value.trim();
  let problem = null;
  if (dialog.kind === 'prompt' && dialog.required && !text) problem = t('dialog.required');
  // A floor on what counts as an answer, for prompts whose answer someone else
  // has to act on -- the reason work is sent back, which the API holds to the
  // same length.
  else if (dialog.kind === 'prompt' && dialog.minLength && text && text.length < dialog.minLength) {
    problem = fill(t('dialog.tooShort'), { count: dialog.minLength });
  }
  if (dialog.kind === 'password') {
    if (dialog.current && !current) problem = t('dialog.required');
    else if (value.trim().length < MINIMUM_PASSWORD_LENGTH) problem = t('dialog.passwordTooShort');
    else if (value !== repeat) problem = t('dialog.passwordMismatch');
  }

  const submit = (event) => {
    event.preventDefault();
    setTouched(true);
    if (problem) return;
    if (dialog.kind === 'confirm') onClose(true);
    else if (dialog.kind === 'password') onClose(dialog.current ? { current, next: value } : value);
    else onClose(text);
  };

  const titleId = 'dialog-title';
  const messageId = dialog.message ? 'dialog-message' : undefined;

  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(cancelValue); }}>
    <form
      ref={panel}
      className="dialog-panel"
      role={dialog.kind === 'confirm' && dialog.danger ? 'alertdialog' : 'dialog'}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={messageId}
      onSubmit={submit}
      onKeyDown={(event) => trapFocus(event, panel.current, () => onClose(cancelValue))}
    >
      <h2 id={titleId}>{dialog.title}</h2>
      {dialog.message && <p id={messageId} className="dialog-message">{dialog.message}</p>}

      {dialog.kind === 'prompt' && <label className="form-field">
        <span>{dialog.label}{dialog.required ? '' : ` (${t('field.optional')})`}</span>
        {dialog.multiline
          ? <textarea rows="3" value={value} placeholder={dialog.placeholder} onChange={(event) => setValue(event.target.value)} />
          : <input value={value} placeholder={dialog.placeholder} onChange={(event) => setValue(event.target.value)} />}
      </label>}

      {dialog.kind === 'password' && <>
        {dialog.current && <label className="form-field">
          <span>{t('auth.currentPassword')}</span>
          <input type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} />
        </label>}
        <label className="form-field">
          <span>{t('dialog.newPassword')}</span>
          <input type="password" autoComplete="new-password" value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
        <label className="form-field">
          <span>{t('dialog.repeatPassword')}</span>
          <input type="password" autoComplete="new-password" value={repeat} onChange={(event) => setRepeat(event.target.value)} />
        </label>
      </>}

      {touched && problem && <p className="dialog-error" role="alert">{problem}</p>}

      <div className="dialog-actions">
        <button className="secondary-btn" type="button" onClick={() => onClose(cancelValue)}>{dialog.cancelLabel || t('action.cancel')}</button>
        <button className={dialog.danger ? 'danger-btn filled' : 'primary-btn'} type="submit">
          {dialog.confirmLabel || t('dialog.confirm')}
        </button>
      </div>
    </form>
  </div>;
}

// ---- detail view --------------------------------------------------------------

// The record a reader opened. On a wide screen it sits in the page, scrolled
// into view with its heading focused -- it used to open above a long register
// while the reader was looking at the row they clicked, and seemed to do
// nothing. On a phone it is a full-screen sheet over the page, closed by its own
// button, Escape, or the back button (the address carries the open record).
export function DetailView({ onClose, label, children }) {
  const t = useT();
  const phone = useMediaQuery(PHONE_QUERY);
  const host = useRef(null);
  useScrollLock(phone);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    if (!phone) element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const heading = element.querySelector('h2');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
  }, [phone, label]);

  return <div
    ref={host}
    className={phone ? 'detail-host detail-sheet' : 'detail-host'}
    role={phone ? 'dialog' : undefined}
    aria-modal={phone ? 'true' : undefined}
    aria-label={label}
    onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}
  >
    {phone && <div className="sheet-bar">
      <button className="sheet-back" type="button" onClick={onClose} aria-label={t('action.close')}>
        <span aria-hidden="true">&larr;</span> {t('action.back')}
      </button>
      <strong>{label}</strong>
    </div>}
    {children}
  </div>;
}

// ---- busy tracking -----------------------------------------------------------

// One action at a time per surface. A second click while the first is still
// with the server is ignored rather than sent -- double-clicking "Create" used
// to create the record twice. The ref answers immediately; the state redraws
// the disabled buttons.
export function useBusy() {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (task) => {
    if (running.current) return undefined;
    running.current = true;
    setBusy(true);
    try {
      return await task();
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);
  return [busy, run];
}

// ---- action icons --------------------------------------------------------------

// A picture beside the words on the buttons that move work forward, so the
// button can be recognised by somebody who reads slowly or not at all: a play
// arrow starts, a camera takes the proof, a tick says finished, a pencil writes
// the day down. Decoration only (aria-hidden); the words stay the label.
const ACTION_ICON_PATHS = {
  start: 'M8 5v14l11-7L8 5Z',
  photo: 'M4 8h3l2-3h6l2 3h3v11H4V8Zm8 9a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  finish: 'M5 12l5 5L20 7',
  write: 'M4 20h4L19 9l-4-4L4 16v4Zm11-15 4 4',
  money: 'M12 3v18M16 7.5c0-1.9-1.8-3-4-3s-4 1.1-4 3 1.8 2.6 4 3 4 1.1 4 3-1.8 3-4 3-4-1.1-4-3',
  open: 'M9 6l6 6-6 6',
  flag: 'M6 21V4m0 0h11l-2.5 4L17 12H6'
};

export function ActionIcon({ name }) {
  const path = ACTION_ICON_PATHS[name];
  if (!path) return null;
  return <svg className="action-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"
    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d={path} /></svg>;
}

// Which picture goes with each next step (the keys nextAction() in journey.jsx
// returns), so every list and record draws the same one.
export const STEP_ICONS = { start: 'start', proof: 'photo', finish: 'finish', check: 'finish', open: 'open', send: 'open', decide: 'open' };

// ---- small shared pieces ----------------------------------------------------

// One label-and-value pair in a `.detail-facts` row. The same six lines lived
// in ActivityReview.jsx, MonthlyPlans.jsx and MovementModule.jsx; a fact is
// the smallest thing every record screen draws, so it belongs here with the
// rest of the shared interface rather than three times over.
export function Fact({ label, value }) {
  return <div className="fact"><span>{label}</span><strong>{value}</strong></div>;
}
