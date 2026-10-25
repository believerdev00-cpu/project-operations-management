import { useCallback, useEffect, useState } from 'react';
import { operationName } from '../shared/businessOperations.js';
import { categoryLabel } from './ActivityReview.jsx';
import { DATE_STYLE, dateLocale } from './format.js';
import { fill } from './i18n.js';
import { ProjectDiscussion } from './Discussion.jsx';

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
  ['projects', 'portal.myProjects'],
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
  return new Date(year, month - 1, day).toLocaleDateString(dateLocale(language), DATE_STYLE);
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
export default function PartnerPortal({ user, fetchJson, language, t, tab = 'overview', onTab, onError, onMessage, download, ReportView }) {
  const [overview, setOverview] = useState(null);
  const [activities, setActivities] = useState([]);
  const [movements, setMovements] = useState([]);
  const [report, setReport] = useState(null);
  const [updates, setUpdates] = useState([]);
  const [threads, setThreads] = useState([]);
  // The projects shared with this partner by name, each with its summary:
  // what the first page is about.
  const [projects, setProjects] = useState([]);
  // The project a card on the first page opened, for the report to start on.
  const [openProject, setOpenProject] = useState('');
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
      const [overviewResult, activityResult, movementResult, reportResult, updateResult, threadResult, projectResult] = await Promise.all([
        fetchJson(`/api/partner/overview?${narrow.slice(1)}`),
        fetchJson(`/api/partner/activities?limit=100${narrow}`),
        fetchJson(`/api/partner/movements?limit=100${narrow}`),
        fetchJson(`/api/partner/report?months=6${narrow}`),
        fetchJson(`/api/partner/updates?limit=30${narrow}`),
        fetchJson('/api/partner/comments').catch(() => []),
        fetchJson('/api/partner/projects').catch(() => [])
      ]);
      setProjects(projectResult);
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

  // Only the tabs with something in them. The activity, trip and update tabs
  // read the older activity register; a partner whose projects are run through
  // monthly plans would otherwise open four tabs of zeros and "nothing yet".
  const hasRecords = activities.length > 0 || movements.length > 0;
  const shown = TABS.filter(([id]) => {
    if (id === 'projects') return projects.length > 0;
    if (id === 'activities') return activities.length > 0;
    if (id === 'movements') return movements.length > 0;
    if (id === 'reports') return hasRecords;
    if (id === 'updates') return updates.length > 0;
    return true;
  });
  const openReport = (id) => { setOpenProject(id); onTab?.('projects'); };

  return <>
    <section className="welcome-strip partner-strip">
      <div>
        <span className="eyebrow">{t('portal.title')}</span>
        <h2>{fill(t('invite.title'), { name: user.name })}</h2>
        <p>{projects.length ? projects.map((project) => project.name).join(' · ') : operation}</p>
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

    {/* The shared projects are read in full, so the "approved records only"
        note belongs to the other tabs. */}
    {['activities', 'movements', 'reports', 'updates'].includes(tab) && <p className="partner-notice">
      <strong>{t('portal.approvedOnly')}.</strong> {t('portal.approvedOnlyNote')}
    </p>}

    <nav className="partner-tabs" aria-label={t('portal.title')}>
      {shown.map(([id, labelKey]) => <button
        key={id}
        type="button"
        className={tab === id ? 'partner-tab active' : 'partner-tab'}
        aria-current={tab === id ? 'page' : undefined}
        onClick={() => onTab?.(id)}
      >{t(labelKey)}</button>)}
    </nav>

    {tab === 'overview' && projects.length > 0 && <div className="partner-project-cards">
      {projects.map((project) => <ProjectCard key={project.id} project={project} language={language} t={t} onOpen={() => openReport(project.id)} />)}
    </div>}

    {/* The older activity register: only when it has something in it. */}
    {tab === 'overview' && overview && (hasRecords || !projects.length) && <>
      <div className="metric-grid metric-grid-5">
        <Metric label={t('portal.activities')} value={overview.activities.total} />
        <Metric label={t('portal.inProgress')} value={overview.activities.inProgress} />
        <Metric label={t('portal.completed')} value={overview.activities.completed} />
        <Metric label={t('portal.completionRate')} value={`${overview.activities.completionRate}%`} />
        <Metric label={t('portal.movements')} value={overview.movements.total} />
      </div>
      {/* The projects the Director shared with this partner one by one. When
          there are none, the partner follows their operations whole. */}
      {Number(overview.activities.approvedBudget) > 0 && <Panel title={t('portal.approvedBudget')} subtitle={operation}>
        <div className="partner-budget">{formatMoney(overview.activities.approvedBudget)}</div>
      </Panel>}
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

    {tab === 'projects' && <PartnerProjects fetchJson={fetchJson} download={download} language={language} t={t}
      onError={onError} onMessage={onMessage} ReportView={ReportView} initialProject={openProject} />}

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

// The projects the Director shared with this partner, each read in full: the
// Director's own report (ReportView is App.jsx's ReportBody, handed down so the
// partner's screen is the Director's screen, not a copy of it), for a month or
// for dates the partner picks, with the PDF and Excel export. The API refuses a
// project that was not shared by name (404), so the list below is the whole
// of what this can reach.
function PartnerProjects({ fetchJson, download, language, t, onError, onMessage, ReportView, initialProject = '' }) {
  const thisMonth = new Date().toISOString().slice(0, 7);
  const [projects, setProjects] = useState(null);
  const [projectId, setProjectId] = useState('');
  const [mode, setMode] = useState('monthly');
  const [month, setMonth] = useState(thisMonth);
  const [range, setRange] = useState({ start: `${thisMonth}-01`, end: new Date().toISOString().slice(0, 10) });
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);

  const queryFor = (asked) => (asked.mode === 'monthly'
    ? `period=monthly&month=${encodeURIComponent(asked.month)}`
    : `period=custom&start=${encodeURIComponent(asked.range.start)}&end=${encodeURIComponent(asked.range.end)}`);
  const query = queryFor({ mode, month, range });

  const generate = async (asked = { id: projectId, mode, month, range }) => {
    if (!asked.id) return;
    setBusy(true);
    try {
      setReport(await fetchJson(`/api/partner/projects/${encodeURIComponent(asked.id)}/report?${queryFor(asked)}`));
    } catch (loadError) {
      setReport(null);
      onError(loadError.message);
    } finally {
      setBusy(false);
    }
  };

  const exportReport = async (format) => {
    if (!report) return;
    setBusy(true);
    try {
      const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
      await download(
        `/api/partner/projects/${encodeURIComponent(projectId)}/report/export?format=${format}&${query}&language=${encodeURIComponent(language)}`,
        `report-${slug(report.scope?.projectName || projectId)}-${report.period.start}-to-${report.period.end}.${format}`
      );
      onMessage?.(fill(t('msg.reportDownloaded'), { format: format === 'xlsx' ? 'Excel' : 'PDF' }));
    } catch (exportError) {
      onError(exportError.message);
    } finally {
      setBusy(false);
    }
  };

  // Choosing a project opens its newest month with work, already shown: the
  // current month is usually still empty, and an empty report on arrival
  // reads as "nothing has been done".
  const choose = (id, list = projects) => {
    const chosen = list.find((project) => project.id === id);
    const opening = chosen?.latestMonth || thisMonth;
    setProjectId(id);
    setMode('monthly');
    setMonth(opening);
    setReport(null);
    if (id) generate({ id, mode: 'monthly', month: opening, range });
  };

  useEffect(() => {
    let live = true;
    fetchJson('/api/partner/projects')
      .then((rows) => {
        if (!live) return;
        setProjects(rows);
        const first = rows.find((row) => row.id === initialProject) || rows[0];
        if (first) choose(first.id, rows);
      })
      .catch((loadError) => onError(loadError.message));
    return () => { live = false; };
    // Once, on arrival: `choose` reads state that is set here.
  }, [fetchJson, onError]);

  if (!projects) return <div className="loading-state"><span className="spinner" />{t('app.loading')}</div>;
  if (!projects.length) return <EmptyState t={t}>{t('portal.noSharedProjects')}</EmptyState>;

  return <>
    <Panel title={t('portal.myProjects')} subtitle={t('portal.myProjectsNote')}>
      <div className="form-grid">
        <label className="form-field"><span>{t('report.project')}</span>
          <select value={projectId} onChange={(event) => choose(event.target.value)}>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {operationName(project.operation, language)}</option>)}
          </select>
        </label>
        <label className="form-field"><span>{t('portal.reportFor')}</span>
          <select value={mode} onChange={(event) => setMode(event.target.value)}>
            <option value="monthly">{t('report.monthly')}</option>
            <option value="custom">{t('report.custom')}</option>
          </select>
        </label>
        {mode === 'monthly'
          ? <label className="form-field"><span>{t('report.month')}</span>
            <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label>
          : <>
            <label className="form-field"><span>{t('report.startDate')}</span>
              <input type="date" value={range.start} max={range.end} onChange={(event) => setRange({ ...range, start: event.target.value })} /></label>
            <label className="form-field"><span>{t('report.endDate')}</span>
              <input type="date" value={range.end} min={range.start} onChange={(event) => setRange({ ...range, end: event.target.value })} /></label>
          </>}
      </div>
      <div className="report-actions">
        <button className="primary-btn" type="button" disabled={busy || !projectId} onClick={() => generate()}>{t('portal.showReport')}</button>
      </div>
    </Panel>
    {report && ReportView && <section className="panel report-result">
      <ReportView report={report} busy={busy} sectorLabel={(id) => operationName(id, language)}
        onExport={exportReport} onPrint={() => window.print()} onClose={() => setReport(null)} />
    </section>}
    {projectId && <ProjectFiles key={`f${projectId}`} fetchJson={fetchJson} download={download} projectId={projectId} t={t} language={language} onError={onError} />}
    {projectId && <ProjectDiscussion key={`d${projectId}`} fetchJson={fetchJson} projectId={projectId} onError={onError} onMessage={onMessage} />}
  </>;
}

// The documents behind a shared project -- photos and papers on its recorded
// days, receipts on its activities -- each downloaded with the partner's own
// session (never a link that could be forwarded).
function ProjectFiles({ fetchJson, download, projectId, t, language, onError }) {
  const [files, setFiles] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    fetchJson(`/api/partner/projects/${encodeURIComponent(projectId)}/files`)
      .then((rows) => { if (live) setFiles(rows); })
      .catch((loadError) => onError(loadError.message));
    return () => { live = false; };
  }, [fetchJson, projectId, onError]);

  const take = async (file) => {
    setBusy(true);
    try {
      await download(`/api/partner/projects/${encodeURIComponent(projectId)}/files/${file.source}/${file.id}`, file.name);
    } catch (downloadError) {
      onError(downloadError.message);
    } finally {
      setBusy(false);
    }
  };

  if (!files) return null;
  return <Panel title={t('portal.documents')} subtitle={t('portal.documentsNote')}>
    {files.length ? <div className="table-wrap"><table className="card-table">
      <thead><tr><th>{t('portal.document')}</th><th>{t('portal.documentFor')}</th><th>{t('portal.documentDate')}</th><th>{t('portal.documentAction')}</th></tr></thead>
      <tbody>{files.map((file) => <tr key={`${file.source}${file.id}`}>
        <td className="card-title-cell" data-label={t('portal.document')}><strong>{file.name}</strong></td>
        <td data-label={t('portal.documentFor')}>{file.recordTitle}</td>
        <td data-label={t('portal.documentDate')}>{formatDate(file.recordDate, language)}</td>
        <td className="card-actions" data-label={t('portal.documentAction')}>
          <button className="secondary-btn" type="button" disabled={busy} onClick={() => take(file)}>{t('portal.download')}</button>
        </td>
      </tr>)}</tbody>
    </table></div> : <EmptyState t={t}>{t('portal.noDocuments')}</EmptyState>}
  </Panel>;
}

// The days imported from the old spreadsheets end with where each came from
// ("| [rubaya report.xlsx / Mining Activities row 51]"): kept on the record
// for the Director, left off the partner's summary card.
const cleanNote = (text) => String(text || '').replace(/\s*\|?\s*\[[^\]]*\brow \d+\]\s*$/i, '').trim();

// One shared project on the partner's first page: how far it is, the money,
// how much work has been recorded, and the last few days -- every figure from
// the API, which reads them the way the Director's reports do.
function ProjectCard({ project, language, t, onOpen }) {
  const s = project.summary || {};
  const percent = s.percent;
  return <section className="panel partner-project-card">
    <div className="panel-header"><div>
      <h2>{project.name}</h2>
      <span>{operationName(project.operation, language)}</span>
    </div></div>
    <div className="partner-progress">
      <strong>{percent === null || percent === undefined ? '—' : `${percent}%`}</strong>
      <span>{t('portal.card.progress')}</span>
      {percent !== null && percent !== undefined && <div className="partner-progress-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, percent)}%` }} /></div>}
    </div>
    <dl className="partner-card-facts">
      <div><dt>{t('portal.card.objectives')}</dt><dd>{fill(t('portal.card.ofCount'), { done: s.objectivesDone || 0, total: s.objectives || 0 })}</dd></div>
      <div><dt>{t('portal.card.days')}</dt><dd>{s.daysRecorded || 0}</dd></div>
      <div><dt>{t('portal.card.spent')}</dt><dd>{formatMoney(s.spent)}{Number(s.budget) > 0 ? ` / ${formatMoney(s.budget)}` : ''}</dd></div>
      <div><dt>{t('portal.card.files')}</dt><dd>{s.files || 0}</dd></div>
    </dl>
    {s.latestDays?.length > 0 && <>
      <h3 className="partner-card-sub">{t('portal.card.latest')}</h3>
      <ul className="partner-latest">{s.latestDays.map((day, index) => <li key={`${day.day}-${index}`}>
        <span>{formatDate(day.day, language)}</span>
        <strong>{day.title || '—'}{day.quantity ? ` · ${new Intl.NumberFormat(language).format(day.quantity)}${day.unit ? ` ${day.unit}` : ''}` : ''}</strong>
        {cleanNote(day.notes) && <small>{cleanNote(day.notes)}</small>}
      </li>)}</ul>
    </>}
    <button className="primary-btn big-action" type="button" onClick={onOpen}>{t('portal.card.open')}</button>
  </section>;
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
