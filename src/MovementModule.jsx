import { useCallback, useEffect, useMemo, useState } from 'react';

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
export const MOVEMENT_STATUSES = ['Draft', 'Pending', 'Approved', 'Funds Released', 'Ongoing', 'Completed', 'Rejected', 'Cancelled'];

// Areas a movement can be linked to. Logistics & Facilitation is its own area,
// so it never appears here (section 5).
const LINKABLE_AREAS = [
  { id: 'farming', name: 'Farming' },
  { id: 'agriculture', name: 'Agriculture' },
  { id: 'mining', name: 'Mining' }
];

const STATUS_FLOW = {
  Draft: ['Pending', 'Cancelled'],
  Pending: ['Approved', 'Rejected', 'Cancelled', 'Draft'],
  Approved: ['Funds Released', 'Ongoing', 'Rejected', 'Cancelled'],
  'Funds Released': ['Ongoing', 'Completed', 'Cancelled'],
  Ongoing: ['Completed', 'Cancelled'],
  Completed: ['Ongoing'],
  Rejected: ['Pending'],
  Cancelled: ['Pending']
};

const COST_LINES = [
  ['transport', 'Transport'],
  ['fuel', 'Fuel'],
  ['accommodation', 'Accommodation'],
  ['meals', 'Meals / Allowance'],
  ['handling', 'Loading / Handling'],
  ['other', 'Other Expenses']
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

function areaLabel(area) {
  if (!area) return 'Not linked';
  return LINKABLE_AREAS.find((item) => item.id === area)?.name || area;
}

function statusTone(status) {
  if (['Completed'].includes(status)) return 'tone-done';
  if (['Approved', 'Funds Released', 'Ongoing'].includes(status)) return 'tone-active';
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
          body: JSON.stringify({ ...body, status: submitForReview ? 'Pending' : 'Draft' })
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
        <span className="eyebrow">MOVEMENT &amp; FACILITATION</span>
        <h2>{isDirector ? 'Director / Super Admin' : user.sector === 'movement' ? 'Movement Officer' : `${areaLabel(user.sector)} — linked movements`}</h2>
        <p>Movements of personnel, equipment and materials, the funds facilitating them, and the evidence returned.</p>
      </div>
      {canCreate && <button className="primary-btn" type="button" onClick={() => setFormState({ mode: 'create', values: emptyForm })}>
        + Create movement / facilitation
      </button>}
    </section>

    <div className="metric-grid metric-grid-5">
      <Metric label="Total requests" value={counts.total ?? 0} />
      <Metric label="Pending" value={counts.pending ?? 0} />
      <Metric label="Approved" value={counts.approved ?? 0} />
      <Metric label="Ongoing" value={counts.ongoing ?? 0} />
      <Metric label="Completed" value={counts.completed ?? 0} />
    </div>

    {summary && <section className="totals-strip">
      <TotalBlock label="Estimated facilitation" totals={summary.totals.estimated} />
      <TotalBlock label="Funds released" totals={summary.totals.released} />
      <TotalBlock label="Actual expense" totals={summary.totals.actual} />
      <TotalBlock label="Balance / return" totals={summary.totals.balance} />
      <div className="total-block total-block-note">
        <span>Reference rate</span>
        <strong>1 USD = {Number(summary.rate.rwfPerUsd).toLocaleString()} RWF</strong>
        <small>1 USD = {Number(summary.rate.cdfPerUsd).toLocaleString()} CDF · {formatDateTime(summary.rate.updatedAt)}</small>
        {isDirector && <button className="text-btn" type="button" onClick={() => setShowRates((current) => !current)}>
          {showRates ? 'Hide rate settings' : 'Update rate'}
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
          <h2>Movement register</h2>
          <span>{movements.length} record{movements.length === 1 ? '' : 's'}{filtersActive ? ' matching the current filters' : ''}</span>
        </div>
        <button className="text-btn" type="button" onClick={load}>Refresh</button>
      </div>
      {loading
        ? <div className="loading-state"><span className="spinner" />Loading movement records...</div>
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
  const set = (patch) => setFilters({ ...filters, ...patch });
  return <form className="filter-panel" onSubmit={(event) => { event.preventDefault(); onApply(); }}>
    <div className="panel-header">
      <div><h2>Filter movements</h2><span>By date, status, destination, person or team, currency, type or related operation.</span></div>
    </div>
    <div className="filter-grid">
      <label className="form-field"><span>Search</span><input placeholder="Reference, purpose, route, person" value={filters.search} onChange={(event) => set({ search: event.target.value })} /></label>
      <label className="form-field"><span>Status</span><select value={filters.status} onChange={(event) => set({ status: event.target.value })}><option value="All">All statuses</option>{MOVEMENT_STATUSES.map((status) => <option key={status}>{status}</option>)}</select></label>
      <label className="form-field"><span>Related operation</span><select value={filters.relatedArea} onChange={(event) => set({ relatedArea: event.target.value })}><option value="All">All operations</option><option value="None">Not linked</option>{LINKABLE_AREAS.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select></label>
      <label className="form-field"><span>Movement type</span><select value={filters.movementType} onChange={(event) => set({ movementType: event.target.value })}><option value="All">All types</option>{MOVEMENT_TYPES.map((type) => <option key={type}>{type}</option>)}</select></label>
      <label className="form-field"><span>Currency</span><select value={filters.currency} onChange={(event) => set({ currency: event.target.value })}><option value="All">All currencies</option>{CURRENCIES.map((currency) => <option key={currency}>{currency}</option>)}</select></label>
      <label className="form-field"><span>Destination</span><input value={filters.destination} onChange={(event) => set({ destination: event.target.value })} /></label>
      <label className="form-field"><span>Person / team</span><input value={filters.personTeam} onChange={(event) => set({ personTeam: event.target.value })} /></label>
      <label className="form-field"><span>Departure from</span><input type="date" value={filters.dateFrom} onChange={(event) => set({ dateFrom: event.target.value })} /></label>
      <label className="form-field"><span>Departure to</span><input type="date" value={filters.dateTo} onChange={(event) => set({ dateTo: event.target.value })} /></label>
    </div>
    <div className="button-row">
      <button className="primary-btn" type="submit">Apply filters</button>
      {active && <button className="secondary-btn" type="button" onClick={onClear}>Clear</button>}
    </div>
  </form>;
}

function MovementTable({ movements, selectedId, onSelect }) {
  if (!movements.length) {
    return <div className="empty-state"><strong>No movement records match.</strong><span>Create a movement or relax the filters.</span></div>;
  }
  return <div className="table-wrap"><table>
    <thead><tr>
      <th>Reference</th><th>Type</th><th>Purpose</th><th>Related area</th><th>Route</th>
      <th>Departure</th><th>Person / team</th><th>Status</th>
      <th>Estimated</th><th>Released</th><th>Actual</th><th>Balance</th><th>Evidence</th>
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
        <h2>{mode === 'edit' ? `Edit ${movement.ref}` : 'Create movement / facilitation'}</h2>
        <span>Record why the movement happened, where it went, who travelled and what it cost.</span>
      </div>
      <button className="text-btn" type="button" onClick={onCancel}>Cancel</button>
    </div>

    <h3 className="form-section-title">Request details</h3>
    <div className="form-grid movement-grid">
      <label className="form-field"><span>Reference no.</span>
        {mode === 'edit'
          ? <span className="read-only-value">{movement.ref}</span>
          : <span className="read-only-value">Generated on save (MF-{new Date().getFullYear()}-0000)</span>}
      </label>
      <label className="form-field"><span>Movement type</span>
        <select value={values.movementType} onChange={(event) => set({ movementType: event.target.value })}>
          {MOVEMENT_TYPES.map((type) => <option key={type}>{type}</option>)}
        </select>
      </label>
      <label className="form-field"><span>Related area</span>
        <select value={values.relatedArea} onChange={(event) => set({ relatedArea: event.target.value })}>
          <option value="">Not linked — Logistics &amp; Facilitation only</option>
          {LINKABLE_AREAS.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}
        </select>
      </label>
      <label className="form-field form-field-wide"><span>Purpose</span>
        <input required placeholder="Mining site inspection" value={values.purpose} onChange={(event) => set({ purpose: event.target.value })} />
      </label>
      <label className="form-field"><span>Origin</span>
        <input required placeholder="Kigali" value={values.origin} onChange={(event) => set({ origin: event.target.value })} />
      </label>
      <label className="form-field"><span>Destination</span>
        <input required placeholder="Rubaya" value={values.destination} onChange={(event) => set({ destination: event.target.value })} />
      </label>
      <label className="form-field"><span>Departure date</span>
        <input type="date" value={values.departureDate} onChange={(event) => set({ departureDate: event.target.value })} />
      </label>
      <label className="form-field"><span>Return date</span>
        <input type="date" min={values.departureDate || undefined} value={values.returnDate} onChange={(event) => set({ returnDate: event.target.value })} />
      </label>
      <label className="form-field"><span>Person / team</span>
        <input placeholder="Site Inspection Team" value={values.personTeam} onChange={(event) => set({ personTeam: event.target.value })} />
      </label>
      <label className="form-field"><span>Transport type</span>
        <input list="transport-suggestions" placeholder="Company Vehicle" value={values.transportType} onChange={(event) => set({ transportType: event.target.value })} />
        <datalist id="transport-suggestions">{TRANSPORT_SUGGESTIONS.map((option) => <option key={option} value={option} />)}</datalist>
      </label>
      <label className="form-field"><span>Vehicle / driver (optional)</span>
        <input value={values.vehicleDriver} onChange={(event) => set({ vehicleDriver: event.target.value })} />
      </label>
      <label className="form-field"><span>Currency</span>
        <select value={values.currency} onChange={(event) => set({ currency: event.target.value })}>
          {CURRENCIES.map((currency) => <option key={currency}>{currency}</option>)}
        </select>
      </label>
      <label className="form-field form-field-wide"><span>Notes</span>
        <input placeholder="Anything the Director should know about this movement" value={values.notes} onChange={(event) => set({ notes: event.target.value })} />
      </label>
    </div>

    <h3 className="form-section-title">Facilitation cost breakdown</h3>
    <div className="cost-grid">
      {COST_LINES.map(([key, label]) => <label className="form-field" key={key}>
        <span>{label}</span>
        <input type="number" min="0" step="0.01" placeholder="0" value={values.costs[key]} onChange={(event) => setCost(key, event.target.value)} />
      </label>)}
      <div className="cost-total">
        <span>Total</span>
        <strong>{formatMoney(total, values.currency)}</strong>
      </div>
    </div>

    {converted && <div className="conversion-strip">
      <div><span>Equivalent</span><strong>{formatMoney(converted.rwf, 'RWF')} · {formatMoney(converted.usd, 'USD')} · {formatMoney(converted.cdf, 'CDF')}</strong></div>
      <small>
        Rate stored with this record: 1 USD = {Number(effectiveRate.rwfPerUsd).toLocaleString()} RWF / {Number(effectiveRate.cdfPerUsd).toLocaleString()} CDF
        {useActualRate ? ' (actual transaction rate)' : ' (reference rate)'}
      </small>
    </div>}

    {isDirector && <div className="rate-override">
      <label className="check-field">
        <input type="checkbox" checked={useActualRate} onChange={(event) => setUseActualRate(event.target.checked)} />
        Use the actual transaction rate instead of the reference rate
      </label>
      {useActualRate && <div className="form-grid">
        <label className="form-field"><span>RWF per USD</span>
          <input type="number" min="0.000001" step="0.01" value={actualRate.rwfPerUsd} onChange={(event) => setActualRate({ ...actualRate, rwfPerUsd: event.target.value })} />
        </label>
        <label className="form-field"><span>CDF per USD</span>
          <input type="number" min="0.000001" step="0.01" value={actualRate.cdfPerUsd} onChange={(event) => setActualRate({ ...actualRate, cdfPerUsd: event.target.value })} />
        </label>
      </div>}
    </div>}

    <div className="button-row">
      <button className="primary-btn" type="submit">{mode === 'edit' ? 'Save changes' : 'Create and submit for review'}</button>
      {mode === 'create' && <button className="secondary-btn" type="button" onClick={(event) => submit(event, false)}>Save as draft</button>}
    </div>
  </form>;
}

// Sections 6, 7 and 8: workflow actions, accountability figures, evidence, history.
function MovementDetail({ detail, user, token, isDirector, onClose, onEdit, onStatus, onFinance, onUpload, onRemoveEvidence, onDelete }) {
  const { movement, evidence, history } = detail;
  const [finance, setFinance] = useState({
    fundsReleased: String(movement.fundsReleased),
    actualExpense: String(movement.actualExpense),
    evidenceStatus: movement.evidenceStatus
  });
  const [reason, setReason] = useState('');

  const canEdit = isDirector || (user.sector === 'movement' && movement.createdBy === user.id && ['Draft', 'Pending'].includes(movement.status));
  const canAttach = isDirector || (user.sector === 'movement' && movement.createdBy === user.id);
  const nextStatuses = (STATUS_FLOW[movement.status] || []).filter((status) => {
    if (isDirector) return true;
    return movement.status === 'Draft' && status === 'Pending' && movement.createdBy === user.id;
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
      <button className="text-btn" type="button" onClick={onClose}>Close</button>
    </div>

    <div className="detail-facts">
      <Fact label="Status" value={<span className={`status-badge ${statusTone(movement.status)}`}>{movement.status}</span>} />
      <Fact label="Departure" value={formatDate(movement.departureDate)} />
      <Fact label="Return" value={formatDate(movement.returnDate)} />
      <Fact label="Person / team" value={movement.personTeam || '—'} />
      <Fact label="Transport" value={movement.transportType || '—'} />
      <Fact label="Vehicle / driver" value={movement.vehicleDriver || '—'} />
      <Fact label="Currency" value={movement.currency} />
      <Fact label="Approved by" value={movement.approvedByName ? `${movement.approvedByName} · ${formatDateTime(movement.approvedAt)}` : 'Not yet approved'} />
    </div>
    {movement.notes && <p className="detail-notes">{movement.notes}</p>}

    <h3 className="form-section-title">Facilitation cost breakdown</h3>
    <div className="table-wrap"><table className="cost-table">
      <thead><tr><th>Cost item</th><th>Amount</th></tr></thead>
      <tbody>
        {COST_LINES.map(([key, label]) => <tr key={key}><td>{label}</td><td>{formatMoney(movement.costs[key], movement.currency)}</td></tr>)}
        <tr className="total-row"><td><strong>Total</strong></td><td><strong>{formatMoney(movement.estimatedTotal, movement.currency)}</strong></td></tr>
      </tbody>
    </table></div>
    {movement.converted && <p className="detail-notes">
      Equivalent at the rate stored with this record ({Number(movement.rate.rwfPerUsd).toLocaleString()} RWF / {Number(movement.rate.cdfPerUsd).toLocaleString()} CDF per USD,
      {' '}{movement.rate.source === 'actual' ? 'actual transaction rate' : 'reference rate'} of {formatDateTime(movement.rate.recordedAt)}):
      {' '}{formatMoney(movement.converted.estimatedTotal.rwf, 'RWF')} · {formatMoney(movement.converted.estimatedTotal.usd, 'USD')} · {formatMoney(movement.converted.estimatedTotal.cdf, 'CDF')}
    </p>}

    <h3 className="form-section-title">Evidence &amp; accountability</h3>
    <div className="accountability-grid">
      <Fact label="Estimated facilitation" value={formatMoney(movement.estimatedTotal, movement.currency)} />
      <Fact label="Funds released" value={formatMoney(movement.fundsReleased, movement.currency)} />
      <Fact label="Actual expense" value={formatMoney(movement.actualExpense, movement.currency)} />
      <Fact label="Balance / return" value={formatMoney(movement.balanceReturn, movement.currency)} />
      <Fact label="Evidence status" value={<span className={`status-badge ${movement.evidenceStatus === 'Complete' ? 'tone-done' : 'tone-waiting'}`}>{movement.evidenceStatus}</span>} />
    </div>

    {isDirector && <form className="inline-form" onSubmit={(event) => {
      event.preventDefault();
      onFinance(movement, {
        fundsReleased: Number(finance.fundsReleased) || 0,
        actualExpense: Number(finance.actualExpense) || 0,
        evidenceStatus: finance.evidenceStatus
      });
    }}>
      <label className="form-field"><span>Funds released ({movement.currency})</span>
        <input type="number" min="0" step="0.01" value={finance.fundsReleased} onChange={(event) => setFinance({ ...finance, fundsReleased: event.target.value })} />
      </label>
      <label className="form-field"><span>Actual expense ({movement.currency})</span>
        <input type="number" min="0" step="0.01" value={finance.actualExpense} onChange={(event) => setFinance({ ...finance, actualExpense: event.target.value })} />
      </label>
      <label className="form-field"><span>Evidence status</span>
        <select value={finance.evidenceStatus} onChange={(event) => setFinance({ ...finance, evidenceStatus: event.target.value })}>
          {EVIDENCE_STATUSES.map((status) => <option key={status}>{status}</option>)}
        </select>
      </label>
      <button className="secondary-btn" type="submit">Record figures</button>
    </form>}

    {canAttach && <EvidenceUpload movement={movement} onUpload={onUpload} />}
    <EvidenceList
      movement={movement}
      evidence={evidence}
      token={token}
      canRemove={isDirector}
      onRemove={(item) => onRemoveEvidence(movement, item)}
    />

    <h3 className="form-section-title">Workflow</h3>
    <p className="workflow-trail">CREATE → COST → REVIEW → APPROVE → RELEASE → EVIDENCE → COMPLETE</p>
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
          >{status === 'Pending' && movement.status === 'Draft' ? 'Submit for review' : `Mark ${status}`}</button>)}
          {isDirector && <input className="reason-input" placeholder="Reason or note (optional)" value={reason} onChange={(event) => setReason(event.target.value)} />}
        </div>
      : <p className="detail-notes">No further status change is available to your account for this movement.</p>}

    <div className="button-row">
      {canEdit && <button className="secondary-btn" type="button" onClick={() => onEdit(movement)}>Edit movement</button>}
      {isDirector && <button className="danger-btn outlined" type="button" onClick={() => onDelete(movement)}>Delete movement</button>}
    </div>

    <h3 className="form-section-title">History of edits and status changes</h3>
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
      : <div className="empty-state"><strong>No history recorded yet.</strong><span>Edits and status changes appear here.</span></div>}
  </section>;
}

function Fact({ label, value }) {
  return <div className="fact"><span>{label}</span><strong>{value}</strong></div>;
}

function EvidenceUpload({ movement, onUpload }) {
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
    <label className="form-field"><span>Evidence type</span>
      <select value={kind} onChange={(event) => setKind(event.target.value)}>{EVIDENCE_KINDS.map((option) => <option key={option}>{option}</option>)}</select>
    </label>
    <label className="form-field"><span>Amount ({movement.currency})</span>
      <input type="number" min="0" step="0.01" placeholder="0" value={amount} onChange={(event) => setAmount(event.target.value)} />
    </label>
    <label className="form-field"><span>Note</span>
      <input placeholder="Fuel for the return leg" value={note} onChange={(event) => setNote(event.target.value)} />
    </label>
    <label className="form-field"><span>Files (JPG, PNG, PDF — max 10 MB each)</span>
      <input key={inputKey} type="file" multiple accept="image/*,application/pdf" onChange={(event) => setFiles(event.target.files)} />
    </label>
    <button className="secondary-btn" type="submit" disabled={!files?.length}>Upload evidence</button>
  </form>;
}

function EvidenceList({ movement, evidence, token, canRemove, onRemove }) {
  if (!evidence.length) {
    return <div className="empty-state"><strong>No evidence attached yet.</strong><span>Receipts, invoices, fuel slips, tickets, payment proof and photographs go here.</span></div>;
  }
  return <div className="table-wrap"><table>
    <thead><tr><th>Type</th><th>File</th><th>Amount</th><th>Note</th><th>Uploaded by</th><th>Date</th><th>Actions</th></tr></thead>
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
        >View</a>
        {canRemove && <button className="danger-btn" type="button" onClick={() => onRemove(item)}>Remove</button>}
      </td>
    </tr>)}</tbody>
  </table></div>;
}

// Section 9.
function MovementReports({ reports, onRun, onClose }) {
  return <section className="report-area">
    <div className="panel-header">
      <div><h2>Movement &amp; facilitation reports</h2><span>Totals are normalised to USD at each record's own stored rate, then shown in all three currencies.</span></div>
      <div className="report-actions">
        <button className="secondary-btn" type="button" onClick={onRun}>Run report</button>
        {reports && <button className="text-btn" type="button" onClick={onClose}>Close</button>}
      </div>
    </div>
    {reports && <div className="report-body">
      <div className="metric-grid metric-grid-5">
        <Metric label="Movements" value={reports.movementCount} />
        <Metric label="Outstanding requests" value={reports.outstanding} />
        <Metric label="Completed" value={reports.completed} />
        <Metric label="Evidence outstanding" value={reports.evidenceOutstanding} />
        <Metric label="Fuel + transport (RWF)" value={new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(reports.fuelAndTransport.fuel.rwf + reports.fuelAndTransport.transport.rwf)} />
      </div>
      <div className="totals-strip">
        <TotalBlock label="Estimated facilitation" totals={reports.totals.estimated} />
        <TotalBlock label="Funds released" totals={reports.totals.released} />
        <TotalBlock label="Actual expense" totals={reports.totals.actual} />
        <TotalBlock label="Balance / return" totals={reports.totals.balance} />
        <div className="total-block total-block-note">
          <span>Fuel vs transport</span>
          <strong>Fuel {formatMoney(reports.fuelAndTransport.fuel.rwf, 'RWF')}</strong>
          <small>Transport {formatMoney(reports.fuelAndTransport.transport.rwf, 'RWF')}</small>
        </div>
      </div>
      <ReportTable title="By month" caption="Total facilitation by month" rows={reports.byMonth} />
      <ReportTable title="By area of operation" caption="Movement cost supporting each operation" rows={reports.byArea} label={(key) => (key === 'unlinked' ? 'Not linked' : areaLabel(key))} />
      <ReportTable title="By currency" caption="Currency breakdown of the entered amounts" rows={reports.byCurrency} />
      <ReportTable title="By status" caption="Outstanding versus settled requests" rows={reports.byStatus} />
      <ReportTable title="Destination history" caption="Top 25 destinations by facilitation cost" rows={reports.byDestination} />
    </div>}
  </section>;
}

function ReportTable({ title, caption, rows, label = (key) => key }) {
  if (!rows?.length) return null;
  return <div className="report-block">
    <div className="panel-header"><div><h2>{title}</h2><span>{caption}</span></div></div>
    <div className="table-wrap"><table>
      <thead><tr><th>{title.replace('By ', '').replace(/^./, (character) => character.toUpperCase())}</th><th>Movements</th><th>Estimated (RWF)</th><th>Released (RWF)</th><th>Actual (RWF)</th><th>Balance (RWF)</th><th>Estimated (USD)</th></tr></thead>
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
        <h2>Reference exchange rate</h2>
        <span>Used to display USD, RWF and CDF equivalents. Saving a new rate never rewrites movements already recorded.</span>
      </div>
      <button className="text-btn" type="button" onClick={loadHistory}>Rate history</button>
    </div>
    <div className="form-grid">
      <label className="form-field"><span>RWF per 1 USD</span>
        <input required type="number" min="0.000001" step="0.01" value={values.rwfPerUsd} onChange={(event) => setValues({ ...values, rwfPerUsd: event.target.value })} />
      </label>
      <label className="form-field"><span>CDF per 1 USD</span>
        <input required type="number" min="0.000001" step="0.01" value={values.cdfPerUsd} onChange={(event) => setValues({ ...values, cdfPerUsd: event.target.value })} />
      </label>
      <label className="form-field form-field-wide"><span>Note (source of the rate)</span>
        <input placeholder="BNR mid-rate, 07 September 2026" value={values.note} onChange={(event) => setValues({ ...values, note: event.target.value })} />
      </label>
    </div>
    <button className="primary-btn" type="submit">Save reference rate</button>
    {history && <div className="table-wrap"><table>
      <thead><tr><th>RWF / USD</th><th>CDF / USD</th><th>Note</th><th>Set by</th><th>Date</th></tr></thead>
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
