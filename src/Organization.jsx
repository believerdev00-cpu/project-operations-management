import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BUSINESS_OPERATIONS, operationName, operationsOf, worksIn } from '../shared/businessOperations.js';
import { fill, useI18n } from './i18n.js';
import { useBusy, useDialog } from './ui.jsx';
import { EscalationList } from './Escalations.jsx';

// The organisation: who reports to whom, the teams under each project manager,
// and -- for senior management -- the external partners as a branch of their
// own.
//
// Everything on this page comes from GET /api/organization, which already cut
// it down to what the reader may see: the Director and the General Manager get
// the whole chart, a project manager their own teams and the line above them,
// a team member their own team and the line above them. Each button is drawn
// from the `can` flags and per-team `canManage` the API worked out with the
// same rules its routes enforce, so a button the browser draws is never the
// thing that decides.
//
// The chart reads top to bottom and never sideways: on a phone every level is
// a full-width stack, so nothing scrolls horizontally however many managers,
// teams or partners there are.

// The General Manager (if any) at the top of a manager's line, walking up
// through senior managers. A manager whose line reaches no General Manager
// reports straight to the Director.
function generalManagerOf(person, byId) {
  const seen = new Set();
  let cursor = byId.get(person.reportsToId);
  while (cursor && !seen.has(cursor.id)) {
    if (cursor.role === 'general-manager') return cursor.id;
    seen.add(cursor.id);
    cursor = byId.get(cursor.reportsToId);
  }
  return null;
}

export default function OrganizationPage({ user, fetchJson, onMessage, onError, onChanged }) {
  const { language, t } = useI18n();
  const dialog = useDialog();
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [history, setHistory] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [openTeam, setOpenTeam] = useState(null);
  const [busy, run] = useBusy();
  const latest = useRef(0);
  const senior = user.role === 'super-admin' || user.role === 'general-manager';

  const load = useCallback(async () => {
    const request = ++latest.current;
    try {
      const [chart, trail] = await Promise.all([
        fetchJson(`/api/organization${showArchived ? '?archived=1' : ''}`),
        senior ? fetchJson('/api/organization/history?limit=40') : Promise.resolve(null)
      ]);
      if (request !== latest.current) return;
      setData(chart);
      setHistory(trail);
      setFailed(false);
    } catch (loadError) {
      if (request !== latest.current) return;
      setFailed(true);
      onError(loadError.message);
    }
  }, [fetchJson, senior, showArchived, onError]);

  useEffect(() => { load(); }, [load]);

  // Every change is one request, then a reload of the chart, so the page never
  // shows a team the server did not agree to.
  const act = useCallback((task, success) => run(async () => {
    try {
      await task();
      if (success) onMessage(success);
      await load();
      onChanged?.();
      return true;
    } catch (actionError) {
      onError(actionError.message);
      return false;
    }
  }), [run, load, onMessage, onError, onChanged]);

  if (failed && !data) {
    return <div className="empty-state load-issue">
      <strong>{t('app.loadFailed')}</strong>
      <button className="primary-btn" type="button" onClick={load}>{t('action.retry')}</button>
    </div>;
  }
  if (!data) return <div className="loading-state"><span className="spinner" />{t('app.loading')}</div>;

  return <div className="organization">
    <section className="welcome-strip">
      <div>
        <span className="eyebrow">{t('org.eyebrow')}</span>
        <h2>{senior ? t('org.title') : t('org.myTitle')}</h2>
        <p>{senior ? t('org.blurb') : user.role === 'manager' ? t('org.managerBlurb') : t('org.staffBlurb')}</p>
      </div>
    </section>

    <OrgChart data={data} user={user} t={t} language={language} busy={busy}
      onOpenTeam={(id) => setOpenTeam(id)}
      onChangeLine={(person, managerId) => act(
        () => fetchJson(`/api/users/${person.id}/assignment`, { method: 'PATCH', body: JSON.stringify({ managerId: managerId || null }) }),
        t('org.lineSaved')
      )} />

    <section className="panel" id="teams">
      <div className="panel-header">
        <div>
          <h2>{user.role === 'staff' ? t('org.myTeams') : t('org.teams')}</h2>
          <span>{fill(t('org.teamCount'), { count: data.teams.filter((team) => team.status === 'active').length })}</span>
        </div>
        {senior && <label className="check-field">
          <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
          <span>{t('org.showArchived')}</span>
        </label>}
      </div>
      {data.teams.length
        ? <div className="team-grid">{data.teams.map((team) => <TeamCard
          key={team.id}
          team={team}
          open={openTeam === team.id}
          people={data.people}
          user={user}
          canChangeSupervisor={data.can.changeSupervisors}
          t={t}
          language={language}
          busy={busy}
          fetchJson={fetchJson}
          onToggle={() => setOpenTeam(openTeam === team.id ? null : team.id)}
          onAct={act}
          dialog={dialog}
        />)}</div>
        : <div className="empty-state"><strong>{t('org.noTeams')}</strong><span>{user.role === 'staff' ? t('org.noTeamsStaff') : t('org.noTeamsHint')}</span></div>}
    </section>

    {data.can.createTeams && data.projects.length > 0 && <CreateTeamForm
      projects={data.projects} people={data.people} canChooseSupervisor={data.can.changeSupervisors}
      t={t} language={language} busy={busy}
      onCreate={(payload) => act(
        () => fetchJson('/api/organization/teams', { method: 'POST', body: JSON.stringify(payload) }),
        fill(t('org.teamCreated'), { name: payload.name })
      )} />}

    {senior && <section className="panel">
      <div className="panel-header"><div><h2>{t('org.history')}</h2></div></div>
      {history && history.length
        ? <ul className="history-list">{history.map((row) => <li key={row.id}>
          <strong>{t(`org.action.${row.action}`)}</strong>
          <span>{[row.subjectName, row.teamName && row.teamName !== row.subjectName ? row.teamName : null].filter(Boolean).join(' · ')}</span>
          <small>{row.actorName} · {new Date(row.createdAt).toLocaleString(language)}</small>
        </li>)}</ul>
        : <div className="empty-state"><strong>{t('org.historyEmpty')}</strong></div>}
    </section>}
  </div>;
}

// ---- the chart ------------------------------------------------------------------

function OrgChart({ data, user, t, language, busy, onOpenTeam, onChangeLine }) {
  const byId = useMemo(() => new Map(data.people.map((person) => [person.id, person])), [data.people]);
  const directors = data.people.filter((person) => person.role === 'super-admin');
  const generals = data.people.filter((person) => person.role === 'general-manager');
  const managers = data.people.filter((person) => person.role === 'manager');
  const teamsLedBy = (id) => data.teams.filter((team) => team.status === 'active' && team.leadId === id);
  const managerIds = new Set(managers.map((manager) => manager.id));
  const unled = data.teams.filter((team) => team.status === 'active' && !managerIds.has(team.leadId));
  const groups = [
    ...generals.map((general) => ({ general, managers: managers.filter((manager) => generalManagerOf(manager, byId) === general.id) })),
    { general: null, managers: managers.filter((manager) => generalManagerOf(manager, byId) === null) }
  ].filter((group) => group.general || group.managers.length);
  // Who a project manager may be put under: a General Manager, or nobody (the
  // Director). The API also allows a senior manager, set from People.
  const lineChoices = generals.filter((general) => general.status === 'active');

  return <section className="org-chart" aria-label={t('org.chart')}>
    <div className="org-level org-top">
      <span className="org-level-label">{t('org.superManager')}</span>
      <div className="org-row">
        {directors.map((director) => <PersonCard key={director.id} person={director} user={user} t={t} language={language} tone="top" />)}
      </div>
    </div>

    <div className={data.can.seeWholeOrganization ? 'org-branches' : 'org-branches org-branches-single'}>
      <div className="org-branch org-internal">
        <h3 className="org-branch-title">{t('org.internalBranch')}</h3>
        {groups.length === 0 && <p className="muted-cell">{t('org.noManagers')}</p>}
        {groups.map((group) => <div className="org-group" key={group.general?.id || 'direct'}>
          {group.general
            ? <PersonCard person={group.general} user={user} t={t} language={language} tone="general" />
            : (generals.length > 0 || group.managers.length > 0) && <span className="org-level-label">{t('org.directToDirector')}</span>}
          <div className="org-children">
            {group.managers.map((manager) => <div className="org-node" key={manager.id}>
              <PersonCard person={manager} user={user} t={t} language={language} tone="manager">
                {data.can.changeReportingLines && <label className="form-field org-line-select">
                  <span>{t('field.reportsTo')}</span>
                  <select value={manager.reportsToId && byId.get(manager.reportsToId)?.role === 'general-manager' ? manager.reportsToId : ''}
                    disabled={busy || (manager.reportsToId && byId.get(manager.reportsToId)?.role === 'manager')}
                    onChange={(event) => onChangeLine(manager, event.target.value ? Number(event.target.value) : null)}>
                    <option value="">{t('org.reportsToDirector')}</option>
                    {lineChoices.map((general) => <option key={general.id} value={general.id}>{general.name}</option>)}
                  </select>
                </label>}
              </PersonCard>
              {teamsLedBy(manager.id).length > 0 && <ul className="org-teams">
                {teamsLedBy(manager.id).map((team) => <li key={team.id}>
                  <button type="button" className="org-team-chip" onClick={() => { onOpenTeam(team.id); document.getElementById('teams')?.scrollIntoView({ behavior: 'smooth' }); }}>
                    <strong>{team.name}</strong>
                    <small>{team.projectName} · {fill(t('org.memberCount'), { count: team.members.length })}</small>
                  </button>
                </li>)}
              </ul>}
            </div>)}
          </div>
        </div>)}
        {unled.length > 0 && <div className="org-group">
          <span className="org-level-label">{t('org.teamsWithoutLead')}</span>
          <ul className="org-teams">{unled.map((team) => <li key={team.id}>
            <button type="button" className="org-team-chip" onClick={() => onOpenTeam(team.id)}>
              <strong>{team.name}</strong>
              <small>{team.projectName} · {fill(t('org.memberCount'), { count: team.members.length })}</small>
            </button>
          </li>)}</ul>
        </div>}
      </div>

      {data.can.seeWholeOrganization && <div className="org-branch org-external">
        <h3 className="org-branch-title">{t('org.externalBranch')}</h3>
        <p className="org-branch-note">{t('org.externalNote')}</p>
        {data.partners.length
          ? <div className="org-children">{data.partners.map((partner) => <article className="org-card org-card-partner" key={partner.id}>
            <strong>{partner.name}</strong>
            {partner.organization && <span>{partner.organization}</span>}
            <small>{partner.operations.map((id) => operationName(id, language)).join(' · ')}</small>
            <small>{partner.projects.length
              ? `${t('org.sharedProjects')}: ${partner.projects.map((project) => project.name).join(', ')}`
              : t('org.wholeOperations')}</small>
            {partner.contactName && <small>{fill(t('org.contact'), { name: partner.contactName })}</small>}
            {partner.status !== 'active' && <span className="status-badge tone-waiting">{t(`partners.${partner.status}`)}</span>}
          </article>)}</div>
          : <p className="muted-cell">{t('org.noPartners')}</p>}
      </div>}
    </div>
  </section>;
}

function PersonCard({ person, user, t, language, tone, children }) {
  const operations = person.coversAllSectors || person.role === 'super-admin' || person.role === 'general-manager'
    ? t('user.allOperations')
    : (person.operations || []).map((id) => operationName(id, language)).join(' · ');
  return <article className={`org-card org-card-${tone}`}>
    <span className="org-role">{t(`role.${person.role}`)}</span>
    <strong>{person.name}{person.id === user.id ? ` · ${t('org.you')}` : ''}</strong>
    {operations && <small>{operations}</small>}
    {person.role === 'manager' && <small>{person.projects?.length
      ? `${t('field.projects')}: ${person.projects.map((project) => project.name).join(', ')}`
      : t('org.noProjects')}</small>}
    {person.status !== 'active' && <span className="status-badge tone-waiting">{t('org.suspended')}</span>}
    {children}
  </article>;
}

// ---- one team --------------------------------------------------------------

function TeamCard({ team, open, people, user, canChangeSupervisor, t, language, busy, fetchJson, onToggle, onAct, dialog }) {
  const [candidates, setCandidates] = useState(null);
  const [choice, setChoice] = useState('');
  const [asLeader, setAsLeader] = useState(false);
  const canManage = team.canManage;

  useEffect(() => {
    if (!open || !canManage || team.status !== 'active') return;
    let cancelled = false;
    fetchJson(`/api/organization/teams/${team.id}/candidates`)
      .then((rows) => { if (!cancelled) setCandidates(rows); })
      .catch(() => { if (!cancelled) setCandidates([]); });
    return () => { cancelled = true; };
  }, [open, canManage, team.id, team.status, team.members.length, fetchJson]);

  // Who may lead this team day to day: an active manager of its operation.
  const supervisors = people.filter((person) => person.role === 'manager' && person.status === 'active'
    && (person.coversAllSectors || worksIn(person, team.sector)));

  const add = async (event) => {
    event.preventDefault();
    if (!choice) return;
    const saved = await onAct(
      () => fetchJson(`/api/organization/teams/${team.id}/members`, { method: 'POST', body: JSON.stringify({ userId: Number(choice), isLeader: asLeader }) }),
      t('org.memberAdded')
    );
    if (saved) { setChoice(''); setAsLeader(false); }
  };

  const remove = async (member) => {
    const sure = await dialog.confirm({
      title: t('org.removeTitle'),
      message: fill(t('org.removeBody'), { name: member.name, team: team.name }),
      confirmLabel: t('action.remove'),
      danger: true
    });
    if (sure) onAct(() => fetchJson(`/api/organization/teams/${team.id}/members/${member.id}`, { method: 'DELETE' }), t('org.memberRemoved'));
  };

  const archive = async () => {
    if (team.status === 'active') {
      const sure = await dialog.confirm({
        title: t('org.archiveTitle'),
        message: fill(t('org.archiveBody'), { team: team.name }),
        confirmLabel: t('org.archive'),
        danger: true
      });
      if (!sure) return;
    }
    onAct(() => fetchJson(`/api/organization/teams/${team.id}`, {
      method: 'PATCH', body: JSON.stringify({ status: team.status === 'active' ? 'archived' : 'active' })
    }), t('msg.saved'));
  };

  return <article className={`team-card${team.status !== 'active' ? ' team-card-archived' : ''}${open ? ' team-card-open' : ''}`}>
    <header className="team-card-head">
      <div>
        <span className="eyebrow">{operationName(team.sector, language)} · {team.projectName}</span>
        <h3>{team.name}</h3>
        <small>{team.leadName ? fill(t('org.ledBy'), { name: team.leadName }) : t('org.noLead')}</small>
      </div>
      <div className="team-card-actions">
        {team.status !== 'active' && <span className="status-badge tone-waiting">{t('org.archived')}</span>}
        <button className="text-btn" type="button" aria-expanded={open} onClick={onToggle}>
          {open ? t('action.close') : canManage ? t('org.manage') : t('action.open')}
        </button>
      </div>
    </header>
    {team.description && <p className="team-description">{team.description}</p>}
    <ul className="team-members">
      {team.members.length === 0 && <li className="muted-cell">{t('org.noMembers')}</li>}
      {team.members.map((member) => <li key={member.id}>
        <span>{member.name}{member.id === user.id ? ` · ${t('org.you')}` : ''}</span>
        {member.isLeader && <span className="status-badge tone-done">{t('org.leader')}</span>}
        {open && canManage && team.status === 'active' && <span className="team-member-actions">
          <button className="text-btn" type="button" disabled={busy} onClick={() => onAct(
            () => fetchJson(`/api/organization/teams/${team.id}/members/${member.id}`, { method: 'PATCH', body: JSON.stringify({ isLeader: !member.isLeader }) }),
            t('msg.saved')
          )}>{member.isLeader ? t('org.unmakeLeader') : t('org.makeLeader')}</button>
          <button className="text-btn danger-text" type="button" disabled={busy} onClick={() => remove(member)}>{t('action.remove')}</button>
        </span>}
      </li>)}
    </ul>

    {open && canManage && <div className="team-manage">
      {team.status === 'active' && <form className="inline-form" onSubmit={add}>
        <label className="form-field">
          <span>{t('org.addMember')}</span>
          <select value={choice} disabled={busy || !candidates?.length} onChange={(event) => setChoice(event.target.value)}>
            <option value="">{candidates && !candidates.length ? t('org.noCandidates') : t('org.chooseMember')}</option>
            {(candidates || []).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select>
        </label>
        <label className="check-field">
          <input type="checkbox" checked={asLeader} onChange={(event) => setAsLeader(event.target.checked)} />
          <span>{t('org.asLeader')}</span>
        </label>
        <button className="primary-btn" type="submit" disabled={busy || !choice}>{t('org.add')}</button>
      </form>}
      {canChangeSupervisor && team.status === 'active' && <label className="form-field">
        <span>{t('org.supervisor')}</span>
        <select value={team.supervisorId || ''} disabled={busy} onChange={(event) => onAct(
          () => fetchJson(`/api/organization/teams/${team.id}`, { method: 'PATCH', body: JSON.stringify({ supervisorId: event.target.value ? Number(event.target.value) : null }) }),
          t('msg.saved')
        )}>
          <option value="">{t('org.projectManagerLeads')}</option>
          {supervisors.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
        </select>
      </label>}
      <div className="button-row">
        <button className={team.status === 'active' ? 'danger-btn outlined compact' : 'secondary-btn compact'} type="button" disabled={busy} onClick={archive}>
          {team.status === 'active' ? t('org.archive') : t('org.restore')}
        </button>
      </div>
    </div>}
  </article>;
}

function CreateTeamForm({ projects, people, canChooseSupervisor, t, language, busy, onCreate }) {
  const empty = { projectId: projects[0]?.id || '', name: '', description: '', supervisorId: '' };
  const [form, setForm] = useState(empty);
  const project = projects.find((row) => row.id === form.projectId);
  const supervisors = people.filter((person) => person.role === 'manager' && person.status === 'active'
    && project && (person.coversAllSectors || worksIn(person, project.sector)));

  const submit = async (event) => {
    event.preventDefault();
    const saved = await onCreate({
      projectId: form.projectId,
      name: form.name,
      description: form.description,
      ...(canChooseSupervisor && form.supervisorId ? { supervisorId: Number(form.supervisorId) } : {})
    });
    if (saved) setForm({ ...empty, projectId: form.projectId });
  };

  return <form className="form-panel" onSubmit={submit}>
    <div className="panel-header"><div>
      <h2>{t('org.createTeam')}</h2>
      <span>{t('org.createTeamBlurb')}</span>
    </div></div>
    <div className="form-grid">
      <label className="form-field"><span>{t('field.project')}</span>
        <select required value={form.projectId} onChange={(event) => setForm({ ...form, projectId: event.target.value, supervisorId: '' })}>
          {BUSINESS_OPERATIONS.map((operation) => {
            const inOperation = projects.filter((row) => row.sector === operation.id);
            return inOperation.length > 0 && <optgroup key={operation.id} label={operationName(operation.id, language)}>
              {inOperation.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            </optgroup>;
          })}
        </select>
      </label>
      <label className="form-field"><span>{t('org.teamName')}</span>
        <input required maxLength={120} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </label>
      {canChooseSupervisor && <label className="form-field"><span>{t('org.supervisor')}</span>
        <select value={form.supervisorId} onChange={(event) => setForm({ ...form, supervisorId: event.target.value })}>
          <option value="">{project?.managerName ? fill(t('org.projectManagerNamed'), { name: project.managerName }) : t('org.projectManagerLeads')}</option>
          {supervisors.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
        </select>
      </label>}
      <label className="form-field form-field-wide"><span>{t('org.teamDescription')}</span>
        <textarea rows="2" maxLength={2000} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
      </label>
    </div>
    <div className="form-submit-bar"><button className="primary-btn" type="submit" disabled={busy || !form.name.trim() || !form.projectId}>{t('org.createTeam')}</button></div>
  </form>;
}

// ---- the General Manager's home -------------------------------------------

// What the General Manager opens on: the internal side of the organisation at
// a glance. The month's figures for every operation (from /api/summary, the
// same counts the Director's tiles read), the issues waiting on them, and each
// project manager with their projects and teams. Every number links to the
// page that lists it; nothing here can decide an approval, which is the
// Director's.
export function GeneralManagerHome({ user, summary, sectorRows, fetchJson, reloadKey, onGo, onOpenEscalation }) {
  const { language, t } = useI18n();
  const [chart, setChart] = useState(null);
  const [issues, setIssues] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchJson('/api/organization').catch(() => null),
      fetchJson('/api/escalations?box=waiting&state=open&limit=5').catch(() => [])
    ]).then(([organization, waiting]) => {
      if (cancelled) return;
      setChart(organization);
      setIssues(waiting);
    });
    return () => { cancelled = true; };
  }, [fetchJson, reloadKey]);

  const counts = summary || {};
  const tiles = [
    { id: 'issues', count: counts.escalationsAwaitingMe || 0, tone: counts.escalationsAwaitingMe ? 'urgent' : 'calm', title: t('gm.tileIssues'), go: () => onGo('escalations') },
    { id: 'overdue', count: counts.overdueWork || 0, tone: counts.overdueWork ? 'urgent' : 'calm', title: t('home.tileOverdue'), go: () => onGo('monthly') },
    { id: 'plans', count: counts.activePlans || 0, tone: 'calm', title: t('home.tileActivePlans'), go: () => onGo('monthly') },
    { id: 'progress', count: counts.objectivesInProgress || 0, tone: counts.objectivesInProgress ? 'active' : 'calm', title: t('home.tileInProgress'), go: () => onGo('monthly') },
    { id: 'done', count: counts.objectivesCompleted || 0, tone: 'calm', title: t('home.tileCompleted'), go: () => onGo('monthly') },
    { id: 'reports', count: counts.monthEndReportsWaiting || 0, tone: counts.monthEndReportsWaiting ? 'active' : 'calm', title: t('gm.tileReportsWithDirector'), go: () => onGo('reports') }
  ];
  const managers = (chart?.people || []).filter((person) => person.role === 'manager');
  const teamsOf = (id) => (chart?.teams || []).filter((team) => team.leadId === id && team.status === 'active');

  return <div className="home">
    <section className="home-hello">
      <div>
        <h2>{t('gm.title')}</h2>
        <p>{fill(t('gm.hello'), { name: user.name })}</p>
      </div>
      <div className="home-quick">
        <button className="primary-btn" type="button" onClick={() => onGo('escalations')}>{t('gm.openIssues')}</button>
        <button className="secondary-btn" type="button" onClick={() => onGo('organization')}>{t('gm.openChart')}</button>
        <button className="secondary-btn" type="button" onClick={() => onGo('reports')}>{t('home.viewReports')}</button>
      </div>
    </section>

    <div className="home-tiles">
      {tiles.map((tile) => <button key={tile.id} type="button" className={`home-tile home-tile-${tile.tone}`} onClick={tile.go}>
        <span className="home-tile-count">{tile.count}</span>
        <span className="home-tile-text">{tile.title}</span>
      </button>)}
    </div>

    <h3 className="home-heading">{t('gm.issuesHeading')}</h3>
    {issues === null
      ? <div className="compact-loading"><span className="spinner" /></div>
      : <EscalationList items={issues} t={t} language={language} onOpen={onOpenEscalation} empty={t('esc.emptyWaiting')} />}

    <h3 className="home-heading">{t('gm.operationsHeading')}</h3>
    <div className="table-wrap"><table className="card-table">
      <thead><tr>
        <th>{t('app.businessOperation')}</th>
        <th>{t('gm.colActivities')}</th>
        <th>{t('gm.colActive')}</th>
        <th>{t('gm.colCompleted')}</th>
        <th>{t('gm.colWaiting')}</th>
      </tr></thead>
      <tbody>{(sectorRows || []).map((row) => <tr key={row.id}>
        <td className="card-title-cell"><strong>{operationName(row.id, language)}</strong></td>
        <td data-label={t('gm.colActivities')}>{row.activities}</td>
        <td data-label={t('gm.colActive')}>{row.activeActivities}</td>
        <td data-label={t('gm.colCompleted')}>{row.completedActivities}</td>
        <td data-label={t('gm.colWaiting')}>{row.decisionsPending + row.finalChecks}</td>
      </tr>)}</tbody>
    </table></div>

    <h3 className="home-heading">{t('gm.managersHeading')}</h3>
    {chart === null
      ? <div className="compact-loading"><span className="spinner" /></div>
      : managers.length
        ? <div className="team-grid">{managers.map((manager) => <article className="org-card org-card-manager" key={manager.id}>
          <span className="org-role">{manager.coversAllSectors ? t('user.allOperations') : operationsOf(manager).map((id) => operationName(id, language)).join(' · ')}</span>
          <strong>{manager.name}</strong>
          <small>{manager.projects.length ? `${t('field.projects')}: ${manager.projects.map((project) => project.name).join(', ')}` : t('org.noProjects')}</small>
          <small>{teamsOf(manager.id).length
            ? `${t('org.teams')}: ${teamsOf(manager.id).map((team) => `${team.name} (${team.members.length})`).join(', ')}`
            : t('org.noTeams')}</small>
          {manager.status !== 'active' && <span className="status-badge tone-waiting">{t('org.suspended')}</span>}
        </article>)}</div>
        : <div className="empty-state"><strong>{t('org.noManagers')}</strong></div>}
  </div>;
}
