import { useState } from 'react';
import { BUSINESS_OPERATIONS, operationName } from '../shared/businessOperations.js';

// The Director's control over External Business Partner access.
//
// Invite a partner, assign them one of the four business operations, change it,
// suspend, restore, revoke, or remove them. Access Level is View Only and is
// not a choice: an external partner never gets approval authority, so the field
// is shown as a fixed value rather than a dropdown that could be set wrong.

const emptyForm = { name: '', email: '', username: '', password: '', operation: 'farming' };

const STATUS_TONE = { active: 'tone-done', suspended: 'tone-waiting', revoked: 'tone-stopped' };

export default function ExternalPartners({ register, language, t, onInvite, onChangeOperation, onChangeStatus, onResetPassword, onRemove }) {
  const [form, setForm] = useState(emptyForm);

  const submit = (event) => {
    event.preventDefault();
    onInvite(form, () => setForm(emptyForm));
  };

  return <>
    <section className="context-strip">
      <div>
        <span className="eyebrow">EXTERNAL BUSINESS PARTNER ACCESS</span>
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
      {register.partners.length ? <div className="table-wrap"><table>
        <thead><tr>
          <th>{t('partners.name')}</th>
          <th>{t('partners.email')}</th>
          <th>{t('app.businessOperation')}</th>
          <th>{t('partners.accessLevel')}</th>
          <th>{t('partners.status')}</th>
          <th>{t('partners.visibleRecords')}</th>
          <th>{t('table.actions')}</th>
        </tr></thead>
        <tbody>{register.partners.map((partner) => <tr key={partner.id}>
          <td><strong>{partner.name}</strong><small>{partner.username}</small></td>
          <td>{partner.email || <span className="muted-cell">—</span>}</td>
          {/* Changing this one cell changes everything the partner can read, on
              their very next request. */}
          <td>
            <select
              value={partner.operation}
              onChange={(event) => onChangeOperation(partner, event.target.value)}
            >
              {BUSINESS_OPERATIONS.map((operation) => <option key={operation.id} value={operation.id}>
                {operationName(operation.id, language)}
              </option>)}
            </select>
          </td>
          <td><span className="status-badge">{t('partners.viewOnly')}</span></td>
          <td><span className={`status-badge ${STATUS_TONE[partner.status] || ''}`}>
            {t(`partners.${partner.status}`)}
          </span></td>
          <td>
            {partner.visibleActivities} {t('portal.activities').toLowerCase()}
            <small>{partner.visibleMovements} {t('portal.movements').toLowerCase()}</small>
          </td>
          <td className="queue-actions">
            {partner.status === 'active'
              ? <button className="secondary-btn compact" type="button" onClick={() => onChangeStatus(partner, 'suspended')}>{t('partners.suspend')}</button>
              : <button className="secondary-btn compact" type="button" onClick={() => onChangeStatus(partner, 'active')}>{t('partners.restore')}</button>}
            {partner.status !== 'revoked' && <button className="danger-btn outlined compact" type="button" onClick={() => onChangeStatus(partner, 'revoked')}>{t('partners.revoke')}</button>}
            <button className="text-btn" type="button" onClick={() => onResetPassword(partner)}>{t('partners.resetPassword')}</button>
            <button className="danger-btn" type="button" onClick={() => onRemove(partner)}>{t('partners.remove')}</button>
          </td>
        </tr>)}</tbody>
      </table></div> : <div className="empty-state">
        <strong>{t('partners.empty')}</strong>
        <span>{t('partners.blurb')}</span>
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
          <input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </label>
        <label className="form-field"><span>{t('partners.email')}</span>
          <input required type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
        </label>
        <label className="form-field"><span>{t('partners.username')}</span>
          <input required value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} />
        </label>
        <label className="form-field"><span>{t('partners.password')}</span>
          <input required type="password" minLength={6} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
        </label>
        {/* Exactly one of the four. There is no "all operations" option, because
            an external partner is only ever given one. */}
        <label className="form-field"><span>{t('app.businessOperation')}</span>
          <select value={form.operation} onChange={(event) => setForm({ ...form, operation: event.target.value })}>
            {BUSINESS_OPERATIONS.map((operation) => <option key={operation.id} value={operation.id}>
              {operationName(operation.id, language)}
            </option>)}
          </select>
        </label>
        {/* Not a choice: an external partner is view-only, and the API refuses
            any other level outright rather than quietly downgrading it. */}
        <label className="form-field"><span>{t('partners.accessLevel')}</span>
          <input readOnly value={t('partners.viewOnly')} />
        </label>
      </div>
      <button className="primary-btn" type="submit">{t('partners.invite')}</button>
    </form>
  </>;
}

function Metric({ label, value }) {
  return <div className="metric-card"><span>{label}</span><strong>{value}</strong></div>;
}
