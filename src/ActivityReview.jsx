import { useEffect, useMemo, useState } from 'react';
import { translate, useI18n, useT } from './i18n.js';
import { ExpensePanel } from './MonthlyPlans.jsx';

// The Director's review screen for one activity, and the same record as the
// manager sees it -- whether they raised it themselves or the Director handed
// it to them: the request or the assignment, the decision taken on it, the
// evidence returned, and the trail of every change.

// Mirrors ACTIVITY_STATUSES in server/db/activitySchema.js.
export const ACTIVITY_STATUSES = [
  'Draft', 'Pending Approval', 'Approved', 'Rejected',
  'In Progress', 'Completed', 'Cancelled',
  'Budget Adjusted', 'Needs Correction', 'On Hold'
];

// What the Director can move a record to from where it stands now. Mirrors
// STATUS_FLOW in server/routes/activities.js, which is what actually enforces it.
const STATUS_FLOW = {
  Draft: ['Pending Approval', 'Cancelled'],
  'Pending Approval': ['Approved', 'Budget Adjusted', 'Rejected', 'On Hold', 'Cancelled'],
  Approved: ['In Progress', 'Completed', 'Needs Correction', 'Budget Adjusted', 'On Hold', 'Rejected', 'Cancelled'],
  'Budget Adjusted': ['In Progress', 'Completed', 'Needs Correction', 'Approved', 'On Hold', 'Rejected', 'Cancelled'],
  'In Progress': ['Completed', 'Needs Correction', 'Budget Adjusted', 'On Hold', 'Rejected', 'Cancelled'],
  'Needs Correction': ['In Progress', 'Completed', 'Budget Adjusted', 'On Hold', 'Rejected', 'Cancelled'],
  Completed: ['In Progress', 'Needs Correction'],
  Rejected: ['Pending Approval', 'Draft'],
  Cancelled: ['Pending Approval', 'Draft'],
  'On Hold': ['Pending Approval', 'Approved', 'Budget Adjusted', 'In Progress', 'Rejected', 'Cancelled']
};

export const EVIDENCE_KINDS = ['Receipt', 'Invoice', 'Fuel Slip', 'Delivery Note', 'Payment Proof', 'Photograph', 'Other'];

// The statuses a manager may hand finished work back from, and the ones they
// may start work from. Both mirror server/routes/activities.js.
const WORKABLE_STATUSES = ['Approved', 'Budget Adjusted', 'In Progress', 'Needs Correction'];
const STARTABLE_STATUSES = ['Approved', 'Budget Adjusted', 'Needs Correction'];
// A deadline on a record that is finished or refused is history, not a warning.
const CLOSED_STATUSES = ['Completed', 'Rejected', 'Cancelled'];

// How the role that must approve reads on screen.
export const APPROVER_ROLE_LABELS = { manager: 'Manager Approval', director: 'Director Approval' };

export function statusTone(status) {
  if (status === 'Completed' || status === 'Approved') return 'tone-done';
  if (status === 'Rejected' || status === 'Cancelled') return 'tone-stopped';
  if (['Pending Approval', 'On Hold', 'Draft', 'Needs Correction'].includes(status)) return 'tone-waiting';
  return 'tone-active';
}

// The approval decision is its own state, separate from where the work is.
export function approvalTone(approvalStatus) {
  if (approvalStatus === 'approved') return 'tone-done';
  if (approvalStatus === 'rejected') return 'tone-stopped';
  return 'tone-waiting';
}

export const APPROVAL_STATUS_LABELS = {
  pending: 'Pending Approval',
  approved: 'Approved',
  rejected: 'Rejected'
};

// "John — Farming Manager", or "Director/Admin" when the record names the
// office rather than a person. Used wherever the screen has to say who a record
// is waiting on, so that never degrades to a bare "Pending".
export function approverName(record, sectorLabel, t) {
  const role = record.approvalRequiredRole;
  // Callers that have no translator in scope still get readable English.
  const label = t || ((key) => translate('en', key));
  const director = label('review.directorAdmin');
  const manager = label('role.manager');
  if (!record.approvalRequiredFrom) {
    return role === 'director' ? director : label('form.nobodyYet');
  }
  const name = record.approvalRequiredFromName || `#${record.approvalRequiredFrom}`;
  if (role === 'director') return `${name} — ${director}`;
  const area = record.approvalRequiredFromSector ? sectorLabel(record.approvalRequiredFromSector) : null;
  return area ? `${name} — ${area} · ${manager}` : `${name} — ${manager}`;
}

// A trimmed budget is a negative number, and the sign belongs in front of the
// currency symbol: -$50.00, not $-50.00.
export function formatUsd(value) {
  const amount = Number(value || 0);
  const digits = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(amount));
  return `${amount < 0 ? '-' : ''}$${digits}`;
}

function formatLocal(value, currency) {
  return `${currency} ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value || 0))}`;
}

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString() : '—';
}

// A deadline is a calendar day, not an instant. Handing '2026-01-05' to Date
// reads it as midnight UTC, which prints as the day before anywhere west of
// Greenwich, so the parts are read straight out of the string instead.
function dateParts(value) {
  if (!value) return null;
  const [year, month, day] = String(value).slice(0, 10).split('-').map(Number);
  return year && month && day ? [year, month, day] : null;
}

export function formatDate(value) {
  const parts = dateParts(value);
  if (!parts) return value ? String(value) : '—';
  return new Date(parts[0], parts[1] - 1, parts[2]).toLocaleDateString();
}

// How the deadline should read on screen: overdue, close, or simply a date.
// Measured from today's calendar day, so "due today" is exactly zero rather
// than a fraction either side of it.
export function deadlineNote(activity, language = 'en') {
  const parts = dateParts(activity.deadline);
  if (!parts || CLOSED_STATUSES.includes(activity.status)) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(parts[0], parts[1] - 1, parts[2]) - today) / 86400000);
  // Built from keys rather than an English sentence, so the flag reads in the
  // viewer's language wherever it is rendered.
  const say = (key) => translate(language, key);
  if (days < 0) return { tone: 'overdue', text: `${-days} ${say('deadline.days')} ${say('deadline.overdue')}` };
  if (days === 0) return { tone: 'due-soon', text: say('deadline.dueToday') };
  const due = `${say('deadline.dueInDays')} ${days} ${say('deadline.days')}`;
  return { tone: days <= 3 ? 'due-soon' : 'ok', text: due };
}

// The materials arrive as free text, one item per line. Bullets are only a
// presentation of that; the stored value stays exactly what was typed.
function materialLines(materials) {
  return String(materials || '')
    .split('\n')
    .map((line) => line.replace(/^[\s•\-*]+/, '').trim())
    .filter(Boolean);
}

// Whether this user is the person the record is waiting on. Mirrors canApprove
// in server/lib/approvals.js, which is what actually decides it -- this only
// governs whether the buttons are drawn.
export function canApproveRecord(user, record) {
  if (!record.approvalRequired) return false;
  if (record.approvalStatus !== 'pending') return false;
  if (['Draft', 'Cancelled'].includes(record.status)) return false;
  if (record.approvalRequiredRole === 'director' && user.role === 'super-admin') return true;
  return record.approvalRequiredFrom !== null && record.approvalRequiredFrom === user.id;
}

export function ActivityReview({
  detail, user, token, sectorLabel, managers = [],
  onClose, onDecision, onStatus, onAssign, onUpload, onRemoveEvidence, onSubmitCompletion, onApprove,
  onVisibility, onRecordExpense, onRemoveExpense
}) {
  const { language, t } = useI18n();
  const { activity, evidence, history, expenses = [], expenseSummary = null } = detail;
  // Section 7: the two kinds are listed under their own headings rather than
  // mixed into one table where a receipt and a site photograph look alike.
  const paymentEvidence = evidence.filter((item) => item.evidenceType !== 'activity');
  const completionEvidence = evidence.filter((item) => item.evidenceType === 'activity');
  const isDirector = user.role === 'super-admin';
  // Which way round the record was created. An assigned activity is the
  // Director's instruction to a manager; a requested one is the manager asking.
  const wasAssigned = activity.origin === 'assigned';

  const [decision, setDecision] = useState({
    approvedBudget: activity.approvedBudget === null ? String(activity.requestedBudget) : String(activity.approvedBudget),
    status: activity.status === 'Pending Approval' ? 'Approved' : activity.status,
    adminNote: activity.adminNote || ''
  });
  // The approve/reject form, which is a different thing from the Director's
  // wider editing surface below: it is the decision the record is waiting on.
  const [approval, setApproval] = useState({
    approvedBudget: activity.approvedBudget === null ? String(activity.requestedBudget) : String(activity.approvedBudget),
    adminNote: '',
    rejectionReason: ''
  });
  const [assignment, setAssignment] = useState({
    assignedTo: activity.assignedTo === null ? '' : String(activity.assignedTo),
    deadline: activity.deadline || '',
    instructions: activity.instructions || ''
  });
  const [completionNote, setCompletionNote] = useState('');

  // Reopening a different activity must not leave the previous decision in the
  // form, and a saved decision should read back what was actually stored.
  useEffect(() => {
    setDecision({
      approvedBudget: activity.approvedBudget === null ? String(activity.requestedBudget) : String(activity.approvedBudget),
      status: activity.status === 'Pending Approval' ? 'Approved' : activity.status,
      adminNote: activity.adminNote || ''
    });
    setApproval({
      approvedBudget: activity.approvedBudget === null ? String(activity.requestedBudget) : String(activity.approvedBudget),
      adminNote: '',
      rejectionReason: ''
    });
    setAssignment({
      assignedTo: activity.assignedTo === null ? '' : String(activity.assignedTo),
      deadline: activity.deadline || '',
      instructions: activity.instructions || ''
    });
    setCompletionNote('');
  }, [
    activity.id, activity.approvedBudget, activity.status, activity.adminNote, activity.requestedBudget,
    activity.assignedTo, activity.deadline, activity.instructions
  ]);

  const typedBudget = Number(decision.approvedBudget || 0);
  const typedAdjustment = typedBudget - activity.requestedBudget;
  // The Director trimmed the amount, so the record is a budget adjustment
  // rather than a plain approval unless they say otherwise.
  const suggestsAdjusted = decision.status === 'Approved' && typedBudget !== activity.requestedBudget;

  const statusOptions = [activity.status, ...(STATUS_FLOW[activity.status] || [])]
    .filter((status, index, all) => all.indexOf(status) === index);

  // A manager only ever reads their own working area, so handing them work in
  // another one would leave them assigned to a record they cannot open. The API
  // refuses it; this keeps the unusable names out of the dropdown. Whoever is
  // already on the record stays listed even if their area has since changed, so
  // the cell is never blank.
  const managerOptions = useMemo(() => {
    const sameArea = managers.filter((manager) => manager.sector === activity.sector);
    if (activity.assignedTo && !sameArea.some((manager) => manager.id === activity.assignedTo)) {
      return [{ id: activity.assignedTo, name: activity.assignedToName || `User #${activity.assignedTo}` }, ...sameArea];
    }
    return sameArea;
  }, [managers, activity.sector, activity.assignedTo, activity.assignedToName]);

  // Only what actually changed travels: the API refuses an assignment save that
  // asks for nothing, so the button stays disabled until there is something.
  const assignmentChanges = {};
  const nextManager = assignment.assignedTo === '' ? null : Number(assignment.assignedTo);
  if (nextManager !== activity.assignedTo) assignmentChanges.assignedTo = nextManager;
  if ((assignment.deadline || '') !== (activity.deadline || '')) assignmentChanges.deadline = assignment.deadline || null;
  if (assignment.instructions.trim() !== (activity.instructions || '')) assignmentChanges.instructions = assignment.instructions.trim();
  const hasAssignmentChanges = Object.keys(assignmentChanges).length > 0;

  const due = deadlineNote(activity, language);
  const canAttach = isDirector || user.sector === activity.sector;
  // Whether this user is the person the record is waiting on. The API checks
  // the same thing again before it writes anything.
  const iAmApprover = canApproveRecord(user, activity);
  // Only the Director may move a budget as part of a decision; a manager
  // approving work handed to them approves the figure as it stands.
  const canChangeBudget = iAmApprover && isDirector;
  // The one move a manager owns on their own work, mirroring the status route:
  // starting what has been approved.
  const canWorkOnIt = !isDirector && user.sector === activity.sector
    && (activity.assignedTo === null || activity.assignedTo === user.id);
  const managerCanStart = canWorkOnIt && STARTABLE_STATUSES.includes(activity.status)
    && (!activity.approvalRequired || activity.approvalStatus === 'approved');
  const canSubmitCompletion = canAttach && WORKABLE_STATUSES.includes(activity.status);
  // Mirrors canRecordExpense in server/lib/monthly.js, which is what decides it.
  const canRecordExpense = (isDirector || activity.assignedTo === user.id)
    && (!activity.approvalRequired || activity.approvalStatus === 'approved')
    && !['Rejected', 'Cancelled'].includes(activity.status)
    && activity.planStatus !== 'Closed';
  const typedApprovalBudget = Number(approval.approvedBudget || 0);
  const approvalBudgetChanged = canChangeBudget && typedApprovalBudget !== activity.requestedBudget;
  const items = materialLines(activity.materials);
  // Ids are what the trail records; these are the names a reader needs.
  const userNames = useMemo(() => {
    const names = new Map(managers.map((manager) => [String(manager.id), manager.name]));
    if (activity.assignedTo && activity.assignedToName) names.set(String(activity.assignedTo), activity.assignedToName);
    return names;
  }, [managers, activity.assignedTo, activity.assignedToName]);

  return <section className="panel detail-panel activity-review">
    <div className="panel-header">
      <div>
        <span className="eyebrow">{wasAssigned ? t('review.assignedActivity') : t('review.activityReview')}</span>
        <h2>{sectorLabel(activity.sector)} &mdash; {activity.activity}</h2>
        <span>
          {wasAssigned
            ? `${t('review.assignedBy')} ${activity.createdByName || t('review.theDirector')} ${t('review.toWhom')} ${activity.assignedToName || t('form.nobodyYet')}`
            : `${t('review.submittedBy')} ${activity.createdByName || '\u2014'}`} · {sectorLabel(activity.sector)} ·
          {' '}{formatDateTime(activity.createdAt)} · {activity.projectName || activity.projectId}
        </span>
      </div>
      <button className="text-btn" type="button" onClick={onClose}>{t('action.close')}</button>
    </div>

    <ApprovalPanel record={activity} sectorLabel={sectorLabel} />

    <div className="detail-facts">
      <Fact label={t('table.status')} value={<span className={`status-badge ${statusTone(activity.status)}`}>{t(`status.${activity.status}`)}</span>} />
      <Fact label={t('table.department')} value={sectorLabel(activity.department || activity.sector)} />
      <Fact label={t('table.category')} value={activity.category} />
      <Fact label={t('field.quantity')} value={activity.quantity} />
      <Fact label={t('table.createdBy')} value={activity.createdByName || <span className="muted-cell">&mdash;</span>} />
      <Fact label={t('field.carriedOutBy')} value={activity.assignedToName || <span className="muted-cell">{t('review.notAssigned')}</span>} />
      <Fact label={t('table.deadline')} value={activity.deadline
        ? <>{formatDate(activity.deadline)}{due && due.tone !== 'ok' && <small className={`deadline-flag deadline-${due.tone}`}>{due.text}</small>}</>
        : <span className="muted-cell">{t('review.noDeadline')}</span>} />
      <Fact label={t('field.evidence')} value={<span className={`status-badge ${activity.evidenceStatus === 'Complete' ? 'tone-done' : 'tone-waiting'}`}>{activity.evidenceStatus}</span>} />
      <Fact label={t('review.reviewedBy')} value={activity.reviewedByName ? `${activity.reviewedByName} · ${formatDateTime(activity.reviewedAt)}` : t('review.notReviewed')} />
      <Fact label={t('review.completionSubmitted')} value={activity.completionSubmittedAt ? formatDateTime(activity.completionSubmittedAt) : t('review.notSubmitted')} />
    </div>

    {/* The decision this record is waiting on, taken by the person it names.
        Drawn only for that person; the API refuses anybody else regardless. */}
    {iAmApprover && <form className="decision-form approval-form" onSubmit={(event) => {
      event.preventDefault();
      onApprove(activity, {
        action: 'approve',
        ...(canChangeBudget ? { approvedBudget: Number(approval.approvedBudget || 0) } : {}),
        adminNote: approval.adminNote.trim()
      });
    }}>
      <h3 className="form-section-title">{t('approval.yourDecision')}</h3>
      <div className="form-grid">
        {canChangeBudget && <label className="form-field"><span>{t('review.approvedBudgetUsd')}</span>
          <input type="number" min="0" step="0.01" value={approval.approvedBudget}
            onChange={(event) => setApproval({ ...approval, approvedBudget: event.target.value })} />
        </label>}
        <label className="form-field form-field-wide">
          <span>{isDirector ? t('review.directorNote') : t('field.note')} ({approvalBudgetChanged ? t('field.required') : t('field.optional')})</span>
          <textarea rows="2"
            value={approval.adminNote} onChange={(event) => setApproval({ ...approval, adminNote: event.target.value })} />
        </label>
        <label className="form-field form-field-wide"><span>{t('review.reasonIfReject')}</span>
          <input
            value={approval.rejectionReason} onChange={(event) => setApproval({ ...approval, rejectionReason: event.target.value })} />
        </label>
      </div>
      {approvalBudgetChanged && <p className="decision-hint">
        {formatUsd(activity.requestedBudget)} &rarr; {formatUsd(typedApprovalBudget)}
        {' '}({typedApprovalBudget - activity.requestedBudget > 0 ? '+' : ''}
        {formatUsd(typedApprovalBudget - activity.requestedBudget)})
      </p>}
      <div className="button-row">
        <button className="primary-btn" type="submit">{t('approval.approve')}</button>
        <button className="danger-btn outlined" type="button"
          disabled={!approval.rejectionReason.trim()}
          onClick={() => onApprove(activity, { action: 'reject', rejectionReason: approval.rejectionReason.trim() })}>
          {t('approval.reject')}
        </button>
      </div>
    </form>}

    {activity.instructions && <>
      <h3 className="form-section-title">{t('review.instructionsFromDirector')}</h3>
      <p className="detail-notes admin-note">{activity.instructions}</p>
    </>}

    <h3 className="form-section-title">{wasAssigned ? t('review.activityDetails') : t('review.requestDetails')}</h3>
    <p className="detail-notes">{activity.description || t('review.noDescription')}</p>
    {items.length
      ? <ul className="material-list">{items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
      : <p className="detail-notes muted-cell">{t('review.noMaterials')}</p>}

    <div className="budget-strip">
      <div className="budget-block">
        <span>{wasAssigned ? t('review.budgetSetAtAssignment') : t('review.requestedBudget')}</span>
        <strong>{formatUsd(activity.requestedBudget)}</strong>
        <small>{formatLocal(activity.requestedEquivalent.rwf, 'RWF')} · {formatLocal(activity.requestedEquivalent.cdf, 'CDF')}</small>
      </div>
      <div className="budget-block">
        <span>{t('review.approvedBudget')}</span>
        <strong>{activity.approvedBudget === null ? t('activities.notDecided') : formatUsd(activity.approvedBudget)}</strong>
        <small>{activity.approvedEquivalent
          ? `${formatLocal(activity.approvedEquivalent.rwf, 'RWF')} · ${formatLocal(activity.approvedEquivalent.cdf, 'CDF')}`
          : t('review.awaitingDirector')}</small>
      </div>
      <div className={`budget-block${activity.budgetAdjustment ? ' budget-adjusted' : ''}`}>
        <span>{t('review.budgetAdjustment')}</span>
        <strong>{activity.budgetAdjustment === null
          ? '—'
          : `${activity.budgetAdjustment > 0 ? '+' : ''}${formatUsd(activity.budgetAdjustment)}`}</strong>
        <small>{activity.budgetAdjustment
          ? t('review.changedOnReview')
          : (wasAssigned ? t('review.unchangedSinceAssigned') : t('review.unchangedSinceRequested'))}</small>
      </div>
    </div>

    {isDirector
      ? <form className="decision-form" onSubmit={(event) => {
        event.preventDefault();
        onDecision(activity, {
          approvedBudget: decision.approvedBudget === '' ? null : Number(decision.approvedBudget),
          status: decision.status,
          adminNote: decision.adminNote.trim()
        });
      }}>
        <h3 className="form-section-title">{t('review.adminDecision')}</h3>
        <div className="form-grid">
          <label className="form-field"><span>{t('review.approvedBudgetUsd')}</span>
            <input type="number" min="0" step="0.01" value={decision.approvedBudget}
              onChange={(event) => setDecision({ ...decision, approvedBudget: event.target.value })} />
          </label>
          <label className="form-field"><span>{t('table.status')}</span>
            <select value={decision.status} onChange={(event) => setDecision({ ...decision, status: event.target.value })}>
              {statusOptions.map((status) => <option key={status} value={status}>{t(`status.${status}`)}</option>)}
            </select>
          </label>
          <label className="form-field form-field-wide"><span>{t('review.adminNote')}{typedBudget !== activity.requestedBudget || ['Rejected', 'Needs Correction'].includes(decision.status) ? ` (${t('field.required')})` : ''}</span>
            <textarea rows="3"
              value={decision.adminNote} onChange={(event) => setDecision({ ...decision, adminNote: event.target.value })} />
          </label>
        </div>
        {typedBudget !== activity.requestedBudget && <p className="decision-hint">
          {formatUsd(activity.requestedBudget)} &rarr; {formatUsd(typedBudget)}
          {' '}({typedAdjustment > 0 ? '+' : ''}{formatUsd(typedAdjustment)}).
          {suggestsAdjusted ? ` ${t('review.considerAdjusted')}` : ''}
        </p>}
        {decision.status === 'Needs Correction' && <p className="decision-hint">{t('review.needsCorrectionHint')}</p>}
        <button className="primary-btn" type="submit">{t('action.saveDecision')}</button>
      </form>
      : <div className="decision-readout">
        <h3 className="form-section-title">{t('review.adminDecision')}</h3>
        {activity.approvedBudget === null
          ? <p className="detail-notes">{t('review.notDecidedYet')}</p>
          : <>
            <p className="detail-notes"><strong>{t('review.approvedBudget')}:</strong> {formatUsd(activity.approvedBudget)}
              {activity.budgetAdjustment ? ` (${activity.budgetAdjustment > 0 ? '+' : ''}${formatUsd(activity.budgetAdjustment)} against the ${wasAssigned ? 'original' : 'request'})` : ''}</p>
            {activity.adminNote && <p className="detail-notes admin-note">&ldquo;{activity.adminNote}&rdquo;</p>}
          </>}
      </div>}

    {/* Who carries the work out, by when, and on what terms. The budget is not
        reachable here; that is the decision above. */}
    {isDirector && <form className="decision-form assignment-form" onSubmit={(event) => {
      event.preventDefault();
      onAssign(activity, assignmentChanges);
    }}>
      <h3 className="form-section-title">{t('review.assignment')}</h3>
      <div className="form-grid">
        <label className="form-field"><span>{t('field.carriedOutBy')}</span>
          <select value={assignment.assignedTo} onChange={(event) => setAssignment({ ...assignment, assignedTo: event.target.value })}>
            <option value="">{t('form.nobodyYet')}</option>
            {managerOptions.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}
          </select>
        </label>
        <label className="form-field"><span>{t('field.deadline')}</span>
          <input type="date" value={assignment.deadline}
            onChange={(event) => setAssignment({ ...assignment, deadline: event.target.value })} />
        </label>
        <label className="form-field form-field-wide"><span>{t('field.instructions')}</span>
          <textarea rows="3"
            value={assignment.instructions} onChange={(event) => setAssignment({ ...assignment, instructions: event.target.value })} />
        </label>
      </div>
      {!managerOptions.length && <p className="decision-hint">{t('review.noManagerCoversArea')}</p>}
      {assignmentChanges.assignedTo !== undefined && activity.acceptedAt && <p className="decision-hint">{t('review.reassignClearsAcceptance')}</p>}
      <button className="secondary-btn" type="submit" disabled={!hasAssignmentChanges}>{t('action.saveAssignment')}</button>
    </form>}

    {(managerCanStart || canSubmitCompletion) && <div className="workflow-actions button-row">
      {managerCanStart && <button className="secondary-btn" type="button" onClick={() => onStatus(activity, 'In Progress')}>{t('action.startWork')}</button>}
      {canSubmitCompletion && <>
        <input className="completion-note" placeholder={t('review.noteForDirector')}
          value={completionNote} onChange={(event) => setCompletionNote(event.target.value)} />
        <button className="secondary-btn" type="button" onClick={() => onSubmitCompletion(activity, completionNote)}>
          {t('action.submitCompleted')}
        </button>
      </>}
    </div>}
    {iAmApprover && <p className="decision-hint">{t('review.waitingOnYou')}</p>}
    {!iAmApprover && activity.approvalStatus === 'pending' && activity.approvalRequired && activity.status !== 'Draft' && <p className="decision-hint">
      {t('approval.waitingFor')} {approverName(activity, sectorLabel, t)} {t('review.waitingOnOther')}
    </p>}
    {activity.status === 'Needs Correction' && !isDirector && <p className="decision-hint">{t('review.sentBackToYou')}</p>}
    {activity.completionSubmittedAt && activity.status !== 'Completed' && <p className="decision-hint">{t('review.completionAwaiting')}</p>}

    {/* What leaves the organisation. An external partner assigned to this
        business operation sees an approved record unless it is switched off
        here; evidence, internal notes and the trail below are never shared. */}
    {isDirector && onVisibility && <div className="visibility-control">
      <div>
        <span className="eyebrow">{t('review.externalVisibility')}</span>
        <strong className={activity.externallyVisible ? 'tone-done' : 'tone-stopped'}>
          {activity.externallyVisible ? t('visibility.visible') : t('visibility.hidden')}
        </strong>
        <small>
          {activity.approvalStatus === 'approved' ? t('visibility.note') : t('visibility.notApprovedYet')}
        </small>
      </div>
      <button
        className={activity.externallyVisible ? 'danger-btn outlined' : 'secondary-btn'}
        type="button"
        onClick={() => onVisibility(activity, !activity.externallyVisible)}
      >{activity.externallyVisible ? t('visibility.hide') : t('visibility.show')}</button>
    </div>}

    {/* Sections 5, 6 and 8: what was actually spent against this activity, and
        what is left of its approved budget. */}
    {onRecordExpense && <ExpensePanel
      activity={activity}
      expenses={expenses}
      summary={expenseSummary}
      canRecord={canRecordExpense}
      canRemove={isDirector}
      onRecord={onRecordExpense}
      onRemoveExpense={onRemoveExpense}
    />}

    {/* Section 7: proof money was spent, and proof the work was done. They are
        different things, so they are uploaded and listed separately. */}
    <h3 className="form-section-title">{t('evidence.payment')}</h3>
    <p className="detail-notes muted-cell">{t('evidence.paymentHint')}</p>
    {canAttach && <EvidenceUpload
      evidenceType="payment"
      expenses={expenses}
      onUpload={(formData) => onUpload(activity, formData)}
    />}
    <EvidenceList
      activity={activity}
      evidence={paymentEvidence}
      token={token}
      canRemove={isDirector}
      onRemove={(item) => onRemoveEvidence(activity, item)}
    />

    <h3 className="form-section-title">{t('evidence.activity')}</h3>
    <p className="detail-notes muted-cell">{t('evidence.activityHint')}</p>
    {canAttach && <EvidenceUpload
      evidenceType="activity"
      expenses={[]}
      onUpload={(formData) => onUpload(activity, formData)}
    />}
    <EvidenceList
      activity={activity}
      evidence={completionEvidence}
      token={token}
      canRemove={isDirector}
      onRemove={(item) => onRemoveEvidence(activity, item)}
    />

    <h3 className="form-section-title">{t('review.activityHistory')}</h3>
    {history.length
      ? <ul className="history-list">{history.map((entry) => <li key={entry.id}>
        <strong>{entry.action}</strong>
        {entry.field && <span>
          {' '}{labelForField(entry.field, t)}: {formatTrailValue(entry.field, entry.oldValue, userNames)} &rarr; {formatTrailValue(entry.field, entry.newValue, userNames)}
        </span>}
        <small>{entry.actorName || '\u2014'} · {formatDateTime(entry.createdAt)}</small>
        {entry.note && <small className="justification">{t('approval.reason')}: {entry.note}</small>}
      </li>)}</ul>
      : <div className="empty-state"><strong>{t('empty.noHistory')}</strong><span>{t('empty.noHistoryHint')}</span></div>}
  </section>;
}

// The audit trail records a column name; these are the words a reader needs.
function labelForField(field, t) {
  const key = `trail.${field}`;
  const label = t(key);
  // translate() falls back to the key itself, which is not worth showing.
  return label === key ? field : label;
}

function formatTrailValue(field, value, userNames) {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'approvedBudget' || field === 'requestedBudget') return formatUsd(value);
  // The trail stores the manager's id, which is not a name anyone reads.
  if (field === 'assignedTo' || field === 'approvalRequiredFrom') return userNames?.get(String(value)) || `#${value}`;
  if (field === 'deadline') return formatDate(value);
  // Instructions and notes run to paragraphs; a trail line is a summary.
  const text = String(value);
  return text.length > 70 ? `${text.slice(0, 70)}…` : text;
}

function Fact({ label, value }) {
  return <div className="fact"><span>{label}</span><strong>{value}</strong></div>;
}

// Who has to approve this record, and what they decided. Shown at the top of
// both the activity and the movement detail screens so a reader never has to
// infer an approver from a bare "Pending".
export function ApprovalPanel({ record, sectorLabel }) {
  const t = useT();
  if (!record.approvalRequired) {
    return <div className="approval-panel approval-none">
      <div><span>{t('approval.required')}</span><strong>{t('approval.none')}</strong></div>
      <div><span>{t('approval.recordedBy')}</span><strong>{record.approvedByName || record.createdByName || '—'}</strong></div>
    </div>;
  }

  const decided = record.approvalStatus !== 'pending';
  return <div className={`approval-panel approval-${record.approvalStatus}`}>
    <div>
      <span>{t('approval.required')}</span>
      <strong>{record.approvalRequiredRole === 'manager' ? t('approval.managerApproval') : t('approval.directorApproval')}</strong>
    </div>
    <div>
      <span>{decided ? t('approval.wasWaitingFor') : t('approval.waitingFor')}</span>
      <strong>{approverName(record, sectorLabel, t)}</strong>
    </div>
    <div>
      <span>{t('approval.status')}</span>
      <strong>
        <span className={`status-badge ${approvalTone(record.approvalStatus)}`}>
          {t(`approval.${record.approvalStatus}`)}
        </span>
      </strong>
    </div>
    {record.approvalStatus === 'approved' && <>
      <div><span>{t('approval.approvedBy')}</span><strong>{record.approvedByName || '—'}</strong></div>
      <div><span>{t('approval.approvedAt')}</span><strong>{formatDateTime(record.approvedAt)}</strong></div>
    </>}
    {record.approvalStatus === 'rejected' && <>
      <div><span>{t('approval.rejectedBy')}</span><strong>{record.approvedByName || '—'}</strong></div>
      <div className="approval-reason">
        <span>{t('approval.reason')}</span>
        <strong>{record.rejectionReason || record.adminNote || '—'}</strong>
      </div>
    </>}
  </div>;
}

function EvidenceUpload({ onUpload, evidenceType = 'payment', expenses = [] }) {
  const t = useT();
  const [kind, setKind] = useState(evidenceType === 'activity' ? 'Photograph' : 'Receipt');
  const [expenseId, setExpenseId] = useState('');
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
    formData.append('evidenceType', evidenceType);
    // Naming the expense is what lets the review say "3 of 3 documented"
    // rather than merely counting files against the activity.
    if (evidenceType === 'payment' && expenseId) formData.append('expenseId', expenseId);
    Array.from(files).forEach((file) => formData.append('files', file));
    onUpload(formData);
    setAmount(''); setNote(''); setFiles(null); setExpenseId(''); setInputKey((current) => current + 1);
  };

  return <form className="inline-form" onSubmit={submit}>
    <label className="form-field"><span>{t('field.evidenceType')}</span>
      <select value={kind} onChange={(event) => setKind(event.target.value)}>{EVIDENCE_KINDS.map((option) => <option key={option} value={option}>{t(`ekind.${option}`)}</option>)}</select>
    </label>
    {/* Which spend this receipt is for. Naming it is what turns a pile of
        files into "3 of 3 expenses documented" on the Director's review. */}
    {evidenceType === 'payment' && expenses.length > 0 && <label className="form-field"><span>{t('expense.attachEvidence')}</span>
      <select value={expenseId} onChange={(event) => setExpenseId(event.target.value)}>
        <option value="">&mdash;</option>
        {expenses.map((expense) => <option key={expense.id} value={expense.id}>
          {expense.spentOn} · {formatUsd(expense.amount)} · {expense.description.slice(0, 40)}
        </option>)}
      </select>
    </label>}
    <label className="form-field"><span>{t('field.amount')} (USD)</span>
      <input type="number" min="0" step="0.01" placeholder="0" value={amount} onChange={(event) => setAmount(event.target.value)} />
    </label>
    <label className="form-field"><span>{t('field.note')}</span>
      <input placeholder={t('evidence.notePlaceholder')} value={note} onChange={(event) => setNote(event.target.value)} />
    </label>
    <label className="form-field"><span>{t('field.files')}</span>
      <input key={inputKey} type="file" multiple accept="image/*,application/pdf" onChange={(event) => setFiles(event.target.files)} />
    </label>
    <button className="secondary-btn" type="submit" disabled={!files?.length}>{t('action.uploadEvidence')}</button>
  </form>;
}

function EvidenceList({ activity, evidence, token, canRemove, onRemove }) {
  const t = useT();
  if (!evidence.length) {
    return <div className="empty-state"><strong>{t('empty.noEvidence')}</strong><span>{t('empty.noEvidenceHint')}</span></div>;
  }
  return <div className="table-wrap"><table>
    <thead><tr><th>{t('field.type')}</th><th>{t('field.file')}</th><th>{t('field.amount')}</th><th>{t('field.note')}</th><th>{t('field.uploadedBy')}</th><th>{t('table.date')}</th><th>{t('table.actions')}</th></tr></thead>
    <tbody>{evidence.map((item) => <tr key={item.id}>
      <td>{item.kind}</td>
      <td><strong>{item.originalName}</strong><small>{(item.sizeBytes / 1024).toFixed(0)} KB · {item.mimeType}</small></td>
      <td>{item.amount ? formatUsd(item.amount) : '—'}</td>
      <td>{item.note || '—'}</td>
      <td>{item.uploadedByName || '—'}</td>
      <td>{formatDateTime(item.createdAt)}</td>
      <td>
        {/* A plain link cannot carry an Authorization header, so the file route
            also accepts the token as a query parameter. */}
        <a className="text-btn" target="_blank" rel="noreferrer"
          href={`/api/activities/${activity.id}/evidence/${item.id}/file?token=${encodeURIComponent(token)}`}>{t('action.view')}</a>
        {canRemove && <button className="danger-btn" type="button" onClick={() => onRemove(item)}>{t('action.remove')}</button>}
      </td>
    </tr>)}</tbody>
  </table></div>;
}

export default ActivityReview;
