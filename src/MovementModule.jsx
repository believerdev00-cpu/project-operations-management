import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApprovalPanel, approverName, canApproveRecord } from './ActivityReview.jsx';
import { displayLanguage, translate, useT } from './i18n.js';
import { operationName } from '../shared/businessOperations.js';

// Logistics & Facilitation module.
// Implements the "Movement_and_Facilitation_Side_Mockup" document: the
// dashboard (2), the create form (3), the facilitation cost breakdown and
// currency conversion (4), linking to another area of operation (5), the
// approval and completion workflow (6), Director controls (7), evidence and
// accountability (8) and the module reports (9).

export const MOVEMENT_TYPES = ['Staff', 'Equipment', 'Materials', 'Field Operation', 'Other'];
export const CURRENCIES = ['RWF', 'USD', 'CDF'];
export const EVIDENCE_KINDS = ['Receipt', 'Invoice', 'Fuel Slip', 'Hotel Receipt', 'Transport Ticket', 'Payment Proof', 'Photograph', 'Other'];
export const EVIDENCE_STATUSES = ['Pending', 'Partial', 'Complete'];
export const MOVEMENT_STATUSES = ['Draft', 'Pending Approval', 'Approved', 'Funds Released', 'In Progress', 'Completed', 'Rejected', 'Cancelled'];

// Areas a movement can be linked to. Logistics & Facilitation is its own area,
// so it never appears here (section 5).
const LINKABLE_AREAS = [
  { id: 'farming', name: 'Farming' },
  { id: 'agriculture', name: 'Agriculture' },
  { id: 'mining', name: 'Mining' }
];

const STATUS_FLOW = {
  Draft: ['Pending Approval', 'Cancelled'],
  'Pending Approval': ['Approved', 'Rejected', 'Cancelled', 'Draft'],
  Approved: ['Funds Released', 'In Progress', 'Rejected', 'Cancelled'],
  'Funds Released': ['In Progress', 'Completed', 'Cancelled'],
  'In Progress': ['Completed', 'Cancelled'],
  Completed: ['In Progress'],
  Rejected: ['Pending Approval'],
  Cancelled: ['Pending Approval']
};

// The key names the column; the second entry is the translation key for its
// label, so a cost line reads in the viewer's language.
const COST_LINES = [
  ['transport', 'cost.transport'],
  ['fuel', 'cost.fuel'],
  ['accommodation', 'cost.accommodation'],
  ['meals', 'cost.meals'],
  ['handling', 'cost.handling'],
  ['other', 'cost.other']
];

const TRANSPORT_SUGGESTIONS = ['Company Vehicle', 'Hired Vehicle', 'Motorcycle', 'Public Transport', 'Air', 'Boat', 'On Foot'];

const emptyForm = {
  movementType: 'Staff',
  purpose: '',
  relatedArea: '',
  origin: '',
  destination: '',
  departureDate: '',
  returnDate: '',
  personTeam: '',
  transportType: '',
  vehicleDriver: '',
  currency: 'RWF',
  category: '',
  notes: '',
  costs: { transport: '', fuel: '', accommodation: '', meals: '', handling: '', other: '' }
};

const emptyFilters = {
  status: 'All',
  relatedArea: 'All',
  currency: 'All',
  movementType: 'All',
  destination: '',
  personTeam: '',
  search: '',
  dateFrom: '',
  dateTo: ''
};

export function formatMoney(amount, currency = 'RWF') {
  const digits = currency === 'USD' ? 2 : 0;
  const value = new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number(amount || 0));
  return `${currency} ${value}`;
}

// Departure and return are calendar dates, not instants. Parsing "2026-09-10"
// with the Date constructor treats it as UTC midnight, which renders as the
// previous day west of Greenwich, so build the date from its own parts.
function formatDate(value) {
  if (!value) return '—';
  const [year, month, day] = String(value).slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return '—';
  return new Date(year, month - 1, day).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function toDateInput(value) {
  if (!value) return '';
  return /^\d{4}-\d{2}-\d{2}/.test(String(value)) ? String(value).slice(0, 10) : '';
}

// Named from the shared definition so a movement's operation reads the same
// here as it does everywhere else, in the viewer's language. A standalone
// movement belongs to Movements & Facilitation itself, which is not a linkable
// area but is very much an operation for the purpose of reading a record.
function areaLabel(area) {
  if (!area) return translate(displayLanguage(), 'filter.notLinked');
  return operationName(area, displayLanguage());
}

function statusTone(status) {
  if (['Completed'].includes(status)) return 'tone-done';
  if (['Approved', 'Funds Released', 'In Progress'].includes(status)) return 'tone-active';
  if (['Rejected', 'Cancelled'].includes(status)) return 'tone-stopped';
  return 'tone-waiting';
}

function sumCosts(costs) {
  return COST_LINES.reduce((total, [key]) => total + (Number(costs[key]) || 0), 0);
}

function movementToForm(movement) {
  return {
    movementType: movement.movementType,
    purpose: movement.purpose,
    relatedArea: movement.relatedArea || '',
    origin: movement.origin,
    destination: movement.destination,
    departureDate: toDateInput(movement.departureDate),
    returnDate: toDateInput(movement.returnDate),
    personTeam: movement.personTeam,
    transportType: movement.transportType,
    vehicleDriver: movement.vehicleDriver,
    currency: movement.currency,
    category: movement.category,
    notes: movement.notes,
    costs: Object.fromEntries(COST_LINES.map(([key]) => [key, String(movement.costs[key] ?? '')]))
  };
}

export default function MovementModule({ user, token, fetchJson, onMessage, onError }) {
  const t = useT();
  const isDirector = user.role === 'super-admin';
  const canCreate = isDirector || user.sector === 'movement';

  const [summary, setSummary] = useState(null);
  const [movements, setMovements] = useState([]);
  const [rate, setRate] = useState(null);
  const [filters, setFilters] = useState(emptyFilters);
  const [appliedFilters, setAppliedFilters] = useState(emptyFilters);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState(null);
  const [formState, setFormState] = useState(null);
  const [reports, setReports] = useState(null);
  const [showRates, setShowRates] = useState(false);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    Object.entries(appliedFilters).forEach(([key, value]) => {
      if (value && value !== 'All') params.set(key, value);
    });
    return params.toString();
  }, [appliedFilters]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [summaryResult, listResult, rateResult] = await Promise.all([
        fetchJson('/api/movements/summary'),
        fetchJson(`/api/movements${query ? `?${query}` : ''}`),
        fetchJson('/api/rates')
      ]);
      setSummary(summaryResult);
      setMovements(listResult);
      setRate(rateResult);
    } catch (loadError) {
      onError(loadError.message);
    } finally {
      setLoading(false);
    }
  }, [fetchJson, onError, query]);

  useEffect(() => { load(); }, [load]);

  const openDetail = async (movementId) => {
    try {
      setDetail(await fetchJson(`/api/movements/${movementId}`));
    } catch (detailError) {
      onError(detailError.message);
    }
  };

  const refreshDetail = async (movementId) => {
    await load();
    if (movementId) await openDetail(movementId);
  };

  const saveMovement = async (values, rateOverride, submitForReview) => {
    const body = {
      ...values,
      relatedArea: values.relatedArea || null,
      costs: Object.fromEntries(COST_LINES.map(([key]) => [key, Number(values.costs[key]) || 0])),
      ...(rateOverride ? { rateOverride } : {})
    };
    try {
      if (formState?.mode === 'edit') {
        await fetchJson(`/api/movements/${formState.movement.id}`, { method: 'PUT', body: JSON.stringify(body) });
        onMessage(`Movement ${formState.movement.ref} updated.`);
        setFormState(null);
        await refreshDetail(formState.movement.id);
      } else {
        const created = await fetchJson('/api/movements', {
          method: 'POST',
          body: JSON.stringify({ ...body, status: submitForReview ? 'Pending Approval' : 'Draft' })
        });
        onMessage(`Movement ${created.ref} created.`);
        setFormState(null);
        await refreshDetail(created.id);
      }
    } catch (saveError) {
      onError(saveError.message);
    }
  };

  const changeStatus = async (movement, status, extra = {}) => {
    try {
      await fetchJson(`/api/movements/${movement.id}/status`, { method: 'PATCH', body: JSON.stringify({ status, ...extra }) });
      onMessage(`${movement.ref} is now ${status}.`);
      await refreshDetail(movement.id);
    } catch (statusError) {
      onError(statusError.message);
    }
  };

  // The decision the record is waiting on. Separate from the status buttons: it
  // goes to the route that checks the caller is the named approver.
  const decideApproval = async (movement, body) => {
    try {
      await fetchJson(`/api/movements/${movement.id}/approval`, { method: 'PATCH', body: JSON.stringify(body) });
      onMessage(body.action === 'approve' ? `${movement.ref} approved.` : `${movement.ref} rejected.`);
      await refreshDetail(movement.id);
    } catch (approvalError) {
      onError(approvalError.message);
    }
  };

  const updateFinance = async (movement, body) => {
    try {
      await fetchJson(`/api/movements/${movement.id}/finance`, { method: 'PATCH', body: JSON.stringify(body) });
      onMessage('Facilitation figures updated.');
      await refreshDetail(movement.id);
    } catch (financeError) {
      onError(financeError.message);
    }
  };

  const removeMovement = async (movement) => {
    if (!window.confirm(`Delete movement ${movement.ref}? Its evidence and history are deleted with it.`)) return;
    try {
      await fetchJson(`/api/movements/${movement.id}`, { method: 'DELETE' });
      onMessage(`Movement ${movement.ref} deleted.`);
      setDetail(null);
      await load();
    } catch (deleteError) {
      onError(deleteError.message);
    }
  };

  const uploadEvidence = async (movement, formData) => {
    try {
      const response = await fetch(`/api/movements/${movement.id}/evidence`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'The evidence could not be uploaded.');
      onMessage(`${payload.length} evidence file${payload.length === 1 ? '' : 's'} attached to ${movement.ref}.`);
      await refreshDetail(movement.id);
    } catch (uploadError) {
      onError(uploadError.message);
    }
  };

  const removeEvidence = async (movement, evidence) => {
    if (!window.confirm(`Remove "${evidence.originalName}" from ${movement.ref}?`)) return;
    try {
      await fetchJson(`/api/movements/${movement.id}/evidence/${evidence.id}`, { method: 'DELETE' });
      onMessage('Evidence removed.');
      await refreshDetail(movement.id);
    } catch (evidenceError) {
      onError(evidenceError.message);
    }
  };

  const runReports = async () => {
    try {
      const params = new URLSearchParams();
      if (appliedFilters.dateFrom) params.set('dateFrom', appliedFilters.dateFrom);
      if (appliedFilters.dateTo) params.set('dateTo', appliedFilters.dateTo);
      setReports(await fetchJson(`/api/movements/reports${params.toString() ? `?${params}` : ''}`));
    } catch (reportError) {
      onError(reportError.message);
    }
  };

  const saveRate = async (values) => {
    try {
      const saved = await fetchJson('/api/rates', { method: 'PUT', body: JSON.stringify(values) });
      setRate(saved);
      onMessage('Reference exchange rate updated. Existing records keep the rate they were saved with.');
      await load();
    } catch (rateError) {
      onError(rateError.message);
    }
  };

  const counts = summary?.counts || {};
  const filtersActive = JSON.stringify(appliedFilters) !== JSON.stringify(emptyFilters);

  return <div className="movement-module">
    <section className="context-strip">
      <div>
        <span className="eyebrow">{t('movement.eyebrow')}</span>
        <h2>{isDirector ? t('role.super-admin') : user.sector === 'movement' ? t('movement.movementOfficer') : `${areaLabel(user.sector)} — ${t('movement.linkedMovements')}`}</h2>
        <p>{t('movement.blurb')}</p>
      </div>
      {canCreate && <button className="primary-btn" type="button" onClick={() => setFormState({ mode: 'create', values: emptyForm })}>
        {t('action.createMovement')}
      </button>}
    </section>

    <div className="metric-grid metric-grid-5">
      <Metric label={t('movement.totalRequests')} value={counts.total ?? 0} />
      <Metric label={t('movement.pendingApproval')} value={counts.pending ?? 0} />
      <Metric label={t('approval.approved')} value={counts.approved ?? 0} />
      <Metric label={t('portal.inProgress')} value={counts.ongoing ?? 0} />
      <Metric label={t('portal.completed')} value={counts.completed ?? 0} />
    </div>

    {summary && <section className="totals-strip">
      <TotalBlock label={t('movement.estimatedFacilitation')} totals={summary.totals.estimated} />
      <TotalBlock label={t('movement.fundsReleased')} totals={summary.totals.released} />
      <TotalBlock label={t('movement.actualExpense')} totals={summary.totals.actual} />
      <TotalBlock label={t('movement.balanceReturn')} totals={summary.totals.balance} />
      <div className="total-block total-block-note">
        <span>{t('movement.referenceRate')}</span>
        <strong>1 USD = {Number(summary.rate.rwfPerUsd).toLocaleString()} RWF</strong>
        <small>1 USD = {Number(summary.rate.cdfPerUsd).toLocaleString()} CDF · {formatDateTime(summary.rate.updatedAt)}</small>
        {isDirector && <button className="text-btn" type="button" onClick={() => setShowRates((current) => !current)}>
          {showRates ? t('action.hideRate') : t('action.updateRate')}
        </button>}
      </div>
    </section>}

    {isDirector && showRates && <RatePanel rate={rate} fetchJson={fetchJson} onSave={saveRate} onError={onError} />}

    {formState && <MovementForm
      key={formState.mode === 'edit' ? formState.movement.id : 'create'}
      mode={formState.mode}
      movement={formState.movement}
      initialValues={formState.values}
      rate={rate}
      isDirector={isDirector}
      onCancel={() => setFormState(null)}
      onSave={saveMovement}
    />}

    <MovementFilters
      filters={filters}
      setFilters={setFilters}
      onApply={() => setAppliedFilters(filters)}
      onClear={() => { setFilters(emptyFilters); setAppliedFilters(emptyFilters); }}
      active={filtersActive}
    />

    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>{t('panel.movementRegister')}</h2>
          <span>{movements.length}</span>
        </div>
        <button className="text-btn" type="button" onClick={load}>{t('action.refresh')}</button>
      </div>
      {loading
        ? <div className="loading-state"><span className="spinner" />{t('app.loading')}</div>
        : <MovementTable movements={movements} selectedId={detail?.movement.id} onSelect={openDetail} />}
    </section>

    {detail && <MovementDetail
      key={detail.movement.id}
      detail={detail}
      user={user}
      token={token}
      isDirector={isDirector}
      onClose={() => setDetail(null)}
      onEdit={(movement) => setFormState({ mode: 'edit', movement, values: movementToForm(movement) })}
      onStatus={changeStatus}
      onApprove={decideApproval}
      onFinance={updateFinance}
      onUpload={uploadEvidence}
      onRemoveEvidence={removeEvidence}
      onDelete={removeMovement}
    />}

    <MovementReports reports={reports} onRun={runReports} onClose={() => setReports(null)} />
  </div>;
}

function Metric({ label, value }) {
  return <div className="metric-card"><span>{label}</span><strong>{value}</strong></div>;
}

function TotalBlock({ label, totals }) {
  return <div className="total-block">
    <span>{label}</span>
    <strong>{formatMoney(totals.rwf, 'RWF')}</strong>
    <small>{formatMoney(totals.usd, 'USD')} · {formatMoney(totals.cdf, 'CDF')}</small>
  </div>;
}

function MovementFilters({ filters, setFilters, onApply, onClear, active }) {
  const t = useT();
  const set = (patch) => setFilters({ ...filters, ...patch });
  return <form className="filter-panel" onSubmit={(event) => { event.preventDefault(); onApply(); }}>
    <div className="panel-header">
      <div><h2>{t('panel.filterMovements')}</h2><span>{t('filter.blurb')}</span></div>
    </div>
    <div className="filter-grid">
      <label className="form-field"><span>{t('field.search')}</span><input placeholder={t('movement.searchPlaceholder')} value={filters.search} onChange={(event) => set({ search: event.target.value })} /></label>
      <label className="form-field"><span>{t('table.status')}</span><select value={filters.status} onChange={(event) => set({ status: event.target.value })}><option value="All">{t('form.allStatuses')}</option>{MOVEMENT_STATUSES.map((status) => <option key={status} value={status}>{t(`status.${status}`)}</option>)}</select></label>
      <label className="form-field"><span>{t('movement.relatedArea')}</span><select value={filters.relatedArea} onChange={(event) => set({ relatedArea: event.target.value })}><option value="All">{t('app.allOperations')}</option><option value="None">{t('filter.notLinked')}</option>{LINKABLE_AREAS.map((area) => <option key={area.id} value={area.id}>{areaLabel(area.id)}</option>)}</select></label>
      <label className="form-field"><span>{t('movement.movementType')}</span><select value={filters.movementType} onChange={(event) => set({ movementType: event.target.value })}><option value="All">{t('filter.allTypes')}</option>{MOVEMENT_TYPES.map((type) => <option key={type} value={type}>{t(`mtype.${type}`)}</option>)}</select></label>
      <label className="form-field"><span>{t('field.currency')}</span><select value={filters.currency} onChange={(event) => set({ currency: event.target.value })}><option value="All">{t('filter.allCurrencies')}</option>{CURRENCIES.map((currency) => <option key={currency}>{currency}</option>)}</select></label>
      <label className="form-field"><span>{t('table.destination')}</span><input value={filters.destination} onChange={(event) => set({ destination: event.target.value })} /></label>
      <label className="form-field"><span>{t('movement.personTeam')}</span><input value={filters.personTeam} onChange={(event) => set({ personTeam: event.target.value })} /></label>
      <label className="form-field"><span>{t('movement.departureFrom')}</span><input type="date" value={filters.dateFrom} onChange={(event) => set({ dateFrom: event.target.value })} /></label>
      <label className="form-field"><span>{t('movement.departureTo')}</span><input type="date" value={filters.dateTo} onChange={(event) => set({ dateTo: event.target.value })} /></label>
    </div>
    <div className="button-row">
      <button className="primary-btn" type="submit">{t('action.applyFilters')}</button>
      {active && <button className="secondary-btn" type="button" onClick={onClear}>{t('action.clear')}</button>}
    </div>
  </form>;
}

function MovementTable({ movements, selectedId, onSelect }) {
  const t = useT();
  if (!movements.length) {
    return <div className="empty-state"><strong>{t('empty.noMovements')}</strong><span>{t('empty.noMovementsHint')}</span></div>;
  }
  return <div className="table-wrap"><table>
    <thead><tr>
      <th>{t('movement.reference')}</th><th>{t('field.type')}</th><th>{t('table.purpose')}</th><th>{t('movement.relatedArea')}</th><th>{t('movement.route')}</th>
      <th>{t('movement.departure')}</th><th>{t('movement.personTeam')}</th><th>{t('table.status')}</th>
      <th>{t('movement.estimated')}</th><th>{t('movement.released')}</th><th>{t('movement.actual')}</th><th>{t('movement.balance')}</th><th>{t('field.evidence')}</th>
    </tr></thead>
    <tbody>{movements.map((movement) => <tr
      key={movement.id}
      className={movement.id === selectedId ? 'row-selected' : undefined}
      onClick={() => onSelect(movement.id)}
    >
      <td><strong>{movement.ref}</strong><small>{formatDateTime(movement.createdAt)}</small></td>
      <td>{movement.movementType}</td>
      <td>{movement.purpose}</td>
      <td>{movement.relatedArea ? <span className="area-badge">{areaLabel(movement.relatedArea)}</span> : <small>Not linked</small>}</td>
      <td>{movement.origin || '—'} &rarr; {movement.destination}</td>
      <td>{formatDate(movement.departureDate)}<small>Return {formatDate(movement.returnDate)}</small></td>
      <td>{movement.personTeam || '—'}</td>
      <td><span className={`status-badge ${statusTone(movement.status)}`}>{movement.status}</span></td>
      <td>{formatMoney(movement.estimatedTotal, movement.currency)}</td>
      <td>{formatMoney(movement.fundsReleased, movement.currency)}</td>
      <td>{formatMoney(movement.actualExpense, movement.currency)}</td>
      <td>{formatMoney(movement.balanceReturn, movement.currency)}</td>
      <td><span className={`status-badge ${movement.evidenceStatus === 'Complete' ? 'tone-done' : 'tone-waiting'}`}>{movement.evidenceStatus}</span><small>{movement.evidenceCount ?? 0} file{(movement.evidenceCount ?? 0) === 1 ? '' : 's'}</small></td>
    </tr>)}</tbody>
  </table></div>;
}

// Section 3 (request details) and section 4 (facilitation cost breakdown).
function MovementForm({ mode, movement, initialValues, rate, isDirector, onCancel, onSave }) {
  const t = useT();
  const [values, setValues] = useState(initialValues);
  const [useActualRate, setUseActualRate] = useState(false);
  const [actualRate, setActualRate] = useState({
    rwfPerUsd: String(movement?.rate?.rwfPerUsd ?? rate?.rwfPerUsd ?? ''),
    cdfPerUsd: String(movement?.rate?.cdfPerUsd ?? rate?.cdfPerUsd ?? '')
  });

  const set = (patch) => setValues((current) => ({ ...current, ...patch }));
  const setCost = (key, value) => setValues((current) => ({ ...current, costs: { ...current.costs, [key]: value } }));

  const total = sumCosts(values.costs);

  // Live conversion preview using the rate that will be stored on the record.
  const effectiveRate = useActualRate && Number(actualRate.rwfPerUsd) > 0 && Number(actualRate.cdfPerUsd) > 0
    ? { rwfPerUsd: Number(actualRate.rwfPerUsd), cdfPerUsd: Number(actualRate.cdfPerUsd) }
    : rate;

  const converted = useMemo(() => {
    if (!effectiveRate) return null;
    const usd = values.currency === 'USD'
      ? total
      : values.currency === 'CDF'
        ? total / effectiveRate.cdfPerUsd
        : total / effectiveRate.rwfPerUsd;
    return { usd, rwf: usd * effectiveRate.rwfPerUsd, cdf: usd * effectiveRate.cdfPerUsd };
  }, [total, values.currency, effectiveRate]);

  const submit = (event, submitForReview) => {
    event.preventDefault();
    onSave(values, useActualRate ? { rwfPerUsd: Number(actualRate.rwfPerUsd), cdfPerUsd: Number(actualRate.cdfPerUsd) } : null, submitForReview);
  };

  return <form className="form-panel movement-form" onSubmit={(event) => submit(event, true)}>
    <div className="panel-header">
      <div>
        <h2>{mode === 'edit' ? `${t('movement.editMovementTitle')} ${movement.ref}` : t('movement.newMovement')}</h2>
        <span>{t('movement.formBlurb')}</span>
      </div>
      <button className="text-btn" type="button" onClick={onCancel}>{t('action.cancel')}</button>
    </div>

    <h3 className="form-section-title">{t('review.requestDetails')}</h3>
    <div className="form-grid movement-grid">
      <label className="form-field"><span>{t('movement.referenceNo')}</span>
        {mode === 'edit'
          ? <span className="read-only-value">{movement.ref}</span>
          : <span className="read-only-value">{t('movement.generatedOnSave')} (MF-{new Date().getFullYear()}-0000)</span>}
      </label>
      <label className="form-field"><span>{t('movement.movementType')}</span>
        <select value={values.movementType} onChange={(event) => set({ movementType: event.target.value })}>
          {MOVEMENT_TYPES.map((type) => <option key={type} value={type}>{t(`mtype.${type}`)}</option>)}
        </select>
      </label>
      <label className="form-field"><span>{t('movement.relatedArea')}</span>
        <select value={values.relatedArea} onChange={(event) => set({ relatedArea: event.target.value })}>
          <option value="">{t('movement.notLinkedOption')}</option>
          {LINKABLE_AREAS.map((area) => <option key={area.id} value={area.id}>{areaLabel(area.id)}</option>)}
        </select>
      </label>
      <label className="form-field form-field-wide"><span>{t('table.purpose')}</span>
        <input required value={values.purpose} onChange={(event) => set({ purpose: event.target.value })} />
      </label>
      <label className="form-field"><span>{t('movement.origin')}</span>
        <input required value={values.origin} onChange={(event) => set({ origin: event.target.value })} />
      </label>
      <label className="form-field"><span>{t('table.destination')}</span>
        <input required value={values.destination} onChange={(event) => set({ destination: event.target.value })} />
      </label>
      <label className="form-field"><span>{t('movement.departureDate')}</span>
        <input type="date" value={values.departureDate} onChange={(event) => set({ departureDate: event.target.value })} />
      </label>
      <label className="form-field"><span>{t('movement.returnDate')}</span>
        <input type="date" min={values.departureDate || undefined} value={values.returnDate} onChange={(event) => set({ returnDate: event.target.value })} />
      </label>
      <label className="form-field"><span>{t('movement.personTeam')}</span>
        <input value={values.personTeam} onChange={(event) => set({ personTeam: event.target.value })} />
      </label>
      <label className="form-field"><span>{t('movement.transportType')}</span>
        <input list="transport-suggestions" value={values.transportType} onChange={(event) => set({ transportType: event.target.value })} />
        <datalist id="transport-suggestions">{TRANSPORT_SUGGESTIONS.map((option) => <option key={option} value={option} />)}</datalist>
      </label>
      <label className="form-field"><span>{t('movement.vehicleDriver')}</span>
        <input value={values.vehicleDriver} onChange={(event) => set({ vehicleDriver: event.target.value })} />
      </label>
      <label className="form-field"><span>{t('field.currency')}</span>
        <select value={values.currency} onChange={(event) => set({ currency: event.target.value })}>
          {CURRENCIES.map((currency) => <option key={currency}>{currency}</option>)}
        </select>
      </label>
      <label className="form-field form-field-wide"><span>{t('field.notes')}</span>
        <input placeholder={t('movement.notesPlaceholder')} value={values.notes} onChange={(event) => set({ notes: event.target.value })} />
      </label>
    </div>

    <h3 className="form-section-title">{t('movement.costBreakdown')}</h3>
    <div className="cost-grid">
      {COST_LINES.map(([key, labelKey]) => <label className="form-field" key={key}>
        <span>{t(labelKey)}</span>
        <input type="number" min="0" step="0.01" placeholder="0" value={values.costs[key]} onChange={(event) => setCost(key, event.target.value)} />
      </label>)}
      <div className="cost-total">
        <span>{t('field.total')}</span>
        <strong>{formatMoney(total, values.currency)}</strong>
      </div>
    </div>

    {converted && <div className="conversion-strip">
      <div><span>{t('field.equivalent')}</span><strong>{formatMoney(converted.rwf, 'RWF')} · {formatMoney(converted.usd, 'USD')} · {formatMoney(converted.cdf, 'CDF')}</strong></div>
      <small>
        {t('movement.rateStored')}: 1 USD = {Number(effectiveRate.rwfPerUsd).toLocaleString()} RWF / {Number(effectiveRate.cdfPerUsd).toLocaleString()} CDF
        {' '}({useActualRate ? t('movement.actualRate') : t('movement.refRate')})
      </small>
    </div>}

    {isDirector && <div className="rate-override">
      <label className="check-field">
        <input type="checkbox" checked={useActualRate} onChange={(event) => setUseActualRate(event.target.checked)} />
        {t('movement.useActualRate')}
      </label>
      {useActualRate && <div className="form-grid">
        <label className="form-field"><span>{t('movement.rwfPerUsdShort')}</span>
          <input type="number" min="0.000001" step="0.01" value={actualRate.rwfPerUsd} onChange={(event) => setActualRate({ ...actualRate, rwfPerUsd: event.target.value })} />
        </label>
        <label className="form-field"><span>{t('movement.cdfPerUsdShort')}</span>
          <input type="number" min="0.000001" step="0.01" value={actualRate.cdfPerUsd} onChange={(event) => setActualRate({ ...actualRate, cdfPerUsd: event.target.value })} />
        </label>
      </div>}
    </div>}

    <div className="button-row">
      <button className="primary-btn" type="submit">{mode === 'edit' ? t('movement.saveChanges') : t('movement.createAndSubmit')}</button>
      {mode === 'create' && <button className="secondary-btn" type="button" onClick={(event) => submit(event, false)}>{t('action.saveDraft')}</button>}
    </div>
  </form>;
}

// Sections 6, 7 and 8: workflow actions, accountability figures, evidence, history.
function MovementDetail({ detail, user, token, isDirector, onClose, onEdit, onStatus, onApprove, onFinance, onUpload, onRemoveEvidence, onDelete }) {
  const t = useT();
  const { movement, evidence, history } = detail;
  const [finance, setFinance] = useState({
    fundsReleased: String(movement.fundsReleased),
    actualExpense: String(movement.actualExpense),
    evidenceStatus: movement.evidenceStatus
  });
  const [reason, setReason] = useState('');
  const [approval, setApproval] = useState({
    approvedBudget: String(movement.estimatedTotal),
    adminNote: '',
    rejectionReason: ''
  });

  const canEdit = isDirector || (user.sector === 'movement' && movement.createdBy === user.id && ['Draft', 'Pending Approval'].includes(movement.status));
  const canAttach = isDirector || (user.sector === 'movement' && movement.createdBy === user.id);
  // Whether this user is the person the record is waiting on. The API checks
  // the same thing again before it writes anything.
  const iAmApprover = canApproveRecord(user, movement);
  const canChangeBudget = iAmApprover && isDirector;
  const typedBudget = Number(approval.approvedBudget || 0);
  const budgetChanged = canChangeBudget && typedBudget !== Number(movement.estimatedTotal);
  const nextStatuses = (STATUS_FLOW[movement.status] || []).filter((status) => {
    // Approving is a decision with a named approver, not a status button.
    if (status === 'Approved' && movement.approvalRequired && movement.approvalStatus === 'pending') return false;
    if (isDirector) return true;
    return movement.status === 'Draft' && status === 'Pending Approval' && movement.createdBy === user.id;
  });

  return <section className="panel detail-panel">
    <div className="panel-header">
      <div>
        <h2>{movement.ref} — {movement.purpose}</h2>
        <span>
          {movement.movementType} · {movement.origin || '—'} &rarr; {movement.destination} · {areaLabel(movement.relatedArea)} ·
          {' '}created by {movement.createdByName || 'Unknown'} on {formatDateTime(movement.createdAt)}
        </span>
      </div>
      <button className="text-btn" type="button" onClick={onClose}>{t('action.close')}</button>
    </div>

    <ApprovalPanel record={movement} sectorLabel={areaLabel} />

    <div className="detail-facts">
      <Fact label={t('table.status')} value={<span className={`status-badge ${statusTone(movement.status)}`}>{t(`status.${movement.status}`)}</span>} />
      <Fact label={t('table.department')} value={areaLabel(movement.department)} />
      <Fact label={t('movement.departure')} value={formatDate(movement.departureDate)} />
      <Fact label={t('movement.return')} value={formatDate(movement.returnDate)} />
      <Fact label={t('movement.personTeam')} value={movement.personTeam || '—'} />
      <Fact label={t('table.assignedTo')} value={movement.assignedToName || <span className="muted-cell">{t('review.notAssigned')}</span>} />
      <Fact label={t('movement.transport')} value={movement.transportType || '—'} />
      <Fact label={t('movement.vehicleDriverShort')} value={movement.vehicleDriver || '—'} />
      <Fact label={t('field.currency')} value={movement.currency} />
      <Fact label={t('approval.approvedBy')} value={movement.approvedByName ? `${movement.approvedByName} · ${formatDateTime(movement.approvedAt)}` : t('review.notReviewed')} />
    </div>
    {movement.notes && <p className="detail-notes">{movement.notes}</p>}
    {movement.adminNote && <p className="detail-notes admin-note">&ldquo;{movement.adminNote}&rdquo;</p>}

    {/* The decision this record is waiting on, drawn only for the person it
        names. The API refuses anybody else regardless of what is on screen. */}
    {iAmApprover && <form className="decision-form approval-form" onSubmit={(event) => {
      event.preventDefault();
      onApprove(movement, {
        action: 'approve',
        ...(canChangeBudget ? { approvedBudget: typedBudget } : {}),
        adminNote: approval.adminNote.trim()
      });
    }}>
      <h3 className="form-section-title">{t('approval.yourDecision')}</h3>
      <div className="form-grid">
        {canChangeBudget && <label className="form-field"><span>{t('review.approvedBudget')} ({movement.currency})</span>
          <input type="number" min="0" step="0.01" value={approval.approvedBudget}
            onChange={(event) => setApproval({ ...approval, approvedBudget: event.target.value })} />
        </label>}
        <label className="form-field form-field-wide">
          <span>{t('review.directorNote')} ({budgetChanged ? t('field.required') : t('field.optional')})</span>
          <textarea rows="2"
            value={approval.adminNote} onChange={(event) => setApproval({ ...approval, adminNote: event.target.value })} />
        </label>
        <label className="form-field form-field-wide"><span>{t('review.reasonIfReject')}</span>
          <input
            value={approval.rejectionReason} onChange={(event) => setApproval({ ...approval, rejectionReason: event.target.value })} />
        </label>
      </div>
      {budgetChanged && <p className="decision-hint">
        {formatMoney(movement.estimatedTotal, movement.currency)} &rarr; {formatMoney(typedBudget, movement.currency)}
      </p>}
      <div className="button-row">
        <button className="primary-btn" type="submit">{t('approval.approve')}</button>
        <button className="danger-btn outlined" type="button"
          disabled={!approval.rejectionReason.trim()}
          onClick={() => onApprove(movement, { action: 'reject', rejectionReason: approval.rejectionReason.trim() })}>
          {t('approval.reject')}
        </button>
      </div>
    </form>}
    {!iAmApprover && movement.approvalRequired && movement.approvalStatus === 'pending' && movement.status !== 'Draft' && <p className="decision-hint">
      {t('approval.waitingFor')} {approverName(movement, areaLabel, t)} {t('review.waitingOnOther')}
    </p>}

    <h3 className="form-section-title">{t('movement.costBreakdown')}</h3>
    <div className="table-wrap"><table className="cost-table">
      <thead><tr><th>{t('movement.costItem')}</th><th>{t('field.amount')}</th></tr></thead>
      <tbody>
        {COST_LINES.map(([key, labelKey]) => <tr key={key}><td>{t(labelKey)}</td><td>{formatMoney(movement.costs[key], movement.currency)}</td></tr>)}
        <tr className="total-row"><td><strong>{t('field.total')}</strong></td><td><strong>{formatMoney(movement.estimatedTotal, movement.currency)}</strong></td></tr>
      </tbody>
    </table></div>
    {movement.converted && <p className="detail-notes">
      {t('movement.equivalentAt')} ({Number(movement.rate.rwfPerUsd).toLocaleString()} RWF / {Number(movement.rate.cdfPerUsd).toLocaleString()} CDF / USD,
      {' '}{movement.rate.source === 'actual' ? t('movement.actualRate') : t('movement.refRate')}, {formatDateTime(movement.rate.recordedAt)}):
      {' '}{formatMoney(movement.converted.estimatedTotal.rwf, 'RWF')} · {formatMoney(movement.converted.estimatedTotal.usd, 'USD')} · {formatMoney(movement.converted.estimatedTotal.cdf, 'CDF')}
    </p>}

    <h3 className="form-section-title">{t('movement.evidenceAccountability')}</h3>
    <div className="accountability-grid">
      <Fact label={t('movement.estimatedFacilitation')} value={formatMoney(movement.estimatedTotal, movement.currency)} />
      <Fact label={t('movement.fundsReleased')} value={formatMoney(movement.fundsReleased, movement.currency)} />
      <Fact label={t('movement.actualExpense')} value={formatMoney(movement.actualExpense, movement.currency)} />
      <Fact label={t('movement.balanceReturn')} value={formatMoney(movement.balanceReturn, movement.currency)} />
      <Fact label={t('movement.evidenceStatus')} value={<span className={`status-badge ${movement.evidenceStatus === 'Complete' ? 'tone-done' : 'tone-waiting'}`}>{movement.evidenceStatus}</span>} />
    </div>

    {isDirector && <form className="inline-form" onSubmit={(event) => {
      event.preventDefault();
      onFinance(movement, {
        fundsReleased: Number(finance.fundsReleased) || 0,
        actualExpense: Number(finance.actualExpense) || 0,
        evidenceStatus: finance.evidenceStatus
      });
    }}>
      <label className="form-field"><span>{t('movement.fundsReleased')} ({movement.currency})</span>
        <input type="number" min="0" step="0.01" value={finance.fundsReleased} onChange={(event) => setFinance({ ...finance, fundsReleased: event.target.value })} />
      </label>
      <label className="form-field"><span>{t('movement.actualExpense')} ({movement.currency})</span>
        <input type="number" min="0" step="0.01" value={finance.actualExpense} onChange={(event) => setFinance({ ...finance, actualExpense: event.target.value })} />
      </label>
      <label className="form-field"><span>{t('movement.evidenceStatus')}</span>
        <select value={finance.evidenceStatus} onChange={(event) => setFinance({ ...finance, evidenceStatus: event.target.value })}>
          {EVIDENCE_STATUSES.map((status) => <option key={status} value={status}>{t(`estatus.${status}`)}</option>)}
        </select>
      </label>
      <button className="secondary-btn" type="submit">{t('action.recordFigures')}</button>
    </form>}

    {canAttach && <EvidenceUpload movement={movement} onUpload={onUpload} />}
    <EvidenceList
      movement={movement}
      evidence={evidence}
      token={token}
      canRemove={isDirector}
      onRemove={(item) => onRemoveEvidence(movement, item)}
    />

    <h3 className="form-section-title">{t('movement.workflow')}</h3>
    <p className="workflow-trail">{t('movement.workflowTrail')}</p>
    {nextStatuses.length
      ? <div className="button-row workflow-actions">
          {nextStatuses.map((status) => <button
            key={status}
            className={['Rejected', 'Cancelled'].includes(status) ? 'danger-btn outlined' : 'secondary-btn'}
            type="button"
            onClick={() => onStatus(movement, status, {
              reason: reason || undefined,
              ...(status === 'Funds Released' ? { fundsReleased: Number(finance.fundsReleased) || Number(movement.estimatedTotal) } : {}),
              ...(status === 'Completed' ? { actualExpense: Number(finance.actualExpense) || 0 } : {})
            })}
          >{status === 'Pending Approval' && movement.status === 'Draft' ? t('action.submitForApproval') : `${t('action.markAs')} ${t(`status.${status}`)}`}</button>)}
          {isDirector && <input className="reason-input" placeholder={`${t('field.reason')} (${t('field.optional')})`} value={reason} onChange={(event) => setReason(event.target.value)} />}
        </div>
      : <p className="detail-notes">{t('movement.noFurtherStatus')}</p>}

    <div className="button-row">
      {canEdit && <button className="secondary-btn" type="button" onClick={() => onEdit(movement)}>{t('action.editMovement')}</button>}
      {isDirector && <button className="danger-btn outlined" type="button" onClick={() => onDelete(movement)}>{t('action.deleteMovement')}</button>}
    </div>

    <h3 className="form-section-title">{t('movement.historyTitle')}</h3>
    {history.length
      ? <ul className="history-list">{history.map((entry) => <li key={entry.id}>
          <strong>{entry.action}</strong>
          <span>
            {entry.field ? `${entry.field}: ` : ''}
            {entry.oldValue !== null && entry.oldValue !== undefined && entry.oldValue !== '' ? `${entry.oldValue} → ` : ''}
            {entry.newValue ?? '—'}
          </span>
          <small>{entry.actorName} · {formatDateTime(entry.createdAt)}</small>
        </li>)}</ul>
      : <div className="empty-state"><strong>{t('empty.noHistory')}</strong><span>{t('empty.historyBlurb')}</span></div>}
  </section>;
}

function Fact({ label, value }) {
  return <div className="fact"><span>{label}</span><strong>{value}</strong></div>;
}

function EvidenceUpload({ movement, onUpload }) {
  const t = useT();
  const [kind, setKind] = useState('Receipt');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [files, setFiles] = useState(null);
  const [inputKey, setInputKey] = useState(0);

  const submit = (event) => {
    event.preventDefault();
    if (!files?.length) return;
    const formData = new FormData();
    formData.append('kind', kind);
    formData.append('amount', amount || '0');
    formData.append('note', note);
    Array.from(files).forEach((file) => formData.append('files', file));
    onUpload(movement, formData);
    setAmount(''); setNote(''); setFiles(null); setInputKey((current) => current + 1);
  };

  return <form className="inline-form" onSubmit={submit}>
    <label className="form-field"><span>{t('field.evidenceType')}</span>
      <select value={kind} onChange={(event) => setKind(event.target.value)}>{EVIDENCE_KINDS.map((option) => <option key={option} value={option}>{t(`ekind.${option}`)}</option>)}</select>
    </label>
    <label className="form-field"><span>{t('field.amount')} ({movement.currency})</span>
      <input type="number" min="0" step="0.01" placeholder="0" value={amount} onChange={(event) => setAmount(event.target.value)} />
    </label>
    <label className="form-field"><span>{t('field.note')}</span>
      <input placeholder={t('evidence.fuelNotePlaceholder')} value={note} onChange={(event) => setNote(event.target.value)} />
    </label>
    <label className="form-field"><span>{t('field.files')}</span>
      <input key={inputKey} type="file" multiple accept="image/*,application/pdf" onChange={(event) => setFiles(event.target.files)} />
    </label>
    <button className="secondary-btn" type="submit" disabled={!files?.length}>{t('action.uploadEvidence')}</button>
  </form>;
}

function EvidenceList({ movement, evidence, token, canRemove, onRemove }) {
  const t = useT();
  if (!evidence.length) {
    return <div className="empty-state"><strong>{t('empty.noEvidence')}</strong><span>{t('empty.noEvidenceHint')}</span></div>;
  }
  return <div className="table-wrap"><table>
    <thead><tr><th>{t('field.type')}</th><th>{t('field.file')}</th><th>{t('field.amount')}</th><th>{t('field.note')}</th><th>{t('field.uploadedBy')}</th><th>{t('table.date')}</th><th>{t('table.actions')}</th></tr></thead>
    <tbody>{evidence.map((item) => <tr key={item.id}>
      <td>{item.kind}</td>
      <td><strong>{item.originalName}</strong><small>{(item.sizeBytes / 1024).toFixed(0)} KB · {item.mimeType}</small></td>
      <td>{item.amount ? formatMoney(item.amount, movement.currency) : '—'}</td>
      <td>{item.note || '—'}</td>
      <td>{item.uploadedByName || '—'}</td>
      <td>{formatDateTime(item.createdAt)}</td>
      <td>
        <a
          className="text-btn"
          href={`/api/movements/${movement.id}/evidence/${item.id}/file?token=${encodeURIComponent(token)}`}
          target="_blank"
          rel="noreferrer"
        >{t('action.view')}</a>
        {canRemove && <button className="danger-btn" type="button" onClick={() => onRemove(item)}>{t('action.remove')}</button>}
      </td>
    </tr>)}</tbody>
  </table></div>;
}

// Section 9.
function MovementReports({ reports, onRun, onClose }) {
  const t = useT();
  return <section className="report-area">
    <div className="panel-header">
      <div><h2>{t('movement.reportsTitle')}</h2></div>
      <div className="report-actions">
        <button className="secondary-btn" type="button" onClick={onRun}>{t('action.runReport')}</button>
        {reports && <button className="text-btn" type="button" onClick={onClose}>{t('action.close')}</button>}
      </div>
    </div>
    {reports && <div className="report-body">
      <div className="metric-grid metric-grid-5">
        <Metric label={t('movement.movements')} value={reports.movementCount} />
        <Metric label={t('movement.outstandingRequests')} value={reports.outstanding} />
        <Metric label={t('portal.completed')} value={reports.completed} />
        <Metric label={t('movement.evidenceOutstanding')} value={reports.evidenceOutstanding} />
        <Metric label={`${t('cost.fuel')} + ${t('cost.transport')} (RWF)`} value={new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(reports.fuelAndTransport.fuel.rwf + reports.fuelAndTransport.transport.rwf)} />
      </div>
      <div className="totals-strip">
        <TotalBlock label={t('movement.estimatedFacilitation')} totals={reports.totals.estimated} />
        <TotalBlock label={t('movement.fundsReleased')} totals={reports.totals.released} />
        <TotalBlock label={t('movement.actualExpense')} totals={reports.totals.actual} />
        <TotalBlock label={t('movement.balanceReturn')} totals={reports.totals.balance} />
        <div className="total-block total-block-note">
          <span>{t('movement.fuelVsTransport')}</span>
          <strong>{t('cost.fuel')} {formatMoney(reports.fuelAndTransport.fuel.rwf, 'RWF')}</strong>
          <small>{t('cost.transport')} {formatMoney(reports.fuelAndTransport.transport.rwf, 'RWF')}</small>
        </div>
      </div>
      <ReportTable title={t('movement.byMonth')} heading={t('report.month')} rows={reports.byMonth} />
      <ReportTable title={t('movement.byOperation')} heading={t('app.businessOperation')} rows={reports.byArea} label={(key) => (key === 'unlinked' ? t('filter.notLinked') : areaLabel(key))} />
      <ReportTable title={t('movement.byCurrency')} heading={t('field.currency')} rows={reports.byCurrency} />
      <ReportTable title={t('movement.byStatus')} heading={t('table.status')} rows={reports.byStatus} label={(key) => t(`status.${key}`)} />
      <ReportTable title={t('movement.destinationHistory')} heading={t('table.destination')} rows={reports.byDestination} />
    </div>}
  </section>;
}

//  names the first column. It is passed in rather than derived from
// the title by stripping an English "By ", which only worked in English.
function ReportTable({ title, heading, rows, label = (key) => key }) {
  const t = useT();
  if (!rows?.length) return null;
  return <div className="report-block">
    <div className="panel-header"><div><h2>{title}</h2></div></div>
    <div className="table-wrap"><table>
      <thead><tr><th>{heading}</th><th>{t('movement.movements')}</th><th>{t('movement.estimated')} (RWF)</th><th>{t('movement.released')} (RWF)</th><th>{t('movement.actual')} (RWF)</th><th>{t('movement.balance')} (RWF)</th><th>{t('movement.estimated')} (USD)</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.key}>
        <td><strong>{label(row.key)}</strong></td>
        <td>{row.count}</td>
        <td>{formatMoney(row.totals.estimated.rwf, 'RWF')}</td>
        <td>{formatMoney(row.totals.released.rwf, 'RWF')}</td>
        <td>{formatMoney(row.totals.actual.rwf, 'RWF')}</td>
        <td>{formatMoney(row.totals.balance.rwf, 'RWF')}</td>
        <td>{formatMoney(row.totals.estimated.usd, 'USD')}</td>
      </tr>)}</tbody>
    </table></div>
  </div>;
}

function RatePanel({ rate, fetchJson, onSave, onError }) {
  const t = useT();
  const [values, setValues] = useState({ rwfPerUsd: '', cdfPerUsd: '', note: '' });
  const [history, setHistory] = useState(null);

  useEffect(() => {
    if (rate) setValues({ rwfPerUsd: String(rate.rwfPerUsd), cdfPerUsd: String(rate.cdfPerUsd), note: '' });
  }, [rate]);

  const loadHistory = async () => {
    try { setHistory(await fetchJson('/api/rates/history')); }
    catch (historyError) { onError(historyError.message); }
  };

  return <form className="form-panel" onSubmit={(event) => {
    event.preventDefault();
    onSave({ rwfPerUsd: Number(values.rwfPerUsd), cdfPerUsd: Number(values.cdfPerUsd), note: values.note });
  }}>
    <div className="panel-header">
      <div>
        <h2>{t('movement.exchangeRateTitle')}</h2>
      </div>
      <button className="text-btn" type="button" onClick={loadHistory}>{t('action.rateHistory')}</button>
    </div>
    <div className="form-grid">
      <label className="form-field"><span>{t('movement.rwfPerUsd')}</span>
        <input required type="number" min="0.000001" step="0.01" value={values.rwfPerUsd} onChange={(event) => setValues({ ...values, rwfPerUsd: event.target.value })} />
      </label>
      <label className="form-field"><span>{t('movement.cdfPerUsd')}</span>
        <input required type="number" min="0.000001" step="0.01" value={values.cdfPerUsd} onChange={(event) => setValues({ ...values, cdfPerUsd: event.target.value })} />
      </label>
      <label className="form-field form-field-wide"><span>{t('movement.rateNote')}</span>
        <input value={values.note} onChange={(event) => setValues({ ...values, note: event.target.value })} />
      </label>
    </div>
    <button className="primary-btn" type="submit">{t('action.saveRate')}</button>
    {history && <div className="table-wrap"><table>
      <thead><tr><th>RWF / USD</th><th>CDF / USD</th><th>{t('field.note')}</th><th>{t('movement.setBy')}</th><th>{t('table.date')}</th></tr></thead>
      <tbody>{history.map((entry) => <tr key={entry.id}>
        <td>{Number(entry.rwfPerUsd).toLocaleString()}</td>
        <td>{Number(entry.cdfPerUsd).toLocaleString()}</td>
        <td>{entry.note || '—'}</td>
        <td>{entry.updatedByName || '—'}</td>
        <td>{formatDateTime(entry.updatedAt)}</td>
      </tr>)}</tbody>
    </table></div>}
  </form>;
}
