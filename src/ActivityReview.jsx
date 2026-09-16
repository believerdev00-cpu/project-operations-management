import { useEffect, useMemo, useState } from 'react';
import { displayLanguage, fill, translate, useI18n, useT } from './i18n.js';
import { ExpensePanel } from './MonthlyPlans.jsx';
import { FilePicker, Journey, MoneyBar, NextStep, Section, activityJourney, goToSection } from './journey.jsx';

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
  Rejected: ['Pending Approval'],
  Cancelled: ['Pending Approval'],
  'On Hold': ['Pending Approval', 'Approved', 'Budget Adjusted', 'In Progress', 'Rejected', 'Cancelled']
};

// Mirrors allowedNextStatuses in server/routes/activities.js: work that never
// needed an approval is never sent back for one, and reopens as Approved.
function allowedNextStatuses(activity) {
  const flow = STATUS_FLOW[activity.status] || [];
  if (activity.approvalRequired) return flow;
  return flow.filter((status) => status !== 'Pending Approval')
    .concat(['Rejected', 'Cancelled'].includes(activity.status) ? ['Approved'] : []);
}

export const EVIDENCE_KINDS = ['Receipt', 'Invoice', 'Fuel Slip', 'Delivery Note', 'Payment Proof', 'Photograph', 'Other'];

// The statuses a manager may hand finished work back from, and the ones they
// may start work from. Both mirror server/routes/activities.js.
const WORKABLE_STATUSES = ['Approved', 'Budget Adjusted', 'In Progress', 'Needs Correction'];
const STARTABLE_STATUSES = ['Approved', 'Budget Adjusted', 'Needs Correction'];
// A deadline on a record that is finished or refused is history, not a warning.
const CLOSED_STATUSES = ['Completed', 'Rejected', 'Cancelled'];

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
  return value ? new Date(value).toLocaleString(displayLanguage()) : '—';
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
  return new Date(parts[0], parts[1] - 1, parts[2])
    .toLocaleDateString(displayLanguage(), { day: 'numeric', month: 'long', year: 'numeric' });
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

// Whether the record's decision is still open for somebody. Mirrors decisionOpen
// in server/lib/approvals.js.
export function decisionIsOpen(record) {
  return Boolean(record.approvalRequired)
    && record.approvalStatus === 'pending'
    && !['Draft', 'Cancelled', 'On Hold'].includes(record.status);
}

// Whether this user is the person the record is waiting on. Mirrors canApprove
// in server/lib/approvals.js, which is what actually decides it -- this only
// governs whether the buttons are drawn.
export function canApproveRecord(user, record) {
  if (!decisionIsOpen(record)) return false;
  if (record.approvalRequiredRole === 'director' && user.role === 'super-admin') return true;
  return record.approvalRequiredFrom !== null && record.approvalRequiredFrom === user.id;
}

export function ActivityReview({
  detail, user, onOpenFile, sectorLabel, managers = [], busy = false,
  onClose, onDecision, onStatus, onAssign, onUpload, onRemoveEvidence, onSubmitCompletion, onApprove, onReject,
  onVisibility, onRecordExpense, onRemoveExpense, onRequestBudget, onDecideBudget, onDelete, onSendDraft,
  onFinish, onSendBack, onReopen, onSchedule
}) {
  const { language, t } = useI18n();
  const { activity, evidence, history, expenses = [], expenseSummary = null, budgetRequests = [] } = detail;
  // Section 7: the two kinds are listed under their own headings rather than
  // mixed into one table where a receipt and a site photograph look alike.
  const paymentEvidence = evidence.filter((item) => item.evidenceType !== 'activity');
  const completionEvidence = evidence.filter((item) => item.evidenceType === 'activity');
  const isDirector = user.role === 'super-admin';
  // Which way round the record was created. An assigned activity is the
  // Director's instruction to a manager; a requested one is the manager asking.
  const wasAssigned = activity.origin === 'assigned';

  // The note field is for a NEW note. Pre-filling it with the standing one sent
  // that old sentence back as the reason for any budget change saved later.
  const [decision, setDecision] = useState({
    approvedBudget: activity.approvedBudget === null ? String(activity.requestedBudget) : String(activity.approvedBudget),
    status: activity.status,
    adminNote: ''
  });
  // The approve/reject form, which is a different thing from the Director's
  // wider editing surface below: it is the decision the record is waiting on.
  const [approval, setApproval] = useState({
    approvedBudget: activity.approvedBudget === null ? String(activity.requestedBudget) : String(activity.approvedBudget),
    adminNote: ''
  });
  const [assignment, setAssignment] = useState({
    assignedTo: activity.assignedTo === null ? '' : String(activity.assignedTo),
    deadline: activity.deadline || '',
    instructions: activity.instructions || ''
  });
  // The manager's own date for the work, changed from the record as the work
  // is planned and re-planned.
  const [workDate, setWorkDate] = useState(activity.scheduledFor || '');

  // Reopening a different activity must not leave the previous decision in the
  // form, and a saved decision should read back what was actually stored.
  useEffect(() => {
    setDecision({
      approvedBudget: activity.approvedBudget === null ? String(activity.requestedBudget) : String(activity.approvedBudget),
      status: activity.status,
      adminNote: ''
    });
    setApproval({
      approvedBudget: activity.approvedBudget === null ? String(activity.requestedBudget) : String(activity.approvedBudget),
      adminNote: ''
    });
    setAssignment({
      assignedTo: activity.assignedTo === null ? '' : String(activity.assignedTo),
      deadline: activity.deadline || '',
      instructions: activity.instructions || ''
    });
    setWorkDate(activity.scheduledFor || '');
  }, [
    activity.id, activity.approvedBudget, activity.status, activity.adminNote, activity.requestedBudget,
    activity.assignedTo, activity.deadline, activity.scheduledFor, activity.instructions
  ]);

  const typedBudget = Number(decision.approvedBudget || 0);
  const typedAdjustment = typedBudget - activity.requestedBudget;
  // The figure the record carries now: the decided one, or the request while
  // nothing has been decided. Only a typed figure that differs from it is a
  // budget change -- saving an untouched form is not.
  const currentFigure = activity.approvedBudget === null ? activity.requestedBudget : activity.approvedBudget;
  const decisionBudgetMoves = decision.approvedBudget !== '' && typedBudget !== currentFigure;
  const decisionNote = decision.adminNote.trim();
  const decisionNoteRequired = decisionBudgetMoves || ['Rejected', 'Needs Correction'].includes(decision.status);
  const decisionHasChanges = decisionBudgetMoves || decision.status !== activity.status || Boolean(decisionNote);
  // The Director trimmed the amount, so the record is a budget adjustment
  // rather than a plain approval unless they say otherwise.
  // While the record waits on a decision, that decision is taken with Approve
  // or Reject by the person it names. The Director's own form can then only
  // park or cancel it -- the API refuses anything else. It used to start on
  // Approved, so saving a note approved work over a manager's head.
  const waitingForDecision = decisionIsOpen(activity);
  const statusOptions = [activity.status, ...allowedNextStatuses(activity)]
    .filter((status, index, all) => all.indexOf(status) === index)
    .filter((status) => !waitingForDecision || [activity.status, 'On Hold', 'Cancelled'].includes(status));

  // A manager only ever reads their own working area, so handing them work in
  // another one would leave them assigned to a record they cannot open. The API
  // refuses it; this keeps the unusable names out of the dropdown. Whoever is
  // already on the record stays listed even if their area has since changed, so
  // the cell is never blank.
  const managerOptions = useMemo(() => {
    const sameArea = managers.filter((manager) => manager.coversAllSectors || manager.sector === activity.sector);
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
  // Mirrors the server: a closed month takes no more changes, and work is carried
  // by the manager it names -- or, unassigned, by a manager of its area.
  const monthOpen = activity.planStatus !== 'Closed';
  // Mirrors withinScope in server/lib/http.js: a manager marked as covering every
  // business operation is inside every area, and so has no single `sector` to
  // compare against.
  const inMyArea = Boolean(user.coversAllSectors) || user.sector === activity.sector;
  const carriesIt = inMyArea
    && (activity.assignedTo === null ? user.role === 'manager' : activity.assignedTo === user.id);
  const canAttach = monthOpen && (isDirector
    || (inMyArea && (user.role === 'manager' || activity.assignedTo === user.id)));
  // Whether this user is the person the record is waiting on. The API checks
  // the same thing again before it writes anything.
  const iAmApprover = monthOpen && canApproveRecord(user, activity);
  // Planned work cannot start, or carry spending, until its month is confirmed.
  const monthConfirmed = activity.planStatus !== 'Draft';
  // Only the Director may move a budget as part of a decision; a manager
  // approving work handed to them approves the figure as it stands.
  const canChangeBudget = iAmApprover && isDirector;
  // The one move a manager owns on their own work, mirroring the status route:
  // starting what has been approved.
  const canWorkOnIt = monthOpen && !isDirector && carriesIt;
  const managerCanStart = canWorkOnIt && monthConfirmed && STARTABLE_STATUSES.includes(activity.status)
    && (!activity.approvalRequired || activity.approvalStatus === 'approved');
  const canSubmitCompletion = monthOpen && (isDirector || carriesIt)
    && WORKABLE_STATUSES.includes(activity.status) && !activity.completionSubmittedAt;
  // Mirrors canRecordExpense in server/lib/monthly.js, which is what decides it:
  // the same person who carries the work.
  const canRecordExpense = (isDirector || carriesIt)
    && (!activity.approvalRequired || activity.approvalStatus === 'approved')
    && !['Rejected', 'Cancelled'].includes(activity.status)
    && monthOpen && monthConfirmed;
  // The manager carrying the work says which day they are doing it, while the
  // work is live and its month is open.
  const canSetDate = Boolean(onSchedule) && monthOpen && (isDirector || carriesIt)
    && !['Rejected', 'Cancelled', 'Completed'].includes(activity.status)
    // A day of work already has its day: the manager chose it when they assigned
    // it. Offering the person doing the work a date picker above the job itself
    // put a second thing on the screen competing with the one that matters, for
    // a decision that is not theirs. Moving it is a manager's call, and they can
    // still do it here.
    && !(activity.parentActivityId && activity.scheduledFor && !isDirector && user.role !== 'manager');
  // A draft is sent on by whoever wrote it, or the Director.
  const canSendDraft = monthOpen && activity.status === 'Draft' && (isDirector || activity.createdBy === user.id);
  // The Director may delete; the author may withdraw a request nobody has
  // decided yet. Both mirror the delete route, which also keeps closed months.
  const canWithdraw = !isDirector && activity.createdBy === user.id
    && ['Draft', 'Pending Approval'].includes(activity.status) && activity.approvalStatus === 'pending';
  const canDelete = monthOpen && onDelete && (isDirector || canWithdraw);
  const typedApprovalBudget = Number(approval.approvedBudget || 0);
  const approvalBudgetChanged = canChangeBudget && typedApprovalBudget !== activity.requestedBudget;
  const items = materialLines(activity.materials);
  // Ids are what the trail records; these are the names a reader needs.
  const userNames = useMemo(() => {
    const names = new Map(managers.map((manager) => [String(manager.id), manager.name]));
    if (activity.assignedTo && activity.assignedToName) names.set(String(activity.assignedTo), activity.assignedToName);
    return names;
  }, [managers, activity.assignedTo, activity.assignedToName]);

  const journey = activityJourney(activity);
  // The rate this record was created at, kept on the row as its RWF and CDF
  // equivalents, so every figure below converts the way the request did.
  const rates = activity.requestedBudget > 0 && activity.requestedEquivalent
    ? {
        rwfPerUsd: activity.requestedEquivalent.rwf / activity.requestedBudget,
        cdfPerUsd: activity.requestedEquivalent.cdf / activity.requestedBudget
      }
    : null;
  const handedBack = Boolean(activity.completionSubmittedAt) && activity.status !== 'Completed';
  const assigneeName = activity.assignedToName || t('form.nobodyYet');
  const spentSoFar = expenseSummary ? expenseSummary.totalSpent : expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  const hasProof = evidence.length > 0;
  const canReopen = isDirector && monthOpen && ['Rejected', 'Cancelled'].includes(activity.status);
  const reopenButton = canReopen && <button className="secondary-btn" type="button" disabled={busy} onClick={() => onReopen(activity)}>{t('action.reopen')}</button>;

  // What happens next, and whether it is this reader who does it. Worked out
  // from the same permissions as the buttons further down, so the box never
  // offers a step the API would refuse.
  let next;
  if (!monthOpen) {
    next = { tone: 'muted', title: t('next.monthClosedTitle'), text: t('next.monthClosedText') };
  } else if (activity.status === 'Draft') {
    next = canSendDraft
      ? { tone: 'action', title: t('journey.draft'), text: t('next.draftText'),
        actions: <button className="primary-btn" type="button" disabled={busy} onClick={() => onSendDraft(activity)}>{t('action.submitForApproval')}</button> }
      : { tone: 'info', title: t('journey.draft'), text: t('next.draftOther') };
  } else if (activity.status === 'Rejected') {
    next = { tone: 'stopped', title: t('journey.refused'), text: activity.rejectionReason || activity.adminNote || '', actions: reopenButton };
  } else if (activity.status === 'Cancelled') {
    next = { tone: 'stopped', title: t('journey.cancelled'), text: activity.adminNote || '', actions: reopenButton };
  } else if (activity.status === 'On Hold') {
    next = { tone: 'muted', title: t('journey.paused'), text: t('next.pausedText') };
  } else if (waitingForDecision) {
    next = iAmApprover
      ? { tone: 'action', title: t('next.decideTitle'), text: t('next.decideText'),
        actions: <button className="primary-btn" type="button" onClick={() => goToSection('decision')}>{t('next.goDecide')}</button> }
      : { tone: 'info', title: fill(t('next.waitingFor'), { name: approverName(activity, sectorLabel, t) }), text: t('next.waitingForText') };
  } else if (activity.status === 'Completed') {
    next = { tone: 'done', title: t('journey.done'), text: activity.completedAt ? fill(t('next.doneOn'), { date: formatDateTime(activity.completedAt) }) : '' };
  } else if (handedBack) {
    next = isDirector
      ? { tone: 'action', title: t('next.finalCheckTitle'), text: t('next.finalCheckText'),
        actions: <>
          <button className="primary-btn" type="button" disabled={busy} onClick={() => onFinish(activity)}>{t('action.markDone')}</button>
          <button className="danger-btn outlined" type="button" disabled={busy} onClick={() => onSendBack(activity)}>{t('action.sendBack')}</button>
        </> }
      : { tone: 'info', title: t('next.withDirectorTitle'), text: t('review.completionWithDirector') };
  } else if (!monthConfirmed) {
    next = { tone: 'muted', title: t('next.monthNotConfirmedTitle'), text: t('review.monthNotConfirmed') };
  } else if (['Approved', 'Budget Adjusted'].includes(activity.status)) {
    next = managerCanStart
      ? { tone: 'action', title: t('next.readyTitle'), text: t('next.readyText'),
        actions: <button className="primary-btn" type="button" disabled={busy} onClick={() => onStatus(activity, 'In Progress')}>{t('action.startWork')}</button> }
      : { tone: 'info', title: fill(t('next.readyOther'), { name: assigneeName }), text: '' };
  } else if (carriesIt || (isDirector && canSubmitCompletion)) {
    const sentBack = activity.status === 'Needs Correction';
    next = {
      tone: sentBack ? 'warning' : 'action',
      title: sentBack ? t('journey.sentBack') : t('next.underwayTitle'),
      text: sentBack ? (activity.adminNote || t('review.sentBackToYou')) : t('next.underwayText'),
      actions: <>
        {/* The one that moves the work on, first and filled in. */}
        {!hasProof && canAttach && <button className="primary-btn" type="button" onClick={() => goToSection('proof')}>{t('next.addProof')}</button>}
        {hasProof && canSubmitCompletion && <button className="primary-btn" type="button" disabled={busy} onClick={() => onSubmitCompletion(activity)}>{t('action.submitCompleted')}</button>}
        {canRecordExpense && <button className="secondary-btn" type="button" onClick={() => goToSection('money')}>{t('expense.record')}</button>}
        {hasProof && canAttach && <button className="secondary-btn" type="button" onClick={() => goToSection('proof')}>{t('next.addProof')}</button>}
      </>
    };
  } else {
    next = { tone: 'info', title: fill(t('next.underwayOther'), { name: assigneeName }), text: '' };
  }

  const peopleLine = [
    // Work that was handed out was not requested by the person who wrote it, and
    // saying "Requested by" of an assignment reads as though the assignee asked
    // for their own instructions.
    `${wasAssigned ? t('people.assignedBy') : t('people.requestedBy')}: ${activity.createdByName || '—'}`,
    `${t('people.assignedTo')}: ${activity.assignedToName || t('form.nobodyYet')}`,
    activity.scheduledFor ? `${t('field.activityDate')}: ${formatDate(activity.scheduledFor)}` : null,
    // A day of work is due on the day it happens, so its deadline is the same
    // date printed twice. Only a deadline that says something different is shown.
    activity.deadline && activity.deadline !== activity.scheduledFor
      ? `${t('table.deadline')}: ${formatDate(activity.deadline)}` : null
  ].filter(Boolean).join(' · ');

  return <section className="panel detail-panel activity-review record">
    <div className="panel-header record-header">
      <div>
        {/* A day of work says what it is towards. Without it the person it was
            handed to opens "Clear the scrub on plots 1-3" with no idea which
            activity it serves or why it matters -- and the eyebrow claimed the
            Director had assigned it when it was their own manager. */}
        <span className="eyebrow">{sectorLabel(activity.sector)} · {activity.parentActivityName
          ? t('review.dayOfWork')
          : (wasAssigned ? t('review.assignedActivity') : t('review.activityReview'))}</span>
        <h2>{activity.activity}</h2>
        {activity.parentActivityName && <p className="towards-line">
          {fill(t('review.towards'), { activity: activity.parentActivityName })}
        </p>}
        {/* What the work is, in the words of whoever set it. It was only in the
            folded "details" section, which is the last place somebody standing in
            a field is going to look. */}
        {activity.description && <p className="record-brief">{activity.description}</p>}
        <span>{peopleLine}{due && due.tone !== 'ok' && <small className={`deadline-flag deadline-${due.tone}`}>{due.text}</small>}</span>
      </div>
      <button className="text-btn hide-on-sheet" type="button" onClick={onClose}>{t('action.close')}</button>
    </div>

    <Journey journey={journey} />

    <NextStep tone={next.tone} title={next.title} actions={next.actions}>{next.text}</NextStep>

    {canSetDate && <form className="work-date" onSubmit={(event) => { event.preventDefault(); onSchedule(activity, workDate); }}>
      <label className="form-field">
        <span>{t('review.whenWillYouDoIt')}</span>
        <input type="date" value={workDate} onChange={(event) => setWorkDate(event.target.value)} />
      </label>
      <button className="secondary-btn" type="submit" disabled={busy || (workDate || '') === (activity.scheduledFor || '')}>
        {t('action.saveDate')}
      </button>
    </form>}

    <MoneyBar
      approved={activity.approvedBudget}
      requested={activity.requestedBudget}
      spent={spentSoFar}
      format={formatUsd}
      rates={rates}
      extra={<p className="money-note">
        {activity.approvedBudget === null
          ? null
          : activity.budgetAdjustment
            ? fill(t('money.changedFrom'), { amount: formatUsd(activity.requestedBudget), change: `${activity.budgetAdjustment > 0 ? '+' : ''}${formatUsd(activity.budgetAdjustment)}` })
            : null}
      </p>}
    />

    <Section id="details" title={t('section.details')} defaultOpen>
      <div className="detail-facts">
        <Fact label={t('field.project')} value={activity.projectName || activity.projectId} />
        <Fact label={t('table.category')} value={categoryLabel(activity.category, t)} />
        <Fact label={t('field.quantity')} value={activity.quantity} />
        <Fact label={t('field.activityDate')} value={activity.scheduledFor
          ? formatDate(activity.scheduledFor)
          : <span className="muted-cell">{t('review.noActivityDate')}</span>} />
        <Fact label={t('table.deadline')} value={activity.deadline
          ? <>{formatDate(activity.deadline)}{due && due.tone !== 'ok' && <small className={`deadline-flag deadline-${due.tone}`}>{due.text}</small>}</>
          : <span className="muted-cell">{t('review.noDeadline')}</span>} />
        <Fact label={t('people.requestedBy')} value={activity.createdByName || '—'} />
        <Fact label={t('people.assignedTo')} value={activity.assignedToName || <span className="muted-cell">{t('review.notAssigned')}</span>} />
      </div>
      {activity.instructions && <>
        <h3 className="form-section-title">{t('review.instructionsFromDirector')}</h3>
        <p className="detail-notes admin-note">{activity.instructions}</p>
      </>}
      <h3 className="form-section-title">{wasAssigned ? t('review.activityDetails') : t('review.requestDetails')}</h3>
      <p className="detail-notes">{activity.description || t('review.noDescription')}</p>
      {items.length > 0 && <ul className="material-list">{items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>}
      {activity.adminNote && <p className="detail-notes admin-note"><strong>{t('review.directorNote')}:</strong> &ldquo;{activity.adminNote}&rdquo;</p>}
      <ApprovalPanel record={activity} sectorLabel={sectorLabel} />
    </Section>

    {/* The decision this record is waiting on, taken by the person it names.
        Drawn only for that person; the API refuses anybody else regardless. It
        comes after the details and the money, which are what is being decided. */}
    {iAmApprover && <form id="decision" className="decision-form approval-form" onSubmit={(event) => {
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
          <input type="number" inputMode="decimal" min="0" step="0.01" value={approval.approvedBudget}
            onChange={(event) => setApproval({ ...approval, approvedBudget: event.target.value })} />
        </label>}
        <label className="form-field form-field-wide">
          <span>{isDirector ? t('review.directorNote') : t('field.note')} ({approvalBudgetChanged ? t('field.required') : t('field.optional')})</span>
          <textarea rows="2" required={approvalBudgetChanged}
            value={approval.adminNote} onChange={(event) => setApproval({ ...approval, adminNote: event.target.value })} />
        </label>
      </div>
      {approvalBudgetChanged && <p className="decision-hint">
        {formatUsd(activity.requestedBudget)} &rarr; {formatUsd(typedApprovalBudget)}
        {' '}({typedApprovalBudget - activity.requestedBudget > 0 ? '+' : ''}
        {formatUsd(typedApprovalBudget - activity.requestedBudget)})
      </p>}
      <div className="form-submit-bar">
        <button className="primary-btn" type="submit" disabled={busy}>{t('approval.approve')}</button>
        {/* The reason is asked for in its own dialog, the same one the queue uses. */}
        <button className="danger-btn outlined" type="button" disabled={busy} onClick={() => onReject(activity)}>{t('approval.reject')}</button>
      </div>
    </form>}

    {/* What was actually spent against this activity, and asking for more. */}
    {onRecordExpense && <Section id="money" title={t('section.money')} count={expenses.length || null}
      defaultOpen={canRecordExpense || expenses.length > 0}>
      <ExpensePanel
        activity={activity}
        expenses={expenses}
        summary={expenseSummary}
        showSummary={false}
        canRecord={canRecordExpense}
        canRemove={isDirector && monthOpen}
        busy={busy}
        // The panel hands back only the expense; the handlers also need to know
        // which activity it belongs to, exactly like the evidence handlers below.
        onRecord={(expense, reset, receipts) => onRecordExpense(activity, expense, reset, receipts)}
        onRemoveExpense={(expense) => onRemoveExpense(activity, expense)}
      />
      <BudgetRequestPanel
        activity={activity}
        requests={budgetRequests}
        user={user}
        isDirector={isDirector}
        monthOpen={monthOpen}
        busy={busy}
        onRequest={onRequestBudget ? (body) => onRequestBudget(activity, body) : null}
        onDecide={onDecideBudget ? (request, status) => onDecideBudget(activity, request, status) : null}
      />
    </Section>}

    {/* Proof money was spent, and proof the work was done: different things,
        uploaded and listed separately. */}
    <Section id="proof" title={t('section.proof')} count={evidence.length || null}
      defaultOpen={canAttach && ['In Progress', 'Needs Correction'].includes(activity.status)}>
      {/* One uploader, not two. There used to be a form under "Receipts" and an
          identical one under "Photos of the work", each with its own Take a
          photo / Choose files / Upload -- six buttons for one job, on a screen
          that already had nine. What it is for is now a question inside the one
          form, which is the only thing that actually differed between them. */}
      {canAttach && <EvidenceUpload
        expenses={expenses}
        busy={busy}
        onUpload={(formData) => onUpload(activity, formData)}
      />}

      <h3 className="form-section-title">{t('evidence.payment')}</h3>
      <p className="detail-notes muted-cell">{t('evidence.paymentHint')}</p>
      <EvidenceList
        activity={activity}
        evidence={paymentEvidence}
        onOpenFile={onOpenFile}
        canRemove={isDirector && monthOpen}
        busy={busy}
        onRemove={(item) => onRemoveEvidence(activity, item)}
      />

      <h3 className="form-section-title">{t('evidence.activity')}</h3>
      <p className="detail-notes muted-cell">{t('evidence.activityHint')}</p>
      <EvidenceList
        activity={activity}
        evidence={completionEvidence}
        onOpenFile={onOpenFile}
        canRemove={isDirector && monthOpen}
        busy={busy}
        onRemove={(item) => onRemoveEvidence(activity, item)}
      />
    </Section>

    {/* The Director's wider controls, folded away: changing status or budget
        outside the normal steps, handing the work to someone else, what
        partners see, and deleting. */}
    {isDirector && monthOpen && <Section id="director-tools" title={t('section.directorTools')}>
      <form className="decision-form" onSubmit={(event) => {
        event.preventDefault();
        // Only what actually changed travels, so an untouched budget is never
        // mistaken for a budget change that needs its own reason.
        onDecision(activity, {
          status: decision.status,
          ...(decisionBudgetMoves ? { approvedBudget: typedBudget } : {}),
          ...(decisionNote ? { adminNote: decisionNote } : {})
        });
      }}>
        <h3 className="form-section-title">{t('review.adminDecision')}</h3>
        <div className="form-grid">
          <label className="form-field"><span>{t('review.approvedBudgetUsd')}</span>
            <input type="number" inputMode="decimal" min="0" step="0.01" value={decision.approvedBudget} disabled={waitingForDecision}
              onChange={(event) => setDecision({ ...decision, approvedBudget: event.target.value })} />
          </label>
          <label className="form-field"><span>{t('table.status')}</span>
            <select value={decision.status} onChange={(event) => setDecision({ ...decision, status: event.target.value })}>
              {statusOptions.map((status) => <option key={status} value={status}>{t(`status.${status}`)}</option>)}
            </select>
          </label>
          <label className="form-field form-field-wide"><span>{t('review.adminNote')} ({decisionNoteRequired ? t('field.required') : t('field.optional')})</span>
            <textarea rows="3" required={decisionNoteRequired}
              value={decision.adminNote} onChange={(event) => setDecision({ ...decision, adminNote: event.target.value })} />
          </label>
        </div>
        {typedBudget !== activity.requestedBudget && <p className="decision-hint">
          {formatUsd(activity.requestedBudget)} &rarr; {formatUsd(typedBudget)}
          {' '}({typedAdjustment > 0 ? '+' : ''}{formatUsd(typedAdjustment)}).
        </p>}
        {waitingForDecision && <p className="decision-hint">{t('review.decisionFirst')}</p>}
        {decision.status === 'Needs Correction' && <p className="decision-hint">{t('review.needsCorrectionHint')}</p>}
        <div className="form-submit-bar">
          <button className="primary-btn" type="submit" disabled={busy || !decisionHasChanges}>{t('action.saveDecision')}</button>
        </div>
      </form>

      {/* Who carries the work out, by when, and on what terms. */}
      <form className="decision-form assignment-form" onSubmit={(event) => {
        event.preventDefault();
        onAssign(activity, assignmentChanges);
      }}>
        <h3 className="form-section-title">{t('review.assignment')}</h3>
        <div className="form-grid">
          <label className="form-field"><span>{t('people.assignedTo')}</span>
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
        {/* Only an undecided hand-over moves to the new manager's queue; work
            already accepted simply changes hands. */}
        {assignmentChanges.assignedTo !== undefined && waitingForDecision && activity.approvalRequiredRole === 'manager' && <p className="decision-hint">{t('review.reassignClearsAcceptance')}</p>}
        <div className="form-submit-bar">
          <button className="secondary-btn" type="submit" disabled={busy || !hasAssignmentChanges}>{t('action.saveAssignment')}</button>
        </div>
      </form>

      {/* What leaves the organisation. An external partner assigned to this
          business operation sees an approved record unless it is switched off
          here; evidence, internal notes and the trail are never shared. */}
      {onVisibility && <div className="visibility-control">
        <div>
          <span className="eyebrow">{t('review.externalVisibility')}</span>
          <strong className={activity.externallyVisible ? 'tone-done' : 'tone-stopped'}>
            {activity.externallyVisible ? t('visibility.visible') : t('visibility.hidden')}
          </strong>
          <small>{activity.approvalStatus === 'approved' ? t('visibility.note') : t('visibility.notApprovedYet')}</small>
        </div>
        <button
          className={activity.externallyVisible ? 'danger-btn outlined' : 'secondary-btn'}
          type="button"
          disabled={busy}
          onClick={() => onVisibility(activity, !activity.externallyVisible)}
        >{activity.externallyVisible ? t('visibility.hide') : t('visibility.show')}</button>
      </div>}

      {canDelete && <div className="button-row danger-zone">
        <button className="danger-btn outlined" type="button" disabled={busy} onClick={() => onDelete(activity)}>{t('action.delete')}</button>
      </div>}
    </Section>}

    {canDelete && !isDirector && <div className="button-row danger-zone">
      <button className="danger-btn outlined" type="button" disabled={busy} onClick={() => onDelete(activity)}>{t('action.withdrawRequest')}</button>
    </div>}

    <Section id="history" title={t('review.activityHistory')} count={history.length || null}>
      {history.length
        ? <ul className="history-list">{history.map((entry) => <li key={entry.id}>
          <strong>{trailActionLabel(entry.action, t)}</strong>
          {entry.field && <span>
            {' '}{labelForField(entry.field, t)}: {formatTrailValue(entry.field, entry.oldValue, userNames, t)} &rarr; {formatTrailValue(entry.field, entry.newValue, userNames, t)}
          </span>}
          <small>{entry.actorName || '—'} · {formatDateTime(entry.createdAt)}</small>
          {entry.note && <small className="justification">{t('approval.reason')}: {trailNoteLabel(entry.note, t)}</small>}
        </li>)}</ul>
        : <div className="empty-state"><strong>{t('empty.noHistory')}</strong><span>{t('empty.noHistoryHint')}</span></div>}
    </Section>
  </section>;
}

// An audit trail entry names its action in the English the server recorded it
// in. Known actions read in the viewer's language; anything else is shown as
// recorded rather than as a missing-key placeholder.
export function trailActionLabel(action, t) {
  const key = `history.${action}`;
  const label = t(key);
  return label === key ? action : label;
}

// A category preset is stored in English (it is what the API validates and the
// reports group by) and read in the viewer's language. A category typed under
// "Other" has no translation and is shown as written.
export function categoryLabel(category, t) {
  if (!category) return '';
  const key = `category.${category}`;
  const label = t(key);
  return label === key ? category : label;
}

// A value from the trail, in words: statuses and decisions in the reader's
// language, everything else through the formatter below.
function translatedTrailValue(field, value, t) {
  if (value === null || value === undefined || value === '') return null;
  const lookups = { status: 'status', approvalStatus: 'approval', evidenceStatus: 'estatus', category: 'category' };
  if (lookups[field]) {
    const key = `${lookups[field]}.${value}`;
    const label = t(key);
    return label === key ? null : label;
  }
  if (field === 'externallyVisible') return String(value) === 'true' ? t('visibility.visible') : t('visibility.hidden');
  return null;
}

// Notes the server writes itself (rather than a person) read in the viewer's
// language too.
export function trailNoteLabel(note, t) {
  const key = `approval.note.${note}`;
  const label = t(key);
  return label === key ? note : label;
}

// The audit trail records a column name; these are the words a reader needs.
export function labelForField(field, t) {
  const key = `trail.${field}`;
  const label = t(key);
  // translate() falls back to the key itself, which is not worth showing.
  return label === key ? field : label;
}

export function formatTrailValue(field, value, userNames, t) {
  if (value === null || value === undefined || value === '') return '—';
  const translated = t ? translatedTrailValue(field, value, t) : null;
  if (translated) return translated;
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

// Statuses with an approved budget that can still be changed. Mirrors
// BUDGET_CHANGEABLE_STATUSES in server/routes/activities.js.
const BUDGET_CHANGEABLE_STATUSES = ['Approved', 'Budget Adjusted', 'In Progress', 'Needs Correction', 'On Hold', 'Completed'];

function BudgetRequestPanel({ activity, requests, user, isDirector, monthOpen, busy, onRequest, onDecide }) {
  const t = useT();
  const currentBudget = activity.approvedBudget === null ? activity.requestedBudget : activity.approvedBudget;
  const [form, setForm] = useState({ amount: '', reason: '' });
  const pending = requests.find((request) => request.status === 'Pending');
  const mayAsk = Boolean(onRequest) && monthOpen && !isDirector && user.role === 'manager'
    && (Boolean(user.coversAllSectors) || user.sector === activity.sector)
    && BUDGET_CHANGEABLE_STATUSES.includes(activity.status) && !pending;
  const typed = Number(form.amount);
  const valid = form.amount !== '' && Number.isFinite(typed) && typed >= 0
    && Math.round(typed * 100) !== Math.round(currentBudget * 100) && form.reason.trim();

  if (!requests.length && !mayAsk) return null;

  return <section id="budget-requests">
    <h3 className="form-section-title">{t('budget.title')}</h3>
    {requests.length > 0 && <ul className="history-list">{requests.map((request) => <li key={request.id}>
      <strong>
        {formatUsd(request.currentBudget)} &rarr; {formatUsd(request.requestedAmount)}
        {' '}<span className={`status-badge ${request.status === 'Approved' ? 'tone-done' : request.status === 'Declined' ? 'tone-stopped' : 'tone-waiting'}`}>
          {request.status === 'Pending' ? t('budget.pending') : t(`budgetRequest.status.${request.status}`)}
        </span>
      </strong>
      <span>{request.reason}</span>
      <small>{request.requestedByName || '—'} · {formatDateTime(request.createdAt)}</small>
      {request.decisionNote && <small className="justification">{request.decidedByName || '—'}: {request.decisionNote}</small>}
      {isDirector && monthOpen && onDecide && request.status === 'Pending' && <div className="button-row">
        <button className="primary-btn compact" type="button" disabled={busy} onClick={() => onDecide(request, 'Approved')}>{t('approval.approve')}</button>
        <button className="danger-btn outlined compact" type="button" disabled={busy} onClick={() => onDecide(request, 'Declined')}>{t('action.decline')}</button>
      </div>}
    </li>)}</ul>}

    {mayAsk && <form className="decision-form" onSubmit={(event) => {
      event.preventDefault();
      if (!valid) return;
      Promise.resolve(onRequest({ amount: typed, reason: form.reason.trim() })).then((sent) => {
        if (sent) setForm({ amount: '', reason: '' });
      });
    }}>
      <p className="detail-notes">{t('budget.hint')}</p>
      <div className="form-grid">
        <label className="form-field"><span>{t('budget.currentBudget')}</span>
          <input readOnly tabIndex={-1} value={formatUsd(currentBudget)} />
        </label>
        <label className="form-field"><span>{t('budget.newAmount')} (USD)</span>
          <input required type="number" inputMode="decimal" min="0" step="0.01" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} />
        </label>
        <label className="form-field form-field-wide"><span>{t('field.reason')}</span>
          <textarea required rows="2" value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
        </label>
      </div>
      <div className="form-submit-bar"><button className="secondary-btn" type="submit" disabled={busy || !valid}>{t('budget.request')}</button></div>
    </form>}
    {pending && !isDirector && <p className="decision-hint">{t('budget.waiting')}</p>}
  </section>;
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

// Adding receipts or photographs. The amount field that used to sit here is
// gone: it was stored on the first file only and never fed the budget, while
// the expense itself carries the amount. A receipt is linked to an expense --
// the most recent one without a receipt is suggested -- so the month's review
// can count expenses that have their paperwork.
export function EvidenceUpload({ onUpload, expenses = [], busy = false }) {
  const t = useT();
  // What the file is for. This was the only real difference between the two
  // forms this replaces, so it is the first question rather than a heading the
  // reader had to notice they were underneath.
  const [evidenceType, setEvidenceType] = useState('payment');
  const [kind, setKind] = useState('Receipt');
  const suggestedId = expenses.find((expense) => !expense.evidenceCount)?.id;
  const [expenseId, setExpenseId] = useState(suggestedId ? String(suggestedId) : '');
  const [note, setNote] = useState('');
  const [files, setFiles] = useState([]);
  // Once the reader has picked an expense -- or "not for an expense" -- a newly
  // recorded expense no longer moves the choice under them.
  const [picked, setPicked] = useState(false);

  useEffect(() => {
    if (!picked) setExpenseId(suggestedId ? String(suggestedId) : '');
  }, [suggestedId, picked]);

  const submit = (event) => {
    event.preventDefault();
    if (!files.length) return;
    const formData = new FormData();
    formData.append('kind', kind);
    formData.append('note', note);
    formData.append('evidenceType', evidenceType);
    if (evidenceType === 'payment' && expenseId) formData.append('expenseId', expenseId);
    files.forEach((file) => formData.append('files', file));
    // Cleared only once the files are stored. A failed upload keeps what was
    // chosen, so it can be tried again without picking every file a second time.
    Promise.resolve(onUpload(formData)).then((stored) => {
      if (stored === false) return;
      setNote(''); setFiles([]); setPicked(false);
    });
  };

  const chooseType = (next) => {
    setEvidenceType(next);
    // The commonest kind for each, so most people never touch the second box.
    setKind(next === 'activity' ? 'Photograph' : 'Receipt');
  };

  return <form className="decision-form evidence-upload" onSubmit={submit}>
    <FilePicker files={files} onChange={setFiles} disabled={busy} />
    <div className="form-grid">
      <label className="form-field"><span>{t('evidence.whatIsThisFor')}</span>
        <select value={evidenceType} onChange={(event) => chooseType(event.target.value)}>
          <option value="payment">{t('evidence.forMoney')}</option>
          <option value="activity">{t('evidence.forWork')}</option>
        </select>
      </label>
      <label className="form-field"><span>{t('field.evidenceType')}</span>
        <select value={kind} onChange={(event) => setKind(event.target.value)}>{EVIDENCE_KINDS.map((option) => <option key={option} value={option}>{t(`ekind.${option}`)}</option>)}</select>
      </label>
      {evidenceType === 'payment' && expenses.length > 0 && <label className="form-field"><span>{t('expense.attachEvidence')}</span>
        <select value={expenseId} onChange={(event) => { setPicked(true); setExpenseId(event.target.value); }}>
          <option value="">{t('evidence.notForExpense')}</option>
          {expenses.map((expense) => <option key={expense.id} value={expense.id}>
            {expense.spentOn} · {formatUsd(expense.amount)} · {expense.description.slice(0, 40)}
          </option>)}
        </select>
      </label>}
      <label className="form-field form-field-wide"><span>{t('field.note')} ({t('field.optional')})</span>
        <input placeholder={t('evidence.notePlaceholder')} value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
    </div>
    <div className="form-submit-bar">
      <button className="primary-btn" type="submit" disabled={busy || !files.length}>{t('action.uploadEvidence')}</button>
    </div>
  </form>;
}

export function EvidenceList({ activity, evidence, onOpenFile, canRemove, busy = false, onRemove }) {
  const t = useT();
  if (!evidence.length) {
    return <div className="empty-state"><strong>{t('empty.noEvidence')}</strong><span>{t('empty.noEvidenceHint')}</span></div>;
  }
  return <div className="table-wrap"><table className="card-table">
    <thead><tr><th>{t('field.file')}</th><th>{t('field.type')}</th><th>{t('field.amount')}</th><th>{t('field.note')}</th><th>{t('field.uploadedBy')}</th><th>{t('table.date')}</th><th>{t('table.actions')}</th></tr></thead>
    <tbody>{evidence.map((item) => <tr key={item.id}>
      <td className="card-title-cell"><strong className="file-name">{item.originalName}</strong><small>{(item.sizeBytes / 1024).toFixed(0)} KB · {item.mimeType}</small></td>
      <td data-label={t('field.type')}>{t(`ekind.${item.kind}`)}</td>
      <td data-label={t('field.amount')}>{item.amount ? formatUsd(item.amount) : '—'}</td>
      <td data-label={t('field.note')}>{item.note || '—'}</td>
      <td data-label={t('field.uploadedBy')}>{item.uploadedByName || '—'}</td>
      <td data-label={t('table.date')}>{formatDateTime(item.createdAt)}</td>
      <td className="card-actions">
        {/* Opened through a short-lived file link asked for on the click; the
            session token never goes into an address. */}
        <button className="text-btn" type="button"
          onClick={() => onOpenFile(`/api/activities/${encodeURIComponent(activity.id)}/evidence/${item.id}/file`)}>{t('action.view')}</button>
        {canRemove && <button className="danger-btn" type="button" disabled={busy} onClick={() => onRemove(item)}>{t('action.remove')}</button>}
      </td>
    </tr>)}</tbody>
  </table></div>;
}

export default ActivityReview;
