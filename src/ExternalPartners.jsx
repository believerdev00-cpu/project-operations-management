import { Fragment, useState } from 'react';
import { BUSINESS_OPERATIONS, operationName } from '../shared/businessOperations.js';
import { OperationChecks } from './ui.jsx';
import { fill } from './i18n.js';

// The Director's control over External Business Partner access.
//
// Invite a partner, grant them any of the four business operations, change the
// grants, suspend, restore, revoke, or remove them; and read and answer what
// partners write to the Director. Access Level is View Only and is
// not a choice: an external partner never gets approval authority, so the field
// is shown as a fixed value rather than a dropdown that could be set wrong.

const emptyForm = { name: '', email: '', username: '', password: '', operations: [BUSINESS_OPERATIONS[0].id] };

// The operation checkboxes live in ui.jsx (OperationChecks): a manager's
// operations are ticked with the same control. The last one cannot be unticked
// -- the API refuses a partner with none.

const STATUS_TONE = { active: 'tone-done', suspended: 'tone-waiting', revoked: 'tone-stopped' };

export default function ExternalPartners({
  register, language, t, busy = false, onInvite, onChangeOperation, onChangeStatus, onResetPassword, onRemove,
  inbox = { unread: 0, threads: [] }, onReply, onMarkRead,
  projects = [], contacts = [], onSaveSharing
}) {
  const [form, setForm] = useState(emptyForm);
  const [replies, setReplies] = useState({});
  // The partner whose organisation and shared projects are open for editing.
  const [sharing, setSharing] = useState(null);

  // Cleared only once the invitation is saved, so a refused one keeps what was typed.
  const submit = (event) => {
    event.preventDefault();
    Promise.resolve(onInvite(form)).then((saved) => { if (saved) setForm(emptyForm); });
  };

  return <>
    <section className="context-strip">
      <div>
        <span className="eyebrow">{t('partners.eyebrow')}</span>
        <h2>{t('partners.title')}</h2>
        <p>{t('partners.blurb')}</p>
      </div>
      <button className="primary-btn" type="button" onClick={() => document.getElementById('partner-form')?.scrollIntoView({ behavior: 'smooth' })}>
        {t('partners.add')}
      </button>
    </section>

    <div className="metric-grid">
      <Metric label={t('partners.total')} value={register.total} />
      <Metric label={t('partners.activeCount')} value={register.active} />
      {BUSINESS_OPERATIONS.map((operation) => <Metric
        key={operation.id}
        label={operationName(operation.id, language)}
        value={register.byOperation?.[operation.id] || 0}
      />)}
    </div>

    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>{t('partners.title')}</h2>
          <span>{register.partners.length} · {t('partners.viewOnly')}</span>
        </div>
      </div>
      {register.partners.length ? <div className="table-wrap"><table className="card-table">
        <thead><tr>
          <th>{t('partners.name')}</th>
          <th>{t('partners.email')}</th>
          <th>{t('app.businessOperation')}</th>
          <th>{t('partners.accessLevel')}</th>
          <th>{t('partners.status')}</th>
          <th>{t('partners.sharing')}</th>
          <th>{t('partners.visibleRecords')}</th>
          <th>{t('table.actions')}</th>
        </tr></thead>
        <tbody>{register.partners.map((partner) => <Fragment key={partner.id}><tr>
          <td className="card-title-cell"><strong>{partner.name}</strong><small>{partner.organization || partner.username}</small></td>
          <td data-label={t('partners.email')}>{partner.email || <span className="muted-cell">—</span>}</td>
          {/* Changing this one cell changes everything the partner can read, on
              their very next request -- which is why the change is confirmed. */}
          <td data-label={t('app.businessOperation')}>
            <OperationChecks
              label={`${t('app.businessOperation')}: ${partner.name}`}
              disabled={busy}
              selected={partner.operations || [partner.operation]}
              language={language}
              onChange={(operations) => onChangeOperation(partner, operations)}
            />
          </td>
          <td data-label={t('partners.accessLevel')}><span className="status-badge">{t('partners.viewOnly')}</span></td>
          <td data-label={t('partners.status')}><span className={`status-badge ${STATUS_TONE[partner.status] || ''}`}>
            {t(`partners.${partner.status}`)}
          </span></td>
          {/* Whole operations, or only the projects shared one by one -- the
              thing that decides what this partner reads, so it is on the row. */}
          <td data-label={t('partners.sharing')}>
            {partner.projects?.length
              ? partner.projects.map((project) => project.name).join(', ')
              : <span className="muted-cell">{t('org.wholeOperations')}</span>}
            {partner.contactName && <small>{fill(t('org.contact'), { name: partner.contactName })}</small>}
          </td>
          <td data-label={t('partners.visibleRecords')}>
            {partner.visibleActivities} {t('portal.activities').toLocaleLowerCase(language)}
            <small>{partner.visibleMovements} {t('portal.movements').toLocaleLowerCase(language)}</small>
          </td>
          <td className="queue-actions card-actions">
            {partner.status === 'active'
              ? <button className="secondary-btn compact" type="button" disabled={busy} onClick={() => onChangeStatus(partner, 'suspended')}>{t('partners.suspend')}</button>
              : <button className="secondary-btn compact" type="button" disabled={busy} onClick={() => onChangeStatus(partner, 'active')}>{t('partners.restore')}</button>}
            {partner.status !== 'revoked' && <button className="danger-btn outlined compact" type="button" disabled={busy} onClick={() => onChangeStatus(partner, 'revoked')}>{t('partners.revoke')}</button>}
            {onSaveSharing && <button className="text-btn" type="button" disabled={busy}
              aria-expanded={sharing === partner.id}
              onClick={() => setSharing(sharing === partner.id ? null : partner.id)}>{t('partners.editSharing')}</button>}
            <button className="text-btn" type="button" disabled={busy} onClick={() => onResetPassword(partner)}>{t('partners.resetPassword')}</button>
            <button className="danger-btn" type="button" disabled={busy} onClick={() => onRemove(partner)}>{t('partners.remove')}</button>
          </td>
        </tr>
        {sharing === partner.id && <tr className="sharing-row"><td colSpan={8}>
          <PartnerSharing partner={partner} projects={projects} contacts={contacts} language={language} t={t} busy={busy}
            onCancel={() => setSharing(null)}
            onSave={(values) => Promise.resolve(onSaveSharing(partner, values)).then((saved) => { if (saved) setSharing(null); })} />
        </td></tr>}
        </Fragment>)}</tbody>
      </table></div> : <div className="empty-state">
        <strong>{t('partners.empty')}</strong>
        <span>{t('partners.blurb')}</span>
      </div>}
    </section>

    {/* What partners wrote to the Director. Nobody else reads it -- not the
        operation's manager, not a manager covering all of them -- and each
        answer goes back only to the partner who wrote. */}
    <section className="panel" id="partner-inbox">
      <div className="panel-header">
        <div>
          <h2>{t('partners.inbox')}</h2>
          <span>{fill(t('partners.inboxCount'), { count: inbox.threads.length, unread: inbox.unread })}</span>
        </div>
      </div>
      {inbox.threads.length ? <div className="message-threads">{inbox.threads.map((thread) => <article
        className={thread.unreadByDirector ? 'message-thread unread' : 'message-thread'} key={thread.id}>
        <header>
          <strong>{thread.partnerName}</strong>
          <span>{operationName(thread.operation, language)} · {thread.subjectTitle || t('portal.theWholeOperation')}</span>
          {thread.unreadByDirector > 0 && <button className="text-btn" type="button" disabled={busy} onClick={() => onMarkRead(thread)}>{t('partners.markRead')}</button>}
        </header>
        {thread.messages.map((message) => <div key={message.id} className={message.authorRole === 'partner' ? 'message theirs' : 'message mine'}>
          <small>{message.authorName} · {new Date(message.createdAt).toLocaleString(language)}</small>
          <p>{message.body}</p>
        </div>)}
        <form className="message-reply" onSubmit={(event) => {
          event.preventDefault();
          const body = (replies[thread.id] || '').trim();
          if (!body) return;
          Promise.resolve(onReply(thread, body)).then((saved) => { if (saved) setReplies({ ...replies, [thread.id]: '' }); });
        }}>
          <input maxLength={2000} aria-label={t('portal.reply')} placeholder={t('portal.replyPlaceholder')} value={replies[thread.id] || ''}
            onChange={(event) => setReplies({ ...replies, [thread.id]: event.target.value })} />
          <button className="secondary-btn" type="submit" disabled={busy || !(replies[thread.id] || '').trim()}>{t('portal.reply')}</button>
        </form>
      </article>)}</div> : <div className="empty-state">
        <strong>{t('partners.inboxEmpty')}</strong>
        <span>{t('table.noData')}</span>
      </div>}
    </section>

    <form className="form-panel" id="partner-form" onSubmit={submit}>
      <div className="panel-header">
        <div>
          <h2>{t('partners.add')}</h2>
          <span>{t('partners.blurb')}</span>
        </div>
      </div>
      <div className="form-grid">
        <label className="form-field"><span>{t('partners.name')}</span>
          <input required maxLength="150" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </label>
        <label className="form-field"><span>{t('partners.email')}</span>
          <input required type="email" inputMode="email" autoComplete="off" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
        </label>
        <label className="form-field"><span>{t('partners.username')}</span>
          <input required maxLength="100" autoCapitalize="none" autoComplete="off" spellCheck="false" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} />
        </label>
        <label className="form-field"><span>{t('partners.password')}</span>
          <input required type="password" autoComplete="new-password" minLength={6} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
        </label>
        {/* One or more of the four, each ticked deliberately. A partner sees
            exactly the operations ticked here and nothing else. */}
        <div className="form-field form-field-wide"><span>{t('partners.operationsGranted')}</span>
          <OperationChecks label={t('partners.operationsGranted')} selected={form.operations} language={language}
            onChange={(operations) => setForm({ ...form, operations })} />
        </div>
        {/* Not a choice: an external partner is view-only, and the API refuses
            any other level outright rather than quietly downgrading it. */}
        <label className="form-field"><span>{t('partners.accessLevel')}</span>
          <input readOnly tabIndex={-1} value={t('partners.viewOnly')} />
        </label>
      </div>
      <div className="form-submit-bar"><button className="primary-btn" type="submit" disabled={busy}>{t('partners.invite')}</button></div>
    </form>
  </>;
}

// Who the partner speaks for, who looks after them, and which projects they
// may follow. Projects are offered only inside the operations the partner
// already holds -- the API refuses anything else -- and ticking none shares
// those operations whole, as before.
function PartnerSharing({ partner, projects, contacts, language, t, busy, onCancel, onSave }) {
  const [organization, setOrganization] = useState(partner.organization || '');
  const [contactId, setContactId] = useState(partner.contactId ? String(partner.contactId) : '');
  const [chosen, setChosen] = useState((partner.projects || []).map((project) => project.id));
  const operations = partner.operations || [partner.operation];
  const offered = projects.filter((project) => operations.includes(project.sector));
  const toggle = (id) => setChosen(chosen.includes(id) ? chosen.filter((value) => value !== id) : [...chosen, id]);
  return <form className="partner-sharing" onSubmit={(event) => {
    event.preventDefault();
    onSave({ organization: organization.trim(), contactId: contactId ? Number(contactId) : null, projectIds: chosen });
  }}>
    <div className="form-grid">
      <label className="form-field"><span>{t('partners.organization')}</span>
        <input maxLength={200} value={organization} onChange={(event) => setOrganization(event.target.value)} />
      </label>
      <label className="form-field"><span>{t('partners.contact')}</span>
        <select value={contactId} onChange={(event) => setContactId(event.target.value)}>
          <option value="">{t('table.none')}</option>
          {contacts.map((person) => <option key={person.id} value={person.id}>{person.name} · {t(`role.${person.role}`)}</option>)}
        </select>
      </label>
      <div className="form-field form-field-wide"><span>{t('partners.sharedProjects')}</span>
        {offered.length
          ? <div className="operation-checks">{offered.map((project) => <label className="check-field" key={project.id}>
            <input type="checkbox" checked={chosen.includes(project.id)} onChange={() => toggle(project.id)} />
            <span>{project.name} · {operationName(project.sector, language)}</span>
          </label>)}</div>
          : <span className="muted-cell">{t('partners.noProjectsToShare')}</span>}
        <small className="field-hint">{t('partners.sharingHint')}</small>
      </div>
    </div>
    <div className="button-row">
      <button className="primary-btn" type="submit" disabled={busy}>{t('partners.saveSharing')}</button>
      <button className="secondary-btn" type="button" onClick={onCancel}>{t('action.cancel')}</button>
    </div>
  </form>;
}

function Metric({ label, value }) {
  return <div className="metric-card"><span>{label}</span><strong>{value}</strong></div>;
}
