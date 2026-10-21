import { useCallback, useEffect, useRef, useState } from 'react';
import { operationName } from '../shared/businessOperations.js';
import { fill, useI18n } from './i18n.js';
import { DetailView, Fact, useBusy, useDialog } from './ui.jsx';

// Issues and decisions that climb the reporting line.
//
// A team member raises to their project manager, a project manager to the
// General Manager, the General Manager to the Director (the API decides where
// each one goes -- nextDeskFor in server/lib/organization.js). Whoever holds it
// settles it or passes it up; a refusal always carries a reason, which goes
// back to the person who raised it. Nothing is deleted: the history under each
// issue is every step, with who took it and when.
//
// The buttons come from each issue's `can` flags, which the API works out with
// the same rules its routes enforce.

// Same floor as sending work back for correction (MIN_CORRECTION_NOTE).
const MIN_REASON = 10;
const STATUS_TONE = { open: 'tone-waiting', resolved: 'tone-done', rejected: 'tone-stopped' };
const PRIORITY_KEY = { Low: 'form.priorityLow', Medium: 'form.priorityMedium', High: 'form.priorityHigh' };

function holderLabel(item, t) {
  return item.holderRole === 'director' ? t('role.super-admin') : (item.holderName || t('form.nobodyYet'));
}

// The list, shared by this page and the General Manager's home.
export function EscalationList({ items, t, language, onOpen, empty, openId = null }) {
  if (!items.length) return <div className="empty-state"><strong>{empty}</strong></div>;
  return <ul className="escalation-list">
    {items.map((item) => <li key={item.id} className={String(item.id) === String(openId) ? 'escalation-row row-selected' : 'escalation-row'}>
      <button type="button" className="escalation-open" onClick={() => onOpen(item.id)}>
        <span className="escalation-main">
          <strong>{item.title}</strong>
          <small>{[
            t(`esc.kind.${item.kind}`),
            item.projectName,
            item.sector && operationName(item.sector, language),
            fill(t('esc.raisedByLine'), { name: item.raisedByName })
          ].filter(Boolean).join(' · ')}</small>
        </span>
        <span className="escalation-meta">
          <span className={`priority-badge priority-${item.priority.toLowerCase()}`}>{t(PRIORITY_KEY[item.priority])}</span>
          <span className={`status-badge ${STATUS_TONE[item.status] || ''}`}>{t(`esc.status.${item.status}`)}</span>
          {item.status === 'open' && <small>{fill(t('esc.withLine'), { name: holderLabel(item, t) })}</small>}
        </span>
      </button>
    </li>)}
  </ul>;
}

export default function EscalationsPage({ user, fetchJson, projects, openId, onOpen, onClose, onChanged, onMessage, onError }) {
  const { language, t } = useI18n();
  const dialog = useDialog();
  const senior = user.role === 'super-admin' || user.role === 'general-manager';
  const canRaise = user.role !== 'super-admin';
  // Raisers start on what they raised; anybody who can hold one starts on what
  // is waiting for them.
  const [box, setBox] = useState(user.role === 'staff' ? 'raised' : 'waiting');
  const [items, setItems] = useState(null);
  const [detail, setDetail] = useState(null);
  const [raising, setRaising] = useState(false);
  const [busy, run] = useBusy();
  const latest = useRef(0);

  const load = useCallback(async () => {
    const request = ++latest.current;
    try {
      const rows = await fetchJson(`/api/escalations?box=${box}`);
      if (request === latest.current) setItems(rows);
    } catch (loadError) {
      if (request === latest.current) { setItems([]); onError(loadError.message); }
    }
  }, [fetchJson, box, onError]);

  const loadDetail = useCallback(async () => {
    if (!openId) { setDetail(null); return; }
    try {
      setDetail(await fetchJson(`/api/escalations/${encodeURIComponent(openId)}`));
    } catch (loadError) {
      setDetail(null);
      onError(loadError.message);
      onClose();
    }
  }, [fetchJson, openId, onError, onClose]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadDetail(); }, [loadDetail]);

  const act = (path, body, success) => run(async () => {
    try {
      await fetchJson(path, { method: 'POST', body: JSON.stringify(body || {}) });
      onMessage(success);
      await Promise.all([load(), loadDetail()]);
      onChanged?.();
      return true;
    } catch (actionError) {
      onError(actionError.message);
      return false;
    }
  });

  const settle = async (item) => {
    const note = await dialog.prompt({
      title: item.kind === 'approval' ? t('esc.approveTitle') : t('esc.resolveTitle'),
      label: t('esc.answer'),
      multiline: true,
      confirmLabel: item.kind === 'approval' ? t('esc.approve') : t('esc.resolve')
    });
    if (note === null) return;
    act(`/api/escalations/${item.id}/resolve`, { note }, t('esc.msgSettled'));
  };
  const refuse = async (item) => {
    const note = await dialog.prompt({
      title: t('esc.rejectTitle'),
      message: t('esc.rejectBody'),
      label: t('field.reason'),
      multiline: true,
      required: true,
      minLength: MIN_REASON,
      confirmLabel: t('esc.reject'),
      danger: true
    });
    if (note === null) return;
    act(`/api/escalations/${item.id}/reject`, { note }, t('esc.msgRefused'));
  };
  const escalate = async (item) => {
    const note = await dialog.prompt({
      title: t('esc.escalateTitle'),
      message: t('esc.escalateBody'),
      label: t('field.note'),
      multiline: true,
      confirmLabel: t('esc.escalate')
    });
    if (note === null) return;
    act(`/api/escalations/${item.id}/escalate`, { note }, t('esc.msgEscalated'));
  };
  const comment = async (item) => {
    const note = await dialog.prompt({ title: t('esc.commentTitle'), label: t('field.note'), multiline: true, required: true, confirmLabel: t('esc.comment') });
    if (note === null) return;
    act(`/api/escalations/${item.id}/comments`, { note }, t('esc.msgComment'));
  };

  // A team member raises issues but never holds one, so they get no
  // "Waiting for me" tab that could only ever be empty.
  const tabs = [
    ...(user.role !== 'staff' ? [['waiting', t('esc.boxWaiting')]] : []),
    ...(canRaise ? [['raised', t('esc.boxRaised')]] : []),
    ...(senior || user.role === 'manager' ? [['all', t('esc.boxAll')]] : [])
  ];

  return <>
    <section className="welcome-strip">
      <div>
        <span className="eyebrow">{t('esc.eyebrow')}</span>
        <h2>{t('esc.title')}</h2>
        <p>{t('esc.blurb')}</p>
      </div>
      {canRaise && <button className="primary-btn" type="button" onClick={() => setRaising(!raising)}>{raising ? t('action.cancel') : t('esc.raise')}</button>}
    </section>

    {raising && <RaiseForm projects={projects} t={t} language={language} busy={busy}
      onRaise={(payload) => run(async () => {
        try {
          const created = await fetchJson('/api/escalations', { method: 'POST', body: JSON.stringify(payload) });
          onMessage(created.holderRole === 'director'
            ? t('esc.msgRaisedDirector')
            : fill(t('esc.msgRaised'), { name: created.holderName || '' }));
          setRaising(false);
          setBox('raised');
          await load();
          onChanged?.();
          return true;
        } catch (raiseError) {
          onError(raiseError.message);
          return false;
        }
      })} />}

    <div className="partner-tabs" role="tablist" aria-label={t('esc.title')}>
      {tabs.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={box === id}
        className={box === id ? 'partner-tab active' : 'partner-tab'} onClick={() => setBox(id)}>{label}</button>)}
    </div>

    {items === null
      ? <div className="loading-state"><span className="spinner" />{t('app.loading')}</div>
      : <EscalationList items={items} t={t} language={language} onOpen={onOpen} openId={openId}
        empty={box === 'waiting' ? t('esc.emptyWaiting') : box === 'raised' ? t('esc.emptyRaised') : t('esc.emptyAll')} />}

    {detail && <DetailView onClose={onClose} label={detail.title}>
      <section className="panel escalation-detail">
        <div className="panel-header">
          <div>
            <span className="eyebrow">{t(`esc.kind.${detail.kind}`)}</span>
            <h2>{detail.title}</h2>
          </div>
          <button className="text-btn" type="button" onClick={onClose}>{t('action.close')}</button>
        </div>
        <div className="detail-facts">
          <Fact label={t('field.status')} value={t(`esc.status.${detail.status}`)} />
          <Fact label={t('field.priority')} value={t(PRIORITY_KEY[detail.priority])} />
          <Fact label={t('esc.raisedBy')} value={detail.raisedByName} />
          {detail.status === 'open' && <Fact label={t('esc.holder')} value={holderLabel(detail, t)} />}
          {detail.projectName && <Fact label={t('field.project')} value={detail.projectName} />}
          {detail.activityName && <Fact label={t('field.activity')} value={detail.activityName} />}
          {detail.teamName && <Fact label={t('field.team')} value={detail.teamName} />}
          {detail.settledByName && <Fact label={t('esc.settledBy')} value={`${detail.settledByName} · ${new Date(detail.settledAt).toLocaleString(language)}`} />}
        </div>
        {detail.body && <p className="detail-notes">{detail.body}</p>}
        {detail.resolution && <p className={detail.status === 'rejected' ? 'admin-note sent-back' : 'admin-note'}>
          <strong>{detail.status === 'rejected' ? t('esc.refusedBecause') : t('esc.answer')}: </strong>{detail.resolution}
        </p>}
        {(detail.can.settle || detail.can.escalate || detail.can.comment) && <div className="button-row">
          {detail.can.settle && <button className="primary-btn" type="button" disabled={busy} onClick={() => settle(detail)}>
            {detail.kind === 'approval' ? t('esc.approve') : t('esc.resolve')}
          </button>}
          {detail.can.settle && <button className="danger-btn outlined" type="button" disabled={busy} onClick={() => refuse(detail)}>{t('esc.reject')}</button>}
          {detail.can.escalate && <button className="secondary-btn" type="button" disabled={busy} onClick={() => escalate(detail)}>{t('esc.escalate')}</button>}
          {detail.can.comment && <button className="text-btn" type="button" disabled={busy} onClick={() => comment(detail)}>{t('esc.comment')}</button>}
        </div>}
        <h3 className="home-heading">{t('esc.trail')}</h3>
        <ul className="history-list">{detail.events.map((event) => <li key={event.id}>
          <strong>{t(`esc.action.${event.action}`)}</strong>
          <span>{[
            event.actorName,
            (event.action === 'raised' || event.action === 'escalated')
              && fill(t('esc.toLine'), { name: event.toHolderName || t('role.super-admin') })
          ].filter(Boolean).join(' · ')}</span>
          {event.note && <p>{event.note}</p>}
          <small>{new Date(event.createdAt).toLocaleString(language)}</small>
        </li>)}</ul>
      </section>
    </DetailView>}
  </>;
}

function RaiseForm({ projects, t, language, busy, onRaise }) {
  const empty = { kind: 'issue', title: '', body: '', priority: 'Medium', projectId: '' };
  const [form, setForm] = useState(empty);
  const submit = async (event) => {
    event.preventDefault();
    const saved = await onRaise({
      kind: form.kind, title: form.title, body: form.body, priority: form.priority,
      ...(form.projectId ? { projectId: form.projectId } : {})
    });
    if (saved) setForm(empty);
  };
  return <form className="form-panel" onSubmit={submit}>
    <div className="panel-header"><div>
      <h2>{t('esc.raise')}</h2>
      <span>{t('esc.raiseBlurb')}</span>
    </div></div>
    <div className="form-grid">
      <label className="form-field"><span>{t('esc.kindField')}</span>
        <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}>
          <option value="issue">{t('esc.kind.issue')}</option>
          <option value="approval">{t('esc.kind.approval')}</option>
        </select>
      </label>
      <label className="form-field"><span>{t('field.priority')}</span>
        <select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })}>
          {Object.entries(PRIORITY_KEY).map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}
        </select>
      </label>
      <label className="form-field form-field-wide"><span>{t('esc.titleField')}</span>
        <input required maxLength={200} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
      </label>
      <label className="form-field"><span>{t('field.project')}</span>
        <select value={form.projectId} onChange={(event) => setForm({ ...form, projectId: event.target.value })}>
          <option value="">{t('esc.noProject')}</option>
          {(projects || []).map((project) => <option key={project.id} value={project.id}>{project.name} · {operationName(project.sector, language)}</option>)}
        </select>
      </label>
      <label className="form-field form-field-wide"><span>{t('esc.details')}</span>
        <textarea rows="3" maxLength={4000} value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} />
      </label>
    </div>
    <div className="form-submit-bar"><button className="primary-btn" type="submit" disabled={busy || !form.title.trim()}>{t('esc.send')}</button></div>
  </form>;
}
