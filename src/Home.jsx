import { useEffect, useRef, useState } from 'react';
import { BUSINESS_OPERATIONS, operationName } from '../shared/businessOperations.js';
import { fill, useI18n } from './i18n.js';
import { MoneyBar, activityJourney, journeyLabel, journeyTone } from './journey.jsx';

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

function todayLabel(language) {
  return new Date().toLocaleDateString(language, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export default function Home({
  user, summary, sectorRows, approvalItems, approvalCount, fetchJson, reloadKey,
  canAddActivity, canAddMovement, busy, rate,
  onGo, onAddActivity, onAddMovement, onOpenActivity, onOpenQueueItem, onDecide, onOpenPlan
}) {
  const { language, t } = useI18n();
  const isDirector = user.role === 'super-admin';
  const approves = isDirector || user.role === 'manager';
  const month = thisMonth();
  const [plans, setPlans] = useState(null);
  const [myWork, setMyWork] = useState(null);
  const [finalChecks, setFinalChecks] = useState(null);
  const latest = useRef(0);

  // Its own lists, reloaded whenever the workspace refreshes its data.
  useEffect(() => {
    const request = ++latest.current;
    Promise.allSettled([
      fetchJson(`/api/monthly-plans/review?month=${month}`),
      isDirector ? Promise.resolve([]) : fetchJson('/api/activities?awaiting=work&limit=20'),
      isDirector ? fetchJson('/api/activities?awaiting=final-check&limit=6') : Promise.resolve([])
    ]).then(([planResult, workResult, checkResult]) => {
      if (request !== latest.current) return;
      setPlans(planResult.status === 'fulfilled' ? planResult.value.operations || [] : []);
      setMyWork(workResult.status === 'fulfilled'
        ? [...workResult.value].sort((left, right) => (left.deadline || '9999-12-31').localeCompare(right.deadline || '9999-12-31'))
        : []);
      setFinalChecks(checkResult.status === 'fulfilled' ? checkResult.value : []);
    });
  }, [fetchJson, isDirector, month, reloadKey]);

  const counts = summary || {};
  const tiles = [
    approves && {
      id: 'approvals', count: approvalCount, tone: approvalCount ? 'urgent' : 'calm',
      title: t('home.tileApprovals'),
      onClick: () => onGo('approval-queue')
    },
    !isDirector && {
      id: 'work', count: counts.myOpenWork || 0, tone: counts.myOpenWork ? 'active' : 'calm',
      title: t('home.tileWork'),
      onClick: () => onGo('activities', 'work')
    },
    (isDirector || user.role === 'manager') && {
      id: 'checks', count: counts.finalChecksWaiting || 0, tone: counts.finalChecksWaiting ? 'active' : 'calm',
      title: isDirector ? t('home.tileChecks') : t('home.tileChecksManager'),
      onClick: () => onGo('activities', 'final-check')
    },
    isDirector && {
      id: 'reports', count: counts.monthEndReportsWaiting || 0, tone: counts.monthEndReportsWaiting ? 'active' : 'calm',
      title: t('home.tileMonthEnd'),
      onClick: () => onGo('monthly')
    }
  ].filter(Boolean);

  // The operations this account covers: all four for the Director or an
  // all-operations manager, otherwise the one they work in.
  const operations = BUSINESS_OPERATIONS.filter((operation) => isDirector || user.coversAllSectors || operation.id === user.sector);
  const rowFor = (id) => (sectorRows || []).find((row) => row.id === id) || {};
  const planFor = (id) => (plans || []).find((plan) => plan.operation === id);

  return <div className="home">
    <section className="home-hello">
      <div>
        <h2>{isDirector || user.coversAllSectors ? t('user.allOperations') : operationName(user.sector, language)}</h2>
        <p>{todayLabel(language)}</p>
      </div>
      {(canAddActivity || canAddMovement) && <div className="home-quick">
        {canAddActivity && <button className="primary-btn" type="button" onClick={onAddActivity}>
          {isDirector ? t('action.assignActivity') : t('action.raiseActivity')}
        </button>}
        {canAddMovement && <button className="secondary-btn" type="button" onClick={onAddMovement}>
          {t('home.newTrip')}
        </button>}
      </div>}
    </section>

    <h3 className="home-heading">{t('home.todo')}</h3>
    <div className="home-tiles">
      {tiles.map((tile) => <button key={tile.id} type="button" className={`home-tile home-tile-${tile.tone}`} onClick={tile.onClick}>
        <span className="home-tile-count">{tile.count}</span>
        <span className="home-tile-text">{tile.title}</span>
      </button>)}
    </div>

    {approves && approvalItems.length > 0 && <>
      <h3 className="home-heading">{t('home.tileApprovals')}</h3>
      <DecisionList items={approvalItems.slice(0, 3)} onOpen={onOpenQueueItem} onDecide={onDecide} busy={busy} />
      {approvalItems.length > 3 && <button className="text-btn home-more" type="button" onClick={() => onGo('approval-queue')}>
        {fill(t('home.seeAll'), { count: approvalCount })} &rarr;
      </button>}
    </>}

    {!isDirector && myWork && myWork.length > 0 && <>
      <h3 className="home-heading">{t('home.tileWork')}</h3>
      <WorkList items={myWork.slice(0, 4)} onOpen={onOpenActivity} />
    </>}

    {isDirector && finalChecks && finalChecks.length > 0 && <>
      <h3 className="home-heading">{t('home.tileChecks')}</h3>
      <WorkList items={finalChecks} onOpen={onOpenActivity} />
    </>}

    <h3 className="home-heading">{fill(t('home.thisMonth'), { month: monthLabel(month, language) })}</h3>
    <div className="home-operations">
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
    </div>
  </div>;
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

// Work as short cards: what it is, where it stands, and when it is due.
export function WorkList({ items, onOpen }) {
  const { language, t } = useI18n();
  return <ul className="work-list">
    {items.map((activity) => {
      const journey = activityJourney(activity);
      return <li key={activity.id}>
        <button type="button" className="work-card" onClick={() => onOpen(activity.id)}>
          <span className="work-card-text">
            <strong>{activity.activity}</strong>
            <small>{operationName(activity.sector, language)}{activity.deadline ? ` · ${fill(t('home.due'), { date: activity.deadline })}` : ''}</small>
          </span>
          <span className={`status-badge ${journeyTone(journey)}`}>{journeyLabel(journey, t)}</span>
        </button>
      </li>;
    })}
  </ul>;
}

