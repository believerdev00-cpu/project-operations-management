// Farming Management: the farm's workspace, at #/farming/<tab>.
//
// One module, one page, with a tab per job: Today (what the farm needs and how
// it is doing), Record (production, herd changes, sales), Expenses (submit,
// approve), Problems, Reports, Set-up (animal types, budget, alerts) and
// History. Which tabs a person gets comes from the role the API answers in
// /overview, never from the browser's guess, and every button is re-checked by
// the route it calls.
//
// FOR PEOPLE WHO READ LITTLE AND HAVE LITTLE TIME. A team member's day is one
// tab: pick the animal, pick what you are recording, type the number. The
// animal types and what they are measured by are the farm's own data, so the
// buttons are whatever the Farming Manager set up -- a fourth animal appears
// here the moment it is added. A form remembers what was typed if the page is
// closed half-way (useDraft), refusals are shown in the reader's language
// (farm.err.<CODE>, from FARM_ERROR_CODES), and nothing here counts a day
// nobody recorded as zero.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fill, useI18n } from './i18n.js';
import { useBusy, useDialog } from './ui.jsx';
import { formatDate, formatUsd, todayLocal } from './format.js';
import {
  FARM_CURRENCIES, addDays, FARM_ERROR_CODES, FARM_EXPENSE_CATEGORIES, FARM_PERIODS, HERD_EVENT_KINDS, ISSUE_KINDS, SHARED_SCOPE,
  THRESHOLD_LIMITS, selectableTypes, validateExpense, validateHerdEvent, validateIssue, validateProduction, validateSale
} from '../shared/farming.js';

const TABS = {
  director: ['today', 'record', 'expenses', 'problems', 'reports', 'setup', 'history'],
  manager: ['today', 'record', 'expenses', 'problems', 'reports', 'setup', 'history'],
  reader: ['today', 'expenses', 'problems', 'reports', 'history'],
  staff: ['today', 'record', 'expenses', 'problems']
};

const EXPENSE_TONE = { pending: 'waiting', approved: 'done', rejected: 'stopped', voided: 'stopped' };
// The herd changes a person records by hand; a sale of animals is recorded on
// the sales form so its money goes with it.
const HERD_FORM_KINDS = HERD_EVENT_KINDS.filter((kind) => kind !== 'sale');

const amountText = (amount, currency) => `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(amount || 0))} ${currency}`;
const quantityText = (value, unit) => (value === null || value === undefined ? '—' : `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)} ${unit || ''}`.trim());

function newRequestKey() {
  try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID(); } catch { /* fall through */ }
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

// A refusal in the reader's words when the farm has words for it, else the
// server's own message.
function errorText(error, t) {
  const code = error?.payload?.code || error?.code;
  return code && FARM_ERROR_CODES.includes(code) ? t(`farm.err.${code}`) : error?.message;
}
const codeText = (code, t) => (FARM_ERROR_CODES.includes(code) ? t(`farm.err.${code}`) : code);

// What a form holds, kept in this browser until it is sent: a phone that
// locks, a page closed by mistake, a call in the middle of typing -- the
// figures are still there. Per account, and never trusted to exist.
function useDraft(key, initial) {
  const first = useRef(initial);
  const [value, setValue] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved ? { ...first.current, ...JSON.parse(saved) } : first.current;
    } catch { return first.current; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage may be unavailable */ }
  }, [key, value]);
  const clear = useCallback(() => {
    try { localStorage.removeItem(key); } catch { /* nothing to clear */ }
    setValue(first.current);
  }, [key]);
  return [value, setValue, clear];
}

function useLoad(fetchJson, path, onError) {
  const [data, setData] = useState(null);
  const latest = useRef(0);
  const reload = useCallback(async () => {
    if (!path) return;
    const n = ++latest.current;
    try {
      const result = await fetchJson(path);
      if (n === latest.current) setData(result);
    } catch (error) {
      if (n === latest.current) onError?.(error.message);
    }
  }, [fetchJson, path, onError]);
  useEffect(() => { reload(); }, [reload]);
  return [data, reload];
}

function Panel({ title, subtitle, children }) {
  return <section className="panel">
    <div className="panel-header"><div><h2>{title}</h2>{subtitle && <span>{subtitle}</span>}</div></div>
    {children}
  </section>;
}
function Field({ label, children, wide }) {
  return <label className={wide ? 'form-field form-field-wide' : 'form-field'}><span>{label}</span>{children}</label>;
}
function Metric({ label, value, tone }) {
  return <div className={`metric-card${tone ? ` farm-metric-${tone}` : ''}`}><span>{label}</span><strong>{value}</strong></div>;
}
function Empty({ children }) { return <div className="empty-state"><strong>{children}</strong></div>; }
function Badge({ tone, children }) { return <span className={`status-badge tone-${tone}`}>{children}</span>; }

export default function Farming({ user, fetchJson, onMessage, onError, onChanged, tab, onNavigate }) {
  const { t } = useI18n();
  const today = todayLocal();
  const [range, setRange] = useState({ from: `${today.slice(0, 7)}-01`, to: today });
  const overviewPath = `/api/farming/overview?from=${range.from}&to=${range.to}`;
  const [overview, reloadOverview] = useLoad(fetchJson, overviewPath, onError);
  const role = overview?.role;
  const tabs = role ? TABS[role] : [];
  const active = tabs.includes(tab) ? tab : 'today';
  const changed = useCallback(() => { reloadOverview(); onChanged?.(); }, [reloadOverview, onChanged]);

  if (!overview) return <div className="loading-state"><span className="spinner" />{t('app.loading')}</div>;
  const can = { manage: role === 'director' || role === 'manager', record: role !== 'reader', money: role !== 'staff', director: role === 'director', role };
  const catalogue = { types: overview.types, measures: overview.measures };
  const common = { fetchJson, onMessage, onError, changed, can, catalogue, overview, user };
  const pending = overview.pendingExpenses?.count || 0;

  return <div className="farming">
    <section className="welcome-strip">
      <div>
        <span className="eyebrow">{t('farm.eyebrow')}</span>
        <h2>{t('farm.title')}</h2>
        <p>{t(can.money ? 'farm.blurb' : 'farm.blurbStaff')}</p>
      </div>
    </section>
    <nav className="partner-tabs" aria-label={t('farm.title')}>
      {tabs.map((id) => <button key={id} type="button" className={`partner-tab${active === id ? ' active' : ''}`} onClick={() => onNavigate(id)}>
        {t(`farm.tab.${id}`)}{id === 'expenses' && can.manage && pending > 0 && <span className="nav-badge">{pending}</span>}
      </button>)}
    </nav>
    {active === 'today' && <TodayTab {...common} range={range} setRange={setRange} go={onNavigate} />}
    {active === 'record' && <RecordTab {...common} />}
    {active === 'expenses' && <ExpensesTab {...common} />}
    {active === 'problems' && <ProblemsTab {...common} />}
    {active === 'reports' && <ReportsTab {...common} />}
    {active === 'setup' && <SetupTab {...common} />}
    {active === 'history' && <HistoryTab {...common} />}
  </div>;
}

// ---- today -----------------------------------------------------------------------

// "What does the farm need, and how is it going?" First anything urgent, then
// today's work and today's figures, then the period's results.
function TodayTab({ overview, can, catalogue, range, setRange, go }) {
  const { t, language } = useI18n();
  const typeName = (id) => catalogue.types.find((type) => type.id === id)?.name || '';
  const measureOf = (id) => catalogue.measures.find((measure) => measure.id === id) || {};
  const urgentIssues = overview.issues.filter((issue) => issue.urgent);
  const summary = overview.summary || { animalTypes: [] };
  const farm = summary.farm;

  return <>
    {can.money && overview.alerts?.length > 0 && <Panel title={t('farm.alerts')} subtitle={t('farm.alertsHint')}>
      <ul className="farm-alerts">
        {overview.alerts.map((alert) => <li key={alert.key} className={alert.severity === 'urgent' ? 'farm-alert urgent' : 'farm-alert'}>
          <strong>{t(`farm.alert.${alert.kind}`)}</strong>
          <span>{fill(t(`farm.alertWhy.${alert.kind}`), alertParams(alert, measureOf, typeName, t, language))}</span>
        </li>)}
      </ul>
    </Panel>}

    {urgentIssues.length > 0 && <Panel title={t('farm.urgentProblems')}>
      <ul className="farm-list">{urgentIssues.map((issue) => <li key={issue.id}><Badge tone="stopped">{t(`farm.issueKind.${issue.kind}`)}</Badge> {issue.description}</li>)}</ul>
    </Panel>}

    {can.manage && overview.pendingExpenses?.count > 0 && <section className="panel farm-callout">
      <span>{fill(t('farm.expensesWaiting'), { count: overview.pendingExpenses.count, amount: formatUsd(overview.pendingExpenses.usd) })}</span>
      <button className="primary-btn" type="button" onClick={() => go('expenses')}>{t('farm.reviewExpenses')}</button>
    </section>}

    <Panel title={t('farm.todaysWork')}>
      {overview.tasks.overdue.length + overview.tasks.today.length === 0
        ? <Empty>{t('farm.noTasks')}</Empty>
        : <ul className="farm-list">
          {[...overview.tasks.overdue, ...overview.tasks.today].map((task) => <li key={task.id}>
            {task.dueOn < overview.today ? <Badge tone="waiting">{t('farm.taskLate')}</Badge> : <Badge tone="active">{t('farm.taskToday')}</Badge>}
            {' '}{task.title}{task.assignedName && can.money ? ` — ${task.assignedName}` : ''}
          </li>)}
        </ul>}
    </Panel>

    <Panel title={t('farm.todaysProduction')} subtitle={formatDate(overview.today, language)}>
      <div className="metric-grid">
        {overview.todayProduction.filter((line) => measureOf(line.measureId).active).map((line) => {
          const measure = measureOf(line.measureId);
          return <Metric key={line.measureId} label={`${typeName(measure.animalTypeId)} · ${measure.name}`}
            value={line.produced === null ? t('farm.notRecordedYet') : quantityText(line.produced, measure.unit)} tone={line.produced === null ? 'quiet' : null} />;
        })}
        {can.money && <Metric label={t('farm.todaysSpending')} value={formatUsd(overview.todayExpenses?.approved || 0)} />}
      </div>
    </Panel>

    <Panel title={t('farm.onHand')}>
      <div className="metric-grid">
        {overview.stock.filter((line) => measureOf(line.measureId).active).map((line) => {
          const measure = measureOf(line.measureId);
          return <Metric key={`s${line.measureId}`} label={`${typeName(measure.animalTypeId)} · ${measure.name}`} value={quantityText(line.onHand, measure.unit)} />;
        })}
        {overview.herd.filter((line) => measureOf(line.measureId).active).map((line) => {
          const measure = measureOf(line.measureId);
          return <Metric key={`h${line.measureId}`} label={`${typeName(measure.animalTypeId)} · ${measure.name}`}
            value={line.head === null ? t('farm.notCountedYet') : quantityText(line.head, measure.unit)} tone={line.head === null ? 'quiet' : null} />;
        })}
      </div>
    </Panel>

    <Panel title={t('farm.period')}>
      <div className="form-grid">
        <Field label={t('farm.from')}><input type="date" value={range.from} max={range.to} onChange={(event) => setRange({ ...range, from: event.target.value })} /></Field>
        <Field label={t('farm.to')}><input type="date" value={range.to} min={range.from} onChange={(event) => setRange({ ...range, to: event.target.value })} /></Field>
      </div>
      {farm && <>
        <div className="metric-grid">
          <Metric label={t('farm.revenue')} value={formatUsd(farm.revenueUsd)} />
          <Metric label={t('farm.expenses')} value={formatUsd(farm.expensesUsd)} />
          <Metric label={t('farm.operatingResult')} value={formatUsd(farm.operatingResultUsd)} tone={farm.operatingResultUsd < 0 ? 'bad' : null} />
          {farm.budget ? <Metric label={t('farm.budgetLeft')} value={formatUsd(farm.budget.remainingUsd)} tone={farm.budget.over ? 'bad' : null} />
            : <Metric label={t('farm.budget')} value={t('farm.noBudget')} tone="quiet" />}
        </div>
        <p className="muted">{t('farm.operatingResultHint')}</p>
      </>}
      <TypeTable summary={summary} catalogue={catalogue} money={can.money} />
      {farm && farm.expensesByCategory.length > 0 && <>
        <h3>{t('farm.byCategory')}</h3>
        <ul className="farm-bars">
          {farm.expensesByCategory.map((line) => <li key={line.category}>
            <span>{categoryName(line.category, t)}</span>
            <span className="farm-bar"><span style={{ width: `${Math.max(2, (line.amountUsd / farm.expensesByCategory[0].amountUsd) * 100)}%` }} /></span>
            <strong>{formatUsd(line.amountUsd)}</strong>
          </li>)}
        </ul>
      </>}
    </Panel>

    {overview.trend.some((line) => line.points.length) && <Panel title={t('farm.trend')} subtitle={t('farm.trendHint')}>
      {overview.trend.filter((line) => line.points.length).map((line) => {
        const measure = measureOf(line.measureId);
        const peak = Math.max(...line.points.map((point) => point.produced), 1);
        const byDay = new Map(line.points.map((point) => [point.period, point]));
        // One slot per day of the 30, so a day nobody recorded is a visible
        // gap -- not a bar that silently disappears and closes up the line.
        const days = Array.from({ length: 30 }, (_, index) => addDays(overview.today, index - 29));
        return <div key={line.measureId} className="farm-trend">
          <span>{typeName(measure.animalTypeId)} · {measure.name} ({measure.unit})</span>
          <div className="farm-spark" role="img" aria-label={`${measure.name}`}>
            {days.map((day) => {
              const point = byDay.get(day);
              return point
                ? <span key={day} title={`${formatDate(day, language)}: ${quantityText(point.produced, measure.unit)}`} style={{ height: `${Math.max(4, (point.produced / peak) * 100)}%` }} />
                : <span key={day} className="farm-spark-gap" title={`${formatDate(day, language)}: ${t('farm.noRecord')}`} />;
            })}
          </div>
        </div>;
      })}
    </Panel>}
  </>;
}

function alertParams(alert, measureOf, typeName, t, language) {
  const params = alert.params || {};
  const measure = params.measureId ? measureOf(params.measureId) : null;
  return {
    ...params,
    product: measure ? `${typeName(measure.animalTypeId)} · ${measure.name}` : '',
    animal: params.animalTypeId ? typeName(params.animalTypeId) : '',
    unit: measure?.unit || '',
    category: params.category ? categoryName(params.category, t) : '',
    date: params.date ? formatDate(params.date, language) : '',
    lastRecorded: params.lastRecorded ? formatDate(params.lastRecorded, language) : '',
    dueOn: params.dueOn ? formatDate(params.dueOn, language) : '',
    amount: params.amountUsd !== undefined ? formatUsd(params.amountUsd) : '',
    usual: params.usualUsd !== undefined ? formatUsd(params.usualUsd) : '',
    budget: params.budgetUsd !== undefined ? formatUsd(params.budgetUsd) : '',
    spent: params.spentUsd !== undefined ? formatUsd(params.spentUsd) : '',
    change: params.changePercent !== undefined ? Math.abs(params.changePercent) : '',
    rise: params.risePercent ?? '',
    percent: params.percentUsed ?? ''
  };
}

// Only what happened: "+3 born, −1 died (head)", never "+0 bought, −0 sold".
function herdText(herd, unit, t) {
  const parts = [
    herd.births && fill(t('farm.herdBorn'), { count: herd.births }),
    herd.purchases && fill(t('farm.herdBought'), { count: herd.purchases }),
    herd.deaths && fill(t('farm.herdDied'), { count: herd.deaths }),
    herd.sales && fill(t('farm.herdSold'), { count: herd.sales }),
    herd.otherChange && fill(t('farm.herdOther'), { count: herd.otherChange > 0 ? `+${herd.otherChange}` : `−${Math.abs(herd.otherChange)}` })
  ].filter(Boolean);
  return parts.length ? `${parts.join(', ')}${unit ? ` (${unit})` : ''}` : t('farm.herdNoChange');
}

function categoryName(category, t) {
  return FARM_EXPENSE_CATEGORIES.includes(category) ? t(`farm.cat.${category}`) : category;
}

// One row per animal type, and the farm's combined row last. Per type the
// money is DIRECT -- its own costs only; shared costs are in the farm's row.
function TypeTable({ summary, catalogue, money }) {
  const { t } = useI18n();
  const rows = summary.animalTypes.filter((line) => line.products.length || line.herd.length || line.revenueUsd || line.directExpensesUsd);
  if (!rows.length) return <Empty>{t('farm.nothingRecorded')}</Empty>;
  const typeName = (id) => catalogue.types.find((type) => type.id === id)?.name || '';
  const measureOf = (id) => catalogue.measures.find((measure) => measure.id === id) || {};
  return <div className="table-wrap"><table className="card-table">
    <thead><tr>
      <th>{t('farm.animalType')}</th><th>{t('farm.produced')}</th><th>{t('farm.sold')}</th><th>{t('farm.lost')}</th><th>{t('farm.herdChange')}</th>
      {money && <><th>{t('farm.revenue')}</th><th>{t('farm.directCosts')}</th><th>{t('farm.directResult')}</th><th>{t('farm.unitCost')}</th></>}
    </tr></thead>
    <tbody>{rows.map((line) => <tr key={line.animalTypeId}>
      <td className="card-title-cell" data-label={t('farm.animalType')}>{typeName(line.animalTypeId)}</td>
      <td data-label={t('farm.produced')}>{line.products.map((product) => <div key={product.measureId}>
        {quantityText(product.produced, product.unit)}{product.daysWithoutRecord ? <small className="muted"> · {fill(t('farm.daysMissing'), { count: product.daysWithoutRecord })}</small> : null}
      </div>)}</td>
      <td data-label={t('farm.sold')}>{line.products.map((product) => <div key={product.measureId}>{quantityText(product.sold, product.unit)}</div>)}</td>
      <td data-label={t('farm.lost')}>{line.products.map((product) => <div key={product.measureId}>{quantityText(product.lost, product.unit)}</div>)}</td>
      <td data-label={t('farm.herdChange')}>{line.herd.map((herd) => <div key={herd.measureId}>{herdText(herd, measureOf(herd.measureId).unit, t)}</div>)}</td>
      {money && <>
        <td data-label={t('farm.revenue')}>{formatUsd(line.revenueUsd)}</td>
        <td data-label={t('farm.directCosts')}>{formatUsd(line.directExpensesUsd)}</td>
        <td data-label={t('farm.directResult')}>{formatUsd(line.directResultUsd)}</td>
        <td data-label={t('farm.unitCost')}>{line.unitCost?.available
          ? <>{fill(t('farm.perUnit'), { amount: `$${line.unitCost.usdPerUnit}`, unit: line.unitCost.unit })}{line.unitCost.estimate && <small className="muted"> · {t('farm.estimateNoShared')}</small>}</>
          : <small className="muted">{t(`farm.noUnitCost.${line.unitCost?.reason || 'NO_PRODUCTION'}`)}</small>}</td>
      </>}
    </tr>)}</tbody>
  </table></div>;
}

// ---- record -----------------------------------------------------------------------

// Pick the animal, pick what you are recording, type the number.
function RecordTab({ fetchJson, onMessage, onError, changed, can, catalogue, user }) {
  const { t } = useI18n();
  const types = selectableTypes(catalogue.types);
  const [typeId, setTypeId] = useState(types[0]?.id || null);
  const measures = catalogue.measures.filter((measure) => measure.animalTypeId === typeId && measure.active);
  const [measureId, setMeasureId] = useState(null);
  const measure = measures.find((item) => item.id === measureId) || measures[0] || null;
  const [mode, setMode] = useState('production');
  const type = catalogue.types.find((item) => item.id === typeId);

  useEffect(() => { setMeasureId(null); }, [typeId]);
  useEffect(() => { setMode(measure?.kind === 'herd' ? 'herd' : 'production'); }, [measure?.id, measure?.kind]);

  if (!types.length) return <Empty>{t('farm.noTypes')}</Empty>;
  const modes = measure?.kind === 'herd' ? ['herd', 'sale'] : (measure?.sellable ? ['production', 'sale'] : ['production']);
  const shared = { fetchJson, onMessage, onError, changed, type, measure, user };

  return <>
    <Panel title={t('farm.whichAnimal')}>
      <div className="farm-choices">
        {types.map((item) => <button key={item.id} type="button" className={`big-action ${item.id === typeId ? 'primary-btn' : 'secondary-btn'}`} onClick={() => setTypeId(item.id)}>{item.name}</button>)}
      </div>
      {measures.length === 0 ? <Empty>{t('farm.noMeasures')}</Empty> : <>
        <h3>{t('farm.whatRecording')}</h3>
        <div className="farm-choices">
          {measures.map((item) => <button key={item.id} type="button" className={`big-action ${item.id === measure?.id ? 'primary-btn' : 'secondary-btn'}`} onClick={() => setMeasureId(item.id)}>{item.name} ({item.unit})</button>)}
        </div>
        {modes.length > 1 && <div className="farm-choices">
          {modes.map((item) => <button key={item} type="button" className={item === mode ? 'primary-btn' : 'secondary-btn'} onClick={() => setMode(item)}>{t(`farm.mode.${item}`)}</button>)}
        </div>}
      </>}
    </Panel>
    {measure && mode === 'production' && <ProductionForm key={`p${measure.id}`} {...shared} />}
    {measure && mode === 'herd' && <HerdForm key={`h${measure.id}`} {...shared} />}
    {measure && mode === 'sale' && <SaleForm key={`s${measure.id}`} {...shared} />}
    {measure && <RecentRecords key={`r${measure.id}-${mode}`} {...shared} mode={mode} can={can} />}
  </>;
}

// Send, and when the API answers "this may be a duplicate", show what is
// already there and send again only if the person says so.
function useSubmit({ fetchJson, onMessage, onError, changed }) {
  const { t, language } = useI18n();
  const dialog = useDialog();
  const [, run] = useBusy();
  return useCallback((path, body, done, describe) => run(async () => {
    const send = (extra) => fetchJson(path, { method: 'POST', body: JSON.stringify({ ...body, ...extra }) });
    try {
      await send({});
    } catch (error) {
      if (error?.payload?.code !== 'POSSIBLE_DUPLICATE') { onError(errorText(error, t)); return false; }
      const lines = (error.payload.matches || []).map((match) => `${formatDate(match.date, language)} — ${describe(match)}`).join('\n');
      const again = await dialog.confirm({ title: t('farm.maybeDuplicate'), message: `${t('farm.maybeDuplicateHint')}\n${lines}`, confirmLabel: t('farm.recordAnyway') });
      if (!again) return false;
      try { await send({ confirmDuplicate: true }); } catch (second) { onError(errorText(second, t)); return false; }
    }
    onMessage(t('farm.saved'));
    done();
    changed();
    return true;
  }), [run, fetchJson, onMessage, onError, changed, dialog, t, language]);
}

function ProductionForm({ fetchJson, onMessage, onError, changed, type, measure, user }) {
  const { t } = useI18n();
  const [form, setForm, clear] = useDraft(`farm-draft:${user.id}:production:${measure.id}`, { date: todayLocal(), produced: '', lost: '', notes: '', key: newRequestKey() });
  const [problem, setProblem] = useState('');
  const submit = useSubmit({ fetchJson, onMessage, onError, changed });
  const save = (event) => {
    event.preventDefault();
    const check = validateProduction(form, { type, measure, today: todayLocal() });
    // The stock check needs the history and is the API's; everything else is
    // refused here first, in the reader's words.
    const errors = check.errors.filter((code) => code !== 'MORE_OUT_THAN_AVAILABLE');
    if (errors.length) { setProblem(codeText(errors[0], t)); return; }
    setProblem('');
    submit('/api/farming/production', { measureId: measure.id, date: form.date, produced: form.produced, lost: form.lost, notes: form.notes, requestKey: form.key },
      clear, (match) => `${quantityText(match.produced, measure.unit)}${match.recordedByName ? ` (${match.recordedByName})` : ''}`);
  };
  return <Panel title={fill(t('farm.recordProduction'), { what: measure.name })}>
    <form className="form-grid" onSubmit={save}>
      <Field label={t('farm.date')}><input type="date" value={form.date} max={todayLocal()} onChange={(event) => setForm({ ...form, date: event.target.value })} required /></Field>
      <Field label={fill(t('farm.producedIn'), { unit: measure.unit })}><input type="number" inputMode="decimal" min="0" step="any" value={form.produced} onChange={(event) => setForm({ ...form, produced: event.target.value })} required /></Field>
      <Field label={fill(t('farm.lostIn'), { unit: measure.unit })}><input type="number" inputMode="decimal" min="0" step="any" value={form.lost} placeholder="0" onChange={(event) => setForm({ ...form, lost: event.target.value })} /></Field>
      <Field label={t('farm.notes')} wide><textarea rows={2} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder={t('farm.notesHint')} /></Field>
      {problem && <p className="form-error form-field-wide" role="alert">{problem}</p>}
      <div className="form-actions form-field-wide"><button className="primary-btn big-action" type="submit">{t('farm.save')}</button></div>
    </form>
    {measure.sellable && <p className="muted">{t('farm.soldSeparately')}</p>}
  </Panel>;
}

function HerdForm({ fetchJson, onMessage, onError, changed, type, measure, user }) {
  const { t } = useI18n();
  const [form, setForm, clear] = useDraft(`farm-draft:${user.id}:herd:${measure.id}`, { date: todayLocal(), kind: 'birth', count: '', reason: '', key: newRequestKey() });
  const [problem, setProblem] = useState('');
  const submit = useSubmit({ fetchJson, onMessage, onError, changed });
  const save = (event) => {
    event.preventDefault();
    const check = validateHerdEvent({ ...form, count: form.count === '' ? '' : Number(form.count) }, { type, measure, today: todayLocal(), headCount: Number.MAX_SAFE_INTEGER });
    if (check.errors.length) { setProblem(codeText(check.errors[0], t)); return; }
    setProblem('');
    submit('/api/farming/herd', { measureId: measure.id, date: form.date, kind: form.kind, count: Number(form.count), reason: form.reason, requestKey: form.key }, clear, () => '');
  };
  return <Panel title={fill(t('farm.recordHerd'), { what: measure.name })}>
    <form className="form-grid" onSubmit={save}>
      <Field label={t('farm.date')}><input type="date" value={form.date} max={todayLocal()} onChange={(event) => setForm({ ...form, date: event.target.value })} required /></Field>
      <Field label={t('farm.whatHappened')}>
        <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}>
          {HERD_FORM_KINDS.map((kind) => <option key={kind} value={kind}>{t(`farm.herdKind.${kind}`)}</option>)}
        </select>
      </Field>
      <Field label={fill(t(form.kind === 'count' ? 'farm.countedIn' : 'farm.howMany'), { unit: measure.unit })}><input type="number" inputMode="numeric" min="0" step="1" value={form.count} onChange={(event) => setForm({ ...form, count: event.target.value })} required /></Field>
      <Field label={t(form.kind === 'death' ? 'farm.causeRequired' : 'farm.notes')} wide><textarea rows={2} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} required={form.kind === 'death'} /></Field>
      {problem && <p className="form-error form-field-wide" role="alert">{problem}</p>}
      <div className="form-actions form-field-wide"><button className="primary-btn big-action" type="submit">{t('farm.save')}</button></div>
    </form>
  </Panel>;
}

function SaleForm({ fetchJson, onMessage, onError, changed, type, measure, user }) {
  const { t } = useI18n();
  const [form, setForm, clear] = useDraft(`farm-draft:${user.id}:sale:${measure.id}`, { date: todayLocal(), quantity: '', amount: '', currency: 'RWF', buyer: '', key: newRequestKey() });
  const [problem, setProblem] = useState('');
  const submit = useSubmit({ fetchJson, onMessage, onError, changed });
  const save = (event) => {
    event.preventDefault();
    const check = validateSale({ ...form, quantity: form.quantity === '' ? '' : Number(form.quantity), amount: form.amount === '' ? '' : Number(form.amount) }, { type, measure, today: todayLocal() });
    if (check.errors.length) { setProblem(codeText(check.errors[0], t)); return; }
    setProblem('');
    submit('/api/farming/sales', { measureId: measure.id, date: form.date, quantity: Number(form.quantity), amount: Number(form.amount), currency: form.currency, buyer: form.buyer, requestKey: form.key }, clear, () => '');
  };
  return <Panel title={fill(t('farm.recordSale'), { what: measure.name })}>
    <form className="form-grid" onSubmit={save}>
      <Field label={t('farm.date')}><input type="date" value={form.date} max={todayLocal()} onChange={(event) => setForm({ ...form, date: event.target.value })} required /></Field>
      <Field label={fill(t('farm.quantityIn'), { unit: measure.unit })}><input type="number" inputMode="decimal" min="0" step={measure.kind === 'herd' ? '1' : 'any'} value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} required /></Field>
      <Field label={t('farm.moneyReceived')}><input type="number" inputMode="decimal" min="0" step="any" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} required /></Field>
      <Field label={t('farm.currency')}>
        <select value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })}>{FARM_CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}</select>
      </Field>
      <Field label={t('farm.buyer')} wide><input value={form.buyer} maxLength={120} onChange={(event) => setForm({ ...form, buyer: event.target.value })} /></Field>
      {problem && <p className="form-error form-field-wide" role="alert">{problem}</p>}
      <div className="form-actions form-field-wide"><button className="primary-btn big-action" type="submit">{t('farm.save')}</button></div>
    </form>
  </Panel>;
}

// The latest records for this product or herd, with the correction and void
// each person may make: the recorder corrects their own with a reason, the
// manager corrects or voids any.
function RecentRecords({ fetchJson, onMessage, onError, changed, measure, mode, can, user }) {
  const { t, language } = useI18n();
  const dialog = useDialog();
  const [busy, run] = useBusy();
  const path = mode === 'production' ? 'production' : mode === 'sale' ? 'sales' : 'herd';
  const [rows, reload] = useLoad(fetchJson, `/api/farming/${path}?measure=${measure.id}&limit=10`, onError);
  const refresh = () => { reload(); changed(); };

  const ask = (title) => dialog.prompt({ title, label: t('farm.reason'), message: t('farm.reasonHint'), required: true, minLength: 10, multiline: true });
  const correct = (row) => run(async () => {
    const figure = await dialog.prompt({
      title: t('farm.correct'),
      label: fill(t(path === 'production' ? 'farm.producedIn' : 'farm.quantityIn'), { unit: measure.unit }),
      initialValue: String(path === 'production' ? row.produced : row.quantity),
      required: true
    });
    if (figure === null) return false;
    const reason = await ask(t('farm.correct'));
    if (!reason) return false;
    try {
      await fetchJson(`/api/farming/${path}/${row.id}`, { method: 'PUT', body: JSON.stringify(path === 'production' ? { produced: Number(figure), reason } : { quantity: Number(figure), reason }) });
      onMessage(t('farm.saved'));
      refresh();
      return true;
    } catch (error) { onError(errorText(error, t)); return false; }
  });
  const voidRow = (row) => run(async () => {
    const reason = await ask(t('farm.void'));
    if (!reason) return false;
    try {
      await fetchJson(`/api/farming/${path}/${row.id}/void`, { method: 'POST', body: JSON.stringify({ reason }) });
      onMessage(t('farm.voided'));
      refresh();
      return true;
    } catch (error) { onError(errorText(error, t)); return false; }
  });

  if (!rows) return null;
  return <Panel title={t('farm.recent')}>
    {rows.length === 0 ? <Empty>{t('farm.nothingYet')}</Empty> : <ul className="farm-list">
      {rows.map((row) => {
        const mine = Number(row.recordedBy) === Number(user.id);
        const live = row.status === 'recorded';
        return <li key={row.id} className={live ? '' : 'farm-voided'}>
          <span>{formatDate(row.date, language)} · {path === 'production'
            ? `${quantityText(row.produced, measure.unit)}${row.lost ? ` (${fill(t('farm.lostShort'), { amount: quantityText(row.lost, measure.unit) })})` : ''}`
            : path === 'sales' ? `${quantityText(row.quantity, measure.unit)}${row.amount !== null ? ` · ${amountText(row.amount, row.currency)}` : ''}`
              : `${t(`farm.herdKind.${row.kind}`)} · ${quantityText(row.count, measure.unit)}${row.reason ? ` — ${row.reason}` : ''}`}
          {row.recordedByName ? ` · ${row.recordedByName}` : ''}{!live && ` · ${t('farm.voidedLabel')}: ${row.voidReason}`}</span>
          {live && <span className="row-actions">
            {path !== 'herd' && (can.manage || mine) && <button className="text-btn" type="button" disabled={busy} onClick={() => correct(row)}>{t('farm.correct')}</button>}
            {can.manage && !(path === 'herd' && row.saleId) && <button className="text-btn" type="button" disabled={busy} onClick={() => voidRow(row)}>{t('farm.void')}</button>}
          </span>}
        </li>;
      })}
    </ul>}
  </Panel>;
}

// ---- expenses ----------------------------------------------------------------------

function ExpensesTab({ fetchJson, onMessage, onError, changed, can, catalogue, user }) {
  const { t, language } = useI18n();
  const dialog = useDialog();
  const [busy, run] = useBusy();
  const [status, setStatus] = useState(can.manage ? 'pending' : '');
  const [list, reload] = useLoad(fetchJson, `/api/farming/expenses?limit=200${status ? `&status=${status}` : ''}`, onError);
  const typeName = (id) => (id === null ? t('farm.shared') : catalogue.types.find((type) => type.id === id)?.name || '');
  const refresh = () => { reload(); changed(); };

  const decide = (expense, approve) => run(async () => {
    const note = approve ? '' : await dialog.prompt({ title: t('farm.refuse'), label: t('farm.reason'), message: t('farm.refuseHint'), required: true, minLength: 10, multiline: true });
    if (note === null) return false;
    try {
      await fetchJson(`/api/farming/expenses/${expense.id}/decision`, { method: 'POST', body: JSON.stringify({ approve, note }) });
      onMessage(t(approve ? 'farm.approvedDone' : 'farm.refusedDone'));
      refresh();
      return true;
    } catch (error) { onError(errorText(error, t)); return false; }
  });
  const voidExpense = (expense) => run(async () => {
    const reason = await dialog.prompt({ title: t('farm.void'), label: t('farm.reason'), message: t('farm.voidExpenseHint'), required: true, minLength: 10, multiline: true });
    if (!reason) return false;
    try {
      await fetchJson(`/api/farming/expenses/${expense.id}/void`, { method: 'POST', body: JSON.stringify({ reason }) });
      onMessage(t('farm.voided'));
      refresh();
      return true;
    } catch (error) { onError(errorText(error, t)); return false; }
  });

  return <>
    {can.record && <ExpenseForm fetchJson={fetchJson} onMessage={onMessage} onError={onError} changed={refresh} catalogue={catalogue} user={user} approvesOwn={can.manage} />}
    <Panel title={t(can.money ? 'farm.expenseList' : 'farm.myExpenses')}>
      <div className="farm-choices">
        {['', 'pending', 'approved', 'rejected', 'voided'].map((value) => <button key={value || 'all'} type="button" className={value === status ? 'primary-btn' : 'secondary-btn'} onClick={() => setStatus(value)}>
          {value ? t(`farm.expenseStatus.${value}`) : t('farm.all')}
        </button>)}
      </div>
      {!list ? null : list.length === 0 ? <Empty>{t('farm.noExpenses')}</Empty> : <div className="table-wrap"><table className="card-table">
        <thead><tr><th>{t('farm.date')}</th><th>{t('farm.whatFor')}</th><th>{t('farm.amount')}</th><th>{t('farm.status')}</th><th>{t('farm.actions')}</th></tr></thead>
        <tbody>{list.map((expense) => <tr key={expense.id}>
          <td data-label={t('farm.date')}>{formatDate(expense.date, language)}</td>
          <td className="card-title-cell" data-label={t('farm.whatFor')}>
            <strong>{categoryName(expense.category, t)}</strong> · {typeName(expense.animalTypeId)}<br />{expense.description}
            {expense.payee && <small className="muted"> · {expense.payee}</small>}
            {expense.receiptRef && <small className="muted"> · {fill(t('farm.receiptShort'), { ref: expense.receiptRef })}</small>}
            {can.money && expense.submittedByName && <small className="muted"><br />{fill(t('farm.submittedBy'), { name: expense.submittedByName })}</small>}
            {expense.decisionNote && <small className="muted"><br />{expense.decisionNote}</small>}
            {expense.voidReason && <small className="muted"><br />{expense.voidReason}</small>}
          </td>
          <td data-label={t('farm.amount')}>{amountText(expense.amount, expense.currency)}{expense.currency !== 'USD' && <small className="muted"><br />{formatUsd(expense.amountUsd)}</small>}</td>
          <td data-label={t('farm.status')}><Badge tone={EXPENSE_TONE[expense.status]}>{t(`farm.expenseStatus.${expense.status}`)}</Badge></td>
          <td className="card-actions" data-label={t('farm.actions')}>
            {can.manage && expense.status === 'pending' && <>
              <button className="primary-btn" type="button" disabled={busy} onClick={() => decide(expense, true)}>{t('farm.approve')}</button>
              <button className="secondary-btn" type="button" disabled={busy} onClick={() => decide(expense, false)}>{t('farm.refuse')}</button>
            </>}
            {can.manage && ['pending', 'approved'].includes(expense.status) && <button className="text-btn" type="button" disabled={busy} onClick={() => voidExpense(expense)}>{t('farm.void')}</button>}
          </td>
        </tr>)}</tbody>
      </table></div>}
    </Panel>
  </>;
}

function ExpenseForm({ fetchJson, onMessage, onError, changed, catalogue, user, approvesOwn }) {
  const { t } = useI18n();
  const types = selectableTypes(catalogue.types);
  const [form, setForm, clear] = useDraft(`farm-draft:${user.id}:expense`, {
    date: todayLocal(), amount: '', currency: 'RWF', scope: SHARED_SCOPE, category: FARM_EXPENSE_CATEGORIES[0], description: '', payee: '', receiptRef: '', key: newRequestKey()
  });
  const [problem, setProblem] = useState('');
  const submit = useSubmit({ fetchJson, onMessage, onError, changed });
  const categories = useMemo(() => {
    const own = form.scope === SHARED_SCOPE
      ? types.flatMap((type) => type.expenseCategories)
      : (types.find((type) => String(type.id) === String(form.scope))?.expenseCategories || []);
    return [...new Set([...FARM_EXPENSE_CATEGORIES, ...own])];
  }, [form.scope, types]);
  const save = (event) => {
    event.preventDefault();
    const check = validateExpense({ ...form, amount: form.amount === '' ? '' : Number(form.amount) }, { types: catalogue.types, categories, today: todayLocal() });
    if (check.errors.length) { setProblem(codeText(check.errors[0], t)); return; }
    setProblem('');
    submit('/api/farming/expenses', { ...form, amount: Number(form.amount), requestKey: form.key }, clear,
      (match) => `${amountText(match.amount, match.currency)} · ${categoryName(match.category, t)}${match.submittedByName ? ` (${match.submittedByName})` : ''}`);
  };
  return <Panel title={t('farm.newExpense')} subtitle={t(approvesOwn ? 'farm.ownApprovedHint' : 'farm.goesToManager')}>
    <form className="form-grid" onSubmit={save}>
      <Field label={t('farm.date')}><input type="date" value={form.date} max={todayLocal()} onChange={(event) => setForm({ ...form, date: event.target.value })} required /></Field>
      <Field label={t('farm.amount')}><input type="number" inputMode="decimal" min="0" step="any" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} required /></Field>
      <Field label={t('farm.currency')}>
        <select value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })}>{FARM_CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}</select>
      </Field>
      <Field label={t('farm.forWhichAnimal')}>
        <select value={form.scope} onChange={(event) => setForm({ ...form, scope: event.target.value })}>
          <option value={SHARED_SCOPE}>{t('farm.sharedFarm')}</option>
          {types.map((type) => <option key={type.id} value={String(type.id)}>{type.name}</option>)}
        </select>
      </Field>
      <Field label={t('farm.category')}>
        <select value={categories.includes(form.category) ? form.category : categories[0]} onChange={(event) => setForm({ ...form, category: event.target.value })}>
          {categories.map((category) => <option key={category} value={category}>{categoryName(category, t)}</option>)}
        </select>
      </Field>
      <Field label={t('farm.payee')}><input value={form.payee} maxLength={120} onChange={(event) => setForm({ ...form, payee: event.target.value })} /></Field>
      <Field label={t('farm.whatAndWhy')} wide><textarea rows={2} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder={t('farm.whatAndWhyHint')} required /></Field>
      <Field label={t('farm.receiptRef')}><input value={form.receiptRef} maxLength={120} onChange={(event) => setForm({ ...form, receiptRef: event.target.value })} /></Field>
      {problem && <p className="form-error form-field-wide" role="alert">{problem}</p>}
      <div className="form-actions form-field-wide"><button className="primary-btn big-action" type="submit">{t(approvesOwn ? 'farm.save' : 'farm.sendForApproval')}</button></div>
    </form>
    <p className="muted">{t('farm.sharedHint')}</p>
  </Panel>;
}

// ---- problems ----------------------------------------------------------------------

function ProblemsTab({ fetchJson, onMessage, onError, changed, can, catalogue, user }) {
  const { t, language } = useI18n();
  const dialog = useDialog();
  const [busy, run] = useBusy();
  const [list, reload] = useLoad(fetchJson, '/api/farming/issues?limit=200', onError);
  const [form, setForm, clear] = useDraft(`farm-draft:${user.id}:issue`, { kind: 'missing_supply', urgent: false, animalTypeId: '', description: '' });
  const [problem, setProblem] = useState('');
  const typeName = (id) => catalogue.types.find((type) => type.id === id)?.name || '';
  const refresh = () => { reload(); changed(); };

  const raise = (event) => { event.preventDefault(); return run(async () => {
    const check = validateIssue({ ...form, animalTypeId: form.animalTypeId || null }, { types: catalogue.types });
    if (check.errors.length) { setProblem(codeText(check.errors[0], t)); return false; }
    setProblem('');
    try {
      await fetchJson('/api/farming/issues', { method: 'POST', body: JSON.stringify({ ...form, animalTypeId: form.animalTypeId || null }) });
      onMessage(t('farm.problemRaised'));
      clear();
      refresh();
      return true;
    } catch (error) { onError(errorText(error, t)); return false; }
  }); };
  const resolve = (issue) => run(async () => {
    const note = await dialog.prompt({ title: t('farm.resolve'), label: t('farm.whatWasDone'), multiline: true });
    if (note === null) return false;
    try {
      await fetchJson(`/api/farming/issues/${issue.id}/resolve`, { method: 'POST', body: JSON.stringify({ note }) });
      onMessage(t('farm.resolvedDone'));
      refresh();
      return true;
    } catch (error) { onError(errorText(error, t)); return false; }
  });

  return <>
    {can.record && <Panel title={t('farm.raiseProblem')} subtitle={t('farm.raiseProblemHint')}>
      <form className="form-grid" onSubmit={raise}>
        <Field label={t('farm.problemKind')}>
          <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}>
            {ISSUE_KINDS.map((kind) => <option key={kind} value={kind}>{t(`farm.issueKind.${kind}`)}</option>)}
          </select>
        </Field>
        <Field label={t('farm.forWhichAnimal')}>
          <select value={form.animalTypeId} onChange={(event) => setForm({ ...form, animalTypeId: event.target.value })}>
            <option value="">{t('farm.sharedFarm')}</option>
            {selectableTypes(catalogue.types).map((type) => <option key={type.id} value={String(type.id)}>{type.name}</option>)}
          </select>
        </Field>
        <Field label={t('farm.whatIsWrong')} wide><textarea rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} required /></Field>
        {form.kind !== 'animal_welfare' && <label className="checkbox-row form-field-wide"><input type="checkbox" checked={form.urgent} onChange={(event) => setForm({ ...form, urgent: event.target.checked })} /> {t('farm.urgentToday')}</label>}
        {problem && <p className="form-error form-field-wide" role="alert">{problem}</p>}
        <div className="form-actions form-field-wide"><button className="primary-btn big-action" type="submit" disabled={busy}>{t('farm.send')}</button></div>
      </form>
    </Panel>}
    <Panel title={t('farm.problems')}>
      {!list ? null : list.length === 0 ? <Empty>{t('farm.noProblems')}</Empty> : <ul className="farm-list">
        {list.map((issue) => <li key={issue.id} className={issue.status === 'resolved' ? 'farm-voided' : ''}>
          <span>
            {issue.urgent && issue.status === 'open' && <Badge tone="stopped">{t('farm.urgent')}</Badge>} <strong>{t(`farm.issueKind.${issue.kind}`)}</strong>
            {issue.animalTypeId && ` · ${typeName(issue.animalTypeId)}`} — {issue.description}
            <small className="muted"><br />{formatDate(issue.createdAt, language)}{issue.raisedByName && ` · ${issue.raisedByName}`}
              {issue.status === 'resolved' && ` · ${fill(t('farm.resolvedBy'), { name: issue.resolvedByName })}${issue.resolutionNote ? `: ${issue.resolutionNote}` : ''}`}</small>
          </span>
          {can.manage && issue.status === 'open' && <button className="secondary-btn" type="button" disabled={busy} onClick={() => resolve(issue)}>{t('farm.resolve')}</button>}
        </li>)}
      </ul>}
    </Panel>
  </>;
}

// ---- reports ------------------------------------------------------------------------

function ReportsTab({ fetchJson, onError, catalogue }) {
  const { t, language } = useI18n();
  const today = todayLocal();
  const [filters, setFilters] = useState({ period: 'weekly', from: `${today.slice(0, 7)}-01`, to: today, animalType: '', measure: '', category: '' });
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString();
  const [report] = useLoad(fetchJson, `/api/farming/report?${query}`, onError);
  const measures = catalogue.measures.filter((measure) => !filters.animalType || String(measure.animalTypeId) === filters.animalType);
  const set = (key) => (event) => setFilters({ ...filters, [key]: event.target.value, ...(key === 'animalType' ? { measure: '' } : {}) });

  return <>
    <Panel title={t('farm.tab.reports')} subtitle={t('farm.reportsHint')}>
      <div className="form-grid">
        <Field label={t('farm.groupBy')}><select value={filters.period} onChange={set('period')}>{FARM_PERIODS.map((period) => <option key={period} value={period}>{t(`farm.periodName.${period}`)}</option>)}</select></Field>
        <Field label={t('farm.from')}><input type="date" value={filters.from} max={filters.to} onChange={set('from')} /></Field>
        <Field label={t('farm.to')}><input type="date" value={filters.to} min={filters.from} onChange={set('to')} /></Field>
        <Field label={t('farm.animalType')}>
          <select value={filters.animalType} onChange={set('animalType')}>
            <option value="">{t('farm.wholeFarm')}</option>
            {catalogue.types.map((type) => <option key={type.id} value={String(type.id)}>{type.name}</option>)}
            <option value={SHARED_SCOPE}>{t('farm.sharedOnly')}</option>
          </select>
        </Field>
        <Field label={t('farm.product')}>
          <select value={filters.measure} onChange={set('measure')}>
            <option value="">{t('farm.all')}</option>
            {measures.map((measure) => <option key={measure.id} value={String(measure.id)}>{measure.name}</option>)}
          </select>
        </Field>
        <Field label={t('farm.category')}>
          <select value={filters.category} onChange={set('category')}>
            <option value="">{t('farm.all')}</option>
            {FARM_EXPENSE_CATEGORIES.map((category) => <option key={category} value={category}>{categoryName(category, t)}</option>)}
          </select>
        </Field>
      </div>
    </Panel>
    {report && <>
      <Panel title={t('farm.totals')} subtitle={`${formatDate(report.from, language)} – ${formatDate(report.to, language)}`}>
        <div className="metric-grid">
          <Metric label={t('farm.revenue')} value={formatUsd(report.summary.farm.revenueUsd)} />
          <Metric label={t('farm.directCosts')} value={formatUsd(report.summary.farm.directExpensesUsd)} />
          <Metric label={t('farm.sharedCosts')} value={formatUsd(report.summary.farm.sharedExpensesUsd)} />
          <Metric label={t('farm.operatingResult')} value={formatUsd(report.summary.farm.operatingResultUsd)} tone={report.summary.farm.operatingResultUsd < 0 ? 'bad' : null} />
        </div>
        {report.pendingExpenses.count > 0 && <p className="muted">{fill(t('farm.pendingNotCounted'), { count: report.pendingExpenses.count, amount: formatUsd(report.pendingExpenses.usd) })}</p>}
        <p className="muted">{t('farm.operatingResultHint')}</p>
        <TypeTable summary={report.summary} catalogue={catalogue} money />
      </Panel>
      <Panel title={t(`farm.periodName.${report.period}`)}>
        {report.periods.length === 0 ? <Empty>{t('farm.nothingRecorded')}</Empty> : <div className="table-wrap"><table className="card-table">
          <thead><tr><th>{t('farm.when')}</th><th>{t('farm.produced')}</th><th>{t('farm.revenue')}</th><th>{t('farm.expenses')}</th><th>{t('farm.operatingResult')}</th></tr></thead>
          <tbody>{report.periods.map((line) => <tr key={line.period}>
            <td className="card-title-cell" data-label={t('farm.when')}>{report.period === 'monthly' ? line.period : formatDate(line.period, language)}</td>
            <td data-label={t('farm.produced')}>{line.animalTypes.flatMap((type) => type.products).map((product) => {
              const measure = catalogue.measures.find((item) => item.id === product.measureId);
              return <div key={product.measureId}>{measure?.name}: {quantityText(product.produced, product.unit)}</div>;
            })}</td>
            <td data-label={t('farm.revenue')}>{formatUsd(line.revenueUsd)}</td>
            <td data-label={t('farm.expenses')}>{formatUsd(line.expensesUsd)}</td>
            <td data-label={t('farm.operatingResult')}>{formatUsd(line.operatingResultUsd)}</td>
          </tr>)}</tbody>
        </table></div>}
      </Panel>
    </>}
  </>;
}

// ---- set-up -----------------------------------------------------------------------

function SetupTab({ fetchJson, onMessage, onError, changed, can }) {
  const { t } = useI18n();
  const dialog = useDialog();
  const [busy, run] = useBusy();
  const [data, reload] = useLoad(fetchJson, '/api/farming/animal-types', onError);
  const refresh = () => { reload(); changed(); };
  const call = (path, method, body, done) => run(async () => {
    try {
      await fetchJson(path, { method, body: body ? JSON.stringify(body) : undefined });
      onMessage(t(done));
      refresh();
      return true;
    } catch (error) { onError(errorText(error, t)); return false; }
  });

  const addType = async () => {
    const name = await dialog.prompt({ title: t('farm.addAnimal'), label: t('farm.animalName'), message: t('farm.addAnimalHint'), required: true });
    if (name) call('/api/farming/animal-types', 'POST', { name }, 'farm.saved');
  };
  const rename = async (type) => {
    const name = await dialog.prompt({ title: t('farm.rename'), label: t('farm.animalName'), initialValue: type.name, required: true });
    if (name && name !== type.name) call(`/api/farming/animal-types/${type.id}`, 'PUT', { name }, 'farm.saved');
  };
  const categories = async (type) => {
    const typed = await dialog.prompt({ title: t('farm.ownCategories'), label: t('farm.ownCategoriesLabel'), message: t('farm.ownCategoriesHint'), initialValue: type.expenseCategories.join(', '), multiline: true });
    if (typed !== null) call(`/api/farming/animal-types/${type.id}`, 'PUT', { expenseCategories: typed.split(',').map((item) => item.trim()).filter(Boolean) }, 'farm.saved');
  };
  const remove = async (type) => {
    const sure = await dialog.confirm({ title: t('farm.remove'), message: fill(t('farm.removeHint'), { name: type.name }), confirmLabel: t('farm.remove') });
    if (sure) call(`/api/farming/animal-types/${type.id}`, 'DELETE', null, 'farm.removed');
  };
  const addMeasure = async (type) => {
    const choice = await dialog.choose({ title: t('farm.addMeasure'), message: t('farm.addMeasureHint'), options: [
      { value: 'product', label: t('farm.measureKind.product') }, { value: 'herd', label: t('farm.measureKind.herd') }
    ] });
    if (!choice) return;
    const name = await dialog.prompt({ title: t('farm.addMeasure'), label: t('farm.measureName'), required: true });
    if (!name) return;
    const unit = await dialog.prompt({ title: t('farm.addMeasure'), label: t('farm.unit'), message: t('farm.unitHint'), required: true });
    if (!unit) return;
    call(`/api/farming/animal-types/${type.id}/measures`, 'POST', { name, unit, kind: choice, sellable: choice === 'product', dailyExpected: false }, 'farm.saved');
  };

  if (!data) return null;
  return <>
    <Panel title={t('farm.animalTypes')} subtitle={t('farm.animalTypesHint')}>
      {can.manage && <div className="form-actions"><button className="primary-btn" type="button" disabled={busy} onClick={addType}>{t('farm.addAnimal')}</button></div>}
      {data.types.map((type) => <div key={type.id} className={`farm-type${type.active ? '' : ' farm-voided'}`}>
        <div className="farm-type-head">
          <h3>{type.name}{!type.active && <> <Badge tone="stopped">{t('farm.off')}</Badge></>}</h3>
          {can.manage && <span className="row-actions">
            <button className="text-btn" type="button" disabled={busy} onClick={() => rename(type)}>{t('farm.rename')}</button>
            <button className="text-btn" type="button" disabled={busy} onClick={() => categories(type)}>{t('farm.ownCategories')}</button>
            <button className="text-btn" type="button" disabled={busy} onClick={() => call(`/api/farming/animal-types/${type.id}`, 'PUT', { active: !type.active }, 'farm.saved')}>{t(type.active ? 'farm.switchOff' : 'farm.switchOn')}</button>
            {type.records === 0 && <button className="text-btn" type="button" disabled={busy} onClick={() => remove(type)}>{t('farm.remove')}</button>}
          </span>}
        </div>
        {type.expenseCategories.length > 0 && <p className="muted">{t('farm.ownCategories')}: {type.expenseCategories.join(', ')}</p>}
        <ul className="farm-list">
          {type.measures.map((measure) => <MeasureRow key={measure.id} measure={measure} can={can} busy={busy} call={call} />)}
        </ul>
        {can.manage && <button className="secondary-btn" type="button" disabled={busy} onClick={() => addMeasure(type)}>{t('farm.addMeasure')}</button>}
      </div>)}
    </Panel>
    {can.director && <BudgetPanel fetchJson={fetchJson} onMessage={onMessage} onError={onError} changed={changed} />}
    <AlertSettings fetchJson={fetchJson} onMessage={onMessage} onError={onError} changed={changed} can={can} />
  </>;
}

function MeasureRow({ measure, can, busy, call }) {
  const { t } = useI18n();
  const toggle = (field) => call(`/api/farming/measures/${measure.id}`, 'PUT', { [field]: !measure[field] }, 'farm.saved');
  return <li className={measure.active ? '' : 'farm-voided'}>
    <span><strong>{measure.name}</strong> ({measure.unit}) · {t(`farm.measureKind.${measure.kind}`)}
      {measure.kind === 'product' && <small className="muted"> · {t(measure.sellable ? 'farm.isSold' : 'farm.notSold')} · {t(measure.dailyExpected ? 'farm.expectedDaily' : 'farm.notDaily')}</small>}</span>
    {can.manage && <span className="row-actions">
      {measure.kind === 'product' && <>
        <button className="text-btn" type="button" disabled={busy} onClick={() => toggle('sellable')}>{t(measure.sellable ? 'farm.markNotSold' : 'farm.markSold')}</button>
        <button className="text-btn" type="button" disabled={busy} onClick={() => toggle('dailyExpected')}>{t(measure.dailyExpected ? 'farm.markNotDaily' : 'farm.markDaily')}</button>
      </>}
      <button className="text-btn" type="button" disabled={busy} onClick={() => toggle('active')}>{t(measure.active ? 'farm.switchOff' : 'farm.switchOn')}</button>
    </span>}
  </li>;
}

function BudgetPanel({ fetchJson, onMessage, onError, changed }) {
  const { t } = useI18n();
  const [month, setMonth] = useState(todayLocal().slice(0, 7));
  const [budget, reload] = useLoad(fetchJson, `/api/farming/budget?month=${month}`, onError);
  const [amount, setAmount] = useState('');
  const [busy, run] = useBusy();
  useEffect(() => { setAmount(budget?.budgetUsd === null || budget?.budgetUsd === undefined ? '' : String(budget.budgetUsd)); }, [budget]);
  const save = (event) => { event.preventDefault(); return run(async () => {
    try {
      await fetchJson(`/api/farming/budget/${month}`, { method: 'PUT', body: JSON.stringify({ amountUsd: Number(amount || 0) }) });
      onMessage(t('farm.saved'));
      reload();
      changed();
      return true;
    } catch (error) { onError(errorText(error, t)); return false; }
  }); };
  return <Panel title={t('farm.budget')} subtitle={t('farm.budgetHint')}>
    <form className="form-grid" onSubmit={save}>
      <Field label={t('farm.month')}><input type="month" value={month} onChange={(event) => setMonth(event.target.value)} required /></Field>
      <Field label={t('farm.budgetUsd')}><input type="number" inputMode="decimal" min="0" step="any" value={amount} onChange={(event) => setAmount(event.target.value)} /></Field>
      <div className="form-actions form-field-wide"><button className="primary-btn" type="submit" disabled={busy}>{t('farm.save')}</button></div>
    </form>
  </Panel>;
}

function AlertSettings({ fetchJson, onMessage, onError, changed, can }) {
  const { t } = useI18n();
  const [settings, reload] = useLoad(fetchJson, '/api/farming/settings', onError);
  const [form, setForm] = useState(null);
  const [busy, run] = useBusy();
  useEffect(() => { if (settings) setForm(settings.thresholds); }, [settings]);
  if (!form) return null;
  const save = (event) => { event.preventDefault(); return run(async () => {
    try {
      await fetchJson('/api/farming/settings', { method: 'PUT', body: JSON.stringify({ thresholds: Object.fromEntries(Object.entries(form).map(([key, value]) => [key, Number(value)])) }) });
      onMessage(t('farm.saved'));
      reload();
      changed();
      return true;
    } catch (error) { onError(errorText(error, t)); return false; }
  }); };
  return <Panel title={t('farm.alertSettings')} subtitle={t('farm.alertSettingsHint')}>
    <form className="form-grid" onSubmit={save}>
      {Object.entries(THRESHOLD_LIMITS).map(([key, [min, max]]) => <Field key={key} label={t(`farm.threshold.${key}`)}>
        <input type="number" min={min} max={max} step="1" value={form[key]} disabled={!can.manage} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />
      </Field>)}
      {can.manage && <div className="form-actions form-field-wide"><button className="primary-btn" type="submit" disabled={busy}>{t('farm.save')}</button></div>}
    </form>
  </Panel>;
}

// ---- history ------------------------------------------------------------------------

function HistoryTab({ fetchJson, onError }) {
  const { t, language } = useI18n();
  const [rows] = useLoad(fetchJson, '/api/farming/audit?limit=200', onError);
  if (!rows) return null;
  return <Panel title={t('farm.tab.history')} subtitle={t('farm.historyHint')}>
    {rows.length === 0 ? <Empty>{t('farm.nothingYet')}</Empty> : <ul className="farm-list">
      {rows.map((row) => <li key={row.id}>
        <span><strong>{t(`farm.entity.${row.entityType}`)}</strong> · {t(`farm.action.${row.action}`)}{row.reason && ` — ${row.reason}`}
          <small className="muted"><br />{formatDate(row.createdAt, language)} · {row.actorName}</small></span>
      </li>)}
    </ul>}
  </Panel>;
}
