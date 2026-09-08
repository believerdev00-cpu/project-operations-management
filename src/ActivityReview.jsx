import { useEffect, useMemo, useState } from 'react';

// The Director's review screen for one activity, and the same record as the
// manager sees it -- whether they raised it themselves or the Director handed
// it to them: the request or the assignment, the decision taken on it, the
// evidence returned, and the trail of every change.

// Mirrors ACTIVITY_STATUSES in server/db/activitySchema.js.
export const ACTIVITY_STATUSES = [
  'Assigned', 'Accepted', 'Pending Review', 'Approved', 'Budget Adjusted',
  'In Progress', 'Needs Correction', 'Completed', 'Rejected', 'On Hold'
];

// What the Director can move a record to from where it stands now. Mirrors
// STATUS_FLOW in server/routes/activities.js, which is what actually enforces it.
const STATUS_FLOW = {
  Assigned: ['Accepted', 'In Progress', 'Budget Adjusted', 'On Hold', 'Rejected'],
  Accepted: ['In Progress', 'Budget Adjusted', 'On Hold', 'Rejected'],
  'Pending Review': ['Approved', 'Budget Adjusted', 'Rejected', 'On Hold'],
  Approved: ['In Progress', 'Completed', 'Needs Correction', 'Budget Adjusted', 'On Hold', 'Rejected'],
  'Budget Adjusted': ['In Progress', 'Completed', 'Needs Correction', 'Approved', 'On Hold', 'Rejected'],
  'In Progress': ['Completed', 'Needs Correction', 'Budget Adjusted', 'On Hold', 'Rejected'],
  'Needs Correction': ['In Progress', 'Completed', 'Budget Adjusted', 'On Hold', 'Rejected'],
  Completed: ['In Progress', 'Needs Correction'],
  Rejected: ['Pending Review', 'Assigned'],
  'On Hold': ['Assigned', 'Accepted', 'Pending Review', 'Approved', 'Budget Adjusted', 'In Progress', 'Rejected']
};

export const EVIDENCE_KINDS = ['Receipt', 'Invoice', 'Fuel Slip', 'Delivery Note', 'Payment Proof', 'Photograph', 'Other'];

// The statuses a manager may hand finished work back from, and the ones they
// may start work from. Both mirror server/routes/activities.js.
const WORKABLE_STATUSES = ['Accepted', 'Approved', 'Budget Adjusted', 'In Progress', 'Needs Correction'];
const STARTABLE_STATUSES = ['Accepted', 'Approved', 'Budget Adjusted', 'Needs Correction'];
// A deadline on a record that is finished or refused is history, not a warning.
const CLOSED_STATUSES = ['Completed', 'Rejected'];

export function statusTone(status) {
  if (status === 'Completed' || status === 'Approved') return 'tone-done';
  if (status === 'Rejected') return 'tone-stopped';
  if (['Pending Review', 'On Hold', 'Assigned', 'Needs Correction'].includes(status)) return 'tone-waiting';
  return 'tone-active';
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
export function deadlineNote(activity) {
  const parts = dateParts(activity.deadline);
  if (!parts || CLOSED_STATUSES.includes(activity.status)) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(parts[0], parts[1] - 1, parts[2]) - today) / 86400000);
  if (days < 0) return { tone: 'overdue', text: `${-days} day${days === -1 ? '' : 's'} overdue` };
  if (days === 0) return { tone: 'due-soon', text: 'Due today' };
  if (days <= 3) return { tone: 'due-soon', text: `Due in ${days} day${days === 1 ? '' : 's'}` };
  return { tone: 'ok', text: `Due in ${days} days` };
}

// The materials arrive as free text, one item per line. Bullets are only a
// presentation of that; the stored value stays exactly what was typed.
function materialLines(materials) {
  return String(materials || '')
    .split('\n')
    .map((line) => line.replace(/^[\s•\-*]+/, '').trim())
    .filter(Boolean);
}

export function ActivityReview({
  detail, user, token, sectorLabel, managers = [],
  onClose, onDecision, onStatus, onAssign, onUpload, onRemoveEvidence, onSubmitCompletion
}) {
  const { activity, evidence, history } = detail;
  const isDirector = user.role === 'super-admin';
  // Which way round the record was created. An assigned activity is the
  // Director's instruction to a manager; a requested one is the manager asking.
  const wasAssigned = activity.origin === 'assigned';

  const [decision, setDecision] = useState({
    approvedBudget: activity.approvedBudget === null ? String(activity.requestedBudget) : String(activity.approvedBudget),
    status: activity.status === 'Pending Review' ? 'Approved' : activity.status,
    adminNote: activity.adminNote || ''
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
      status: activity.status === 'Pending Review' ? 'Approved' : activity.status,
      adminNote: activity.adminNote || ''
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

  const due = deadlineNote(activity);
  const canAttach = isDirector || user.sector === activity.sector;
  // The moves a manager owns on their own work, mirroring the status route:
  // accepting what they were handed, and starting it.
  const canWorkOnIt = !isDirector && user.sector === activity.sector
    && (activity.assignedTo === null || activity.assignedTo === user.id);
  const canAccept = canWorkOnIt && activity.status === 'Assigned';
  const managerCanStart = canWorkOnIt && STARTABLE_STATUSES.includes(activity.status);
  const canSubmitCompletion = canAttach && WORKABLE_STATUSES.includes(activity.status);
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
        <span className="eyebrow">{wasAssigned ? 'ASSIGNED ACTIVITY' : 'ACTIVITY REVIEW'}</span>
        <h2>{sectorLabel(activity.sector)} &mdash; {activity.activity}</h2>
        <span>
          {wasAssigned
            ? `Assigned by ${activity.createdByName || 'the Director'} to ${activity.assignedToName || 'nobody yet'}`
            : `Submitted by ${activity.createdByName || 'Unknown'}`} · {sectorLabel(activity.sector)} ·
          {' '}{formatDateTime(activity.createdAt)} · {activity.projectName || activity.projectId}
        </span>
      </div>
      <button className="text-btn" type="button" onClick={onClose}>Close</button>
    </div>

    <div className="detail-facts">
      <Fact label="Status" value={<span className={`status-badge ${statusTone(activity.status)}`}>{activity.status}</span>} />
      <Fact label="Category" value={activity.category} />
      <Fact label="Quantity" value={activity.quantity} />
      <Fact label="Carried out by" value={activity.assignedToName || <span className="muted-cell">Not assigned</span>} />
      <Fact label="Deadline" value={activity.deadline
        ? <>{formatDate(activity.deadline)}{due && due.tone !== 'ok' && <small className={`deadline-flag deadline-${due.tone}`}>{due.text}</small>}</>
        : <span className="muted-cell">No deadline</span>} />
      <Fact label="Accepted" value={activity.acceptedAt ? formatDateTime(activity.acceptedAt) : <span className="muted-cell">Not accepted yet</span>} />
      <Fact label="Evidence" value={<span className={`status-badge ${activity.evidenceStatus === 'Complete' ? 'tone-done' : 'tone-waiting'}`}>{activity.evidenceStatus}</span>} />
      <Fact label="Reviewed by" value={activity.reviewedByName ? `${activity.reviewedByName} · ${formatDateTime(activity.reviewedAt)}` : 'Not yet reviewed'} />
      <Fact label="Completion submitted" value={activity.completionSubmittedAt ? formatDateTime(activity.completionSubmittedAt) : 'Not submitted'} />
    </div>

    {activity.instructions && <>
      <h3 className="form-section-title">Instructions from the Director</h3>
      <p className="detail-notes admin-note">{activity.instructions}</p>
    </>}

    <h3 className="form-section-title">{wasAssigned ? 'Activity details' : 'Request details'}</h3>
    <p className="detail-notes">{activity.description || 'No description was given.'}</p>
    {items.length
      ? <ul className="material-list">{items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
      : <p className="detail-notes muted-cell">No itemised materials were listed.</p>}

    <div className="budget-strip">
      <div className="budget-block">
        <span>{wasAssigned ? 'Budget set at assignment' : 'Requested budget'}</span>
        <strong>{formatUsd(activity.requestedBudget)}</strong>
        <small>{formatLocal(activity.requestedEquivalent.rwf, 'RWF')} · {formatLocal(activity.requestedEquivalent.cdf, 'CDF')}</small>
      </div>
      <div className="budget-block">
        <span>Approved budget</span>
        <strong>{activity.approvedBudget === null ? 'Not decided' : formatUsd(activity.approvedBudget)}</strong>
        <small>{activity.approvedEquivalent
          ? `${formatLocal(activity.approvedEquivalent.rwf, 'RWF')} · ${formatLocal(activity.approvedEquivalent.cdf, 'CDF')}`
          : 'Awaiting the Director'}</small>
      </div>
      <div className={`budget-block${activity.budgetAdjustment ? ' budget-adjusted' : ''}`}>
        <span>Budget adjustment</span>
        <strong>{activity.budgetAdjustment === null
          ? '—'
          : `${activity.budgetAdjustment > 0 ? '+' : ''}${formatUsd(activity.budgetAdjustment)}`}</strong>
        <small>{activity.budgetAdjustment
          ? 'The budget was changed on review'
          : `Unchanged since it was ${wasAssigned ? 'assigned' : 'requested'}`}</small>
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
        <h3 className="form-section-title">Admin decision</h3>
        <div className="form-grid">
          <label className="form-field"><span>Approved budget (USD)</span>
            <input type="number" min="0" step="0.01" value={decision.approvedBudget}
              onChange={(event) => setDecision({ ...decision, approvedBudget: event.target.value })} />
          </label>
          <label className="form-field"><span>Status</span>
            <select value={decision.status} onChange={(event) => setDecision({ ...decision, status: event.target.value })}>
              {statusOptions.map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
          </label>
          <label className="form-field form-field-wide"><span>Admin note{typedBudget !== activity.requestedBudget || ['Rejected', 'Needs Correction'].includes(decision.status) ? ' (required)' : ''}</span>
            <textarea rows="3" placeholder="e.g. We will do the rest next month. Use the approved amount for the materials needed now."
              value={decision.adminNote} onChange={(event) => setDecision({ ...decision, adminNote: event.target.value })} />
          </label>
        </div>
        {typedBudget !== activity.requestedBudget && <p className="decision-hint">
          {formatUsd(activity.requestedBudget)} {wasAssigned ? 'set' : 'requested'} &rarr; {formatUsd(typedBudget)} approved
          {' '}({typedAdjustment > 0 ? '+' : ''}{formatUsd(typedAdjustment)}).
          {suggestsAdjusted ? ' Consider recording this as Budget Adjusted.' : ''}
        </p>}
        {decision.status === 'Needs Correction' && <p className="decision-hint">
          This sends the work back to {activity.assignedToName || 'the manager'}, who corrects it and submits it again. Say what needs correcting.
        </p>}
        <button className="primary-btn" type="submit">Save decision</button>
      </form>
      : <div className="decision-readout">
        <h3 className="form-section-title">Admin decision</h3>
        {activity.approvedBudget === null
          ? <p className="detail-notes">This request has not been decided yet. You will see the approved budget and the Director&rsquo;s note here.</p>
          : <>
            <p className="detail-notes"><strong>Approved budget:</strong> {formatUsd(activity.approvedBudget)}
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
      <h3 className="form-section-title">Assignment</h3>
      <div className="form-grid">
        <label className="form-field"><span>Carried out by</span>
          <select value={assignment.assignedTo} onChange={(event) => setAssignment({ ...assignment, assignedTo: event.target.value })}>
            <option value="">Nobody yet</option>
            {managerOptions.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}
          </select>
        </label>
        <label className="form-field"><span>Deadline</span>
          <input type="date" value={assignment.deadline}
            onChange={(event) => setAssignment({ ...assignment, deadline: event.target.value })} />
        </label>
        <label className="form-field form-field-wide"><span>Instructions</span>
          <textarea rows="3" placeholder="e.g. Buy the hoes from the Kigali supplier and keep every receipt."
            value={assignment.instructions} onChange={(event) => setAssignment({ ...assignment, instructions: event.target.value })} />
        </label>
      </div>
      {!managerOptions.length && <p className="decision-hint">
        No manager covers {sectorLabel(activity.sector)} yet. Add one under User management before handing this work over.
      </p>}
      {assignmentChanges.assignedTo !== undefined && activity.acceptedAt && <p className="decision-hint">
        Handing this to someone else clears the acceptance, so the new manager has to accept it themselves.
      </p>}
      <button className="secondary-btn" type="submit" disabled={!hasAssignmentChanges}>Save assignment</button>
    </form>}

    {(canAccept || managerCanStart || canSubmitCompletion) && <div className="workflow-actions button-row">
      {canAccept && <button className="primary-btn" type="button" onClick={() => onStatus(activity, 'Accepted')}>Accept this work</button>}
      {managerCanStart && <button className="secondary-btn" type="button" onClick={() => onStatus(activity, 'In Progress')}>Start the work</button>}
      {canSubmitCompletion && <>
        <input className="completion-note" placeholder="Note for the Director (optional)"
          value={completionNote} onChange={(event) => setCompletionNote(event.target.value)} />
        <button className="secondary-btn" type="button" onClick={() => onSubmitCompletion(activity, completionNote)}>
          Submit as completed
        </button>
      </>}
    </div>}
    {canAccept && <p className="decision-hint">
      The Director assigned this to you{activity.deadline ? ` for ${formatDate(activity.deadline)}` : ''}. Accept it to confirm you have it.
    </p>}
    {activity.status === 'Needs Correction' && !isDirector && <p className="decision-hint">
      This work was sent back to you. Put right what the Director&rsquo;s note asks for, attach the evidence, and submit it again.
    </p>}
    {activity.completionSubmittedAt && activity.status !== 'Completed' && <p className="decision-hint">
      The manager submitted this work on {formatDateTime(activity.completionSubmittedAt)}. Review the evidence below, then set the status to Completed.
    </p>}

    <h3 className="form-section-title">Evidence</h3>
    {canAttach && <EvidenceUpload onUpload={(formData) => onUpload(activity, formData)} />}
    <EvidenceList
      activity={activity}
      evidence={evidence}
      token={token}
      canRemove={isDirector}
      onRemove={(item) => onRemoveEvidence(activity, item)}
    />

    <h3 className="form-section-title">Activity history</h3>
    {history.length
      ? <ul className="history-list">{history.map((entry) => <li key={entry.id}>
        <strong>{entry.action}</strong>
        {entry.field && <span>
          {' '}{labelForField(entry.field)}: {formatTrailValue(entry.field, entry.oldValue, userNames)} &rarr; {formatTrailValue(entry.field, entry.newValue, userNames)}
        </span>}
        <small>Changed by {entry.actorName || 'Unknown'} · {formatDateTime(entry.createdAt)}</small>
        {entry.note && <small className="justification">Reason: {entry.note}</small>}
      </li>)}</ul>
      : <div className="empty-state"><strong>No history recorded yet.</strong><span>Decisions, status changes and uploads appear here.</span></div>}
  </section>;
}

const FIELD_LABELS = {
  approvedBudget: 'Budget',
  requestedBudget: 'Requested budget',
  status: 'Status',
  adminNote: 'Note',
  evidence: 'Evidence',
  completionSubmittedAt: 'Completion',
  activity: 'Activity',
  assignedTo: 'Carried out by',
  deadline: 'Deadline',
  instructions: 'Instructions'
};

function labelForField(field) {
  return FIELD_LABELS[field] || field;
}

function formatTrailValue(field, value, userNames) {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'approvedBudget' || field === 'requestedBudget') return formatUsd(value);
  // The trail stores the manager's id, which is not a name anyone reads.
  if (field === 'assignedTo') return userNames?.get(String(value)) || `User #${value}`;
  if (field === 'deadline') return formatDate(value);
  // Instructions and notes run to paragraphs; a trail line is a summary.
  const text = String(value);
  return text.length > 70 ? `${text.slice(0, 70)}…` : text;
}

function Fact({ label, value }) {
  return <div className="fact"><span>{label}</span><strong>{value}</strong></div>;
}

function EvidenceUpload({ onUpload }) {
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
    onUpload(formData);
    setAmount(''); setNote(''); setFiles(null); setInputKey((current) => current + 1);
  };

  return <form className="inline-form" onSubmit={submit}>
    <label className="form-field"><span>Evidence type</span>
      <select value={kind} onChange={(event) => setKind(event.target.value)}>{EVIDENCE_KINDS.map((option) => <option key={option}>{option}</option>)}</select>
    </label>
    <label className="form-field"><span>Amount (USD)</span>
      <input type="number" min="0" step="0.01" placeholder="0" value={amount} onChange={(event) => setAmount(event.target.value)} />
    </label>
    <label className="form-field"><span>Note</span>
      <input placeholder="e.g. Receipt for 10 hoes" value={note} onChange={(event) => setNote(event.target.value)} />
    </label>
    <label className="form-field"><span>Files (JPG, PNG, PDF &mdash; max 10 MB each)</span>
      <input key={inputKey} type="file" multiple accept="image/*,application/pdf" onChange={(event) => setFiles(event.target.files)} />
    </label>
    <button className="secondary-btn" type="submit" disabled={!files?.length}>Upload evidence</button>
  </form>;
}

function EvidenceList({ activity, evidence, token, canRemove, onRemove }) {
  if (!evidence.length) {
    return <div className="empty-state"><strong>No evidence attached yet.</strong><span>Receipts, invoices, fuel slips and photographs go here.</span></div>;
  }
  return <div className="table-wrap"><table>
    <thead><tr><th>Type</th><th>File</th><th>Amount</th><th>Note</th><th>Uploaded by</th><th>Date</th><th>Actions</th></tr></thead>
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
          href={`/api/activities/${activity.id}/evidence/${item.id}/file?token=${encodeURIComponent(token)}`}>View</a>
        {canRemove && <button className="danger-btn" type="button" onClick={() => onRemove(item)}>Remove</button>}
      </td>
    </tr>)}</tbody>
  </table></div>;
}

export default ActivityReview;
