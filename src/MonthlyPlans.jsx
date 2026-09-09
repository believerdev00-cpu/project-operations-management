import { useCallback, useEffect, useMemo, useState } from 'react';
import { BUSINESS_OPERATIONS, operationName } from '../shared/businessOperations.js';
import { useI18n } from './i18n.js';

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

function monthLabel(month, language) {
  const [year, index] = String(month).split('-').map(Number);
  if (!year || !index) return month;
  return new Date(year, index - 1, 1).toLocaleDateString(language, { month: 'long', year: 'numeric' });
}

const emptyActivity = {
  activity: '', category: '', description: '', approvedBudget: '',
  priority: 'Medium', deadline: '', adminNote: ''
};

export default function MonthlyPlans({ user, fetchJson, managers, activities: registerActivities = [], onMessage, onError }) {
  const { language, t } = useI18n();
  const isDirector = user.role === 'super-admin';

  const [month, setMonth] = useState(thisMonth);
  const [review, setReview] = useState(null);
  const [openPlanId, setOpenPlanId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [newPlan, setNewPlan] = useState({ operation: 'farming', managerId: '' });
  const [activityForm, setActivityForm] = useState(emptyActivity);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReview(await fetchJson(`/api/monthly-plans/review?month=${month}`));
    } catch (loadError) {
      onError(loadError.message);
    } finally {
      setLoading(false);
    }
  }, [fetchJson, month, onError]);

  useEffect(() => { load(); }, [load]);

  const openPlan = useCallback(async (planId) => {
    try {
      setDetail(await fetchJson(`/api/monthly-plans/${planId}`));
      setOpenPlanId(planId);
    } catch (openError) { onError(openError.message); }
  }, [fetchJson, onError]);

  // A manager works one operation, so their month opens straight away rather
  // than making them pick their own plan out of a list of one.
  useEffect(() => {
    if (isDirector || !review?.operations?.length || openPlanId) return;
    openPlan(review.operations[0].id);
  }, [isDirector, review, openPlanId, openPlan]);

  const refresh = async () => {
    await load();
    if (openPlanId) await openPlan(openPlanId);
  };

  const createPlan = async (event) => {
    event.preventDefault();
    try {
      const plan = await fetchJson('/api/monthly-plans', {
        method: 'POST',
        body: JSON.stringify({ ...newPlan, month, managerId: newPlan.managerId || null })
      });
      onMessage(`${operationName(plan.operation, language)} — ${monthLabel(month, language)}: ${t('monthly.createPlan')}.`);
      setNewPlan({ operation: 'farming', managerId: '' });
      await load();
      await openPlan(plan.id);
    } catch (createError) { onError(createError.message); }
  };

  const addActivity = async (event) => {
    event.preventDefault();
    try {
      await fetchJson(`/api/monthly-plans/${openPlanId}/activities`, {
        method: 'POST',
        body: JSON.stringify({ ...activityForm, approvedBudget: Number(activityForm.approvedBudget || 0) })
      });
      setActivityForm(emptyActivity);
      onMessage(t('monthly.addActivity'));
      await refresh();
    } catch (addError) { onError(addError.message); }
  };

  const confirmPlan = async (plan) => {
    if (!window.confirm(
      `${t('monthly.confirmHint')}\n\n${t('monthly.totalToGive')}: ${formatUsd(plan.plannedBudget)}`
    )) return;
    try {
      const saved = await fetchJson(`/api/monthly-plans/${plan.id}/confirm`, { method: 'POST' });
      onMessage(`${t('monthly.approvedAllocation')}: ${formatUsd(saved.approvedBudget)}. ${t('monthly.noMoneyNotice')}`);
      await refresh();
    } catch (confirmError) { onError(confirmError.message); }
  };

  const reopenPlan = async (plan) => {
    const reason = window.prompt(t('monthly.reopen'), '');
    if (reason === null) return;
    if (!reason.trim()) return onError(t('approval.reason'));
    try {
      await fetchJson(`/api/monthly-plans/${plan.id}/reopen`, {
        method: 'POST', body: JSON.stringify({ reason: reason.trim() })
      });
      onMessage(t('monthly.reopen'));
      await refresh();
    } catch (reopenError) { onError(reopenError.message); }
  };

  const decideReport = async (plan, status) => {
    const note = window.prompt(t('monthend.reviewNote'), '');
    if (note === null) return;
    if (status === 'Returned' && !note.trim()) return onError(t('monthend.reviewNote'));
    try {
      await fetchJson(`/api/monthly-plans/${plan.id}/report`, {
        method: 'PATCH', body: JSON.stringify({ status, reviewNote: note.trim() })
      });
      onMessage(status === 'Accepted' ? t('monthend.accept') : t('monthend.return'));
      await refresh();
    } catch (decideError) { onError(decideError.message); }
  };

  // Section 4: an activity a manager raised is not part of the month's budget
  // until the Director deliberately attaches it here.
  const attachActivity = async (plan, activityId) => {
    const reason = window.prompt(t('monthly.attachActivity'), '');
    if (reason === null) return;
    try {
      const saved = await fetchJson(`/api/monthly-plans/${plan.id}/attach/${activityId}`, {
        method: 'POST', body: JSON.stringify({ reason: reason.trim() })
      });
      onMessage(`${t('monthly.approvedAllocation')}: ${formatUsd(saved.approvedBudget)}`);
      await refresh();
    } catch (attachError) { onError(attachError.message); }
  };

  const submitReport = async (plan, explanations) => {
    try {
      await fetchJson(`/api/monthly-plans/${plan.id}/report`, {
        method: 'POST', body: JSON.stringify(explanations)
      });
      onMessage(t('monthend.submit'));
      await refresh();
    } catch (submitError) { onError(submitError.message); }
  };

  // Operations that have no plan for this month yet, so the Director is offered
  // exactly the ones still to plan.
  const unplanned = useMemo(() => {
    const planned = new Set((review?.operations || []).map((plan) => plan.operation));
    return BUSINESS_OPERATIONS.filter((operation) => !planned.has(operation.id));
  }, [review]);

  const managerOptions = useMemo(
    () => managers.filter((manager) => manager.sector === newPlan.operation),
    [managers, newPlan.operation]
  );

  if (loading) return <div className="loading-state"><span className="spinner" />{t('app.loading')}</div>;

  return <>
    <section className="context-strip">
      <div>
        <span className="eyebrow">{t('monthly.eyebrow')}</span>
        <h2>{isDirector ? t('monthly.title') : t('monthly.myActivities')}</h2>
        <p>{t('monthly.blurb')}</p>
      </div>
      <label className="form-field"><span>{t('monthly.month')}</span>
        <input type="month" value={month} onChange={(event) => { setMonth(event.target.value); setOpenPlanId(null); setDetail(null); }} />
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
        {review.operations.length ? <div className="table-wrap"><table>
          <thead><tr>
            <th>{t('app.businessOperation')}</th><th>{t('field.manager')}</th>
            <th>{t('monthly.approvedAllocation')}</th><th>{t('monthly.totalSpent')}</th>
            <th>{t('monthly.remainingBalance')}</th><th>{t('review.completedActivities')}</th>
            <th>{t('review.pendingActivities')}</th><th>{t('review.expensesWithoutEvidence')}</th>
            <th>{t('review.missingEvidence')}</th><th>{t('table.status')}</th><th>{t('table.actions')}</th>
          </tr></thead>
          <tbody>{review.operations.map((plan) => <tr key={plan.id} className={plan.id === openPlanId ? 'row-selected' : undefined}>
            <td><strong>{operationName(plan.operation, language)}</strong></td>
            <td>{plan.managerName || <span className="muted-cell">{t('table.unassigned')}</span>}</td>
            <td>{formatUsd(plan.approvedBudget)}</td>
            <td>{formatUsd(plan.totalSpent)}</td>
            <td className={plan.remainingBalance < 0 ? 'over-budget' : undefined}>{formatUsd(plan.remainingBalance)}</td>
            <td>{plan.completedCount}/{plan.activityCount}</td>
            <td>{plan.outstandingCount}</td>
            <td className={plan.expensesWithoutEvidence ? 'over-budget' : undefined}>
              {plan.expenseCount - plan.expensesWithoutEvidence}/{plan.expenseCount} {t('review.documented')}
            </td>
            <td className={plan.completedWithoutEvidence ? 'over-budget' : undefined}>
              {plan.completedCount - plan.completedWithoutEvidence}/{plan.completedCount} {t('review.documented')}
            </td>
            <td><span className={`status-badge ${planTone(plan.status)}`}>{t(`monthly.planStatus.${plan.status}`)}</span></td>
            <td><button className="text-btn" type="button" onClick={() => openPlan(plan.id)}>{t('monthly.openPlan')}</button></td>
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
            <select value={newPlan.operation} onChange={(event) => setNewPlan({ operation: event.target.value, managerId: '' })}>
              {unplanned.map((operation) => <option key={operation.id} value={operation.id}>
                {operationName(operation.id, language)}
              </option>)}
            </select>
          </label>
          <label className="form-field"><span>{t('monthly.responsibleManager')}</span>
            <select required value={newPlan.managerId} onChange={(event) => setNewPlan({ ...newPlan, managerId: event.target.value })}>
              <option value="">{t('form.selectManager')}</option>
              {managerOptions.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}
            </select>
          </label>
        </div>
        {!managerOptions.length && <p className="decision-hint">{t('form.noManagerCovers')}</p>}
        <button className="primary-btn" type="submit" disabled={!managerOptions.length}>{t('monthly.createPlan')}</button>
      </form>}
    </>}

    {detail && <PlanDetail
      key={detail.plan.id}
      detail={detail}
      user={user}
      isDirector={isDirector}
      language={language}
      t={t}
      activityForm={activityForm}
      setActivityForm={setActivityForm}
      onAddActivity={addActivity}
      onConfirm={confirmPlan}
      onReopen={reopenPlan}
      onSubmitReport={submitReport}
      onAttach={attachActivity}
      offPlanActivities={registerActivities.filter((item) => item.monthlyPlanId === null
        && item.approvalStatus === 'approved'
        && item.sector === detail.plan.operation
        && !['Rejected', 'Cancelled'].includes(item.status))}
      onDecideReport={decideReport}
      onClose={() => { setDetail(null); setOpenPlanId(null); }}
      onOpenActivity={null}
    />}
  </>;
}

function planTone(status) {
  if (status === 'Confirmed') return 'tone-done';
  if (status === 'Closed') return 'tone-stopped';
  return 'tone-waiting';
}

function PlanDetail({
  detail, user, isDirector, language, t, activityForm, setActivityForm,
  onAddActivity, onConfirm, onReopen, onSubmitReport, onDecideReport, onClose, onAttach, offPlanActivities = []
}) {
  const { plan, activities, history, report } = detail;
  const [explanations, setExplanations] = useState({
    unusedBalanceExplanation: '', budgetDifferenceExplanation: ''
  });

  const isPlanManager = !isDirector && plan.managerId === user.id;
  const open = plan.status !== 'Closed';

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
      <button className="text-btn" type="button" onClick={onClose}>{t('action.close')}</button>
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

    <h3 className="form-section-title">
      {isDirector ? t('nav.activities') : t('monthly.myActivities')}
    </h3>
    {activities.length ? <div className="table-wrap"><table>
      <thead><tr>
        <th>{t('table.activity')}</th><th>{t('field.priority')}</th>
        <th>{t('monthly.approvedAllocation')}</th><th>{t('monthly.totalSpent')}</th>
        <th>{t('expense.remainingOnActivity')}</th><th>{t('monthly.expectedCompletion')}</th>
        <th>{t('table.status')}</th><th>{t('evidence.payment')}</th><th>{t('evidence.activity')}</th>
      </tr></thead>
      <tbody>{activities.map((item) => <tr key={item.id}>
        <td><strong>{item.activity}</strong><small>{item.description || item.category}</small></td>
        <td>{t(`form.priority${item.priority}`)}</td>
        <td>{formatUsd(item.approvedBudget)}</td>
        <td>{formatUsd(item.spent)}</td>
        <td className={item.remaining < 0 ? 'over-budget' : undefined}>{formatUsd(item.remaining)}</td>
        <td>{formatDate(item.deadline, language)}</td>
        <td><span className={`status-badge ${item.status === 'Completed' ? 'tone-done' : 'tone-waiting'}`}>
          {t(`status.${item.status}`)}
        </span></td>
        <td className={item.expensesWithoutEvidence ? 'over-budget' : undefined}>
          {item.expenseCount - item.expensesWithoutEvidence}/{item.expenseCount}
        </td>
        <td className={item.status === 'Completed' && !item.activityEvidenceCount ? 'over-budget' : undefined}>
          {item.activityEvidenceCount}
        </td>
      </tr>)}</tbody>
      <tfoot><tr className="total-row">
        <td colSpan="2"><strong>{plan.status === 'Draft' ? t('monthly.totalToGive') : t('monthly.totalApprovedBudget')}</strong></td>
        <td><strong>{formatUsd(plan.status === 'Draft' ? plan.plannedBudget : plan.approvedBudget)}</strong></td>
        <td><strong>{formatUsd(plan.totalSpent)}</strong></td>
        <td><strong>{formatUsd(plan.remainingBalance)}</strong></td>
        <td colSpan="4" />
      </tr></tfoot>
    </table></div> : <div className="empty-state">
      <strong>{t('monthly.noActivitiesInPlan')}</strong><span>{t('table.noData')}</span>
    </div>}

    {/* Section 2: the Director confirms the plan, which records the allocation
        and nothing else. The wording on the button says so. */}
    {isDirector && plan.status === 'Draft' && <div className="visibility-control">
      <div>
        <span className="eyebrow">{t('monthly.totalToGive')}</span>
        <strong>{formatUsd(plan.plannedBudget)}</strong>
        <small>{t('monthly.confirmHint')}</small>
      </div>
      <button className="primary-btn" type="button" disabled={!activities.length || !plan.managerId}
        onClick={() => onConfirm(plan)}>{t('monthly.confirmPlan')}</button>
    </div>}
    {isDirector && plan.status !== 'Draft' && <div className="button-row">
      <button className="secondary-btn" type="button" onClick={() => onReopen(plan)}>{t('monthly.reopen')}</button>
    </div>}

    {/* Section 1: the Director builds the month's activities. */}
    {isDirector && open && <form className="decision-form" onSubmit={onAddActivity}>
      <h3 className="form-section-title">{t('monthly.addActivity')}</h3>
      <div className="form-grid">
        <label className="form-field"><span>{t('field.activity')}</span>
          <input required value={activityForm.activity} onChange={(event) => setActivityForm({ ...activityForm, activity: event.target.value })} />
        </label>
        <label className="form-field"><span>{t('field.category')}</span>
          <input required value={activityForm.category} onChange={(event) => setActivityForm({ ...activityForm, category: event.target.value })} />
        </label>
        <label className="form-field"><span>{t('monthly.approvedAllocation')} (USD)</span>
          <input required type="number" min="0" step="0.01" value={activityForm.approvedBudget}
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
      <button className="primary-btn" type="submit">{t('monthly.addActivity')}</button>
    </form>}

    {/* Section 4: approved work the Director may fold into this month. */}
    {isDirector && open && offPlanActivities.length > 0 && <>
      <h3 className="form-section-title">{t('monthly.attachActivity')}</h3>
      <p className="detail-notes muted-cell">{t('monthly.offPlanHint')}</p>
      <div className="table-wrap"><table>
        <thead><tr>
          <th>{t('table.activity')}</th><th>{t('table.createdBy')}</th>
          <th>{t('monthly.approvedAllocation')}</th><th>{t('table.actions')}</th>
        </tr></thead>
        <tbody>{offPlanActivities.map((item) => <tr key={item.id}>
          <td><strong>{item.activity}</strong><small>{item.category}</small></td>
          <td>{item.createdByName || '—'}</td>
          <td>{formatUsd(item.approvedBudget ?? item.requestedBudget)}</td>
          <td><button className="secondary-btn compact" type="button" onClick={() => onAttach(plan, item.id)}>
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
      {isDirector && report.status === 'Submitted' && <div className="button-row">
        <button className="primary-btn" type="button" onClick={() => onDecideReport(plan, 'Accepted')}>{t('monthend.accept')}</button>
        <button className="danger-btn outlined" type="button" onClick={() => onDecideReport(plan, 'Returned')}>{t('monthend.return')}</button>
      </div>}
    </> : <p className="detail-notes muted-cell">{t('monthend.notSubmitted')}</p>}

    {isPlanManager && plan.status === 'Confirmed' && (!report || report.status === 'Returned') && <form
      className="decision-form"
      onSubmit={(event) => { event.preventDefault(); onSubmitReport(plan, explanations); }}
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
      <button className="primary-btn" type="submit">{t('monthend.submit')}</button>
    </form>}

    <h3 className="form-section-title">{t('monthly.planHistory')}</h3>
    {history.length ? <ul className="history-list">{history.map((entry) => <li key={entry.id}>
      <strong>{entry.action}</strong>
      {entry.field && <span> {entry.oldValue ?? '—'} &rarr; {entry.newValue ?? '—'}</span>}
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
export function ExpensePanel({ activity, expenses, summary, canRecord, onRecord, onRemoveExpense, canRemove }) {
  const { language, t } = useI18n();
  const [form, setForm] = useState({
    amount: '', spentOn: new Date().toISOString().slice(0, 10),
    paymentMethod: 'Cash', description: ''
  });

  const remaining = summary?.remaining ?? 0;
  const typed = Number(form.amount || 0);
  // Warned before submitting, refused by the API regardless.
  const overBudget = typed > 0 && Math.round(typed * 100) > Math.round(remaining * 100);

  return <>
    <h3 className="form-section-title">{t('expense.title')}</h3>
    <div className="detail-facts">
      <Fact label={t('monthly.approvedAllocation')} value={formatUsd(summary?.approvedBudget ?? 0)} />
      <Fact label={t('monthly.totalSpent')} value={formatUsd(summary?.totalSpent ?? 0)} />
      <Fact label={t('expense.remainingOnActivity')}
        value={<span className={remaining < 0 ? 'over-budget' : undefined}>{formatUsd(remaining)}</span>} />
    </div>

    {expenses.length ? <div className="table-wrap"><table>
      <thead><tr>
        <th>{t('expense.dateSpent')}</th><th>{t('field.description')}</th>
        <th>{t('expense.paymentMethod')}</th><th>{t('expense.amountSpent')}</th>
        <th>{t('evidence.payment')}</th><th>{t('expense.recordedBy')}</th>
        {canRemove && <th>{t('table.actions')}</th>}
      </tr></thead>
      <tbody>{expenses.map((expense) => <tr key={expense.id}>
        <td>{formatDate(expense.spentOn, language)}</td>
        <td>{expense.description}</td>
        <td>{t(`pmethod.${expense.paymentMethod}`)}</td>
        <td>{formatUsd(expense.amount)}</td>
        <td className={expense.evidenceCount ? undefined : 'over-budget'}>
          {expense.evidenceCount || t('expense.noEvidence')}
        </td>
        <td>{expense.recordedByName || '—'}</td>
        {canRemove && <td>
          <button className="danger-btn" type="button" onClick={() => onRemoveExpense(expense)}>{t('action.remove')}</button>
        </td>}
      </tr>)}</tbody>
    </table></div> : <div className="empty-state">
      <strong>{t('expense.none')}</strong><span>{t('expense.noneHint')}</span>
    </div>}

    {canRecord && <form className="decision-form" onSubmit={(event) => {
      event.preventDefault();
      onRecord({ ...form, amount: Number(form.amount || 0) }, () => setForm({ ...form, amount: '', description: '' }));
    }}>
      <h3 className="form-section-title">{t('expense.record')}</h3>
      <div className="form-grid">
        <label className="form-field"><span>{t('expense.amountSpent')} (USD)</span>
          <input required type="number" min="0.01" step="0.01" value={form.amount}
            onChange={(event) => setForm({ ...form, amount: event.target.value })} />
        </label>
        <label className="form-field"><span>{t('expense.dateSpent')}</span>
          <input required type="date" value={form.spentOn} onChange={(event) => setForm({ ...form, spentOn: event.target.value })} />
        </label>
        <label className="form-field"><span>{t('expense.paymentMethod')}</span>
          <select value={form.paymentMethod} onChange={(event) => setForm({ ...form, paymentMethod: event.target.value })}>
            {PAYMENT_METHODS.map((method) => <option key={method} value={method}>{t(`pmethod.${method}`)}</option>)}
          </select>
        </label>
        <label className="form-field form-field-wide"><span>{t('field.description')}</span>
          <input required value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
        </label>
      </div>
      {overBudget && <p className="decision-hint over-budget">{t('expense.overBudget')}</p>}
      <button className="primary-btn" type="submit" disabled={overBudget}>{t('expense.record')}</button>
    </form>}
  </>;
}
