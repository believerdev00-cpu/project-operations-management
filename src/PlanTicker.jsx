// A manager's month, moving across the top of every page.
//
// The Director asked for the plan a manager was given to be in front of them
// all the time, sliding along the top of the screen the way a website runs its
// news: this month's objectives, how far each has got, when each is due. It
// reads the same review payload as Home, filtered the same way (the months this
// manager may work: their operation, and nobody else named on it), so the strip
// and the plan can never disagree. Pressing it opens the plan.
//
// It pauses under the finger or the mouse and while it has keyboard focus, and
// it does not move at all for somebody whose device asks for reduced motion --
// then it is a strip that can be scrolled by hand. The moving copy is drawn
// twice so the loop has no gap; screen readers hear it once.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { operationName, worksIn } from '../shared/businessOperations.js';
import { fill, useI18n } from './i18n.js';
import { objectiveState } from './Home.jsx';

function thisMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(month, language) {
  const [year, index] = month.split('-').map(Number);
  return new Date(year, index - 1, 1).toLocaleDateString(language, { month: 'long', year: 'numeric' });
}

function dayLabel(value, language) {
  const [year, month, day] = String(value || '').slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return '';
  return new Date(year, month - 1, day).toLocaleDateString(language, { day: 'numeric', month: 'short' });
}

// Pixels a second: slow enough to read a line as it passes.
const READ_SPEED = 45;

const STATE_MARK = { done: '✅', overdue: '⚠️', inProgress: '🔄', notStarted: '⏳' };

export default function PlanTicker({ user, fetchJson, reloadKey, onOpenPlan }) {
  const { language, t } = useI18n();
  const [plans, setPlans] = useState([]);
  const latest = useRef(0);
  const track = useRef(null);
  // How long one full pass takes, from how long the words are: a steady
  // reading pace (READ_SPEED pixels a second) whatever the plan holds.
  const [seconds, setSeconds] = useState(30);
  const month = thisMonth();

  useEffect(() => {
    const request = ++latest.current;
    fetchJson(`/api/monthly-plans/review?month=${month}`)
      .then((result) => {
        if (request !== latest.current) return;
        setPlans((result.operations || []).filter((plan) => worksIn(user, plan.operation)
          && (plan.managerId === null || plan.managerId === undefined || Number(plan.managerId) === Number(user.id))
          && plan.objectives?.length > 0));
      })
      // The strip is a reminder, not the plan: if it cannot load it simply
      // is not drawn, and the plan page says what went wrong.
      .catch(() => { if (request === latest.current) setPlans([]); });
  }, [fetchJson, month, reloadKey, user]);

  useLayoutEffect(() => {
    const width = track.current ? track.current.scrollWidth / 2 : 0;
    if (width > 0) setSeconds(Math.max(20, Math.round(width / READ_SPEED)));
  }, [plans, language]);

  if (!plans.length) return null;

  const items = plans.flatMap((plan) => [
    {
      key: `plan-${plan.id}`, planId: plan.id, head: true,
      text: `📅 ${monthLabel(month, language)} · ${operationName(plan.operation, language)}`
        + (plan.overallProgress !== null && plan.overallProgress !== undefined ? ` — ${fill(t('ticker.overall'), { percent: plan.overallProgress })}` : '')
    },
    ...plan.objectives.map((objective) => {
      const state = objectiveState(objective);
      const figures = objective.targetQuantity !== null && objective.targetQuantity !== undefined
        ? `: ${fill(t('plan.doneOfTarget'), { done: objective.quantityDone ?? 0, target: objective.targetQuantity, unit: objective.targetUnit || '' })}`
          + (objective.percent !== null && objective.percent !== undefined ? ` (${objective.percent}%)` : '')
        : '';
      const due = objective.deadline && state !== 'done' ? ` · ${fill(t('plan.dueOn'), { date: dayLabel(objective.deadline, language) })}` : '';
      return {
        key: `objective-${objective.id}`, planId: plan.id,
        text: `${STATE_MARK[state]} ${objective.title}${figures}${due} · ${t(`plan.objectiveState.${state}`)}`
      };
    })
  ]);
  const line = (hidden) => <ul className="plan-ticker-line" aria-hidden={hidden || undefined}>
    {items.map((item) => <li key={item.key} className={item.head ? 'plan-ticker-head' : undefined}>
      <button type="button" tabIndex={hidden ? -1 : 0} onClick={() => onOpenPlan(item.planId)}>{item.text}</button>
    </li>)}
  </ul>;

  return <section className="plan-ticker" aria-label={t('ticker.region')}>
    <button type="button" className="plan-ticker-label" onClick={() => onOpenPlan(plans[0].id)}>
      <span aria-hidden="true">📌</span> {t('nav.myPlan')}
    </button>
    <div className="plan-ticker-viewport">
      <div className="plan-ticker-track" ref={track} style={{ animationDuration: `${seconds}s` }}>
        {line(false)}
        {line(true)}
      </div>
    </div>
  </section>;
}
