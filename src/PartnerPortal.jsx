import { useCallback, useEffect, useState } from 'react';
import { operationName } from '../shared/businessOperations.js';
import { categoryLabel } from './ActivityReview.jsx';

// External Business Partner / Business Operation Access.
//
// The whole application, as seen by someone outside the organisation who has
// been given one or more business operations to follow. It is not a cut-down
// copy of the internal screens: it reads a different API (/api/partner/*) that
// returns only approved, externally released records for the operations the
// Director granted their account.
//
// The one thing written from here is a comment to the Director. No approve, no
// reject, no edit, no internal notes, no evidence, no audit trail, no operation
// outside their grants. That is enforced by the backend -- authMiddleware
// refuses a partner account anything outside /api/partner, and the partner
// routes scope every query to the grants -- and this file has nothing else to draw.

const TABS = [
  ['overview', 'nav.overview'],
  ['activities', 'nav.activities'],
  ['movements', 'nav.movements'],
  ['reports', 'nav.reports'],
  ['updates', 'nav.updates'],
  ['messages', 'portal.messages']
];

function formatMoney(value) {
  return `$${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0))}`;
}

function formatDate(value, language) {
  if (!value) return '—';
  const text = String(value).slice(0, 10);
  const [year, month, day] = text.split('-').map(Number);
  if (!year || !month || !day) return text;
  return new Date(year, month - 1, day).toLocaleDateString(language);
}

function formatDateTime(value, language) {
  return value ? new Date(value).toLocaleString(language) : '—';
}

function statusTone(status) {
  if (status === 'Completed') return 'tone-done';
  if (status === 'In Progress' || status === 'Funds Released') return 'tone-active';
  return 'tone-waiting';
}

// The tab is carried in the address (#/activities, #/reports ...) by the shell,
// so the back button steps between tabs and a refresh keeps the one open.
export default function PartnerPortal({ user, fetchJson, language, t, tab = 'overview', onTab, onError }) {
  const [overview, setOverview] = useState(null);
  const [activities, setActivities] = useState([]);
  const [movements, setMovements] = useState([]);
  const [report, setReport] = useState(null);
  const [updates, setUpdates] = useState([]);
  const [threads, setThreads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // '' reads every operation the partner was granted; an id narrows to that
  // one. The API refuses an operation outside the grants, so this can only
  // ever narrow.
  const [scope, setScope] = useState('');

  const granted = overview?.operations || [user.sector];
  const operation = scope
    ? operationName(scope, language)
    : granted.map((id) => operationName(id, language)).join(' · ');

  const load = useCallback(async () => {
    setLoading(true);
    const narrow = scope ? `&operation=${encodeURIComponent(scope)}` : '';
    try {
      const [overviewResult, activityResult, movementResult, reportResult, updateResult, threadResult] = await Promise.all([
        fetchJson(`/api/partner/overview?${narrow.slice(1)}`),
        fetchJson(`/api/partner/activities?limit=100${narrow}`),
        fetchJson(`/api/partner/movements?limit=100${narrow}`),
        fetchJson(`/api/partner/report?months=6${narrow}`),
        fetchJson(`/api/partner/updates?limit=30${narrow}`),
        fetchJson('/api/partner/comments').catch(() => [])
      ]);
      setOverview(overviewResult);
      setActivities(activityResult);
      setMovements(movementResult);
      setReport(reportResult);
      setUpdates(updateResult);
      setThreads(threadResult);
      setFailed(false);
    } catch (loadError) {
      setFailed(true);
      onError(loadError.message);
    } finally {
      setLoading(false);
    }
  }, [fetchJson, onError, scope]);

  // Handlers report success so the form clears only once a message is saved.
  const sendComment = useCallback(async (comment) => {
    try {
      await fetchJson('/api/partner/comments', { method: 'POST', body: JSON.stringify(comment) });
      setThreads(await fetchJson('/api/partner/comments'));
      return true;
    } catch (sendError) { onError(sendError.message); return false; }
  }, [fetchJson, onError]);

  const sendReply = useCallback(async (thread, body) => {
    try {
      await fetchJson(`/api/partner/comments/${thread.id}/replies`, { method: 'POST', body: JSON.stringify({ body }) });
      setThreads(await fetchJson('/api/partner/comments'));
      return true;
    } catch (sendError) { onError(sendError.message); return false; }
  }, [fetchJson, onError]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <div className="loading-state"><span className="spinner" />{t('app.loading')}</div>;
  }
  if (failed && !overview) {
    return <div className="empty-state load-issue">
      <strong>{t('app.loadFailed')}</strong>
      <button className="secondary-btn" type="button" onClick={load}>{t('action.retry')}</button>
    </div>;
  }

  return <>
    <section className="welcome-strip partner-strip">
      <div>
        <span className="eyebrow">{t('portal.title')}</span>
        <h2>{t('portal.welcome')}: {operation}</h2>
        <p>{t('portal.accessNote')}</p>
      </div>
      <div className="partner-access-chip">
        <span>{t('partners.accessLevel')}</span>
        <strong>{t('partners.viewOnly')}</strong>
      </div>
    </section>

    {/* Only drawn when there is a choice: a partner following one operation
        has nothing to pick. */}
    {granted.length > 1 && <section className="toolbar-row"><div className="filter-group">
      <select value={scope} onChange={(event) => setScope(event.target.value)} aria-label={t('app.businessOperation')}>
        <option value="">{t('portal.allMyOperations')}</option>
        {granted.map((id) => <option key={id} value={id}>{operationName(id, language)}</option>)}
      </select>
    </div></section>}

    <p className="partner-notice">
      <strong>{t('portal.approvedOnly')}.</strong> {t('portal.approvedOnlyNote')}
    </p>

    <nav className="partner-tabs" aria-label={t('portal.title')}>
      {TABS.map(([id, labelKey]) => <button
        key={id}
        type="button"
        className={tab === id ? 'partner-tab active' : 'partner-tab'}
        aria-current={tab === id ? 'page' : undefined}
        onClick={() => onTab?.(id)}
      >{t(labelKey)}</button>)}
    </nav>

    {tab === 'overview' && overview && <>
      <div className="metric-grid metric-grid-5">
        <Metric label={t('portal.activities')} value={overview.activities.total} />
        <Metric label={t('portal.inProgress')} value={overview.activities.inProgress} />
        <Metric label={t('portal.completed')} value={overview.activities.completed} />
        <Metric label={t('portal.completionRate')} value={`${overview.activities.completionRate}%`} />
        <Metric label={t('portal.movements')} value={overview.movements.total} />
      </div>
      <Panel title={t('portal.approvedBudget')} subtitle={operation}>
        <div className="partner-budget">{formatMoney(overview.activities.approvedBudget)}</div>
      </Panel>
      <Panel title={t('portal.recentUpdates')} subtitle={operation}>
        <ActivityTable rows={overview.recentActivities} language={language} t={t} empty={t('portal.noActivities')} />
      </Panel>
    </>}

    {tab === 'activities' && <Panel
      title={t('portal.activities')}
      subtitle={`${activities.length} · ${operation}`}
    >
      <ActivityTable rows={activities} language={language} t={t} empty={t('portal.noActivities')} />
    </Panel>}

    {tab === 'movements' && <Panel
      title={t('portal.movements')}
      subtitle={`${movements.length} · ${operation}`}
    >
      {movements.length ? <div className="table-wrap"><table className="card-table">
        <thead><tr>
          <th>{t('table.purpose')}</th><th>{t('table.destination')}</th><th>{t('table.date')}</th>
          <th>{t('table.budget')}</th><th>{t('table.status')}</th>
        </tr></thead>
        <tbody>{movements.map((movement) => <tr key={movement.id}>
          <td className="card-title-cell"><strong>{movement.purpose}</strong><small>{movement.ref} · {t(`mtype.${movement.movementType}`)}</small></td>
          <td data-label={t('table.destination')}>{movement.origin ? `${movement.origin} → ` : ''}{movement.destination}</td>
          <td data-label={t('table.date')}>{formatDate(movement.departureDate, language)}</td>
          <td data-label={t('table.budget')}>{movement.currency} {new Intl.NumberFormat(language).format(movement.estimatedTotal)}</td>
          <td data-label={t('table.status')}><span className={`status-badge ${statusTone(movement.status)}`}>{t(`status.${movement.status}`)}</span></td>
        </tr>)}</tbody>
      </table></div> : <EmptyState t={t}>{t('portal.noMovements')}</EmptyState>}
    </Panel>}

    {tab === 'reports' && report && <>
      <Panel title={t('portal.byMonth')} subtitle={operation}>
        {report.byMonth.length ? <div className="table-wrap"><table className="card-table">
          <thead><tr>
            <th>{t('portal.period')}</th><th>{t('portal.activities')}</th>
            <th>{t('portal.completed')}</th><th>{t('portal.approvedBudget')}</th>
          </tr></thead>
          <tbody>{report.byMonth.map((row) => <tr key={row.period}>
            <td className="card-title-cell"><strong>{row.period}</strong></td>
            <td data-label={t('portal.activities')}>{row.activities}</td>
            <td data-label={t('portal.completed')}>{row.completed}</td>
            <td data-label={t('portal.approvedBudget')}>{formatMoney(row.approvedBudget)}</td>
          </tr>)}</tbody>
        </table></div> : <EmptyState t={t}>{t('portal.noActivities')}</EmptyState>}
      </Panel>
      <Panel title={t('portal.byCategory')} subtitle={operation}>
        {report.byCategory.length ? <div className="table-wrap"><table className="card-table">
          <thead><tr>
            <th>{t('table.category')}</th><th>{t('portal.activities')}</th><th>{t('portal.approvedBudget')}</th>
          </tr></thead>
          <tbody>{report.byCategory.map((row) => <tr key={row.category}>
            <td className="card-title-cell"><strong>{categoryLabel(row.category, t)}</strong></td>
            <td data-label={t('portal.activities')}>{row.activities}</td>
            <td data-label={t('portal.approvedBudget')}>{formatMoney(row.approvedBudget)}</td>
          </tr>)}</tbody>
        </table></div> : <EmptyState t={t}>{t('portal.noActivities')}</EmptyState>}
      </Panel>
    </>}

    {tab === 'updates' && <Panel title={t('portal.recentUpdates')} subtitle={operation}>
      {updates.length ? <ul className="history-list">{updates.map((update) => <UpdateItem
        key={update.id} update={update} language={language} t={t} onSend={sendComment} />)}</ul>
        : <EmptyState t={t}>{t('portal.noUpdates')}</EmptyState>}
    </Panel>}

    {tab === 'messages' && <PartnerMessages
      threads={threads}
      granted={granted}
      activities={activities}
      language={language}
      t={t}
      onSend={sendComment}
      onReply={sendReply}
    />}
  </>;
}

// One thing that happened, with a comment on it written where it was read. The
// comment goes to the Director like any other (about this activity, which the
// API re-checks the partner can see) and the answer comes back under Messages;
// before this the only way to remark on an update was to go to Messages and
// find the same activity again in a list.
function UpdateItem({ update, language, t, onSend }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    if (sending || !body.trim()) return;
    setSending(true);
    const saved = await onSend({ operation: update.operation, subjectType: 'activity', subjectId: update.activityId, body: body.trim() });
    setSending(false);
    if (saved) { setBody(''); setOpen(false); setSent(true); }
  };

  return <li className="partner-update">
    <div className="partner-update-head">
      <div>
        <strong>{update.activity}</strong>
        <span>{t('portal.milestone')}: {t(`status.${update.milestone}`)}</span>
        <small>{operationName(update.operation, language)} · {formatDateTime(update.at, language)}</small>
      </div>
      {!open && update.activityId && <button className="secondary-btn" type="button" onClick={() => { setOpen(true); setSent(false); }}>{t('portal.comment')}</button>}
    </div>
    {sent && <p className="field-hint" role="status">{t('portal.commentSent')}</p>}
    {open && <form className="partner-update-comment" onSubmit={submit}>
      <textarea rows="3" maxLength={2000} aria-label={t('portal.yourComment')} placeholder={t('portal.yourComment')}
        value={body} onChange={(event) => setBody(event.target.value)} autoFocus />
      <div className="button-row">
        <button className="primary-btn" type="submit" disabled={sending || !body.trim()}>{t('portal.sendToDirector')}</button>
        <button className="text-btn" type="button" disabled={sending} onClick={() => setOpen(false)}>{t('action.cancel')}</button>
      </div>
    </form>}
  </li>;
}

// Comments to the Director and the Director's answers. Addressed to the
// Director only -- managers never see them -- about an operation the partner
// follows, or one of the activities listed in this portal.
function PartnerMessages({ threads, granted, activities, language, t, onSend, onReply }) {
  const [form, setForm] = useState({ operation: granted[0], subject: '', body: '' });
  const [replies, setReplies] = useState({});
  const [sending, setSending] = useState(false);
  const subjects = activities.filter((activity) => activity.operation === form.operation);

  const submit = async (event) => {
    event.preventDefault();
    if (sending || !form.body.trim()) return;
    setSending(true);
    const saved = await onSend({
      operation: form.operation,
      subjectType: form.subject ? 'activity' : 'operation',
      subjectId: form.subject || null,
      body: form.body.trim()
    });
    setSending(false);
    if (saved) setForm({ ...form, subject: '', body: '' });
  };

  const reply = async (event, thread) => {
    event.preventDefault();
    const body = (replies[thread.id] || '').trim();
    if (sending || !body) return;
    setSending(true);
    const saved = await onReply(thread, body);
    setSending(false);
    if (saved) setReplies({ ...replies, [thread.id]: '' });
  };

  return <>
    <form className="form-panel" onSubmit={submit}>
      <div className="panel-header"><div>
        <h2>{t('portal.writeToDirector')}</h2>
        <span>{t('portal.writeToDirectorBlurb')}</span>
      </div></div>
      <div className="form-grid">
        <label className="form-field"><span>{t('app.businessOperation')}</span>
          <select value={form.operation} onChange={(event) => setForm({ ...form, operation: event.target.value, subject: '' })}>
            {granted.map((id) => <option key={id} value={id}>{operationName(id, language)}</option>)}
          </select>
        </label>
        <label className="form-field"><span>{t('portal.about')}</span>
          <select value={form.subject} onChange={(event) => setForm({ ...form, subject: event.target.value })}>
            <option value="">{t('portal.theWholeOperation')}</option>
            {subjects.map((activity) => <option key={activity.id} value={activity.id}>{activity.activity}</option>)}
          </select>
        </label>
        <label className="form-field form-field-wide"><span>{t('portal.yourComment')}</span>
          <textarea required rows="4" maxLength={2000} value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} />
        </label>
      </div>
      <div className="form-submit-bar">
        <button className="primary-btn" type="submit" disabled={sending || !form.body.trim()}>{t('portal.sendToDirector')}</button>
      </div>
    </form>

    <Panel title={t('portal.messages')} subtitle={`${threads.length}`}>
      {threads.length ? <div className="message-threads">{threads.map((thread) => <article className="message-thread" key={thread.id}>
        <header>
          <strong>{operationName(thread.operation, language)}</strong>
          <span>{thread.subjectTitle || t('portal.theWholeOperation')}</span>
        </header>
        {thread.messages.map((message) => <div key={message.id} className={message.authorRole === 'partner' ? 'message mine' : 'message theirs'}>
          <small>{message.authorRole === 'partner' ? t('portal.you') : t('role.super-admin')} · {formatDateTime(message.createdAt, language)}</small>
          <p>{message.body}</p>
        </div>)}
        <form className="message-reply" onSubmit={(event) => reply(event, thread)}>
          <input maxLength={2000} aria-label={t('portal.reply')} placeholder={t('portal.replyPlaceholder')} value={replies[thread.id] || ''}
            onChange={(event) => setReplies({ ...replies, [thread.id]: event.target.value })} />
          <button className="secondary-btn" type="submit" disabled={sending || !(replies[thread.id] || '').trim()}>{t('portal.reply')}</button>
        </form>
      </article>)}</div> : <EmptyState t={t}>{t('portal.noMessages')}</EmptyState>}
    </Panel>
  </>;
}

function ActivityTable({ rows, language, t, empty }) {
  if (!rows.length) return <EmptyState t={t}>{empty}</EmptyState>;
  return <div className="table-wrap"><table className="card-table">
    <thead><tr>
      <th>{t('table.activity')}</th><th>{t('table.category')}</th><th>{t('table.budget')}</th>
      <th>{t('table.deadline')}</th><th>{t('table.status')}</th>
    </tr></thead>
    <tbody>{rows.map((row) => <tr key={row.id}>
      <td className="card-title-cell"><strong>{row.activity}</strong><small>{row.description || row.projectName || ''}</small></td>
      <td data-label={t('table.category')}>{categoryLabel(row.category, t)}</td>
      <td data-label={t('table.budget')}>{row.approvedBudget === null ? '—' : formatMoney(row.approvedBudget)}</td>
      <td data-label={t('table.deadline')}>{formatDate(row.deadline, language)}</td>
      <td data-label={t('table.status')}><span className={`status-badge ${statusTone(row.status)}`}>{t(`status.${row.status}`)}</span></td>
    </tr>)}</tbody>
  </table></div>;
}

function Metric({ label, value }) {
  return <div className="metric-card"><span>{label}</span><strong>{value}</strong></div>;
}

function Panel({ title, subtitle, children }) {
  return <section className="panel">
    <div className="panel-header"><div><h2>{title}</h2>{subtitle && <span>{subtitle}</span>}</div></div>
    {children}
  </section>;
}

function EmptyState({ children, t }) {
  return <div className="empty-state"><strong>{children}</strong><span>{t('table.noData')}</span></div>;
}
