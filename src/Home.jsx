import { useEffect, useRef, useState } from 'react';
import { BUSINESS_OPERATIONS, operationName, operationsOf, worksIn } from '../shared/businessOperations.js';
import { fill, useI18n } from './i18n.js';
import { MoneyBar, activityJourney, journeyLabel, journeyTone, nextAction } from './journey.jsx';
import { DATE_STYLE, dateLocale, todayLocal } from './format.js';
import { ActionIcon, STEP_ICONS } from './ui.jsx';
import { BudgetCards, MonthTrend, ProjectProgress } from './Progress.jsx';

// How many of the newest manager-raised activities the Director's Home lists.
const LATEST_FROM_MANAGERS = 5;

// The home screen: "what do I need to do?", before anything else.
//
// It used to be a report -- five metrics, two of them measuring something other
// than their label, then a stack of tables. A first-time reader could not tell
// what was theirs to act on. Now it opens with the few things that need this
// person, each a large tile with its count that leads straight to the list; then
// the quick actions they are allowed; then this month's money for the business
// operations they cover; then the first items of their own queues.
//
// Every count comes from /api/summary, built from the same SQL as the list its
// tile opens, and every button is drawn only for the roles the API allows.

// The organisation's notices worth a card on Home rather than only a line
// under the bell.
const ORGANIZATION_ALERTS = ['work_to_check', 'team_added'];

// What the button on a Home alert card says: where it takes the reader.
function alertButton(kind, t) {
  if (kind === 'plan_assigned' || kind === 'plan_changed') return t('home.viewPlan');
  if (kind === 'team_added') return t('home.openTeam');
  if (kind === 'work_to_check') return t('do.checkWork');
  return t('home.openRecord');
}

function thisMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(month, language) {
  const [year, index] = month.split('-').map(Number);
  return new Date(year, index - 1, 1).toLocaleDateString(language, { month: 'long', year: 'numeric' });
}

export function formatUsdShort(value) {
  const amount = Number(value || 0);
  return `${amount < 0 ? '-' : ''}$${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(amount))}`;
}

// A date-only string written the way people say it. Built from the parts rather
// than through Date, which reads '2026-09-20' as UTC midnight and prints the day
// before anywhere west of Greenwich.
function formatDay(value, language) {
  const [year, month, day] = String(value || '').slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return String(value || '');
  return new Date(year, month - 1, day).toLocaleDateString(language, { day: 'numeric', month: 'long' });
}

function todayLabel(language) {
  return new Date().toLocaleDateString(language, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

// Where one objective stands, in the four words a manager uses: not started,
// in progress, done, overdue. Derived from the figures the server calculates
// (nothing is typed) so the plan screen, the dashboard and the Director's
// review all call the same objective the same thing.
//
// Overdue beats in-progress: an objective past its own deadline with work still
// to do is late whatever else is true of it. An objective with no deadline is
// due at month end and is never called overdue mid-month.
export function objectiveState(objective, today = todayLocal()) {
  if (objective.complete) return 'done';
  if (objective.deadline && objective.deadline < today) return 'overdue';
  if (Number(objective.quantityDone) > 0 || Number(objective.updateCount) > 0) return 'inProgress';
  return 'notStarted';
}

export function objectiveStateTone(state) {
  if (state === 'done') return 'tone-done';
  if (state === 'overdue') return 'tone-stopped';
  if (state === 'inProgress') return 'tone-active';
  return 'tone-waiting';
}

export default function Home({
  user, summary, sectorRows, approvalItems, approvalCount, fetchJson, reloadKey,
  canAddActivity, canAddMovement, busy, rate,
  onGo, onAddActivity, onAddMovement, onOpenActivity, onOpenQueueItem, onDecide, onOpenPlan, onStartWork,
  notices = null, onOpenNotice
}) {
  const { language, t } = useI18n();
  const isDirector = user.role === 'super-admin';
  const isManager = user.role === 'manager';
  // A team member's home is the list of their work and nothing else. It used to
  // be the same page as everybody's: one lonely tile under a "To do" heading,
  // then the whole business operation's approved budget and spend -- figures
  // that are their manager's to worry about and that they cannot act on.
  const isWorker = !isDirector && !isManager;
  const month = thisMonth();
  const [plans, setPlans] = useState(null);
  // This month's money across every operation, from the same review payload.
  const [planTotals, setPlanTotals] = useState(null);
  const [myWork, setMyWork] = useState(null);
  const [recent, setRecent] = useState([]);
  const [finalChecks, setFinalChecks] = useState(null);
  // A project manager's: their team members' finished work waiting for them.
  const [toCheck, setToCheck] = useState([]);
  // The five newest records managers put into the register, whatever state
  // they are in, so the latest arrivals are in front of the Director in order.
  // The whole history is the report export.
  const [latestFromManagers, setLatestFromManagers] = useState([]);
  // What the managers have actually recorded lately, across every operation in
  // scope. The Director monitors rather than asks: this arrives with the page.
  const [updates, setUpdates] = useState([]);
  // Bumped after a correction so the corrected figure is the one shown.
  const [ownReload, setOwnReload] = useState(0);
  const latest = useRef(0);

  // Its own lists, reloaded whenever the workspace refreshes its data.
  useEffect(() => {
    const request = ++latest.current;
    Promise.allSettled([
      fetchJson(`/api/monthly-plans/review?month=${month}`),
      isDirector ? Promise.resolve([]) : fetchJson('/api/activities?awaiting=work&limit=20'),
      isDirector ? fetchJson('/api/activities?awaiting=final-check&limit=6') : Promise.resolve([]),
      // What they finished lately, so the page can say so rather than simply
      // losing the work the moment it is done.
      isWorker ? fetchJson('/api/activities?status=Completed&assignedTo=me&limit=3') : Promise.resolve([]),
      // The operational history, newest first. A team member has no month of
      // their own to monitor, so they are not asked for it. A manager gets only
      // the last day they recorded themselves -- the one they may still
      // correct; the rest of the record is in the month itself.
      isWorker ? Promise.resolve({ updates: [] })
        : fetchJson(isManager ? '/api/monthly-plans/updates?limit=1&mine=1' : '/api/monthly-plans/updates?limit=5'),
      isDirector ? fetchJson(`/api/activities?raisedBy=managers&limit=${LATEST_FROM_MANAGERS}`) : Promise.resolve([]),
      isManager ? fetchJson('/api/activities?awaiting=check&limit=10') : Promise.resolve([])
    ]).then(([planResult, workResult, checkResult, doneResult, updateResult, latestResult, toCheckResult]) => {
      if (request !== latest.current) return;
      setToCheck(toCheckResult.status === 'fulfilled' ? toCheckResult.value : []);
      setLatestFromManagers(latestResult.status === 'fulfilled' ? latestResult.value : []);
      setUpdates(updateResult.status === 'fulfilled' ? updateResult.value.updates || [] : []);
      setRecent(doneResult.status === 'fulfilled' ? doneResult.value : []);
      setPlans(planResult.status === 'fulfilled' ? planResult.value.operations || [] : []);
      setPlanTotals(planResult.status === 'fulfilled' ? planResult.value.totals || null : null);
      setMyWork(workResult.status === 'fulfilled'
        ? [...workResult.value].sort((left, right) => (left.deadline || '9999-12-31').localeCompare(right.deadline || '9999-12-31'))
        : []);
      setFinalChecks(checkResult.status === 'fulfilled' ? checkResult.value : []);
    });
  }, [fetchJson, isDirector, isManager, isWorker, month, reloadKey, ownReload]);

  // Correcting the last day, in place. Only the author's latest day on an open
  // month carries `correctable`; PUT /reports/:id re-checks all of it.
  const [editing, setEditing] = useState(null);
  const [editError, setEditError] = useState('');
  const [saving, setSaving] = useState(false);
  const startEdit = (update) => {
    setEditError('');
    setEditing({ id: update.id, planId: update.planId, quantityDone: String(update.quantityDone || ''), cost: String(update.cost || ''), notes: update.notes || '',
      workStatus: update.workStatus || '', remarks: update.remarks || '' });
  };
  const saveEdit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setEditError('');
    try {
      await fetchJson(`/api/monthly-plans/${editing.planId}/reports/${editing.id}`, {
        method: 'PUT',
        body: JSON.stringify({ quantityDone: Number(editing.quantityDone || 0), cost: Number(editing.cost || 0), notes: editing.notes,
          workStatus: editing.workStatus, remarks: editing.remarks })
      });
      setEditing(null);
      setOwnReload((value) => value + 1);
    } catch (error) {
      setEditError(error.message);
    } finally {
      setSaving(false);
    }
  };

  const counts = summary || {};
  // The month at a glance: how many months are live and how much of their
  // work is moving or finished. What needs acting on is not repeated here --
  // it is said once, as a sentence, in "Needs your attention" above.
  const tiles = [
    isDirector && {
      id: 'plans', count: counts.activePlans || 0, tone: 'calm',
      title: t('home.tileActivePlans'),
      onClick: () => onGo('monthly')
    },
    isDirector && {
      id: 'progress', count: counts.objectivesInProgress || 0, tone: counts.objectivesInProgress ? 'active' : 'calm',
      title: t('home.tileInProgress'),
      onClick: () => onGo('monthly')
    },
    isDirector && {
      id: 'done', count: counts.objectivesCompleted || 0, tone: 'calm',
      title: t('home.tileCompleted'),
      onClick: () => onGo('monthly')
    },
  ].filter(Boolean);

  // "Needs your attention": the same counts as sentences, each one a link. A
  // Director who reads one line and presses it has done the whole dashboard.
  const attention = isDirector ? [
    counts.monthEndReportsWaiting > 0 && { id: 'reports', text: fill(t(counts.monthEndReportsWaiting === 1 ? 'home.attentionReportsOne' : 'home.attentionReports'), { count: counts.monthEndReportsWaiting }), go: () => onGo('approval-queue') },
    counts.finalChecksWaiting > 0 && { id: 'checks', text: fill(t(counts.finalChecksWaiting === 1 ? 'home.attentionChecksOne' : 'home.attentionChecks'), { count: counts.finalChecksWaiting }), go: () => onGo('activities', 'final-check') },
    approvalCount > 0 && { id: 'approvals', text: fill(t(approvalCount === 1 ? 'home.attentionApprovalsOne' : 'home.attentionApprovals'), { count: approvalCount }), go: () => onGo('approval-queue') },
    counts.overdueWork > 0 && { id: 'overdue', text: fill(t(counts.overdueWork === 1 ? 'home.attentionOverdueOne' : 'home.attentionOverdue'), { count: counts.overdueWork }), go: () => onGo('monthly') },
    counts.budgetChangesPending > 0 && { id: 'budget', text: fill(t(counts.budgetChangesPending === 1 ? 'home.attentionBudgetOne' : 'home.attentionBudget'), { count: counts.budgetChangesPending }), go: () => onGo('activities') }
  ].filter(Boolean) : [];

  // The newest work managers added, less anything already shown above it as a
  // decision or a final check -- one record, one place on the page.
  const shownAbove = new Set([...(approvalItems || []), ...(finalChecks || [])].map((item) => item.id));
  const latestElsewhere = latestFromManagers.filter((item) => !shownAbove.has(item.id));

  // What the system told this manager and they have not opened yet, shown as
  // cards at the top of their home: a new plan, work returned, a report
  // returned. These are the events that change what they should do next, so
  // they are not left under the bell alone. Opening one marks it read.
  //
  // The organisation's events join them, for a manager and a team member
  // alike: being put on a team, an issue arriving, and the answer to one they
  // raised. Each opens where it happened (the team page, or the issue).
  const alertKinds = [
    ...(isManager ? ['plan_assigned', 'report_returned', 'report_accepted', 'plan_changed'] : []),
    ...(isManager || isWorker ? ORGANIZATION_ALERTS : [])
  ];
  const listedToCheck = new Set(toCheck.map((item) => item.id));
  const alerts = (notices?.items || []).filter((notice) => !notice.read && alertKinds.includes(notice.kind)
    && !(notice.kind === 'work_to_check' && listedToCheck.has(notice.activityId))).slice(0, 4);


  // The operations this account covers: all four for the Director or an
  // all-operations manager, otherwise each one they work in -- a manager may
  // run Mining and Agriculture at once.
  const operations = BUSINESS_OPERATIONS.filter((operation) => isDirector || worksIn(user, operation.id));
  const rowFor = (id) => (sectorRows || []).find((row) => row.id === id) || {};
  const planFor = (id) => (plans || []).find((plan) => plan.operation === id);
  // The manager's own months, taken from the review payload that is already
  // loaded -- it carries each plan's objectives and overall figure, so the
  // manager's dashboard costs no extra request. One per operation they run,
  // and only the months they may work (canWorkPlan: nobody named on it, or
  // them), so a second operation's month is not hidden behind the first.
  const myMonths = isManager
    ? (plans || []).filter((plan) => worksIn(user, plan.operation)
      && (plan.managerId === null || plan.managerId === undefined || Number(plan.managerId) === Number(user.id)))
    : [];

  // A team member's page: their name for it, how much there is, and the list.
  if (isWorker) {
    const waiting = myWork === null;
    return <div className="home">
      <section className="home-hello">
        <div>
          <h2>{t('nav.myWork')}</h2>
          <p>{operationsOf(user).map((id) => operationName(id, language)).join(' · ')} · {todayLabel(language)}</p>
        </div>
      </section>

      {alerts.length > 0 && <ul className="home-alerts">
        {alerts.map((notice) => <li key={notice.id} className={`home-alert home-alert-${notice.kind}`}>
          <span>{noticeSentence(notice, t, language)}</span>
          <button type="button" className="primary-btn compact" onClick={() => onOpenNotice?.(notice)}>{alertButton(notice.kind, t)}</button>
        </li>)}
      </ul>}

      {!waiting && (myWork.length > 0
        ? <>
          {/* Said in a sentence, because a number in a box does not tell somebody
              what it is a number OF. */}
          <p className="home-lead">{myWork.length === 1
            ? t('home.oneToDo')
            : fill(t('home.howManyToDo'), { count: myWork.length })}</p>
          <WorkList items={myWork} user={user} t={t} language={language} onOpen={onOpenActivity} onStart={onStartWork} busy={busy} />
        </>
        : <div className="empty-state">
          <strong>{t('home.noWorkTitle')}</strong>
          <span>{t('home.noWorkText')}</span>
        </div>)}

      {recent.length > 0 && <>
        <h3 className="home-heading">{t('home.recentlyDone')}</h3>
        <WorkList items={recent} user={user} t={t} language={language} onOpen={onOpenActivity} />
      </>}
    </div>;
  }

  return <div className="home">
    <section className="home-hello">
      <div>
        <h2>{isDirector || user.coversAllSectors ? t('user.allOperations') : operationsOf(user).map((id) => operationName(id, language)).join(' · ')}</h2>
        <p>{todayLabel(language)}</p>
      </div>
      {/* The Director's five doors (section 1 of the brief), in the words of
          the job: create a plan, review what came in, the managers, the
          reports, the budgets. Assigning a one-off activity and logging a trip
          are still here, but behind the five, because they are not the daily
          workflow. A manager keeps their own two. */}
      {isDirector
        ? <div className="home-quick home-quick-director">
          <button className="primary-btn" type="button" onClick={() => onGo('monthly', 'create')}>{t('home.createPlan')}</button>
          <button className="secondary-btn" type="button" onClick={() => onGo('approval-queue')}>{t('home.reviewWork')}</button>
          {canAddActivity && <button className="secondary-btn" type="button" onClick={onAddActivity}>{t('action.assignActivity')}</button>}
        </div>
        : !isManager && (canAddActivity || canAddMovement) && <div className="home-quick">
          {canAddActivity && <button className="primary-btn" type="button" onClick={onAddActivity}>{t('action.raiseActivity')}</button>}
          {canAddMovement && <button className="secondary-btn" type="button" onClick={onAddMovement}>{t('home.newTrip')}</button>}
        </div>}
    </section>

    {/* What the system has told this manager since they last looked: a new
        plan, work or a report returned with its reason, work approved. Each
        card is one sentence and one button. */}
    {alerts.length > 0 && <ul className="home-alerts">
      {alerts.map((notice) => <li key={notice.id} className={`home-alert home-alert-${notice.kind}`}>
        <span>{noticeSentence(notice, t, language)}</span>
        <button type="button" className="primary-btn compact" onClick={() => onOpenNotice?.(notice)}>
          {alertButton(notice.kind, t)}
        </button>
      </li>)}
    </ul>}

    {/* A team member's finished work is checked here before the Director
        sees it: the project manager's own queue, one press from the record. */}
    {isManager && toCheck.length > 0 && <>
      <h3 className="home-heading">{fill(t('home.toCheckHeading'), { count: toCheck.length })}</h3>
      <WorkList items={toCheck} user={user} t={t} language={language} onOpen={onOpenActivity} />
    </>}

    {/* THE MANAGER'S DASHBOARD (section 10 of the brief): the month in one
        line -- how many objectives, how many done, in progress, not started --
        then each objective with the one thing to do on it, then the one button
        that records today's work. It comes before the queues and the tiles
        because leading the operation and writing down what happened IS the
        manager's job; the rest is secondary.

        The Director does not get this block: they monitor the four operations
        further down the page and do not record work at all. */}
    {isManager && plans !== null && !myMonths.some((myMonth) => myMonth.objectives?.length > 0) && <div className="empty-state">
      <strong>{t('home.noPlanForYou')}</strong>
    </div>}
    {isManager && myMonths.filter((myMonth) => myMonth.objectives?.length > 0).map((myMonth) => {
      const states = myMonth.objectives.map((objective) => objectiveState(objective));
      const done = states.filter((state) => state === 'done').length;
      const active = states.filter((state) => state === 'inProgress' || state === 'overdue').length;
      const left = states.length - done - active;
      const notStarted = myMonth.status === 'Confirmed';
      const allDone = done === states.length;
      const submitted = myMonth.report?.status === 'Submitted';
      const closed = myMonth.status === 'Closed';
      return <section className="my-month" key={myMonth.id}>
        <div className="my-month-head">
          <div>
            {/* Which operation, once there is more than one card to tell apart. */}
            {myMonths.length > 1 && <span className="eyebrow">{operationName(myMonth.operation, language)}</span>}
            <h3>{fill(t('home.myPlanTitle'), { month: monthLabel(month, language) })}</h3>
            <small>{fill(t('home.objectiveCounts'), { total: states.length, done, active, left })}</small>
          </div>
          {myMonth.overallProgress !== null && myMonth.overallProgress !== undefined
            && <span className="my-month-overall">{myMonth.overallProgress}%</span>}
        </div>
        <h4 className="my-month-sub">{t('home.todaysWork')}</h4>
        <div className="my-month-objectives">
          {myMonth.objectives.map((objective, index) => {
            const state = states[index];
            return <div className="my-month-objective" key={objective.id}>
              <div className="my-month-objective-head">
                <strong>{objective.title}</strong>
                <span className={`status-badge ${objectiveStateTone(state)}`}>{t(`plan.objectiveState.${state}`)}</span>
              </div>
              {objective.percent !== null && <>
                <div className="objective-bar"><span style={{ width: `${objective.percent}%` }} /></div>
                <div className="objective-figures">
                  <span>{fill(t('plan.doneOfTarget'), {
                    done: objective.quantityDone, target: objective.targetQuantity, unit: objective.targetUnit
                  })}</span>
                  {objective.deadline && !objective.complete && <span className="muted-cell">
                    {fill(t('plan.dueOn'), { date: formatDay(objective.deadline, language) })}
                  </span>}
                </div>
              </>}
              {/* One obvious action per objective: Start on a month nobody has
                  begun, Update once it is moving, nothing once it is done. All
                  of them open the plan, where the form is. */}
              {!closed && state !== 'done' && <div className="my-month-do">
                <button type="button" className={notStarted ? 'primary-btn compact' : 'secondary-btn compact'}
                  onClick={() => onOpenPlan(myMonth.id)}>
                  {notStarted ? t('home.actionStart') : t('home.actionUpdate')}
                </button>
              </div>}
            </div>;
          })}
        </div>
        {/* The main action on the manager's whole screen: record today, or --
            once the month is done -- hand it in. */}
        {!closed && (submitted
          ? <p className="my-month-note">{t('monthend.waitingReview')}</p>
          : <button className="primary-btn big-action my-month-record" type="button" onClick={() => onOpenPlan(myMonth.id)}>
            {allDone || myMonth.status === 'Completed'
              ? <><ActionIcon name="finish" />{t('home.actionSubmit')}</>
              : <><ActionIcon name="write" />{t('plan.writeToday')}</>}
          </button>)}
      </section>;
    })}

    {/* The Director's "needs your attention" (section 11): every line a link. */}
    {isDirector && <>
      <h3 className="home-heading">{t('home.needsAttention')}</h3>
      {attention.length
        ? <ul className="attention-list">
          {attention.map((item) => <li key={item.id}>
            <button type="button" className="attention-item" onClick={item.go}>{item.text} &rarr;</button>
          </li>)}
        </ul>
        : <p className="home-lead">{t('home.allClear')}</p>}
    </>}

    {!isManager && <h3 className="home-heading">{t('home.todo')}</h3>}
    {!isManager && <div className="home-tiles">
      {tiles.map((tile) => <button key={tile.id} type="button" className={`home-tile home-tile-${tile.tone}`} onClick={tile.onClick}>
        <span className="home-tile-count">{tile.count}</span>
        <span className="home-tile-text">{tile.title}</span>
      </button>)}
    </div>}

    {isDirector && approvalItems.length > 0 && <>
      <h3 className="home-heading">{t('home.tileApprovals')}</h3>
      <DecisionList items={approvalItems.slice(0, 3)} onOpen={onOpenQueueItem} onDecide={onDecide} busy={busy} />
      {approvalItems.length > 3 && <button className="text-btn home-more" type="button" onClick={() => onGo('approval-queue')}>
        {fill(t('home.seeAll'), { count: approvalCount })} &rarr;
      </button>}
    </>}

    {isDirector && finalChecks && finalChecks.length > 0 && <>
      <h3 className="home-heading">{t('home.tileChecks')}</h3>
      <WorkList items={finalChecks} user={user} t={t} language={language} onOpen={onOpenActivity} />
    </>}

    {isDirector && latestElsewhere.length > 0 && <>
      <h3 className="home-heading">{t('home.latestFromManagers')}</h3>
      <p className="field-hint">{t('home.latestFromManagersHint')}</p>
      <WorkList items={latestElsewhere} user={user} t={t} language={language} onOpen={onOpenActivity} />
    </>}

    {/* WHAT HAPPENED. The Director does not ask a manager how the month is
        going: every day a manager records appears here, newest first, with the
        objective it counted towards and where that objective now stands. A
        manager sees the same feed for their own operation. The Director gets
        only the five newest: across every operation the feed ran to a long
        list that pushed the rest of Home off the screen, and each plan still
        holds its full day-by-day record. */}
    {!isWorker && updates.length > 0 && <>
      <h3 className="home-heading">{t(isManager ? 'home.myLatestUpdate' : 'home.recentUpdates')}</h3>
      <ul className="update-feed">
        {updates.slice(0, isManager ? 1 : 5).map((update) => editing?.id === update.id
          ? <li key={update.id} className="update-row">
            <form className="update-edit" onSubmit={saveEdit}>
              <strong>{formatDay(update.date, language)} &middot; {operationName(update.operation, language)}
                {update.objectiveTitle && <> &middot; {update.objectiveTitle}</>}</strong>
              {/* Same headers and order as the day form and the exports. */}
              <label className="form-field form-field-wide"><span>{t('day.description')}</span>
                <textarea rows="3" maxLength={4000} value={editing.notes}
                  onChange={(event) => setEditing({ ...editing, notes: event.target.value })} />
              </label>
              <label className="form-field"><span>{t('day.quantity')}{update.targetUnit && ` (${update.targetUnit})`}</span>
                <input type="number" min="0" step="any" inputMode="decimal" value={editing.quantityDone}
                  onChange={(event) => setEditing({ ...editing, quantityDone: event.target.value })} />
              </label>
              <label className="form-field"><span>{t('day.cost')}</span>
                <input type="number" min="0" step="0.01" inputMode="decimal" value={editing.cost}
                  onChange={(event) => setEditing({ ...editing, cost: event.target.value })} />
              </label>
              <label className="form-field"><span>{t('day.status')}</span>
                <input maxLength={100} placeholder={t('plan.dayStatusHint')} value={editing.workStatus}
                  onChange={(event) => setEditing({ ...editing, workStatus: event.target.value })} />
              </label>
              <label className="form-field form-field-wide"><span>{t('day.remarks')}</span>
                <textarea rows="2" maxLength={4000} value={editing.remarks}
                  onChange={(event) => setEditing({ ...editing, remarks: event.target.value })} />
              </label>
              {editError && <p className="error-banner" role="alert">{editError}</p>}
              <div className="button-row">
                <button className="primary-btn" type="submit" disabled={saving}>{t('action.saveCorrection')}</button>
                <button className="text-btn" type="button" disabled={saving} onClick={() => setEditing(null)}>{t('action.cancel')}</button>
              </div>
            </form>
          </li>
          : <li key={update.id} className="update-row">
          <button type="button" className="update-main" onClick={() => onOpenPlan(update.planId)}>
            <span className="update-when">{formatDay(update.date, language)}</span>
            <span className="update-what">
              <strong>{operationName(update.operation, language)}</strong>
              {update.objectiveTitle && <span className="update-objective">{update.objectiveTitle}</span>}
              <span className="update-detail">
                {update.quantityDone > 0
                  ? fill(t('home.updateDid'), { amount: update.quantityDone, unit: update.targetUnit })
                  : (update.notes || t('home.updateNoQuantity'))}
                {update.workStatus && <> &middot; {t('day.status')}: {update.workStatus}</>}
              </span>
            </span>
            {update.objectivePercent !== null && update.objectivePercent !== undefined
              && <span className="update-percent">{update.objectivePercent}%</span>}
          </button>
          {isManager && update.correctable && update.submittedBy === user.id
            ? <button className="secondary-btn update-edit-btn" type="button" onClick={() => startEdit(update)}>{t('action.correctDay')}</button>
            : <small className="update-by">{update.submittedByName}</small>}
        </li>)}
      </ul>
    </>}

    {/* The money, across the open months (section 1: "budget overview"): the
        ceilings the Director approved and what has been recorded against them.
        Summed from the plans, not the legacy project figures. */}
    {/* This month's money across every operation: the same three cards as
        the monthly plan page, from the same review payload, so the two pages
        cannot show different figures for the same month. */}
    {isDirector && planTotals && <>
      <h3 className="home-heading">{`${t('home.budgetOverview')} · ${monthLabel(month, language)}`}</h3>
      <BudgetCards approved={planTotals.approvedBudget} spent={planTotals.totalSpent}
        remaining={planTotals.remainingBalance} unbudgeted={planTotals.spentWithoutBudget} t={t} />
    </>}

    {/* How far each project has got, and the last six months -- work done,
        kept apart from money spent. Both are calculated by the API. */}
    {isDirector && <div className="home-progress">
      <ProjectProgress fetchJson={fetchJson} reloadKey={reloadKey} compact />
      <MonthTrend fetchJson={fetchJson} reloadKey={reloadKey} />
    </div>}

    {/* The operations at a glance are the Director's. A manager's Home is their
        own month and their latest day, and nothing else: their plan above is
        where they work. */}
    {isDirector && <h3 className="home-heading">{`${t('home.sectorProgress')} · ${monthLabel(month, language)}`}</h3>}
    {isDirector && <div className="home-operations">
      {operations.map((operation) => {
        const plan = planFor(operation.id);
        const row = rowFor(operation.id);
        return <article key={operation.id} className={`operation-card operation-${operation.id}`}>
          <header>
            <div>
              <h4>{operationName(operation.id, language)}</h4>
              <small>{plan?.managerName ? fill(t('home.runBy'), { name: plan.managerName }) : t('home.noPlanYet')}</small>
            </div>
          </header>
          {/* A draft month used to show "not decided yet" against the budget,
              because the figure was only worked out at confirmation. The Director
              now states it when they create the plan, so it is a real number from
              the first day and is shown as one. */}
          {/* WHAT THE MONTH COMMITTED TO, AND HOW FAR IT HAS GOT. This comes
              first because it is what the month is; the money is a detail of it
              and follows underneath. Every bar is summed from the manager's own
              records -- nobody types a percentage anywhere in this system. */}
          {plan?.objectives?.length > 0 && <div className="operation-objectives">
            {plan.overallProgress !== null && plan.overallProgress !== undefined && <div className="operation-overall">
              <span>{t('plan.overallProgress')}</span>
              <strong>{plan.overallProgress}%</strong>
            </div>}
            {plan.objectives.map((objective) => <div className="operation-objective" key={objective.id}>
              <div className="operation-objective-head">
                <span>{objective.title}</span>
                {objective.percent === null
                  ? <small className="muted-cell">{t('plan.notCounted')}</small>
                  : <small>{objective.percent}%</small>}
              </div>
              {objective.percent !== null && <div className="objective-bar">
                <span style={{ width: `${objective.percent}%` }} />
              </div>}
            </div>)}
          </div>}
          {plan
            ? <MoneyBar approved={plan.approvedBudget} spent={plan.totalSpent}
              format={formatUsdShort} rates={rate} />
            : <p className="operation-empty">{isDirector ? t('home.planThisMonth') : t('home.noPlanForYou')}</p>}
          <ul className="operation-facts">
            <li><strong>{row.activeActivities || 0}</strong> {t('home.underWay')}</li>
            <li><strong>{row.decisionsPending || 0}</strong> {t('home.waitingDecision')}</li>
            <li><strong>{row.finalChecks || 0}</strong> {t('home.waitingCheck')}</li>
          </ul>
          <div className="operation-actions">
            {plan
              ? <button className="secondary-btn" type="button" onClick={() => onOpenPlan(plan.id)}>{t('home.openMonth')}</button>
              : isDirector && <button className="secondary-btn" type="button" onClick={() => onGo('monthly')}>{t('home.planMonth')}</button>}
          </div>
        </article>;
      })}
    </div>}
  </div>;
}

// One notification as a sentence, in the reader's language. The server stores
// the event's kind and its params, never a sentence, so the same row reads in
// Kinyarwanda for one person and French for the next.
export function noticeSentence(notice, t, language) {
  const params = notice.params || {};
  // The Director's change, in the trail's own words. Not every action the
  // server writes has a history.* key (the plan trail falls back to the English
  // action for those, in trailActionLabel), so the same fallback applies here
  // rather than printing "history.Objective set" under the bell.
  const actionLabel = (action) => {
    const key = `history.${action}`;
    const label = t(key);
    return label === key ? action : label;
  };
  const detail = Array.isArray(params.changes) && params.changes.length
    ? params.changes.map(actionLabel).join(', ') + (params.detail ? ` (${params.detail})` : '')
    : (params.detail || '');
  return fill(t(`notice.kind.${notice.kind}`), {
    operation: params.operation ? operationName(params.operation, language) : '',
    month: params.month ? monthLabel(params.month, language) : '',
    detail,
    name: params.managerName || notice.actorName || '',
    reason: params.reason || '',
    activity: params.activity || '',
    // The organisation's events: a team, its project, an issue's title.
    team: params.team || '',
    project: params.project || '',
    title: params.title || '',
    // The boutique's decisions: approved or refused, accepted or returned, in
    // the reader's words; and a figure (the pieces left on a shelf).
    outcome: params.outcome ? t(`btq.outcome.${params.outcome}`) : '',
    count: params.count ?? ''
  });
}

// The Director's REVIEW WORK page (section 8 of the brief): what the managers
// have handed in. Two lists -- finished activities waiting for the final check,
// and month-end reports waiting to be accepted or returned -- each item opening
// the record where the approve / return buttons live. Both come from the same
// queries as the dashboard tiles, so the numbers and the lists agree.
export function ReviewQueue({ fetchJson, reloadKey, user, onOpenActivity, onOpenPlan }) {
  const { language, t } = useI18n();
  const [checks, setChecks] = useState(null);
  const [reports, setReports] = useState(null);
  const latest = useRef(0);

  useEffect(() => {
    const request = ++latest.current;
    Promise.allSettled([
      fetchJson('/api/activities?awaiting=final-check&limit=50'),
      fetchJson('/api/monthly-plans')
    ]).then(([checkResult, planResult]) => {
      if (request !== latest.current) return;
      setChecks(checkResult.status === 'fulfilled' ? checkResult.value : []);
      setReports(planResult.status === 'fulfilled'
        ? (planResult.value || []).filter((plan) => plan.report?.status === 'Submitted' && plan.status !== 'Closed')
        : []);
    });
  }, [fetchJson, reloadKey]);

  if (checks === null || reports === null) return null;
  return <section className="review-queue">
    <p className="home-lead">{t('home.reviewQueueBlurb')}</p>
    <h3 className="home-heading">{t('home.reviewReports')}</h3>
    {reports.length
      ? <ul className="work-list">
        {reports.map((plan) => <li key={plan.id}>
          <button type="button" className="work-card" onClick={() => onOpenPlan(plan.id)}>
            <span className="work-card-text">
              <strong>{operationName(plan.operation, language)} · {monthLabel(plan.month, language)}</strong>
              <small>{plan.managerName || '—'}
                {plan.report?.submittedAt ? ` · ${fill(t('home.submittedOn'), { date: new Date(plan.report.submittedAt).toLocaleDateString(dateLocale(language), DATE_STYLE) })}` : ''}
                {plan.overallProgress !== null && plan.overallProgress !== undefined ? ` · ${plan.overallProgress}%` : ''}</small>
            </span>
            <span className="status-badge tone-waiting">{t('monthend.status.Submitted')}</span>
          </button>
        </li>)}
      </ul>
      : <div className="empty-state"><strong>{t('home.nothingToReview')}</strong></div>}
    <h3 className="home-heading">{t('home.tileChecks')}</h3>
    {checks.length
      ? <WorkList items={checks} user={user} t={t} language={language} onOpen={onOpenActivity} />
      : <div className="empty-state"><strong>{t('home.nothingToReview')}</strong></div>}
  </section>;
}

// A record waiting for a decision, as a card with the three things the approver
// needs -- what, how much, who asked -- and the two buttons. Used on the home
// screen and on the approvals page, instead of an eight-column table that
// became a seven-line card on a phone.
export function DecisionList({ items, onOpen, onDecide, busy, empty }) {
  const { language, t } = useI18n();
  if (!items.length) return <div className="empty-state"><strong>{empty}</strong></div>;
  return <ul className="decision-list">
    {items.map((item) => {
      const isMovement = Boolean(item.ref);
      const title = isMovement ? item.purpose : item.activity;
      const amount = isMovement
        ? `${item.currency} ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(item.estimatedTotal || 0))}`
        : formatUsdShort(item.approvedBudget === null ? item.requestedBudget : item.approvedBudget);
      return <li key={`${isMovement ? 'mov' : 'act'}-${item.id}`} className="decision-card">
        <button type="button" className="decision-card-main" onClick={() => onOpen(item)}>
          <span className="decision-card-kind">{isMovement ? t('home.kindTrip') : t('home.kindActivity')} · {operationName(item.department || item.sector, language)}</span>
          <strong>{title}</strong>
          <span className="decision-card-meta">{fill(t('home.askedBy'), { name: item.createdByName || '—' })}</span>
          <span className="decision-card-amount">{amount}</span>
        </button>
        <div className="decision-card-actions">
          <button className="primary-btn" type="button" disabled={busy} onClick={() => onDecide(item, 'approve')}>{t('approval.approve')}</button>
          <button className="danger-btn outlined" type="button" disabled={busy} onClick={() => onDecide(item, 'reject')}>{t('approval.reject')}</button>
        </div>
      </li>;
    })}
  </ul>;
}

// Work as short cards: what it is, where it is, when it is due -- and the one
// button for whatever comes next on it.
//
// The card used to show a status badge only, so the reader had to open a record
// to find out whether there was anything for them to do in it. The button comes
// from nextAction in journey.jsx, the same answer the record screen gives, so the
// two can never disagree. Starting work is done from here in one tap; anything
// that needs typing or a photo opens the record, where the form is.
export function WorkList({ items, user, t, language, onOpen, onStart, busy }) {
  return <ul className="work-list">
    {items.map((activity) => {
      const journey = activityJourney(activity);
      const step = user ? nextAction(activity, user, t) : { done: true };
      const oneTap = step.key === 'start' && onStart;
      // "Not started" where the journey would say "Approved": on a card with a
      // Start button beside it, the reader is asking how far along the work is,
      // not what happened to it in the approval system.
      const state = step.state || journeyLabel(journey, t);
      return <li key={activity.id}>
        <button type="button" className="work-card" onClick={() => onOpen(activity.id)}>
          <span className="work-card-text">
            <strong>{activity.activity}</strong>
            <small>{operationName(activity.sector, language)}
              {activity.deadline ? ` · ${fill(t('home.due'), { date: formatDay(activity.deadline, language) })}` : ''}</small>
          </span>
          <span className={`status-badge ${journeyTone(journey)}`}>{state}</span>
        </button>
        {!step.done && <div className="work-card-do">
          {oneTap
            ? <button type="button" className="primary-btn big-action" disabled={busy} onClick={() => onStart(activity)}><ActionIcon name="start" />{step.label}</button>
            : <button type="button" className="primary-btn big-action" onClick={() => onOpen(activity.id)}><ActionIcon name={STEP_ICONS[step.key]} />{step.label}</button>}
        </div>}
      </li>;
    })}
  </ul>;
}

