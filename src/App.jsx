import { useCallback, useEffect, useMemo, useState } from 'react';
import MovementModule from './MovementModule.jsx';
import PartnerPortal from './PartnerPortal.jsx';
import ExternalPartners from './ExternalPartners.jsx';
import MonthlyPlans from './MonthlyPlans.jsx';
import { LANGUAGES, LanguageContext, displayLanguage, setDisplayLanguage, useLanguage, useT } from './i18n.js';
import { BUSINESS_OPERATIONS, operationName } from '../shared/businessOperations.js';
import ActivityReview, {
  ACTIVITY_STATUSES, APPROVAL_STATUS_LABELS, approvalTone, approverName,
  deadlineNote, formatDate, formatUsd, statusTone
} from './ActivityReview.jsx';

// The category presets offered per business operation. Keep in step with
// CATEGORIES in server/data/seedData.js, which is what the API validates
// against. The operations themselves -- their ids and their names in all four
// languages -- come from shared/businessOperations.js, so this file never
// restates what an operation is called.
const CATEGORIES = {
  farming: [
    'Land preparation', 'Planting and sowing', 'Irrigation', 'Fertilizer and inputs',
    'Pest and disease control', 'Livestock and animal feed', 'Harvesting',
    'Storage and preservation', 'Farm equipment and tools', 'Farm labour'
  ],
  mining: [
    'Exploration and survey', 'Extraction', 'Haulage', 'Washing and sorting',
    'Processing', 'Site preparation and access roads', 'Machinery and equipment',
    'Safety and protective equipment', 'Licenses and permits', 'Mining labour'
  ],
  agriculture: [
    'Seeds and seedlings', 'Land preparation', 'Planting', 'Crop maintenance',
    'Fertilizer and agro-inputs', 'Harvesting', 'Post-harvest handling',
    'Storage and warehousing', 'Transport to market', 'Agricultural labour'
  ],
  movement: [
    'Vehicle hire', 'Fuel and lubricants', 'Freight and haulage', 'Border clearance',
    'Permits and licenses', 'Escort and security', 'Warehousing and handling',
    'Loading and offloading', 'Travel and allowances', 'Documentation and administration'
  ]
};

const sectors = BUSINESS_OPERATIONS.map((operation) => ({
  ...operation,
  categories: CATEGORIES[operation.id] || []
}));

const OTHER_CATEGORY = 'Other (specify)';

// The working area a manager who covers every operation is filed under. It is
// not an operation id -- the API translates it into "no single area, covers all"
// on the account row -- so it must never be looked up in `sectors`.
const ALL_OPERATIONS = 'all';

function categoriesForSector(sectorId) {
  return sectors.find((sector) => sector.id === sectorId)?.categories || [];
}

// Rows store the operation id ('movement'), which is not what a reader should
// see: they get "Movements & Facilitation", in their own language.
function sectorName(sectorId) {
  return operationName(sectorId, displayLanguage());
}

const emptyProject = { name: '', sector: 'agriculture', location: '', owner: '', status: 'On Track', progress: '', budget: '', spent: '', category: '', managerId: '' };
// One form, two ways round. A manager raises an activity, which is born
// awaiting the Director's review, so it carries no status and no "approved"
// tick for the requester to set. The Director instead hands work out: the last
// three fields are theirs, and what they assign is funded from the start.
const emptyActivity = { projectId: '', sector: 'agriculture', categoryChoice: '', category: '', activity: '', description: '', materials: '', quantity: '', costUsd: '', signed: false, assignedTo: '', deadline: '', instructions: '' };
// The statuses that mean assigned work is still on the manager's desk. Closed
// and refused records drop out of their queue.
const OPEN_ASSIGNMENT_STATUSES = ['Pending Approval', 'Approved', 'Budget Adjusted', 'In Progress', 'Needs Correction'];
const emptyApproval = { title: '', sector: 'agriculture', amount: '', owner: '', priority: 'Medium', status: 'Pending', requestedBy: '', justification: '' };
const emptyAccount = { username: '', name: '', password: '', role: 'manager', sector: '', managerId: '' };
const emptyRegister = { total: 0, roleCounts: {}, unassigned: 0, users: [] };
const exchangeRates = { rwfPerUsd: 1450, cdfPerUsd: 2850 };

// Roles are stored as slugs; these are the words the Director reads.
const roleLabels = { 'super-admin': 'Director', manager: 'Sector manager', staff: 'Team member' };

function roleName(role) {
  return roleLabels[role] || role;
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(value || 0));
}

function formatRwf(value) {
  return `RWF ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value || 0))}`;
}

// Report pickers deal in calendar days, so the local date is assembled by hand.
// toISOString() would convert to UTC first and hand back yesterday for anyone
// east of Greenwich after midnight.
function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// A custom period opens on the month so far, which is the range most often
// wanted, and is the one starting point that is never an empty report.
const defaultReportRange = {
  week: todayIso(),
  month: todayIso().slice(0, 7),
  start: `${todayIso().slice(0, 7)}-01`,
  end: todayIso()
};

const REPORT_MODES = [['weekly', 'report.weekly'], ['monthly', 'report.monthly'], ['custom', 'report.custom']];

function App() {
  const { language, setLanguage, t } = useLanguage();
  // Set before anything renders, so the display helpers that are not components
  // -- sectorName here, areaLabel and deadlineNote elsewhere -- name things in
  // the language currently chosen.
  setDisplayLanguage(language);
  // Carried down the tree rather than passed to every component: the tables,
  // forms and detail panels that need it sit several levels below this one.
  const i18n = useMemo(() => ({ language, setLanguage, t }), [language, setLanguage, t]);

  const [token, setToken] = useState(localStorage.getItem('ops-token') || '');
  const [user, setUser] = useState(() => JSON.parse(localStorage.getItem('ops-user') || 'null'));
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [activeView, setActiveView] = useState('dashboard');
  const [summary, setSummary] = useState({ summary: {}, sectors });
  const [projects, setProjects] = useState([]);
  const [activities, setActivities] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [managers, setManagers] = useState([]);
  const [register, setRegister] = useState(emptyRegister);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [sectorFilter, setSectorFilter] = useState('All');
  const [projectSearch, setProjectSearch] = useState('');
  const [projectForm, setProjectForm] = useState(emptyProject);
  const [activityForm, setActivityForm] = useState(emptyActivity);
  const [approvalForm, setApprovalForm] = useState(emptyApproval);
  const [accountForm, setAccountForm] = useState(emptyAccount);
  const [userSearch, setUserSearch] = useState('');
  const [userRoleFilter, setUserRoleFilter] = useState('All');
  const [activityStatusFilter, setActivityStatusFilter] = useState('All');
  const [activityDetail, setActivityDetail] = useState(null);
  // "What I Need to Approve": everything waiting on this account, activities
  // and movements together, fetched from the queue the API builds from the
  // signed-in user rather than filtered out of the register on the client.
  const [approvalQueue, setApprovalQueue] = useState({ activities: [], movements: [], total: 0 });
  // External business partners, and the one business operation each may follow.
  const [partnerRegister, setPartnerRegister] = useState({ total: 0, active: 0, byOperation: {}, partners: [] });
  const [report, setReport] = useState(null);
  const [reportMode, setReportMode] = useState('weekly');
  const [reportRange, setReportRange] = useState(defaultReportRange);
  const [reportBusy, setReportBusy] = useState(false);

  const fetchJson = useCallback(async (url, options = {}) => {
    let response;
    try {
      response = await fetch(url, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) }
      });
    } catch (requestError) {
      throw new Error('The API cannot be reached. Start the Node server and check the database connection.');
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${payload.message || 'Request failed.'} (${response.status} ${url})`);
    return payload;
  }, [token]);

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      const results = await Promise.allSettled([
        fetchJson('/api/summary'), fetchJson('/api/projects'), fetchJson('/api/activities?limit=100'),
        fetchJson('/api/approvals'), fetchJson('/api/managers'), fetchJson('/api/users'),
        fetchJson('/api/approval-queue'), fetchJson('/api/partners')
      ]);
      const [summaryResult, projectResult, activityResult, approvalResult, managerResult, userResult, queueResult, partnerResult] = results;
      const criticalResults = [summaryResult, projectResult, activityResult, approvalResult];
      const criticalFailure = criticalResults.find((result) => result.status === 'rejected');
      if (criticalFailure) throw criticalFailure.reason;

      setSummary(summaryResult.value);
      setProjects(projectResult.value);
      setActivities(activityResult.value);
      setApprovals(approvalResult.value);
      setManagers(managerResult.status === 'fulfilled' ? managerResult.value : []);
      // An empty queue and an unreachable queue must not look the same, but
      // neither should a failure here take the whole dashboard down.
      setApprovalQueue(queueResult.status === 'fulfilled'
        ? queueResult.value
        : { activities: [], movements: [], total: 0 });
      // Only the Director may read the partner register; anyone else's 403 is
      // expected and is not an error worth showing.
      setPartnerRegister(partnerResult.status === 'fulfilled'
        ? partnerResult.value
        : { total: 0, active: 0, byOperation: {}, partners: [] });
      // Only the Director may read the account register; a manager's 403 is expected.
      setRegister(userResult.status === 'fulfilled' ? userResult.value : emptyRegister);
      if (managerResult.status === 'rejected') {
        setMessage('Manager list is unavailable; other records loaded successfully.');
      }
      // A project can disappear between loads -- deleted, or moved to a sector
      // this user does not cover. The id stayed selected, and because a <select>
      // whose value matches no option falls back to displaying its first entry,
      // the page showed "Select project" while still posting the vanished id.
      // That is what came back as "Select an existing project" on a form that
      // plainly had one chosen, so the selection is reconciled on every load.
      const visibleProjects = projectResult.value;
      const stillVisible = visibleProjects.find((project) => project.id === selectedProjectId);
      const chosenProject = stillVisible || visibleProjects[0] || null;
      if ((chosenProject?.id || '') !== selectedProjectId) {
        setSelectedProjectId(chosenProject?.id || '');
        setActivityForm((current) => ({
          ...current,
          projectId: chosenProject?.id || '',
          sector: chosenProject?.sector || current.sector,
          // The preset category list is per sector, and so is the set of
          // managers who may be handed the work, so a change clears both.
          ...(chosenProject && chosenProject.sector !== current.sector ? { categoryChoice: '', category: '', assignedTo: '' } : {})
        }));
      }
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!token) return;
    localStorage.setItem('ops-token', token);
    fetchJson('/api/auth/session')
      .then((session) => {
        setUser(session.user);
        localStorage.setItem('ops-user', JSON.stringify(session.user));
        // An external partner has no access to any of the internal registers --
        // the API refuses every one of them -- so loading them would be seven
        // guaranteed 403s. Their portal fetches its own data instead.
        if (session.user?.role !== 'partner') loadData();
        else setLoading(false);
      })
      .catch(() => {
        setToken('');
        localStorage.removeItem('ops-token');
        localStorage.removeItem('ops-user');
      });
  }, [token]);

  // The requester is whoever is signed in, and a manager's request belongs to
  // their own sector, so neither is left for the user to type.
  useEffect(() => {
    if (!user) return;
    setApprovalForm((current) => ({
      ...current,
      requestedBy: user.name,
      sector: user.role !== 'super-admin' && user.sector ? user.sector : current.sector
    }));
  }, [user]);

  const login = async (event) => {
    event.preventDefault();
    setError('');
    try {
      const result = await fetchJson('/api/auth/login', { method: 'POST', body: JSON.stringify(loginForm) });
      setToken(result.token);
      setUser(result.user);
      localStorage.setItem('ops-user', JSON.stringify(result.user));
    } catch (loginError) {
      setError(loginError.message);
    }
  };

  const resetPassword = async (account) => {
    const next = window.prompt(`New password for ${account.name} (${account.username}).
Minimum 6 characters.`, '');
    if (next === null) return;
    if (next.trim().length < 6) {
      setError('The new password must be at least 6 characters.');
      return;
    }
    setError('');
    try {
      await fetchJson(`/api/users/${account.id}/password`, { method: 'PATCH', body: JSON.stringify({ password: next.trim() }) });
      await loadData();
      setMessage(`Password updated for ${account.name}. They must sign in again.`);
    } catch (resetError) {
      setError(resetError.message);
    }
  };

  // One route carries both the manager and the working area, because the two
  // have to agree: a user under a manager who covers another area would be on a
  // team whose records they cannot open.
  const updateAssignment = async (account, changes) => {
    setError('');
    try {
      const result = await fetchJson(`/api/users/${account.id}/assignment`, { method: 'PATCH', body: JSON.stringify(changes) });
      await loadData();
      setMessage(`${account.name}: ${result.message || 'Assignment updated.'}`);
    } catch (assignmentError) {
      // The dropdown has already moved on screen, so reload before reporting:
      // it puts the cell back to what was actually saved. The refresh clears
      // the error banner, which is why the message is set after it, not before.
      await loadData().catch(() => {});
      setError(assignmentError.message);
    }
  };

  const changeUserManager = (account, managerId) => updateAssignment(account, { managerId: managerId || null });

  // Moving a user to another area drops a manager who does not work there,
  // rather than leaving the pair inconsistent and the save refused.
  const changeUserSector = (account, sector) => {
    const manager = managers.find((candidate) => candidate.id === account.managerId);
    // An all-operations manager works in the new area too, so the link survives
    // the move; one confined to the area being left does not.
    const keepsManager = manager && (manager.coversAllSectors || manager.sector === sector);
    return updateAssignment(account, { sector, managerId: keepsManager ? manager.id : null });
  };

  const decideApproval = async (approval, status) => {
    // A decline without a reason leaves the manager with no idea what to fix,
    // so the note is required to reject and optional to approve.
    const prompt = status === 'Rejected' ? 'Reason for declining this request:' : 'Note for the requester (optional):';
    const note = window.prompt(`${prompt}\n\n${approval.title}`, '');
    if (note === null) return;
    if (status === 'Rejected' && !note.trim()) {
      setError('A reason is required when declining a request.');
      return;
    }
    setError('');
    try {
      await fetchJson(`/api/approvals/${approval.id}`, { method: 'PATCH', body: JSON.stringify({ status, decisionNote: note.trim() }) });
      await loadData();
      setMessage(status === 'Approved' ? 'Request approved.' : 'Request declined.');
    } catch (decisionError) {
      setError(decisionError.message);
    }
  };

  const chooseProject = (projectId) => {
    const project = projects.find((item) => item.id === projectId);
    setSelectedProjectId(projectId);
    setActivityForm((current) => {
      const sector = project?.sector || current.sector;
      // The preset category list is sector specific, and a manager only works
      // one area, so a sector change invalidates both the category and the pick
      // of who carries the work out.
      const keepSector = sector === current.sector;
      return {
        ...current, projectId, sector,
        categoryChoice: keepSector ? current.categoryChoice : '',
        category: keepSector ? current.category : '',
        assignedTo: keepSector ? current.assignedTo : ''
      };
    });
  };

  const submit = async (event, url, body, success, reset, onCreated) => {
    event.preventDefault();
    setError('');
    try {
      const result = await fetchJson(url, { method: 'POST', body: JSON.stringify(body) });
      reset(result);
      onCreated?.(result);
      setMessage(success);
      try {
        await loadData();
      } catch (refreshError) {
        setError(`Saved successfully, but the list could not refresh: ${refreshError.message}`);
      }
    } catch (submitError) {
      setError(submitError.message);
    }
  };

  // ---- activity review workflow -------------------------------------------

  // The review screen wants the record, its evidence, its trail and what has
  // actually been spent against it. Both requests travel together so the
  // remaining balance on screen always matches the expenses listed beside it.
  const loadActivityDetail = async (activityId) => {
    const [detail, spending] = await Promise.all([
      fetchJson(`/api/activities/${activityId}`),
      // A user who may read the activity may read its expenses; if that ever
      // fails, the screen still opens without the money section.
      fetchJson(`/api/activities/${activityId}/expenses`).catch(() => null)
    ]);
    return {
      ...detail,
      expenses: spending?.expenses || [],
      expenseSummary: spending
        ? { approvedBudget: spending.approvedBudget, totalSpent: spending.totalSpent, remaining: spending.remaining }
        : null
    };
  };

  const openActivity = async (activityId) => {
    setError('');
    try {
      setActivityDetail(await loadActivityDetail(activityId));
    } catch (openError) { setError(openError.message); }
  };

  const refreshActivity = async (activityId) => {
    try {
      setActivityDetail(await loadActivityDetail(activityId));
      await loadData();
    } catch (refreshError) { setError(refreshError.message); }
  };

  // ---- actual expenses -----------------------------------------------------

  // Section 5: the manager records what was really spent. The API checks it
  // against the remaining approved budget and refuses anything over it, so an
  // over-budget attempt comes back as the message the workflow specifies.
  const recordExpense = async (activity, expense, reset) => {
    setError('');
    try {
      const result = await fetchJson(`/api/activities/${activity.id}/expenses`, {
        method: 'POST', body: JSON.stringify(expense)
      });
      reset?.();
      await refreshActivity(activity.id);
      setMessage(`${formatUsd(result.expense.amount)} recorded. ${formatUsd(result.remaining)} left on this activity.`);
    } catch (expenseError) { setError(expenseError.message); }
  };

  // Section 13: only the Director removes a financial record, and the API
  // refuses anyone else regardless of what is on screen.
  const removeExpense = async (activity, expense) => {
    if (!window.confirm(`Remove ${formatUsd(expense.amount)} spent on ${expense.spentOn}? The activity budget is restored by that amount.`)) return;
    setError('');
    try {
      const result = await fetchJson(`/api/activities/${activity.id}/expenses/${expense.id}`, { method: 'DELETE' });
      await refreshActivity(activity.id);
      setMessage(result.message);
    } catch (removeError) { setError(removeError.message); }
  };

  const saveDecision = async (activity, decision) => {
    setError('');
    try {
      const result = await fetchJson(`/api/activities/${activity.id}/decision`, { method: 'PATCH', body: JSON.stringify(decision) });
      await refreshActivity(activity.id);
      setMessage(result.budgetAdjustment
        ? `Decision saved. ${formatUsd(result.requestedBudget)} requested, ${formatUsd(result.approvedBudget)} approved.`
        : 'Decision saved.');
    } catch (decisionError) { setError(decisionError.message); }
  };

  // ---- the approval decision ----------------------------------------------

  // Approve or reject, taken by the person the record names. The API checks the
  // caller is that person; this only carries the decision there.
  const decideActivityApproval = async (activity, body) => {
    setError('');
    try {
      const result = await fetchJson(`/api/activities/${activity.id}/approval`, { method: 'PATCH', body: JSON.stringify(body) });
      await refreshActivity(activity.id);
      setMessage(body.action === 'approve'
        ? `Approved. ${result.approvedBudget !== null && result.approvedBudget !== result.requestedBudget
          ? `${formatUsd(result.requestedBudget)} requested, ${formatUsd(result.approvedBudget)} approved.`
          : 'The work can now start.'}`
        : 'Rejected. The record has left your approval queue.');
    } catch (approvalError) { setError(approvalError.message); }
  };

  const decideMovementApproval = async (movement, body) => {
    setError('');
    try {
      await fetchJson(`/api/movements/${movement.id}/approval`, { method: 'PATCH', body: JSON.stringify(body) });
      await loadData();
      setMessage(body.action === 'approve' ? `${movement.ref} approved.` : `${movement.ref} rejected.`);
    } catch (approvalError) { setError(approvalError.message); }
  };

  // Approve or reject straight from the queue, without opening the record. A
  // rejection still has to say why, and a prompt is the shortest honest way to
  // ask for it from a table row.
  const decideFromQueue = async (item, action) => {
    const isMovement = Boolean(item.ref);
    const label = isMovement ? `${item.ref} — ${item.purpose}` : item.activity;
    if (action === 'reject') {
      const reason = window.prompt(`Reason for rejecting this:\n\n${label}`, '');
      if (reason === null) return;
      if (!reason.trim()) {
        setError('A reason is required when rejecting.');
        return;
      }
      const body = { action: 'reject', rejectionReason: reason.trim() };
      return isMovement ? decideMovementApproval(item, body) : decideActivityApproval(item, body);
    }
    const note = window.prompt(`Note for the record (optional):\n\n${label}`, '');
    if (note === null) return;
    const body = { action: 'approve', adminNote: note.trim() };
    return isMovement ? decideMovementApproval(item, body) : decideActivityApproval(item, body);
  };

  const changeActivityStatus = async (activity, status) => {
    setError('');
    try {
      await fetchJson(`/api/activities/${activity.id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
      await refreshActivity(activity.id);
      setMessage(`Activity moved to ${status}.`);
    } catch (actionError) { setError(actionError.message); }
  };

  const submitCompletion = async (activity, note) => {
    setError('');
    try {
      await fetchJson(`/api/activities/${activity.id}/completion`, { method: 'POST', body: JSON.stringify({ note }) });
      await refreshActivity(activity.id);
      setMessage('Submitted for review. The Director will check the evidence and close the activity.');
    } catch (completionError) { setError(completionError.message); }
  };

  // Handing the work to a different manager, or moving the deadline. Only the
  // fields that actually changed travel: the API refuses a save that asks for
  // nothing, and an unchanged field would still stamp the trail.
  const saveActivityAssignment = async (activity, changes) => {
    setError('');
    try {
      const result = await fetchJson(`/api/activities/${activity.id}/assignment`, { method: 'PATCH', body: JSON.stringify(changes) });
      await refreshActivity(activity.id);
      setMessage(result.assignedToName
        ? `Assignment saved. ${result.assignedToName} carries this out${result.deadline ? ` by ${formatDate(result.deadline)}` : ''}.`
        : 'Assignment saved. Nobody is carrying this out yet.');
    } catch (assignError) { setError(assignError.message); }
  };

  // Multipart, so it goes through fetch directly rather than the JSON helper.
  const uploadActivityEvidence = async (activity, formData) => {
    setError('');
    try {
      const response = await fetch(`/api/activities/${activity.id}/evidence`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'The evidence could not be uploaded.');
      await refreshActivity(activity.id);
      setMessage(`${payload.length} file${payload.length === 1 ? '' : 's'} attached.`);
    } catch (uploadError) { setError(uploadError.message); }
  };

  const removeActivityEvidence = async (activity, evidence) => {
    if (!window.confirm(`Remove "${evidence.originalName}" from this activity?`)) return;
    try {
      await fetchJson(`/api/activities/${activity.id}/evidence/${evidence.id}`, { method: 'DELETE' });
      await refreshActivity(activity.id);
      setMessage('Evidence removed.');
    } catch (evidenceError) { setError(evidenceError.message); }
  };

  const deleteRecord = async (url, label) => {
    if (!window.confirm(`Delete this ${label}? This action cannot be undone.`)) return;
    try {
      await fetchJson(url, { method: 'DELETE' });
      setMessage(`${label} deleted.`);
      await loadData();
    } catch (deleteError) { setError(deleteError.message); }
  };

  const assignManager = async (projectId, managerId) => {
    try {
      await fetchJson(`/api/projects/${projectId}/manager`, { method: 'PATCH', body: JSON.stringify({ managerId: managerId || null }) });
      setMessage('Project manager assignment updated.');
      await loadData();
    } catch (assignmentError) { setError(assignmentError.message); }
  };

  // ---- external business partner access ------------------------------------

  // Invite someone outside the organisation and give them exactly one business
  // operation to follow, view only.
  const invitePartner = async (form, reset) => {
    setError('');
    try {
      const result = await fetchJson('/api/partners', { method: 'POST', body: JSON.stringify(form) });
      reset();
      await loadData();
      setMessage(`${result.name} can now follow ${result.operationName}. View only.`);
    } catch (inviteError) { setError(inviteError.message); }
  };

  // Moving the operation moves everything they can read, on their next request.
  const changePartnerOperation = async (partner, operation) => {
    setError('');
    try {
      const result = await fetchJson(`/api/partners/${partner.id}/operation`, {
        method: 'PATCH', body: JSON.stringify({ operation })
      });
      await loadData();
      setMessage(result.message);
    } catch (changeError) {
      await loadData().catch(() => {});
      setError(changeError.message);
    }
  };

  const changePartnerStatus = async (partner, status) => {
    const wording = { suspended: 'Suspend', revoked: 'Revoke', active: 'Restore' }[status];
    if (status !== 'active' && !window.confirm(`${wording} access for ${partner.name}? They lose it on their next request.`)) return;
    setError('');
    try {
      const result = await fetchJson(`/api/partners/${partner.id}/status`, {
        method: 'PATCH', body: JSON.stringify({ status })
      });
      await loadData();
      setMessage(result.message);
    } catch (statusError) { setError(statusError.message); }
  };

  const resetPartnerPassword = async (partner) => {
    const next = window.prompt(`New password for ${partner.name} (${partner.username}).\nMinimum 6 characters.`, '');
    if (next === null) return;
    if (next.trim().length < 6) {
      setError('The new password must be at least 6 characters.');
      return;
    }
    setError('');
    try {
      const result = await fetchJson(`/api/partners/${partner.id}/password`, {
        method: 'PATCH', body: JSON.stringify({ password: next.trim() })
      });
      setMessage(result.message);
    } catch (resetError) { setError(resetError.message); }
  };

  const removePartner = async (partner) => {
    if (!window.confirm(`Remove ${partner.name} entirely? Revoking instead keeps the record of who had access.`)) return;
    setError('');
    try {
      const result = await fetchJson(`/api/partners/${partner.id}`, { method: 'DELETE' });
      await loadData();
      setMessage(result.message);
    } catch (removeError) { setError(removeError.message); }
  };

  // The Director's control over what leaves the organisation. An approved
  // record in an operation is visible to that operation's partners unless it is
  // switched off here.
  const setActivityVisibility = async (activity, externallyVisible) => {
    setError('');
    try {
      await fetchJson(`/api/activities/${activity.id}/visibility`, {
        method: 'PATCH', body: JSON.stringify({ externallyVisible })
      });
      await refreshActivity(activity.id);
      setMessage(externallyVisible
        ? 'External partners in this business operation can now see this activity.'
        : 'This activity is now hidden from external partners.');
    } catch (visibilityError) { setError(visibilityError.message); }
  };

  // ---- reports -------------------------------------------------------------

  // One place builds the query, so the report on screen and the file that is
  // exported can never be asked for different periods.
  const reportQuery = (mode = reportMode, range = reportRange) => {
    if (mode === 'monthly') return `period=monthly&month=${encodeURIComponent(range.month)}`;
    if (mode === 'custom') return `period=custom&start=${encodeURIComponent(range.start)}&end=${encodeURIComponent(range.end)}`;
    // Any day inside the week; the API widens it to Monday-Sunday.
    return `period=weekly&start=${encodeURIComponent(range.week)}`;
  };

  const requestReport = async (mode = reportMode, range = reportRange) => {
    setError('');
    setReportBusy(true);
    try {
      setReport(await fetchJson(`/api/reports/activities?${reportQuery(mode, range)}`));
    } catch (reportError) {
      setReport(null);
      setError(reportError.message);
    } finally {
      setReportBusy(false);
    }
  };

  // The export runs the same scoped query on the server, so a manager's file
  // holds their own working area and nothing more. It comes back as a binary
  // body rather than JSON, which is why it bypasses the JSON helper -- and it
  // travels with the Authorization header rather than a token in the URL.
  const exportReport = async (format) => {
    setError('');
    setReportBusy(true);
    try {
      const response = await fetch(`/api/reports/activities/export?format=${format}&${reportQuery()}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || 'The report could not be exported.');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `activity-report-${report?.period?.start || 'period'}-to-${report?.period?.end || 'period'}.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setMessage(`${format === 'xlsx' ? 'Excel' : 'PDF'} report downloaded.`);
    } catch (exportError) {
      setError(exportError.message);
    } finally {
      setReportBusy(false);
    }
  };

  const logout = () => {
    localStorage.removeItem('ops-token'); localStorage.removeItem('ops-user');
    setToken(''); setUser(null);
  };

  const filteredProjects = useMemo(() => projects.filter((project) => {
    const matchesSector = sectorFilter === 'All' || project.sector === sectorFilter;
    const term = projectSearch.toLowerCase();
    return matchesSector && (!term || [project.name, project.location, project.owner, project.category].some((value) => String(value || '').toLowerCase().includes(term)));
  }), [projects, sectorFilter, projectSearch]);

  const filteredUsers = useMemo(() => {
    const term = userSearch.trim().toLowerCase();
    return register.users.filter((account) => (userRoleFilter === 'All' || account.role === userRoleFilter)
      && (!term || [account.name, account.username, account.managerName, sectorName(account.sector), roleName(account.role)]
        .some((value) => String(value || '').toLowerCase().includes(term))));
  }, [register.users, userSearch, userRoleFilter]);

  // "Awaiting review" is the Director's queue: undecided requests plus finished
  // work handed back. It is a view over the statuses, not a status of its own.
  const awaitingReview = (activity) => activity.status === 'Pending Approval'
    || (activity.completionSubmittedAt && activity.status !== 'Completed');

  // "Assigned to me" is the same idea seen from the other end: everything the
  // Director handed to whoever is signed in.
  const assignedToMe = (activity) => Boolean(user) && activity.assignedTo === user.id;

  const selectedActivities = useMemo(() => activities.filter((activity) => {
    const matchesProject = !selectedProjectId || activity.projectId === selectedProjectId;
    const matchesSector = sectorFilter === 'All' || activity.sector === sectorFilter;
    const matchesStatus = activityStatusFilter === 'All'
      || (activityStatusFilter === 'Awaiting review' && awaitingReview(activity))
      || (activityStatusFilter === 'Assigned to me' && assignedToMe(activity))
      || activityStatusFilter === activity.status;
    return matchesProject && matchesSector && matchesStatus;
  }), [activities, selectedProjectId, sectorFilter, activityStatusFilter, user]);

  const reviewQueue = useMemo(() => activities.filter(awaitingReview), [activities]);
  // The manager's own queue, soonest deadline first, because that is the order
  // the work is due. Anything without a deadline sits at the end.
  const myAssignments = useMemo(() => activities
    .filter((activity) => assignedToMe(activity) && OPEN_ASSIGNMENT_STATUSES.includes(activity.status))
    .sort((left, right) => (left.deadline || '9999-12-31').localeCompare(right.deadline || '9999-12-31')),
  [activities, user]);
  const pendingApprovals = approvals.filter((approval) => approval.status === 'Pending');
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const usd = Number(activityForm.costUsd || 0);
  // A sector manager may only file against their own sector; the API enforces
  // the same rule, this just keeps the unusable options out of the dropdown.
  const sectorOptions = useMemo(
    () => (user && user.role !== 'super-admin' && user.sector ? sectors.filter((sector) => sector.id === user.sector) : sectors),
    [user]
  );

  if (!token || !user) {
    return <LanguageContext.Provider value={i18n}><div className="login-shell"><form className="login-card" onSubmit={login}>
      <img className="login-logo" src="/logo.png" srcSet="/logo.png 1x, /logo@2x.png 2x" alt="Gisuma Project Operations Management" />
      <LanguagePicker language={language} setLanguage={setLanguage} label={t('app.language')} />
      <h1>{t('auth.signIn')}</h1>
      <p>{t('auth.signInBlurb')}</p>
      <label>{t('auth.username')}<input required value={loginForm.username} onChange={(event) => setLoginForm({ ...loginForm, username: event.target.value })} /></label>
      <label>{t('auth.password')}<input required type="password" value={loginForm.password} onChange={(event) => setLoginForm({ ...loginForm, password: event.target.value })} /></label>
      <button className="primary-btn full-width" type="submit">{t('auth.signIn')}</button>
      {error && <div className="error-state">{error}</div>}
    </form></div></LanguageContext.Provider>;
  }

  const isDirector = user.role === 'super-admin';

  // An external business partner gets a different application, not a trimmed
  // version of this one: a read-only window onto the single business operation
  // their account carries. The internal shell -- registers, approvals, admin --
  // is never constructed for them, and the API would refuse it anyway.
  if (user.role === 'partner') {
    return <LanguageContext.Provider value={i18n}><div className="application-shell partner-shell">
      <aside className="sidebar">
        <div className="brand-lockup"><img className="brand-logo" src="/logo-mark.png" alt="" /><div><strong>{t('app.name')}</strong><span>{t('portal.title')}</span></div></div>
        <div className="sidebar-label">{t('app.businessOperation')}</div>
        <div className="partner-operation">{operationName(user.sector, language)}</div>
        <div className="sidebar-bottom">
          <LanguagePicker language={language} setLanguage={setLanguage} label={t('app.language')} />
          <div className="sidebar-label">{t('app.signedInAs')}</div>
          <strong>{user.name}</strong>
          <span>{t('role.partner')}</span>
          <span>{t('partners.viewOnly')}</span>
          <button className="logout-btn" onClick={logout} type="button">{t('app.signOut')}</button>
        </div>
      </aside>
      <div className="main-area">
        <header className="top-header">
          <div><span className="eyebrow">{t('portal.title')}</span><h1>{operationName(user.sector, language)}</h1></div>
          <div className="header-meta"><span className="connection-dot" />{t('partners.viewOnly')}</div>
        </header>
        {message && <div className="success-banner">{message}<button type="button" onClick={() => setMessage('')}>{t('app.dismiss')}</button></div>}
        {error && <div className="error-banner">{error}<button type="button" onClick={() => setError('')}>{t('app.dismiss')}</button></div>}
        <PartnerPortal user={user} fetchJson={fetchJson} language={language} t={t} onError={setError} />
      </div>
    </div></LanguageContext.Provider>;
  }

  // Four figures everyone gets, and a fifth that depends on who is reading it:
  // the Director sees the size of the organisation, a manager sees the work
  // sitting on their own desk.
  const dashboardMetrics = [
    [t('metric.projects'), summary.summary?.totalProjects || 0],
    [t('metric.activitiesInProgress'), summary.summary?.activeOperations || 0],
    [t('metric.pendingApprovals'), summary.summary?.approvalsPending || 0],
    [t('metric.completionRate'), `${summary.summary?.completionRate || 0}%`],
    ...(typeof summary.summary?.registeredUsers === 'number' ? [[t('metric.registeredUsers'), summary.summary.registeredUsers]] : []),
    // The API counts only what is actually waiting on the manager -- work they
    // have not accepted, and work sent back -- not everything they hold.
    ...(isDirector ? [] : [[t('metric.needingYourAction'), summary.summary?.activitiesAssignedToMe || 0]])
  ];

  // The badge is the number of records personally held up by this account. It
  // comes from the API's own count of the same predicate the queue runs, so the
  // two can never drift apart.
  const approvalCount = summary.summary?.approvalsAwaitingMe ?? approvalQueue.total ?? 0;

  const navItems = [
    ['dashboard', t('nav.dashboard')],
    ['approval-queue', t('nav.approvalQueue'), approvalCount],
    ['projects', t('nav.projects')], ['activities', t('nav.activities')],
    ['monthly', t('nav.monthlyPlans')],
    ['approvals', t('nav.approvals')], ['movements', operationName('movement', language)],
    ...(isDirector ? [['users', t('nav.users')], ['partners', t('nav.partners')]] : [])
  ];

  return <LanguageContext.Provider value={i18n}><div className="application-shell">
    <aside className="sidebar">
      <div className="brand-lockup"><img className="brand-logo" src="/logo-mark.png" alt="" /><div><strong>{t('app.name')}</strong><span>{t('app.subtitle')}</span></div></div>
      <div className="sidebar-label">{t('app.workspace')}</div>
      <nav>{navItems.map(([id, label, badge]) => <button key={id} className={activeView === id ? 'nav-item active' : 'nav-item'} onClick={() => setActiveView(id)} type="button">
        <span className={`nav-icon nav-${id}`} />{label}
        {badge > 0 && <span className="nav-badge" aria-label={`${badge} waiting on you`}>{badge}</span>}
      </button>)}</nav>
      <div className="sidebar-bottom">
        <LanguagePicker language={language} setLanguage={setLanguage} label={t('app.language')} />
        <div className="sidebar-label">{t('app.signedInAs')}</div>
        <strong>{user.name}</strong>
        <span>{t(`role.${user.role}`)}</span>
        {user.coversAllSectors
          ? <span>{t('app.businessOperation')}: {t('user.allOperations')}</span>
          : user.sector && <span>{t('app.businessOperation')}: {sectorName(user.sector)}</span>}
        <button className="logout-btn" onClick={logout} type="button">{t('app.signOut')}</button>
      </div>
    </aside>

    <div className="main-area">
      <header className="top-header"><div><span className="eyebrow">{t('app.operationsControl')}</span><h1>{navItems.find(([id]) => id === activeView)?.[1]}</h1></div><div className="header-meta"><span className="connection-dot" />{t('app.databaseConnected')}</div></header>
      {message && <div className="success-banner">{message}<button type="button" onClick={() => setMessage('')}>{t('app.dismiss')}</button></div>}
      {error && <div className="error-banner">{error}<button type="button" onClick={() => setError('')}>{t('app.dismiss')}</button></div>}
      {loading ? <div className="loading-state"><span className="spinner" />{t('app.loading')}</div> : <>

        {activeView === 'dashboard' && <>
          <section className="welcome-strip"><div><span className="eyebrow">{t('dash.systemOverview')}</span><h2>{t('dash.headline')}</h2><p>{t('dash.blurb')}</p></div><button className="primary-btn" type="button" onClick={() => setActiveView('activities')}>{isDirector ? t('action.assignActivity') : t('action.raiseActivity')}</button></section>
          <div className={`metric-grid${dashboardMetrics.length === 5 ? ' metric-grid-5' : ''}`}>
            {dashboardMetrics.map(([label, value]) => <Metric key={label} label={label} value={value} />)}
          </div>
          {/* The decisions this account is personally holding up. First on the
              dashboard because nothing else moves until they are taken. */}
          <Panel
            title={t('approval.queueTitle')}
            subtitle={approvalCount ? `${approvalCount} \u00b7 ${t('approval.queueBlurb')}` : t('approval.queueEmpty')}
            action={t('action.openQueue')}
            onAction={() => setActiveView('approval-queue')}
          >
            <ApprovalQueueTable
              items={[...approvalQueue.activities, ...approvalQueue.movements].slice(0, 6)}
              onOpen={(item) => {
                if (item.ref) return setActiveView('movements');
                setActiveView('activities');
                openActivity(item.id);
              }}
              onDecide={decideFromQueue}
              empty={t('approval.queueEmpty')}
            />
          </Panel>
          {/* A manager's own queue: what the Director handed them, soonest
              deadline first, so nothing is accepted late or quietly forgotten. */}
          {!isDirector && <Panel
            title={t('panel.workAssignedToYou')}
            subtitle={`${myAssignments.length} \u00b7 ${t('nav.activities')}`}
            action={t('action.openRegister')}
            onAction={() => { setActivityStatusFilter('Assigned to me'); setActiveView('activities'); }}
          >
            <AssignmentQueue
              activities={myAssignments.slice(0, 6)}
              onOpen={(id) => { setActiveView('activities'); openActivity(id); }}
              empty={t('empty.nothingAssigned')}
            />
          </Panel>}
          {/* A request submitted by a manager lands here the moment it is
              raised, so nothing sits unnoticed in the register. */}
          <Panel
            title={isDirector ? t('panel.awaitingYourReview') : t('panel.awaitingDirector')}
            subtitle={`${summary.summary?.activityReviewsPending || 0} \u00b7 ${summary.summary?.completionsAwaitingReview || 0} ${t('activities.completionSubmitted')}`}
            action={t('action.openRegister')}
            onAction={() => setActiveView('activities')}
          >
            <ReviewQueue
              activities={reviewQueue.slice(0, 6)}
              onOpen={(id) => { setActiveView('activities'); openActivity(id); }}
              empty={isDirector ? t('empty.nothingWaiting') : t('empty.noneOfYours')}
            />
          </Panel>
          {(summary.sectorBreakdown || []).length > 1 && <Panel title={t('panel.operationsOverview')} subtitle={t('panel.operationsOverviewBlurb')}><SectorBoard rows={summary.sectorBreakdown} onSelect={(sector) => { setSectorFilter(sector); setActiveView('projects'); }} /></Panel>}
          <div className="dashboard-columns"><Panel title={t('panel.projects')} action={t('action.viewAll')} onAction={() => setActiveView('projects')}><ProjectPreview projects={projects.slice(0, 5)} empty={t('empty.noProjects')} /></Panel><Panel title={t('panel.pendingApprovals')} action={t('approval.review')} onAction={() => setActiveView('approvals')}><ApprovalPreview approvals={pendingApprovals.slice(0, 5)} empty={t('empty.noPendingApprovals')} /></Panel></div>
        </>}

        {activeView === 'approval-queue' && <>
          <section className="welcome-strip">
            <div>
              <span className="eyebrow">{t('approval.yourQueue')}</span>
              <h2>{t('approval.queueTitle')} <span className="queue-count">{approvalCount}</span></h2>
              <p>
                {t('approval.queueBlurb')} {t('approval.onlyYou')}
              </p>
            </div>
          </section>
          <Panel
            title={t('approval.activitiesWaiting')}
            subtitle={`${approvalQueue.activities.length}`}
          >
            <ApprovalQueueTable
              items={approvalQueue.activities}
              onOpen={(item) => { setActiveView('activities'); openActivity(item.id); }}
              onDecide={decideFromQueue}
              empty={t('approval.queueEmpty')}
            />
          </Panel>
          <Panel
            title={t('approval.movementsWaiting')}
            subtitle={`${approvalQueue.movements.length}`}
          >
            <ApprovalQueueTable
              items={approvalQueue.movements}
              onOpen={() => setActiveView('movements')}
              onDecide={decideFromQueue}
              empty={t('approval.queueEmpty')}
            />
          </Panel>
        </>}

        {activeView === 'projects' && <><section className="toolbar-row"><div className="filter-group"><select value={sectorFilter} onChange={(event) => setSectorFilter(event.target.value)}><option value="All">{t('app.allOperations')}</option>{(summary.sectors || sectors).map((sector) => <option key={sector.id} value={sector.id}>{sectorName(sector.id)}</option>)}</select><input placeholder={t('form.searchProjects')} value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} /></div>{user.role === 'super-admin' && <button className="primary-btn" type="button" onClick={() => document.getElementById('project-form')?.scrollIntoView({ behavior: 'smooth' })}>{t('form.addProject')}</button>}</section><Panel title={t('panel.projectRegister')} subtitle={`${filteredProjects.length}`}><ProjectTable projects={filteredProjects} managers={managers} onSelect={chooseProject} onAssign={assignManager} onDelete={(id) => deleteRecord(`/api/projects/${id}`, 'project')} empty={t('empty.noProjectsMatch')} /></Panel>{user.role === 'super-admin' && <ProjectForm form={projectForm} setForm={setProjectForm} managers={managers} onSubmit={(event) => submit(event, '/api/projects', projectForm, 'Project added.', () => setProjectForm(emptyProject))} />}</>}

        {activeView === 'activities' && <>
          <section className="context-strip">
            <div><span className="eyebrow">{t('activities.eyebrow')}</span><h2>{t('activities.title')}</h2><p>{isDirector ? t('activities.directorBlurb') : t('activities.managerBlurb')}</p></div>
            <select value={selectedProjectId} onChange={(event) => chooseProject(event.target.value)}><option value="">{t('form.selectProject')}</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
          </section>

          {activityDetail && <ActivityReview
            detail={activityDetail}
            user={user}
            token={token}
            sectorLabel={sectorName}
            managers={managers}
            onClose={() => setActivityDetail(null)}
            onDecision={saveDecision}
            onStatus={changeActivityStatus}
            onAssign={saveActivityAssignment}
            onUpload={uploadActivityEvidence}
            onRemoveEvidence={removeActivityEvidence}
            onSubmitCompletion={submitCompletion}
            onApprove={decideActivityApproval}
            onVisibility={setActivityVisibility}
            onRecordExpense={(activity, expense, reset) => recordExpense(activity, expense, reset)}
            onRemoveExpense={removeExpense}
          />}

          <section className="toolbar-row"><div className="filter-group">
            <select value={activityStatusFilter} onChange={(event) => setActivityStatusFilter(event.target.value)}>
              <option value="All">{t('form.allStatuses')}</option>
              <option value="Awaiting review">{t('activities.awaitingReview')}</option>
              {!isDirector && <option value="Assigned to me">{t('activities.assignedToMe')}</option>}
              {ACTIVITY_STATUSES.map((status) => <option key={status} value={status}>{t(`status.${status}`)}</option>)}
            </select>
            <select value={selectedProjectId} onChange={(event) => chooseProject(event.target.value)}><option value="">{t('form.allProjects')}</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
          </div></section>

          <Panel title={t('panel.activityRegister')} subtitle={`${selectedActivities.length}`}>
            <ActivityTable
              activities={selectedActivities}
              isDirector={user.role === 'super-admin'}
              openId={activityDetail?.activity?.id}
              onOpen={openActivity}
              onDelete={(id) => { setActivityDetail(null); return deleteRecord(`/api/activities/${id}`, 'activity'); }}
              empty={t('empty.noActivitiesMatch')}
            />
          </Panel>

          <ActivityForm
            form={activityForm} setForm={setActivityForm} projects={projects} onChooseProject={chooseProject}
            selectedProject={selectedProject} sectorOptions={sectorOptions} managers={managers}
            isDirector={isDirector} usd={usd}
            onSubmit={(event) => {
              const { categoryChoice, ...payload } = activityForm;
              return submit(
                event, '/api/activities',
                { ...payload, projectId: payload.projectId || selectedProjectId, costRwf: usd * exchangeRates.rwfPerUsd, costCdf: usd * exchangeRates.cdfPerUsd },
                isDirector ? 'Activity assigned. It is now on the manager\u2019s dashboard for them to accept.' : 'Activity submitted for review.',
                (result) => { setActivityForm({ ...emptyActivity, projectId: result.projectId, sector: result.sector }); },
                (result) => openActivity(result.id)
              );
            }}
          />
          <ReportsSection
            mode={reportMode}
            range={reportRange}
            report={report}
            busy={reportBusy}
            sectorLabel={sectorName}
            onModeChange={(next) => { setReportMode(next); setReport(null); }}
            onRangeChange={(changes) => setReportRange({ ...reportRange, ...changes })}
            onGenerate={() => requestReport()}
            onExport={exportReport}
            onPrint={() => window.print()}
            onClose={() => setReport(null)}
          />
        </>}

        {activeView === 'approvals' && <><section className="toolbar-row"><div className="filter-group"><select value={sectorFilter} onChange={(event) => setSectorFilter(event.target.value)}><option value="All">{t('app.allOperations')}</option>{(summary.sectors || sectors).map((sector) => <option key={sector.id} value={sector.id}>{sectorName(sector.id)}</option>)}</select></div></section><Panel title={t('panel.approvalRegister')} subtitle={`${approvals.length}`}><ApprovalTable approvals={approvals.filter((approval) => sectorFilter === 'All' || approval.sector === sectorFilter)} canDecide={user.role === 'super-admin'} onDecide={decideApproval} empty={t('empty.noApprovalRecords')} /></Panel><ApprovalForm form={approvalForm} setForm={setApprovalForm} sectorOptions={sectorOptions} onSubmit={(event) => submit(event, '/api/approvals', approvalForm, 'Request sent for approval.', () => setApprovalForm({ ...emptyApproval, sector: sectorOptions[0]?.id || emptyApproval.sector, requestedBy: user.name }))} /></>}

        {activeView === 'users' && user.role === 'super-admin' && <>
          <div className="metric-grid metric-grid-5">
            <Metric label={t('metric.registeredUsers')} value={register.total} />
            <Metric label={t('metric.operationManagers')} value={register.roleCounts?.manager || 0} />
            <Metric label={t('metric.teamMembers')} value={register.roleCounts?.staff || 0} />
            <Metric label={t('metric.withoutManager')} value={register.unassigned || 0} />
            {/* A manager who covers every operation covers this one too, so they
                count here as well -- matching on sector alone read their NULL
                sector as covering nothing and left every operation uncovered. */}
            <Metric label={t('metric.operationsWithoutManager')} value={sectors.filter((sector) => !register.users.some((account) => account.role === 'manager' && (account.coversAllSectors || account.sector === sector.id))).length} />
          </div>
          <section className="toolbar-row"><div className="filter-group">
            <select value={userRoleFilter} onChange={(event) => setUserRoleFilter(event.target.value)}>
              <option value="All">{t('form.allRoles')}</option>
              <option value="super-admin">{t('role.super-admin')}</option>
              <option value="manager">{t('role.manager')}</option>
              <option value="staff">{t('role.staff')}</option>
            </select>
            <input placeholder={t('form.searchUsers')} value={userSearch} onChange={(event) => setUserSearch(event.target.value)} />
          </div><button className="primary-btn" type="button" onClick={() => document.getElementById('account-form')?.scrollIntoView({ behavior: 'smooth' })}>{t('form.addUser')}</button></section>
          <Panel title={t('panel.userManagement')} subtitle={`${filteredUsers.length} / ${register.total}`}>
            <UserTable users={filteredUsers} managers={managers} onChangeManager={changeUserManager} onChangeSector={changeUserSector} onResetPassword={resetPassword} empty={t('empty.noAccountsMatch')} />
          </Panel>
          <AccountForm form={accountForm} setForm={setAccountForm} managers={managers} onSubmit={(event) => submit(event, '/api/users', { ...accountForm, managerId: accountForm.managerId || null }, 'Account created.', () => setAccountForm(emptyAccount))} />
        </>}

        {activeView === 'monthly' && <MonthlyPlans
          user={user}
          fetchJson={fetchJson}
          managers={managers}
          activities={activities}
          onMessage={setMessage}
          onError={setError}
        />}

        {activeView === 'partners' && isDirector && <ExternalPartners
          register={partnerRegister}
          language={language}
          t={t}
          onInvite={invitePartner}
          onChangeOperation={changePartnerOperation}
          onChangeStatus={changePartnerStatus}
          onResetPassword={resetPartnerPassword}
          onRemove={removePartner}
        />}

        {activeView === 'movements' && <MovementModule user={user} token={token} fetchJson={fetchJson} onMessage={setMessage} onError={setError} />}
      </>}</div>
  </div></LanguageContext.Provider>;
}

// Available before sign-in as well as after, because someone who reads no
// English has to be able to change it before they can read the login form.
function LanguagePicker({ language, setLanguage, label }) {
  return <label className="language-picker">
    <span>{label}</span>
    <select value={language} onChange={(event) => setLanguage(event.target.value)}>
      {LANGUAGES.map((option) => <option key={option.code} value={option.code}>{option.nativeName}</option>)}
    </select>
  </label>;
}

function UserTable({ users, managers, onChangeManager, onChangeSector, onResetPassword, empty }) {
  const t = useT();
  return users.length ? <div className="table-wrap"><table><thead><tr><th>{t('field.name')}</th><th>{t('field.username')}</th><th>{t('field.role')}</th><th>{t('field.reportsTo')}</th><th>{t('field.workingArea')}</th><th>{t('field.projects')}</th><th>{t('field.team')}</th><th>{t('field.added')}</th><th>{t('field.password')}</th><th>{t('field.action')}</th></tr></thead><tbody>
    {users.map((account) => {
      const isDirector = account.role === 'super-admin';
      // Only managers who work the same area can be picked, which is the rule
      // the API applies; the current manager stays listed so the cell is never
      // blank while the two are still in step.
      const managerOptions = managers.filter((manager) => manager.id !== account.id
        && (manager.coversAllSectors || manager.sector === account.sector || manager.id === account.managerId));
      return <tr key={account.id}>
        <td><strong>{account.name}</strong><small>#{account.id}</small></td>
        <td>{account.username}</td>
        <td><span className={isDirector ? 'role-badge role-admin' : 'role-badge'}>{t(`role.${account.role}`)}</span></td>
        <td>{isDirector ? <span className="muted-cell">{t('user.reportsToNobody')}</span>
          : <select value={account.managerId || ''} onChange={(event) => onChangeManager(account, event.target.value)}>
            <option value="">{t('user.noManager')}</option>
            {managerOptions.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}
          </select>}</td>
        <td>{isDirector ? <span className="muted-cell">{t('user.allOperations')}</span>
          : <select value={account.coversAllSectors ? ALL_OPERATIONS : (account.sector || '')} onChange={(event) => onChangeSector(account, event.target.value)}>
            {!account.sector && !account.coversAllSectors && <option value="">{t('user.notAssigned')}</option>}
            {/* Offered only to managers: the API refuses it for a team member. */}
            {account.role === 'manager' && <option value={ALL_OPERATIONS}>{t('user.allOperations')}</option>}
            {sectors.map((sector) => <option key={sector.id} value={sector.id}>{sectorName(sector.id)}</option>)}
          </select>}</td>
        <td>{account.assignedProjects}</td>
        <td>{account.teamSize || <span className="muted-cell">&mdash;</span>}</td>
        <td>{account.createdAt ? new Date(account.createdAt).toLocaleDateString() : <span className="muted-cell">&mdash;</span>}</td>
        {/* Only ever a date. The stored value is a bcrypt hash, so there is no
            password here for anyone, the Director included, to read. */}
        <td>{account.passwordChangedAt ? <span className="muted-cell">{t('user.passwordReset')} {new Date(account.passwordChangedAt).toLocaleDateString()}</span> : <span className="muted-cell">{t('user.passwordOriginal')}</span>}</td>
        <td><button className="text-btn" onClick={() => onResetPassword(account)} type="button">{t('action.changePassword')}</button></td>
      </tr>;
    })}
  </tbody></table></div> : <EmptyState>{empty}</EmptyState>;
}

function Metric({ label, value }) { return <div className="metric-card"><span>{label}</span><strong>{value}</strong></div>; }

function ReviewQueue({ activities, onOpen, empty }) {
  const t = useT();
  return activities.length ? <div className="preview-list">{activities.map((activity) => <div className="preview-row review-row" key={activity.id} onClick={() => onOpen(activity.id)} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') onOpen(activity.id); }}>
    <div>
      <strong>{sectorName(activity.sector)} &mdash; {activity.activity}</strong>
      <span>{activity.createdByName || '\u2014'} &middot; {formatUsd(activity.requestedBudget)} &middot; {new Date(activity.createdAt).toLocaleDateString()}</span>
    </div>
    <span className={`status-badge ${statusTone(activity.status)}`}>{activity.status === 'Pending Approval' ? t('activities.needsDecision') : t('activities.completionSubmitted')}</span>
  </div>)}</div> : <EmptyState>{empty}</EmptyState>;
}

// The manager's side of the same queue: what they were handed, what it is
// worth, and how its deadline stands. Work not yet accepted is called out,
// because accepting it is the one move only they can make.
function AssignmentQueue({ activities, onOpen, empty }) {
  const t = useT();
  return activities.length ? <div className="preview-list">{activities.map((activity) => {
    const due = deadlineNote(activity, displayLanguage());
    return <div className="preview-row review-row" key={activity.id} onClick={() => onOpen(activity.id)} role="button" tabIndex={0}
      onKeyDown={(event) => { if (event.key === 'Enter') onOpen(activity.id); }}>
      <div>
        <strong>{sectorName(activity.sector)} &mdash; {activity.activity}</strong>
        <span>
          {formatUsd(activity.approvedBudget === null ? activity.requestedBudget : activity.approvedBudget)}
          {' '}&middot; {activity.deadline ? formatDate(activity.deadline) : t('review.noDeadline')}
          {due && due.tone !== 'ok' ? ` · ${due.text}` : ''}
        </span>
      </div>
      <span className={`status-badge ${statusTone(activity.status)}`}>{activity.status === 'Pending Approval' ? t('activities.approveIt') : t(`status.${activity.status}`)}</span>
    </div>;
  })}</div> : <EmptyState>{empty}</EmptyState>;
}

// "What I Need to Approve", as rows. Takes activities and movements alike --
// the two carry the same approval fields, so one table reads both.
//
// Every row states who must approve it, so an approval is never presented as a
// bare "Pending" with nobody attached. Review / Approve / Reject are the only
// actions offered, and each one is checked again by the API.
function ApprovalQueueTable({ items, onOpen, onDecide, empty }) {
  const t = useT();
  if (!items.length) return <EmptyState>{empty}</EmptyState>;
  return <div className="table-wrap"><table className="approval-queue-table"><thead><tr>
    <th>{t('table.activityMovement')}</th><th>{t('table.createdBy')}</th><th>{t('table.assignedTo')}</th><th>{t('table.department')}</th>
    <th>{t('table.budget')}</th><th>{t('table.date')}</th><th>{t('approval.status')}</th><th>{t('table.actions')}</th>
  </tr></thead><tbody>
    {items.map((item) => {
      const isMovement = Boolean(item.ref);
      const title = isMovement ? `${item.ref} — ${item.purpose}` : item.activity;
      const detail = isMovement
        ? `${item.movementType} · ${item.origin || '—'} → ${item.destination}`
        : (item.description || 'No description');
      const budget = isMovement
        ? `${item.currency} ${formatNumber(item.estimatedTotal)}`
        : formatUsd(item.approvedBudget === null ? item.requestedBudget : item.approvedBudget);
      const carrier = isMovement
        ? (item.assignedToName || item.personTeam || null)
        : item.assignedToName;
      return <tr key={`${isMovement ? 'mov' : 'act'}-${item.id}`}>
        <td><strong>{title}</strong><small>{detail}</small></td>
        <td>{item.createdByName || <span className="muted-cell">&mdash;</span>}</td>
        <td>{carrier || <span className="muted-cell">Unassigned</span>}</td>
        <td>{sectorName(item.department || item.sector)}</td>
        <td>{budget}</td>
        <td>{new Date(item.createdAt).toLocaleDateString()}</td>
        <td>
          <span className={`status-badge ${approvalTone(item.approvalStatus)}`}>
            {APPROVAL_STATUS_LABELS[item.approvalStatus] || item.approvalStatus}
          </span>
          <small className="awaiting-flag">{t('approval.waitingFor')} {approverName(item, sectorName, t)}</small>
        </td>
        <td className="queue-actions">
          <button className="text-btn" type="button" onClick={() => onOpen(item)}>{t('approval.review')}</button>
          <button className="primary-btn compact" type="button" onClick={() => onDecide(item, 'approve')}>{t('approval.approve')}</button>
          <button className="danger-btn outlined compact" type="button" onClick={() => onDecide(item, 'reject')}>{t('approval.reject')}</button>
        </td>
      </tr>;
    })}
  </tbody></table></div>;
}

function SectorBoard({ rows, onSelect }) {
  const t = useT();
  return <div className="table-wrap"><table className="sector-board"><thead><tr><th>{t('app.businessOperation')}</th><th>{t('field.projects')}</th><th>{t('nav.activities')}</th><th>{t('portal.inProgress')}</th><th>{t('portal.completed')}</th><th>{t('metric.pendingApprovals')}</th><th>{t('field.budget')}</th><th>{t('field.spent')}</th><th>{t('report.remainingBudget')}</th><th>{t('table.progress')}</th></tr></thead><tbody>
    {rows.map((row) => <tr key={row.id} onClick={() => onSelect(row.id)}>
      <td><strong>{sectorName(row.id)}</strong><small>{row.id}</small></td>
      <td>{row.projects}</td>
      <td>{row.activities}</td>
      <td>{row.activeActivities}</td>
      <td>{row.completedActivities}</td>
      <td>{row.approvalsPending ? <span className="priority-badge">{row.approvalsPending}</span> : <span className="muted-cell">{t('table.none')}</span>}</td>
      <td>{formatRwf(row.budget)}</td>
      <td>{formatRwf(row.spent)}</td>
      <td className={row.remaining < 0 ? 'over-budget' : undefined}>{formatRwf(row.remaining)}</td>
      <td><div className="progress-meter"><span style={{ width: `${Math.max(0, Math.min(100, row.progress))}%` }} /></div><small>{row.progress}%</small></td>
    </tr>)}
  </tbody></table></div>;
}
function Panel({ title, subtitle, action, onAction, children }) { return <section className="panel"><div className="panel-header"><div><h2>{title}</h2>{subtitle && <span>{subtitle}</span>}</div>{action && <button className="text-btn" onClick={onAction} type="button">{action} &rarr;</button>}</div>{children}</section>; }
function EmptyState({ children }) { const t = useT(); return <div className="empty-state"><strong>{children}</strong><span>{t('table.noData')}</span></div>; }
function ProjectPreview({ projects, empty }) { const t = useT(); return projects.length ? <div className="preview-list">{projects.map((project) => <div className="preview-row" key={project.id}><div><strong>{project.name}</strong><span>{project.location} &middot; {project.category || t('activities.notDecided')}</span></div><span className="status-badge">{t(`status.${project.status}`)}</span></div>)}</div> : <EmptyState>{empty}</EmptyState>; }
function ApprovalPreview({ approvals, empty }) { return approvals.length ? <div className="preview-list">{approvals.map((approval) => <div className="preview-row" key={approval.id}><div><strong>{approval.title}</strong><span>{approval.owner} &middot; {formatRwf(approval.amount)}</span></div><span className="priority-badge">{approval.priority}</span></div>)}</div> : <EmptyState>{empty}</EmptyState>; }
function ProjectTable({ projects, managers, onSelect, onAssign, onDelete, empty }) { const t = useT(); return projects.length ? <div className="table-wrap"><table><thead><tr><th>{t('field.project')}</th><th>{t('app.businessOperation')}</th><th>{t('field.location')}</th><th>{t('field.organizationOwner')}</th><th>{t('field.manager')}</th><th>{t('field.status')}</th><th>{t('table.progress')}</th><th>{t('field.budget')}</th><th>{t('field.spent')}</th><th>{t('table.actions')}</th></tr></thead><tbody>{projects.map((project) => <tr key={project.id} onClick={() => onSelect(project.id)}><td><strong>{project.name}</strong><small>{project.id}</small></td><td>{sectorName(project.sector)}</td><td>{project.location}</td><td>{project.owner}</td><td><select value={project.managerId || ''} onClick={(event) => event.stopPropagation()} onChange={(event) => onAssign(project.id, event.target.value)}><option value="">{t('table.unassigned')}</option>{managers.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}</select></td><td><span className="status-badge">{t(`status.${project.status}`)}</span></td><td>{project.progress}%</td><td>{formatRwf(project.budget)}</td><td>{formatRwf(project.spent)}</td><td><button className="danger-btn" onClick={(event) => { event.stopPropagation(); onDelete(project.id); }} type="button">{t('action.delete')}</button></td></tr>)}</tbody></table></div> : <EmptyState>{empty}</EmptyState>; }
// The register doubles as the Director's queue: what was asked for, what was
// approved, and whether anything is still waiting on a decision.
function ActivityTable({ activities, isDirector, openId, onOpen, onDelete, empty }) {
  const t = useT();
  return activities.length ? <div className="table-wrap"><table><thead><tr>
    <th>{t('table.activity')}</th><th>{t('table.category')}</th><th>{t('activities.originalBudget')}</th><th>{t('approval.approved')}</th><th>{t('activities.adjustment')}</th><th>{t('table.status')}</th><th>{t('field.evidence')}</th><th>{t('activities.raisedBy')}</th><th>{t('field.carriedOutBy')}</th><th>{t('table.actions')}</th>
  </tr></thead><tbody>
    {activities.map((activity) => {
      const awaiting = activity.status === 'Pending Approval' || (activity.completionSubmittedAt && activity.status !== 'Completed');
      const due = deadlineNote(activity, displayLanguage());
      return <tr key={activity.id} className={activity.id === openId ? 'row-selected' : undefined}>
        <td><strong>{activity.activity}</strong><small>{activity.description || t('review.noDescription')}</small></td>
        <td>{activity.category}</td>
        <td>{formatUsd(activity.requestedBudget)}</td>
        <td>{activity.approvedBudget === null ? <span className="muted-cell">{t('activities.notDecided')}</span> : formatUsd(activity.approvedBudget)}</td>
        <td className={activity.budgetAdjustment ? 'over-budget' : undefined}>
          {activity.budgetAdjustment ? `${activity.budgetAdjustment > 0 ? '+' : ''}${formatUsd(activity.budgetAdjustment)}` : <span className="muted-cell">&mdash;</span>}
        </td>
        {/* A pending record always names the person it is pending on, so the
            register never presents "Pending" as if anyone could act on it. */}
        <td><span className={`status-badge ${statusTone(activity.status)}`}>{t(`status.${activity.status}`)}</span>
          {activity.approvalRequired && activity.approvalStatus === 'pending' && !['Draft', 'Cancelled'].includes(activity.status)
            ? <small className="awaiting-flag">{t('approval.waitingFor')} {approverName(activity, sectorName, t)}</small>
            : awaiting && <small className="awaiting-flag">{t('activities.completionSubmitted')}</small>}</td>
        <td>{activity.evidenceCount ? `${activity.evidenceCount} \u00d7 ${t('field.file')}` : <span className="muted-cell">{t('table.none')}</span>}</td>
        <td>{activity.createdByName || <span className="muted-cell">&mdash;</span>}</td>
        {/* Who the work sits with, and how its deadline stands. An overdue
            record is flagged here, not only inside the review screen. */}
        <td>{activity.assignedToName
          ? <><strong>{activity.assignedToName}</strong>{activity.deadline && <small className={due && due.tone !== 'ok' ? `deadline-flag deadline-${due.tone}` : undefined}>
            {formatDate(activity.deadline)}{due && due.tone !== 'ok' ? ` · ${due.text}` : ''}
          </small>}</>
          : <span className="muted-cell">{t('table.unassigned')}</span>}</td>
        <td>
          <button className="text-btn" onClick={() => onOpen(activity.id)} type="button">{isDirector ? t('approval.review') : t('action.open')}</button>
          {isDirector && <button className="danger-btn" onClick={() => onDelete(activity.id)} type="button">{t('action.delete')}</button>}
        </td>
      </tr>;
    })}
  </tbody></table></div> : <EmptyState>{empty}</EmptyState>;
}
function ApprovalTable({ approvals, canDecide, onDecide, empty }) {
  const t = useT();
  return approvals.length ? <div className="table-wrap"><table><thead><tr><th>{t('field.whatIsNeeded')}</th><th>{t('app.businessOperation')}</th><th>{t('field.amount')}</th><th>{t('field.organizationOwner')}</th><th>{t('field.priority')}</th><th>{t('table.status')}</th><th>{t('field.requestedBy')}</th><th>{t('field.added')}</th><th>{t('approval.yourDecision')}</th></tr></thead><tbody>
    {approvals.map((approval) => <tr key={approval.id}>
      <td><strong>{approval.title}</strong>{approval.justification && <small className="justification">{approval.justification}</small>}<small>{approval.id}</small></td>
      <td>{sectorName(approval.sector)}</td>
      <td>{formatRwf(approval.amount)}</td>
      <td>{approval.owner}</td>
      <td><span className="priority-badge">{approval.priority}</span></td>
      <td><span className={`status-badge status-${approval.status.toLowerCase()}`}>{approval.status}</span></td>
      <td>{approval.requestedBy}</td>
      <td>{new Date(approval.createdAt).toLocaleDateString()}</td>
      <td>
        {approval.status === 'Pending'
          ? (canDecide
            ? <div className="decision-actions"><button className="text-btn" onClick={() => onDecide(approval, 'Approved')} type="button">{t('approval.approve')}</button><button className="danger-btn" onClick={() => onDecide(approval, 'Rejected')} type="button">{t('action.decline')}</button></div>
            : <span className="muted-cell">Awaiting the Director</span>)
          : <div className="decision-trail"><strong>{approval.decidedBy || 'Recorded'}</strong>{approval.decidedAt && <small>{new Date(approval.decidedAt).toLocaleDateString()}</small>}{approval.decisionNote && <small className="justification">{approval.decisionNote}</small>}</div>}
      </td>
    </tr>)}
  </tbody></table></div> : <EmptyState>{empty}</EmptyState>;
}
// A textarea in a three-column grid is unreadably narrow, so a field can ask
// for two columns of it.
function Field({ label, wide, children }) { return <label className={wide ? 'form-field form-field-wide' : 'form-field'}><span>{label}</span>{children}</label>; }

function AccountForm({ form, setForm, managers, onSubmit }) {
  const t = useT();
  // A manager heads an area, so they report to nobody and the field is hidden.
  const showsManager = form.role === 'staff';
  const managerOptions = managers.filter((manager) => manager.coversAllSectors || manager.sector === form.sector);
  return <form className="form-panel" id="account-form" onSubmit={onSubmit}>
    <div className="panel-header"><div><h2>{t('form.addUser')}</h2><span>{t('form.addUserBlurbHash')}</span></div></div>
    <div className="form-grid">
      <Field label={t('field.name')}><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
      <Field label={t('field.username')}><input required autoComplete="off" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} /></Field>
      <Field label={t('field.password')}><input required minLength="6" type="password" autoComplete="new-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></Field>
      {/* Switching to a team member drops an "all operations" choice that only a
          manager may hold, rather than submitting a value the API will refuse. */}
      <Field label={t('field.role')}><select required value={form.role} onChange={(event) => { const role = event.target.value; setForm({ ...form, role, managerId: '', sector: role !== 'manager' && form.sector === ALL_OPERATIONS ? '' : form.sector }); }}><option value="manager">{t('role.manager')}</option><option value="staff">{t('role.staff')}</option></select></Field>
      {/* Only a manager can carry every operation at once; a team member always
          sits in exactly one, so the choice is offered for managers alone. */}
      <Field label={t('field.workingArea')}><select required value={form.sector || ''} onChange={(event) => setForm({ ...form, sector: event.target.value, managerId: '' })}><option value="">{t('form.selectOperation')}</option>{form.role === 'manager' && <option value={ALL_OPERATIONS}>{t('user.allOperations')}</option>}{sectors.map((sector) => <option key={sector.id} value={sector.id}>{sectorName(sector.id)}</option>)}</select></Field>
      {showsManager && <Field label={t('field.reportsTo')}><select value={form.managerId || ''} onChange={(event) => setForm({ ...form, managerId: event.target.value })} disabled={!form.sector}><option value="">{t('form.noManagerYet')}</option>{managerOptions.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}</select></Field>}
    </div>
    <button className="primary-btn" type="submit">{form.role === 'manager' ? t('form.addManager') : t('form.addTeamMember')}</button>
  </form>;
}
function ProjectForm({ form, setForm, managers, onSubmit }) { const t = useT(); return <form className="form-panel" id="project-form" onSubmit={onSubmit}><div className="panel-header"><div><h2>{t('form.addProject')}</h2><span>{t('form.addProjectBlurb')}</span></div></div><div className="form-grid"><Field label={t('field.name')}><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field><Field label={t('app.businessOperation')}><select value={form.sector} onChange={(event) => setForm({ ...form, sector: event.target.value })}>{sectors.map((sector) => <option key={sector.id} value={sector.id}>{sectorName(sector.id)}</option>)}</select></Field><Field label={t('field.location')}><input required value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} /></Field><Field label={t('field.organizationOwner')}><input required value={form.owner} onChange={(event) => setForm({ ...form, owner: event.target.value })} /></Field><Field label={t('field.status')}><select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>{['On Track', 'In Review', 'Delayed', 'Healthy'].map((option) => <option key={option} value={option}>{t(`status.${option}`)}</option>)}</select></Field><Field label={t('table.progress')}><input required type="number" min="0" max="100" value={form.progress} onChange={(event) => setForm({ ...form, progress: event.target.value })} /></Field><Field label={t('field.category')}><input required value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} /></Field><Field label={t('field.manager')}><select value={form.managerId} onChange={(event) => setForm({ ...form, managerId: event.target.value })}><option value="">{t('table.unassigned')}</option>{managers.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}</select></Field><Field label={t('field.budget')}><input required type="number" min="0" value={form.budget} onChange={(event) => setForm({ ...form, budget: event.target.value })} /></Field><Field label={t('field.spent')}><input required type="number" min="0" value={form.spent} onChange={(event) => setForm({ ...form, spent: event.target.value })} /></Field></div><button className="primary-btn" type="submit">{t('form.addProject')}</button></form>; }
// One form for both ways in. A manager fills it to raise work and the budget it
// needs, which the Director then decides; the Director fills it to hand work
// out, and the three fields at the end -- who carries it out, by when, and on
// what terms -- are theirs alone.
function ActivityForm({ form, setForm, projects, selectedProject, sectorOptions, managers, isDirector, usd, onChooseProject, onSubmit }) {
  const t = useT();
  // A manager only ever reads their own working area, so only the managers who
  // cover the chosen area can be handed the work. The API refuses the rest.
  // A manager covering every operation can take work in any of them, so they
  // belong in every list alongside that operation's own managers.
  const managerOptions = managers.filter((manager) => manager.coversAllSectors || manager.sector === form.sector);
  const incomplete = !form.projectId || !form.category.trim() || !form.activity.trim()
    || Number(form.quantity) <= 0 || form.costUsd === '' || (isDirector && !form.assignedTo);

  return <form className="form-panel" id="activity-form" onSubmit={onSubmit}>
    <div className="panel-header"><div>
      <h2>{isDirector ? t('form.assignAnActivity') : t('form.raiseAnActivity')}</h2>
      <span>
        {selectedProject ? `${t('form.selectedProject')}: ${selectedProject.name}` : t('form.selectProjectFirst')}
        {' '}{isDirector ? t('form.goesToManager') : t('form.submittedToDirector')}
      </span>
    </div></div>
    <div className="form-grid activity-grid">
      <Field label={t('field.project')}>
        <select required value={form.projectId} onChange={(event) => onChooseProject(event.target.value)}>
          <option value="">{t('form.selectProject')}</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </Field>
      <Field label={t('field.workingArea')}>
        <select required value={form.sector} onChange={(event) => setForm({ ...form, sector: event.target.value, categoryChoice: '', category: '', assignedTo: '' })}>
          {sectorOptions.map((sector) => <option key={sector.id} value={sector.id}>{sectorName(sector.id)}</option>)}
        </select>
      </Field>
      <Field label={t('field.category')}>
        <select required value={form.categoryChoice} onChange={(event) => { const choice = event.target.value; setForm({ ...form, categoryChoice: choice, category: choice === OTHER_CATEGORY ? '' : choice }); }}>
          <option value="">{t('form.selectCategory')}</option>
          {categoriesForSector(form.sector).map((category) => <option key={category} value={category}>{category}</option>)}
          <option value={OTHER_CATEGORY}>{t('form.otherSpecify')}</option>
        </select>
      </Field>
      {form.categoryChoice === OTHER_CATEGORY && <Field label={t('field.specifyCategory')}>
        <input required value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} />
      </Field>}
      <Field label={t('field.activity')}>
        <input required value={form.activity} onChange={(event) => setForm({ ...form, activity: event.target.value })} />
      </Field>
      <Field label={t('field.description')}>
        <input placeholder={isDirector ? t('form.whatWorkInvolves') : t('form.whyWorkNeeded')} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
      </Field>
      <Field label={isDirector ? t('form.materialsToBuy') : t('form.materialsRequested')}>
        <textarea rows="3" placeholder={t('form.onePerLine')} value={form.materials} onChange={(event) => setForm({ ...form, materials: event.target.value })} />
      </Field>
      <Field label={t('field.quantity')}>
        <input required type="number" min="0.01" step="0.01" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} />
      </Field>
      <Field label={isDirector ? t('form.budgetUsd') : t('form.requestedBudgetUsd')}>
        <input required type="number" min="0" step="0.01" placeholder={isDirector ? t('form.amountReleased') : t('form.amountNeeded')} value={form.costUsd} onChange={(event) => setForm({ ...form, costUsd: event.target.value })} />
      </Field>
      <Field label={t('field.equivalentRwf')}><input readOnly value={usd ? usd * exchangeRates.rwfPerUsd : ''} placeholder={t('form.calculatedFromUsd')} /></Field>
      <Field label={t('field.equivalentCdf')}><input readOnly value={usd ? usd * exchangeRates.cdfPerUsd : ''} placeholder={t('form.calculatedFromUsd')} /></Field>
      {isDirector && <>
        <Field label={t('field.carriedOutBy')}>
          <select required value={form.assignedTo} onChange={(event) => setForm({ ...form, assignedTo: event.target.value })} disabled={!managerOptions.length}>
            <option value="">{t('form.selectManager')}</option>
            {managerOptions.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}
          </select>
        </Field>
        <Field label={t('field.deadline')}>
          <input type="date" value={form.deadline} onChange={(event) => setForm({ ...form, deadline: event.target.value })} />
        </Field>
        <Field label={t('field.instructionsForManager')} wide>
          <textarea rows="3" value={form.instructions} onChange={(event) => setForm({ ...form, instructions: event.target.value })} />
        </Field>
      </>}
      <label className="check-field"><input type="checkbox" checked={form.signed} onChange={(event) => setForm({ ...form, signed: event.target.checked })} />{t('form.signed')}</label>
    </div>
    {isDirector && !managerOptions.length && <p className="decision-hint">{t('form.noManagerCovers')}</p>}
    <button className="primary-btn" disabled={incomplete} type="submit">{isDirector ? t('action.assignActivity') : t('form.submitForReview')}</button>
  </form>;
}
function ApprovalForm({ form, setForm, sectorOptions, onSubmit }) { const t = useT(); return <form className="form-panel" onSubmit={onSubmit}><div className="panel-header"><div><h2>{t('form.raiseRequest')}</h2><span>{t('form.raiseRequestBlurb')}</span></div></div><div className="form-grid"><Field label={t('field.whatIsNeeded')}><input required value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></Field><Field label={t('app.businessOperation')}><select value={form.sector} onChange={(event) => setForm({ ...form, sector: event.target.value })}>{sectorOptions.map((sector) => <option key={sector.id} value={sector.id}>{sectorName(sector.id)}</option>)}</select></Field><Field label={t('field.estimatedAmount')}><input required type="number" min="0" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></Field><Field label={t('field.organizationOwner')}><input required value={form.owner} onChange={(event) => setForm({ ...form, owner: event.target.value })} /></Field><Field label={t('field.priority')}><select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })}>{[['Low', 'form.priorityLow'], ['Medium', 'form.priorityMedium'], ['High', 'form.priorityHigh']].map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}</select></Field><Field label={t('field.requestedBy')}><input readOnly value={form.requestedBy} /></Field><Field label={t('field.reasonForRequest')}><textarea required rows="3" value={form.justification} onChange={(event) => setForm({ ...form, justification: event.target.value })} /></Field></div><button className="primary-btn" type="submit">{t('action.sendForApproval')}</button></form>; }
// The Reports section: pick a period, read the figures, take them away.
//
// Every number below is computed on the server from the activity register, and
// the PDF and Excel exports run the very same scoped query, so what a manager
// downloads is exactly what a manager can see.
function ReportsSection({ mode, range, report, busy, sectorLabel, onModeChange, onRangeChange, onGenerate, onExport, onPrint, onClose }) {
  const t = useT();
  const ready = mode !== 'custom' || (range.start && range.end && range.start <= range.end);

  return <section className="report-area report-print-area">
    <div className="panel-header">
      <div>
        <h2>{t('report.title')}</h2>
        <span>{t('report.blurb')}</span>
      </div>
      <div className="report-actions report-controls">
        {REPORT_MODES.map(([id, key]) => <button
          key={id}
          className={mode === id ? 'primary-btn' : 'secondary-btn'}
          onClick={() => onModeChange(id)}
          type="button"
        >{t(key)}</button>)}
      </div>
    </div>

    <div className="report-picker report-controls">
      {mode === 'weekly' && <Field label={t('report.anyDayInWeek')}>
        <input type="date" value={range.week} onChange={(event) => onRangeChange({ week: event.target.value })} />
      </Field>}
      {mode === 'monthly' && <Field label={t('report.month')}>
        <input type="month" value={range.month} onChange={(event) => onRangeChange({ month: event.target.value })} />
      </Field>}
      {mode === 'custom' && <>
        <Field label={t('report.startDate')}>
          <input type="date" value={range.start} onChange={(event) => onRangeChange({ start: event.target.value })} />
        </Field>
        <Field label={t('report.endDate')}>
          <input type="date" value={range.end} onChange={(event) => onRangeChange({ end: event.target.value })} />
        </Field>
      </>}
      <button className="primary-btn" type="button" disabled={busy || !ready} onClick={onGenerate}>
        {busy ? t('report.working') : t('action.generateReport')}
      </button>
      {mode === 'custom' && !ready && <span className="report-hint">{t('report.chooseValidRange')}</span>}
    </div>

    {report && <ReportBody
      report={report}
      busy={busy}
      sectorLabel={sectorLabel}
      onExport={onExport}
      onPrint={onPrint}
      onClose={onClose}
    />}
  </section>;
}

function ReportBody({ report, busy, sectorLabel, onExport, onPrint, onClose }) {
  const t = useT();
  const counts = report.activitySummary;
  const budget = report.budgetSummary;

  return <div className="report-result-body">
    <div className="report-meta">
      <div>
        <strong>{report.period.label}</strong>
        <span>
          {report.period.start} {t('report.to')} {report.period.end} &middot; {sectorName(report.scope.sector) || report.scope.sectorName}
          {' '}&middot; {t('report.generated')} {new Date(report.generatedAt).toLocaleString()}
        </span>
        <span className="muted-cell">{report.basis}</span>
      </div>
      <div className="report-actions report-controls">
        <button className="secondary-btn" type="button" disabled={busy} onClick={() => onExport('pdf')}>{t('action.exportPdf')}</button>
        <button className="secondary-btn" type="button" disabled={busy} onClick={() => onExport('xlsx')}>{t('action.exportExcel')}</button>
        <button className="secondary-btn" type="button" onClick={onPrint}>{t('action.print')}</button>
        <button className="text-btn" type="button" onClick={onClose}>{t('action.close')}</button>
      </div>
    </div>

    {counts.total === 0
      ? <div className="empty-state">
        <strong>{t('report.noneInPeriod')}</strong>
        <span>{t('report.nothingBetween')}</span>
      </div>
      : <>
        <h3 className="form-section-title">{t('report.activitySummary')}</h3>
        {/* Overdue cuts across the other counts rather than being one of them,
            so these six are not meant to add up to the total. */}
        <div className="metric-grid metric-grid-6">
          <Metric label={t('report.totalActivities')} value={counts.total} />
          <Metric label={t('portal.completed')} value={counts.completed} />
          <Metric label={t('portal.inProgress')} value={counts.inProgress} />
          <Metric label={t('approval.pending')} value={counts.pending} />
          <Metric label={t('report.overdue')} value={counts.overdue} />
          <Metric label={t('status.Cancelled')} value={counts.cancelled} />
        </div>

        <h3 className="form-section-title">{t('report.budgetSummary')}</h3>
        <div className="budget-strip budget-strip-4">
          <div className="budget-block">
            <span>{t('report.totalAssignedBudget')}</span>
            <strong>{formatUsd(budget.assigned)}</strong>
            <small>What was originally set or asked for</small>
          </div>
          <div className={`budget-block${budget.revised !== budget.assigned ? ' budget-adjusted' : ''}`}>
            <span>{t('report.totalRevisedBudget')}</span>
            <strong>{formatUsd(budget.revised)}</strong>
            <small>{budget.revised === budget.assigned ? 'Unchanged on review' : `${budget.revised > budget.assigned ? '+' : ''}${formatUsd(budget.revised - budget.assigned)} against the original`}</small>
          </div>
          <div className="budget-block">
            <span>{t('report.totalActualSpending')}</span>
            <strong>{formatUsd(budget.spent)}</strong>
            <small>{budget.utilisation}% of the revised budget, from filed evidence</small>
          </div>
          <div className={`budget-block${budget.remaining < 0 ? ' budget-adjusted' : ''}`}>
            <span>{t('report.remainingBudget')}</span>
            <strong>{formatUsd(budget.remaining)}</strong>
            <small>{budget.remaining < 0 ? 'Spending has passed the released budget' : 'Released but not yet spent'}</small>
          </div>
        </div>

        <h3 className="form-section-title">{t('report.managerPerformance')}</h3>
        <div className="table-wrap"><table>
          <thead><tr>
            <th>{t('field.manager')}</th><th>{t('report.activitiesAssigned')}</th><th>{t('portal.completed')}</th><th>{t('portal.inProgress')}</th>
            <th>{t('report.overdue')}</th><th>{t('report.totalBudgetHandled')}</th><th>{t('field.spent')}</th>
          </tr></thead>
          <tbody>{report.managers.map((entry) => <tr key={entry.managerId ?? 'unassigned'}>
            <td><strong>{entry.managerName}</strong>
              {entry.managerId === null && <small className="muted-cell">Work nobody has been given yet</small>}</td>
            <td>{entry.assigned}</td>
            <td>{entry.completed}</td>
            <td>{entry.inProgress}</td>
            <td className={entry.overdue ? 'over-budget' : undefined}>{entry.overdue || <span className="muted-cell">0</span>}</td>
            <td>{formatUsd(entry.budgetHandled)}</td>
            <td>{formatUsd(entry.spent)}</td>
          </tr>)}</tbody>
        </table></div>

        <h3 className="form-section-title">{t('report.activityDetails')}</h3>
        <div className="table-wrap"><table className="report-detail-table">
          <thead><tr>
            <th>{t('table.activity')}</th><th>{t('report.projectArea')}</th><th>{t('report.assignedManager')}</th>
            <th>{t('activities.originalBudget')}</th><th>{t('report.revisedBudget')}</th><th>{t('report.actualSpending')}</th>
            <th>{t('table.status')}</th><th>{t('report.dateAssigned')}</th><th>{t('report.completionDate')}</th><th>{t('report.adminNotes')}</th>
          </tr></thead>
          <tbody>{report.activities.map((item) => <tr key={item.id}>
            <td><strong>{item.activity}</strong><small>{item.category}</small></td>
            <td>{item.projectName}<small className="muted-cell">{sectorLabel(item.sector)}</small></td>
            <td>{item.assignedToName || <span className="muted-cell">{t('review.notAssigned')}</span>}</td>
            <td>{formatUsd(item.originalBudget)}</td>
            {/* An undecided budget is not a zero, and showing it as one would
                read as the Director having released nothing. */}
            <td className={item.budgetAdjustment ? 'over-budget' : undefined}>
              {item.revisedBudget === null
                ? <span className="muted-cell">Not decided</span>
                : <>{formatUsd(item.revisedBudget)}
                  {item.budgetAdjustment ? <small>{item.budgetAdjustment > 0 ? '+' : ''}{formatUsd(item.budgetAdjustment)}</small> : null}</>}
            </td>
            <td>{formatUsd(item.actualSpending)}
              <small className={item.remainingBudget < 0 ? 'over-budget' : 'muted-cell'}>
                {formatUsd(item.remainingBudget)} left
              </small></td>
            <td><span className={`status-badge ${statusTone(item.status)}`}>{item.status}</span>
              {item.overdue && <small className="deadline-flag deadline-overdue">Overdue</small>}</td>
            <td>{item.dateAssigned ? formatDate(item.dateAssigned) : <span className="muted-cell">&mdash;</span>}</td>
            <td>{item.completionDate ? formatDate(item.completionDate) : <span className="muted-cell">&mdash;</span>}</td>
            <td className="report-note-cell"><ReportNotes item={item} /></td>
          </tr>)}</tbody>
        </table></div>
      </>}
  </div>;
}

// Why a budget moved, which is the whole point of keeping the original figure
// beside the revised one. The Director's standing note, the trail of what they
// actually changed it to, and any request a manager raised, all read together.
function ReportNotes({ item }) {
  const hasAnything = item.adminNote || item.budgetRevisions.length || item.budgetRequests.length;
  if (!hasAnything) return <span className="muted-cell">&mdash;</span>;

  return <div className="report-notes">
    {item.adminNote && <span className="admin-note">&ldquo;{item.adminNote}&rdquo;</span>}
    {item.budgetRevisions.map((change, index) => <small key={`revision-${index}`}>
      {change.from === null ? 'Not set' : formatUsd(change.from)} &rarr; {change.to === null ? 'not set' : formatUsd(change.to)}
      {change.changedBy ? ` by ${change.changedBy}` : ''}
      {change.note ? ` — ${change.note}` : ''}
    </small>)}
    {item.budgetRequests.map((request, index) => <small key={`request-${index}`}>
      {request.requestedBy || 'Manager'} asked for {formatUsd(request.requestedAmount)}: {request.reason}
      {' '}({request.status === 'Pending' ? 'awaiting an answer' : request.status.toLowerCase()})
      {request.decisionNote ? ` — ${request.decisionNote}` : ''}
    </small>)}
  </div>;
}

export default App;
