import { useCallback, useEffect, useState } from 'react';
import { operationName } from '../shared/businessOperations.js';

// External Business Partner / Business Operation Access.
//
// The whole application, as seen by someone outside the organisation who has
// been given ONE business operation to follow. It is not a cut-down copy of the
// internal screens: it reads a different API (/api/partner/*) that returns only
// approved, externally released records for the operation on their own account.
//
// There is deliberately nothing here that writes. No approve, no reject, no
// edit, no internal notes, no evidence, no audit trail, no other operation.
// That is enforced by the backend -- authMiddleware refuses a partner account
// anything outside /api/partner -- and this file simply has nothing to draw.

const TABS = [
  ['overview', 'nav.overview'],
  ['activities', 'nav.activities'],
  ['movements', 'nav.movements'],
  ['reports', 'nav.reports'],
  ['updates', 'nav.updates']
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

export default function PartnerPortal({ user, fetchJson, language, t, onError }) {
  const [tab, setTab] = useState('overview');
  const [overview, setOverview] = useState(null);
  const [activities, setActivities] = useState([]);
  const [movements, setMovements] = useState([]);
  const [report, setReport] = useState(null);
  const [updates, setUpdates] = useState([]);
  const [loading, setLoading] = useState(true);

  // The operation is read from the signed-in account, never chosen here. There
  // is no operation picker in this interface because there is nothing to pick:
  // the account carries exactly one, and the API would refuse any other.
  const operation = operationName(user.sector, language);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [overviewResult, activityResult, movementResult, reportResult, updateResult] = await Promise.all([
        fetchJson('/api/partner/overview'),
        fetchJson('/api/partner/activities?limit=100'),
        fetchJson('/api/partner/movements?limit=100'),
        fetchJson('/api/partner/report?months=6'),
        fetchJson('/api/partner/updates?limit=30')
      ]);
      setOverview(overviewResult);
      setActivities(activityResult);
      setMovements(movementResult);
      setReport(reportResult);
      setUpdates(updateResult);
    } catch (loadError) {
      onError(loadError.message);
    } finally {
      setLoading(false);
    }
  }, [fetchJson, onError]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <div className="loading-state"><span className="spinner" />{t('app.loading')}</div>;
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

    <p className="partner-notice">
      <strong>{t('portal.approvedOnly')}.</strong> {t('portal.approvedOnlyNote')}
    </p>

    <nav className="partner-tabs">
      {TABS.map(([id, labelKey]) => <button
        key={id}
        type="button"
        className={tab === id ? 'partner-tab active' : 'partner-tab'}
        onClick={() => setTab(id)}
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
      {movements.length ? <div className="table-wrap"><table>
        <thead><tr>
          <th>{t('table.purpose')}</th><th>{t('table.destination')}</th><th>{t('table.date')}</th>
          <th>{t('table.budget')}</th><th>{t('table.status')}</th>
        </tr></thead>
        <tbody>{movements.map((movement) => <tr key={movement.id}>
          <td><strong>{movement.purpose}</strong><small>{movement.ref} · {movement.movementType}</small></td>
          <td>{movement.origin ? `${movement.origin} → ` : ''}{movement.destination}</td>
          <td>{formatDate(movement.departureDate, language)}</td>
          <td>{movement.currency} {new Intl.NumberFormat('en-US').format(movement.estimatedTotal)}</td>
          <td><span className={`status-badge ${statusTone(movement.status)}`}>{t(`status.${movement.status}`)}</span></td>
        </tr>)}</tbody>
      </table></div> : <EmptyState t={t}>{t('portal.noMovements')}</EmptyState>}
    </Panel>}

    {tab === 'reports' && report && <>
      <Panel title={t('portal.byMonth')} subtitle={operation}>
        {report.byMonth.length ? <div className="table-wrap"><table>
          <thead><tr>
            <th>{t('portal.period')}</th><th>{t('portal.activities')}</th>
            <th>{t('portal.completed')}</th><th>{t('portal.approvedBudget')}</th>
          </tr></thead>
          <tbody>{report.byMonth.map((row) => <tr key={row.period}>
            <td><strong>{row.period}</strong></td>
            <td>{row.activities}</td>
            <td>{row.completed}</td>
            <td>{formatMoney(row.approvedBudget)}</td>
          </tr>)}</tbody>
        </table></div> : <EmptyState t={t}>{t('portal.noActivities')}</EmptyState>}
      </Panel>
      <Panel title={t('portal.byCategory')} subtitle={operation}>
        {report.byCategory.length ? <div className="table-wrap"><table>
          <thead><tr>
            <th>{t('table.category')}</th><th>{t('portal.activities')}</th><th>{t('portal.approvedBudget')}</th>
          </tr></thead>
          <tbody>{report.byCategory.map((row) => <tr key={row.category}>
            <td><strong>{row.category}</strong></td>
            <td>{row.activities}</td>
            <td>{formatMoney(row.approvedBudget)}</td>
          </tr>)}</tbody>
        </table></div> : <EmptyState t={t}>{t('portal.noActivities')}</EmptyState>}
      </Panel>
    </>}

    {tab === 'updates' && <Panel title={t('portal.recentUpdates')} subtitle={operation}>
      {updates.length ? <ul className="history-list">{updates.map((update) => <li key={update.id}>
        <strong>{update.activity}</strong>
        <span>{t('portal.milestone')}: {t(`status.${update.milestone}`)}</span>
        <small>{formatDateTime(update.at, language)}</small>
      </li>)}</ul> : <EmptyState t={t}>{t('portal.noUpdates')}</EmptyState>}
    </Panel>}
  </>;
}

function ActivityTable({ rows, language, t, empty }) {
  if (!rows.length) return <EmptyState t={t}>{empty}</EmptyState>;
  return <div className="table-wrap"><table>
    <thead><tr>
      <th>{t('table.activity')}</th><th>{t('table.category')}</th><th>{t('table.budget')}</th>
      <th>{t('table.deadline')}</th><th>{t('table.status')}</th>
    </tr></thead>
    <tbody>{rows.map((row) => <tr key={row.id}>
      <td><strong>{row.activity}</strong><small>{row.description || row.projectName || ''}</small></td>
      <td>{row.category}</td>
      <td>{row.approvedBudget === null ? '—' : formatMoney(row.approvedBudget)}</td>
      <td>{formatDate(row.deadline, language)}</td>
      <td><span className={`status-badge ${statusTone(row.status)}`}>{t(`status.${row.status}`)}</span></td>
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
