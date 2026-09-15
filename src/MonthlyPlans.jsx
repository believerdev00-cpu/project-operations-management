import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BUSINESS_OPERATIONS, operationName } from '../shared/businessOperations.js';
import { fill, useI18n } from './i18n.js';
import { categoryLabel, trailActionLabel } from './ActivityReview.jsx';
import { DetailView, useBusy, useDialog } from './ui.jsx';
import { FilePicker, activityJourney, formatLocal, journeyLabel, journeyTone } from './journey.jsx';

// Monthly planning, allocation and month-end review.
//
// The Director plans a month per business operation, confirms the budget, and
// reviews how it went. The manager sees the month they were given and reports
// on it. Both read the same figures from the same endpoint, so the manager's
// dashboard and the Director's review can never disagree.
//
// Nothing here moves money. Confirming a plan records that an allocation was
// approved; the cash is handed over outside the platform. There is no transfer,
// wallet, transaction or gateway in this file, and the screen says so.

const PAYMENT_METHODS = ['Cash', 'Bank Transfer', 'Mobile Money', 'Cheque', 'Credit', 'Other'];
const PRIORITIES = ['High', 'Medium', 'Low'];

export function formatUsd(value) {
  const amount = Number(value || 0);
  const digits = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(amount));
  return `${amount < 0 ? '-' : ''}$${digits}`;
}

function formatDate(value, language) {
  if (!value) return '—';
  const [year, month, day] = String(value).slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return '—';
  return new Date(year, month - 1, day).toLocaleDateString(language);
}

function thisMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// Today as the calendar sees it here. toISOString() converts to UTC first, so
// between midnight and 02:00 in Kigali it handed back yesterday's date.
function todayLocal() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function monthLabel(month, language) {
  const [year, index] = String(month).split('-').map(Number);
  if (!year || !index) return month;
  return new Date(year, index - 1, 1).toLocaleDateString(language, { month: 'long', year: 'numeric' });
}

const emptyActivity = {
  activity: '', category: '', description: '', approvedBudget: '',
  priority: 'Medium', deadline: '', adminNote: ''
};

export default function MonthlyPlans({
  user, fetchJson, managers, rate = null,
  planId = null, onOpenPlan, onClosePlan, onChanged, onMessage, onError
}) {
  const { language, t } = useI18n();
  const dialog = useDialog();
  const [busy, run] = useBusy();
  const isDirector = user.role === 'super-admin';

  const [month, setMonth] = useState(thisMonth);
  const [review, setReview] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [detail, setDetail] = useState(null);
  // Approved work in the plan's operation that no month has taken in yet --
  // asked of the server, not picked out of the newest page of the register.
  const [offPlan, setOffPlan] = useState([]);
  const [newPlan, setNewPlan] = useState({ operation: '', managerId: '' });
  const [activityForm, setActivityForm] = useState(emptyActivity);
  // Each load is numbered, and only the newest may write. Stepping through the
  // month picker fires a request per month, and an older one answering last
  // used to put last month's figures under this month's heading.
  const latestLoad = useRef(0);
  const latestOpen = useRef(0);
  // The month a manager's plan has already been opened for, so closing it
  // stays closed instead of the auto-open immediately bringing it back.
  const autoOpenedFor = useRef(null);

  // The open plan lives in the address (#/monthly/12), so it survives a refresh
  // and the back button closes it.
  const openPlanId = planId ? Number(planId) : null;
  // Held in a ref so a parent passing a fresh function each render cannot turn
  // the plan loader into a new function -- and its effect into a refetch loop.
  const closePlanRef = useRef(onClosePlan);
  closePlanRef.current = onClosePlan;

  const load = useCallback(async () => {
    const request = ++latestLoad.current;
    try {
      const result = await fetchJson(`/api/monthly-plans/review?month=${month}`);
      if (request !== latestLoad.current) return;
      setReview(result);
      setLoadFailed(false);
    } catch (loadError) {
      if (request !== latestLoad.current) return;
      setLoadFailed(true);
      onError(loadError.message);
    }
  }, [fetchJson, month, onError]);

  useEffect(() => { load(); }, [load]);

  const loadPlan = useCallback(async (id) => {
    const request = ++latestOpen.current;
    try {
      const result = await fetchJson(`/api/monthly-plans/${id}`);
      if (request !== latestOpen.current) return;
      setDetail(result);
      if (isDirector && result.plan.status !== 'Closed') {
        fetchJson(`/api/activities?unplanned=1&sector=${encodeURIComponent(result.plan.operation)}&limit=200`)
          .then((items) => { if (request === latestOpen.current) setOffPlan(items); })
          .catch(() => { if (request === latestOpen.current) setOffPlan([]); });
      } else {
        setOffPlan([]);
      }
      // A link to a plan in another month moves the page to that month, so the
      // review above the plan is the one it belongs to.
      if (result.plan.month) {
        setMonth((current) => {
          if (current === result.plan.month) return current;
          autoOpenedFor.current = result.plan.month;
          return result.plan.month;
        });
      }
    } catch (openError) {
      if (request !== latestOpen.current) return;
      onError(openError.message);
      closePlanRef.current?.();
    }
  }, [fetchJson, onError, isDirector]);

  useEffect(() => {
    if (!openPlanId) {
      latestOpen.current += 1;
      setDetail(null);
      return;
    }
    loadPlan(openPlanId);
  }, [openPlanId, loadPlan]);

  // A manager works one operation, so their month opens straight away rather
  // than making them pick their own plan out of a list of one -- once per
  // month, and only for the month the review actually belongs to.
  useEffect(() => {
    if (isDirector || openPlanId || !review?.operations?.length || review.month !== month) return;
    if (autoOpenedFor.current === month) return;
    autoOpenedFor.current = month;
    onOpenPlan?.(review.operations[0].id);
  }, [isDirector, review, month, openPlanId, onOpenPlan]);

  const changeMonth = (next) => {
    if (!next) return;
    setMonth(next);
    // Everything on screen belonged to the old month; none of it may linger
    // under the new heading while the new month loads.
    setReview(null);
    setLoadFailed(false);
    if (openPlanId) onClosePlan?.();
  };

  const refresh = async () => {
    await load();
    if (openPlanId) await loadPlan(openPlanId);
    onChanged?.();
  };

  // Operations that have no plan for this month yet, so the Director is offered
  // exactly the ones still to plan.
  const unplanned = useMemo(() => {
    const planned = new Set((review?.operations || []).map((plan) => plan.operation));
    return BUSINESS_OPERATIONS.filter((operation) => !planned.has(operation.id));
  }, [review]);

  // The select can only show operations still to plan. When the chosen one is
  // no longer among them -- it was just planned, or the month changed -- the
  // choice follows what is actually on screen, or the form would display one
  // operation while submitting another.
  const chosenOperation = unplanned.some((operation) => operation.id === newPlan.operation)
    ? newPlan.operation
    : (unplanned[0]?.id || '');
  const managerOptions = useMemo(
    () => managers.filter((manager) => manager.coversAllSectors || manager.sector === chosenOperation),
    [managers, chosenOperation]
  );

  // ---- actions, one at a time ------------------------------------------------

  const createPlan = (event) => {
    event.preventDefault();
    run(async () => {
      try {
        const plan = await fetchJson('/api/monthly-plans', {
          method: 'POST',
          body: JSON.stringify({ operation: chosenOperation, month, managerId: newPlan.managerId || null })
        });
        onMessage(fill(t('msg.planCreated'), { operation: operationName(plan.operation, language), month: monthLabel(month, language) }));
        setNewPlan({ operation: '', managerId: '' });
        await load();
        onChanged?.();
        onOpenPlan?.(plan.id);
      } catch (createError) { onError(createError.message); }
    });
  };

  const addActivity = (event) => {
    event.preventDefault();
    const name = activityForm.activity;
    run(async () => {
      try {
        await fetchJson(`/api/monthly-plans/${openPlanId}/activities`, {
          method: 'POST',
          body: JSON.stringify({ ...activityForm, approvedBudget: Number(activityForm.approvedBudget || 0) })
        });
        setActivityForm(emptyActivity);
        onMessage(fill(t('msg.plannedActivityAdded'), { name }));
        await refresh();
      } catch (addError) { onError(addError.message); }
    });
  };

  const confirmPlan = (plan) => run(async () => {
    const confirmed = await dialog.confirm({
      title: t('monthly.confirmPlan'),
      message: `${t('monthly.confirmHint')} ${t('monthly.totalToGive')}: ${formatUsd(plan.plannedBudget)}`,
      confirmLabel: t('monthly.confirmPlan')
    });
    if (!confirmed) return;
    try {
      const saved = await fetchJson(`/api/monthly-plans/${plan.id}/confirm`, { method: 'POST' });
      onMessage(`${t('monthly.approvedAllocation')}: ${formatUsd(saved.approvedBudget)}. ${t('monthly.noMoneyNotice')}`);
      await refresh();
    } catch (confirmError) { onError(confirmError.message); }
  });

  const reopenPlan = (plan) => run(async () => {
    const reason = await dialog.prompt({
      title: t('monthly.reopen'),
      label: t('field.reason'),
      required: true,
      multiline: true,
      confirmLabel: t('monthly.reopen')
    });
    if (reason === null) return;
    try {
      await fetchJson(`/api/monthly-plans/${plan.id}/reopen`, { method: 'POST', body: JSON.stringify({ reason }) });
      onMessage(t('msg.monthReopened'));
      await refresh();
    } catch (reopenError) { onError(reopenError.message); }
  });

  const decideReport = (plan, status) => run(async () => {
    const returning = status === 'Returned';
    const note = await dialog.prompt({
      title: returning ? t('monthend.return') : t('monthend.accept'),
      label: t('monthend.reviewNote'),
      required: returning,
      multiline: true,
      danger: returning,
      confirmLabel: returning ? t('monthend.return') : t('monthend.accept')
    });
    if (note === null) return;
    try {
      await fetchJson(`/api/monthly-plans/${plan.id}/report`, { method: 'PATCH', body: JSON.stringify({ status, reviewNote: note }) });
      onMessage(returning ? t('msg.reportReturned') : t('msg.reportAccepted'));
      await refresh();
    } catch (decideError) { onError(decideError.message); }
  });

  // Section 4: an activity a manager raised is not part of the month's budget
  // until the Director deliberately attaches it here.
  const attachActivity = (plan, item) => run(async () => {
    const reason = await dialog.prompt({
      title: t('monthly.attachActivity'),
      message: item.activity,
      label: t('field.reason'),
      multiline: true,
      confirmLabel: t('monthly.attachActivity')
    });
    if (reason === null) return;
    try {
      const saved = await fetchJson(`/api/monthly-plans/${plan.id}/attach/${encodeURIComponent(item.id)}`, {
        method: 'POST', body: JSON.stringify({ reason })
      });
      onMessage(`${t('monthly.approvedAllocation')}: ${formatUsd(saved.approvedBudget)}`);
      await refresh();
    } catch (attachError) { onError(attachError.message); }
  });

  // Resolves true once filed, so the explanations typed survive a refusal.
  const submitReport = (plan, explanations) => run(async () => {
    try {
      await fetchJson(`/api/monthly-plans/${plan.id}/report`, { method: 'POST', body: JSON.stringify(explanations) });
      onMessage(t('msg.reportSubmitted'));
      await refresh();
      return true;
    } catch (submitError) {
      onError(submitError.message);
      return false;
    }
  });

  // Section 10: the Director changes who runs the month, or its notes. The API
  // hands the month's live activities to the new manager with it.
  const updatePlan = (plan, changes) => run(async () => {
    try {
      await fetchJson(`/api/monthly-plans/${plan.id}`, { method: 'PATCH', body: JSON.stringify(changes) });
      onMessage(t('msg.planUpdated'));
      await refresh();
    } catch (updateError) { onError(updateError.message); }
  });

  if (!review) {
    return loadFailed
      ? <div className="empty-state load-issue">
          <strong>{t('app.loadFailed')}</strong>
          <button className="secondary-btn" type="button" onClick={load}>{t('action.retry')}</button>
        </div>
      : <div className="loading-state"><span className="spinner" />{t('app.loading')}</div>;
  }

  return <>
    <section className="context-strip">
      <div>
        <span className="eyebrow">{t('monthly.eyebrow')}</span>
        <h2>{isDirector ? t('monthly.title') : t('monthly.myActivities')}</h2>
        <p>{t('monthly.blurb')}</p>
      </div>
      <label className="form-field month-picker"><span>{t('monthly.month')}</span>
        <input type="month" value={month} onChange={(event) => changeMonth(event.target.value)} />
      </label>
    </section>

    {/* Stated on the screen itself, not only in the code: this is a record of
        an approved budget, not a payment. */}
    <p className="partner-notice">{t('monthly.noMoneyNotice')}</p>

    {isDirector && <>
      <div className="metric-grid metric-grid-5">
        <Metric label={t('monthly.approvedAllocation')} value={formatUsd(review.totals.approvedBudget)} />
        <Metric label={t('monthly.totalSpent')} value={formatUsd(review.totals.totalSpent)} />
        <Metric label={t('monthly.remainingBalance')} value={formatUsd(review.totals.remainingBalance)} />
        <Metric label={t('review.completedActivities')} value={`${review.totals.completed}/${review.totals.activities}`} />
        <Metric label={t('review.expensesWithoutEvidence')} value={review.totals.expensesWithoutEvidence} />
      </div>

      {/* Section 9: every business operation for the month, side by side. */}
      <section className="panel">
        <div className="panel-header"><div>
          <h2>{t('review.monthly')}</h2>
          <span>{monthLabel(month, language)}</span>
        </div></div>
        {review.operations.length ? <div className="table-wrap"><table className="card-table">
          <thead><tr>
            <th>{t('app.businessOperation')}</th><th>{t('field.manager')}</th>
            <th>{t('monthly.approvedAllocation')}</th><th>{t('monthly.totalSpent')}</th>
            <th>{t('monthly.remainingBalance')}</th><th>{t('review.completedActivities')}</th>
            <th>{t('review.pendingActivities')}</th><th>{t('review.expensesWithoutEvidence')}</th>
            <th>{t('review.missingEvidence')}</th><th>{t('table.status')}</th><th>{t('table.actions')}</th>
          </tr></thead>
          <tbody>{review.operations.map((plan) => <tr key={plan.id} className={plan.id === openPlanId ? 'row-selected' : undefined}>
            <td className="card-title-cell"><strong>{operationName(plan.operation, language)}</strong></td>
            <td data-label={t('field.manager')}>{plan.managerName || <span className="muted-cell">{t('table.unassigned')}</span>}</td>
            <td data-label={t('monthly.approvedAllocation')}>{formatUsd(plan.approvedBudget)}</td>
            <td data-label={t('monthly.totalSpent')}>{formatUsd(plan.totalSpent)}</td>
            <td data-label={t('monthly.remainingBalance')} className={plan.remainingBalance < 0 ? 'over-budget' : undefined}>{formatUsd(plan.remainingBalance)}</td>
            <td data-label={t('review.completedActivities')}>{plan.completedCount}/{plan.activityCount}</td>
            <td data-label={t('review.pendingActivities')}>{plan.outstandingCount}</td>
            <td data-label={t('review.expensesWithoutEvidence')} className={plan.expensesWithoutEvidence ? 'over-budget' : undefined}>
              {plan.expenseCount - plan.expensesWithoutEvidence}/{plan.expenseCount} {t('review.documented')}
            </td>
            <td data-label={t('review.missingEvidence')} className={plan.completedWithoutEvidence ? 'over-budget' : undefined}>
              {plan.completedCount - plan.completedWithoutEvidence}/{plan.completedCount} {t('review.documented')}
            </td>
            <td data-label={t('table.status')}><span className={`status-badge ${planTone(plan.status)}`}>{t(`monthly.planStatus.${plan.status}`)}</span></td>
            <td className="card-actions"><button className="text-btn" type="button" onClick={() => onOpenPlan?.(plan.id)}>{t('monthly.openPlan')}</button></td>
          </tr>)}</tbody>
        </table></div> : <div className="empty-state"><strong>{t('monthly.noPlans')}</strong><span>{t('table.noData')}</span></div>}
      </section>

      {unplanned.length > 0 && <form className="form-panel" onSubmit={createPlan}>
        <div className="panel-header"><div>
          <h2>{t('monthly.createPlan')}</h2>
          <span>{monthLabel(month, language)}</span>
        </div></div>
        <div className="form-grid">
          <label className="form-field"><span>{t('app.businessOperation')}</span>
            <select value={chosenOperation} onChange={(event) => setNewPlan({ operation: event.target.value, managerId: '' })}>
              {unplanned.map((operation) => <option key={operation.id} value={operation.id}>
                {operationName(operation.id, language)}
              </option>)}
            </select>
          </label>
          <label className="form-field"><span>{t('monthly.responsibleManager')}</span>
            <select required value={newPlan.managerId} onChange={(event) => setNewPlan({ operation: chosenOperation, managerId: event.target.value })}>
              <option value="">{t('form.selectManager')}</option>
              {managerOptions.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}
            </select>
          </label>
        </div>
        {!managerOptions.length && <p className="decision-hint">{t('form.noManagerCovers')}</p>}
        <div className="form-submit-bar"><button className="primary-btn" type="submit" disabled={busy || !managerOptions.length}>{t('monthly.createPlan')}</button></div>
      </form>}
    </>}

    {!isDirector && !review.operations.length && <div className="empty-state"><strong>{t('monthly.noPlans')}</strong><span>{t('table.noData')}</span></div>}

    {detail && openPlanId && detail.plan.id === openPlanId && <DetailView
      onClose={() => onClosePlan?.()}
      label={`${operationName(detail.plan.operation, language)} · ${monthLabel(detail.plan.month, language)}`}
    >
      <PlanDetail
        key={detail.plan.id}
        detail={detail}
        user={user}
        isDirector={isDirector}
        language={language}
        t={t}
        busy={busy}
        managers={managers}
        rate={rate}
        activityForm={activityForm}
        setActivityForm={setActivityForm}
        onAddActivity={addActivity}
        onConfirm={confirmPlan}
        onReopen={reopenPlan}
        onSubmitReport={submitReport}
        onAttach={attachActivity}
        onUpdatePlan={updatePlan}
        offPlanActivities={offPlan}
        onDecideReport={decideReport}
        onClose={() => onClosePlan?.()}
      />
    </DetailView>}
  </>;
}

// Plan statuses in the plan's own trail read in the viewer's language.
function planTrailValue(field, value, t) {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'status') {
    const key = `monthly.planStatus.${value}`;
    const label = t(key);
    return label === key ? value : label;
  }
  return value;
}

function planTone(status) {
  if (status === 'Confirmed') return 'tone-done';
  if (status === 'Closed') return 'tone-stopped';
  return 'tone-waiting';
}

function PlanDetail({
  detail, user, isDirector, language, t, busy, managers = [], rate = null, activityForm, setActivityForm,
  onAddActivity, onConfirm, onReopen, onSubmitReport, onDecideReport, onClose, onAttach, onUpdatePlan, offPlanActivities = []
}) {
  const { plan, activities, history, report } = detail;
  const [explanations, setExplanations] = useState({
    unusedBalanceExplanation: '', budgetDifferenceExplanation: ''
  });
  const [settings, setSettings] = useState({ managerId: plan.managerId ? String(plan.managerId) : '', notes: plan.notes || '' });

  // Re-read after a save, so the form shows what was actually stored.
  useEffect(() => {
    setSettings({ managerId: plan.managerId ? String(plan.managerId) : '', notes: plan.notes || '' });
  }, [plan.managerId, plan.notes]);

  const isPlanManager = !isDirector && plan.managerId === user.id;
  const open = plan.status !== 'Closed';
  const operationManagers = managers.filter((manager) => manager.coversAllSectors || manager.sector === plan.operation || manager.id === plan.managerId);
  const settingsChanges = {};
  if ((settings.managerId || '') !== (plan.managerId ? String(plan.managerId) : '')) settingsChanges.managerId = settings.managerId ? Number(settings.managerId) : null;
  if (settings.notes.trim() !== (plan.notes || '')) settingsChanges.notes = settings.notes.trim();
  const hasSettingsChanges = Object.keys(settingsChanges).length > 0;

  return <section className="panel detail-panel">
    <div className="panel-header">
      <div>
        <span className="eyebrow">{operationName(plan.operation, language).toUpperCase()}</span>
        <h2>{monthLabel(plan.month, language)}</h2>
        <span>
          {t('monthly.responsibleManager')}: {plan.managerName || '—'}
          {plan.confirmedByName ? ` · ${t('monthly.planStatus.Confirmed')}: ${plan.confirmedByName}` : ''}
        </span>
      </div>
      <button className="text-btn hide-on-sheet" type="button" onClick={onClose}>{t('action.close')}</button>
    </div>

    {/* Section 2 and 3: the total, and what it is made of. */}
    <div className="detail-facts">
      <Fact label={t('table.status')} value={<span className={`status-badge ${planTone(plan.status)}`}>{t(`monthly.planStatus.${plan.status}`)}</span>} />
      <Fact label={plan.status === 'Draft' ? t('monthly.plannedBudget') : t('monthly.approvedAllocation')}
        value={formatUsd(plan.status === 'Draft' ? plan.plannedBudget : plan.approvedBudget)} />
      <Fact label={t('monthly.totalSpent')} value={formatUsd(plan.totalSpent)} />
      <Fact label={t('monthly.remainingBalance')}
        value={<span className={plan.remainingBalance < 0 ? 'over-budget' : undefined}>{formatUsd(plan.remainingBalance)}</span>} />
      <Fact label={t('review.completedActivities')} value={`${plan.completedCount}/${plan.activityCount}`} />
      <Fact label={t('review.expensesWithoutEvidence')} value={plan.expensesWithoutEvidence} />
    </div>
    {plan.notes && <p className="detail-notes">{plan.notes}</p>}

    <h3 className="form-section-title">
      {isDirector ? t('nav.activities') : t('monthly.myActivities')}
    </h3>
    {activities.length ? <div className="table-wrap"><table className="card-table">
      <thead><tr>
        <th>{t('table.activity')}</th><th>{t('field.priority')}</th>
        <th>{t('monthly.approvedAllocation')}</th><th>{t('monthly.totalSpent')}</th>
        <th>{t('expense.remainingOnActivity')}</th><th>{t('monthly.expectedCompletion')}</th>
        <th>{t('table.status')}</th><th>{t('evidence.payment')}</th><th>{t('evidence.activity')}</th><th>{t('table.actions')}</th>
      </tr></thead>
      <tbody>{activities.map((item) => <tr key={item.id}>
        <td className="card-title-cell"><strong>{item.activity}</strong><small>{item.description || categoryLabel(item.category, t)}</small></td>
        <td data-label={t('field.priority')}>{t(`form.priority${item.priority}`)}</td>
        <td data-label={t('monthly.approvedAllocation')}>{formatUsd(item.approvedBudget)}</td>
        <td data-label={t('monthly.totalSpent')}>{formatUsd(item.spent)}</td>
        <td data-label={t('expense.remainingOnActivity')} className={item.remaining < 0 ? 'over-budget' : undefined}>{formatUsd(item.remaining)}</td>
        <td data-label={t('monthly.expectedCompletion')}>{formatDate(item.deadline, language)}</td>
        <td data-label={t('table.status')}><span className={`status-badge ${journeyTone(activityJourney(item))}`}>
          {journeyLabel(activityJourney(item), t)}
        </span></td>
        <td data-label={t('evidence.payment')} className={item.expensesWithoutEvidence ? 'over-budget' : undefined}>
          {item.expenseCount - item.expensesWithoutEvidence}/{item.expenseCount}
        </td>
        <td data-label={t('evidence.activity')} className={item.status === 'Completed' && !item.activityEvidenceCount ? 'over-budget' : undefined}>
          {item.activityEvidenceCount}
        </td>
        {/* Expenses and evidence are recorded on the activity itself. */}
        <td className="card-actions"><a className="text-btn" href={`#/activities/${encodeURIComponent(item.id)}`}>{t('action.open')}</a></td>
      </tr>)}</tbody>
    </table></div> : <div className="empty-state">
      <strong>{t('monthly.noActivitiesInPlan')}</strong><span>{t('table.noData')}</span>
    </div>}
    {activities.length > 0 && <>
      <div className="totals-line">
        <span>{plan.status === 'Draft' ? t('monthly.totalToGive') : t('monthly.totalApprovedBudget')}: <strong>{formatUsd(plan.status === 'Draft' ? plan.plannedBudget : plan.approvedBudget)}</strong></span>
        <span>{t('monthly.totalSpent')}: <strong>{formatUsd(plan.totalSpent)}</strong></span>
        <span>{t('monthly.remainingBalance')}: <strong className={plan.remainingBalance < 0 ? 'over-budget' : undefined}>{formatUsd(plan.remainingBalance)}</strong></span>
      </div>
      {/* The month adds up records agreed at different times, so the local
          currencies here are at today's rate rather than any one record's. */}
      {rate?.rwfPerUsd > 0 && <p className="field-hint">
        {t('money.todayRate')}: {formatLocal((plan.status === 'Draft' ? plan.plannedBudget : plan.approvedBudget) * rate.rwfPerUsd, 'RWF')}
        {' · '}{formatLocal((plan.status === 'Draft' ? plan.plannedBudget : plan.approvedBudget) * rate.cdfPerUsd, 'CDF')}
        {' · '}{t('monthly.remainingBalance')}: {formatLocal(plan.remainingBalance * rate.rwfPerUsd, 'RWF')} · {formatLocal(plan.remainingBalance * rate.cdfPerUsd, 'CDF')}
      </p>}
    </>}

    {/* Section 2: the Director confirms the plan, which records the allocation
        and nothing else. The wording on the button says so. */}
    {isDirector && plan.status === 'Draft' && <div className="visibility-control">
      <div>
        <span className="eyebrow">{t('monthly.totalToGive')}</span>
        <strong>{formatUsd(plan.plannedBudget)}</strong>
        <small>{t('monthly.confirmHint')}</small>
      </div>
      <button className="primary-btn" type="button" disabled={busy || !activities.length || !plan.managerId}
        onClick={() => onConfirm(plan)}>{t('monthly.confirmPlan')}</button>
    </div>}
    {isDirector && plan.status !== 'Draft' && <div className="button-row">
      <button className="secondary-btn" type="button" disabled={busy} onClick={() => onReopen(plan)}>{t('monthly.reopen')}</button>
    </div>}

    {/* Section 10: who runs the month, and what the Director noted about it. */}
    {isDirector && open && <form className="decision-form" onSubmit={(event) => {
      event.preventDefault();
      if (hasSettingsChanges) onUpdatePlan(plan, settingsChanges);
    }}>
      <h3 className="form-section-title">{t('monthly.planSettings')}</h3>
      <div className="form-grid">
        <label className="form-field"><span>{t('monthly.responsibleManager')}</span>
          <select value={settings.managerId} onChange={(event) => setSettings({ ...settings, managerId: event.target.value })}>
            <option value="">{t('form.selectManager')}</option>
            {operationManagers.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}
          </select>
        </label>
        <label className="form-field form-field-wide"><span>{t('field.notes')}</span>
          <textarea rows="2" value={settings.notes} onChange={(event) => setSettings({ ...settings, notes: event.target.value })} />
        </label>
      </div>
      {settingsChanges.managerId !== undefined && <p className="decision-hint">{t('monthly.managerChangeHint')}</p>}
      <div className="form-submit-bar"><button className="secondary-btn" type="submit" disabled={busy || !hasSettingsChanges}>{t('movement.saveChanges')}</button></div>
    </form>}

    {/* Section 1: the Director builds the month's activities. */}
    {isDirector && open && <form className="decision-form" onSubmit={onAddActivity}>
      <h3 className="form-section-title">{t('monthly.addActivity')}</h3>
      <div className="form-grid">
        <label className="form-field"><span>{t('field.activity')}</span>
          <input required maxLength="200" value={activityForm.activity} onChange={(event) => setActivityForm({ ...activityForm, activity: event.target.value })} />
        </label>
        <label className="form-field"><span>{t('field.category')}</span>
          <input required maxLength="100" value={activityForm.category} onChange={(event) => setActivityForm({ ...activityForm, category: event.target.value })} />
        </label>
        <label className="form-field"><span>{t('monthly.approvedAllocation')} (USD)</span>
          <input required type="number" inputMode="decimal" min="0" step="0.01" value={activityForm.approvedBudget}
            onChange={(event) => setActivityForm({ ...activityForm, approvedBudget: event.target.value })} />
        </label>
        <label className="form-field"><span>{t('field.priority')}</span>
          <select value={activityForm.priority} onChange={(event) => setActivityForm({ ...activityForm, priority: event.target.value })}>
            {PRIORITIES.map((priority) => <option key={priority} value={priority}>{t(`form.priority${priority}`)}</option>)}
          </select>
        </label>
        <label className="form-field"><span>{t('monthly.expectedCompletion')}</span>
          <input type="date" value={activityForm.deadline} onChange={(event) => setActivityForm({ ...activityForm, deadline: event.target.value })} />
        </label>
        <label className="form-field form-field-wide"><span>{t('field.description')}</span>
          <input value={activityForm.description} onChange={(event) => setActivityForm({ ...activityForm, description: event.target.value })} />
        </label>
        <label className="form-field form-field-wide"><span>{t('review.adminNote')}</span>
          <input value={activityForm.adminNote} onChange={(event) => setActivityForm({ ...activityForm, adminNote: event.target.value })} />
        </label>
      </div>
      <div className="form-submit-bar"><button className="primary-btn" type="submit" disabled={busy}>{t('monthly.addActivity')}</button></div>
    </form>}

    {/* Section 4: approved work the Director may fold into this month. */}
    {isDirector && open && offPlanActivities.length > 0 && <>
      <h3 className="form-section-title">{t('monthly.attachActivity')}</h3>
      <p className="detail-notes muted-cell">{t('monthly.offPlanHint')}</p>
      <div className="table-wrap"><table className="card-table">
        <thead><tr>
          <th>{t('table.activity')}</th><th>{t('table.createdBy')}</th>
          <th>{t('monthly.approvedAllocation')}</th><th>{t('table.actions')}</th>
        </tr></thead>
        <tbody>{offPlanActivities.map((item) => <tr key={item.id}>
          <td className="card-title-cell"><strong>{item.activity}</strong><small>{categoryLabel(item.category, t)}</small></td>
          <td data-label={t('table.createdBy')}>{item.createdByName || '—'}</td>
          <td data-label={t('monthly.approvedAllocation')}>{formatUsd(item.approvedBudget ?? item.requestedBudget)}</td>
          <td className="card-actions"><button className="secondary-btn compact" type="button" disabled={busy} onClick={() => onAttach(plan, item)}>
            {t('monthly.attachActivity')}
          </button></td>
        </tr>)}</tbody>
      </table></div>
    </>}

    {/* Section 11: the manager's account of the month. */}
    <h3 className="form-section-title">{t('monthend.title')}</h3>
    {report ? <>
      <div className="detail-facts">
        <Fact label={t('table.status')} value={<span className={`status-badge ${report.status === 'Accepted' ? 'tone-done' : report.status === 'Returned' ? 'tone-stopped' : 'tone-waiting'}`}>
          {t(`monthend.status.${report.status}`)}
        </span>} />
        <Fact label={t('monthly.approvedAllocation')} value={formatUsd(report.approvedBudget)} />
        <Fact label={t('monthly.totalSpent')} value={formatUsd(report.totalSpent)} />
        <Fact label={t('monthly.remainingBalance')} value={formatUsd(report.remainingBalance)} />
        <Fact label={t('review.completedActivities')} value={report.completedActivities} />
        <Fact label={t('review.pendingActivities')} value={report.incompleteActivities} />
        <Fact label={t('evidence.payment')} value={report.paymentEvidenceCount} />
        <Fact label={t('evidence.activity')} value={report.activityEvidenceCount} />
      </div>
      {report.unusedBalanceExplanation && <p className="detail-notes">
        <strong>{t('monthend.unusedBalance')}:</strong> {report.unusedBalanceExplanation}
      </p>}
      {report.budgetDifferenceExplanation && <p className="detail-notes">
        <strong>{t('monthend.budgetDifference')}:</strong> {report.budgetDifferenceExplanation}
      </p>}
      {report.reviewNote && <p className="detail-notes admin-note">&ldquo;{report.reviewNote}&rdquo;</p>}
      {isDirector && report.status === 'Submitted' && plan.status !== 'Closed' && <div className="button-row">
        <button className="primary-btn" type="button" disabled={busy} onClick={() => onDecideReport(plan, 'Accepted')}>{t('monthend.accept')}</button>
        <button className="danger-btn outlined" type="button" disabled={busy} onClick={() => onDecideReport(plan, 'Returned')}>{t('monthend.return')}</button>
      </div>}
    </> : <p className="detail-notes muted-cell">{t('monthend.notSubmitted')}</p>}

    {isPlanManager && plan.status === 'Confirmed' && (!report || report.status === 'Returned') && <form
      className="decision-form"
      onSubmit={(event) => {
        event.preventDefault();
        Promise.resolve(onSubmitReport(plan, explanations)).then((filed) => {
          if (filed) setExplanations({ unusedBalanceExplanation: '', budgetDifferenceExplanation: '' });
        });
      }}
    >
      <div className="form-grid">
        <label className="form-field form-field-wide"><span>{t('monthend.unusedBalance')}</span>
          <textarea rows="2" value={explanations.unusedBalanceExplanation}
            onChange={(event) => setExplanations({ ...explanations, unusedBalanceExplanation: event.target.value })} />
        </label>
        <label className="form-field form-field-wide"><span>{t('monthend.budgetDifference')}</span>
          <textarea rows="2" value={explanations.budgetDifferenceExplanation}
            onChange={(event) => setExplanations({ ...explanations, budgetDifferenceExplanation: event.target.value })} />
        </label>
      </div>
      <div className="form-submit-bar"><button className="primary-btn" type="submit" disabled={busy}>{t('monthend.submit')}</button></div>
    </form>}

    <h3 className="form-section-title">{t('monthly.planHistory')}</h3>
    {history.length ? <ul className="history-list">{history.map((entry) => <li key={entry.id}>
      <strong>{trailActionLabel(entry.action, t)}</strong>
      {entry.field && <span> {planTrailValue(entry.field, entry.oldValue, t)} &rarr; {planTrailValue(entry.field, entry.newValue, t)}</span>}
      <small>{entry.actorName} · {new Date(entry.createdAt).toLocaleString(language)}</small>
      {entry.note && <small className="justification">{entry.note}</small>}
    </li>)}</ul> : <div className="empty-state"><strong>{t('empty.noHistory')}</strong><span>{t('empty.noHistoryHint')}</span></div>}
  </section>;
}

function Metric({ label, value }) {
  return <div className="metric-card"><span>{label}</span><strong>{value}</strong></div>;
}

function Fact({ label, value }) {
  return <div className="fact"><span>{label}</span><strong>{value}</strong></div>;
}

// ---- recording an expense --------------------------------------------------

// Section 5, 6 and 8, as it appears on the activity review screen. The remaining
// balance is shown before the manager types, and the block is explained in the
// same words the API uses when it refuses.
//
// The receipt is taken with the expense, in the same form: a photo from the
// camera or a file. Recording the spend and then scrolling to a separate upload
// form, and linking the two by hand, took two screens and most receipts were
// left unlinked.
export function ExpensePanel({ expenses, summary, canRecord, onRecord, onRemoveExpense, canRemove, busy = false, showSummary = true }) {
  const { language, t } = useI18n();
  const [form, setForm] = useState({
    amount: '', spentOn: todayLocal(),
    paymentMethod: 'Cash', description: ''
  });
  const [receipts, setReceipts] = useState([]);

  // A failed summary is not a zero balance: without one nothing is presumed
  // over budget, and the API remains the judge of the spend.
  const known = summary !== null && summary !== undefined;
  const remaining = summary?.remaining ?? 0;
  const typed = Number(form.amount || 0);
  // Warned before submitting, refused by the API regardless.
  const overBudget = known && typed > 0 && Math.round(typed * 100) > Math.round(remaining * 100);

  return <>
    {showSummary && <>
      <h3 className="form-section-title">{t('expense.title')}</h3>
      <div className="detail-facts">
        <Fact label={t('monthly.approvedAllocation')} value={known ? formatUsd(summary.approvedBudget) : '—'} />
        <Fact label={t('monthly.totalSpent')} value={known ? formatUsd(summary.totalSpent) : '—'} />
        <Fact label={t('expense.remainingOnActivity')}
          value={known ? <span className={remaining < 0 ? 'over-budget' : undefined}>{formatUsd(remaining)}</span> : '—'} />
      </div>
    </>}

    {expenses.length ? <div className="table-wrap"><table className="card-table">
      <thead><tr>
        <th>{t('field.description')}</th><th>{t('expense.dateSpent')}</th>
        <th>{t('expense.paymentMethod')}</th><th>{t('expense.amountSpent')}</th>
        <th>{t('evidence.payment')}</th><th>{t('expense.recordedBy')}</th>
        {canRemove && <th>{t('table.actions')}</th>}
      </tr></thead>
      <tbody>{expenses.map((expense) => <tr key={expense.id}>
        <td className="card-title-cell"><strong>{expense.description}</strong></td>
        <td data-label={t('expense.dateSpent')}>{formatDate(expense.spentOn, language)}</td>
        <td data-label={t('expense.paymentMethod')}>{t(`pmethod.${expense.paymentMethod}`)}</td>
        <td data-label={t('expense.amountSpent')}>{formatUsd(expense.amount)}</td>
        <td data-label={t('evidence.payment')} className={expense.evidenceCount ? undefined : 'over-budget'}>
          {expense.evidenceCount || t('expense.noEvidence')}
        </td>
        <td data-label={t('expense.recordedBy')}>{expense.recordedByName || '—'}</td>
        {canRemove && <td className="card-actions">
          <button className="danger-btn" type="button" disabled={busy} onClick={() => onRemoveExpense(expense)}>{t('action.remove')}</button>
        </td>}
      </tr>)}</tbody>
    </table></div> : <div className="empty-state">
      <strong>{t('expense.none')}</strong><span>{t('expense.noneHint')}</span>
    </div>}

    {canRecord && <form className="decision-form" onSubmit={(event) => {
      event.preventDefault();
      onRecord({ ...form, amount: Number(form.amount || 0) }, () => {
        setForm((current) => ({ ...current, amount: '', description: '' }));
        setReceipts([]);
      }, receipts);
    }}>
      <h3 className="form-section-title">{t('expense.record')}</h3>
      {known && <p className="field-hint">{fill(t('expense.leftToSpend'), { amount: formatUsd(remaining) })}</p>}
      <div className="form-grid">
        <label className="form-field"><span>{t('expense.amountSpent')} (USD)</span>
          <input required type="number" inputMode="decimal" min="0.01" step="0.01" value={form.amount}
            onChange={(event) => setForm({ ...form, amount: event.target.value })} />
        </label>
        <label className="form-field"><span>{t('field.description')}</span>
          <input required value={form.description} placeholder={t('expense.descriptionPlaceholder')} onChange={(event) => setForm({ ...form, description: event.target.value })} />
        </label>
        <label className="form-field"><span>{t('expense.dateSpent')}</span>
          <input required type="date" max={todayLocal()} value={form.spentOn} onChange={(event) => setForm({ ...form, spentOn: event.target.value })} />
        </label>
        <label className="form-field"><span>{t('expense.paymentMethod')}</span>
          <select value={form.paymentMethod} onChange={(event) => setForm({ ...form, paymentMethod: event.target.value })}>
            {PAYMENT_METHODS.map((method) => <option key={method} value={method}>{t(`pmethod.${method}`)}</option>)}
          </select>
        </label>
      </div>
      <div className="receipt-field">
        <span className="receipt-label">{t('expense.receipt')} ({t('field.optional')})</span>
        <FilePicker files={receipts} onChange={setReceipts} disabled={busy} />
      </div>
      {overBudget && <p className="decision-hint over-budget">{t('expense.overBudget')} <a href="#budget-requests" onClick={(event) => { event.preventDefault(); document.getElementById('budget-requests')?.scrollIntoView({ behavior: 'smooth' }); }}>{t('budget.request')}</a></p>}
      <div className="form-submit-bar"><button className="primary-btn" type="submit" disabled={busy || overBudget}>{t('expense.record')}</button></div>
    </form>}
  </>;
}
