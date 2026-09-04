import { useEffect, useMemo, useState } from 'react';

const sectors = [
  { id: 'farming', name: 'Farming Activity' },
  { id: 'mining', name: 'Mining Activity' },
  { id: 'agriculture', name: 'Agriculture Activity' },
  { id: 'movement', name: 'Movement & Facilitation' }
];

const emptyProject = { name: '', sector: 'agriculture', location: '', owner: '', status: 'On Track', progress: '', budget: '', spent: '', category: '', managerId: '' };
const emptyActivity = { projectId: '', sector: 'agriculture', category: '', activity: '', description: '', quantity: '', costUsd: '', signed: false, approved: false, status: 'Pending' };
const emptyApproval = { title: '', sector: 'agriculture', amount: '', owner: '', priority: 'Medium', status: 'Pending', requestedBy: '' };
const emptyMovement = { sector: 'movement', purpose: '', destination: '', cost: '', category: '' };
const emptyManager = { username: '', name: '', password: '' };
const exchangeRates = { rwfPerUsd: 1450, cdfPerUsd: 2850 };

function formatNumber(value) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(value || 0));
}

function formatRwf(value) {
  return `RWF ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value || 0))}`;
}

function App() {
  const [token, setToken] = useState(localStorage.getItem('ops-token') || '');
  const [user, setUser] = useState(() => JSON.parse(localStorage.getItem('ops-user') || 'null'));
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [activeView, setActiveView] = useState('dashboard');
  const [summary, setSummary] = useState({ summary: {}, sectors });
  const [projects, setProjects] = useState([]);
  const [activities, setActivities] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [movements, setMovements] = useState([]);
  const [managers, setManagers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [sectorFilter, setSectorFilter] = useState('All');
  const [projectSearch, setProjectSearch] = useState('');
  const [projectForm, setProjectForm] = useState(emptyProject);
  const [activityForm, setActivityForm] = useState(emptyActivity);
  const [approvalForm, setApprovalForm] = useState(emptyApproval);
  const [movementForm, setMovementForm] = useState(emptyMovement);
  const [managerForm, setManagerForm] = useState(emptyManager);
  const [report, setReport] = useState(null);

  const fetchJson = async (url, options = {}) => {
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
  };

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      const results = await Promise.allSettled([
        fetchJson('/api/summary'), fetchJson('/api/projects'), fetchJson('/api/activities'),
        fetchJson('/api/approvals'), fetchJson('/api/movements'), fetchJson('/api/managers')
      ]);
      const [summaryResult, projectResult, activityResult, approvalResult, movementResult, managerResult] = results;
      const criticalResults = [summaryResult, projectResult, activityResult, approvalResult, movementResult];
      const criticalFailure = criticalResults.find((result) => result.status === 'rejected');
      if (criticalFailure) throw criticalFailure.reason;

      setSummary(summaryResult.value);
      setProjects(projectResult.value);
      setActivities(activityResult.value);
      setApprovals(approvalResult.value);
      setMovements(movementResult.value);
      setManagers(managerResult.status === 'fulfilled' ? managerResult.value : []);
      if (managerResult.status === 'rejected') {
        setMessage('Manager list is unavailable; other records loaded successfully.');
      }
      if (!selectedProjectId && projectResult.value[0]) {
        setSelectedProjectId(projectResult.value[0].id);
        setActivityForm((current) => ({ ...current, projectId: projectResult.value[0].id, sector: projectResult.value[0].sector }));
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

  const chooseProject = (projectId) => {
    const project = projects.find((item) => item.id === projectId);
    setSelectedProjectId(projectId);
    setActivityForm((current) => ({ ...current, projectId, sector: project?.sector || current.sector }));
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

  const completeActivity = async (activityId, status) => {
    try {
      await fetchJson(`/api/activities/${activityId}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
      setMessage(status === 'Completed' ? 'Activity completed.' : 'Activity reopened.');
      await loadData();
    } catch (actionError) { setError(actionError.message); }
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

  const requestReport = async (period) => {
    try { setReport(await fetchJson(`/api/reports/activities?period=${period}`)); }
    catch (reportError) { setError(reportError.message); }
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

  const selectedActivities = useMemo(() => activities.filter((activity) => (!selectedProjectId || activity.projectId === selectedProjectId) && (sectorFilter === 'All' || activity.sector === sectorFilter)), [activities, selectedProjectId, sectorFilter]);
  const pendingApprovals = approvals.filter((approval) => approval.status === 'Pending');
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const usd = Number(activityForm.costUsd || 0);

  if (!token || !user) {
    return <div className="login-shell"><form className="login-card" onSubmit={login}>
      <div className="brand-mark">OPS CONTROL</div><span className="eyebrow">PROJECT OPERATIONS</span><h1>Sign in</h1>
      <p>Access your operational records and approvals.</p>
      <label>Username<input required value={loginForm.username} onChange={(event) => setLoginForm({ ...loginForm, username: event.target.value })} /></label>
      <label>Password<input required type="password" value={loginForm.password} onChange={(event) => setLoginForm({ ...loginForm, password: event.target.value })} /></label>
      <button className="primary-btn full-width" type="submit">Sign in</button>
      {error && <div className="error-state">{error}</div>}
    </form></div>;
  }

  const navItems = [
    ['dashboard', 'Dashboard'], ['projects', 'Projects'], ['activities', 'Activities'], ['approvals', 'Approvals'], ['movements', 'Movements']
  ];

  return <div className="application-shell">
    <aside className="sidebar">
      <div className="brand-lockup"><div className="brand-mark">OPS</div><div><strong>Operations</strong><span>Management System</span></div></div>
      <div className="sidebar-label">Workspace</div>
      <nav>{navItems.map(([id, label]) => <button key={id} className={activeView === id ? 'nav-item active' : 'nav-item'} onClick={() => setActiveView(id)} type="button"><span className={`nav-icon nav-${id}`} />{label}</button>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-label">Signed in as</div><strong>{user.name}</strong><span>{user.role}</span>{user.sector && <span>Sector: {user.sector}</span>}<button className="logout-btn" onClick={logout} type="button">Sign out</button></div>
    </aside>

    <div className="main-area">
      <header className="top-header"><div><span className="eyebrow">OPERATIONS CONTROL</span><h1>{navItems.find(([id]) => id === activeView)?.[1]}</h1></div><div className="header-meta"><span className="connection-dot" />Database connected</div></header>
      {message && <div className="success-banner">{message}<button type="button" onClick={() => setMessage('')}>Dismiss</button></div>}
      {error && <div className="error-banner">{error}<button type="button" onClick={() => setError('')}>Dismiss</button></div>}
      {loading ? <div className="loading-state"><span className="spinner" />Loading records from database...</div> : <>

        {activeView === 'dashboard' && <>
          <section className="welcome-strip"><div><span className="eyebrow">SYSTEM OVERVIEW</span><h2>Operational visibility in one place.</h2><p>Review the records currently available in the system.</p></div><button className="primary-btn" type="button" onClick={() => setActiveView('activities')}>Assign activity</button></section>
          <div className="metric-grid"><Metric label="Projects" value={summary.summary?.totalProjects || 0} /><Metric label="Activities in progress" value={summary.summary?.activeOperations || 0} /><Metric label="Pending approvals" value={summary.summary?.approvalsPending || 0} /><Metric label="Completion rate" value={`${summary.summary?.completionRate || 0}%`} /></div>
          <div className="dashboard-columns"><Panel title="Projects" action="View all" onAction={() => setActiveView('projects')}><ProjectPreview projects={projects.slice(0, 5)} empty="No projects have been added." /></Panel><Panel title="Pending approvals" action="Review" onAction={() => setActiveView('approvals')}><ApprovalPreview approvals={pendingApprovals.slice(0, 5)} empty="No pending approvals." /></Panel></div>
        </>}

        {activeView === 'projects' && <><section className="toolbar-row"><div className="filter-group"><select value={sectorFilter} onChange={(event) => setSectorFilter(event.target.value)}><option value="All">All sectors</option>{(summary.sectors || sectors).map((sector) => <option key={sector.id} value={sector.id}>{sector.name}</option>)}</select><input placeholder="Search projects" value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} /></div>{user.role === 'super-admin' && <button className="primary-btn" type="button" onClick={() => document.getElementById('project-form')?.scrollIntoView({ behavior: 'smooth' })}>Add project</button>}</section><Panel title="Project register" subtitle={`${filteredProjects.length} record${filteredProjects.length === 1 ? '' : 's'}`}><ProjectTable projects={filteredProjects} managers={managers} onSelect={chooseProject} onAssign={assignManager} onDelete={(id) => deleteRecord(`/api/projects/${id}`, 'project')} empty="No projects match the current filters." /></Panel>{user.role === 'super-admin' && <ManagerForm form={managerForm} setForm={setManagerForm} onSubmit={(event) => submit(event, '/api/managers', managerForm, 'Manager added.', () => setManagerForm(emptyManager))} />} {user.role === 'super-admin' && <ProjectForm form={projectForm} setForm={setProjectForm} managers={managers} onSubmit={(event) => submit(event, '/api/projects', projectForm, 'Project added.', () => setProjectForm(emptyProject))} />}</>}

        {activeView === 'activities' && <><section className="context-strip"><div><span className="eyebrow">PROJECT ACTIVITY REGISTER</span><h2>Assign activity to a project</h2><p>Record the work, quantities, costs, and approval state against an existing project.</p></div><select value={selectedProjectId} onChange={(event) => chooseProject(event.target.value)}><option value="">Select project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></section><ActivityForm form={activityForm} setForm={setActivityForm} projects={projects} selectedProject={selectedProject} usd={usd} onSubmit={(event) => submit(event, '/api/activities', { ...activityForm, projectId: selectedProjectId || activityForm.projectId, costRwf: usd * exchangeRates.rwfPerUsd, costCdf: usd * exchangeRates.cdfPerUsd }, 'Activity assigned.', (result) => { setActivityForm({ ...emptyActivity, projectId: result.projectId, sector: result.sector }); })} /><Panel title="Latest 5 activities" subtitle="Older records remain available in reports."><ActivityTable activities={selectedActivities} onComplete={completeActivity} onDelete={(id) => deleteRecord(`/api/activities/${id}`, 'activity')} empty={selectedProjectId ? 'No activities assigned to this project.' : 'Select a project to view its activities.'} /></Panel><ReportControls report={report} onRequest={requestReport} onClose={() => setReport(null)} /></>}

        {activeView === 'approvals' && <><section className="toolbar-row"><div className="filter-group"><select value={sectorFilter} onChange={(event) => setSectorFilter(event.target.value)}><option value="All">All sectors</option>{(summary.sectors || sectors).map((sector) => <option key={sector.id} value={sector.id}>{sector.name}</option>)}</select></div></section><Panel title="Approval register" subtitle={`${approvals.length} record${approvals.length === 1 ? '' : 's'}`}><ApprovalTable approvals={approvals.filter((approval) => sectorFilter === 'All' || approval.sector === sectorFilter)} onApprove={async (id) => { await fetchJson(`/api/approvals/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'Approved' }) }); await loadData(); setMessage('Approval updated.'); }} empty="No approval records available." /></Panel><ApprovalForm form={approvalForm} setForm={setApprovalForm} onSubmit={(event) => submit(event, '/api/approvals', approvalForm, 'Approval submitted.', () => setApprovalForm(emptyApproval))} /></>}

        {activeView === 'movements' && <><Panel title="Movement register" subtitle={`${movements.length} record${movements.length === 1 ? '' : 's'}`}><MovementTable movements={movements} empty="No movement records available." /></Panel><MovementForm form={movementForm} setForm={setMovementForm} onSubmit={(event) => submit(event, '/api/movements', movementForm, 'Movement submitted.', () => setMovementForm(emptyMovement), (createdMovement) => setMovements((current) => [createdMovement, ...current]))} /></>}
      </>}</div>
  </div>;
}

function Metric({ label, value }) { return <div className="metric-card"><span>{label}</span><strong>{value}</strong></div>; }
function Panel({ title, subtitle, action, onAction, children }) { return <section className="panel"><div className="panel-header"><div><h2>{title}</h2>{subtitle && <span>{subtitle}</span>}</div>{action && <button className="text-btn" onClick={onAction} type="button">{action} &rarr;</button>}</div>{children}</section>; }
function EmptyState({ children }) { return <div className="empty-state"><strong>{children}</strong><span>There is no data to display yet.</span></div>; }
function ProjectPreview({ projects, empty }) { return projects.length ? <div className="preview-list">{projects.map((project) => <div className="preview-row" key={project.id}><div><strong>{project.name}</strong><span>{project.location} &middot; {project.category || 'To Be Decided'}</span></div><span className="status-badge">{project.status}</span></div>)}</div> : <EmptyState>{empty}</EmptyState>; }
function ApprovalPreview({ approvals, empty }) { return approvals.length ? <div className="preview-list">{approvals.map((approval) => <div className="preview-row" key={approval.id}><div><strong>{approval.title}</strong><span>{approval.owner} &middot; {formatRwf(approval.amount)}</span></div><span className="priority-badge">{approval.priority}</span></div>)}</div> : <EmptyState>{empty}</EmptyState>; }
function ProjectTable({ projects, managers, onSelect, onAssign, onDelete, empty }) { return projects.length ? <div className="table-wrap"><table><thead><tr><th>Project</th><th>Sector</th><th>Location</th><th>Organization owner</th><th>Manager</th><th>Status</th><th>Progress</th><th>Budget</th><th>Spent</th><th>Actions</th></tr></thead><tbody>{projects.map((project) => <tr key={project.id} onClick={() => onSelect(project.id)}><td><strong>{project.name}</strong><small>{project.id}</small></td><td>{project.sector}</td><td>{project.location}</td><td>{project.owner}</td><td><select value={project.managerId || ''} onClick={(event) => event.stopPropagation()} onChange={(event) => onAssign(project.id, event.target.value)}><option value="">Unassigned</option>{managers.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}</select></td><td><span className="status-badge">{project.status}</span></td><td>{project.progress}%</td><td>{formatRwf(project.budget)}</td><td>{formatRwf(project.spent)}</td><td><button className="danger-btn" onClick={(event) => { event.stopPropagation(); onDelete(project.id); }} type="button">Delete</button></td></tr>)}</tbody></table></div> : <EmptyState>{empty}</EmptyState>; }
function ActivityTable({ activities, onComplete, onDelete, empty }) { return activities.length ? <div className="table-wrap"><table><thead><tr><th>Category</th><th>Activity</th><th>Description</th><th>Quantity</th><th>USD</th><th>RWF</th><th>CDF</th><th>Status</th><th>Actions</th></tr></thead><tbody>{activities.map((activity) => <tr key={activity.id}><td>{activity.category}</td><td><strong>{activity.activity}</strong></td><td>{activity.description || 'To Be Decided'}</td><td>{activity.quantity}</td><td>{formatNumber(activity.costUsd)}</td><td>{formatNumber(activity.costRwf)}</td><td>{formatNumber(activity.costCdf)}</td><td><span className="status-badge">{activity.status}</span></td><td>{activity.status === 'Completed' ? <button className="text-btn" onClick={() => onComplete(activity.id, 'In Progress')} type="button">Reopen</button> : <button className="text-btn" onClick={() => onComplete(activity.id, 'Completed')} type="button">Complete</button>}<button className="danger-btn" onClick={() => onDelete(activity.id)} type="button">Delete</button></td></tr>)}</tbody></table></div> : <EmptyState>{empty}</EmptyState>; }
function ApprovalTable({ approvals, onApprove, empty }) { return approvals.length ? <div className="table-wrap"><table><thead><tr><th>Title</th><th>Sector</th><th>Amount</th><th>Owner</th><th>Priority</th><th>Status</th><th>Requested by</th><th>Created</th><th>Action</th></tr></thead><tbody>{approvals.map((approval) => <tr key={approval.id}><td><strong>{approval.title}</strong><small>{approval.id}</small></td><td>{approval.sector}</td><td>{formatRwf(approval.amount)}</td><td>{approval.owner}</td><td><span className="priority-badge">{approval.priority}</span></td><td><span className="status-badge">{approval.status}</span></td><td>{approval.requestedBy}</td><td>{new Date(approval.createdAt).toLocaleDateString()}</td><td>{approval.status === 'Pending' && <button className="text-btn" onClick={() => onApprove(approval.id)} type="button">Approve</button>}</td></tr>)}</tbody></table></div> : <EmptyState>{empty}</EmptyState>; }
function MovementTable({ movements, empty }) { return movements.length ? <div className="table-wrap"><table><thead><tr><th>Reference</th><th>Sector</th><th>Purpose</th><th>Destination</th><th>Status</th><th>Cost</th><th>Category</th></tr></thead><tbody>{movements.map((movement) => <tr key={movement.id}><td><strong>{movement.ref}</strong></td><td>{movement.sector}</td><td>{movement.purpose}</td><td>{movement.destination}</td><td><span className="status-badge">{movement.status}</span></td><td>{formatRwf(movement.cost)}</td><td>{movement.category}</td></tr>)}</tbody></table></div> : <EmptyState>{empty}</EmptyState>; }
function Field({ label, children }) { return <label className="form-field"><span>{label}</span>{children}</label>; }
function ManagerForm({ form, setForm, onSubmit }) { return <form className="form-panel" onSubmit={onSubmit}><div className="panel-header"><div><h2>Add sector manager</h2><span>Maximum three managers can be assigned to each sector.</span></div></div><div className="form-grid"><Field label="Name"><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field><Field label="Username"><input required value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} /></Field><Field label="Password"><input required minLength="6" type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></Field><Field label="Assigned sector"><select required value={form.sector || ''} onChange={(event) => setForm({ ...form, sector: event.target.value })}><option value="">Select sector</option>{sectors.map((sector) => <option key={sector.id} value={sector.id}>{sector.name}</option>)}</select></Field></div><button className="primary-btn" type="submit">Add manager</button></form>; }
function ProjectForm({ form, setForm, managers, onSubmit }) { return <form className="form-panel" id="project-form" onSubmit={onSubmit}><div className="panel-header"><div><h2>Add project</h2><span>For administrator use when a new project is defined.</span></div></div><div className="form-grid"><Field label="Name"><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field><Field label="Sector"><select value={form.sector} onChange={(event) => setForm({ ...form, sector: event.target.value })}>{sectors.map((sector) => <option key={sector.id} value={sector.id}>{sector.name}</option>)}</select></Field><Field label="Location"><input required value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} /></Field><Field label="Organization owner"><input required placeholder="Name of the organization" value={form.owner} onChange={(event) => setForm({ ...form, owner: event.target.value })} /></Field><Field label="Status"><select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option>On Track</option><option>In Review</option><option>Delayed</option><option>Healthy</option></select></Field><Field label="Progress"><input required type="number" min="0" max="100" value={form.progress} onChange={(event) => setForm({ ...form, progress: event.target.value })} /></Field><Field label="Category"><input required value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} /></Field><Field label="Manager"><select value={form.managerId} onChange={(event) => setForm({ ...form, managerId: event.target.value })}><option value="">Unassigned</option>{managers.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}</select></Field><Field label="Budget"><input required type="number" min="0" value={form.budget} onChange={(event) => setForm({ ...form, budget: event.target.value })} /></Field><Field label="Spent"><input required type="number" min="0" value={form.spent} onChange={(event) => setForm({ ...form, spent: event.target.value })} /></Field></div><button className="primary-btn" type="submit">Add project</button></form>; }
function ActivityForm({ form, setForm, projects, selectedProject, usd, onSubmit }) { return <form className="form-panel" onSubmit={onSubmit}><div className="panel-header"><div><h2>Assign activity</h2><span>{selectedProject ? `Selected project: ${selectedProject.name}` : 'Select an existing project before entering activity details.'}</span></div></div><div className="form-grid activity-grid"><Field label="Project"><select required value={form.projectId} onChange={(event) => { const project = projects.find((item) => item.id === event.target.value); setForm({ ...form, projectId: event.target.value, sector: project?.sector || form.sector }); }}><option value="">Select project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field><Field label="Sector"><select value={form.sector} readOnly>{sectors.map((sector) => <option key={sector.id} value={sector.id}>{sector.name}</option>)}</select></Field><Field label="Category"><input required placeholder="Category of work or item" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} /></Field><Field label="Activity"><input required placeholder="Activity name" value={form.activity} onChange={(event) => setForm({ ...form, activity: event.target.value })} /></Field><Field label="Description"><input placeholder="Details of work or item" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field><Field label="Quantity"><input required type="number" min="0.01" step="0.01" placeholder="Quantity" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} /></Field><Field label="Cost in USD"><input required type="number" min="0" step="0.01" placeholder="Enter USD amount" value={form.costUsd} onChange={(event) => setForm({ ...form, costUsd: event.target.value })} /></Field><Field label="Cost in RWF (automatic)"><input readOnly value={usd ? usd * exchangeRates.rwfPerUsd : ''} placeholder="Calculated from USD" /></Field><Field label="Cost in CDF / Congo (automatic)"><input readOnly value={usd ? usd * exchangeRates.cdfPerUsd : ''} placeholder="Calculated from USD" /></Field><Field label="Status"><select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option>Pending</option><option>In Progress</option><option>Completed</option><option>Cancelled</option></select></Field><label className="check-field"><input type="checkbox" checked={form.signed} onChange={(event) => setForm({ ...form, signed: event.target.checked })} />Signed</label><label className="check-field"><input type="checkbox" checked={form.approved} onChange={(event) => setForm({ ...form, approved: event.target.checked })} />Approved</label></div><button className="primary-btn" disabled={!form.projectId || !form.category.trim() || !form.activity.trim() || Number(form.quantity) <= 0 || form.costUsd === ''} type="submit">Assign activity</button></form>; }
function ApprovalForm({ form, setForm, onSubmit }) { return <form className="form-panel" onSubmit={onSubmit}><div className="panel-header"><div><h2>Submit approval</h2><span>Use the approval fields defined by the system.</span></div></div><div className="form-grid"><Field label="Title"><input required value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></Field><Field label="Sector"><select value={form.sector} onChange={(event) => setForm({ ...form, sector: event.target.value })}>{sectors.map((sector) => <option key={sector.id} value={sector.id}>{sector.name}</option>)}</select></Field><Field label="Amount"><input required type="number" min="0" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></Field><Field label="Organization owner"><input required placeholder="Name of the organization" value={form.owner} onChange={(event) => setForm({ ...form, owner: event.target.value })} /></Field><Field label="Priority"><select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })}><option>Low</option><option>Medium</option><option>High</option></select></Field><Field label="Requested by"><input required value={form.requestedBy} onChange={(event) => setForm({ ...form, requestedBy: event.target.value })} /></Field></div><button className="primary-btn" type="submit">Submit approval</button></form>; }
function MovementForm({ form, setForm, onSubmit }) { return <form className="form-panel" onSubmit={onSubmit}><div className="panel-header"><div><h2>Add movement</h2><span>Record the movement fields currently defined by the system.</span></div></div><div className="form-grid"><Field label="Reference"><span className="read-only-value">Generated by the system</span></Field><Field label="Sector"><select value={form.sector} onChange={(event) => setForm({ ...form, sector: event.target.value })}>{sectors.map((sector) => <option key={sector.id} value={sector.id}>{sector.name}</option>)}</select></Field><Field label="Purpose"><input required value={form.purpose} onChange={(event) => setForm({ ...form, purpose: event.target.value })} /></Field><Field label="Destination"><input required value={form.destination} onChange={(event) => setForm({ ...form, destination: event.target.value })} /></Field><Field label="Cost"><input required type="number" min="0" value={form.cost} onChange={(event) => setForm({ ...form, cost: event.target.value })} /></Field><Field label="Category"><input required value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} /></Field></div><button className="primary-btn" type="submit">Add movement</button></form>; }
function ReportControls({ report, onRequest, onClose }) { return <section className="report-area"><div className="panel-header"><div><h2>Reports</h2><span>Request older activity records by period.</span></div><div className="report-actions"><button className="secondary-btn" onClick={() => onRequest('weekly')} type="button">Weekly report</button><button className="secondary-btn" onClick={() => onRequest('monthly')} type="button">Monthly report</button></div></div>{report && <div className="report-result"><div><strong>{report.period} activity report</strong><span>{report.totalActivities} activities &middot; {report.completedActivities} completed &middot; {report.approvedActivities} approved</span></div><button className="text-btn" onClick={onClose} type="button">Close</button></div>}</section>; }

export default App;
