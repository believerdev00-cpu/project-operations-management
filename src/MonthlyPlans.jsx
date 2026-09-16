import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BUSINESS_OPERATIONS, operationName } from '../shared/businessOperations.js';
import { OTHER_CATEGORY, categoriesForOperation } from '../shared/categories.js';
import { fill, useI18n } from './i18n.js';
import { EvidenceList, EvidenceUpload, categoryLabel, trailActionLabel } from './ActivityReview.jsx';
import { DetailView, useBusy, useDialog } from './ui.jsx';
import { FilePicker, activityJourney, formatLocal, journeyLabel, journeyTone, nextAction } from './journey.jsx';

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

// A month starts empty: the Director names the operation and the manager, states
// the budget they are approving, and says what the month is for.
const emptyPlan = { operation: '', managerId: '', approvedBudget: '', category: '', objective: '' };

// A day of the manager's work towards a planned activity.
const emptyWork = {
  activity: '', description: '', scheduledFor: '', assignedTo: '', budget: '',
  evidenceRequired: true, notes: ''
};

export function formatUsd(value) {
  const amount = Number(value || 0);
  const digits = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(amount));
  return `${amount < 0 ? '-' : ''}$${digits}`;
}

function monthEnd(month) {
  const [year, index] = String(month || '').split('-').map(Number);
  if (!year || !index) return undefined;
  // Day 0 of the next month is the last day of this one, and passing month index
  // 12 to the constructor rolls into January correctly.
  const last = new Date(year, index, 0).getDate();
  return `${month}-${String(last).padStart(2, '0')}`;
}

function formatDate(value, language) {
  if (!value) return '—';
  const [year, month, day] = String(value).slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return '—';
  return new Date(year, month - 1, day).toLocaleDateString(language);
}

// The day a person has to turn up and do the work, written so it cannot be read
// as another day: "Sun 5 Apr" rather than 4/5/2098, which is April 5th in one
// country and May 4th in the next. The month is on the heading above it, so the
// year is left off.
function formatWorkDay(value, language) {
  if (!value) return '—';
  const [year, month, day] = String(value).slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return '—';
  return new Date(year, month - 1, day).toLocaleDateString(language, { weekday: 'short', day: 'numeric', month: 'short' });
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
  user, fetchJson, upload, onOpenFile, managers, people = [], rate = null, onStartWork, onOpenActivity,
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
  const [newPlan, setNewPlan] = useState(emptyPlan);
  const [activityForm, setActivityForm] = useState(emptyActivity);
  // The day-by-day work the manager is assigning, keyed by the planned activity
  // it belongs to -- so two forms open at once cannot write into each other.
  const [workForms, setWorkForms] = useState({});
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
          body: JSON.stringify({
            operation: chosenOperation, month, managerId: newPlan.managerId || null,
            // The budget the Director approves for the month. Everything the
            // manager does afterwards has to fit inside it.
            approvedBudget: newPlan.approvedBudget === '' ? 0 : Number(newPlan.approvedBudget),
            category: newPlan.category === OTHER_CATEGORY ? '' : newPlan.category,
            objective: newPlan.objective
          })
        });
        onMessage(fill(t('msg.planCreated'), { operation: operationName(plan.operation, language), month: monthLabel(month, language) }));
        setNewPlan(emptyPlan);
        await load();
        onChanged?.();
        onOpenPlan?.(plan.id);
      } catch (createError) { onError(createError.message); }
    });
  };

  // The manager assigns a day of work towards a planned activity. The server
  // holds it to the planned activity's remaining budget and to the plan's own
  // month, and answers with the whole month again -- so the figures on screen are
  // the ones the write landed against rather than a guess made here.
  const addWork = (activity, form) => {
    run(async () => {
      try {
        const result = await fetchJson(`/api/monthly-plans/${openPlanId}/activities/${encodeURIComponent(activity.id)}/work`, {
          method: 'POST',
          body: JSON.stringify({
            activity: form.activity,
            description: form.description,
            scheduledFor: form.scheduledFor,
            assignedTo: form.assignedTo || null,
            budget: form.budget === '' ? 0 : Number(form.budget),
            evidenceRequired: form.evidenceRequired,
            notes: form.notes
          })
        });
        setWorkForms((current) => ({ ...current, [activity.id]: emptyWork }));
        setDetail({ plan: result.plan, activities: result.activities, history: result.history, report: result.report });
        onMessage(fill(t('msg.workAssigned'), { activity: activity.activity }));
        await load();
        onChanged?.();
      } catch (workError) { onError(workError.message); }
    });
  };

  // The manager gets on with the work the Director planned, from the plan
  // itself. The record screen has always allowed this; the month did not show it,
  // so the only thing a manager could see to do with their own plan was hand a
  // day of it to somebody else.
  // Re-read the month after anything the workspace changed, so the figures on
  // the card and at the top of the page move with the work.
  const reloadMonth = useCallback(async () => {
    if (openPlanId) await loadPlan(openPlanId);
    await load();
    onChanged?.();
  }, [openPlanId, loadPlan, load, onChanged]);

  const startPlannedWork = (activity) => {
    run(async () => {
      const moved = await onStartWork?.(activity);
      if (moved === false) return;
      if (openPlanId) await loadPlan(openPlanId);
      await load();
      onChanged?.();
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
      message: `${t('monthly.confirmHint')} ${t('monthly.totalToGive')}: ${formatUsd(plan.approvedBudget)}`,
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
      <div className="metric-grid metric-grid-6">
        <Metric label={t('monthly.approvedAllocation')} value={formatUsd(review.totals.approvedBudget)} />
        <Metric label={t('monthly.committed')} value={formatUsd(review.totals.committedBudget)} />
        <Metric label={t('monthly.totalSpent')} value={formatUsd(review.totals.totalSpent)} />
        <Metric label={t('monthly.remainingBalance')} value={formatUsd(review.totals.remainingBalance)} />
        <Metric label={t('review.completedActivities')} value={`${review.totals.completed}/${review.totals.activities}`} />
        <Metric label={t('monthly.workDone')} value={review.totals.work ? `${review.totals.workCompleted}/${review.totals.work}` : '—'} />
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
            <th>{t('monthly.approvedAllocation')}</th><th className="card-optional">{t('monthly.committed')}</th>
            <th>{t('monthly.totalSpent')}</th>
            <th>{t('monthly.remainingBalance')}</th><th>{t('review.completedActivities')}</th>
            <th className="card-optional">{t('monthly.workDone')}</th>
            <th className="card-optional">{t('review.expensesWithoutEvidence')}</th>
            <th className="card-optional">{t('review.missingEvidence')}</th>
            <th>{t('table.status')}</th><th>{t('table.actions')}</th>
          </tr></thead>
          <tbody>{review.operations.map((plan) => <tr key={plan.id} className={plan.id === openPlanId ? 'row-selected' : undefined}>
            <td className="card-title-cell"><strong>{operationName(plan.operation, language)}</strong></td>
            <td data-label={t('field.manager')}>{plan.managerName || <span className="muted-cell">{t('table.unassigned')}</span>}</td>
            <td data-label={t('monthly.approvedAllocation')}>{formatUsd(plan.approvedBudget)}</td>
            <td className="card-optional" data-label={t('monthly.committed')}>{formatUsd(plan.committedBudget)}</td>
            <td data-label={t('monthly.totalSpent')}>{formatUsd(plan.totalSpent)}</td>
            <td data-label={t('monthly.remainingBalance')} className={plan.remainingBalance < 0 ? 'over-budget' : undefined}>{formatUsd(plan.remainingBalance)}</td>
            <td data-label={t('review.completedActivities')}>{plan.completedCount}/{plan.activityCount}</td>
            <td className="card-optional" data-label={t('monthly.workDone')}>{plan.workCount ? `${plan.workCompletedCount}/${plan.workCount}` : '—'}</td>
            <td data-label={t('review.expensesWithoutEvidence')} className={plan.expensesWithoutEvidence ? 'card-optional over-budget' : 'card-optional'}>
              {plan.expenseCount - plan.expensesWithoutEvidence}/{plan.expenseCount} {t('review.documented')}
            </td>
            <td data-label={t('review.missingEvidence')} className={plan.completedWithoutEvidence ? 'card-optional over-budget' : 'card-optional'}>
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
            <select required value={newPlan.managerId} onChange={(event) => setNewPlan({ ...newPlan, operation: chosenOperation, managerId: event.target.value })}>
              <option value="">{t('form.selectManager')}</option>
              {managerOptions.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}
            </select>
          </label>
          {/* The figure the Director approves for the month. It used to be
              worked out from the activities when the plan was confirmed, so
              nobody ever stated one and the month had no limit. */}
          <label className="form-field"><span>{t('monthly.budgetYouApprove')}</span>
            <input required type="number" inputMode="decimal" min="0" step="0.01" placeholder={t('monthly.budgetPlaceholder')}
              value={newPlan.approvedBudget}
              onChange={(event) => setNewPlan({ ...newPlan, approvedBudget: event.target.value })} />
            {Number(newPlan.approvedBudget) > 0 && rate && <small className="field-hint">
              {t('money.todayRate')}: {formatLocal(Number(newPlan.approvedBudget) * rate.rwfPerUsd, 'RWF')}
              {' · '}{formatLocal(Number(newPlan.approvedBudget) * rate.cdfPerUsd, 'CDF')}
            </small>}
          </label>
          <label className="form-field"><span>{t('monthly.businessCategory')}</span>
            <select value={newPlan.category} onChange={(event) => setNewPlan({ ...newPlan, category: event.target.value })}>
              <option value="">{t('form.selectCategory')}</option>
              {categoriesForOperation(chosenOperation).map((category) =>
                <option key={category} value={category}>{categoryLabel(category, t)}</option>)}
            </select>
          </label>
          <label className="form-field form-field-wide"><span>{t('monthly.objectives')}</span>
            <textarea rows="2" placeholder={t('monthly.objectivesPlaceholder')} value={newPlan.objective}
              onChange={(event) => setNewPlan({ ...newPlan, objective: event.target.value })} />
          </label>
        </div>
        <p className="field-hint">{t('monthly.createHint')}</p>
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
        people={people}
        rate={rate}
        activityForm={activityForm}
        setActivityForm={setActivityForm}
        workForms={workForms}
        setWorkForms={setWorkForms}
        onAddWork={addWork}
        onStartWork={startPlannedWork}
        onOpenActivity={onOpenActivity}
        fetchJson={fetchJson}
        upload={upload}
        onOpenFile={onOpenFile}
        onReload={reloadMonth}
        onError={onError}
        onMessage={onMessage}
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

// The workspace: the Director's own planned activity, opened for work.
//
// THE POINT OF IT: the manager executes the activity the Director planned. There
// is no second record, no "work request", nothing created when they press Work --
// the same row gains a progress figure, what was actually done, the days it took,
// its expenses and its photos. So the Director reviewing the month afterwards is
// looking at the thing they planned, with the doing of it attached.
//
// It opens inside the card. Nothing about the address, the sidebar or the page
// changes, because leaving the month to record a day's work was the thing that
// made the month feel like somebody else's screen.
//
// Everything below reuses what already exists: GET /api/activities/:id for the
// record, ExpensePanel for the spending, EvidenceUpload/EvidenceList for the
// photos, and the completion route for finishing. Only the progress fields are
// new, and they are columns on the activity, not a system of their own.
function Workspace({ activity, plan, user, t, language, busy, fetchJson, upload, onOpenFile, onChanged, onError, onMessage }) {
  // Once a planned activity has days of work under it, the money and the photos
  // belong to the days -- the expense route refuses the heading, which is what
  // stops the same budget appearing to be available twice.
  const hasDays = Number(activity.workCount) > 0;
  const [detail, setDetail] = useState(null);
  const [failed, setFailed] = useState(false);
  const [form, setForm] = useState(null);
  const dialog = useDialog();
  // Each load is numbered so a slow answer for a card opened earlier cannot
  // overwrite the one the reader is looking at now.
  const latest = useRef(0);

  const load = useCallback(async () => {
    const request = ++latest.current;
    try {
      const [result, money] = await Promise.all([
        fetchJson(`/api/activities/${encodeURIComponent(activity.id)}`),
        fetchJson(`/api/activities/${encodeURIComponent(activity.id)}/expenses`)
      ]);
      if (request !== latest.current) return;
      setDetail({ ...result, ...money });
      setFailed(false);
      setForm({
        progress: String(result.activity.progress ?? 0),
        workPerformed: result.activity.workPerformed || '',
        daysWorked: result.activity.daysWorked ? String(result.activity.daysWorked) : '',
        managerNote: result.activity.managerNote || ''
      });
    } catch (loadError) {
      if (request !== latest.current) return;
      setFailed(true);
      onError(loadError.message);
    }
  }, [fetchJson, activity.id, onError]);

  useEffect(() => { load(); }, [load]);

  if (failed) return <div className="workspace"><p className="planned-empty">{t('work.couldNotOpen')}</p></div>;
  if (!detail || !form) return <div className="workspace"><p className="planned-empty">{t('app.loading')}</p></div>;

  const record = detail.activity;
  const expenses = detail.expenses || [];
  const evidence = detail.evidence || [];
  // The API is the judge of the money: its own totals rather than a sum worked
  // out here, which could disagree with what the spend check enforces.
  const spent = detail.totalSpent ?? 0;
  const remaining = detail.remaining ?? Math.round(((detail.approvedBudget ?? 0) - spent) * 100) / 100;
  const open = plan.status !== 'Closed';
  const live = !['Completed', 'Rejected', 'Cancelled'].includes(record.status);
  const handedBack = Boolean(record.completionSubmittedAt) && record.status !== 'Completed';
  const canWork = open && live && !handedBack;

  const changed = form.progress !== String(record.progress ?? 0)
    || form.workPerformed.trim() !== (record.workPerformed || '')
    || (form.daysWorked === '' ? 0 : Number(form.daysWorked)) !== Number(record.daysWorked || 0)
    || form.managerNote.trim() !== (record.managerNote || '');

  const saveProgress = async () => {
    try {
      await fetchJson(`/api/activities/${encodeURIComponent(record.id)}/progress`, {
        method: 'PATCH',
        body: JSON.stringify({
          progress: Number(form.progress || 0),
          workPerformed: form.workPerformed,
          daysWorked: form.daysWorked === '' ? 0 : Number(form.daysWorked),
          managerNote: form.managerNote
        })
      });
      onMessage(t('work.saved'));
      await load();
      await onChanged();
    } catch (saveError) { onError(saveError.message); }
  };

  const recordExpense = async (payload, reset, receipts) => {
    try {
      const saved = await fetchJson(`/api/activities/${encodeURIComponent(record.id)}/expenses`, {
        method: 'POST', body: JSON.stringify(payload)
      });
      // The receipt is attached to the expense it belongs to, exactly as the
      // record screen does it, so the Director sees the two together.
      for (const file of receipts || []) {
        const data = new FormData();
        data.append('kind', 'Receipt');
        data.append('evidenceType', 'payment');
        data.append('expenseId', String(saved.expense.id));
        data.append('files', file);
        await upload(`/api/activities/${encodeURIComponent(record.id)}/evidence`, data);
      }
      onMessage(fill(t('msg.expenseRecorded'), {
        amount: formatUsd(payload.amount),
        remaining: formatUsd(Math.round((remaining - Number(payload.amount || 0)) * 100) / 100)
      }));
      reset?.();
      await load();
      await onChanged();
      return true;
    } catch (expenseError) { onError(expenseError.message); return false; }
  };

  const uploadEvidence = async (formData) => {
    try {
      await upload(`/api/activities/${encodeURIComponent(record.id)}/evidence`, formData);
      onMessage(t('work.evidenceAdded'));
      await load();
      await onChanged();
      return true;
    } catch (uploadError) { onError(uploadError.message); return false; }
  };

  const markCompleted = async () => {
    const note = await dialog.prompt({
      title: t('work.markCompleted'),
      message: record.activity,
      label: t('review.noteForDirector'),
      multiline: true,
      confirmLabel: t('work.markCompleted')
    });
    if (note === null) return;
    try {
      await fetchJson(`/api/activities/${encodeURIComponent(record.id)}/completion`, {
        method: 'POST', body: JSON.stringify({ note })
      });
      onMessage(t('work.sentForCheck'));
      await load();
      await onChanged();
    } catch (finishError) { onError(finishError.message); }
  };

  return <div className="workspace">
    <h4>{t('work.workspace')}</h4>

    {handedBack && <p className="workspace-waiting">{t('work.waitingForDirector')}</p>}
    {record.status === 'Needs Correction' && <p className="workspace-waiting">
      {record.adminNote || t('review.sentBackToYou')}
    </p>}

    <div className="form-grid">
      <label className="form-field form-field-wide"><span>{t('work.progress')}</span>
        {/* A slider, because a percentage is the one number people guess at and
            typing it on a phone keyboard is the slowest way to say "about half". */}
        <span className="progress-row">
          <input type="range" min="0" max="100" step="5" value={form.progress} disabled={!canWork}
            onChange={(event) => setForm({ ...form, progress: event.target.value })} />
          <strong>{form.progress}%</strong>
        </span>
      </label>
      <label className="form-field form-field-wide"><span>{t('work.workPerformed')}</span>
        <textarea rows="3" placeholder={t('work.workPerformedHint')} value={form.workPerformed} disabled={!canWork}
          onChange={(event) => setForm({ ...form, workPerformed: event.target.value })} />
      </label>
      <label className="form-field"><span>{t('work.daysWorked')}</span>
        <input type="number" inputMode="decimal" min="0" step="0.5" value={form.daysWorked} disabled={!canWork}
          onChange={(event) => setForm({ ...form, daysWorked: event.target.value })} />
      </label>
      <label className="form-field form-field-wide"><span>{t('work.notes')}</span>
        <textarea rows="2" placeholder={t('work.notesHint')} value={form.managerNote} disabled={!canWork}
          onChange={(event) => setForm({ ...form, managerNote: event.target.value })} />
      </label>
    </div>

    {canWork && <div className="workspace-actions">
      <button type="button" className="primary-btn" disabled={busy || !changed} onClick={saveProgress}>
        {t('work.saveProgress')}
      </button>
    </div>}

    {/* The money on this activity, recorded here and belonging to it. */}
    <h4>{t('work.money')}</h4>
    <div className="planned-figures">
      <span><small>{t('money.approved')}</small><strong>{formatUsd(detail.approvedBudget ?? 0)}</strong></span>
      <span><small>{t('monthly.totalSpent')}</small><strong>{formatUsd(spent)}</strong></span>
      <span><small>{t('money.left')}</small>
        <strong className={remaining < 0 ? 'over-budget' : undefined}>{formatUsd(remaining)}</strong></span>
    </div>
    {hasDays && <p className="workspace-waiting">{t('work.moneyOnTheDays')}</p>}
    <ExpensePanel
      expenses={expenses}
      summary={{ totalSpent: spent, remaining }}
      canRecord={canWork && !hasDays}
      onRecord={recordExpense}
      canRemove={false}
      busy={busy}
      showSummary={false}
    />

    {/* And the photos and receipts, on the same activity. */}
    <h4>{t('work.evidence')}</h4>
    {canWork && <EvidenceUpload expenses={expenses} busy={busy} onUpload={uploadEvidence} />}
    <EvidenceList activity={record} evidence={evidence} onOpenFile={onOpenFile} canRemove={false} busy={busy} />

    {canWork && <div className="workspace-actions workspace-finish">
      <button type="button" className="secondary-btn" disabled={busy} onClick={markCompleted}>
        {t('work.markCompleted')}
      </button>
      <small>{t('work.markCompletedHint')}</small>
    </div>}
  </div>;
}

// One planned activity, with the days of work underneath it.
//
// This is the screen the whole two-level model exists for. The Director wrote the
// planned activity and its budget; the manager breaks it into the days that will
// finish it; and both of them read the same block -- what was promised, what has
// been given out to the days, what has been spent, and how many of those days are
// done. The Director watching the month is watching this.
function PlannedActivity({
  item, plan, user, t, language, busy, people, canAssignWork, form, setForm, onAddWork, onStart, onOpen,
  isMine, fetchJson, upload, onOpenFile, onReload, onError, onMessage
}) {
  const [open, setOpen] = useState(false);
  // Whether the workspace is open on this card. Held here and nowhere else: no
  // address changes, no sidebar changes, no page changes -- opening the work is
  // opening this card, which is what stopped the month feeling like somebody
  // else's screen the moment there was anything to do in it.
  const [working, setWorking] = useState(false);
  // Giving the work to somebody else is a choice, not the only way in. The form
  // used to be the only thing on a planned activity, so a manager looking at the
  // month the Director had planned for them could not tell that they were simply
  // meant to get on with it -- there was no "start" anywhere, only a form asking
  // them to invent work that had already been planned.
  const [delegating, setDelegating] = useState(false);
  const journey = activityJourney(item);
  const dead = ['Rejected', 'Cancelled'].includes(item.status);
  // Nothing left to give out means no form: an empty form that can only be
  // refused is worse than no form at all.
  const canAssign = canAssignWork && !dead && item.uncommitted > 0;
  // The one thing to do on this activity, from the same rule the record screen
  // and the work cards use. Starting happens here in a tap; anything needing a
  // photo or a figure opens the record, where the form for it lives.
  const step = nextAction({ ...item, monthlyPlanId: plan.id, planStatus: plan.status }, user, t);
  // WORK -> CONTINUE WORK -> COMPLETED. The label follows the activity's own
  // state, so leaving the month and coming back shows the same thing: the state
  // lives on the record, not in this component.
  const finished = item.status === 'Completed';
  const waitingOnDirector = Boolean(item.completionSubmittedAt) && !finished;
  const startedAlready = item.status === 'In Progress' || item.progress > 0
    || item.status === 'Needs Correction';
  let workButton = null;
  if (!isMine) {
    // Not this reader's work: the button belongs to whoever carries it.
    workButton = !step.done
      ? <button type="button" className="primary-btn" onClick={() => onOpen(item.id)}>{step.label}</button>
      : null;
  } else if (finished) {
    workButton = <span className="status-badge tone-done work-done">{t('work.completed')}</span>;
  } else if (waitingOnDirector) {
    workButton = <span className="status-badge tone-waiting">{t('work.withDirector')}</span>;
  } else if (dead) {
    workButton = null;
  } else if (plan.status === 'Draft') {
    // Nothing to work against until the Director confirms the budget.
    workButton = <span className="status-badge tone-waiting">{t('work.waitingForBudget')}</span>;
  } else {
    workButton = <button type="button" className="primary-btn" onClick={() => setWorking((current) => !current)}>
      {working ? t('work.hide') : startedAlready ? t('work.continue') : t('work.start')}
    </button>;
  }

  const missing = [
    !form.activity.trim() && t('table.activity'),
    !form.description.trim() && t('field.description'),
    !form.scheduledFor && t('monthly.dayOfWork')
  ].filter(Boolean);

  return <article className={`planned-activity${dead ? ' planned-activity-dead' : ''}`}>
    <header className="planned-head">
      <div>
        <strong>{item.activity}</strong>
        <small>{categoryLabel(item.category, t)} · {t(`form.priority${item.priority}`)}
          {item.deadline ? ` · ${t('monthly.dueBy')} ${formatWorkDay(item.deadline, language)}` : ''}</small>
      </div>
      {/* "Not started" where the journey would say "Approved". Beside a Start
          button, the reader is asking how far along the work is, not what the
          approval system did to it. */}
      <span className={`status-badge ${journeyTone(journey)}`}>{step.state || journeyLabel(journey, t)}</span>
    </header>
    {item.description && <p className="planned-description">{item.description}</p>}

    {/* The planned activity's own money: what it was given, how much of that is
        promised to the days below, what has actually gone, and what is left. */}
    <div className="planned-figures">
      <span><small>{t('monthly.approvedAllocation')}</small><strong>{formatUsd(item.approvedBudget)}</strong></span>
      <span><small>{t('monthly.givenToWork')}</small><strong>{formatUsd(item.committedToWork)}</strong></span>
      <span><small>{t('monthly.totalSpent')}</small><strong>{formatUsd(item.spent)}</strong></span>
      <span><small>{t('money.left')}</small>
        <strong className={item.remaining < 0 ? 'over-budget' : undefined}>{formatUsd(item.remaining)}</strong></span>
    </div>

    {/* The one button, and for the person the work belongs to it opens the work
        itself rather than sending them somewhere. It is the first thing under the
        money, because "what do I do with this?" is the question somebody opening
        the month is asking. */}
    <div className="planned-do">
      {workButton}
      {canAssign && !delegating && <button type="button" className="secondary-btn" onClick={() => setDelegating(true)}>
        {t('work.addDay')}
      </button>}
    </div>

    {/* The Director's own activity, opened for work, inside this card. */}
    {working && <Workspace
      activity={item}
      plan={plan}
      user={user}
      t={t}
      language={language}
      busy={busy}
      fetchJson={fetchJson}
      upload={upload}
      onOpenFile={onOpenFile}
      onChanged={onReload}
      onError={onError}
      onMessage={onMessage}
    />}

    {/* What the person doing it says about how far along it is. */}
    {(item.progress > 0 || startedAlready) && <div className="planned-progress">
      <div className="planned-progress-bar"><span style={{ width: `${item.progress}%` }} /></div>
      <small>{fill(t('work.percentDone'), { percent: item.progress })}</small>
    </div>}
    {item.daysWorked > 0 && <p className="planned-empty">
      {fill(t('work.daysSoFar'), { days: item.daysWorked })}
    </p>}

    {/* How far along it is, by the days finished underneath it. */}
    {item.workCount > 0 && <div className="planned-progress">
      <div className="planned-progress-bar"><span style={{ width: `${item.workProgress}%` }} /></div>
      <small>{fill(t('monthly.daysDone'), { done: item.workCompletedCount, total: item.workCount })}</small>
    </div>}

    {item.workCount > 0 ? <>
      <button type="button" className="text-btn planned-toggle" onClick={() => setOpen(!open)}>
        {open ? t('monthly.hideWork') : fill(t('work.showDays'), { count: item.workCount })}
      </button>
      {open && <div className="table-wrap"><table className="card-table">
        <thead><tr>
          <th>{t('table.activity')}</th><th>{t('monthly.dayOfWork')}</th><th>{t('field.whoDoesIt')}</th>
          <th>{t('monthly.approvedAllocation')}</th><th>{t('monthly.totalSpent')}</th>
          <th>{t('table.status')}</th><th>{t('evidence.payment')}</th><th>{t('table.actions')}</th>
        </tr></thead>
        <tbody>{item.work.map((day) => <tr key={day.id}>
          <td className="card-title-cell"><strong>{day.activity}</strong><small>{day.description}</small></td>
          <td data-label={t('monthly.dayOfWork')}><strong>{formatWorkDay(day.scheduledFor, language)}</strong></td>
          <td data-label={t('field.whoDoesIt')}>{day.assignedToName || <span className="muted-cell">{t('table.unassigned')}</span>}</td>
          <td data-label={t('monthly.approvedAllocation')}>{formatUsd(day.approvedBudget)}</td>
          <td data-label={t('monthly.totalSpent')}>{formatUsd(day.spent)}</td>
          <td data-label={t('table.status')}><span className={`status-badge ${journeyTone(activityJourney(day))}`}>
            {journeyLabel(activityJourney(day), t)}
          </span></td>
          <td data-label={t('evidence.payment')} className={day.expensesWithoutEvidence ? 'over-budget' : undefined}>
            {day.expenseCount ? `${day.expenseCount - day.expensesWithoutEvidence}/${day.expenseCount}` : '—'}
          </td>
          <td className="card-actions">
            <a className="text-btn" href={`#/activities/${encodeURIComponent(day.id)}`}>{t('action.open')}</a>
          </td>
        </tr>)}</tbody>
      </table></div>}
    </> : <p className="planned-empty">{canAssignWork && delegating ? t('monthly.noWorkYetAssign') : t('monthly.noWorkYet')}</p>}

    {/* The manager's form for giving a day of this work to somebody else, opened
        only when they ask for it. */}
    {canAssign && delegating && <form className="work-form" onSubmit={(event) => { event.preventDefault(); onAddWork(item, form); }}>
      <h4>{t('work.addDay')}</h4>
      <p className="field-hint">{t('work.addDayHint')}</p>
      <div className="form-grid">
        <label className="form-field form-field-wide"><span>{t('table.activity')}</span>
          <input required maxLength="200" placeholder={t('monthly.workPlaceholder')} value={form.activity}
            onChange={(event) => setForm({ ...form, activity: event.target.value })} />
        </label>
        <label className="form-field form-field-wide"><span>{t('field.description')}</span>
          <textarea required rows="2" placeholder={t('monthly.workDescriptionPlaceholder')} value={form.description}
            onChange={(event) => setForm({ ...form, description: event.target.value })} />
        </label>
        {/* The day it happens. The plan's month is the only month it can fall in,
            so the picker is held to it. */}
        <label className="form-field"><span>{t('monthly.dayOfWork')}</span>
          <input required type="date" min={`${plan.month}-01`} max={monthEnd(plan.month)} value={form.scheduledFor}
            onChange={(event) => setForm({ ...form, scheduledFor: event.target.value })} />
        </label>
        <label className="form-field"><span>{t('field.whoDoesIt')}</span>
          <select value={form.assignedTo} onChange={(event) => setForm({ ...form, assignedTo: event.target.value })}>
            <option value="">{t('work.myselfOption')}</option>
            {people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
          </select>
        </label>
        <label className="form-field"><span>{t('monthly.costOfDay')}</span>
          <input type="number" inputMode="decimal" min="0" step="0.01" value={form.budget}
            onChange={(event) => setForm({ ...form, budget: event.target.value })} />
          <small className="field-hint">{fill(t('monthly.leftToGiveOut'), { amount: formatUsd(item.uncommitted) })}</small>
        </label>
        <label className="form-field form-field-wide"><span>{t('field.notes')}</span>
          <input value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
        </label>
        <label className="check-field">
          <input type="checkbox" checked={form.evidenceRequired}
            onChange={(event) => setForm({ ...form, evidenceRequired: event.target.checked })} />
          {t('monthly.evidenceNeeded')}
        </label>
      </div>
      <div className="form-submit-bar">
        {missing.length > 0 && <p className="form-missing">{t('form.stillNeeded')}: {missing.join(', ')}</p>}
        <button className="primary-btn" type="submit" disabled={busy || missing.length > 0}>{t('monthly.assignWork')}</button>
      </div>
    </form>}

    <a className="text-btn planned-open" href={`#/activities/${encodeURIComponent(item.id)}`}>{t('monthly.openFullRecord')}</a>
    {step.done && canAssign && !delegating && <button type="button" className="secondary-btn" onClick={() => setDelegating(true)}>
      {t('work.addDay')}
    </button>}
  </article>;
}

function PlanDetail({
  detail, user, isDirector, language, t, busy, managers = [], people = [], rate = null, activityForm, setActivityForm,
  workForms = {}, setWorkForms, onAddWork, onStartWork, onOpenActivity,
  fetchJson, upload, onOpenFile, onReload, onError, onMessage,
  onAddActivity, onConfirm, onReopen, onSubmitReport, onDecideReport, onClose, onAttach, onUpdatePlan, offPlanActivities = []
}) {
  const { plan, activities, history, report } = detail;
  const [explanations, setExplanations] = useState({
    unusedBalanceExplanation: '', budgetDifferenceExplanation: ''
  });
  const planSettings = (source) => ({
    managerId: source.managerId ? String(source.managerId) : '',
    notes: source.notes || '',
    category: source.category || '',
    objective: source.objective || '',
    approvedBudget: String(source.approvedBudget ?? '')
  });
  const [settings, setSettings] = useState(() => planSettings(plan));

  // Re-read after a save, so the form shows what was actually stored.
  useEffect(() => {
    setSettings(planSettings(plan));
  }, [plan.managerId, plan.notes, plan.category, plan.objective, plan.approvedBudget]);

  const isPlanManager = !isDirector && plan.managerId === user.id;
  const open = plan.status !== 'Closed';
  // The manager the month was given to assigns its work, once the Director has
  // confirmed the plan and the budget it runs on. The Director can do it too --
  // covering for a manager is part of running the month.
  const canAssignWork = open && plan.status === 'Confirmed' && (isDirector || isPlanManager);
  // Who a day's work can be handed to: this operation's managers and its team
  // members. Somebody covering every operation belongs in every list. Falling
  // back to the managers list keeps the form usable if /api/people failed.
  const workPeople = (people.length ? people : managers)
    .filter((person) => person.coversAllSectors || person.sector === plan.operation);
  const operationManagers = managers.filter((manager) => manager.coversAllSectors || manager.sector === plan.operation || manager.id === plan.managerId);
  // The Director reviews the whole month. A manager is shown the activities that
  // were planned for THEM -- another manager's work in the same operation is
  // theirs to read on the register, not to record progress against here.
  const visible = isDirector ? activities : activities.filter((item) => Number(item.assignedTo) === Number(user.id));

  const settingsChanges = {};
  if ((settings.managerId || '') !== (plan.managerId ? String(plan.managerId) : '')) settingsChanges.managerId = settings.managerId ? Number(settings.managerId) : null;
  if (settings.notes.trim() !== (plan.notes || '')) settingsChanges.notes = settings.notes.trim();
  if (settings.category !== (plan.category || '')) settingsChanges.category = settings.category;
  if (settings.objective.trim() !== (plan.objective || '')) settingsChanges.objective = settings.objective.trim();
  if (settings.approvedBudget !== String(plan.approvedBudget ?? '')) {
    settingsChanges.approvedBudget = settings.approvedBudget === '' ? 0 : Number(settings.approvedBudget);
  }
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

    {/* The four figures the month is read by. Approved is the Director's ceiling;
        committed is what has been given out to activities; spent is what has
        actually gone; and what is left of each is the number somebody is about to
        act on. Showing only three of them was why nobody could tell whether there
        was room for more work. */}
    <div className="detail-facts">
      <Fact label={t('table.status')} value={<span className={`status-badge ${planTone(plan.status)}`}>{t(`monthly.planStatus.${plan.status}`)}</span>} />
      <Fact label={t('monthly.approvedAllocation')} value={formatUsd(plan.approvedBudget)} />
      <Fact label={t('monthly.committed')}
        value={<>{formatUsd(plan.committedBudget)}
          <small className="fact-note">{fill(t('monthly.freeToPlan'), { amount: formatUsd(plan.uncommittedBudget) })}</small>
        </>} />
      <Fact label={t('monthly.totalSpent')} value={formatUsd(plan.totalSpent)} />
      <Fact label={t('monthly.remainingBalance')}
        value={<span className={plan.remainingBalance < 0 ? 'over-budget' : undefined}>{formatUsd(plan.remainingBalance)}</span>} />
      <Fact label={t('review.completedActivities')} value={`${plan.completedCount}/${plan.activityCount}`} />
      <Fact label={t('monthly.workDone')}
        value={plan.workCount ? `${plan.workCompletedCount}/${plan.workCount}` : '—'} />
      <Fact label={t('review.expensesWithoutEvidence')} value={plan.expensesWithoutEvidence} />
    </div>
    {/* A month with no activities on it is a heading and a budget: the manager
        opening it has nothing to do and no way to know why. Said here, where the
        Director is looking, instead of leaving them to find the form below. */}
    {isDirector && open && !activities.length && <p className="next-step next-step-action plan-next">
      <strong>{t('monthly.nextAddActivities')}</strong>
      <span>{t('monthly.nextAddActivitiesText')}</span>
    </p>}
    {isDirector && open && activities.length > 0 && plan.status === 'Draft' && <p className="next-step next-step-action plan-next">
      <strong>{t('monthly.nextConfirm')}</strong>
      <span>{t('monthly.nextConfirmText')}</span>
    </p>}
    {plan.category && <p className="detail-notes"><strong>{t('monthly.businessCategory')}:</strong> {categoryLabel(plan.category, t)}</p>}
    {plan.objective && <p className="detail-notes"><strong>{t('monthly.objectives')}:</strong> {plan.objective}</p>}
    {plan.notes && <p className="detail-notes">{plan.notes}</p>}

    {/* What the Director set for the month, and under each one the days of work
        the manager assigned to finish it. The two levels used to be one flat
        table, which is why a planned activity looked untouched however much work
        was going on inside it. */}
    <h3 className="form-section-title">{isDirector ? t('monthly.plannedActivities') : t('work.plannedForYou')}</h3>
    {visible.length ? <div className="planned-list">{visible.map((item) => <PlannedActivity
      key={item.id}
      item={item}
      plan={plan}
      user={user}
      t={t}
      language={language}
      busy={busy}
      people={workPeople}
      canAssignWork={canAssignWork}
      form={workForms[item.id] || emptyWork}
      setForm={(next) => setWorkForms({ ...workForms, [item.id]: next })}
      onAddWork={onAddWork}
      onStart={onStartWork}
      onOpen={onOpenActivity}
      isMine={isDirector || Number(item.assignedTo) === Number(user.id)}
      fetchJson={fetchJson}
      upload={upload}
      onOpenFile={onOpenFile}
      onReload={onReload}
      onError={onError}
      onMessage={onMessage}
    />)}</div> : <div className="empty-state">
      <strong>{isDirector ? t('monthly.noActivitiesInPlan') : t('work.nonePlannedForYou')}</strong>
      <span>{isDirector ? t('monthly.noActivitiesHint')
        : plan.status === 'Draft' ? t('work.monthStillDraft') : t('work.nonePlannedForYouHint')}</span>
    </div>}
    {activities.length > 0 && <>
      <div className="totals-line">
        <span>{t('monthly.totalApprovedBudget')}: <strong>{formatUsd(plan.approvedBudget)}</strong></span>
        <span>{t('monthly.committed')}: <strong>{formatUsd(plan.committedBudget)}</strong></span>
        <span>{t('monthly.totalSpent')}: <strong>{formatUsd(plan.totalSpent)}</strong></span>
        <span>{t('monthly.remainingBalance')}: <strong className={plan.remainingBalance < 0 ? 'over-budget' : undefined}>{formatUsd(plan.remainingBalance)}</strong></span>
      </div>
      {/* The month adds up records agreed at different times, so the local
          currencies here are at today's rate rather than any one record's. */}
      {rate?.rwfPerUsd > 0 && <p className="field-hint">
        {t('money.todayRate')}: {formatLocal(plan.approvedBudget * rate.rwfPerUsd, 'RWF')}
        {' · '}{formatLocal(plan.approvedBudget * rate.cdfPerUsd, 'CDF')}
        {' · '}{t('monthly.remainingBalance')}: {formatLocal(plan.remainingBalance * rate.rwfPerUsd, 'RWF')} · {formatLocal(plan.remainingBalance * rate.cdfPerUsd, 'CDF')}
      </p>}
    </>}

    {/* Section 2: the Director confirms the plan, which records the allocation
        and nothing else. The wording on the button says so. */}
    {isDirector && plan.status === 'Draft' && <div className="visibility-control">
      <div>
        <span className="eyebrow">{t('monthly.totalToGive')}</span>
        <strong>{formatUsd(plan.approvedBudget)}</strong>
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
        {/* The budget for the month. Changing it once the month is running asks
            for a reason, which the handler collects. */}
        <label className="form-field"><span>{t('monthly.budgetYouApprove')}</span>
          <input type="number" inputMode="decimal" min="0" step="0.01" value={settings.approvedBudget}
            onChange={(event) => setSettings({ ...settings, approvedBudget: event.target.value })} />
          <small className="field-hint">{fill(t('monthly.committedSoFar'), { amount: formatUsd(plan.committedBudget) })}</small>
        </label>
        <label className="form-field"><span>{t('monthly.businessCategory')}</span>
          <select value={settings.category} onChange={(event) => setSettings({ ...settings, category: event.target.value })}>
            <option value="">{t('form.selectCategory')}</option>
            {categoriesForOperation(plan.operation).map((category) =>
              <option key={category} value={category}>{categoryLabel(category, t)}</option>)}
          </select>
        </label>
        <label className="form-field form-field-wide"><span>{t('monthly.objectives')}</span>
          <textarea rows="2" value={settings.objective} onChange={(event) => setSettings({ ...settings, objective: event.target.value })} />
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
          <select required value={activityForm.category} onChange={(event) => setActivityForm({ ...activityForm, category: event.target.value })}>
            <option value="">{t('form.selectCategory')}</option>
            {categoriesForOperation(plan.operation).map((category) =>
              <option key={category} value={category}>{categoryLabel(category, t)}</option>)}
          </select>
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
        {/* Required: the manager breaks this into days of work and the person
            doing them reads it. A title on its own tells neither of them
            anything, and it was the field people were skipping. */}
        <label className="form-field form-field-wide"><span>{t('field.description')}</span>
          <textarea required rows="2" placeholder={t('form.whatWorkInvolves')} value={activityForm.description}
            onChange={(event) => setActivityForm({ ...activityForm, description: event.target.value })} />
        </label>
        <label className="form-field form-field-wide"><span>{t('review.adminNote')}</span>
          <input value={activityForm.adminNote} onChange={(event) => setActivityForm({ ...activityForm, adminNote: event.target.value })} />
        </label>
      </div>
      <p className="field-hint">{fill(t('monthly.freeToPlan'), { amount: formatUsd(plan.uncommittedBudget) })}</p>
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
