import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MovementModule from './MovementModule.jsx';
import PartnerPortal from './PartnerPortal.jsx';
import ExternalPartners from './ExternalPartners.jsx';
import MonthlyPlans from './MonthlyPlans.jsx';
import { LANGUAGES, LanguageContext, displayLanguage, fill, setDisplayLanguage, useI18n, useLanguage, useT } from './i18n.js';
import { BUSINESS_OPERATIONS, operationName } from '../shared/businessOperations.js';
import ActivityReview, {
  ACTIVITY_STATUSES, approvalTone, approverName, categoryLabel,
  deadlineNote, formatDate, formatUsd, statusTone
} from './ActivityReview.jsx';
import {
  DetailView, DialogProvider, ErrorBoundary, MINIMUM_PASSWORD_LENGTH, PHONE_QUERY, buildHash, trapFocus, useBusy, useDialog,
  useHashRoute, useMediaQuery, useScrollLock
} from './ui.jsx';
import { activityJourney, formatLocal, journeyLabel, journeyTone } from './journey.jsx';
import Home, { DecisionList } from './Home.jsx';

// The category presets offered per business operation. Keep in step with
// CATEGORIES in server/data/seedData.js, which is what the API validates
// against. The operations themselves -- their ids and their names in all four
// languages -- come from shared/businessOperations.js, so this file never
// restates what an operation is called.
const CATEGORIES = {
  farming: [
    'Land preparation', 'Planting and sowing', 'Irrigation', 'Fertilizer and inputs',
    'Pest and disease control', 'Livestock and animal feed', 'Harvesting',
    'Storage and preservation', 'Farm equipment and tools', 'Farm labour'
  ],
  mining: [
    'Exploration and survey', 'Extraction', 'Haulage', 'Washing and sorting',
    'Processing', 'Site preparation and access roads', 'Machinery and equipment',
    'Safety and protective equipment', 'Licenses and permits', 'Mining labour'
  ],
  agriculture: [
    'Seeds and seedlings', 'Land preparation', 'Planting', 'Crop maintenance',
    'Fertilizer and agro-inputs', 'Harvesting', 'Post-harvest handling',
    'Storage and warehousing', 'Transport to market', 'Agricultural labour'
  ],
  movement: [
    'Vehicle hire', 'Fuel and lubricants', 'Freight and haulage', 'Border clearance',
    'Permits and licenses', 'Escort and security', 'Warehousing and handling',
    'Loading and offloading', 'Travel and allowances', 'Documentation and administration'
  ]
};

const sectors = BUSINESS_OPERATIONS.map((operation) => ({
  ...operation,
  categories: CATEGORIES[operation.id] || []
}));

const OTHER_CATEGORY = 'Other (specify)';

// The working area a manager who covers every operation is filed under. It is
// not an operation id -- the API translates it into "no single area, covers all"
// on the account row -- so it must never be looked up in `sectors`.
const ALL_OPERATIONS = 'all';
const PROJECT_STATUSES = ['On Track', 'In Review', 'Delayed', 'Healthy'];

function categoriesForSector(sectorId) {
  return sectors.find((sector) => sector.id === sectorId)?.categories || [];
}

// Rows store the operation id ('movement'), which is not what a reader should
// see: they get "Movements & Facilitation", in their own language.
function sectorName(sectorId) {
  return operationName(sectorId, displayLanguage());
}

// Budget, spent and progress are no longer typed: they come from the project's
// activities (see PROJECT_FIGURES in server/index.js).
const emptyProject = { name: '', sector: 'agriculture', location: '', owner: '', status: 'On Track', category: '', managerId: '' };
// One form, two ways round. A manager raises an activity, which is born
// awaiting the Director's review, so it carries no status and no "approved"
// tick for the requester to set. The Director instead hands work out: the last
// three fields are theirs, and what they assign is funded from the start.
// Quantity starts at 1: most requests are for one thing, and it was one more
// box every manager had to fill before the form would send.
const emptyActivity = { projectId: '', sector: 'agriculture', categoryChoice: '', category: '', activity: '', description: '', materials: '', quantity: '1', costUsd: '', signed: false, assignedTo: '', deadline: '', instructions: '' };
// The statuses that mean assigned work is still on the manager's desk. Closed
// and refused records drop out of their queue.
const OPEN_ASSIGNMENT_STATUSES = ['Pending Approval', 'Approved', 'Budget Adjusted', 'In Progress', 'Needs Correction'];
const emptyApproval = { title: '', sector: 'agriculture', amount: '', owner: '', priority: 'Medium', requestedBy: '', justification: '' };
const emptyAccount = { username: '', name: '', password: '', role: 'manager', sector: '', managerId: '' };
const emptyRegister = { total: 0, roleCounts: {}, unassigned: 0, users: [] };
const emptyQueue = { activities: [], movements: [], total: 0 };
const emptyPartnerRegister = { total: 0, active: 0, byOperation: {}, partners: [] };
// Used only until the Director's reference rate has loaded, so an equivalent is
// never shown as zero while the page is still arriving.
const fallbackRate = { rwfPerUsd: 1450, cdfPerUsd: 2850 };

// Roles are stored as slugs; these are the words the Director reads.
function roleName(role, t) {
  return t(`role.${role}`);
}

function formatNumber(value) {
  return new Intl.NumberFormat(displayLanguage(), { maximumFractionDigits: 2 }).format(Number(value || 0));
}

function formatRwf(value) {
  return `RWF ${new Intl.NumberFormat(displayLanguage(), { maximumFractionDigits: 0 }).format(Number(value || 0))}`;
}

function formatShortDate(value) {
  return value ? new Date(value).toLocaleDateString(displayLanguage()) : '—';
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

// Report pickers deal in calendar days, so the local date is assembled by hand.
// toISOString() would convert to UTC first and hand back yesterday for anyone
// east of Greenwich after midnight.
function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// A custom period opens on the month so far, which is the range most often
// wanted, and is the one starting point that is never an empty report. Built
// when the section first needs it, not when the file loads -- a tab left open
// overnight would otherwise keep offering yesterday.
function defaultReportRange() {
  const today = todayIso();
  return { week: today, month: today.slice(0, 7), start: `${today.slice(0, 7)}-01`, end: today };
}

const REPORT_MODES = [['weekly', 'report.weekly'], ['monthly', 'report.monthly'], ['custom', 'report.custom']];

// The register is read a page at a time, filtered on the server, so an older
// activity is never silently missing because it fell outside the newest 100.
const REGISTER_PAGE = 50;
const emptyRegisterPage = { items: [], hasMore: false, loading: true, failed: false };

// ---- browser storage ---------------------------------------------------------

// Storage can be blocked (private windows, strict settings) or hold something
// unreadable. Either used to throw during the first render and leave a blank
// page; now it just means nobody is remembered.
function readStorage(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeStorage(key, value) {
  try { localStorage.setItem(key, value); } catch { /* not remembered, still works */ }
}

function removeStorage(key) {
  try { localStorage.removeItem(key); } catch { /* nothing to remove */ }
}

function readStoredUser() {
  try {
    const parsed = JSON.parse(readStorage('ops-user') || 'null');
    return parsed && typeof parsed === 'object' && parsed.id ? parsed : null;
  } catch {
    return null;
  }
}

// ---- talking to the API -------------------------------------------------------

// Why the API turned a session or a sign-in away, in the reader's language. The
// server's own sentence is the fallback for anything without a known code.
function authRefusal(payload, t) {
  switch (payload?.code) {
    case 'AUTH_REQUIRED':
    case 'TOKEN_INVALID':
    case 'ACCOUNT_GONE': return t('auth.sessionExpired');
    case 'PASSWORD_CHANGED': return t('auth.passwordChanged');
    case 'ACCOUNT_INACTIVE': return payload.status === 'suspended' ? t('auth.accountSuspended') : t('auth.accountRevoked');
    case 'BAD_CREDENTIALS': return t('auth.badCredentials');
    case 'TOO_MANY_ATTEMPTS': return t('auth.tooManyAttempts');
    case 'PASSWORD_CHANGE_REQUIRED': return t('auth.choosePasswordFirst');
    case 'CURRENT_PASSWORD_WRONG': return t('auth.currentPasswordWrong');
    case 'PASSWORD_SAME': return t('auth.passwordSame');
    default: return payload?.message || t('auth.sessionExpired');
  }
}

// The one way every screen reaches the API. It carries the session, turns a
// dead session into a sign-out, and reports failures in words a reader can act
// on -- the method, status and URL go to the console for whoever is debugging,
// not onto the screen.
function useApi(token, onExpired) {
  const t = useT();
  const translator = useRef(t);
  translator.current = t;
  const expired = useRef(onExpired);
  expired.current = onExpired;
  const [online, setOnline] = useState(true);

  const request = useCallback(async (url, options = {}, { json = true } = {}) => {
    let response;
    try {
      response = await fetch(url, {
        ...options,
        headers: {
          ...(json ? { 'Content-Type': 'application/json' } : {}),
          Authorization: `Bearer ${token}`,
          ...(options.headers || {})
        }
      });
    } catch (networkError) {
      setOnline(false);
      console.warn(`${options.method || 'GET'} ${url} could not reach the server:`, networkError);
      throw new Error(translator.current('app.offline'));
    }
    setOnline(true);
    if (response.ok) return response;

    const payload = await response.json().catch(() => ({}));
    console.warn(`${options.method || 'GET'} ${url} -> ${response.status}`, payload);
    // A token that no longer works, or an account that may no longer sign in,
    // ends the session instead of leaving every screen failing with 401s.
    // A password the Director just reset is the same: signing in again leads
    // straight to choosing a new one.
    if (response.status === 401 || payload.code === 'ACCOUNT_INACTIVE' || payload.code === 'PASSWORD_CHANGE_REQUIRED') {
      const reason = authRefusal(payload, translator.current);
      expired.current(reason);
      throw new Error(reason);
    }
    throw new Error(payload.code ? authRefusal(payload, translator.current) : (payload.message || translator.current('app.requestFailed')));
  }, [token]);

  const fetchJson = useCallback(async (url, options = {}) => {
    const response = await request(url, options);
    return response.json().catch(() => ({}));
  }, [request]);

  // Multipart uploads set their own content type, boundary included.
  const upload = useCallback(async (url, formData) => {
    const response = await request(url, { method: 'POST', body: formData }, { json: false });
    return response.json().catch(() => []);
  }, [request]);

  const download = useCallback(async (url, filename) => {
    const response = await request(url, {}, { json: false });
    const blob = await response.blob();
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoked after the browser has had a moment to start the download; some
    // mobile browsers cancel it when the object URL disappears immediately.
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }, [request]);

  // Opens an evidence file in a new tab. The address carries a file token that
  // lasts minutes and opens that one file, asked for at the moment of the click
  // -- never the session token, which in a link ends up in browser history.
  // The tab is opened before the request so the browser treats it as the
  // reader's own click rather than a popup.
  const openFile = useCallback(async (path) => {
    const tab = window.open('', '_blank');
    try {
      const { url } = await fetchJson('/api/auth/file-link', { method: 'POST', body: JSON.stringify({ path }) });
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else {
        window.location.assign(url);
      }
    } catch (fileError) {
      tab?.close();
      throw fileError;
    }
  }, [fetchJson]);

  return { fetchJson, upload, download, openFile, online };
}

// Changing your own password, from the account menu. The API hands back a fresh
// session -- every other session on the account has just ended -- which
// replaces the current one.
function useOwnPasswordChange(fetchJson, onSessionRenewed) {
  const t = useT();
  const dialog = useDialog();
  return useCallback(async () => {
    const answer = await dialog.password({
      title: t('account.changeMyPassword'),
      current: true,
      confirmLabel: t('auth.savePassword')
    });
    if (!answer) return;
    const result = await fetchJson('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: answer.current, newPassword: answer.next })
    });
    onSessionRenewed(result.token, result.user, t('msg.ownPasswordChanged'));
  }, [dialog, fetchJson, onSessionRenewed, t]);
}

// ---- the application ------------------------------------------------------------

function App() {
  const { language, setLanguage, t } = useLanguage();
  // Set before anything renders, so the display helpers that are not components
  // -- sectorName here, areaLabel and deadlineNote elsewhere -- name things in
  // the language currently chosen.
  setDisplayLanguage(language);
  // Carried down the tree rather than passed to every component: the tables,
  // forms and detail panels that need it sit several levels below this one.
  const i18n = useMemo(() => ({ language, setLanguage, t }), [language, setLanguage, t]);

  const [token, setToken] = useState(() => readStorage('ops-token') || '');
  const [user, setUser] = useState(readStoredUser);
  // Why the reader is looking at the sign-in screen, when it was not their
  // choice: an expired session, a suspended account, a changed password.
  const [notice, setNotice] = useState('');
  // A one-off confirmation shown once the new workspace opens, for changes that
  // replace the session themselves -- choosing a new password.
  const [welcome, setWelcome] = useState('');

  const endSession = useCallback((reason = '') => {
    removeStorage('ops-token');
    removeStorage('ops-user');
    setToken('');
    setUser(null);
    setNotice(reason);
  }, []);

  // Signing out on purpose also forgets the page: whoever signs in next starts
  // on their own dashboard, not on the record the last person had open. An
  // expired session keeps it, so signing back in returns to the same place.
  const signOut = useCallback(() => {
    window.history.replaceState(null, '', '#/');
    endSession('');
  }, [endSession]);

  const startSession = useCallback((nextToken, nextUser, welcomeMessage = '') => {
    writeStorage('ops-token', nextToken);
    writeStorage('ops-user', JSON.stringify(nextUser));
    setNotice('');
    setWelcome(welcomeMessage);
    setToken(nextToken);
    setUser(nextUser);
  }, []);
  const clearWelcome = useCallback(() => setWelcome(''), []);

  // The stored account is a snapshot. It is confirmed against the API on every
  // start, and replaced with what the API says -- a manager moved to another
  // area gets the new area now, not at the next sign-in. Only a real refusal
  // signs the reader out: a network blip or a cold server start leaves them
  // signed in, where they will simply see the connection error.
  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    fetch('/api/auth/session', { headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => {
        if (cancelled) return;
        const payload = await response.json().catch(() => ({}));
        if (response.status === 401 || response.status === 403) {
          endSession(authRefusal(payload, t));
          return;
        }
        if (response.ok && payload.user) {
          writeStorage('ops-user', JSON.stringify(payload.user));
          setUser((current) => (JSON.stringify(current) === JSON.stringify(payload.user) ? current : payload.user));
        } else if (response.ok) {
          endSession(t('auth.sessionExpired'));
        }
      })
      .catch(() => {
        // Offline or the API is starting: keep the session.
        if (!cancelled && !readStoredUser()) setNotice(t('app.offline'));
      });
    return () => { cancelled = true; };
    // Checked once per token; a language change must not re-validate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, endSession]);

  let screen;
  if (!token || !user) {
    screen = <LoginScreen notice={notice} onSignedIn={startSession} />;
  } else if (user.mustChangePassword) {
    // The API refuses everything else until this is done, so nothing else is
    // drawn -- a workspace here would only fill with refusals.
    screen = <ChoosePasswordScreen token={token} user={user} onChosen={startSession} onSignOut={signOut} onExpired={endSession} />;
  } else if (user.role === 'partner') {
    screen = <PartnerWorkspace key={`${user.id}:${token}`} token={token} user={user} onLogout={signOut} onExpired={endSession} onSessionRenewed={startSession} welcome={welcome} onWelcomeShown={clearWelcome} />;
  } else {
    screen = <InternalWorkspace key={`${user.id}:${token}`} token={token} user={user} onLogout={signOut} onExpired={endSession} onSessionRenewed={startSession} welcome={welcome} onWelcomeShown={clearWelcome} />;
  }

  return <LanguageContext.Provider value={i18n}>
    <DialogProvider>{screen}</DialogProvider>
  </LanguageContext.Provider>;
}

// The sign-in form keeps its own state, so it is thrown away the moment someone
// signs in. It used to live on App, and signing out left the previous person's
// username and password filled in for whoever sat down next.
function LoginScreen({ notice, onSignedIn }) {
  const { language, setLanguage, t } = useI18n();
  const [form, setForm] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  const [busy, run] = useBusy();

  const submit = (event) => {
    event.preventDefault();
    run(async () => {
      setError('');
      try {
        const response = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(form)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.code ? authRefusal(payload, t) : (payload.message || t('app.requestFailed')));
        onSignedIn(payload.token, payload.user);
      } catch (loginError) {
        setError(loginError.message === 'Failed to fetch' || loginError.name === 'TypeError' ? t('app.offline') : loginError.message);
      }
    });
  };

  return <div className="login-shell"><form className="login-card" onSubmit={submit}>
    <img className="login-logo" src="/logo.png" srcSet="/logo.png 1x, /logo@2x.png 2x" alt={t('app.name')} />
    <LanguagePicker language={language} setLanguage={setLanguage} label={t('app.language')} />
    <h1>{t('auth.signIn')}</h1>
    <p>{t('auth.signInBlurb')}</p>
    {notice && <div className="notice-banner" role="status">{notice}</div>}
    <label>{t('auth.username')}<input required autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck="false" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} /></label>
    <label>{t('auth.password')}<input required type="password" autoComplete="current-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label>
    <button className="primary-btn full-width" type="submit" disabled={busy}>{busy ? t('auth.signingIn') : t('auth.signIn')}</button>
    {error && <div className="error-state" role="alert">{error}</div>}
  </form></div>;
}

// Shown in place of the workspace while the account still has a password somebody
// else chose: the Director's starting password, or one the Director set. It asks
// for that password again, so a session left open on someone's desk cannot be
// used to lock its owner out.
function ChoosePasswordScreen({ token, user, onChosen, onSignOut, onExpired }) {
  const { language, setLanguage, t } = useI18n();
  const [form, setForm] = useState({ current: '', next: '', repeat: '' });
  const [error, setError] = useState('');
  const [busy, run] = useBusy();

  const submit = (event) => {
    event.preventDefault();
    if (form.next.trim().length < MINIMUM_PASSWORD_LENGTH) { setError(t('dialog.passwordTooShort')); return; }
    if (form.next !== form.repeat) { setError(t('dialog.passwordMismatch')); return; }
    run(async () => {
      setError('');
      try {
        const response = await fetch('/api/auth/password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ currentPassword: form.current, newPassword: form.next })
        });
        const payload = await response.json().catch(() => ({}));
        if (response.status === 401 || payload.code === 'ACCOUNT_INACTIVE') { onExpired(authRefusal(payload, t)); return; }
        if (!response.ok) throw new Error(payload.code ? authRefusal(payload, t) : (payload.message || t('app.requestFailed')));
        onChosen(payload.token, payload.user, t('msg.ownPasswordChanged'));
      } catch (changeError) {
        setError(changeError.name === 'TypeError' ? t('app.offline') : changeError.message);
      }
    });
  };

  return <div className="login-shell"><form className="login-card" onSubmit={submit}>
    <img className="login-logo" src="/logo.png" srcSet="/logo.png 1x, /logo@2x.png 2x" alt={t('app.name')} />
    <LanguagePicker language={language} setLanguage={setLanguage} label={t('app.language')} />
    <h1>{t('auth.choosePasswordTitle')}</h1>
    <p>{fill(t('auth.choosePasswordBlurb'), { name: user.name })}</p>
    <label>{t('auth.currentPassword')}<input required type="password" autoComplete="current-password" value={form.current} onChange={(event) => setForm({ ...form, current: event.target.value })} /></label>
    <label>{t('dialog.newPassword')}<input required type="password" autoComplete="new-password" minLength={MINIMUM_PASSWORD_LENGTH} value={form.next} onChange={(event) => setForm({ ...form, next: event.target.value })} /></label>
    <label>{t('dialog.repeatPassword')}<input required type="password" autoComplete="new-password" value={form.repeat} onChange={(event) => setForm({ ...form, repeat: event.target.value })} /></label>
    <p className="field-hint">{t('dialog.passwordTooShort')}</p>
    <button className="primary-btn full-width" type="submit" disabled={busy}>{busy ? t('report.working') : t('auth.savePassword')}</button>
    {error && <div className="error-state" role="alert">{error}</div>}
    <button className="text-btn full-width" type="button" onClick={onSignOut}>{t('app.signOut')}</button>
  </form></div>;
}

// ---- the shell: sidebar on a wide screen, drawer on a phone ---------------------

// One small line icon per page, so the pages can be told apart at a glance in
// the sidebar and the drawer. Drawn inline: no icon font or extra request.
const NAV_ICON_PATHS = {
  dashboard: 'M4 13h7V4H4v9Zm0 7h7v-5H4v5Zm9 0h7v-9h-7v9Zm0-16v5h7V4h-7Z',
  'approval-queue': 'M9 12l2 2 4-4M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z',
  projects: 'M3 7h6l2 2h10v10H3V7Z',
  activities: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  monthly: 'M7 3v3M17 3v3M4 8h16M5 5h14v15H5V5Zm4 7h2m2 0h2m-6 4h2',
  approvals: 'M5 12l4 4L19 6',
  movements: 'M3 16V7h11v9M14 10h4l3 3v3h-7M7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm10 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  reports: 'M5 20V10m7 10V4m7 16v-7',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  users: 'M16 19v-1a4 4 0 0 0-8 0v1M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7 8v-1a3 3 0 0 0-2-2.8M17 5.2a3 3 0 0 1 0 5.6',
  partners: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-9 9h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9Z'
};

function NavIcon({ id }) {
  const path = NAV_ICON_PATHS[id];
  return <span className="nav-icon" aria-hidden="true">
    {path && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={path} /></svg>}
  </span>;
}

function AppShell({
  user, subtitle, navLabel, nav = [], bottomNav = null, activeId, onNavigate, sidebarContent, eyebrow, title,
  badge = 0, onBadge, online, refreshing, onRefresh, onLogout, onChangePassword, accountLines = [], children
}) {
  const { language, setLanguage, t } = useI18n();
  const phone = useMediaQuery(PHONE_QUERY);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const sidebar = useRef(null);
  const menuButton = useRef(null);
  const drawerActive = phone && drawerOpen;
  useScrollLock(drawerActive);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    menuButton.current?.focus();
  }, []);

  useEffect(() => {
    if (drawerActive) sidebar.current?.querySelector('.drawer-close')?.focus();
  }, [drawerActive]);

  // Leaving a phone-sized window with the drawer open must not leave it open
  // behind the desktop layout.
  useEffect(() => { if (!phone) setDrawerOpen(false); }, [phone]);
  // Every page change closes it: the reader chose where to go.
  useEffect(() => { setDrawerOpen(false); }, [activeId]);

  const go = (id) => {
    setDrawerOpen(false);
    onNavigate(id);
  };

  return <div className={`application-shell${drawerActive ? ' drawer-open' : ''}`}>
    <header className={bottomNav ? 'mobile-bar has-bottom-nav' : 'mobile-bar'}>
      {/* With a bottom bar, "More" opens the menu, so the burger is not needed. */}
      {!bottomNav && <button
        ref={menuButton}
        className="icon-btn menu-btn"
        type="button"
        aria-label={t('app.menu')}
        aria-expanded={drawerActive}
        aria-controls="app-sidebar"
        onClick={() => setDrawerOpen(true)}
      ><span className="burger" aria-hidden="true"><span /><span /><span /></span></button>}
      <span className="mobile-title">{title}</span>
      {!bottomNav && badge > 0 && <button className="mobile-badge" type="button" onClick={onBadge}
        aria-label={fill(t('app.waitingOnYou'), { count: badge })}>{badge}</button>}
      {onRefresh && <button className="icon-btn" type="button" onClick={onRefresh} disabled={refreshing} aria-label={t('action.refresh')}>
        <span className={refreshing ? 'refresh-glyph spinning' : 'refresh-glyph'} aria-hidden="true">&#8635;</span>
      </button>}
    </header>
    <div className="drawer-backdrop" aria-hidden="true" onClick={closeDrawer} />

    <aside
      id="app-sidebar"
      ref={sidebar}
      className="sidebar"
      aria-label={navLabel}
      aria-hidden={phone && !drawerOpen ? 'true' : undefined}
      onKeyDown={drawerActive ? (event) => trapFocus(event, sidebar.current, closeDrawer) : undefined}
    >
      <div className="sidebar-top">
        <div className="brand-lockup"><img className="brand-logo" src="/logo-mark.png" alt="" /><div><strong>{t('app.name')}</strong><span>{subtitle}</span></div></div>
        <button className="icon-btn drawer-close" type="button" onClick={closeDrawer} aria-label={t('app.closeMenu')}>&times;</button>
      </div>
      {nav.length > 0 && <nav aria-label={navLabel}>
        {[['main', t('app.workspace')], ['more', t('nav.more')]].map(([group, groupLabel]) => {
          const items = nav.filter((item) => (item[3] || 'main') === group);
          if (!items.length) return null;
          return <div key={group} className="nav-group">
            <div className="sidebar-label">{groupLabel}</div>
            {items.map(([id, label, count]) => <button
              key={id}
              className={activeId === id ? 'nav-item active' : 'nav-item'}
              aria-current={activeId === id ? 'page' : undefined}
              onClick={() => go(id)}
              type="button"
            >
              <NavIcon id={id} />
              <span className="nav-label">{label}</span>
              {count > 0 && <span className="nav-badge"><span className="sr-only">{fill(t('app.waitingOnYou'), { count })}</span><span aria-hidden="true">{count}</span></span>}
            </button>)}
          </div>;
        })}
      </nav>}
      {sidebarContent}
      <div className="sidebar-bottom">
        <LanguagePicker language={language} setLanguage={setLanguage} label={t('app.language')} />
        <div className="sidebar-label">{t('app.signedInAs')}</div>
        <strong>{user.name}</strong>
        {accountLines.map((line) => <span key={line}>{line}</span>)}
        {onChangePassword && <button className="account-btn" onClick={() => { setDrawerOpen(false); onChangePassword(); }} type="button">{t('account.changeMyPassword')}</button>}
        <button className="logout-btn" onClick={onLogout} type="button">{t('app.signOut')}</button>
      </div>
    </aside>

    <div className="main-area">
      <header className="top-header">
        <div><span className="eyebrow">{eyebrow}</span><h1 id="page-title" tabIndex={-1}>{title}</h1></div>
        <div className="header-meta">
          {/* While connected the green dot says it on its own; the word stays for
              screen readers and as the dot's tooltip. "Updating…" and "Offline"
              are still written out, because those are worth noticing. */}
          <span className={online ? 'connection-dot' : 'connection-dot offline'} aria-hidden="true" title={online ? t('app.online') : t('app.offlineShort')} />
          <span role="status" className={online && !refreshing ? 'sr-only' : undefined}>{online ? (refreshing ? t('app.refreshing') : t('app.online')) : t('app.offlineShort')}</span>
          {onRefresh && <button className="text-btn" type="button" onClick={onRefresh} disabled={refreshing}>{t('action.refresh')}</button>}
        </div>
      </header>
      <main id="main-content" className={bottomNav ? 'main-content with-bottom-nav' : 'main-content'}>{children}</main>
    </div>

    {/* On a phone: the everyday pages under the thumb, and More for the rest,
        the account and the language. Hidden on wider screens by the stylesheet. */}
    {bottomNav && <nav className="bottom-nav" aria-label={t('app.quickNavigation')}>
      {bottomNav.map((id) => {
        const item = nav.find(([navId]) => navId === id);
        if (!item) return null;
        const [, fullLabel, count, , shortLabel] = item;
        const label = shortLabel || fullLabel;
        return <button key={id} type="button" className={activeId === id ? 'bottom-nav-item active' : 'bottom-nav-item'}
          aria-current={activeId === id ? 'page' : undefined} onClick={() => go(id)}>
          <span className="bottom-nav-icon"><NavIcon id={id} />{count > 0 && <span className="bottom-nav-badge" aria-hidden="true">{count}</span>}</span>
          <span className="bottom-nav-label">{label}{count > 0 && <span className="sr-only"> {fill(t('app.waitingOnYou'), { count })}</span>}</span>
        </button>;
      })}
      <button ref={menuButton} type="button" className={drawerActive || !bottomNav.includes(activeId) ? 'bottom-nav-item active' : 'bottom-nav-item'}
        aria-expanded={drawerActive} aria-controls="app-sidebar" onClick={() => setDrawerOpen(true)}>
        <span className="bottom-nav-icon"><NavIcon id="more" /></span>
        <span className="bottom-nav-label">{t('nav.more')}</span>
      </button>
    </nav>}
  </div>;
}

// Success fades on its own; an error stays until it is read and dismissed, or
// the reader moves on.
function Banners({ message, error, onDismissMessage, onDismissError }) {
  const t = useT();
  useEffect(() => {
    if (!message) return undefined;
    const timer = setTimeout(onDismissMessage, 6000);
    return () => clearTimeout(timer);
  }, [message, onDismissMessage]);

  return <div className="banner-stack">
    {message && <div className="success-banner" role="status"><span>{message}</span><button type="button" onClick={onDismissMessage}>{t('app.dismiss')}</button></div>}
    {error && <div className="error-banner" role="alert"><span>{error}</span><button type="button" onClick={onDismissError}>{t('app.dismiss')}</button></div>}
  </div>;
}

// ---- the external partner's application ---------------------------------------

const PARTNER_TABS = ['overview', 'activities', 'movements', 'reports', 'updates'];

function PartnerWorkspace({ token, user, onLogout, onExpired, onSessionRenewed, welcome, onWelcomeShown }) {
  const { language, t } = useI18n();
  const [route, navigate] = useHashRoute();
  const { fetchJson, online } = useApi(token, onExpired);
  const [error, setError] = useState('');
  const [message, setMessage] = useState(welcome || '');
  useEffect(() => { if (welcome) onWelcomeShown(); }, [welcome, onWelcomeShown]);
  const changeOwnPassword = useOwnPasswordChange(fetchJson, onSessionRenewed);
  const [reloadKey, setReloadKey] = useState(0);
  const tab = PARTNER_TABS.includes(route.view) ? route.view : 'overview';

  useEffect(() => {
    if (route.view !== tab) navigate(buildHash(tab), { replace: true });
  }, [route.view, tab, navigate]);

  const clearError = useCallback(() => setError(''), []);

  // An external business partner gets a different application, not a trimmed
  // version of the internal one: a read-only window onto the single business
  // operation their account carries. The internal registers, approvals and
  // administration are never constructed for them, and the API would refuse
  // them anyway.
  return <AppShell
    user={user}
    subtitle={t('portal.title')}
    navLabel={t('app.mainNavigation')}
    activeId={tab}
    onNavigate={(id) => navigate(buildHash(id))}
    sidebarContent={<>
      <div className="sidebar-label">{t('app.businessOperation')}</div>
      <div className="partner-operation">{operationName(user.sector, language)}</div>
    </>}
    eyebrow={t('portal.title')}
    title={operationName(user.sector, language)}
    online={online}
    onRefresh={() => setReloadKey((key) => key + 1)}
    onLogout={onLogout}
    onChangePassword={() => changeOwnPassword().catch((changeError) => setError(changeError.message))}
    accountLines={[t('role.partner'), t('partners.viewOnly')]}
  >
    <Banners message={message} error={error} onDismissError={clearError} onDismissMessage={() => setMessage('')} />
    <ErrorBoundary resetKey={tab}>
      <PartnerPortal
        key={reloadKey}
        user={user}
        fetchJson={fetchJson}
        language={language}
        t={t}
        tab={tab}
        onTab={(id) => navigate(buildHash(id))}
        onError={setError}
      />
    </ErrorBoundary>
  </AppShell>;
}

// ---- the internal application -----------------------------------------------

function InternalWorkspace({ token, user, onLogout, onExpired, onSessionRenewed, welcome, onWelcomeShown }) {
  const { language, t } = useI18n();
  const dialog = useDialog();
  const [route, navigate] = useHashRoute();
  const { fetchJson, upload, download, openFile, online } = useApi(token, onExpired);
  const changeOwnPassword = useOwnPasswordChange(fetchJson, onSessionRenewed);
  const isDirector = user.role === 'super-admin';
  const isManager = user.role === 'manager';
  // Work is assigned by the Director and asked for by a manager. A team member
  // follows their operation's work but raises nothing; the API refuses them too.
  const canAddActivity = isDirector || isManager;

  // ---- data ------------------------------------------------------------------
  // 'loading' only until the first successful load. After that every refresh
  // happens behind the page: an action no longer swaps the whole view for a
  // spinner, which threw away scroll position and half-typed inputs.
  const [loadState, setLoadState] = useState('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [summary, setSummary] = useState({ summary: {}, sectors });
  const [projects, setProjects] = useState([]);
  const [activities, setActivities] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [managers, setManagers] = useState([]);
  const [register, setRegister] = useState(emptyRegister);
  const [approvalQueue, setApprovalQueue] = useState(emptyQueue);
  const [partnerRegister, setPartnerRegister] = useState(emptyPartnerRegister);
  const [rate, setRate] = useState(fallbackRate);
  // Secondary lists that failed to load. A failure is shown as a failure with a
  // retry, never as an empty list that looks like "nothing to do".
  const [issues, setIssues] = useState({});

  // ---- feedback --------------------------------------------------------------
  const [message, setMessage] = useState(welcome || '');
  const [error, setError] = useState('');
  useEffect(() => { if (welcome) onWelcomeShown(); }, [welcome, onWelcomeShown]);
  const [actionBusy, runAction] = useBusy();
  const notify = useCallback((text) => { setError(''); setMessage(text); }, []);
  const fail = useCallback((text) => { setMessage(''); setError(text); }, []);
  const clearMessage = useCallback(() => setMessage(''), []);
  const clearError = useCallback(() => setError(''), []);

  // ---- page state ------------------------------------------------------------
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [sectorFilter, setSectorFilter] = useState('All');
  const [projectSearch, setProjectSearch] = useState('');
  const [projectForm, setProjectForm] = useState(emptyProject);
  const [activityForm, setActivityForm] = useState(emptyActivity);
  const [approvalForm, setApprovalForm] = useState(emptyApproval);
  const [accountForm, setAccountForm] = useState(emptyAccount);
  const [userSearch, setUserSearch] = useState('');
  const [userRoleFilter, setUserRoleFilter] = useState('All');
  const [activityStatusFilter, setActivityStatusFilter] = useState('All');
  const [activitySearch, setActivitySearch] = useState('');
  const [registerPage, setRegisterPage] = useState(emptyRegisterPage);
  const [activityDetail, setActivityDetail] = useState(null);
  const [report, setReport] = useState(null);
  // The exact query the report on screen was generated from, so an export can
  // never be of a different period than the one being read.
  const [reportQueryUsed, setReportQueryUsed] = useState('');
  const [reportMode, setReportMode] = useState('weekly');
  const [reportRange, setReportRange] = useState(defaultReportRange);
  const [reportBusy, setReportBusy] = useState(false);

  // ---- navigation -------------------------------------------------------------
  // The badge is the number of records personally held up by this account. It
  // comes from the API's own count of the same predicate the queue runs, so the
  // two can never drift apart.
  const approvalCount = summary.summary?.approvalsAwaitingMe ?? approvalQueue.total ?? 0;
  // Five things people use every day, and the rest under "More". Nine items at
  // one level, with two of them both called some form of "approvals", was the
  // first thing the client found confusing. Only people who approve anything --
  // the Director and managers -- get the approvals page at all.
  const approves = isDirector || isManager;
  const navItems = [
    // The fifth entry is the short name used in the phone's bottom bar.
    ['dashboard', t('nav.home'), 0, 'main', t('nav.home')],
    ...(approves ? [['approval-queue', t('nav.approvalQueue'), approvalCount, 'main', t('nav.shortApprovals')]] : []),
    ['activities', t('nav.activities'), 0, 'main', t('nav.activities')],
    ['monthly', t('nav.monthlyPlans'), 0, 'main', t('nav.shortBudget')],
    ['movements', operationName('movement', language), 0, 'main', t('nav.shortTrips')],
    ['reports', t('nav.reports'), 0, 'more'],
    ['projects', t('nav.projects'), 0, 'more'],
    ['approvals', t('nav.approvals'), 0, 'more'],
    ...(isDirector ? [['users', t('nav.users'), 0, 'more'], ['partners', t('nav.partners'), 0, 'more']] : [])
  ];
  // The bar along the bottom of a phone: four pages and More. Someone who works
  // in Movements & Facilitation gets their trips there instead of activities.
  const tripsFirst = !isDirector && !user.coversAllSectors && user.sector === 'movement';
  const bottomNav = approves
    ? ['dashboard', 'approval-queue', tripsFirst ? 'movements' : 'activities', 'monthly']
    : ['dashboard', 'activities', 'monthly', 'movements'];
  // An address naming a page this account does not have -- a manager following
  // a Director's link to #/users -- lands on the home page instead of a blank page.
  const view = navItems.some(([id]) => id === route.view) ? route.view : 'dashboard';
  const routeId = route.id;
  // #/activities/new is the add form, not a record called "new".
  const creatingActivity = view === 'activities' && routeId === 'new' && canAddActivity;
  const activeRouteActivity = view === 'activities' && routeId !== 'new' ? routeId : null;
  const currentActivityRoute = useRef(activeRouteActivity);
  currentActivityRoute.current = activeRouteActivity;

  useEffect(() => {
    if (route.view !== view) navigate(buildHash(view), { replace: true });
  }, [route.view, view, navigate]);

  // ---- loading ----------------------------------------------------------------
  // Each load is numbered and only the newest may write, so two refreshes that
  // cross in flight cannot leave the older data on screen.
  const latestLoad = useRef(0);
  const lastLoadedAt = useRef(0);

  const loadData = useCallback(async () => {
    const requestNumber = ++latestLoad.current;
    setRefreshing(true);
    const results = await Promise.allSettled([
      fetchJson('/api/summary'), fetchJson('/api/projects'), fetchJson('/api/activities?limit=200'),
      fetchJson('/api/approvals'), fetchJson('/api/managers'), fetchJson('/api/approval-queue'),
      // Only the Director may read these two registers; nobody else is asked
      // for them, rather than being refused and the refusal ignored.
      isDirector ? fetchJson('/api/users') : Promise.resolve(emptyRegister),
      isDirector ? fetchJson('/api/partners') : Promise.resolve(emptyPartnerRegister),
      fetchJson('/api/rates')
    ]);
    if (requestNumber !== latestLoad.current) return;
    setRefreshing(false);

    const [summaryResult, projectResult, activityResult, approvalResult, managerResult, queueResult, userResult, partnerResult, rateResult] = results;
    const criticalFailure = [summaryResult, projectResult, activityResult, approvalResult].find((result) => result.status === 'rejected');
    if (criticalFailure) {
      setLoadState((current) => (current === 'ready' ? 'ready' : 'failed'));
      fail(criticalFailure.reason.message);
      return;
    }

    lastLoadedAt.current = Date.now();
    setSummary(summaryResult.value);
    setProjects(projectResult.value);
    setActivities(activityResult.value);
    setApprovals(approvalResult.value);
    setManagers(managerResult.status === 'fulfilled' ? managerResult.value : []);
    setApprovalQueue(queueResult.status === 'fulfilled' ? queueResult.value : emptyQueue);
    setRegister(userResult.status === 'fulfilled' ? userResult.value : emptyRegister);
    setPartnerRegister(partnerResult.status === 'fulfilled' ? partnerResult.value : emptyPartnerRegister);
    if (rateResult.status === 'fulfilled') setRate(rateResult.value);
    setIssues({
      managers: managerResult.status === 'rejected',
      queue: queueResult.status === 'rejected',
      users: userResult.status === 'rejected',
      partners: partnerResult.status === 'rejected'
    });
    setLoadState('ready');

    // A project can disappear between loads -- deleted, or moved to a sector
    // this user does not cover. The register filter and the form's project are
    // reconciled separately: an empty filter means "All projects", a choice and
    // not a vanished id, and treating it as vanished locked the register to the
    // first project on every refresh.
    const visibleProjects = projectResult.value;
    const isVisible = (projectId) => visibleProjects.some((project) => project.id === projectId);
    setSelectedProjectId((current) => (current && !isVisible(current) ? '' : current));
    setActivityForm((current) => {
      if (current.projectId && isVisible(current.projectId)) return current;
      const fallback = visibleProjects[0] || null;
      return {
        ...current,
        projectId: fallback?.id || '',
        sector: fallback?.sector || current.sector,
        // The preset category list is per sector, and so is the set of managers
        // who may be handed the work, so a change clears both.
        ...(fallback && fallback.sector !== current.sector ? { categoryChoice: '', category: '', assignedTo: '' } : {})
      };
    });
  }, [fetchJson, isDirector, fail]);

  useEffect(() => { loadData(); }, [loadData]);

  // ---- the activity register, page by page ---------------------------------------
  const latestRegister = useRef(0);
  const registerItems = useRef(0);
  registerItems.current = registerPage.items.length;
  const registerQuery = useMemo(() => {
    const params = new URLSearchParams({ paged: '1' });
    if (activityStatusFilter === 'Awaiting review') params.set('awaiting', 'review');
    else if (activityStatusFilter === 'My work') params.set('awaiting', 'work');
    else if (activityStatusFilter === 'Final check') params.set('awaiting', 'final-check');
    else if (activityStatusFilter === 'Assigned to me') params.set('assignedTo', 'me');
    else if (activityStatusFilter !== 'All') params.set('status', activityStatusFilter);
    if (selectedProjectId) params.set('projectId', selectedProjectId);
    if (activitySearch.trim()) params.set('search', activitySearch.trim());
    return params.toString();
  }, [activityStatusFilter, selectedProjectId, activitySearch]);

  // mode 'reset' starts again from the first page (filters changed); 'more'
  // appends the next page; 'refresh' re-reads everything already shown, so a
  // change made on page three does not throw the reader back to page one.
  const loadRegister = useCallback(async (mode = 'reset') => {
    const requestNumber = ++latestRegister.current;
    const offset = mode === 'more' ? registerItems.current : 0;
    const limit = mode === 'refresh' ? Math.min(200, Math.max(REGISTER_PAGE, registerItems.current)) : REGISTER_PAGE;
    setRegisterPage((current) => ({ ...current, loading: true, failed: false, ...(mode === 'reset' ? { items: [] } : {}) }));
    try {
      const page = await fetchJson(`/api/activities?${registerQuery}&limit=${limit}&offset=${offset}`);
      if (requestNumber !== latestRegister.current) return;
      setRegisterPage((current) => ({
        items: mode === 'more' ? [...current.items, ...page.items] : page.items,
        hasMore: page.hasMore,
        loading: false,
        failed: false
      }));
    } catch (registerError) {
      if (requestNumber !== latestRegister.current) return;
      setRegisterPage((current) => ({ ...current, loading: false, failed: true }));
      console.warn('The activity register could not be loaded:', registerError.message);
    }
  }, [fetchJson, registerQuery]);

  // Typing in the search box waits for a pause before asking the server.
  useEffect(() => {
    if (view !== 'activities') return undefined;
    const timer = setTimeout(() => loadRegister('reset'), activitySearch ? 300 : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, registerQuery]);

  // Every refresh of the application's data refreshes the register too while
  // it is on screen, so a change made from its detail shows in its row.
  const registerVisible = useRef(false);
  registerVisible.current = view === 'activities';
  const refreshRegister = useRef(loadRegister);
  refreshRegister.current = loadRegister;
  useEffect(() => {
    if (registerVisible.current && lastLoadedAt.current) refreshRegister.current('refresh');
  }, [activities]);

  // Moving to another page starts it clean -- at the top, with the old page's
  // banners gone -- and refreshes what the badge and the lists show, unless
  // they were loaded moments ago.
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) { firstView.current = false; return; }
    setMessage('');
    setError('');
    window.scrollTo({ top: 0 });
    document.getElementById('page-title')?.focus({ preventScroll: true });
    if (Date.now() - lastLoadedAt.current > 15000) loadData();
  }, [view, loadData]);

  // The requester is whoever is signed in, and a manager's request belongs to
  // their own sector, so neither is left for the user to type.
  useEffect(() => {
    setApprovalForm((current) => ({
      ...current,
      requestedBy: user.name,
      sector: !isDirector && user.sector ? user.sector : current.sector
    }));
  }, [user, isDirector]);

  // ---- the open activity --------------------------------------------------------

  // The review screen wants the record, its evidence, its trail and what has
  // actually been spent against it. Both requests travel together so the
  // remaining balance on screen always matches the expenses listed beside it.
  const loadActivityDetail = useCallback(async (activityId) => {
    const [detail, spending] = await Promise.all([
      fetchJson(`/api/activities/${encodeURIComponent(activityId)}`),
      // A user who may read the activity may read its expenses; if that ever
      // fails, the screen still opens without the money section.
      fetchJson(`/api/activities/${encodeURIComponent(activityId)}/expenses`).catch(() => null)
    ]);
    return {
      ...detail,
      expenses: spending?.expenses || [],
      expenseSummary: spending
        ? { approvedBudget: spending.approvedBudget, totalSpent: spending.totalSpent, remaining: spending.remaining }
        : null
    };
  }, [fetchJson]);

  // Clicking A and then B quickly must end on B, whichever answer lands last.
  const latestDetail = useRef(0);
  const showActivity = useCallback(async (activityId) => {
    const requestNumber = ++latestDetail.current;
    try {
      const detail = await loadActivityDetail(activityId);
      if (requestNumber === latestDetail.current && currentActivityRoute.current === activityId) setActivityDetail(detail);
    } catch (openError) {
      if (requestNumber !== latestDetail.current) return;
      fail(openError.message);
      navigate(buildHash('activities'), { replace: true });
    }
  }, [loadActivityDetail, fail, navigate]);

  // The open activity is the one in the address. Back closes it; a shared link
  // opens it.
  useEffect(() => {
    if (!activeRouteActivity) {
      latestDetail.current += 1;
      setActivityDetail(null);
      return;
    }
    showActivity(activeRouteActivity);
  }, [activeRouteActivity, showActivity]);

  const openActivity = (activityId) => navigate(buildHash('activities', activityId));
  const closeActivity = () => navigate(buildHash('activities'));

  // After a change: the lists always, the detail only if it is still the one
  // being read -- approving from the dashboard must not quietly open a review
  // that then appears the next time the Activities page is visited.
  const refreshActivity = async (activityId) => {
    await Promise.all([
      currentActivityRoute.current === activityId ? showActivity(activityId) : null,
      loadData()
    ]);
  };

  // A home tile opens the register already filtered to what it counted:
  // #/activities?filter=work or ?filter=final-check.
  const filterFromAddress = view === 'activities' ? route.query.get('filter') : null;
  useEffect(() => {
    if (!filterFromAddress) return;
    setActivityStatusFilter(filterFromAddress === 'work' ? 'My work' : filterFromAddress === 'final-check' ? 'Final check' : 'All');
    navigate(buildHash('activities'), { replace: true });
  }, [filterFromAddress, navigate]);

  // ---- actions ------------------------------------------------------------------
  // Every change goes through runAction, so a second click while the first is
  // still with the server is ignored instead of sent twice.
  const act = (task) => (...args) => runAction(() => task(...args));

  // Stable: the evidence lists inside the modules receive it.
  const openEvidenceFile = useCallback((path) => {
    openFile(path).catch((fileError) => fail(fileError.message));
  }, [openFile, fail]);

  // Suspending signs the person out everywhere at once. It is never blocked by
  // the work they hold -- locking out someone who has left cannot wait -- but
  // that work is named afterwards, so it can be handed to somebody else.
  const setAccountStatus = act(async (account, status) => {
    const suspending = status === 'suspended';
    const confirmed = await dialog.confirm({
      title: fill(t(suspending ? 'msg.suspendTitle' : 'msg.reactivateTitle'), { name: account.name }),
      message: t(suspending ? 'msg.suspendBody' : 'msg.reactivateBody'),
      confirmLabel: t(suspending ? 'action.suspend' : 'action.reactivate'),
      danger: suspending
    });
    if (!confirmed) return;
    setError('');
    try {
      const result = await fetchJson(`/api/users/${account.id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
      const held = result.heldWork || {};
      if (!suspending) notify(fill(t('msg.reactivated'), { name: account.name }));
      else if (held.approvals || held.activities || held.plans) {
        fail(fill(t('msg.suspendedHeldWork'), { name: account.name, approvals: held.approvals, activities: held.activities, plans: held.plans }));
      } else notify(fill(t('msg.suspended'), { name: account.name }));
      await loadData();
    } catch (statusError) { fail(statusError.message); }
  });

  const resetPassword = act(async (account) => {
    const next = await dialog.password({
      title: t('action.changePassword'),
      message: `${fill(t('msg.passwordFor'), { name: account.name, username: account.username })} ${t('form.temporaryPasswordHint')}`,
      confirmLabel: t('action.changePassword')
    });
    if (next === null) return;
    setError('');
    try {
      await fetchJson(`/api/users/${account.id}/password`, { method: 'PATCH', body: JSON.stringify({ password: next }) });
      notify(fill(t('msg.passwordUpdated'), { name: account.name }));
      loadData();
    } catch (resetError) { fail(resetError.message); }
  });

  // One route carries both the manager and the working area, because the two
  // have to agree: a user under a manager who covers another area would be on a
  // team whose records they cannot open.
  const saveAssignment = async (account, changes) => {
    setError('');
    try {
      const result = await fetchJson(`/api/users/${account.id}/assignment`, { method: 'PATCH', body: JSON.stringify(changes) });
      notify(`${account.name}: ${result.message || t('msg.saved')}`);
    } catch (assignmentError) {
      fail(assignmentError.message);
    }
    // Reloaded either way: on a refusal it puts the cell back to what was saved.
    await loadData();
  };

  const changeUserManager = act((account, managerId) => saveAssignment(account, { managerId: managerId || null }));

  // Moving a user to another area drops a manager who does not work there,
  // rather than leaving the pair inconsistent and the save refused -- so it is
  // confirmed first.
  const changeUserSector = act(async (account, sector) => {
    const confirmed = await dialog.confirm({
      title: t('msg.moveUserTitle'),
      message: fill(t('msg.moveUserBody'), { name: account.name, area: sector === ALL_OPERATIONS ? t('user.allOperations') : sectorName(sector) }),
      confirmLabel: t('dialog.confirm')
    });
    if (!confirmed) return;
    const manager = managers.find((candidate) => candidate.id === account.managerId);
    // An all-operations manager works in the new area too, so the link survives
    // the move; one confined to the area being left does not.
    const keepsManager = manager && (manager.coversAllSectors || manager.sector === sector);
    await saveAssignment(account, { sector, managerId: keepsManager ? manager.id : null });
  });

  const decideApproval = act(async (approval, status) => {
    // A decline without a reason leaves the manager with no idea what to fix,
    // so the note is required to decline and optional to approve.
    const declining = status === 'Rejected';
    const note = await dialog.prompt({
      title: declining ? t('msg.declineTitle') : t('msg.approveTitle'),
      message: approval.title,
      label: declining ? t('msg.declineReason') : t('msg.noteForRequester'),
      required: declining,
      multiline: true,
      danger: declining,
      confirmLabel: declining ? t('action.decline') : t('approval.approve')
    });
    if (note === null) return;
    setError('');
    try {
      await fetchJson(`/api/approvals/${encodeURIComponent(approval.id)}`, { method: 'PATCH', body: JSON.stringify({ status, decisionNote: note }) });
      notify(declining ? t('msg.requestDeclined') : t('msg.requestApproved'));
      await loadData();
    } catch (decisionError) { fail(decisionError.message); }
  });

  const chooseFormProject = (projectId) => {
    const project = projects.find((item) => item.id === projectId);
    setActivityForm((current) => {
      const sector = project?.sector || current.sector;
      // The preset category list is sector specific, and a manager only works
      // one area, so a sector change invalidates both the category and the pick
      // of who carries the work out.
      const keepSector = sector === current.sector;
      return {
        ...current, projectId, sector,
        categoryChoice: keepSector ? current.categoryChoice : '',
        category: keepSector ? current.category : '',
        assignedTo: keepSector ? current.assignedTo : ''
      };
    });
  };

  const showProjectActivities = (projectId) => {
    setSelectedProjectId(projectId);
    navigate(buildHash('activities'));
  };

  const submit = (event, url, body, success, reset, onCreated) => {
    event.preventDefault();
    return runAction(async () => {
      setError('');
      let result;
      try {
        result = await fetchJson(url, { method: 'POST', body: JSON.stringify(body) });
      } catch (submitError) {
        fail(submitError.message);
        return;
      }
      reset(result);
      notify(success);
      onCreated?.(result);
      await loadData();
    });
  };

  // ---- expenses -----------------------------------------------------------------

  // Section 5: the manager records what was really spent. The API checks it
  // against the remaining approved budget and refuses anything over it, so an
  // over-budget attempt comes back as the message the workflow specifies.
  // The expense first, then its receipt linked to it. If the expense is saved
  // but the receipt is not, the reader is told exactly that -- the money is
  // recorded, and the receipt can be added again under Receipts and proof.
  const recordExpense = act(async (activity, expense, reset, receipts = []) => {
    setError('');
    let result;
    try {
      result = await fetchJson(`/api/activities/${encodeURIComponent(activity.id)}/expenses`, {
        method: 'POST', body: JSON.stringify(expense)
      });
    } catch (expenseError) { fail(expenseError.message); return; }
    reset?.();
    const recorded = fill(t('msg.expenseRecorded'), { amount: formatUsd(result.expense.amount), remaining: formatUsd(result.remaining) });
    if (receipts.length) {
      const formData = new FormData();
      formData.append('kind', 'Receipt');
      formData.append('evidenceType', 'payment');
      formData.append('expenseId', String(result.expense.id));
      formData.append('note', expense.description || '');
      receipts.forEach((file) => formData.append('files', file));
      try {
        await upload(`/api/activities/${encodeURIComponent(activity.id)}/evidence`, formData);
        notify(`${recorded} ${t('msg.receiptAttached')}`);
      } catch (uploadError) {
        fail(fill(t('msg.expenseSavedReceiptFailed'), { reason: uploadError.message }));
      }
    } else {
      notify(recorded);
    }
    await refreshActivity(activity.id);
  });

  // Section 13: only the Director removes a financial record, and the API
  // refuses anyone else regardless of what is on screen.
  const removeExpense = act(async (activity, expense) => {
    const confirmed = await dialog.confirm({
      title: t('msg.removeExpenseTitle'),
      message: fill(t('msg.removeExpenseBody'), { amount: formatUsd(expense.amount), date: formatDate(expense.spentOn) }),
      confirmLabel: t('action.remove'),
      danger: true
    });
    if (!confirmed) return;
    setError('');
    try {
      const result = await fetchJson(`/api/activities/${encodeURIComponent(activity.id)}/expenses/${expense.id}`, { method: 'DELETE' });
      notify(result.message || t('msg.saved'));
      await refreshActivity(activity.id);
    } catch (removeError) { fail(removeError.message); }
  });

  // ---- the review and approval decisions ----------------------------------------

  const saveDecision = act(async (activity, decision) => {
    setError('');
    try {
      const result = await fetchJson(`/api/activities/${encodeURIComponent(activity.id)}/decision`, { method: 'PATCH', body: JSON.stringify(decision) });
      notify(result.budgetAdjustment
        ? fill(t('msg.decisionSavedBudget'), { requested: formatUsd(result.requestedBudget), approved: formatUsd(result.approvedBudget) })
        : t('msg.decisionSaved'));
      await refreshActivity(activity.id);
    } catch (decisionError) { fail(decisionError.message); }
  });

  // Approve or reject, taken by the person the record names. The API checks the
  // caller is that person; this only carries the decision there.
  const sendActivityApproval = async (activity, body) => {
    setError('');
    try {
      const result = await fetchJson(`/api/activities/${encodeURIComponent(activity.id)}/approval`, { method: 'PATCH', body: JSON.stringify(body) });
      if (body.action === 'approve') {
        notify(result.approvedBudget !== null && result.approvedBudget !== result.requestedBudget
          ? fill(t('msg.approvedBudget'), { requested: formatUsd(result.requestedBudget), approved: formatUsd(result.approvedBudget) })
          : t('msg.approvedStart'));
      } else {
        notify(t('msg.rejected'));
      }
      await refreshActivity(activity.id);
    } catch (approvalError) { fail(approvalError.message); }
  };
  const decideActivityApproval = act(sendActivityApproval);

  const sendMovementApproval = async (movement, body) => {
    setError('');
    try {
      await fetchJson(`/api/movements/${encodeURIComponent(movement.id)}/approval`, { method: 'PATCH', body: JSON.stringify(body) });
      notify(fill(body.action === 'approve' ? t('msg.movementApproved') : t('msg.movementRejected'), { ref: movement.ref }));
      await loadData();
    } catch (approvalError) { fail(approvalError.message); }
  };

  // Approve or reject straight from the queue, without opening the record. A
  // rejection still has to say why.
  const decideFromQueue = act(async (item, action) => {
    const isMovement = Boolean(item.ref);
    const label = isMovement ? `${item.ref} — ${item.purpose}` : item.activity;
    const rejecting = action === 'reject';
    const text = await dialog.prompt({
      title: rejecting ? t('approval.reject') : t('approval.approve'),
      message: label,
      label: rejecting ? t('msg.rejectReason') : t('msg.approveNote'),
      required: rejecting,
      multiline: true,
      danger: rejecting,
      confirmLabel: rejecting ? t('approval.reject') : t('approval.approve')
    });
    if (text === null) return;
    const body = rejecting ? { action: 'reject', rejectionReason: text } : { action: 'approve', adminNote: text };
    await (isMovement ? sendMovementApproval(item, body) : sendActivityApproval(item, body));
  });

  const changeActivityStatus = act(async (activity, status) => {
    setError('');
    try {
      await fetchJson(`/api/activities/${encodeURIComponent(activity.id)}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
      notify(fill(t('msg.statusMoved'), { status: t(`status.${status}`) }));
      await refreshActivity(activity.id);
    } catch (actionError) { fail(actionError.message); }
  });

  const submitCompletion = act(async (activity) => {
    const note = await dialog.prompt({
      title: t('action.submitCompleted'),
      message: activity.activity,
      label: t('review.noteForDirector'),
      multiline: true,
      confirmLabel: t('action.submitCompleted')
    });
    if (note === null) return;
    setError('');
    try {
      await fetchJson(`/api/activities/${encodeURIComponent(activity.id)}/completion`, { method: 'POST', body: JSON.stringify({ note }) });
      notify(t('msg.completionSubmitted'));
      await refreshActivity(activity.id);
    } catch (completionError) { fail(completionError.message); }
  });

  // Handing the work to a different manager, or moving the deadline. Only the
  // fields that actually changed travel: the API refuses a save that asks for
  // nothing, and an unchanged field would still stamp the trail.
  const saveActivityAssignment = act(async (activity, changes) => {
    setError('');
    try {
      const result = await fetchJson(`/api/activities/${encodeURIComponent(activity.id)}/assignment`, { method: 'PATCH', body: JSON.stringify(changes) });
      notify(result.assignedToName
        ? fill(result.deadline ? t('msg.assignmentSavedBy') : t('msg.assignmentSaved'), { name: result.assignedToName, date: formatDate(result.deadline) })
        : t('msg.assignmentNobody'));
      await refreshActivity(activity.id);
    } catch (assignError) { fail(assignError.message); }
  });

  // Resolves true only once the files are stored, so the upload form keeps the
  // chosen files when it fails and the reader does not have to pick them again.
  const uploadActivityEvidence = (activity, formData) => runAction(async () => {
    setError('');
    try {
      const saved = await upload(`/api/activities/${encodeURIComponent(activity.id)}/evidence`, formData);
      notify(fill(t('msg.filesAttached'), { count: saved.length }));
      await refreshActivity(activity.id);
      return true;
    } catch (uploadError) {
      fail(uploadError.message);
      return false;
    }
  });

  const removeActivityEvidence = act(async (activity, evidence) => {
    const confirmed = await dialog.confirm({
      title: t('msg.removeEvidenceTitle'),
      message: fill(t('msg.removeEvidenceBody'), { name: evidence.originalName }),
      confirmLabel: t('action.remove'),
      danger: true
    });
    if (!confirmed) return;
    setError('');
    try {
      await fetchJson(`/api/activities/${encodeURIComponent(activity.id)}/evidence/${evidence.id}`, { method: 'DELETE' });
      notify(t('msg.evidenceRemoved'));
      await refreshActivity(activity.id);
    } catch (evidenceError) { fail(evidenceError.message); }
  });

  const deleteProject = act(async (project) => {
    const confirmed = await dialog.confirm({
      title: t('msg.deleteTitle'),
      message: `${project.name}. ${t('msg.deleteProjectBody')}`,
      confirmLabel: t('action.delete'),
      danger: true
    });
    if (!confirmed) return;
    setError('');
    try {
      await fetchJson(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
      notify(t('msg.projectDeleted'));
      await loadData();
    } catch (deleteError) { fail(deleteError.message); }
  });

  // The review stays open until the deletion is confirmed and done; cancelling
  // leaves the reader exactly where they were.
  // The Director's final check, in the words of the step rather than a status
  // dropdown: done, or back to the manager with what to fix.
  const finishActivity = act(async (activity) => {
    const confirmed = await dialog.confirm({
      title: t('action.markDone'),
      message: `${activity.activity}. ${t('msg.markDoneBody')}`,
      confirmLabel: t('action.markDone')
    });
    if (!confirmed) return;
    setError('');
    try {
      await fetchJson(`/api/activities/${encodeURIComponent(activity.id)}/decision`, { method: 'PATCH', body: JSON.stringify({ status: 'Completed' }) });
      notify(t('msg.markedDone'));
      await refreshActivity(activity.id);
    } catch (finishError) { fail(finishError.message); }
  });

  const sendBackActivity = act(async (activity) => {
    const reason = await dialog.prompt({
      title: t('action.sendBack'),
      message: activity.activity,
      label: t('msg.sendBackReason'),
      required: true,
      multiline: true,
      confirmLabel: t('action.sendBack')
    });
    if (reason === null) return;
    setError('');
    try {
      await fetchJson(`/api/activities/${encodeURIComponent(activity.id)}/decision`, {
        method: 'PATCH', body: JSON.stringify({ status: 'Needs Correction', adminNote: reason })
      });
      notify(t('msg.sentBack'));
      await refreshActivity(activity.id);
    } catch (sendBackError) { fail(sendBackError.message); }
  });

  // Refused or cancelled work comes back for a decision -- or, when it never
  // needed one, straight back to Approved.
  const reopenActivity = act(async (activity) => {
    const reason = await dialog.prompt({
      title: t('action.reopen'),
      message: activity.activity,
      label: t('field.reason'),
      required: true,
      multiline: true,
      confirmLabel: t('action.reopen')
    });
    if (reason === null) return;
    setError('');
    try {
      await fetchJson(`/api/activities/${encodeURIComponent(activity.id)}/decision`, {
        method: 'PATCH',
        body: JSON.stringify({ status: activity.approvalRequired ? 'Pending Approval' : 'Approved', adminNote: reason })
      });
      notify(t('msg.reopened'));
      await refreshActivity(activity.id);
    } catch (reopenError) { fail(reopenError.message); }
  });

  const sendDraft = act(async (activity) => {
    setError('');
    try {
      await fetchJson(`/api/activities/${encodeURIComponent(activity.id)}/submit`, { method: 'PATCH' });
      notify(t('msg.activitySubmitted'));
      await refreshActivity(activity.id);
    } catch (sendError) { fail(sendError.message); }
  });

  const deleteActivity = act(async (activity) => {
    const confirmed = await dialog.confirm({
      title: t('msg.deleteTitle'),
      message: `${activity.activity}. ${t('msg.deleteActivityBody')}`,
      confirmLabel: t('action.delete'),
      danger: true
    });
    if (!confirmed) return;
    setError('');
    try {
      await fetchJson(`/api/activities/${encodeURIComponent(activity.id)}`, { method: 'DELETE' });
      notify(t('msg.activityDeleted'));
      if (currentActivityRoute.current === activity.id) closeActivity();
      await loadData();
    } catch (deleteError) { fail(deleteError.message); }
  });

  const assignManager = act(async (projectId, managerId) => {
    setError('');
    try {
      await fetchJson(`/api/projects/${encodeURIComponent(projectId)}/manager`, { method: 'PATCH', body: JSON.stringify({ managerId: managerId || null }) });
      notify(t('msg.projectManagerUpdated'));
    } catch (assignmentError) { fail(assignmentError.message); }
    await loadData();
  });

  // ---- external business partner access ------------------------------------

  // Invite someone outside the organisation and give them exactly one business
  // operation to follow, view only. Resolves true once saved, so the form only
  // clears on success.
  const invitePartner = (form) => runAction(async () => {
    setError('');
    try {
      const result = await fetchJson('/api/partners', { method: 'POST', body: JSON.stringify(form) });
      notify(fill(t('msg.partnerInvited'), { name: result.name, operation: operationName(result.operation, language) }));
      await loadData();
      return true;
    } catch (inviteError) {
      fail(inviteError.message);
      return false;
    }
  });

  // Moving the operation moves everything they can read, on their next request,
  // so it is confirmed rather than applied the instant the select changes.
  const changePartnerOperation = act(async (partner, operation) => {
    const confirmed = await dialog.confirm({
      title: t('msg.partnerOperationTitle'),
      message: fill(t('msg.partnerOperationBody'), { name: partner.name, operation: operationName(operation, language) }),
      confirmLabel: t('dialog.confirm')
    });
    if (!confirmed) return;
    setError('');
    try {
      const result = await fetchJson(`/api/partners/${partner.id}/operation`, { method: 'PATCH', body: JSON.stringify({ operation }) });
      notify(result.message);
    } catch (changeError) { fail(changeError.message); }
    await loadData();
  });

  const changePartnerStatus = act(async (partner, status) => {
    if (status !== 'active') {
      const confirmed = await dialog.confirm({
        title: status === 'suspended' ? t('msg.suspendTitle') : t('msg.revokeTitle'),
        message: fill(t('msg.partnerStatusBody'), { name: partner.name }),
        confirmLabel: status === 'suspended' ? t('partners.suspend') : t('partners.revoke'),
        danger: true
      });
      if (!confirmed) return;
    }
    setError('');
    try {
      const result = await fetchJson(`/api/partners/${partner.id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
      notify(result.message);
      await loadData();
    } catch (statusError) { fail(statusError.message); }
  });

  const resetPartnerPassword = act(async (partner) => {
    const next = await dialog.password({
      title: t('partners.resetPassword'),
      message: fill(t('msg.passwordFor'), { name: partner.name, username: partner.username }),
      confirmLabel: t('action.changePassword')
    });
    if (next === null) return;
    setError('');
    try {
      const result = await fetchJson(`/api/partners/${partner.id}/password`, { method: 'PATCH', body: JSON.stringify({ password: next }) });
      notify(result.message);
    } catch (resetError) { fail(resetError.message); }
  });

  const removePartner = act(async (partner) => {
    const confirmed = await dialog.confirm({
      title: t('msg.removePartnerTitle'),
      message: `${partner.name}. ${t('msg.removePartnerBody')}`,
      confirmLabel: t('partners.remove'),
      danger: true
    });
    if (!confirmed) return;
    setError('');
    try {
      const result = await fetchJson(`/api/partners/${partner.id}`, { method: 'DELETE' });
      notify(result.message);
      await loadData();
    } catch (removeError) { fail(removeError.message); }
  });

  // The Director's control over what leaves the organisation. An approved
  // record in an operation is visible to that operation's partners unless it is
  // switched off here.
  const setActivityVisibility = act(async (activity, externallyVisible) => {
    setError('');
    try {
      await fetchJson(`/api/activities/${encodeURIComponent(activity.id)}/visibility`, {
        method: 'PATCH', body: JSON.stringify({ externallyVisible })
      });
      notify(externallyVisible ? t('msg.visibleToPartners') : t('msg.hiddenFromPartners'));
      await refreshActivity(activity.id);
    } catch (visibilityError) { fail(visibilityError.message); }
  });

  // ---- budget change requests ----------------------------------------------

  // A manager cannot move a budget the Director set; they ask, with a reason.
  // Resolves true once sent, so the form keeps what was typed on a refusal.
  const requestBudgetChange = (activity, body) => runAction(async () => {
    setError('');
    try {
      await fetchJson(`/api/activities/${encodeURIComponent(activity.id)}/budget-requests`, { method: 'POST', body: JSON.stringify(body) });
      notify(t('msg.budgetRequestSent'));
      await refreshActivity(activity.id);
      return true;
    } catch (requestError) {
      fail(requestError.message);
      return false;
    }
  });

  const decideBudgetRequest = act(async (activity, request, status) => {
    const declining = status === 'Declined';
    const note = await dialog.prompt({
      title: declining ? t('budget.declineTitle') : t('budget.approveTitle'),
      message: `${formatUsd(request.currentBudget)} → ${formatUsd(request.requestedAmount)} · ${request.reason}`,
      label: declining ? t('msg.declineReason') : t('msg.noteForRequester'),
      required: declining,
      multiline: true,
      danger: declining,
      confirmLabel: declining ? t('action.decline') : t('approval.approve')
    });
    if (note === null) return;
    setError('');
    try {
      await fetchJson(`/api/activities/${encodeURIComponent(activity.id)}/budget-requests/${request.id}`, {
        method: 'PATCH', body: JSON.stringify({ status, decisionNote: note })
      });
      notify(declining ? t('msg.budgetRequestDeclined') : t('msg.budgetRequestApproved'));
      await refreshActivity(activity.id);
    } catch (decisionError) { fail(decisionError.message); }
  });

  // ---- reports -------------------------------------------------------------

  const reportQuery = (mode = reportMode, range = reportRange) => {
    if (mode === 'monthly') return `period=monthly&month=${encodeURIComponent(range.month)}`;
    if (mode === 'custom') return `period=custom&start=${encodeURIComponent(range.start)}&end=${encodeURIComponent(range.end)}`;
    // Any day inside the week; the API widens it to Monday-Sunday.
    return `period=weekly&start=${encodeURIComponent(range.week)}`;
  };

  const requestReport = async () => {
    setError('');
    setReportBusy(true);
    const query = reportQuery();
    try {
      setReport(await fetchJson(`/api/reports/activities?${query}`));
      setReportQueryUsed(query);
    } catch (reportError) {
      setReport(null);
      fail(reportError.message);
    } finally {
      setReportBusy(false);
    }
  };

  // The export runs the same scoped query on the server, so a manager's file
  // holds their own working area and nothing more -- and it is the query the
  // report on screen came from, so the file matches what is being read.
  const exportReport = async (format) => {
    if (!report || !reportQueryUsed) return;
    setError('');
    setReportBusy(true);
    try {
      await download(
        `/api/reports/activities/export?format=${format}&${reportQueryUsed}`,
        `activity-report-${report.period.start}-to-${report.period.end}.${format}`
      );
      notify(fill(t('msg.reportDownloaded'), { format: format === 'xlsx' ? 'Excel' : 'PDF' }));
    } catch (exportError) {
      fail(exportError.message);
    } finally {
      setReportBusy(false);
    }
  };

  // ---- derived lists -----------------------------------------------------------

  const filteredProjects = useMemo(() => projects.filter((project) => {
    const matchesSector = sectorFilter === 'All' || project.sector === sectorFilter;
    const term = projectSearch.trim().toLowerCase();
    return matchesSector && (!term || [project.name, project.location, project.owner, project.category].some((value) => String(value || '').toLowerCase().includes(term)));
  }), [projects, sectorFilter, projectSearch]);

  const filteredUsers = useMemo(() => {
    const term = userSearch.trim().toLowerCase();
    return register.users.filter((account) => (userRoleFilter === 'All' || account.role === userRoleFilter)
      && (!term || [account.name, account.username, account.managerName, sectorName(account.sector), roleName(account.role, t)]
        .some((value) => String(value || '').toLowerCase().includes(term))));
  }, [register.users, userSearch, userRoleFilter, t]);

  // "Awaiting review" is the Director's queue: undecided requests, finished work
  // handed back, and budget changes waiting for an answer. It is a view over the
  // records, not a status of its own -- the same one the API's awaiting=review runs.
  const awaitingReview = (activity) => activity.status === 'Pending Approval'
    || (activity.completionSubmittedAt && activity.status !== 'Completed')
    || activity.pendingBudgetRequests > 0;

  const reviewQueue = useMemo(() => activities.filter(awaitingReview), [activities]);
  // The manager's own queue, soonest deadline first, because that is the order
  // the work is due. Anything without a deadline sits at the end.
  const myAssignments = useMemo(() => activities
    .filter((activity) => activity.assignedTo === user.id && OPEN_ASSIGNMENT_STATUSES.includes(activity.status))
    .sort((left, right) => (left.deadline || '9999-12-31').localeCompare(right.deadline || '9999-12-31')),
  [activities, user.id]);
  const pendingApprovals = approvals.filter((approval) => approval.status === 'Pending');
  const formProject = projects.find((project) => project.id === activityForm.projectId);
  const usd = Number(activityForm.costUsd || 0);
  // A sector manager may only file against their own sector; the API enforces
  // the same rule, this just keeps the unusable options out of the dropdown.
  const sectorOptions = useMemo(
    () => (!isDirector && user.sector ? sectors.filter((sector) => sector.id === user.sector) : sectors),
    [isDirector, user.sector]
  );

  // Four figures everyone gets, and a fifth that depends on who is reading it:
  // the Director sees the size of the organisation, a manager sees the work
  // sitting on their own desk.
  const dashboardMetrics = [
    [t('metric.projects'), summary.summary?.totalProjects || 0],
    [t('metric.activitiesInProgress'), summary.summary?.activeOperations || 0],
    [t('metric.pendingApprovals'), summary.summary?.approvalsPending || 0],
    [t('metric.completionRate'), `${summary.summary?.completionRate || 0}%`],
    ...(typeof summary.summary?.registeredUsers === 'number' ? [[t('metric.registeredUsers'), summary.summary.registeredUsers]] : []),
    // The API counts only what is actually waiting on the manager -- work they
    // have not accepted, and work sent back -- not everything they hold.
    ...(isDirector ? [] : [[t('metric.needingYourAction'), summary.summary?.activitiesAssignedToMe || 0]])
  ];

  const pageTitle = navItems.find(([id]) => id === view)?.[1];
  const go = (id, filter) => navigate(filter ? `${buildHash(id)}?filter=${encodeURIComponent(filter)}` : buildHash(id));
  const addActivity = () => navigate(buildHash('activities', 'new'));
  const coversMovements = Boolean(user.coversAllSectors) || user.sector === 'movement';
  const canAddMovement = isDirector || (isManager && coversMovements);
  // Stable, because the modules key their loading effects on them.
  const openPlanRoute = useCallback((planId) => navigate(buildHash('monthly', planId)), [navigate]);
  const closePlanRoute = useCallback(() => navigate(buildHash('monthly')), [navigate]);
  const openMovementRoute = useCallback((movementId) => navigate(buildHash('movements', movementId)), [navigate]);
  const closeMovementRoute = useCallback(() => navigate(buildHash('movements')), [navigate]);
  const openQueueItem = (item) => (item.ref ? navigate(buildHash('movements', item.id)) : openActivity(item.id));
  const onModuleChanged = useCallback(() => { loadData(); }, [loadData]);

  // ---- the page ------------------------------------------------------------------

  let content;
  if (loadState === 'loading') {
    content = <div className="loading-state"><span className="spinner" />{t('app.loading')}</div>;
  } else if (loadState === 'failed') {
    content = <div className="empty-state load-issue">
      <strong>{t('app.loadFailed')}</strong>
      <button className="primary-btn" type="button" onClick={() => { setLoadState('loading'); loadData(); }}>{t('action.retry')}</button>
    </div>;
  } else if (view === 'dashboard') {
    content = <Home
      user={user}
      summary={summary.summary}
      sectorRows={summary.sectorBreakdown}
      approvalItems={issues.queue ? [] : [...approvalQueue.activities, ...approvalQueue.movements]}
      approvalCount={approvalCount}
      fetchJson={fetchJson}
      reloadKey={summary}
      canAddActivity={canAddActivity}
      canAddMovement={canAddMovement}
      rate={rate}
      busy={actionBusy}
      onGo={go}
      onAddActivity={addActivity}
      onAddMovement={() => navigate(buildHash('movements', 'new'))}
      onOpenActivity={openActivity}
      onOpenQueueItem={openQueueItem}
      onDecide={decideFromQueue}
      onOpenPlan={openPlanRoute}
    />;
  } else if (view === 'approval-queue') {
    content = <>
      <section className="welcome-strip">
        <div>
          <span className="eyebrow">{t('approval.yourQueue')}</span>
          <h2>{t('approval.queueTitle')} <span className="queue-count">{approvalCount}</span></h2>
          <p>{t('approval.queueBlurb')} {t('approval.onlyYou')}</p>
        </div>
      </section>
      {issues.queue
        ? <Panel title={t('approval.queueTitle')}><LoadIssue onRetry={loadData} /></Panel>
        : <DecisionList
          items={[...approvalQueue.activities, ...approvalQueue.movements]}
          onOpen={openQueueItem}
          onDecide={decideFromQueue}
          busy={actionBusy}
          empty={t('approval.queueEmpty')}
        />}
    </>;
  } else if (view === 'projects') {
    content = <>
      <section className="toolbar-row">
        <div className="filter-group">
          <label className="sr-only" htmlFor="project-sector-filter">{t('app.businessOperation')}</label>
          <select id="project-sector-filter" value={sectorFilter} onChange={(event) => setSectorFilter(event.target.value)}><option value="All">{t('app.allOperations')}</option>{sectors.map((sector) => <option key={sector.id} value={sector.id}>{sectorName(sector.id)}</option>)}</select>
          <label className="sr-only" htmlFor="project-search">{t('form.searchProjects')}</label>
          <input id="project-search" type="search" placeholder={t('form.searchProjects')} value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} />
        </div>
        {isDirector && <button className="primary-btn" type="button" onClick={() => document.getElementById('project-form')?.scrollIntoView({ behavior: 'smooth' })}>{t('form.addProject')}</button>}
      </section>
      <Panel title={t('panel.projectRegister')} subtitle={`${filteredProjects.length}`}>
        <ProjectTable projects={filteredProjects} managers={managers} isDirector={isDirector} busy={actionBusy} onShowActivities={showProjectActivities} onAssign={assignManager} onDelete={deleteProject} empty={t('empty.noProjectsMatch')} />
      </Panel>
      {isDirector && <ProjectForm form={projectForm} setForm={setProjectForm} managers={managers} busy={actionBusy} onSubmit={(event) => submit(event, '/api/projects', projectForm, t('msg.projectAdded'), () => setProjectForm(emptyProject))} />}
    </>;
  } else if (view === 'activities') {
    content = <>
      <section className="context-strip">
        <div><span className="eyebrow">{t('activities.eyebrow')}</span><h2>{t('activities.title')}</h2><p>{isDirector ? t('activities.directorBlurb') : t('activities.managerBlurb')}</p></div>
        {canAddActivity && <button className="primary-btn" type="button" onClick={addActivity}>{isDirector ? t('action.assignActivity') : t('action.raiseActivity')}</button>}
      </section>

      {creatingActivity && <DetailView onClose={closeActivity} label={isDirector ? t('action.assignActivity') : t('action.raiseActivity')}>
        <ActivityForm
          form={activityForm} setForm={setActivityForm} projects={projects} onChooseProject={chooseFormProject}
          selectedProject={formProject} managers={managers}
          isDirector={isDirector} usd={usd} rate={rate} busy={actionBusy}
          onCancel={closeActivity}
          onSubmit={(event) => {
            const { categoryChoice, ...payload } = activityForm;
            return submit(
              event, '/api/activities',
              { ...payload, costRwf: round2(usd * rate.rwfPerUsd), costCdf: round2(usd * rate.cdfPerUsd) },
              isDirector ? t('msg.activityAssigned') : t('msg.activitySubmitted'),
              (result) => { setActivityForm({ ...emptyActivity, projectId: result.projectId, sector: result.sector }); },
              (result) => navigate(buildHash('activities', result.id), { replace: true })
            );
          }}
        />
      </DetailView>}

      {activityDetail && activeRouteActivity && activityDetail.activity.id === activeRouteActivity && <DetailView onClose={closeActivity} label={activityDetail.activity.activity}>
        <ActivityReview
          detail={activityDetail}
          user={user}
          onOpenFile={openEvidenceFile}
          busy={actionBusy}
          sectorLabel={sectorName}
          managers={managers}
          onClose={closeActivity}
          onDecision={saveDecision}
          onStatus={changeActivityStatus}
          onAssign={saveActivityAssignment}
          onUpload={uploadActivityEvidence}
          onRemoveEvidence={removeActivityEvidence}
          onSubmitCompletion={submitCompletion}
          onApprove={decideActivityApproval}
          onReject={(record) => decideFromQueue(record, 'reject')}
          onVisibility={setActivityVisibility}
          onRecordExpense={recordExpense}
          onRemoveExpense={removeExpense}
          onRequestBudget={requestBudgetChange}
          onDecideBudget={decideBudgetRequest}
          onDelete={deleteActivity}
          onSendDraft={sendDraft}
          onFinish={finishActivity}
          onSendBack={sendBackActivity}
          onReopen={reopenActivity}
        />
      </DetailView>}

      <section className="toolbar-row"><div className="filter-group">
        <label className="sr-only" htmlFor="activity-status-filter">{t('table.status')}</label>
        <select id="activity-status-filter" value={activityStatusFilter} onChange={(event) => setActivityStatusFilter(event.target.value)}>
          <option value="All">{t('form.allStatuses')}</option>
          {!isDirector && <option value="My work">{t('home.tileWork')}</option>}
          <option value="Final check">{t('home.tileChecks')}</option>
          <option value="Awaiting review">{t('activities.awaitingReview')}</option>
          {!isDirector && <option value="Assigned to me">{t('activities.assignedToMe')}</option>}
          {ACTIVITY_STATUSES.map((status) => <option key={status} value={status}>{t(`status.${status}`)}</option>)}
        </select>
        <label className="sr-only" htmlFor="activity-project-filter">{t('field.project')}</label>
        <select id="activity-project-filter" value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}><option value="">{t('form.allProjects')}</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
        <label className="sr-only" htmlFor="activity-search">{t('form.searchActivities')}</label>
        <input id="activity-search" type="search" placeholder={t('form.searchActivities')} value={activitySearch} onChange={(event) => setActivitySearch(event.target.value)} />
      </div></section>

      <Panel title={t('panel.activityRegister')} subtitle={registerPage.loading && !registerPage.items.length ? t('app.loading') : `${registerPage.items.length}${registerPage.hasMore ? '+' : ''}`}>
        {registerPage.failed && !registerPage.items.length
          ? <LoadIssue onRetry={() => loadRegister('reset')} />
          : registerPage.loading && !registerPage.items.length
            ? <div className="loading-state compact-loading"><span className="spinner" />{t('app.loading')}</div>
            : <ActivityTable
              activities={registerPage.items}
              isDirector={isDirector}
              openId={activeRouteActivity}
              onOpen={openActivity}
              empty={t('empty.noActivitiesMatch')}
            />}
        {registerPage.hasMore && <div className="load-more-row">
          <button className="secondary-btn" type="button" disabled={registerPage.loading} onClick={() => loadRegister('more')}>
            {registerPage.loading ? t('app.loading') : t('action.loadMore')}
          </button>
        </div>}
      </Panel>

    </>;
  } else if (view === 'reports') {
    content = <>
      <ReportsSection
        mode={reportMode}
        range={reportRange}
        report={report}
        busy={reportBusy}
        sectorLabel={sectorName}
        onModeChange={(next) => { setReportMode(next); setReport(null); }}
        // A report is a reading of one period. Once the range moves it no
        // longer describes what the pickers show, so it is cleared.
        onRangeChange={(changes) => { setReportRange((current) => ({ ...current, ...changes })); setReport(null); }}
        onGenerate={requestReport}
        onExport={exportReport}
        onPrint={() => window.print()}
        onClose={() => setReport(null)}
      />
    </>;
  } else if (view === 'approvals') {
    content = <>
      <section className="toolbar-row"><div className="filter-group">
        <label className="sr-only" htmlFor="approval-sector-filter">{t('app.businessOperation')}</label>
        <select id="approval-sector-filter" value={sectorFilter} onChange={(event) => setSectorFilter(event.target.value)}><option value="All">{t('app.allOperations')}</option>{sectors.map((sector) => <option key={sector.id} value={sector.id}>{sectorName(sector.id)}</option>)}</select>
      </div></section>
      <Panel title={t('panel.approvalRegister')} subtitle={`${approvals.length}`}>
        <ApprovalTable approvals={approvals.filter((approval) => sectorFilter === 'All' || approval.sector === sectorFilter)} canDecide={isDirector} busy={actionBusy} onDecide={decideApproval} empty={t('empty.noApprovalRecords')} />
      </Panel>
      {/* A request is raised by a sector manager and decided by the Director,
          who therefore has nobody to raise one to. */}
      {isManager && <ApprovalForm form={approvalForm} setForm={setApprovalForm} sectorOptions={sectorOptions} busy={actionBusy} onSubmit={(event) => submit(event, '/api/approvals', approvalForm, t('msg.requestSent'), () => setApprovalForm({ ...emptyApproval, sector: sectorOptions[0]?.id || emptyApproval.sector, requestedBy: user.name }))} />}
    </>;
  } else if (view === 'users') {
    content = <>
      <div className="metric-grid metric-grid-5">
        <Metric label={t('metric.registeredUsers')} value={register.total} />
        <Metric label={t('metric.operationManagers')} value={register.roleCounts?.manager || 0} />
        <Metric label={t('metric.teamMembers')} value={register.roleCounts?.staff || 0} />
        <Metric label={t('metric.withoutManager')} value={register.unassigned || 0} />
        {/* A manager who covers every operation covers this one too, so they
            count here as well -- matching on sector alone read their NULL
            sector as covering nothing and left every operation uncovered. */}
        <Metric label={t('metric.operationsWithoutManager')} value={sectors.filter((sector) => !register.users.some((account) => account.role === 'manager' && (account.coversAllSectors || account.sector === sector.id))).length} />
      </div>
      <section className="toolbar-row"><div className="filter-group">
        <label className="sr-only" htmlFor="user-role-filter">{t('field.role')}</label>
        <select id="user-role-filter" value={userRoleFilter} onChange={(event) => setUserRoleFilter(event.target.value)}>
          <option value="All">{t('form.allRoles')}</option>
          <option value="super-admin">{t('role.super-admin')}</option>
          <option value="manager">{t('role.manager')}</option>
          <option value="staff">{t('role.staff')}</option>
        </select>
        <label className="sr-only" htmlFor="user-search">{t('form.searchUsers')}</label>
        <input id="user-search" type="search" placeholder={t('form.searchUsers')} value={userSearch} onChange={(event) => setUserSearch(event.target.value)} />
      </div><button className="primary-btn" type="button" onClick={() => document.getElementById('account-form')?.scrollIntoView({ behavior: 'smooth' })}>{t('form.addUser')}</button></section>
      <Panel title={t('panel.userManagement')} subtitle={`${filteredUsers.length} / ${register.total}`}>
        {issues.users
          ? <LoadIssue onRetry={loadData} />
          : <UserTable users={filteredUsers} managers={managers} currentUserId={user.id} busy={actionBusy} onChangeManager={changeUserManager} onChangeSector={changeUserSector} onResetPassword={resetPassword} onSetStatus={setAccountStatus} empty={t('empty.noAccountsMatch')} />}
      </Panel>
      <AccountForm form={accountForm} setForm={setAccountForm} managers={managers} busy={actionBusy} onSubmit={(event) => submit(event, '/api/users', { ...accountForm, managerId: accountForm.managerId || null }, t('msg.accountCreated'), () => setAccountForm(emptyAccount))} />
    </>;
  } else if (view === 'monthly') {
    content = <MonthlyPlans
      user={user}
      fetchJson={fetchJson}
      managers={managers}
      rate={rate}
      planId={routeId}
      onOpenPlan={openPlanRoute}
      onClosePlan={closePlanRoute}
      onChanged={onModuleChanged}
      onMessage={notify}
      onError={fail}
    />;
  } else if (view === 'partners') {
    content = issues.partners
      ? <Panel title={t('nav.partners')}><LoadIssue onRetry={loadData} /></Panel>
      : <ExternalPartners
        register={partnerRegister}
        language={language}
        t={t}
        busy={actionBusy}
        onInvite={invitePartner}
        onChangeOperation={changePartnerOperation}
        onChangeStatus={changePartnerStatus}
        onResetPassword={resetPartnerPassword}
        onRemove={removePartner}
      />;
  } else if (view === 'movements') {
    content = <MovementModule
      user={user}
      onOpenFile={openEvidenceFile}
      fetchJson={fetchJson}
      upload={upload}
      openId={routeId}
      onOpen={openMovementRoute}
      onClose={closeMovementRoute}
      onChanged={onModuleChanged}
      onMessage={notify}
      onError={fail}
    />;
  }

  return <AppShell
    user={user}
    subtitle={t('app.subtitle')}
    navLabel={t('app.mainNavigation')}
    nav={navItems}
    bottomNav={bottomNav}
    activeId={view}
    onNavigate={go}
    eyebrow={t('app.operationsControl')}
    title={pageTitle}
    badge={approvalCount}
    onBadge={() => go('approval-queue')}
    online={online}
    refreshing={refreshing}
    onRefresh={loadData}
    onLogout={onLogout}
    onChangePassword={() => changeOwnPassword().catch((changeError) => fail(changeError.message))}
    accountLines={[
      roleName(user.role, t),
      ...(user.coversAllSectors
        ? [`${t('app.businessOperation')}: ${t('user.allOperations')}`]
        : user.sector ? [`${t('app.businessOperation')}: ${sectorName(user.sector)}`] : [])
    ]}
  >
    <Banners message={message} error={error} onDismissMessage={clearMessage} onDismissError={clearError} />
    {issues.managers && loadState === 'ready' && <p className="notice-banner" role="status">{t('msg.managersUnavailable')}</p>}
    <ErrorBoundary resetKey={view}>{content}</ErrorBoundary>
  </AppShell>;
}

// Available before sign-in as well as after, because someone who reads no
// English has to be able to change it before they can read the login form.
function LanguagePicker({ language, setLanguage, label }) {
  return <label className="language-picker">
    <span>{label}</span>
    <select value={language} onChange={(event) => setLanguage(event.target.value)}>
      {LANGUAGES.map((option) => <option key={option.code} value={option.code}>{option.nativeName}</option>)}
    </select>
  </label>;
}

function LoadIssue({ onRetry }) {
  const t = useT();
  return <div className="empty-state load-issue" role="alert">
    <strong>{t('app.sectionLoadFailed')}</strong>
    <button className="secondary-btn" type="button" onClick={onRetry}>{t('action.retry')}</button>
  </div>;
}

// Rows that open something are reachable from the keyboard as well as by click.
function rowActivation(onActivate) {
  return {
    tabIndex: 0,
    role: 'button',
    onClick: onActivate,
    onKeyDown: (event) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onActivate();
      }
    }
  };
}

function UserTable({ users, managers, currentUserId, busy, onChangeManager, onChangeSector, onResetPassword, onSetStatus, empty }) {
  const t = useT();
  return users.length ? <div className="table-wrap"><table className="card-table"><thead><tr><th>{t('field.name')}</th><th>{t('field.username')}</th><th>{t('field.role')}</th><th>{t('user.access')}</th><th>{t('field.reportsTo')}</th><th>{t('field.workingArea')}</th><th>{t('field.projects')}</th><th>{t('field.team')}</th><th>{t('field.added')}</th><th>{t('field.password')}</th><th>{t('field.action')}</th></tr></thead><tbody>
    {users.map((account) => {
      const isDirector = account.role === 'super-admin';
      const isSelf = account.id === currentUserId;
      // Only managers who work the same area can be picked, which is the rule
      // the API applies; the current manager stays listed so the cell is never
      // blank while the two are still in step.
      const managerOptions = managers.filter((manager) => manager.id !== account.id
        && (manager.coversAllSectors || manager.sector === account.sector || manager.id === account.managerId));
      return <tr key={account.id}>
        <td className="card-title-cell"><strong>{account.name}</strong><small>#{account.id}</small></td>
        <td data-label={t('field.username')}>{account.username}</td>
        <td data-label={t('field.role')}><span className={isDirector ? 'role-badge role-admin' : 'role-badge'}>{t(`role.${account.role}`)}</span></td>
        <td data-label={t('user.access')}>{account.status === 'suspended'
          ? <span className="status-badge tone-stopped">{t('user.suspended')}</span>
          : <span className="status-badge tone-done">{t('user.active')}</span>}</td>
        <td data-label={t('field.reportsTo')}>{isDirector ? <span className="muted-cell">{t('user.reportsToNobody')}</span>
          : <select aria-label={`${t('field.reportsTo')}: ${account.name}`} disabled={busy} value={account.managerId || ''} onChange={(event) => onChangeManager(account, event.target.value)}>
            <option value="">{t('user.noManager')}</option>
            {managerOptions.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}
          </select>}</td>
        <td data-label={t('field.workingArea')}>{isDirector ? <span className="muted-cell">{t('user.allOperations')}</span>
          : <select aria-label={`${t('field.workingArea')}: ${account.name}`} disabled={busy} value={account.coversAllSectors ? ALL_OPERATIONS : (account.sector || '')} onChange={(event) => onChangeSector(account, event.target.value)}>
            {!account.sector && !account.coversAllSectors && <option value="">{t('user.notAssigned')}</option>}
            {/* Offered only to managers: the API refuses it for a team member. */}
            {account.role === 'manager' && <option value={ALL_OPERATIONS}>{t('user.allOperations')}</option>}
            {sectors.map((sector) => <option key={sector.id} value={sector.id}>{sectorName(sector.id)}</option>)}
          </select>}</td>
        <td data-label={t('field.projects')}>{account.assignedProjects}</td>
        <td data-label={t('field.team')}>{account.teamSize || <span className="muted-cell">&mdash;</span>}</td>
        <td data-label={t('field.added')}>{account.createdAt ? formatShortDate(account.createdAt) : <span className="muted-cell">&mdash;</span>}</td>
        {/* Only ever a date. The stored value is a bcrypt hash, so there is no
            password here for anyone, the Director included, to read. */}
        <td data-label={t('field.password')}>{account.mustChangePassword
          ? <span className="muted-cell">{t('user.passwordTemporary')}</span>
          : account.passwordChangedAt ? <span className="muted-cell">{t('user.passwordReset')} {formatShortDate(account.passwordChangedAt)}</span> : <span className="muted-cell">{t('user.passwordOriginal')}</span>}</td>
        {/* Your own password is changed from the account menu, which asks for
            the current one; the Director's account cannot be suspended. */}
        <td className="card-actions">{isSelf
          ? <span className="muted-cell">{t('user.thisIsYou')}</span>
          : <>
            <button className="text-btn" disabled={busy} onClick={() => onResetPassword(account)} type="button">{t('action.changePassword')}</button>
            {!isDirector && (account.status === 'suspended'
              ? <button className="text-btn" disabled={busy} onClick={() => onSetStatus(account, 'active')} type="button">{t('action.reactivate')}</button>
              : <button className="danger-btn outlined" disabled={busy} onClick={() => onSetStatus(account, 'suspended')} type="button">{t('action.suspend')}</button>)}
          </>}</td>
      </tr>;
    })}
  </tbody></table></div> : <EmptyState>{empty}</EmptyState>;
}

function Metric({ label, value }) { return <div className="metric-card"><span>{label}</span><strong>{value}</strong></div>; }

function Panel({ title, subtitle, action, onAction, children }) { return <section className="panel"><div className="panel-header"><div><h2>{title}</h2>{subtitle && <span>{subtitle}</span>}</div>{action && <button className="text-btn" onClick={onAction} type="button">{action} &rarr;</button>}</div>{children}</section>; }
// The empty-state message on its own. It used to add "There is no data to
// display yet." under every one, which contradicted "No activities match the
// current filters" when there were activities, just not these.
function EmptyState({ children }) { return <div className="empty-state"><strong>{children}</strong></div>; }

// Where an activity is, in the same words as its journey on the record screen.
// A USD amount written in Rwandan and Congolese francs, for the readers who
// think in those. `rates` is either a record's own frozen rate or today's.
function localPair(amount, rates) {
  if (!rates?.rwfPerUsd || !rates?.cdfPerUsd) return null;
  return `${formatLocal(Number(amount || 0) * rates.rwfPerUsd, 'RWF')} · ${formatLocal(Number(amount || 0) * rates.cdfPerUsd, 'CDF')}`;
}

// The rate an activity was created at, kept on the row as its equivalents.
function ratesOf(activity) {
  if (!(activity.requestedBudget > 0) || !activity.requestedEquivalent) return null;
  return {
    rwfPerUsd: activity.requestedEquivalent.rwf / activity.requestedBudget,
    cdfPerUsd: activity.requestedEquivalent.cdf / activity.requestedBudget
  };
}

function StageBadge({ activity }) {
  const t = useT();
  const journey = activityJourney(activity);
  return <span className={`status-badge ${journeyTone(journey)}`}>{journeyLabel(journey, t)}</span>;
}

// Delete and the manager picker are the Director's; the API refuses anyone else,
// so a manager is no longer shown controls that could only ever fail.
function ProjectTable({ projects, managers, isDirector, busy, onShowActivities, onAssign, onDelete, empty }) {
  const t = useT();
  return projects.length ? <div className="table-wrap"><table className="card-table"><thead><tr><th>{t('field.project')}</th><th>{t('app.businessOperation')}</th><th>{t('field.location')}</th><th>{t('field.organizationOwner')}</th><th>{t('field.manager')}</th><th>{t('field.status')}</th><th>{t('table.progress')}</th><th>{t('money.approved')} (USD)</th><th>{t('money.spent')} (USD)</th><th>{t('table.actions')}</th></tr></thead><tbody>
    {projects.map((project) => {
      // A project is managed by someone who works its own operation.
      const managerOptions = managers.filter((manager) => manager.coversAllSectors || manager.sector === project.sector || manager.id === project.managerId);
      return <tr key={project.id}>
        <td className="card-title-cell"><strong>{project.name}</strong><small>{sectorName(project.sector)} · {project.location}</small></td>
        <td className="card-optional" data-label={t('app.businessOperation')}>{sectorName(project.sector)}</td>
        <td className="card-optional" data-label={t('field.location')}>{project.location}</td>
        <td className="card-optional" data-label={t('field.organizationOwner')}>{project.owner}</td>
        <td data-label={t('field.manager')}>{isDirector
          ? <select aria-label={`${t('field.manager')}: ${project.name}`} disabled={busy} value={project.managerId || ''} onChange={(event) => onAssign(project.id, event.target.value)}><option value="">{t('table.unassigned')}</option>{managerOptions.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}</select>
          : (project.managerName || <span className="muted-cell">{t('table.unassigned')}</span>)}</td>
        {/* Toned by meaning: "Delayed" used to be drawn in the same green as "On Track". */}
        <td data-label={t('field.status')}><span className={`status-badge ${project.status === 'Delayed' ? 'tone-stopped' : project.status === 'In Review' ? 'tone-waiting' : 'tone-done'}`}>{t(`status.${project.status}`)}</span></td>
        <td data-label={t('table.progress')}>{fill(t('projects.doneOf'), { done: project.completedCount, total: project.activityCount })}</td>
        <td data-label={`${t('money.approved')} (USD)`}>{formatUsd(project.approvedUsd)}</td>
        <td data-label={`${t('money.spent')} (USD)`}>{formatUsd(project.spentUsd)}</td>
        <td className="card-actions">
          <button className="text-btn" type="button" onClick={() => onShowActivities(project.id)}>{t('nav.activities')}</button>
          {isDirector && <button className="danger-btn" disabled={busy} onClick={() => onDelete(project)} type="button">{t('action.delete')}</button>}
        </td>
      </tr>;
    })}
  </tbody></table></div> : <EmptyState>{empty}</EmptyState>;
}

function ActivityTable({ activities, isDirector, openId, onOpen, empty }) {
  const t = useT();
  return activities.length ? <div className="table-wrap"><table className="card-table"><thead><tr>
    <th>{t('table.activity')}</th><th>{t('table.category')}</th><th>{t('activities.originalBudget')}</th><th>{t('approval.approved')}</th><th>{t('activities.adjustment')}</th><th>{t('table.status')}</th><th>{t('field.evidence')}</th><th>{t('people.requestedBy')}</th><th>{t('people.assignedTo')}</th><th>{t('table.actions')}</th>
  </tr></thead><tbody>
    {activities.map((activity) => {
      const awaiting = activity.status === 'Pending Approval' || (activity.completionSubmittedAt && activity.status !== 'Completed');
      const due = deadlineNote(activity, displayLanguage());
      return <tr key={activity.id} className={activity.id === openId ? 'row-selected' : undefined}>
        <td className="card-title-cell"><strong>{activity.activity}</strong><small>{activity.description || t('review.noDescription')}</small></td>
        <td className="card-optional" data-label={t('table.category')}>{categoryLabel(activity.category, t)}</td>
        <td className="card-optional" data-label={t('activities.originalBudget')}>{formatUsd(activity.requestedBudget)}</td>
        {/* In the local currencies as well, at the rate the record carries. */}
        <td data-label={t('approval.approved')}>{activity.approvedBudget === null
          ? <span className="muted-cell">{fill(t('activities.askedForAmount'), { amount: formatUsd(activity.requestedBudget) })}</span>
          : <>{formatUsd(activity.approvedBudget)}<small>{localPair(activity.approvedBudget, ratesOf(activity))}</small></>}</td>
        <td data-label={t('activities.adjustment')} className={activity.budgetAdjustment ? 'card-optional over-budget' : 'card-optional'}>
          {activity.budgetAdjustment ? `${activity.budgetAdjustment > 0 ? '+' : ''}${formatUsd(activity.budgetAdjustment)}` : <span className="muted-cell">&mdash;</span>}
        </td>
        {/* A pending record always names the person it is pending on, so the
            register never presents "Pending" as if anyone could act on it. */}
        <td data-label={t('table.status')}><StageBadge activity={activity} />
          {activity.approvalRequired && activity.approvalStatus === 'pending' && !['Draft', 'Cancelled', 'On Hold'].includes(activity.status)
            ? <small className="awaiting-flag">{t('approval.waitingFor')} {approverName(activity, sectorName, t)}</small>
            : awaiting && <small className="awaiting-flag">{t('activities.completionSubmitted')}</small>}</td>
        <td className="card-optional" data-label={t('field.evidence')}>{activity.evidenceCount ? `${activity.evidenceCount} × ${t('field.file')}` : <span className="muted-cell">{t('table.none')}</span>}</td>
        <td className="card-optional" data-label={t('people.requestedBy')}>{activity.createdByName || <span className="muted-cell">&mdash;</span>}</td>
        {/* Who the work sits with, and how its deadline stands. An overdue
            record is flagged here, not only inside the review screen. */}
        <td data-label={t('people.assignedTo')}>{activity.assignedToName
          ? <><strong>{activity.assignedToName}</strong>{activity.deadline && <small className={due && due.tone !== 'ok' ? `deadline-flag deadline-${due.tone}` : undefined}>
            {formatDate(activity.deadline)}{due && due.tone !== 'ok' ? ` · ${due.text}` : ''}
          </small>}</>
          : <span className="muted-cell">{t('table.unassigned')}</span>}</td>
        <td className="card-actions">
          <button className="text-btn" onClick={() => onOpen(activity.id)} type="button">{isDirector ? t('approval.review') : t('action.open')}</button>
        </td>
      </tr>;
    })}
  </tbody></table></div> : <EmptyState>{empty}</EmptyState>;
}

function ApprovalTable({ approvals, canDecide, busy, onDecide, empty }) {
  const t = useT();
  return approvals.length ? <div className="table-wrap"><table className="card-table"><thead><tr><th>{t('field.whatIsNeeded')}</th><th>{t('app.businessOperation')}</th><th>{t('field.amount')}</th><th>{t('field.organizationOwner')}</th><th>{t('field.priority')}</th><th>{t('table.status')}</th><th>{t('field.requestedBy')}</th><th>{t('field.added')}</th><th>{t('approval.yourDecision')}</th></tr></thead><tbody>
    {approvals.map((approval) => <tr key={approval.id}>
      <td className="card-title-cell"><strong>{approval.title}</strong>{approval.justification && <small className="justification">{approval.justification}</small>}<small>{approval.id}</small></td>
      <td data-label={t('app.businessOperation')}>{sectorName(approval.sector)}</td>
      <td data-label={t('field.amount')}>{formatRwf(approval.amount)}</td>
      <td data-label={t('field.organizationOwner')}>{approval.owner}</td>
      <td data-label={t('field.priority')}><span className="priority-badge">{t(`form.priority${approval.priority}`)}</span></td>
      <td data-label={t('table.status')}><span className={`status-badge status-${approval.status.toLowerCase()}`}>{t(`approval.${approval.status.toLowerCase()}`)}</span></td>
      <td data-label={t('field.requestedBy')}>{approval.requestedBy}</td>
      <td data-label={t('field.added')}>{formatShortDate(approval.createdAt)}</td>
      <td className="card-actions">
        {approval.status === 'Pending'
          ? (canDecide
            ? <div className="decision-actions"><button className="text-btn" disabled={busy} onClick={() => onDecide(approval, 'Approved')} type="button">{t('approval.approve')}</button><button className="danger-btn" disabled={busy} onClick={() => onDecide(approval, 'Rejected')} type="button">{t('action.decline')}</button></div>
            : <span className="muted-cell">{t('approval.awaitingDirector')}</span>)
          : <div className="decision-trail"><strong>{approval.decidedBy || t('approval.recorded')}</strong>{approval.decidedAt && <small>{formatShortDate(approval.decidedAt)}</small>}{approval.decisionNote && <small className="justification">{approval.decisionNote}</small>}</div>}
      </td>
    </tr>)}
  </tbody></table></div> : <EmptyState>{empty}</EmptyState>;
}

function Field({ label, wide, children }) { return <label className={wide ? 'form-field form-field-wide' : 'form-field'}><span>{label}</span>{children}</label>; }

function AccountForm({ form, setForm, managers, busy, onSubmit }) {
  const t = useT();
  // A manager heads an area, so they report to nobody and the field is hidden.
  const showsManager = form.role === 'staff';
  const managerOptions = managers.filter((manager) => manager.coversAllSectors || manager.sector === form.sector);
  return <form className="form-panel" id="account-form" onSubmit={onSubmit}>
    <div className="panel-header"><div><h2>{t('form.addUser')}</h2><span>{t('form.addUserBlurbHash')}</span></div></div>
    <div className="form-grid">
      <Field label={t('field.name')}><input required maxLength="150" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
      <Field label={t('field.username')}><input required maxLength="100" autoComplete="off" autoCapitalize="none" spellCheck="false" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} /></Field>
      <Field label={t('field.password')}><input required minLength={MINIMUM_PASSWORD_LENGTH} type="password" autoComplete="new-password" aria-describedby="account-password-hint" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /><small id="account-password-hint" className="field-hint">{t('form.temporaryPasswordHint')}</small></Field>
      {/* Switching to a team member drops an "all operations" choice that only a
          manager may hold, rather than submitting a value the API will refuse. */}
      <Field label={t('field.role')}><select required value={form.role} onChange={(event) => { const role = event.target.value; setForm({ ...form, role, managerId: '', sector: role !== 'manager' && form.sector === ALL_OPERATIONS ? '' : form.sector }); }}><option value="manager">{t('role.manager')}</option><option value="staff">{t('role.staff')}</option></select></Field>
      {/* Only a manager can carry every operation at once; a team member always
          sits in exactly one, so the choice is offered for managers alone. */}
      <Field label={t('field.workingArea')}><select required value={form.sector || ''} onChange={(event) => setForm({ ...form, sector: event.target.value, managerId: '' })}><option value="">{t('form.selectOperation')}</option>{form.role === 'manager' && <option value={ALL_OPERATIONS}>{t('user.allOperations')}</option>}{sectors.map((sector) => <option key={sector.id} value={sector.id}>{sectorName(sector.id)}</option>)}</select></Field>
      {showsManager && <Field label={t('field.reportsTo')}><select value={form.managerId || ''} onChange={(event) => setForm({ ...form, managerId: event.target.value })} disabled={!form.sector}><option value="">{t('form.noManagerYet')}</option>{managerOptions.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}</select></Field>}
    </div>
    <div className="form-submit-bar"><button className="primary-btn" type="submit" disabled={busy}>{form.role === 'manager' ? t('form.addManager') : t('form.addTeamMember')}</button></div>
  </form>;
}

function ProjectForm({ form, setForm, managers, busy, onSubmit }) {
  const t = useT();
  const managerOptions = managers.filter((manager) => manager.coversAllSectors || manager.sector === form.sector);
  return <form className="form-panel" id="project-form" onSubmit={onSubmit}>
    <div className="panel-header"><div><h2>{t('form.addProject')}</h2><span>{t('form.addProjectBlurb')}</span></div></div>
    <div className="form-grid">
      <Field label={t('field.name')}><input required maxLength="200" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
      <Field label={t('app.businessOperation')}><select value={form.sector} onChange={(event) => setForm({ ...form, sector: event.target.value, managerId: '' })}>{sectors.map((sector) => <option key={sector.id} value={sector.id}>{sectorName(sector.id)}</option>)}</select></Field>
      <Field label={t('field.location')}><input required maxLength="200" value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} /></Field>
      <Field label={t('field.organizationOwner')}><input required maxLength="200" value={form.owner} onChange={(event) => setForm({ ...form, owner: event.target.value })} /></Field>
      <Field label={t('field.status')}><select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>{PROJECT_STATUSES.map((option) => <option key={option} value={option}>{t(`status.${option}`)}</option>)}</select></Field>
      <Field label={t('field.category')}><input required maxLength="100" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} /></Field>
      <Field label={t('field.manager')}><select value={form.managerId} onChange={(event) => setForm({ ...form, managerId: event.target.value })}><option value="">{t('table.unassigned')}</option>{managerOptions.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}</select></Field>
    </div>
    <p className="field-hint">{t('projects.figuresAutomatic')}</p>
    <div className="form-submit-bar"><button className="primary-btn" type="submit" disabled={busy}>{t('form.addProject')}</button></div>
  </form>;
}

// One form for both ways in. A manager fills it to raise work and the budget it
// needs, which the Director then decides; the Director fills it to hand work
// out, and the three fields at the end -- who carries it out, by when, and on
// what terms -- are theirs alone.
function ActivityForm({ form, setForm, projects, selectedProject, managers, isDirector, usd, rate, busy, onChooseProject, onSubmit, onCancel }) {
  const t = useT();
  // A manager only ever reads their own working area, so only the managers who
  // cover the chosen area can be handed the work. The API refuses the rest.
  // A manager covering every operation can take work in any of them, so they
  // belong in every list alongside that operation's own managers.
  const managerOptions = managers.filter((manager) => manager.coversAllSectors || manager.sector === form.sector);
  // What is still missing, said plainly next to the button, rather than a
  // disabled button with no explanation.
  const missing = [
    !form.projectId && t('field.project'),
    !form.category.trim() && t('field.category'),
    !form.activity.trim() && t('field.activity'),
    !(Number(form.quantity) > 0) && t('field.quantity'),
    form.costUsd === '' && (isDirector ? t('form.budgetUsd') : t('form.requestedBudgetUsd')),
    isDirector && !form.assignedTo && t('field.carriedOutBy')
  ].filter(Boolean);

  return <form className="form-panel" id="activity-form" onSubmit={onSubmit}>
    <div className="panel-header"><div>
      <h2>{isDirector ? t('form.assignAnActivity') : t('form.raiseAnActivity')}</h2>
      <span>
        {selectedProject ? `${t('form.selectedProject')}: ${selectedProject.name} · ` : `${t('form.selectProjectFirst')} `}
        {isDirector ? t('form.goesToManager') : t('form.submittedToDirector')}
      </span>
    </div></div>
    {/* The four things every request needs first; where it belongs and the
        longer explanations follow. A manager with one project and one operation
        is never asked to choose them. */}
    <div className="form-grid activity-grid">
      <Field label={t('field.activity')} wide>
        <input required maxLength="200" placeholder={t('form.activityPlaceholder')} value={form.activity} onChange={(event) => setForm({ ...form, activity: event.target.value })} />
      </Field>
      {/* What the work is for. It was moved under "More details" and people
          missed it, so it is back among the first questions. */}
      <Field label={t('field.description')} wide>
        <textarea rows="2" placeholder={isDirector ? t('form.whatWorkInvolves') : t('form.whyWorkNeeded')} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
      </Field>
      <Field label={t('field.category')}>
        <select required value={form.categoryChoice} onChange={(event) => { const choice = event.target.value; setForm({ ...form, categoryChoice: choice, category: choice === OTHER_CATEGORY ? '' : choice }); }}>
          <option value="">{t('form.selectCategory')}</option>
          {categoriesForSector(form.sector).map((category) => <option key={category} value={category}>{categoryLabel(category, t)}</option>)}
          <option value={OTHER_CATEGORY}>{t('form.otherSpecify')}</option>
        </select>
      </Field>
      {form.categoryChoice === OTHER_CATEGORY && <Field label={t('field.specifyCategory')}>
        <input required maxLength="100" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} />
      </Field>}
      <Field label={isDirector ? t('form.budgetUsd') : t('form.requestedBudgetUsd')}>
        <input required type="number" inputMode="decimal" min="0" step="0.01" placeholder={isDirector ? t('form.amountReleased') : t('form.amountNeeded')} value={form.costUsd} onChange={(event) => setForm({ ...form, costUsd: event.target.value })} />
        {/* At the Director's current reference rate, the same one the Movements
            module uses -- not a figure fixed in the code. */}
        {usd > 0 && <small className="field-hint">≈ RWF {formatNumber(round2(usd * rate.rwfPerUsd))} · CDF {formatNumber(round2(usd * rate.cdfPerUsd))}</small>}
      </Field>
      <Field label={t('field.quantity')}>
        <input required type="number" inputMode="decimal" min="0.01" step="0.01" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} />
      </Field>
      {/* One question, not two: every project belongs to a business operation,
          so choosing the project sets the operation, the categories offered and
          the managers who can be given the work. The operation was a second
          dropdown that repeated the project's own answer. */}
      {projects.length !== 1 && <Field label={t('field.project')}>
        <select required value={form.projectId} onChange={(event) => onChooseProject(event.target.value)}>
          <option value="">{t('form.selectProject')}</option>
          {sectors.filter((sector) => projects.some((project) => project.sector === sector.id))
            .map((sector) => <optgroup key={sector.id} label={sectorName(sector.id)}>
              {projects.filter((project) => project.sector === sector.id)
                .map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </optgroup>)}
        </select>
        {selectedProject && <small className="field-hint">{fill(t('form.projectOperation'), { operation: sectorName(selectedProject.sector) })}</small>}
      </Field>}
      {isDirector && <>
        <Field label={t('field.carriedOutBy')}>
          <select required value={form.assignedTo} onChange={(event) => setForm({ ...form, assignedTo: event.target.value })} disabled={!managerOptions.length}>
            <option value="">{t('form.selectManager')}</option>
            {managerOptions.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}
          </select>
        </Field>
        <Field label={t('field.deadline')}>
          <input type="date" value={form.deadline} onChange={(event) => setForm({ ...form, deadline: event.target.value })} />
        </Field>
      </>}
    </div>
    <details className="form-more">
      <summary>{t('form.moreDetails')}</summary>
      <div className="form-grid">
        <Field label={isDirector ? t('form.materialsToBuy') : t('form.materialsRequested')} wide>
          <textarea rows="3" placeholder={t('form.onePerLine')} value={form.materials} onChange={(event) => setForm({ ...form, materials: event.target.value })} />
        </Field>
        {isDirector && <Field label={t('field.instructionsForManager')} wide>
          <textarea rows="3" value={form.instructions} onChange={(event) => setForm({ ...form, instructions: event.target.value })} />
        </Field>}
        <label className="check-field"><input type="checkbox" checked={form.signed} onChange={(event) => setForm({ ...form, signed: event.target.checked })} />{t('form.signed')}</label>
      </div>
    </details>
    {isDirector && !managerOptions.length && <p className="decision-hint">{t('form.noManagerCovers')}</p>}
    <div className="form-submit-bar">
      {missing.length > 0 && <p className="form-missing">{t('form.stillNeeded')}: {missing.join(', ')}</p>}
      {onCancel && <button className="secondary-btn" type="button" onClick={onCancel}>{t('action.cancel')}</button>}
      <button className="primary-btn" disabled={busy || missing.length > 0} type="submit">{isDirector ? t('action.assignActivity') : t('form.submitForReview')}</button>
    </div>
  </form>;
}

function ApprovalForm({ form, setForm, sectorOptions, busy, onSubmit }) {
  const t = useT();
  return <form className="form-panel" onSubmit={onSubmit}>
    <div className="panel-header"><div><h2>{t('form.raiseRequest')}</h2><span>{t('form.raiseRequestBlurb')}</span></div></div>
    <div className="form-grid">
      <Field label={t('field.whatIsNeeded')}><input required maxLength="200" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></Field>
      <Field label={t('app.businessOperation')}><select value={form.sector} onChange={(event) => setForm({ ...form, sector: event.target.value })}>{sectorOptions.map((sector) => <option key={sector.id} value={sector.id}>{sectorName(sector.id)}</option>)}</select></Field>
      <Field label={t('field.estimatedAmount')}><input required type="number" inputMode="decimal" min="0" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></Field>
      <Field label={t('field.organizationOwner')}><input required maxLength="150" value={form.owner} onChange={(event) => setForm({ ...form, owner: event.target.value })} /></Field>
      <Field label={t('field.priority')}><select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })}>{[['Low', 'form.priorityLow'], ['Medium', 'form.priorityMedium'], ['High', 'form.priorityHigh']].map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}</select></Field>
      <Field label={t('field.requestedBy')}><input readOnly tabIndex={-1} value={form.requestedBy} /></Field>
      <Field label={t('field.reasonForRequest')}><textarea required rows="3" value={form.justification} onChange={(event) => setForm({ ...form, justification: event.target.value })} /></Field>
    </div>
    <div className="form-submit-bar"><button className="primary-btn" type="submit" disabled={busy}>{t('action.sendForApproval')}</button></div>
  </form>;
}

// The Reports section: pick a period, read the figures, take them away.
//
// Every number below is computed on the server from the activity register, and
// the PDF and Excel exports run the very same scoped query, so what a manager
// downloads is exactly what a manager can see.
function ReportsSection({ mode, range, report, busy, sectorLabel, onModeChange, onRangeChange, onGenerate, onExport, onPrint, onClose }) {
  const t = useT();
  const ready = mode !== 'custom' || (range.start && range.end && range.start <= range.end);

  return <section className="report-area report-print-area">
    <div className="panel-header">
      <div>
        <h2>{t('report.title')}</h2>
        <span>{t('report.blurb')}</span>
      </div>
      <div className="report-actions report-controls" role="group" aria-label={t('report.title')}>
        {REPORT_MODES.map(([id, key]) => <button
          key={id}
          className={mode === id ? 'primary-btn' : 'secondary-btn'}
          aria-pressed={mode === id}
          onClick={() => onModeChange(id)}
          type="button"
        >{t(key)}</button>)}
      </div>
    </div>

    <div className="report-picker report-controls">
      {mode === 'weekly' && <Field label={t('report.anyDayInWeek')}>
        <input type="date" value={range.week} onChange={(event) => onRangeChange({ week: event.target.value })} />
      </Field>}
      {mode === 'monthly' && <Field label={t('report.month')}>
        <input type="month" value={range.month} onChange={(event) => onRangeChange({ month: event.target.value })} />
      </Field>}
      {mode === 'custom' && <>
        <Field label={t('report.startDate')}>
          <input type="date" value={range.start} onChange={(event) => onRangeChange({ start: event.target.value })} />
        </Field>
        <Field label={t('report.endDate')}>
          <input type="date" value={range.end} onChange={(event) => onRangeChange({ end: event.target.value })} />
        </Field>
      </>}
      <button className="primary-btn" type="button" disabled={busy || !ready} onClick={onGenerate}>
        {busy ? t('report.working') : t('action.generateReport')}
      </button>
      {mode === 'custom' && !ready && <span className="report-hint">{t('report.chooseValidRange')}</span>}
    </div>

    {report && <ReportBody
      report={report}
      busy={busy}
      sectorLabel={sectorLabel}
      onExport={onExport}
      onPrint={onPrint}
      onClose={onClose}
    />}
  </section>;
}

function ReportBody({ report, busy, sectorLabel, onExport, onPrint, onClose }) {
  const t = useT();
  const counts = report.activitySummary;
  const budget = report.budgetSummary;

  return <div className="report-result-body">
    <div className="report-meta">
      <div>
        <strong>{report.period.label}</strong>
        <span>
          {formatDate(report.period.start)} {t('report.to')} {formatDate(report.period.end)} &middot; {sectorName(report.scope.sector) || report.scope.sectorName}
          {' '}&middot; {t('report.generated')} {new Date(report.generatedAt).toLocaleString(displayLanguage())}
        </span>
      </div>
      <div className="report-actions report-controls">
        <button className="secondary-btn" type="button" disabled={busy} onClick={() => onExport('pdf')}>{t('action.exportPdf')}</button>
        <button className="secondary-btn" type="button" disabled={busy} onClick={() => onExport('xlsx')}>{t('action.exportExcel')}</button>
        <button className="secondary-btn" type="button" onClick={onPrint}>{t('action.print')}</button>
        <button className="text-btn" type="button" onClick={onClose}>{t('action.close')}</button>
      </div>
    </div>

    {counts.total === 0
      ? <div className="empty-state">
        <strong>{t('report.noneInPeriod')}</strong>
        <span>{t('report.nothingBetween')}</span>
      </div>
      : <>
        <h3 className="form-section-title">{t('report.activitySummary')}</h3>
        {/* Overdue cuts across the other counts rather than being one of them,
            so these six are not meant to add up to the total. */}
        <div className="metric-grid metric-grid-6">
          <Metric label={t('report.totalActivities')} value={counts.total} />
          <Metric label={t('portal.completed')} value={counts.completed} />
          <Metric label={t('portal.inProgress')} value={counts.inProgress} />
          <Metric label={t('approval.pending')} value={counts.pending} />
          <Metric label={t('report.overdue')} value={counts.overdue} />
          <Metric label={t('status.Cancelled')} value={counts.cancelled} />
        </div>

        <h3 className="form-section-title">{t('report.budgetSummary')}</h3>
        <div className="budget-strip budget-strip-4">
          {/* Each figure in the local currencies too, at the rate the report
              was generated with (it carries that rate with it). */}
          <div className="budget-block">
            <span>{t('report.totalAssignedBudget')}</span>
            <strong>{formatUsd(budget.assigned)}</strong>
            <small className="money-equivalent">{localPair(budget.assigned, report.rate)}</small>
            <small>{t('report.assignedHint')}</small>
          </div>
          <div className={`budget-block${budget.revised !== budget.assigned ? ' budget-adjusted' : ''}`}>
            <span>{t('report.totalRevisedBudget')}</span>
            <strong>{formatUsd(budget.revised)}</strong>
            <small className="money-equivalent">{localPair(budget.revised, report.rate)}</small>
            <small>{budget.revised === budget.assigned
              ? t('report.unchangedOnReview')
              : fill(t('report.againstOriginal'), { change: `${budget.revised > budget.assigned ? '+' : ''}${formatUsd(budget.revised - budget.assigned)}` })}</small>
          </div>
          <div className="budget-block">
            <span>{t('report.totalActualSpending')}</span>
            <strong>{formatUsd(budget.spent)}</strong>
            <small className="money-equivalent">{localPair(budget.spent, report.rate)}</small>
            <small>{fill(t('report.utilisationHint'), { percent: budget.utilisation })}</small>
          </div>
          <div className={`budget-block${budget.remaining < 0 ? ' budget-adjusted' : ''}`}>
            <span>{t('report.remainingBudget')}</span>
            <strong>{formatUsd(budget.remaining)}</strong>
            <small className="money-equivalent">{localPair(budget.remaining, report.rate)}</small>
            <small>{budget.remaining < 0 ? t('report.overspent') : t('report.releasedNotSpent')}</small>
          </div>
        </div>
        {report.rate?.rwfPerUsd > 0 && <p className="field-hint">
          {t('money.todayRate')}: 1 USD = {formatLocal(report.rate.rwfPerUsd, 'RWF')} = {formatLocal(report.rate.cdfPerUsd, 'CDF')}
        </p>}

        <h3 className="form-section-title">{t('report.managerPerformance')}</h3>
        <div className="table-wrap"><table className="card-table">
          <thead><tr>
            <th>{t('field.manager')}</th><th>{t('report.activitiesAssigned')}</th><th>{t('portal.completed')}</th><th>{t('portal.inProgress')}</th>
            <th>{t('report.overdue')}</th><th>{t('report.totalBudgetHandled')}</th><th>{t('field.spent')}</th>
          </tr></thead>
          <tbody>{report.managers.map((entry) => <tr key={entry.managerId ?? 'unassigned'}>
            <td className="card-title-cell"><strong>{entry.managerId === null ? t('table.unassigned') : entry.managerName}</strong>
              {entry.managerId === null && <small className="muted-cell">{t('report.unassignedWork')}</small>}</td>
            <td data-label={t('report.activitiesAssigned')}>{entry.assigned}</td>
            <td data-label={t('portal.completed')}>{entry.completed}</td>
            <td data-label={t('portal.inProgress')}>{entry.inProgress}</td>
            <td data-label={t('report.overdue')} className={entry.overdue ? 'over-budget' : undefined}>{entry.overdue || <span className="muted-cell">0</span>}</td>
            <td data-label={t('report.totalBudgetHandled')}>{formatUsd(entry.budgetHandled)}</td>
            <td data-label={t('field.spent')}>{formatUsd(entry.spent)}</td>
          </tr>)}</tbody>
        </table></div>

        <h3 className="form-section-title">{t('report.activityDetails')}</h3>
        <div className="table-wrap scroll-hint"><table className="report-detail-table">
          <thead><tr>
            <th>{t('table.activity')}</th><th>{t('report.projectArea')}</th><th>{t('report.assignedManager')}</th>
            <th>{t('activities.originalBudget')}</th><th>{t('report.revisedBudget')}</th><th>{t('report.actualSpending')}</th>
            <th>{t('table.status')}</th><th>{t('report.dateAssigned')}</th><th>{t('report.completionDate')}</th><th>{t('report.adminNotes')}</th>
          </tr></thead>
          <tbody>{report.activities.map((item) => <tr key={item.id}>
            <td><strong>{item.activity}</strong><small>{categoryLabel(item.category, t)}</small></td>
            <td>{item.projectName}<small className="muted-cell">{sectorLabel(item.sector)}</small></td>
            <td>{item.assignedToName || <span className="muted-cell">{t('review.notAssigned')}</span>}</td>
            <td>{formatUsd(item.originalBudget)}</td>
            {/* An undecided budget is not a zero, and showing it as one would
                read as the Director having released nothing. */}
            <td className={item.budgetAdjustment ? 'over-budget' : undefined}>
              {item.revisedBudget === null
                ? <span className="muted-cell">{t('activities.notDecided')}</span>
                : <>{formatUsd(item.revisedBudget)}
                  {item.budgetAdjustment ? <small>{item.budgetAdjustment > 0 ? '+' : ''}{formatUsd(item.budgetAdjustment)}</small> : null}</>}
            </td>
            <td>{formatUsd(item.actualSpending)}
              <small className={item.remainingBudget < 0 ? 'over-budget' : 'muted-cell'}>
                {fill(t('report.left'), { amount: formatUsd(item.remainingBudget) })}
              </small></td>
            <td><span className={`status-badge ${statusTone(item.status)}`}>{t(`status.${item.status}`)}</span>
              {item.overdue && <small className="deadline-flag deadline-overdue">{t('report.overdue')}</small>}</td>
            <td>{item.dateAssigned ? formatDate(item.dateAssigned) : <span className="muted-cell">&mdash;</span>}</td>
            <td>{item.completionDate ? formatDate(item.completionDate) : <span className="muted-cell">&mdash;</span>}</td>
            <td className="report-note-cell"><ReportNotes item={item} /></td>
          </tr>)}</tbody>
        </table></div>
      </>}
  </div>;
}

// Why a budget moved, which is the whole point of keeping the original figure
// beside the revised one. The Director's standing note, the trail of what they
// actually changed it to, and any request a manager raised, all read together.
function ReportNotes({ item }) {
  const t = useT();
  const hasAnything = item.adminNote || item.budgetRevisions.length || item.budgetRequests.length;
  if (!hasAnything) return <span className="muted-cell">&mdash;</span>;

  return <div className="report-notes">
    {item.adminNote && <span className="admin-note">&ldquo;{item.adminNote}&rdquo;</span>}
    {item.budgetRevisions.map((change, index) => <small key={`revision-${index}`}>
      {change.from === null ? t('report.notSet') : formatUsd(change.from)} &rarr; {change.to === null ? t('report.notSet') : formatUsd(change.to)}
      {change.changedBy ? ` · ${change.changedBy}` : ''}
      {change.note ? ` — ${change.note}` : ''}
    </small>)}
    {item.budgetRequests.map((request, index) => <small key={`request-${index}`}>
      {fill(t('report.askedFor'), { name: request.requestedBy || t('role.manager'), amount: formatUsd(request.requestedAmount) })}: {request.reason}
      {' '}({request.status === 'Pending' ? t('report.awaitingAnswer') : t(`budgetRequest.status.${request.status}`)})
      {request.decisionNote ? ` — ${request.decisionNote}` : ''}
    </small>)}
  </div>;
}

export default App;
