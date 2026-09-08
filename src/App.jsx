import { useCallback, useEffect, useMemo, useState } from 'react';
import MovementModule from './MovementModule.jsx';
import ActivityReview, { ACTIVITY_STATUSES, deadlineNote, formatDate, formatUsd, statusTone } from './ActivityReview.jsx';

// Keep in step with `sectors` in server/data/seedData.js, which is the source of
// truth the API validates against.
const sectors = [
  {
    id: 'farming',
    name: 'Farming Activity',
    categories: [
      'Land preparation', 'Planting and sowing', 'Irrigation', 'Fertilizer and inputs',
      'Pest and disease control', 'Livestock and animal feed', 'Harvesting',
      'Storage and preservation', 'Farm equipment and tools', 'Farm labour'
    ]
  },
  {
    id: 'mining',
    name: 'Mining Activity',
    categories: [
      'Exploration and survey', 'Extraction', 'Haulage', 'Washing and sorting',
      'Processing', 'Site preparation and access roads', 'Machinery and equipment',
      'Safety and protective equipment', 'Licenses and permits', 'Mining labour'
    ]
  },
  {
    id: 'agriculture',
    name: 'Agriculture Activity',
    categories: [
      'Seeds and seedlings', 'Land preparation', 'Planting', 'Crop maintenance',
      'Fertilizer and agro-inputs', 'Harvesting', 'Post-harvest handling',
      'Storage and warehousing', 'Transport to market', 'Agricultural labour'
    ]
  },
  {
    id: 'movement',
    name: 'Logistics & Facilitation',
    categories: [
      'Vehicle hire', 'Fuel and lubricants', 'Freight and haulage', 'Border clearance',
      'Permits and licenses', 'Escort and security', 'Warehousing and handling',
      'Loading and offloading', 'Travel and allowances', 'Documentation and administration'
    ]
  }
];

const OTHER_CATEGORY = 'Other (specify)';

function categoriesForSector(sectorId) {
  return sectors.find((sector) => sector.id === sectorId)?.categories || [];
}

// Rows store the sector id ('movement'), which is not what a reader should see.
function sectorName(sectorId) {
  return sectors.find((sector) => sector.id === sectorId)?.name || sectorId;
}

const emptyProject = { name: '', sector: 'agriculture', location: '', owner: '', status: 'On Track', progress: '', budget: '', spent: '', category: '', managerId: '' };
// One form, two ways round. A manager raises an activity, which is born
// awaiting the Director's review, so it carries no status and no "approved"
// tick for the requester to set. The Director instead hands work out: the last
// three fields are theirs, and what they assign is funded from the start.
const emptyActivity = { projectId: '', sector: 'agriculture', categoryChoice: '', category: '', activity: '', description: '', materials: '', quantity: '', costUsd: '', signed: false, assignedTo: '', deadline: '', instructions: '' };
// The statuses that mean assigned work is still on the manager's desk. Closed
// and refused records drop out of their queue.
const OPEN_ASSIGNMENT_STATUSES = ['Assigned', 'Accepted', 'In Progress', 'Needs Correction'];
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

const REPORT_MODES = [['weekly', 'Weekly Report'], ['monthly', 'Monthly Report'], ['custom', 'Custom Period']];

function App() {
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
        fetchJson('/api/approvals'), fetchJson('/api/managers'), fetchJson('/api/users')
      ]);
      const [summaryResult, projectResult, activityResult, approvalResult, managerResult, userResult] = results;
      const criticalResults = [summaryResult, projectResult, activityResult, approvalResult];
      const criticalFailure = criticalResults.find((result) => result.status === 'rejected');
      if (criticalFailure) throw criticalFailure.reason;

      setSummary(summaryResult.value);
      setProjects(projectResult.value);
      setActivities(activityResult.value);
      setApprovals(approvalResult.value);
      setManagers(managerResult.status === 'fulfilled' ? managerResult.value : []);
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
        loadData();
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
    return updateAssignment(account, { sector, managerId: manager && manager.sector === sector ? manager.id : null });
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

  // The review screen wants the record, its evidence and its trail together, so
  // one request carries all three and one refresh keeps them in step.
  const openActivity = async (activityId) => {
    setError('');
    try {
      setActivityDetail(await fetchJson(`/api/activities/${activityId}`));
    } catch (openError) { setError(openError.message); }
  };

  const refreshActivity = async (activityId) => {
    try {
      setActivityDetail(await fetchJson(`/api/activities/${activityId}`));
      await loadData();
    } catch (refreshError) { setError(refreshError.message); }
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
  const awaitingReview = (activity) => activity.status === 'Pending Review'
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
    return <div className="login-shell"><form className="login-card" onSubmit={login}>
      <img className="login-logo" src="/logo.png" srcSet="/logo.png 1x, /logo@2x.png 2x" alt="Gisuma Project Operations Management" /><h1>Sign in</h1>
      <p>Access your operational records and approvals.</p>
      <label>Username<input required value={loginForm.username} onChange={(event) => setLoginForm({ ...loginForm, username: event.target.value })} /></label>
      <label>Password<input required type="password" value={loginForm.password} onChange={(event) => setLoginForm({ ...loginForm, password: event.target.value })} /></label>
      <button className="primary-btn full-width" type="submit">Sign in</button>
      {error && <div className="error-state">{error}</div>}
    </form></div>;
  }

  const isDirector = user.role === 'super-admin';

  // Four figures everyone gets, and a fifth that depends on who is reading it:
  // the Director sees the size of the organisation, a manager sees the work
  // sitting on their own desk.
  const dashboardMetrics = [
    ['Projects', summary.summary?.totalProjects || 0],
    ['Activities in progress', summary.summary?.activeOperations || 0],
    ['Pending approvals', summary.summary?.approvalsPending || 0],
    ['Completion rate', `${summary.summary?.completionRate || 0}%`],
    ...(typeof summary.summary?.registeredUsers === 'number' ? [['Registered users', summary.summary.registeredUsers]] : []),
    // The API counts only what is actually waiting on the manager -- work they
    // have not accepted, and work sent back -- not everything they hold.
    ...(isDirector ? [] : [['Needing your action', summary.summary?.activitiesAssignedToMe || 0]])
  ];

  const navItems = [
    ['dashboard', 'Dashboard'], ['projects', 'Projects'], ['activities', 'Activities'], ['approvals', 'Approvals'], ['movements', 'Logistics & Facilitation'],
    ...(isDirector ? [['users', 'User management']] : [])
  ];

  return <div className="application-shell">
    <aside className="sidebar">
      <div className="brand-lockup"><img className="brand-logo" src="/logo-mark.png" alt="" /><div><strong>Gisuma</strong><span>Project Operations</span></div></div>
      <div className="sidebar-label">Workspace</div>
      <nav>{navItems.map(([id, label]) => <button key={id} className={activeView === id ? 'nav-item active' : 'nav-item'} onClick={() => setActiveView(id)} type="button"><span className={`nav-icon nav-${id}`} />{label}</button>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-label">Signed in as</div><strong>{user.name}</strong><span>{roleName(user.role)}</span>{user.sector && <span>Area: {sectorName(user.sector)}</span>}<button className="logout-btn" onClick={logout} type="button">Sign out</button></div>
    </aside>

    <div className="main-area">
      <header className="top-header"><div><span className="eyebrow">OPERATIONS CONTROL</span><h1>{navItems.find(([id]) => id === activeView)?.[1]}</h1></div><div className="header-meta"><span className="connection-dot" />Database connected</div></header>
      {message && <div className="success-banner">{message}<button type="button" onClick={() => setMessage('')}>Dismiss</button></div>}
      {error && <div className="error-banner">{error}<button type="button" onClick={() => setError('')}>Dismiss</button></div>}
      {loading ? <div className="loading-state"><span className="spinner" />Loading records from database...</div> : <>

        {activeView === 'dashboard' && <>
          <section className="welcome-strip"><div><span className="eyebrow">SYSTEM OVERVIEW</span><h2>Operational visibility in one place.</h2><p>Review the records currently available in the system.</p></div><button className="primary-btn" type="button" onClick={() => setActiveView('activities')}>{isDirector ? 'Assign activity' : 'Raise activity'}</button></section>
          <div className={`metric-grid${dashboardMetrics.length === 5 ? ' metric-grid-5' : ''}`}>
            {dashboardMetrics.map(([label, value]) => <Metric key={label} label={label} value={value} />)}
          </div>
          {/* A manager's own queue: what the Director handed them, soonest
              deadline first, so nothing is accepted late or quietly forgotten. */}
          {!isDirector && <Panel
            title="Work assigned to you"
            subtitle={`${myAssignments.length} activit${myAssignments.length === 1 ? 'y' : 'ies'} handed to you by the Director. Open one to read the instructions and accept it.`}
            action="Open register"
            onAction={() => { setActivityStatusFilter('Assigned to me'); setActiveView('activities'); }}
          >
            <AssignmentQueue
              activities={myAssignments.slice(0, 6)}
              onOpen={(id) => { setActiveView('activities'); openActivity(id); }}
              empty="Nothing has been assigned to you yet."
            />
          </Panel>}
          {/* A request submitted by a manager lands here the moment it is
              raised, so nothing sits unnoticed in the register. */}
          <Panel
            title={user.role === 'super-admin' ? 'Activities awaiting your review' : 'Your activities awaiting the Director'}
            subtitle={`${summary.summary?.activityReviewsPending || 0} new request${(summary.summary?.activityReviewsPending || 0) === 1 ? '' : 's'} · ${summary.summary?.completionsAwaitingReview || 0} submitted as finished`}
            action="Open register"
            onAction={() => setActiveView('activities')}
          >
            <ReviewQueue
              activities={reviewQueue.slice(0, 6)}
              onOpen={(id) => { setActiveView('activities'); openActivity(id); }}
              empty={user.role === 'super-admin' ? 'Nothing is waiting on a decision.' : 'None of your activities are waiting on the Director.'}
            />
          </Panel>
          {(summary.sectorBreakdown || []).length > 1 && <Panel title="Sector overview" subtitle="Every sector side by side. Select a row to open it in the project register."><SectorBoard rows={summary.sectorBreakdown} onSelect={(sector) => { setSectorFilter(sector); setActiveView('projects'); }} /></Panel>}
          <div className="dashboard-columns"><Panel title="Projects" action="View all" onAction={() => setActiveView('projects')}><ProjectPreview projects={projects.slice(0, 5)} empty="No projects have been added." /></Panel><Panel title="Pending approvals" action="Review" onAction={() => setActiveView('approvals')}><ApprovalPreview approvals={pendingApprovals.slice(0, 5)} empty="No pending approvals." /></Panel></div>
        </>}

        {activeView === 'projects' && <><section className="toolbar-row"><div className="filter-group"><select value={sectorFilter} onChange={(event) => setSectorFilter(event.target.value)}><option value="All">All sectors</option>{(summary.sectors || sectors).map((sector) => <option key={sector.id} value={sector.id}>{sector.name}</option>)}</select><input placeholder="Search projects" value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} /></div>{user.role === 'super-admin' && <button className="primary-btn" type="button" onClick={() => document.getElementById('project-form')?.scrollIntoView({ behavior: 'smooth' })}>Add project</button>}</section><Panel title="Project register" subtitle={`${filteredProjects.length} record${filteredProjects.length === 1 ? '' : 's'}`}><ProjectTable projects={filteredProjects} managers={managers} onSelect={chooseProject} onAssign={assignManager} onDelete={(id) => deleteRecord(`/api/projects/${id}`, 'project')} empty="No projects match the current filters." /></Panel>{user.role === 'super-admin' && <ProjectForm form={projectForm} setForm={setProjectForm} managers={managers} onSubmit={(event) => submit(event, '/api/projects', projectForm, 'Project added.', () => setProjectForm(emptyProject))} />}</>}

        {activeView === 'activities' && <>
          <section className="context-strip">
            <div><span className="eyebrow">PROJECT ACTIVITY REGISTER</span><h2>Activities and requests</h2><p>{isDirector ? 'Hand work to a sector manager with its budget and deadline, or review what a manager has raised, and close it once the evidence is in.' : 'Accept the work the Director assigns you, or raise the work and the budget you need. Attach the evidence and submit it when it is done.'}</p></div>
            <select value={selectedProjectId} onChange={(event) => chooseProject(event.target.value)}><option value="">Select project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
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
          />}

          <section className="toolbar-row"><div className="filter-group">
            <select value={activityStatusFilter} onChange={(event) => setActivityStatusFilter(event.target.value)}>
              <option value="All">All statuses</option>
              <option value="Awaiting review">Awaiting review</option>
              {!isDirector && <option value="Assigned to me">Assigned to me</option>}
              {ACTIVITY_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
            <select value={selectedProjectId} onChange={(event) => chooseProject(event.target.value)}><option value="">All projects</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
          </div></section>

          <Panel title="Activity register" subtitle={`${selectedActivities.length} record${selectedActivities.length === 1 ? '' : 's'}. Open one to see the request, the decision, the evidence and the full history.`}>
            <ActivityTable
              activities={selectedActivities}
              isDirector={user.role === 'super-admin'}
              openId={activityDetail?.activity?.id}
              onOpen={openActivity}
              onDelete={(id) => { setActivityDetail(null); return deleteRecord(`/api/activities/${id}`, 'activity'); }}
              empty="No activities match the current filters."
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

        {activeView === 'approvals' && <><section className="toolbar-row"><div className="filter-group"><select value={sectorFilter} onChange={(event) => setSectorFilter(event.target.value)}><option value="All">All sectors</option>{(summary.sectors || sectors).map((sector) => <option key={sector.id} value={sector.id}>{sector.name}</option>)}</select></div></section><Panel title="Approval register" subtitle={`${approvals.length} record${approvals.length === 1 ? '' : 's'}`}><ApprovalTable approvals={approvals.filter((approval) => sectorFilter === 'All' || approval.sector === sectorFilter)} canDecide={user.role === 'super-admin'} onDecide={decideApproval} empty="No approval records available." /></Panel><ApprovalForm form={approvalForm} setForm={setApprovalForm} sectorOptions={sectorOptions} onSubmit={(event) => submit(event, '/api/approvals', approvalForm, 'Request sent for approval.', () => setApprovalForm({ ...emptyApproval, sector: sectorOptions[0]?.id || emptyApproval.sector, requestedBy: user.name }))} /></>}

        {activeView === 'users' && user.role === 'super-admin' && <>
          <div className="metric-grid metric-grid-5">
            <Metric label="Registered users" value={register.total} />
            <Metric label="Sector managers" value={register.roleCounts?.manager || 0} />
            <Metric label="Team members" value={register.roleCounts?.staff || 0} />
            <Metric label="Without a manager" value={register.unassigned || 0} />
            <Metric label="Areas without a manager" value={sectors.filter((sector) => !register.users.some((account) => account.role === 'manager' && account.sector === sector.id)).length} />
          </div>
          <section className="toolbar-row"><div className="filter-group">
            <select value={userRoleFilter} onChange={(event) => setUserRoleFilter(event.target.value)}>
              <option value="All">All roles</option>
              <option value="super-admin">Director</option>
              <option value="manager">Sector manager</option>
              <option value="staff">Team member</option>
            </select>
            <input placeholder="Search users" value={userSearch} onChange={(event) => setUserSearch(event.target.value)} />
          </div><button className="primary-btn" type="button" onClick={() => document.getElementById('account-form')?.scrollIntoView({ behavior: 'smooth' })}>Add user</button></section>
          <Panel title="User management" subtitle={`${filteredUsers.length} of ${register.total} account${register.total === 1 ? '' : 's'}. Change a manager, a working area, or a password here.`}>
            <UserTable users={filteredUsers} managers={managers} onChangeManager={changeUserManager} onChangeSector={changeUserSector} onResetPassword={resetPassword} empty="No accounts match the current filters." />
          </Panel>
          <AccountForm form={accountForm} setForm={setAccountForm} managers={managers} onSubmit={(event) => submit(event, '/api/users', { ...accountForm, managerId: accountForm.managerId || null }, 'Account created.', () => setAccountForm(emptyAccount))} />
        </>}

        {activeView === 'movements' && <MovementModule user={user} token={token} fetchJson={fetchJson} onMessage={setMessage} onError={setError} />}
      </>}</div>
  </div>;
}

function UserTable({ users, managers, onChangeManager, onChangeSector, onResetPassword, empty }) {
  return users.length ? <div className="table-wrap"><table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Reports to</th><th>Area of work</th><th>Projects</th><th>Team</th><th>Added</th><th>Password</th><th>Action</th></tr></thead><tbody>
    {users.map((account) => {
      const isDirector = account.role === 'super-admin';
      // Only managers who work the same area can be picked, which is the rule
      // the API applies; the current manager stays listed so the cell is never
      // blank while the two are still in step.
      const managerOptions = managers.filter((manager) => manager.id !== account.id
        && (manager.sector === account.sector || manager.id === account.managerId));
      return <tr key={account.id}>
        <td><strong>{account.name}</strong><small>#{account.id}</small></td>
        <td>{account.username}</td>
        <td><span className={isDirector ? 'role-badge role-admin' : 'role-badge'}>{roleName(account.role)}</span></td>
        <td>{isDirector ? <span className="muted-cell">Reports to nobody</span>
          : <select value={account.managerId || ''} onChange={(event) => onChangeManager(account, event.target.value)}>
            <option value="">No manager</option>
            {managerOptions.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}
          </select>}</td>
        <td>{isDirector ? <span className="muted-cell">All areas</span>
          : <select value={account.sector || ''} onChange={(event) => onChangeSector(account, event.target.value)}>
            {!account.sector && <option value="">Not assigned</option>}
            {sectors.map((sector) => <option key={sector.id} value={sector.id}>{sector.name}</option>)}
          </select>}</td>
        <td>{account.assignedProjects}</td>
        <td>{account.teamSize || <span className="muted-cell">&mdash;</span>}</td>
        <td>{account.createdAt ? new Date(account.createdAt).toLocaleDateString() : <span className="muted-cell">&mdash;</span>}</td>
        {/* Only ever a date. The stored value is a bcrypt hash, so there is no
            password here for anyone, the Director included, to read. */}
        <td>{account.passwordChangedAt ? <span className="muted-cell">Reset {new Date(account.passwordChangedAt).toLocaleDateString()}</span> : <span className="muted-cell">Original</span>}</td>
        <td><button className="text-btn" onClick={() => onResetPassword(account)} type="button">Change password</button></td>
      </tr>;
    })}
  </tbody></table></div> : <EmptyState>{empty}</EmptyState>;
}

function Metric({ label, value }) { return <div className="metric-card"><span>{label}</span><strong>{value}</strong></div>; }

function ReviewQueue({ activities, onOpen, empty }) {
  return activities.length ? <div className="preview-list">{activities.map((activity) => <div className="preview-row review-row" key={activity.id} onClick={() => onOpen(activity.id)} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') onOpen(activity.id); }}>
    <div>
      <strong>{sectorName(activity.sector)} &mdash; {activity.activity}</strong>
      <span>{activity.createdByName || 'Unknown'} &middot; {formatUsd(activity.requestedBudget)} requested &middot; {new Date(activity.createdAt).toLocaleDateString()}</span>
    </div>
    <span className={`status-badge ${statusTone(activity.status)}`}>{activity.status === 'Pending Review' ? 'Needs a decision' : 'Completion submitted'}</span>
  </div>)}</div> : <EmptyState>{empty}</EmptyState>;
}

// The manager's side of the same queue: what they were handed, what it is
// worth, and how its deadline stands. Work not yet accepted is called out,
// because accepting it is the one move only they can make.
function AssignmentQueue({ activities, onOpen, empty }) {
  return activities.length ? <div className="preview-list">{activities.map((activity) => {
    const due = deadlineNote(activity);
    return <div className="preview-row review-row" key={activity.id} onClick={() => onOpen(activity.id)} role="button" tabIndex={0}
      onKeyDown={(event) => { if (event.key === 'Enter') onOpen(activity.id); }}>
      <div>
        <strong>{sectorName(activity.sector)} &mdash; {activity.activity}</strong>
        <span>
          {formatUsd(activity.approvedBudget === null ? activity.requestedBudget : activity.approvedBudget)}
          {' '}&middot; {activity.deadline ? `due ${formatDate(activity.deadline)}` : 'no deadline'}
          {due && due.tone !== 'ok' ? ` · ${due.text}` : ''}
        </span>
      </div>
      <span className={`status-badge ${statusTone(activity.status)}`}>{activity.status === 'Assigned' ? 'Accept it' : activity.status}</span>
    </div>;
  })}</div> : <EmptyState>{empty}</EmptyState>;
}

function SectorBoard({ rows, onSelect }) {
  return <div className="table-wrap"><table className="sector-board"><thead><tr><th>Sector</th><th>Projects</th><th>Activities</th><th>In progress</th><th>Completed</th><th>Pending approvals</th><th>Budget</th><th>Spent</th><th>Remaining</th><th>Progress</th></tr></thead><tbody>
    {rows.map((row) => <tr key={row.id} onClick={() => onSelect(row.id)}>
      <td><strong>{row.name}</strong><small>{row.id}</small></td>
      <td>{row.projects}</td>
      <td>{row.activities}</td>
      <td>{row.activeActivities}</td>
      <td>{row.completedActivities}</td>
      <td>{row.approvalsPending ? <span className="priority-badge">{row.approvalsPending}</span> : <span className="muted-cell">None</span>}</td>
      <td>{formatRwf(row.budget)}</td>
      <td>{formatRwf(row.spent)}</td>
      <td className={row.remaining < 0 ? 'over-budget' : undefined}>{formatRwf(row.remaining)}</td>
      <td><div className="progress-meter"><span style={{ width: `${Math.max(0, Math.min(100, row.progress))}%` }} /></div><small>{row.progress}%</small></td>
    </tr>)}
  </tbody></table></div>;
}
function Panel({ title, subtitle, action, onAction, children }) { return <section className="panel"><div className="panel-header"><div><h2>{title}</h2>{subtitle && <span>{subtitle}</span>}</div>{action && <button className="text-btn" onClick={onAction} type="button">{action} &rarr;</button>}</div>{children}</section>; }
function EmptyState({ children }) { return <div className="empty-state"><strong>{children}</strong><span>There is no data to display yet.</span></div>; }
function ProjectPreview({ projects, empty }) { return projects.length ? <div className="preview-list">{projects.map((project) => <div className="preview-row" key={project.id}><div><strong>{project.name}</strong><span>{project.location} &middot; {project.category || 'To Be Decided'}</span></div><span className="status-badge">{project.status}</span></div>)}</div> : <EmptyState>{empty}</EmptyState>; }
function ApprovalPreview({ approvals, empty }) { return approvals.length ? <div className="preview-list">{approvals.map((approval) => <div className="preview-row" key={approval.id}><div><strong>{approval.title}</strong><span>{approval.owner} &middot; {formatRwf(approval.amount)}</span></div><span className="priority-badge">{approval.priority}</span></div>)}</div> : <EmptyState>{empty}</EmptyState>; }
function ProjectTable({ projects, managers, onSelect, onAssign, onDelete, empty }) { return projects.length ? <div className="table-wrap"><table><thead><tr><th>Project</th><th>Sector</th><th>Location</th><th>Organization owner</th><th>Manager</th><th>Status</th><th>Progress</th><th>Budget</th><th>Spent</th><th>Actions</th></tr></thead><tbody>{projects.map((project) => <tr key={project.id} onClick={() => onSelect(project.id)}><td><strong>{project.name}</strong><small>{project.id}</small></td><td>{sectorName(project.sector)}</td><td>{project.location}</td><td>{project.owner}</td><td><select value={project.managerId || ''} onClick={(event) => event.stopPropagation()} onChange={(event) => onAssign(project.id, event.target.value)}><option value="">Unassigned</option>{managers.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}</select></td><td><span className="status-badge">{project.status}</span></td><td>{project.progress}%</td><td>{formatRwf(project.budget)}</td><td>{formatRwf(project.spent)}</td><td><button className="danger-btn" onClick={(event) => { event.stopPropagation(); onDelete(project.id); }} type="button">Delete</button></td></tr>)}</tbody></table></div> : <EmptyState>{empty}</EmptyState>; }
// The register doubles as the Director's queue: what was asked for, what was
// approved, and whether anything is still waiting on a decision.
function ActivityTable({ activities, isDirector, openId, onOpen, onDelete, empty }) {
  return activities.length ? <div className="table-wrap"><table><thead><tr>
    <th>Activity</th><th>Category</th><th>Original budget</th><th>Approved</th><th>Adjustment</th><th>Status</th><th>Evidence</th><th>Raised by</th><th>Carried out by</th><th>Actions</th>
  </tr></thead><tbody>
    {activities.map((activity) => {
      const awaiting = activity.status === 'Pending Review' || (activity.completionSubmittedAt && activity.status !== 'Completed');
      const due = deadlineNote(activity);
      return <tr key={activity.id} className={activity.id === openId ? 'row-selected' : undefined}>
        <td><strong>{activity.activity}</strong><small>{activity.description || 'No description'}</small></td>
        <td>{activity.category}</td>
        <td>{formatUsd(activity.requestedBudget)}</td>
        <td>{activity.approvedBudget === null ? <span className="muted-cell">Not decided</span> : formatUsd(activity.approvedBudget)}</td>
        <td className={activity.budgetAdjustment ? 'over-budget' : undefined}>
          {activity.budgetAdjustment ? `${activity.budgetAdjustment > 0 ? '+' : ''}${formatUsd(activity.budgetAdjustment)}` : <span className="muted-cell">&mdash;</span>}
        </td>
        <td><span className={`status-badge ${statusTone(activity.status)}`}>{activity.status}</span>
          {awaiting && <small className="awaiting-flag">{activity.status === 'Pending Review' ? 'Needs a decision' : 'Completion submitted'}</small>}</td>
        <td>{activity.evidenceCount ? `${activity.evidenceCount} file${activity.evidenceCount === 1 ? '' : 's'}` : <span className="muted-cell">None</span>}</td>
        <td>{activity.createdByName || <span className="muted-cell">&mdash;</span>}</td>
        {/* Who the work sits with, and how its deadline stands. An overdue
            record is flagged here, not only inside the review screen. */}
        <td>{activity.assignedToName
          ? <><strong>{activity.assignedToName}</strong>{activity.deadline && <small className={due && due.tone !== 'ok' ? `deadline-flag deadline-${due.tone}` : undefined}>
            {formatDate(activity.deadline)}{due && due.tone !== 'ok' ? ` · ${due.text}` : ''}
          </small>}</>
          : <span className="muted-cell">Unassigned</span>}</td>
        <td>
          <button className="text-btn" onClick={() => onOpen(activity.id)} type="button">{isDirector ? 'Review' : 'Open'}</button>
          {isDirector && <button className="danger-btn" onClick={() => onDelete(activity.id)} type="button">Delete</button>}
        </td>
      </tr>;
    })}
  </tbody></table></div> : <EmptyState>{empty}</EmptyState>;
}
function ApprovalTable({ approvals, canDecide, onDecide, empty }) {
  return approvals.length ? <div className="table-wrap"><table><thead><tr><th>Request</th><th>Sector</th><th>Amount</th><th>Owner</th><th>Priority</th><th>Status</th><th>Requested by</th><th>Created</th><th>Decision</th></tr></thead><tbody>
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
            ? <div className="decision-actions"><button className="text-btn" onClick={() => onDecide(approval, 'Approved')} type="button">Approve</button><button className="danger-btn" onClick={() => onDecide(approval, 'Rejected')} type="button">Decline</button></div>
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
  // A manager heads an area, so they report to nobody and the field is hidden.
  const showsManager = form.role === 'staff';
  const managerOptions = managers.filter((manager) => manager.sector === form.sector);
  return <form className="form-panel" id="account-form" onSubmit={onSubmit}>
    <div className="panel-header"><div><h2>Add user</h2><span>The password is hashed before it is stored and can never be read back &mdash; only reset.</span></div></div>
    <div className="form-grid">
      <Field label="Name"><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
      <Field label="Username"><input required autoComplete="off" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} /></Field>
      <Field label="Password"><input required minLength="6" type="password" autoComplete="new-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></Field>
      <Field label="Role"><select required value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value, managerId: '' })}><option value="manager">Sector manager</option><option value="staff">Team member</option></select></Field>
      <Field label="Area of work"><select required value={form.sector || ''} onChange={(event) => setForm({ ...form, sector: event.target.value, managerId: '' })}><option value="">Select area</option>{sectors.map((sector) => <option key={sector.id} value={sector.id}>{sector.name}</option>)}</select></Field>
      {showsManager && <Field label="Reports to"><select value={form.managerId || ''} onChange={(event) => setForm({ ...form, managerId: event.target.value })} disabled={!form.sector}><option value="">No manager yet</option>{managerOptions.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}</select></Field>}
    </div>
    <button className="primary-btn" type="submit">{form.role === 'manager' ? 'Add manager' : 'Add team member'}</button>
  </form>;
}
function ProjectForm({ form, setForm, managers, onSubmit }) { return <form className="form-panel" id="project-form" onSubmit={onSubmit}><div className="panel-header"><div><h2>Add project</h2><span>For administrator use when a new project is defined.</span></div></div><div className="form-grid"><Field label="Name"><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field><Field label="Sector"><select value={form.sector} onChange={(event) => setForm({ ...form, sector: event.target.value })}>{sectors.map((sector) => <option key={sector.id} value={sector.id}>{sector.name}</option>)}</select></Field><Field label="Location"><input required value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} /></Field><Field label="Organization owner"><input required placeholder="Name of the organization" value={form.owner} onChange={(event) => setForm({ ...form, owner: event.target.value })} /></Field><Field label="Status"><select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option>On Track</option><option>In Review</option><option>Delayed</option><option>Healthy</option></select></Field><Field label="Progress"><input required type="number" min="0" max="100" value={form.progress} onChange={(event) => setForm({ ...form, progress: event.target.value })} /></Field><Field label="Category"><input required value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} /></Field><Field label="Manager"><select value={form.managerId} onChange={(event) => setForm({ ...form, managerId: event.target.value })}><option value="">Unassigned</option>{managers.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}</select></Field><Field label="Budget"><input required type="number" min="0" value={form.budget} onChange={(event) => setForm({ ...form, budget: event.target.value })} /></Field><Field label="Spent"><input required type="number" min="0" value={form.spent} onChange={(event) => setForm({ ...form, spent: event.target.value })} /></Field></div><button className="primary-btn" type="submit">Add project</button></form>; }
// One form for both ways in. A manager fills it to raise work and the budget it
// needs, which the Director then decides; the Director fills it to hand work
// out, and the three fields at the end -- who carries it out, by when, and on
// what terms -- are theirs alone.
function ActivityForm({ form, setForm, projects, selectedProject, sectorOptions, managers, isDirector, usd, onChooseProject, onSubmit }) {
  // A manager only ever reads their own working area, so only the managers who
  // cover the chosen area can be handed the work. The API refuses the rest.
  const managerOptions = managers.filter((manager) => manager.sector === form.sector);
  const incomplete = !form.projectId || !form.category.trim() || !form.activity.trim()
    || Number(form.quantity) <= 0 || form.costUsd === '' || (isDirector && !form.assignedTo);

  return <form className="form-panel" id="activity-form" onSubmit={onSubmit}>
    <div className="panel-header"><div>
      <h2>{isDirector ? 'Assign an activity' : 'Raise an activity'}</h2>
      <span>
        {selectedProject ? `Selected project: ${selectedProject.name}` : 'Select an existing project before entering activity details.'}
        {isDirector ? ' It goes straight to the manager, funded, for them to accept.' : ' It is submitted for the Director to review.'}
      </span>
    </div></div>
    <div className="form-grid activity-grid">
      <Field label="Project">
        <select required value={form.projectId} onChange={(event) => onChooseProject(event.target.value)}>
          <option value="">Select project</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </Field>
      <Field label="Working area">
        <select required value={form.sector} onChange={(event) => setForm({ ...form, sector: event.target.value, categoryChoice: '', category: '', assignedTo: '' })}>
          {sectorOptions.map((sector) => <option key={sector.id} value={sector.id}>{sector.name}</option>)}
        </select>
      </Field>
      <Field label="Category">
        <select required value={form.categoryChoice} onChange={(event) => { const choice = event.target.value; setForm({ ...form, categoryChoice: choice, category: choice === OTHER_CATEGORY ? '' : choice }); }}>
          <option value="">Select category</option>
          {categoriesForSector(form.sector).map((category) => <option key={category} value={category}>{category}</option>)}
          <option value={OTHER_CATEGORY}>{OTHER_CATEGORY}</option>
        </select>
      </Field>
      {form.categoryChoice === OTHER_CATEGORY && <Field label="Specify category">
        <input required placeholder="Category of work or item" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} />
      </Field>}
      <Field label="Activity">
        <input required placeholder="e.g. Purchase farming materials" value={form.activity} onChange={(event) => setForm({ ...form, activity: event.target.value })} />
      </Field>
      <Field label="Description">
        <input placeholder={isDirector ? 'What the work involves' : 'Why the work is needed'} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
      </Field>
      <Field label={isDirector ? 'Materials / items to buy' : 'Materials / items requested'}>
        <textarea rows="3" placeholder={'One per line, e.g.\nHoes\nMachetes'} value={form.materials} onChange={(event) => setForm({ ...form, materials: event.target.value })} />
      </Field>
      <Field label="Quantity">
        <input required type="number" min="0.01" step="0.01" placeholder="Quantity" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} />
      </Field>
      <Field label={isDirector ? 'Budget (USD)' : 'Requested budget (USD)'}>
        <input required type="number" min="0" step="0.01" placeholder={isDirector ? 'Amount released for this work' : 'Enter the amount needed'} value={form.costUsd} onChange={(event) => setForm({ ...form, costUsd: event.target.value })} />
      </Field>
      <Field label="Equivalent in RWF (automatic)"><input readOnly value={usd ? usd * exchangeRates.rwfPerUsd : ''} placeholder="Calculated from USD" /></Field>
      <Field label="Equivalent in CDF / Congo (automatic)"><input readOnly value={usd ? usd * exchangeRates.cdfPerUsd : ''} placeholder="Calculated from USD" /></Field>
      {isDirector && <>
        <Field label="Carried out by">
          <select required value={form.assignedTo} onChange={(event) => setForm({ ...form, assignedTo: event.target.value })} disabled={!managerOptions.length}>
            <option value="">Select a manager</option>
            {managerOptions.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}
          </select>
        </Field>
        <Field label="Deadline">
          <input type="date" value={form.deadline} onChange={(event) => setForm({ ...form, deadline: event.target.value })} />
        </Field>
        <Field label="Instructions for the manager" wide>
          <textarea rows="3" placeholder="e.g. Buy the hoes from the Kigali supplier and keep every receipt." value={form.instructions} onChange={(event) => setForm({ ...form, instructions: event.target.value })} />
        </Field>
      </>}
      <label className="check-field"><input type="checkbox" checked={form.signed} onChange={(event) => setForm({ ...form, signed: event.target.checked })} />Signed</label>
    </div>
    {isDirector && !managerOptions.length && <p className="decision-hint">
      No manager covers {sectorName(form.sector)} yet. Add one under User management before assigning work in this area.
    </p>}
    <button className="primary-btn" disabled={incomplete} type="submit">{isDirector ? 'Assign activity' : 'Submit for review'}</button>
  </form>;
}
function ApprovalForm({ form, setForm, sectorOptions, onSubmit }) { return <form className="form-panel" onSubmit={onSubmit}><div className="panel-header"><div><h2>Raise a request</h2><span>Describe what is needed. The Director reviews it and approves or declines.</span></div></div><div className="form-grid"><Field label="What is needed"><input required placeholder="e.g. Build a perimeter fence" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></Field><Field label="Sector"><select value={form.sector} onChange={(event) => setForm({ ...form, sector: event.target.value })}>{sectorOptions.map((sector) => <option key={sector.id} value={sector.id}>{sector.name}</option>)}</select></Field><Field label="Estimated amount"><input required type="number" min="0" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></Field><Field label="Organization owner"><input required placeholder="Name of the organization" value={form.owner} onChange={(event) => setForm({ ...form, owner: event.target.value })} /></Field><Field label="Priority"><select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })}><option>Low</option><option>Medium</option><option>High</option></select></Field><Field label="Requested by"><input readOnly value={form.requestedBy} /></Field><Field label="Reason for the request"><textarea required rows="3" placeholder="Why is this needed? e.g. The site perimeter is open and livestock are straying onto the plots." value={form.justification} onChange={(event) => setForm({ ...form, justification: event.target.value })} /></Field></div><button className="primary-btn" type="submit">Send for approval</button></form>; }
// The Reports section: pick a period, read the figures, take them away.
//
// Every number below is computed on the server from the activity register, and
// the PDF and Excel exports run the very same scoped query, so what a manager
// downloads is exactly what a manager can see.
function ReportsSection({ mode, range, report, busy, sectorLabel, onModeChange, onRangeChange, onGenerate, onExport, onPrint, onClose }) {
  const ready = mode !== 'custom' || (range.start && range.end && range.start <= range.end);

  return <section className="report-area report-print-area">
    <div className="panel-header">
      <div>
        <h2>Reports</h2>
        <span>Review project activities, budgets, spending and performance by period.</span>
      </div>
      <div className="report-actions report-controls">
        {REPORT_MODES.map(([id, label]) => <button
          key={id}
          className={mode === id ? 'primary-btn' : 'secondary-btn'}
          onClick={() => onModeChange(id)}
          type="button"
        >{label}</button>)}
      </div>
    </div>

    <div className="report-picker report-controls">
      {mode === 'weekly' && <Field label="Any day in the week">
        <input type="date" value={range.week} onChange={(event) => onRangeChange({ week: event.target.value })} />
      </Field>}
      {mode === 'monthly' && <Field label="Month">
        <input type="month" value={range.month} onChange={(event) => onRangeChange({ month: event.target.value })} />
      </Field>}
      {mode === 'custom' && <>
        <Field label="Start date">
          <input type="date" value={range.start} onChange={(event) => onRangeChange({ start: event.target.value })} />
        </Field>
        <Field label="End date">
          <input type="date" value={range.end} onChange={(event) => onRangeChange({ end: event.target.value })} />
        </Field>
      </>}
      <button className="primary-btn" type="button" disabled={busy || !ready} onClick={onGenerate}>
        {busy ? 'Working...' : 'Generate report'}
      </button>
      {mode === 'custom' && !ready && <span className="report-hint">Choose a start date on or before the end date.</span>}
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
  const counts = report.activitySummary;
  const budget = report.budgetSummary;

  return <div className="report-result-body">
    <div className="report-meta">
      <div>
        <strong>{report.period.label}</strong>
        <span>
          {report.period.start} to {report.period.end} &middot; {report.scope.sectorName}
          {' '}&middot; generated {new Date(report.generatedAt).toLocaleString()}
        </span>
        <span className="muted-cell">{report.basis}</span>
      </div>
      <div className="report-actions report-controls">
        <button className="secondary-btn" type="button" disabled={busy} onClick={() => onExport('pdf')}>Export PDF</button>
        <button className="secondary-btn" type="button" disabled={busy} onClick={() => onExport('xlsx')}>Export Excel</button>
        <button className="secondary-btn" type="button" onClick={onPrint}>Print</button>
        <button className="text-btn" type="button" onClick={onClose}>Close</button>
      </div>
    </div>

    {counts.total === 0
      ? <div className="empty-state">
        <strong>No activities fall in this period.</strong>
        <span>Nothing was assigned or raised between {report.period.start} and {report.period.end}.</span>
      </div>
      : <>
        <h3 className="form-section-title">Activity summary</h3>
        {/* Overdue cuts across the other counts rather than being one of them,
            so these six are not meant to add up to the total. */}
        <div className="metric-grid metric-grid-6">
          <Metric label="Total activities" value={counts.total} />
          <Metric label="Completed" value={counts.completed} />
          <Metric label="In progress" value={counts.inProgress} />
          <Metric label="Pending" value={counts.pending} />
          <Metric label="Overdue" value={counts.overdue} />
          <Metric label="Cancelled" value={counts.cancelled} />
        </div>

        <h3 className="form-section-title">Budget summary</h3>
        <div className="budget-strip budget-strip-4">
          <div className="budget-block">
            <span>Total assigned budget</span>
            <strong>{formatUsd(budget.assigned)}</strong>
            <small>What was originally set or asked for</small>
          </div>
          <div className={`budget-block${budget.revised !== budget.assigned ? ' budget-adjusted' : ''}`}>
            <span>Total revised budget</span>
            <strong>{formatUsd(budget.revised)}</strong>
            <small>{budget.revised === budget.assigned ? 'Unchanged on review' : `${budget.revised > budget.assigned ? '+' : ''}${formatUsd(budget.revised - budget.assigned)} against the original`}</small>
          </div>
          <div className="budget-block">
            <span>Total actual spending</span>
            <strong>{formatUsd(budget.spent)}</strong>
            <small>{budget.utilisation}% of the revised budget, from filed evidence</small>
          </div>
          <div className={`budget-block${budget.remaining < 0 ? ' budget-adjusted' : ''}`}>
            <span>Remaining budget</span>
            <strong>{formatUsd(budget.remaining)}</strong>
            <small>{budget.remaining < 0 ? 'Spending has passed the released budget' : 'Released but not yet spent'}</small>
          </div>
        </div>

        <h3 className="form-section-title">Manager performance</h3>
        <div className="table-wrap"><table>
          <thead><tr>
            <th>Manager</th><th>Activities assigned</th><th>Completed</th><th>In progress</th>
            <th>Overdue</th><th>Total budget handled</th><th>Spent</th>
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

        <h3 className="form-section-title">Activity details</h3>
        <div className="table-wrap"><table className="report-detail-table">
          <thead><tr>
            <th>Activity</th><th>Project / area</th><th>Assigned manager</th>
            <th>Original budget</th><th>Revised budget</th><th>Actual spending</th>
            <th>Status</th><th>Date assigned</th><th>Completion date</th><th>Admin notes</th>
          </tr></thead>
          <tbody>{report.activities.map((item) => <tr key={item.id}>
            <td><strong>{item.activity}</strong><small>{item.category}</small></td>
            <td>{item.projectName}<small className="muted-cell">{sectorLabel(item.sector)}</small></td>
            <td>{item.assignedToName || <span className="muted-cell">Not yet assigned</span>}</td>
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
