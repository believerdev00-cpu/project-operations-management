// A project's discussion with its external partners.
//
// Two views of the same threads:
//
//   ProjectDiscussion  the partner's, under a project shared with them (My
//                      projects): every comment on that project, a box to ask
//                      or comment -- about the whole project, one month or one
//                      activity -- and a reply under each conversation.
//   DiscussionInbox    the inside's: the Director (Partners page), the General
//                      Manager and project managers (Home). Questions still
//                      waiting for an answer come first; whoever may answer
//                      replies and marks a question answered.
//
// Both read and write only through routes that check the project on every
// request (/api/partner/projects/:id/discussion and /api/project-discussions);
// nothing here decides who sees what.

import { useCallback, useEffect, useState } from 'react';
import { fill, useI18n } from './i18n.js';
import { useBusy } from './ui.jsx';
import { dateLocale, formatDateTime } from './format.js';

function when(value, language) {
  return value ? formatDateTime(value, language) : '';
}

// '2026-09' as "September 2026" in the reader's language; anything else as it is.
function monthWords(value, language) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value || ''));
  if (!match) return value || '';
  return new Date(Number(match[1]), Number(match[2]) - 1, 1).toLocaleDateString(dateLocale(language), { month: 'long', year: 'numeric' });
}

function subjectLabel(thread, t, language) {
  if (thread.subjectType === 'plan') return fill(t('discussion.aboutMonth'), { month: monthWords(thread.subjectTitle, language) });
  if (thread.subjectType === 'activity') return fill(t('discussion.aboutActivity'), { title: thread.subjectTitle || '' });
  return t('discussion.aboutProject');
}

function ThreadCard({ thread, language, t, canReply, busy, onReply, onResolve, showProject }) {
  const [reply, setReply] = useState('');
  const send = async (event) => {
    event.preventDefault();
    const body = reply.trim();
    if (!body) return;
    if (await onReply(thread, body)) setReply('');
  };
  return <article className={`message-thread${thread.needsReply ? ' unread' : ''}`}>
    <header>
      <strong>{showProject && thread.projectName ? `${thread.projectName} · ` : ''}{subjectLabel(thread, t, language)}</strong>
      <span className={`status-badge ${thread.resolvedAt ? 'tone-done' : thread.needsReply ? 'tone-waiting' : 'tone-active'}`}>
        {thread.resolvedAt ? t('discussion.answered') : thread.needsReply ? t('discussion.waiting') : t('discussion.inProgress')}
      </span>
      {onResolve && <button className="text-btn" type="button" disabled={busy} onClick={() => onResolve(thread, !thread.resolvedAt)}>
        {thread.resolvedAt ? t('discussion.reopen') : t('discussion.markAnswered')}
      </button>}
    </header>
    {thread.messages.map((message) => <div key={message.id} className={message.authorRole === 'partner' ? 'message theirs' : 'message mine'}>
      <small>{message.authorName} · {t(`discussion.role.${message.authorRole}`)} · {when(message.createdAt, language)}</small>
      <p>{message.body}</p>
    </div>)}
    {thread.resolvedAt && <small className="muted">{fill(t('discussion.answeredBy'), { name: thread.resolvedByName, when: when(thread.resolvedAt, language) })}</small>}
    {canReply && <form className="message-reply" onSubmit={send}>
      <input maxLength={2000} aria-label={t('discussion.reply')} placeholder={t('discussion.replyPlaceholder')} value={reply} onChange={(event) => setReply(event.target.value)} />
      <button className="secondary-btn" type="submit" disabled={busy || !reply.trim()}>{t('discussion.reply')}</button>
    </form>}
  </article>;
}

// ---- the partner's view ------------------------------------------------------------

export function ProjectDiscussion({ fetchJson, projectId, onError, onMessage }) {
  const { t, language } = useI18n();
  const [data, setData] = useState(null);
  const [subject, setSubject] = useState('project');
  const [body, setBody] = useState('');
  const [busy, run] = useBusy();
  const base = `/api/partner/projects/${encodeURIComponent(projectId)}/discussion`;

  const load = useCallback(async () => {
    try { setData(await fetchJson(base)); } catch (error) { onError(error.message); }
  }, [fetchJson, base, onError]);
  useEffect(() => { setData(null); setSubject('project'); load(); }, [load]);

  const send = (event) => {
    event.preventDefault();
    const text = body.trim();
    if (!text) return undefined;
    const [subjectType, ...rest] = subject.split(':');
    return run(async () => {
      try {
        await fetchJson(base, { method: 'POST', body: JSON.stringify({ subjectType, subjectId: rest.join(':') || null, body: text }) });
        setBody('');
        onMessage?.(t('discussion.sent'));
        await load();
        return true;
      } catch (error) { onError(error.message); return false; }
    });
  };
  const reply = (thread, text) => run(async () => {
    try {
      await fetchJson(`${base}/${thread.id}/replies`, { method: 'POST', body: JSON.stringify({ body: text }) });
      onMessage?.(t('discussion.sent'));
      await load();
      return true;
    } catch (error) { onError(error.message); return false; }
  });

  if (!data) return null;
  return <section className="panel" id="project-discussion">
    <div className="panel-header"><div>
      <h2>{t('discussion.title')}</h2>
      <span>{t('discussion.partnerHint')}</span>
    </div></div>
    <form className="form-grid" onSubmit={send}>
      <label className="form-field"><span>{t('discussion.about')}</span>
        <select value={subject} onChange={(event) => setSubject(event.target.value)}>
          <option value="project">{t('discussion.aboutProject')}</option>
          {data.subjects.plans.map((plan) => <option key={`p${plan.id}`} value={`plan:${plan.id}`}>{fill(t('discussion.aboutMonth'), { month: monthWords(plan.month, language) })}</option>)}
          {data.subjects.activities.map((activity) => <option key={`a${activity.id}`} value={`activity:${activity.id}`}>{fill(t('discussion.aboutActivity'), { title: activity.title })}</option>)}
        </select>
      </label>
      <label className="form-field form-field-wide"><span>{t('discussion.yourComment')}</span>
        <textarea rows={3} maxLength={2000} value={body} onChange={(event) => setBody(event.target.value)} placeholder={t('discussion.commentPlaceholder')} />
      </label>
      <div className="form-field-wide"><button className="primary-btn big-action" type="submit" disabled={busy || !body.trim()}>{t('discussion.send')}</button></div>
    </form>
    {data.threads.length
      ? <div className="message-threads">{data.threads.map((thread) => <ThreadCard key={thread.id} thread={thread} language={language} t={t}
        canReply busy={busy} onReply={reply} />)}</div>
      : <div className="empty-state"><strong>{t('discussion.none')}</strong></div>}
  </section>;
}

// ---- the inside's view ----------------------------------------------------------------

export function DiscussionInbox({ fetchJson, onError, onMessage, hideWhenEmpty = false }) {
  const { t, language } = useI18n();
  const [status, setStatus] = useState('open');
  const [data, setData] = useState(null);
  const [busy, run] = useBusy();

  const load = useCallback(async () => {
    try { setData(await fetchJson(`/api/project-discussions${status === 'all' ? '' : `?status=${status}`}`)); } catch (error) { onError(error.message); }
  }, [fetchJson, status, onError]);
  useEffect(() => { load(); }, [load]);

  const reply = (thread, text) => run(async () => {
    try {
      await fetchJson(`/api/project-discussions/${thread.id}/replies`, { method: 'POST', body: JSON.stringify({ body: text }) });
      onMessage?.(t('discussion.sent'));
      await load();
      return true;
    } catch (error) { onError(error.message); return false; }
  });
  const resolve = (thread, resolved) => run(async () => {
    try {
      await fetchJson(`/api/project-discussions/${thread.id}/resolve`, { method: 'POST', body: JSON.stringify({ resolved }) });
      await load();
      return true;
    } catch (error) { onError(error.message); return false; }
  });

  if (!data) return null;
  if (hideWhenEmpty && status === 'open' && !data.threads.length) return null;
  // Waiting questions first, then the rest, newest first within each.
  const threads = [...data.threads].sort((a, b) => Number(b.needsReply) - Number(a.needsReply));
  return <section className="panel" id="project-discussions">
    <div className="panel-header"><div>
      <h2>{t('discussion.inboxTitle')}</h2>
      <span>{fill(t('discussion.waitingCount'), { count: data.waiting })}</span>
    </div></div>
    <div className="toolbar-row"><div className="filter-group">
      {['open', 'resolved', 'all'].map((value) => <button key={value} type="button" className={status === value ? 'primary-btn' : 'secondary-btn'} onClick={() => setStatus(value)}>
        {t(`discussion.filter.${value}`)}
      </button>)}
    </div></div>
    {threads.length
      ? <div className="message-threads">{threads.map((thread) => <ThreadCard key={thread.id} thread={thread} language={language} t={t} showProject
        canReply={data.canAnswer} busy={busy} onReply={reply} onResolve={data.canAnswer ? resolve : null} />)}</div>
      : <div className="empty-state"><strong>{t('discussion.none')}</strong></div>}
  </section>;
}
