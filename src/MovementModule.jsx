import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApprovalPanel, approverName, canApproveRecord, decisionIsOpen, formatTrailValue, labelForField, trailActionLabel } from './ActivityReview.jsx';
import { displayLanguage, fill, translate, useT } from './i18n.js';
import { operationName } from '../shared/businessOperations.js';
import { DetailView, useBusy, useDialog } from './ui.jsx';
import { FilePicker, Journey, MoneyBar, NextStep, Section, goToSection, journeyLabel, journeyTone, movementJourney } from './journey.jsx';

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
  Rejected: ['Pending Approval', 'Draft'],
  Cancelled: ['Pending Approval']
};

// Mirrors SELF_MOVES, FINANCE_STATUSES and DELETABLE_STATUSES in
// server/routes/movements.js, which is what enforces them.
const SELF_MOVES = [['Draft', 'Pending Approval'], ['Pending Approval', 'Draft'], ['Rejected', 'Draft']];
const FINANCE_STATUSES = ['Approved', 'Funds Released', 'In Progress', 'Completed'];
const DELETABLE_STATUSES = ['Draft', 'Pending Approval', 'Rejected', 'Cancelled'];

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
  return new Date(year, month - 1, day).toLocaleDateString(displayLanguage(), { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(displayLanguage(), { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
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

export default function MovementModule({ user, onOpenFile, fetchJson, upload, openId = null, onOpen, onClose, onChanged, onMessage, onError }) {
  const t = useT();
  const dialog = useDialog();
  const [busy, run] = useBusy();
  const isDirector = user.role === 'super-admin';
  // An all-operations manager covers Movements & Facilitation like any other.
  const coversMovements = Boolean(user.coversAllSectors) || user.sector === 'movement';
  // Team members follow the trips but do not raise them; the API refuses them too.
  const canCreate = isDirector || (coversMovements && user.role === 'manager');
  // The open movement lives in the address (#/movements/MOV-...), so a link from
  // the approval queue opens it directly and the back button closes it.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;

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

  // Numbered so that of two loads crossing in flight -- filters applied twice
  // quickly -- only the newest reaches the screen.
  const latestLoad = useRef(0);
  const latestDetail = useRef(0);

  const load = useCallback(async () => {
    const request = ++latestLoad.current;
    try {
      const [summaryResult, listResult, rateResult] = await Promise.all([
        fetchJson('/api/movements/summary'),
        fetchJson(`/api/movements${query ? `?${query}` : ''}`),
        fetchJson('/api/rates')
      ]);
      if (request !== latestLoad.current) return;
      setSummary(summaryResult);
      setMovements(listResult);
      setRate(rateResult);
    } catch (loadError) {
      if (request === latestLoad.current) onError(loadError.message);
    } finally {
      if (request === latestLoad.current) setLoading(false);
    }
  }, [fetchJson, onError, query]);

  useEffect(() => { load(); }, [load]);

  const fetchDetail = useCallback(async (movementId) => {
    const request = ++latestDetail.current;
    try {
      const result = await fetchJson(`/api/movements/${encodeURIComponent(movementId)}`);
      if (request === latestDetail.current) setDetail(result);
    } catch (detailError) {
      if (request !== latestDetail.current) return;
      onError(detailError.message);
      closeRef.current?.();
    }
  }, [fetchJson, onError]);

  useEffect(() => {
    if (!openId) {
      latestDetail.current += 1;
      setDetail(null);
      return;
    }
    // #/movements/new, from "New trip" on the home screen, opens the form.
    if (openId === 'new') {
      if (canCreate) setFormState({ mode: 'create', values: emptyForm });
      closeRef.current?.();
      return;
    }
    fetchDetail(openId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, fetchDetail]);

  const openDetail = (movementId) => onOpen?.(movementId);

  // After any change: the register, the open record if it is still the one
  // being read, and the application's own badge and queue.
  const refreshDetail = async (movementId) => {
    await load();
    if (movementId && movementId === openId) await fetchDetail(movementId);
    changedRef.current?.();
  };

  const saveMovement = (values, rateOverride, submitForReview) => run(async () => {
    const body = {
      ...values,
      relatedArea: values.relatedArea || null,
      costs: Object.fromEntries(COST_LINES.map(([key]) => [key, Number(values.costs[key]) || 0])),
      ...(rateOverride ? { rateOverride } : {})
    };
    try {
      if (formState?.mode === 'edit') {
        await fetchJson(`/api/movements/${encodeURIComponent(formState.movement.id)}`, { method: 'PUT', body: JSON.stringify(body) });
        onMessage(fill(t('msg.movementUpdated'), { ref: formState.movement.ref }));
        setFormState(null);
        await refreshDetail(formState.movement.id);
      } else {
        const created = await fetchJson('/api/movements', {
          method: 'POST',
          body: JSON.stringify({ ...body, status: submitForReview ? 'Pending Approval' : 'Draft' })
        });
        onMessage(fill(t('msg.movementCreated'), { ref: created.ref }));
        setFormState(null);
        await load();
        changedRef.current?.();
        openDetail(created.id);
      }
    } catch (saveError) {
      onError(saveError.message);
    }
  });

  const changeStatus = (movement, status, extra = {}) => run(async () => {
    // Refusing or cancelling a movement stops the work, so it is confirmed --
    // and it has to say why, which the API insists on too: the person who
    // raised it is otherwise left with nothing to act on.
    let reason;
    if (['Rejected', 'Cancelled'].includes(status)) {
      reason = await dialog.prompt({
        title: `${t('action.markAs')} ${t(`status.${status}`)}`,
        message: `${movement.ref} — ${movement.purpose}`,
        label: t('field.reason'),
        required: true,
        multiline: true,
        confirmLabel: `${t('action.markAs')} ${t(`status.${status}`)}`,
        danger: true
      });
      if (reason === null) return;
    }
    try {
      await fetchJson(`/api/movements/${encodeURIComponent(movement.id)}/status`, { method: 'PATCH', body: JSON.stringify({ status, ...extra, ...(reason ? { reason } : {}) }) });
      onMessage(fill(t('msg.movementStatus'), { ref: movement.ref, status: t(`status.${status}`) }));
      await refreshDetail(movement.id);
    } catch (statusError) {
      onError(statusError.message);
    }
  });

  // The decision the record is waiting on. Separate from the status buttons: it
  // goes to the route that checks the caller is the named approver.
  const decideApproval = (movement, body) => run(async () => {
    try {
      await fetchJson(`/api/movements/${encodeURIComponent(movement.id)}/approval`, { method: 'PATCH', body: JSON.stringify(body) });
      onMessage(fill(body.action === 'approve' ? t('msg.movementApproved') : t('msg.movementRejected'), { ref: movement.ref }));
      await refreshDetail(movement.id);
    } catch (approvalError) {
      onError(approvalError.message);
    }
  });

  // Rejecting asks for the reason in a dialog, the same one the approval queue
  // and the activity screen use, rather than a box that sits empty on every
  // record waiting for a decision.
  const rejectApproval = (movement) => run(async () => {
    const reason = await dialog.prompt({
      title: t('approval.reject'),
      message: `${movement.ref} — ${movement.purpose}`,
      label: t('msg.rejectReason'),
      required: true,
      multiline: true,
      danger: true,
      confirmLabel: t('approval.reject')
    });
    if (reason === null) return;
    try {
      await fetchJson(`/api/movements/${encodeURIComponent(movement.id)}/approval`, {
        method: 'PATCH', body: JSON.stringify({ action: 'reject', rejectionReason: reason })
      });
      onMessage(fill(t('msg.movementRejected'), { ref: movement.ref }));
      await refreshDetail(movement.id);
    } catch (approvalError) {
      onError(approvalError.message);
    }
  });

  const updateFinance = (movement, body) => run(async () => {
    try {
      await fetchJson(`/api/movements/${encodeURIComponent(movement.id)}/finance`, { method: 'PATCH', body: JSON.stringify(body) });
      onMessage(t('msg.figuresUpdated'));
      await refreshDetail(movement.id);
    } catch (financeError) {
      onError(financeError.message);
    }
  });

  const setVisibility = (movement, externallyVisible) => run(async () => {
    try {
      await fetchJson(`/api/movements/${encodeURIComponent(movement.id)}/visibility`, { method: 'PATCH', body: JSON.stringify({ externallyVisible }) });
      onMessage(externallyVisible ? t('msg.movementVisible') : t('msg.movementHidden'));
      await refreshDetail(movement.id);
    } catch (visibilityError) {
      onError(visibilityError.message);
    }
  });

  const removeMovement = (movement) => run(async () => {
    const confirmed = await dialog.confirm({
      title: t('msg.deleteTitle'),
      message: fill(t('msg.deleteMovementBody'), { ref: movement.ref }),
      confirmLabel: t('action.deleteMovement'),
      danger: true
    });
    if (!confirmed) return;
    try {
      await fetchJson(`/api/movements/${encodeURIComponent(movement.id)}`, { method: 'DELETE' });
      onMessage(fill(t('msg.movementDeleted'), { ref: movement.ref }));
      onClose?.();
      await load();
      changedRef.current?.();
    } catch (deleteError) {
      onError(deleteError.message);
    }
  });

  // Resolves true once stored, so the upload form keeps the files on a failure.
  const uploadEvidence = (movement, formData) => run(async () => {
    try {
      const saved = await upload(`/api/movements/${encodeURIComponent(movement.id)}/evidence`, formData);
      onMessage(fill(t('msg.filesAttached'), { count: saved.length }));
      await refreshDetail(movement.id);
      return true;
    } catch (uploadError) {
      onError(uploadError.message);
      return false;
    }
  });

  const removeEvidence = (movement, evidence) => run(async () => {
    const confirmed = await dialog.confirm({
      title: t('msg.removeEvidenceTitle'),
      message: fill(t('msg.removeEvidenceBody'), { name: evidence.originalName }),
      confirmLabel: t('action.remove'),
      danger: true
    });
    if (!confirmed) return;
    try {
      await fetchJson(`/api/movements/${encodeURIComponent(movement.id)}/evidence/${evidence.id}`, { method: 'DELETE' });
      onMessage(t('msg.evidenceRemoved'));
      await refreshDetail(movement.id);
    } catch (evidenceError) {
      onError(evidenceError.message);
    }
  });

  const runReports = () => run(async () => {
    try {
      const params = new URLSearchParams();
      if (appliedFilters.dateFrom) params.set('dateFrom', appliedFilters.dateFrom);
      if (appliedFilters.dateTo) params.set('dateTo', appliedFilters.dateTo);
      setReports(await fetchJson(`/api/movements/reports${params.toString() ? `?${params}` : ''}`));
    } catch (reportError) {
      onError(reportError.message);
    }
  });

  const saveRate = (values) => run(async () => {
    try {
      const saved = await fetchJson('/api/rates', { method: 'PUT', body: JSON.stringify(values) });
      setRate(saved);
      onMessage(t('msg.rateUpdated'));
      await load();
      changedRef.current?.();
    } catch (rateError) {
      onError(rateError.message);
    }
  });

  const counts = summary?.counts || {};
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersActive = JSON.stringify(appliedFilters) !== JSON.stringify(emptyFilters);

  return <div className="movement-module">
    <section className="context-strip">
      <div>
        <span className="eyebrow">{t('movement.eyebrow')}</span>
        {/* The page's subject, not the reader's job title: the heading used to read "Director". */}
        <h2>{isDirector || coversMovements ? operationName('movement', displayLanguage()) : `${areaLabel(user.sector)} — ${t('movement.linkedMovements')}`}</h2>
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

    {isDirector && showRates && <RatePanel rate={rate} fetchJson={fetchJson} busy={busy} onSave={saveRate} onError={onError} />}

    {/* The form opens where the reader is looking: a sheet on a phone, and
        scrolled into view on a wide screen, instead of far above the button. */}
    {formState && <DetailView
      onClose={() => setFormState(null)}
      label={formState.mode === 'edit' ? `${t('movement.editMovementTitle')} ${formState.movement.ref}` : t('movement.newMovement')}
    >
      <MovementForm
        key={formState.mode === 'edit' ? formState.movement.id : 'create'}
        mode={formState.mode}
        movement={formState.movement}
        initialValues={formState.values}
        rate={rate}
        isDirector={isDirector}
        busy={busy}
        onCancel={() => setFormState(null)}
        onSave={saveMovement}
      />
    </DetailView>}

    <MovementFilters
      filters={filters}
      setFilters={setFilters}
      open={filtersOpen}
      onToggle={() => setFiltersOpen((current) => !current)}
      onApply={() => { setAppliedFilters(filters); setFiltersOpen(false); }}
      onClear={() => { setFilters(emptyFilters); setAppliedFilters(emptyFilters); }}
      active={filtersActive}
    />

    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>{t('panel.movementRegister')}</h2>
          <span>{movements.length}</span>
        </div>
        <button className="text-btn" type="button" onClick={() => { load(); changedRef.current?.(); }}>{t('action.refresh')}</button>
      </div>
      {loading
        ? <div className="loading-state"><span className="spinner" />{t('app.loading')}</div>
        : <MovementTable movements={movements} selectedId={detail?.movement.id} onSelect={openDetail} />}
    </section>

    {detail && openId && detail.movement.id === openId && !formState && <DetailView onClose={() => onClose?.()} label={`${detail.movement.ref} — ${detail.movement.purpose}`}>
      <MovementDetail
        key={detail.movement.id}
        detail={detail}
        user={user}
        onOpenFile={onOpenFile}
        isDirector={isDirector}
        busy={busy}
        onClose={() => onClose?.()}
        onEdit={(movement) => setFormState({ mode: 'edit', movement, values: movementToForm(movement) })}
        onStatus={changeStatus}
        onApprove={decideApproval}
        onReject={rejectApproval}
        onFinance={updateFinance}
        onVisibility={setVisibility}
        onUpload={uploadEvidence}
        onRemoveEvidence={removeEvidence}
        onDelete={removeMovement}
      />
    </DetailView>}

    <MovementReports reports={reports} busy={busy} onRun={runReports} onClose={() => setReports(null)} />
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

// On a phone the nine filters fold away behind one button, so the register is
// not pushed a whole screen down. On a wide screen they are always shown.
function MovementFilters({ filters, setFilters, open, onToggle, onApply, onClear, active }) {
  const t = useT();
  const set = (patch) => setFilters({ ...filters, ...patch });
  return <form className={`filter-panel${open ? ' filters-open' : ''}`} onSubmit={(event) => { event.preventDefault(); onApply(); }}>
    <div className="panel-header">
      <div><h2>{t('panel.filterMovements')}</h2><span>{t('filter.blurb')}</span></div>
      <button className="secondary-btn compact filter-toggle" type="button" aria-expanded={open} aria-controls="movement-filter-body" onClick={onToggle}>
        {open ? t('action.hideFilters') : t('action.showFilters')}{active ? ' •' : ''}
      </button>
    </div>
    <div className="filter-body" id="movement-filter-body">
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
    </div>
  </form>;
}

function MovementTable({ movements, selectedId, onSelect }) {
  const t = useT();
  if (!movements.length) {
    return <div className="empty-state"><strong>{t('empty.noMovements')}</strong><span>{t('empty.noMovementsHint')}</span></div>;
  }
  return <div className="table-wrap"><table className="card-table">
    <thead><tr>
      <th>{t('movement.reference')}</th><th>{t('field.type')}</th><th>{t('movement.relatedArea')}</th><th>{t('movement.route')}</th>
      <th>{t('movement.departure')}</th><th>{t('movement.personTeam')}</th><th>{t('table.status')}</th>
      <th>{t('movement.estimated')}</th><th>{t('movement.released')}</th><th>{t('movement.actual')}</th><th>{t('movement.balance')}</th><th>{t('field.evidence')}</th>
    </tr></thead>
    <tbody>{movements.map((movement) => <tr
      key={movement.id}
      className={movement.id === selectedId ? 'row-selected clickable-row' : 'clickable-row'}
      tabIndex={0}
      aria-label={`${movement.ref} — ${movement.purpose}`}
      onClick={() => onSelect(movement.id)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(movement.id); }
      }}
    >
      <td className="card-title-cell"><strong>{movement.ref} — {movement.purpose}</strong><small>{formatDateTime(movement.createdAt)}</small></td>
      <td data-label={t('field.type')}>{t(`mtype.${movement.movementType}`)}</td>
      <td data-label={t('movement.relatedArea')}>{movement.relatedArea ? <span className="area-badge">{areaLabel(movement.relatedArea)}</span> : <small>{t('filter.notLinked')}</small>}</td>
      <td data-label={t('movement.route')}>{movement.origin || '—'} &rarr; {movement.destination}</td>
      <td data-label={t('movement.departure')}>{formatDate(movement.departureDate)}<small>{t('movement.return')} {formatDate(movement.returnDate)}</small></td>
      <td data-label={t('movement.personTeam')}>{movement.personTeam || '—'}</td>
      <td data-label={t('table.status')}><span className={`status-badge ${journeyTone(movementJourney(movement))}`}>{journeyLabel(movementJourney(movement), t)}</span></td>
      <td data-label={t('movement.estimated')}>{formatMoney(movement.estimatedTotal, movement.currency)}</td>
      <td data-label={t('movement.released')}>{formatMoney(movement.fundsReleased, movement.currency)}</td>
      <td data-label={t('movement.actual')}>{formatMoney(movement.actualExpense, movement.currency)}</td>
      <td data-label={t('movement.balance')}>{formatMoney(movement.balanceReturn, movement.currency)}</td>
      <td data-label={t('field.evidence')}><span className={`status-badge ${movement.evidenceStatus === 'Complete' ? 'tone-done' : 'tone-waiting'}`}>{t(`estatus.${movement.evidenceStatus}`)}</span><small>{fill(t('movement.fileCount'), { count: movement.evidenceCount ?? 0 })}</small></td>
    </tr>)}</tbody>
  </table></div>;
}

// Section 3 (request details) and section 4 (facilitation cost breakdown).
function MovementForm({ mode, movement, initialValues, rate, isDirector, busy = false, onCancel, onSave }) {
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
    // "Save draft" is a plain button, so the browser's own required-field check
    // never ran for it and an empty draft went to the server. Asked for here.
    const form = event.currentTarget.form || event.currentTarget;
    if (typeof form.reportValidity === 'function' && !form.reportValidity()) return;
    onSave(values, useActualRate ? { rwfPerUsd: Number(actualRate.rwfPerUsd), cdfPerUsd: Number(actualRate.cdfPerUsd) } : null, submitForReview);
  };

  return <form className="form-panel movement-form" onSubmit={(event) => submit(event, true)}>
    <div className="panel-header">
      <div>
        <h2>{mode === 'edit' ? `${t('movement.editMovementTitle')} ${movement.ref}` : t('movement.newMovement')}</h2>
        <span>{t('movement.formBlurb')}</span>
      </div>
      <button className="text-btn hide-on-sheet" type="button" onClick={onCancel}>{t('action.cancel')}</button>
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
        <input type="number" inputMode="decimal" min="0" step="0.01" placeholder="0" value={values.costs[key]} onChange={(event) => setCost(key, event.target.value)} />
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

    <div className="form-submit-bar">
      <button className="secondary-btn" type="button" onClick={onCancel}>{t('action.cancel')}</button>
      {mode === 'create' && <button className="secondary-btn" type="button" disabled={busy} onClick={(event) => submit(event, false)}>{t('action.saveDraft')}</button>}
      <button className="primary-btn" type="submit" disabled={busy}>{mode === 'edit' ? t('movement.saveChanges') : t('movement.createAndSubmit')}</button>
    </div>
  </form>;
}

// Sections 6, 7 and 8: workflow actions, accountability figures, evidence, history.
function MovementDetail({ detail, user, onOpenFile, isDirector, busy = false, onClose, onEdit, onStatus, onApprove, onReject, onFinance, onVisibility, onUpload, onRemoveEvidence, onDelete }) {
  const t = useT();
  const { movement, evidence, history } = detail;
  const [finance, setFinance] = useState({
    fundsReleased: String(movement.fundsReleased),
    actualExpense: String(movement.actualExpense),
    evidenceStatus: movement.evidenceStatus
  });
  const [approval, setApproval] = useState({
    approvedBudget: String(movement.estimatedTotal),
    adminNote: '',
  });

  // The detail stays mounted while the record is saved and re-read, so the
  // inputs are re-seeded whenever the server's copy changes. Seeded once, they
  // kept the figures from before "Mark as Funds Released", and the next "Record
  // figures" wrote that stale 0 over the released amount -- and put an evidence
  // status the upload had already moved on back to Pending. The reason typed
  // for one status change is cleared too, so it is not sent with the next.
  useEffect(() => {
    setFinance({
      fundsReleased: String(movement.fundsReleased),
      actualExpense: String(movement.actualExpense),
      evidenceStatus: movement.evidenceStatus
    });
    setApproval({ approvedBudget: String(movement.estimatedTotal), adminNote: '' });
  }, [movement.updatedAt, movement.fundsReleased, movement.actualExpense, movement.evidenceStatus, movement.estimatedTotal]);

  const coversMovements = Boolean(user.coversAllSectors) || user.sector === 'movement';
  const canEdit = isDirector || (coversMovements && movement.createdBy === user.id && ['Draft', 'Pending Approval'].includes(movement.status));
  const canAttach = isDirector || (coversMovements && movement.createdBy === user.id);
  // Whether this user is the person the record is waiting on. The API checks
  // the same thing again before it writes anything.
  const iAmApprover = canApproveRecord(user, movement);
  const canChangeBudget = iAmApprover && isDirector;
  const typedBudget = Number(approval.approvedBudget || 0);
  const budgetChanged = canChangeBudget && typedBudget !== Number(movement.estimatedTotal);
  const nextStatuses = (STATUS_FLOW[movement.status] || []).filter((status) => {
    // Approving and refusing are decisions with a named approver, not status
    // buttons: while the decision is open they happen in the decision form.
    if (['Approved', 'Rejected'].includes(status) && decisionIsOpen(movement)) return false;
    if (isDirector) return true;
    return movement.createdBy === user.id && SELF_MOVES.some(([from, to]) => movement.status === from && status === to);
  });
  const canRecordFigures = isDirector && FINANCE_STATUSES.includes(movement.status);
  const journey = movementJourney(movement);
  const moveTo = (status) => onStatus(movement, status, {
    ...(status === 'Funds Released' ? { fundsReleased: Number(finance.fundsReleased) || Number(movement.estimatedTotal) } : {}),
    ...(status === 'Completed' ? { actualExpense: Number(finance.actualExpense) || 0 } : {})
  });
  const statusButtonLabel = (status) => {
    if (status === 'Pending Approval' && movement.status === 'Draft') return t('action.submitForApproval');
    if (status === 'Draft' && !isDirector) return t('action.takeBackToEdit');
    if (status === 'Funds Released') return t('action.markMoneyHandedOver');
    if (status === 'In Progress') return t('action.markUnderway');
    if (status === 'Completed') return t('action.markDone');
    if (status === 'Pending Approval') return t('action.reopen');
    return `${t('action.markAs')} ${t(`status.${status}`)}`;
  };
  const canMove = (status) => nextStatuses.includes(status);
  const stepButton = (status, primary = true) => canMove(status) && <button key={status}
    className={primary ? 'primary-btn' : 'secondary-btn'} type="button" disabled={busy} onClick={() => moveTo(status)}>
    {statusButtonLabel(status)}
  </button>;

  let next;
  switch (movement.status) {
    case 'Draft':
      next = canMove('Pending Approval')
        ? { tone: 'action', title: t('journey.draft'), text: t('next.draftText'), actions: <>
          {stepButton('Pending Approval')}
          {canEdit && <button className="secondary-btn" type="button" disabled={busy} onClick={() => onEdit(movement)}>{t('action.editMovement')}</button>}
        </> }
        : { tone: 'info', title: t('journey.draft'), text: t('next.draftOther') };
      break;
    case 'Pending Approval':
      next = iAmApprover
        ? { tone: 'action', title: t('next.decideTitle'), text: t('next.decideText'),
          actions: <button className="primary-btn" type="button" onClick={() => goToSection('movement-decision')}>{t('next.goDecide')}</button> }
        : { tone: 'info', title: fill(t('next.waitingFor'), { name: approverName(movement, areaLabel, t) }), text: t('next.waitingForText'),
          actions: !isDirector && stepButton('Draft', false) };
      break;
    case 'Rejected':
      next = { tone: 'stopped', title: t('journey.refused'), text: movement.rejectionReason || '',
        actions: stepButton(isDirector ? 'Pending Approval' : 'Draft', false) };
      break;
    case 'Cancelled':
      next = { tone: 'stopped', title: t('journey.cancelled'), text: movement.rejectionReason || '', actions: stepButton('Pending Approval', false) };
      break;
    case 'Approved':
      next = isDirector
        ? { tone: 'action', title: t('next.tripApprovedTitle'), text: t('next.tripApprovedText'), actions: <>{stepButton('Funds Released')}{stepButton('In Progress', false)}</> }
        : { tone: 'info', title: t('next.tripApprovedTitle'), text: t('next.tripWithDirector') };
      break;
    case 'Funds Released':
      next = isDirector
        ? { tone: 'action', title: t('journey.fundsOut'), text: t('next.tripFundedText'), actions: stepButton('In Progress') }
        : { tone: 'info', title: t('journey.fundsOut'), text: t('next.tripAddReceipts'),
          actions: canAttach && <button className="secondary-btn" type="button" onClick={() => goToSection('movement-proof')}>{t('next.addReceipts')}</button> };
      break;
    case 'In Progress':
      next = isDirector
        ? { tone: 'action', title: t('journey.underway'), text: t('next.tripUnderwayText'), actions: <>
          <button className="secondary-btn" type="button" onClick={() => goToSection('movement-tools')}>{t('action.recordFigures')}</button>
          {stepButton('Completed')}
        </> }
        : { tone: 'info', title: t('journey.underway'), text: t('next.tripAddReceipts'),
          actions: canAttach && <button className="secondary-btn" type="button" onClick={() => goToSection('movement-proof')}>{t('next.addReceipts')}</button> };
      break;
    default:
      next = { tone: 'done', title: t('journey.done'), text: movement.completedAt ? fill(t('next.doneOn'), { date: formatDateTime(movement.completedAt) }) : '' };
  }
  const canDelete = isDirector && DELETABLE_STATUSES.includes(movement.status)
    && !Number(movement.fundsReleased) && !Number(movement.actualExpense);
  // An approval that changed the budget moves the total but not the lines it was
  // estimated from, so the lines are shown against the approved total rather
  // than as a sum that silently fails to add up.
  const linesTotal = COST_LINES.reduce((sum, [key]) => sum + Number(movement.costs[key] || 0), 0);
  const approvedDiffers = Math.round(linesTotal * 100) !== Math.round(Number(movement.estimatedTotal) * 100);

  return <section className="panel detail-panel">
    <div className="panel-header">
      <div>
        <h2>{movement.ref} — {movement.purpose}</h2>
        <span>
          {t(`mtype.${movement.movementType}`)} · {movement.origin || '—'} &rarr; {movement.destination} · {areaLabel(movement.relatedArea)} ·
          {' '}{fill(t('movement.createdByOn'), { name: movement.createdByName || '—', date: formatDateTime(movement.createdAt) })}
        </span>
      </div>
      <button className="text-btn hide-on-sheet" type="button" onClick={onClose}>{t('action.close')}</button>
    </div>

    <Journey journey={journey} />

    <NextStep tone={next.tone} title={next.title} actions={next.actions}>{next.text}</NextStep>

    <MoneyBar
      approved={movement.estimatedTotal}
      spent={movement.actualExpense}
      format={(amount) => formatMoney(amount, movement.currency)}
      extra={<p className="money-note">
        {fill(t('money.handedOver'), { amount: formatMoney(movement.fundsReleased, movement.currency) })}
        {Number(movement.fundsReleased) > 0 && ` · ${fill(t('money.toGiveBack'), { amount: formatMoney(movement.balanceReturn, movement.currency) })}`}
      </p>}
    />

    <Section id="movement-details" title={t('section.details')} defaultOpen>
      <div className="detail-facts">
        <Fact label={t('table.department')} value={areaLabel(movement.department)} />
        <Fact label={t('movement.departure')} value={formatDate(movement.departureDate)} />
        <Fact label={t('movement.return')} value={formatDate(movement.returnDate)} />
        <Fact label={t('movement.personTeam')} value={movement.personTeam || '—'} />
        <Fact label={t('movement.transport')} value={movement.transportType || '—'} />
        <Fact label={t('movement.vehicleDriverShort')} value={movement.vehicleDriver || '—'} />
      </div>
      {movement.notes && <p className="detail-notes">{movement.notes}</p>}
      {movement.adminNote && <p className="detail-notes admin-note"><strong>{t('review.directorNote')}:</strong> &ldquo;{movement.adminNote}&rdquo;</p>}

      <h3 className="form-section-title">{t('movement.costBreakdown')}</h3>
      <div className="table-wrap"><table className="cost-table">
        <thead><tr><th>{t('movement.costItem')}</th><th>{t('field.amount')}</th></tr></thead>
        <tbody>
          {COST_LINES.map(([key, labelKey]) => <tr key={key}><td>{t(labelKey)}</td><td>{formatMoney(movement.costs[key], movement.currency)}</td></tr>)}
          {approvedDiffers && <tr><td>{t('movement.estimatedLines')}</td><td>{formatMoney(linesTotal, movement.currency)}</td></tr>}
          <tr className="total-row"><td><strong>{approvedDiffers ? t('movement.approvedTotal') : t('field.total')}</strong></td><td><strong>{formatMoney(movement.estimatedTotal, movement.currency)}</strong></td></tr>
        </tbody>
      </table></div>
      {movement.converted && <p className="detail-notes">
        {t('movement.equivalentAt')} ({Number(movement.rate.rwfPerUsd).toLocaleString()} RWF / {Number(movement.rate.cdfPerUsd).toLocaleString()} CDF / USD,
        {' '}{movement.rate.source === 'actual' ? t('movement.actualRate') : t('movement.refRate')}, {formatDateTime(movement.rate.recordedAt)}):
        {' '}{formatMoney(movement.converted.estimatedTotal.rwf, 'RWF')} · {formatMoney(movement.converted.estimatedTotal.usd, 'USD')} · {formatMoney(movement.converted.estimatedTotal.cdf, 'CDF')}
      </p>}
      <ApprovalPanel record={movement} sectorLabel={areaLabel} />
      {canEdit && !['Draft'].includes(movement.status) && <div className="button-row">
        <button className="secondary-btn" type="button" disabled={busy} onClick={() => onEdit(movement)}>{t('action.editMovement')}</button>
      </div>}
    </Section>

    {/* The decision this record is waiting on, drawn only for the person it
        names. The API refuses anybody else regardless of what is on screen. */}
    {iAmApprover && <form id="movement-decision" className="decision-form approval-form" onSubmit={(event) => {
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
          <input type="number" inputMode="decimal" min="0" step="0.01" value={approval.approvedBudget}
            onChange={(event) => setApproval({ ...approval, approvedBudget: event.target.value })} />
        </label>}
        <label className="form-field form-field-wide">
          <span>{t('review.directorNote')} ({budgetChanged ? t('field.required') : t('field.optional')})</span>
          <textarea rows="2" required={budgetChanged}
            value={approval.adminNote} onChange={(event) => setApproval({ ...approval, adminNote: event.target.value })} />
        </label>
      </div>
      {budgetChanged && <p className="decision-hint">
        {formatMoney(movement.estimatedTotal, movement.currency)} &rarr; {formatMoney(typedBudget, movement.currency)}
      </p>}
      <div className="form-submit-bar">
        <button className="primary-btn" type="submit" disabled={busy}>{t('approval.approve')}</button>
        <button className="danger-btn outlined" type="button" disabled={busy} onClick={() => onReject(movement)}>{t('approval.reject')}</button>
      </div>
    </form>}

    <Section id="movement-proof" title={t('section.receipts')} count={evidence.length || null}
      defaultOpen={canAttach && ['Funds Released', 'In Progress'].includes(movement.status)}>
      {canAttach && <EvidenceUpload movement={movement} busy={busy} onUpload={onUpload} />}
      <EvidenceList
        movement={movement}
        evidence={evidence}
        onOpenFile={onOpenFile}
        canRemove={isDirector}
        busy={busy}
        onRemove={(item) => onRemoveEvidence(movement, item)}
      />
    </Section>

    {isDirector && <Section id="movement-tools" title={t('section.directorTools')}
      defaultOpen={movement.status === 'In Progress'}>
      {canRecordFigures && <form className="decision-form" onSubmit={(event) => {
        event.preventDefault();
        onFinance(movement, {
          fundsReleased: Number(finance.fundsReleased) || 0,
          actualExpense: Number(finance.actualExpense) || 0,
          evidenceStatus: finance.evidenceStatus
        });
      }}>
        <h3 className="form-section-title">{t('action.recordFigures')}</h3>
        <div className="form-grid">
          <label className="form-field"><span>{t('movement.fundsReleased')} ({movement.currency})</span>
            <input type="number" inputMode="decimal" min="0" step="0.01" value={finance.fundsReleased} onChange={(event) => setFinance({ ...finance, fundsReleased: event.target.value })} />
          </label>
          <label className="form-field"><span>{t('movement.actualExpense')} ({movement.currency})</span>
            <input type="number" inputMode="decimal" min="0" step="0.01" value={finance.actualExpense} onChange={(event) => setFinance({ ...finance, actualExpense: event.target.value })} />
          </label>
          <label className="form-field"><span>{t('movement.evidenceStatus')}</span>
            <select value={finance.evidenceStatus} onChange={(event) => setFinance({ ...finance, evidenceStatus: event.target.value })}>
              {EVIDENCE_STATUSES.map((status) => <option key={status} value={status}>{t(`estatus.${status}`)}</option>)}
            </select>
          </label>
        </div>
        <div className="form-submit-bar">
          <button className="secondary-btn" type="submit" disabled={busy}>{t('action.recordFigures')}</button>
        </div>
      </form>}

      {nextStatuses.length > 0 && <>
        <h3 className="form-section-title">{t('movement.workflow')}</h3>
        <div className="button-row workflow-actions">
          {nextStatuses.map((status) => <button
            key={status}
            className={['Rejected', 'Cancelled'].includes(status) ? 'danger-btn outlined' : 'secondary-btn'}
            type="button"
            disabled={busy}
            onClick={() => moveTo(status)}
          >{statusButtonLabel(status)}</button>)}
        </div>
      </>}

      {/* The Director's switch for what an external partner may see, as on an
          activity. It publishes nothing that has not been approved. */}
      {onVisibility && <div className="visibility-control">
        <div>
          <span className="eyebrow">{t('review.externalVisibility')}</span>
          <strong className={movement.externallyVisible ? 'tone-done' : 'tone-stopped'}>
            {movement.externallyVisible ? t('visibility.visible') : t('visibility.hidden')}
          </strong>
          <small>{movement.approvalStatus === 'approved' ? t('visibility.note') : t('visibility.notApprovedYet')}</small>
        </div>
        <button className={movement.externallyVisible ? 'danger-btn outlined' : 'secondary-btn'} type="button" disabled={busy}
          onClick={() => onVisibility(movement, !movement.externallyVisible)}>
          {movement.externallyVisible ? t('visibility.hide') : t('visibility.show')}
        </button>
      </div>}

      {canDelete && <div className="button-row danger-zone">
        <button className="danger-btn outlined" type="button" disabled={busy} onClick={() => onDelete(movement)}>{t('action.deleteMovement')}</button>
      </div>}
    </Section>}

    <Section id="movement-history" title={t('movement.historyTitle')} count={history.length || null}>
      {history.length
        ? <ul className="history-list">{history.map((entry) => <li key={entry.id}>
            <strong>{trailActionLabel(entry.action, t)}</strong>
            <span>
              {entry.field ? `${labelForField(entry.field, t)}: ` : ''}
              {entry.oldValue !== null && entry.oldValue !== undefined && entry.oldValue !== '' ? `${formatTrailValue(entry.field, entry.oldValue, null, t)} → ` : ''}
              {formatTrailValue(entry.field, entry.newValue, null, t)}
            </span>
            <small>{entry.actorName} · {formatDateTime(entry.createdAt)}</small>
          </li>)}</ul>
        : <div className="empty-state"><strong>{t('empty.noHistory')}</strong><span>{t('empty.historyBlurb')}</span></div>}
    </Section>
  </section>;
}

function Fact({ label, value }) {
  return <div className="fact"><span>{label}</span><strong>{value}</strong></div>;
}

// Receipts and photographs for a trip, taken with the camera or picked from
// files. The amount box that used to sit here was stored on the first file only
// and never counted towards what was spent, so it is gone.
function EvidenceUpload({ movement, busy = false, onUpload }) {
  const t = useT();
  const [kind, setKind] = useState('Receipt');
  const [note, setNote] = useState('');
  const [files, setFiles] = useState([]);

  const submit = (event) => {
    event.preventDefault();
    if (!files.length) return;
    const formData = new FormData();
    formData.append('kind', kind);
    formData.append('note', note);
    files.forEach((file) => formData.append('files', file));
    // Cleared only once stored, so a failed upload keeps the chosen files.
    Promise.resolve(onUpload(movement, formData)).then((stored) => {
      if (stored === false) return;
      setNote(''); setFiles([]);
    });
  };

  return <form className="decision-form evidence-upload" onSubmit={submit}>
    <FilePicker files={files} onChange={setFiles} disabled={busy} />
    <div className="form-grid">
      <label className="form-field"><span>{t('field.evidenceType')}</span>
        <select value={kind} onChange={(event) => setKind(event.target.value)}>{EVIDENCE_KINDS.map((option) => <option key={option} value={option}>{t(`ekind.${option}`)}</option>)}</select>
      </label>
      <label className="form-field"><span>{t('field.note')} ({t('field.optional')})</span>
        <input placeholder={t('evidence.fuelNotePlaceholder')} value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
    </div>
    <div className="form-submit-bar">
      <button className="primary-btn" type="submit" disabled={busy || !files.length}>{t('action.uploadEvidence')}</button>
    </div>
  </form>;
}

function EvidenceList({ movement, evidence, onOpenFile, canRemove, busy = false, onRemove }) {
  const t = useT();
  if (!evidence.length) {
    return <div className="empty-state"><strong>{t('empty.noEvidence')}</strong><span>{t('empty.noEvidenceHint')}</span></div>;
  }
  return <div className="table-wrap"><table className="card-table">
    <thead><tr><th>{t('field.file')}</th><th>{t('field.type')}</th><th>{t('field.amount')}</th><th>{t('field.note')}</th><th>{t('field.uploadedBy')}</th><th>{t('table.date')}</th><th>{t('table.actions')}</th></tr></thead>
    <tbody>{evidence.map((item) => <tr key={item.id}>
      <td className="card-title-cell"><strong className="file-name">{item.originalName}</strong><small>{(item.sizeBytes / 1024).toFixed(0)} KB · {item.mimeType}</small></td>
      <td data-label={t('field.type')}>{t(`ekind.${item.kind}`)}</td>
      <td data-label={t('field.amount')}>{item.amount ? formatMoney(item.amount, movement.currency) : '—'}</td>
      <td data-label={t('field.note')}>{item.note || '—'}</td>
      <td data-label={t('field.uploadedBy')}>{item.uploadedByName || '—'}</td>
      <td data-label={t('table.date')}>{formatDateTime(item.createdAt)}</td>
      <td className="card-actions">
        <button className="text-btn" type="button"
          onClick={() => onOpenFile(`/api/movements/${encodeURIComponent(movement.id)}/evidence/${item.id}/file`)}>{t('action.view')}</button>
        {canRemove && <button className="danger-btn" type="button" disabled={busy} onClick={() => onRemove(item)}>{t('action.remove')}</button>}
      </td>
    </tr>)}</tbody>
  </table></div>;
}

// Section 9.
function MovementReports({ reports, busy = false, onRun, onClose }) {
  const t = useT();
  return <section className="report-area">
    <div className="panel-header">
      <div><h2>{t('movement.reportsTitle')}</h2></div>
      <div className="report-actions">
        <button className="secondary-btn" type="button" disabled={busy} onClick={onRun}>{t('action.runReport')}</button>
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

// `heading` names the first column. It is passed in rather than derived from
// the title by stripping an English "By ", which only worked in English.
function ReportTable({ title, heading, rows, label = (key) => key }) {
  const t = useT();
  if (!rows?.length) return null;
  return <div className="report-block">
    <div className="panel-header"><div><h2>{title}</h2></div></div>
    <div className="table-wrap"><table className="card-table">
      <thead><tr><th>{heading}</th><th>{t('movement.movements')}</th><th>{t('movement.estimated')} (RWF)</th><th>{t('movement.released')} (RWF)</th><th>{t('movement.actual')} (RWF)</th><th>{t('movement.balance')} (RWF)</th><th>{t('movement.estimated')} (USD)</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.key}>
        <td className="card-title-cell"><strong>{label(row.key)}</strong></td>
        <td data-label={t('movement.movements')}>{row.count}</td>
        <td data-label={`${t('movement.estimated')} (RWF)`}>{formatMoney(row.totals.estimated.rwf, 'RWF')}</td>
        <td data-label={`${t('movement.released')} (RWF)`}>{formatMoney(row.totals.released.rwf, 'RWF')}</td>
        <td data-label={`${t('movement.actual')} (RWF)`}>{formatMoney(row.totals.actual.rwf, 'RWF')}</td>
        <td data-label={`${t('movement.balance')} (RWF)`}>{formatMoney(row.totals.balance.rwf, 'RWF')}</td>
        <td data-label={`${t('movement.estimated')} (USD)`}>{formatMoney(row.totals.estimated.usd, 'USD')}</td>
      </tr>)}</tbody>
    </table></div>
  </div>;
}

function RatePanel({ rate, fetchJson, busy = false, onSave, onError }) {
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
    <button className="primary-btn" type="submit" disabled={busy}>{t('action.saveRate')}</button>
    {history && <div className="table-wrap"><table className="card-table">
      <thead><tr><th>{t('table.date')}</th><th>RWF / USD</th><th>CDF / USD</th><th>{t('field.note')}</th><th>{t('movement.setBy')}</th></tr></thead>
      <tbody>{history.map((entry) => <tr key={entry.id}>
        <td className="card-title-cell"><strong>{formatDateTime(entry.updatedAt)}</strong></td>
        <td data-label="RWF / USD">{Number(entry.rwfPerUsd).toLocaleString()}</td>
        <td data-label="CDF / USD">{Number(entry.cdfPerUsd).toLocaleString()}</td>
        <td data-label={t('field.note')}>{entry.note || '—'}</td>
        <td data-label={t('movement.setBy')}>{entry.updatedByName || '—'}</td>
      </tr>)}</tbody>
    </table></div>}
  </form>;
}
