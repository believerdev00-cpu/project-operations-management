// Recording what was spent against one activity.
//
// This lived at the bottom of MonthlyPlans.jsx, which made the two biggest
// screens import each other: ActivityReview.jsx needed ExpensePanel, and
// MonthlyPlans.jsx needed EvidenceList/EvidenceUpload back out of
// ActivityReview.jsx. A cycle like that has two costs -- the evaluation order
// of the two modules depends on which one the bundler reaches first, and
// neither screen can ever be loaded on its own, so the monthly plan screen
// could not be split out of the first download. It is the same component,
// moved: both screens now import it from here and nothing imports back.

import { useState } from 'react';
import { fill, useI18n } from './i18n.js';
import { Fact } from './ui.jsx';
import { formatDate, formatUsd, todayLocal } from './format.js';
import { FilePicker } from './journey.jsx';
import { PAYMENT_METHODS } from '../shared/paymentMethods.js';

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
