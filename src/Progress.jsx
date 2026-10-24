// How far the work has got, for the Director's Home and the Reports page.
//
// Two readings, both from the API and both calculated there, never here:
//
//  * ProjectProgress -- GET /api/reports/projects: each project's completion,
//    from the objectives of the monthly plans filed under it (the same
//    planProgress rule a month uses). When there is nothing to count, it says
//    what is missing instead of showing a number. It is work done, not money
//    spent, and the screen says so.
//  * MonthTrend -- GET /api/reports/trends: the last six months, each read by
//    the same function as the period report, so a row here and that month's
//    report always agree.
//
// Each is a short list with plain bars and the figures written beside them,
// so it reads the same without the bars (and on paper).

import { useEffect, useRef, useState } from 'react';
import { fill, useI18n } from './i18n.js';
import { formatUsd } from './format.js';
import { operationName } from '../shared/businessOperations.js';

// THE MONTH'S MONEY: exactly three cards -- Approved Budget, Actual Spent,
// Remaining Budget -- and nothing else beside them. Every figure comes from
// the server's plan payload, which sums it from the saved records
// (PLAN_TOTALS); nothing is calculated here except the sign of the remainder.
//
//  * Approved Budget is monthly_plans.approved_budget, the Director's ceiling.
//    A planned amount on an objective is never added to it.
//  * Actual Spent is every cost recorded against the month (the days' costs
//    plus the expenses on its activities), never what was planned.
//  * Remaining = Approved − Spent, shown NEGATIVE when spending has gone past
//    the budget, with a warning in words, never forced to zero.
//
// A month with no budget set (approved 0, the documented "no ceiling") has
// nothing to subtract from, so its remaining reads "No limit set" rather than
// a negative figure that would call ordinary spending an overspend.
//
// Several months together (the Director's overview, a report) pass the
// server's `remaining`, which is taken only over the months that have a
// budget, and `unbudgeted` -- spending in months with none -- which is named
// under the cards so Approved − Spent ≠ Remaining is explained, not hidden.
export function BudgetCards({ approved, spent, remaining: given = undefined, unbudgeted = 0, t }) {
  const hasBudget = Number(approved) > 0;
  const remaining = !hasBudget ? null
    : given !== undefined && given !== null ? Number(given)
      : Math.round((Number(approved) - Number(spent || 0)) * 100) / 100;
  const over = remaining !== null && remaining < 0;
  return <div className="budget-cards" role="group" aria-label={t('budget.cardsLabel')}>
    <div className="budget-card">
      <span>{t('budget.approved')}</span>
      <strong>{hasBudget ? formatUsd(approved) : t('budget.noneSet')}</strong>
      <small>{t('budget.approvedHint')}</small>
    </div>
    <div className="budget-card">
      <span>{t('budget.spent')}</span>
      <strong>{formatUsd(spent || 0)}</strong>
      <small>{t('budget.spentHint')}</small>
    </div>
    <div className={`budget-card${over ? ' budget-card-over' : ''}`}>
      <span>{t('budget.remaining')}</span>
      <strong>{remaining === null ? t('budget.noLimit') : formatUsd(remaining)}</strong>
      <small>{remaining === null ? t('budget.noLimitHint') : over ? fill(t('budget.overWarning'), { amount: formatUsd(Math.abs(remaining)) }) : t('budget.remainingHint')}</small>
    </div>
    {hasBudget && Number(unbudgeted) > 0 && <p className="field-hint budget-cards-note">{fill(t('budget.unbudgetedNote'), { amount: formatUsd(unbudgeted) })}</p>}
  </div>;
}

function useReport(fetchJson, path, reloadKey) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(0);
  useEffect(() => {
    if (!path) return;
    const request = ++latest.current;
    setError('');
    fetchJson(path)
      .then((result) => { if (request === latest.current) setData(result); })
      .catch((failure) => { if (request === latest.current) setError(failure.message); });
  }, [fetchJson, path, reloadKey, attempt]);
  return [data, error, () => setAttempt((n) => n + 1)];
}

// Loading, a failure with a way to try again, or the content: never a
// half-drawn table of zeros that reads like real figures.
function State({ data, error, retry, t, children }) {
  if (error) {
    return <div className="empty-state"><strong>{t('progress.loadFailed')}</strong>
      <span>{error}</span>
      <button type="button" className="secondary-btn" onClick={retry}>{t('progress.tryAgain')}</button></div>;
  }
  if (!data) return <div className="compact-loading"><span className="spinner" /> {t('app.loading')}</div>;
  return children;
}

function Bar({ percent, label }) {
  return <div className="progress-bar" role="img" aria-label={label}>
    <span style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
  </div>;
}

export function ProjectProgress({ fetchJson, reloadKey, query = '', compact = false }) {
  const { t, language } = useI18n();
  const [data, error, retry] = useReport(fetchJson, `/api/reports/projects${query ? `?${query}` : ''}`, reloadKey);
  return <section className="panel progress-panel">
    <div className="panel-header"><div>
      <h2>{t('progress.projectsTitle')}</h2>
      <span>{t('progress.projectsHint')}</span>
    </div></div>
    <State data={data} error={error} retry={retry} t={t}>
      {data?.projects?.length ? <ul className="progress-list">
        {data.projects.map((project) => <li key={project.id}>
          <div className="progress-row-head">
            <strong>{project.name}</strong>
            <small className="muted-cell">{operationName(project.operation, language)}</small>
            <span className="progress-figure">{project.percent === null ? '—' : `${project.percent}%`}</span>
          </div>
          {project.percent !== null
            ? <>
              <Bar percent={project.percent} label={fill(t('progress.barLabel'), { percent: project.percent })} />
              <small className="muted-cell">{fill(t('progress.projectFacts'), {
                done: project.done, countable: project.countable, plans: project.plans
              })}{project.weighted ? ` ${t('progress.weighted')}` : ''}</small>
            </>
            : <small className="progress-missing">{t(`progress.missing.${project.missing}`)}</small>}
          {/* The objectives behind the figure, folded: target, done, percent,
              in that order, with the real done figure even past 100%. */}
          {!compact && project.items.length > 0 && <details className="progress-items">
            <summary>{fill(t('progress.showObjectives'), { count: project.items.length })}</summary>
            <ul>{project.items.map((item) => <li key={item.objectiveId}>
              <span>{item.title} <small className="muted-cell">({item.planMonth})</small></span>
              <span>{item.target === null
                ? t('plan.notCounted')
                : !item.records ? t('plan.noProgressYet')
                  : `${item.done} / ${item.target} ${item.unit} · ${item.percent}%`}</span>
            </li>)}</ul>
          </details>}
        </li>)}
      </ul> : <div className="empty-state"><strong>{t('progress.noProjects')}</strong></div>}
    </State>
  </section>;
}

export function MonthTrend({ fetchJson, reloadKey, query = '' }) {
  const { t, language } = useI18n();
  const [data, error, retry] = useReport(fetchJson, `/api/reports/trends?months=6${query ? `&${query}` : ''}`, reloadKey);
  const label = (key) => {
    const [year, month] = key.split('-').map(Number);
    return new Intl.DateTimeFormat(language, { month: 'short', year: 'numeric' }).format(new Date(year, month - 1, 1));
  };
  return <section className="panel progress-panel">
    <div className="panel-header"><div>
      <h2>{t('progress.trendTitle')}</h2>
      <span>{t('progress.trendHint')}</span>
    </div></div>
    <State data={data} error={error} retry={retry} t={t}>
      {data?.months?.some((m) => m.plans > 0) ? <div className="table-wrap"><table className="card-table progress-trend">
        <thead><tr>
          <th>{t('monthly.month')}</th><th>{t('progress.workDone')}</th>
          <th>{t('budget.approved')}</th><th>{t('budget.spent')}</th><th>{t('budget.remaining')}</th>
        </tr></thead>
        <tbody>{data.months.map((m) => <tr key={m.month}>
          <td className="card-title-cell"><strong>{label(m.month)}</strong></td>
          <td data-label={t('progress.workDone')}>{!m.plans
            ? <span className="muted-cell">{t('progress.noPlan')}</span>
            : m.percent === null ? <span className="muted-cell">{t('plan.notCounted')}</span>
              : <span className="trend-cell"><Bar percent={m.percent} label={fill(t('progress.barLabel'), { percent: m.percent })} /> {m.percent}%</span>}</td>
          <td data-label={t('budget.approved')}>{m.plans ? (m.approved > 0 ? formatUsd(m.approved) : t('budget.noneSet')) : '—'}</td>
          <td data-label={t('budget.spent')}>{m.plans ? formatUsd(m.spent) : '—'}</td>
          <td data-label={t('budget.remaining')}>{!m.plans || m.remaining === null ? '—'
            : <span className={m.remaining < 0 ? 'over-budget' : undefined}>{formatUsd(m.remaining)}{m.remaining < 0 ? ` (${t('progress.over')})` : ''}</span>}</td>
        </tr>)}</tbody>
      </table></div> : <div className="empty-state"><strong>{t('progress.noHistory')}</strong></div>}
    </State>
  </section>;
}
