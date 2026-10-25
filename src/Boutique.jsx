// The Boutique Management System (Project 5): the shop's workspace, at
// #/boutique/<tab>.
//
// One module, one page, with a tab per part of the brief: the till (Sell),
// Sales, Products, Stock, Suppliers & purchases, Cash, Expenses, the Books,
// Reports, Approvals and History. Which tabs a person gets is decided by the
// role the API answers in /overview (director, reader, manager, cashier),
// never by the browser's own guess, and every button here is re-checked by
// the route it calls.
//
// Reached from the Director's Projects page (the PRJ-BOUTIQUE row's "Open
// boutique" button), from the Boutique chip under the logo, and from the
// Boutique entry in the menu of everybody who works in it. Money is RWF
// throughout (formatRwf); nothing here moves money, it records it.

import { useCallback, useEffect, useRef, useState } from 'react';
import { fill, useI18n } from './i18n.js';
import { DetailView, Fact, useBusy, useDialog } from './ui.jsx';
import { Section } from './journey.jsx';
import { categoryLabel } from './ActivityReview.jsx';
import { formatDate, formatRwf, todayLocal } from './format.js';
import {
  ADDING_ADJUSTMENTS, ADJUSTMENT_KINDS, BOUTIQUE_PAYMENT_METHODS, EXPENSE_CATEGORIES, PRODUCT_CATEGORIES, REPORT_PERIODS,
  fromMinor, lineTotals, saleTotals, toMinor
} from '../shared/boutique.js';

const TABS = {
  director: ['overview', 'sell', 'sales', 'products', 'stock', 'count', 'suppliers', 'cash', 'expenses', 'books', 'reports', 'approvals', 'history'],
  manager: ['overview', 'sell', 'sales', 'products', 'stock', 'count', 'suppliers', 'cash', 'expenses', 'books', 'reports', 'approvals', 'history'],
  reader: ['overview', 'sales', 'products', 'stock', 'count', 'suppliers', 'cash', 'expenses', 'books', 'reports', 'approvals', 'history'],
  cashier: ['overview', 'sell', 'sales', 'products', 'stock', 'cash']
};

// The tabs each person uses every day, in front; everything else is one tap
// away under "More". Thirteen tabs in a row filled half a phone screen before
// anything useful appeared, and nobody uses all thirteen in a day: the
// Director decides and reads, the manager sells and keeps the shelf.
const MAIN_TABS = {
  director: ['overview', 'approvals', 'reports'],
  // The manager's day, as the Director put it: add a product with its buying
  // and selling price, report what sold, and the shop shows the profit.
  manager: ['overview', 'products', 'count', 'expenses'],
  reader: ['overview', 'reports'],
  cashier: ['overview', 'sell', 'stock']
};
// A picture on every tab, so it can be found without reading.
const TAB_ICONS = {
  overview: '🏠', sell: '🛒', sales: '🧾', products: '📦', stock: '📊', count: '🔢', suppliers: '🚚',
  cash: '💵', expenses: '💸', books: '📒', reports: '📈', approvals: '✅', history: '🕘'
};

const money = formatRwf;
const variantLabel = (v) => [v.size, v.color].filter(Boolean).join(' / ');
// A quantity with what it is counted in -- '20 kg', '12 bottles' -- or the
// bare number for a product saved before the unit was asked.
const qty = (n, unit) => (unit ? `${n} ${unit}` : String(n));
// Suggestions for 'Counted in'. Typed freely; these are only the usual ones.
const UNIT_SUGGESTIONS = ['kg', 'g', 'litres', 'pieces', 'bottles', 'packets', 'bags', 'boxes', 'dozens', 'sacks', 'trays'];
const fullName = (v) => `${v.productName || ''}${variantLabel(v) ? ` (${variantLabel(v)})` : ''}`;

function Panel({ title, subtitle, children, action, onAction }) {
  return <section className="panel">
    <div className="panel-header"><div><h2>{title}</h2>{subtitle && <span>{subtitle}</span>}</div>
      {action && <button className="text-btn" type="button" onClick={onAction}>{action} &rarr;</button>}</div>
    {children}
  </section>;
}
function Field({ label, children, wide }) {
  return <label className={wide ? 'form-field form-field-wide' : 'form-field'}><span>{label}</span>{children}</label>;
}
function Metric({ label, value, tone }) {
  return <div className={`metric-card${tone ? ` btq-metric-${tone}` : ''}`}><span>{label}</span><strong>{value}</strong></div>;
}
function Empty({ children }) { return <div className="empty-state"><strong>{children}</strong></div>; }
function Badge({ tone, children }) { return <span className={`status-badge tone-${tone}`}>{children}</span>; }

const SALE_TONE = { completed: 'done', void_requested: 'waiting', voided: 'stopped' };
const APPROVAL_TONE = { pending: 'waiting', approved: 'done', rejected: 'stopped' };
const PO_TONE = { ordered: 'waiting', partially_received: 'active', received: 'done', cancelled: 'stopped' };

// Loads one address and re-loads it when `key` changes. The newest request
// wins, as every loader in this app does.
function useLoad(fetchJson, path, key, onError) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);
  const reload = useCallback(async () => {
    if (!path) return;
    const n = ++latest.current;
    setLoading(true);
    try {
      const result = await fetchJson(path);
      if (n === latest.current) setData(result);
    } catch (error) {
      if (n === latest.current) onError?.(error.message);
    } finally {
      if (n === latest.current) setLoading(false);
    }
  }, [fetchJson, path, onError]);
  useEffect(() => { reload(); }, [reload, key]);
  return [data, reload, loading];
}

// A search box that asks the till's search route and offers the matches.
function VariantSearch({ fetchJson, onPick, placeholder, disabled }) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const latest = useRef(0);
  useEffect(() => {
    const text = q.trim();
    if (!text) { setResults([]); return undefined; }
    const n = ++latest.current;
    const timer = setTimeout(async () => {
      try {
        const found = await fetchJson(`/api/boutique/pos/search?q=${encodeURIComponent(text)}`);
        if (n === latest.current) setResults(found);
      } catch { /* the box simply shows nothing */ }
    }, 250);
    return () => clearTimeout(timer);
  }, [q, fetchJson]);
  return <div className="btq-search">
    <input type="search" value={q} disabled={disabled} placeholder={placeholder || t('btq.searchProducts')} onChange={(e) => setQ(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter' && results.length === 1) { e.preventDefault(); onPick(results[0]); setQ(''); setResults([]); } }} />
    {results.length > 0 && <ul className="btq-results">
      {results.map((v) => <li key={v.id}>
        <button type="button" className="btq-result" onClick={() => { onPick(v); setQ(''); setResults([]); }}>
          <strong>{fullName(v)}</strong>
          <span>{v.sku} · {money(v.sellingPrice)} · {fill(t('btq.inStockCount'), { count: v.stockQuantity })}</span>
        </button>
      </li>)}
    </ul>}
  </div>;
}

// ---- the workspace ----------------------------------------------------------------

export default function Boutique({ user, fetchJson, upload, onMessage, onError, onChanged, tab, query, onNavigate }) {
  const { t } = useI18n();
  const [overview, reloadOverview] = useLoad(fetchJson, '/api/boutique/overview', 0, onError);
  const role = overview?.role;
  const tabs = role ? TABS[role] : [];
  const active = tabs.includes(tab) ? tab : 'overview';
  const changed = useCallback(() => { reloadOverview(); onChanged?.(); }, [reloadOverview, onChanged]);
  const go = useCallback((next, params) => onNavigate(next, params), [onNavigate]);
  // Today's page is read live: while it is open and the window is in front,
  // the figures are read again every half minute, so a count the manager
  // saves shows up on the Director's profit without anybody pressing refresh.
  const onToday = !tab || tab === 'overview';
  useEffect(() => {
    if (!onToday) return undefined;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') reloadOverview(); }, 30000);
    return () => clearInterval(timer);
  }, [onToday, reloadOverview]);

  if (!overview) return <div className="loading-state"><span className="spinner" />{t('app.loading')}</div>;
  const can = { manage: role === 'director' || role === 'manager', sell: role !== 'reader', decide: role === 'director', role };
  const common = { fetchJson, upload, onMessage, onError, changed, can, go, query, user, overview };
  const main = (MAIN_TABS[role] || tabs).filter((id) => tabs.includes(id));
  const more = tabs.filter((id) => !main.includes(id) && id !== active);
  const tabButton = (id) => <button key={id} type="button" className={`partner-tab${active === id ? ' active' : ''}`} onClick={() => go(id)}>
    <span aria-hidden="true">{TAB_ICONS[id]}</span> {t(`btq.tab.${id}`)}{id === 'approvals' && overview.pendingApprovals > 0 && <span className="nav-badge btq-badge">{overview.pendingApprovals}</span>}
  </button>;

  return <div className="boutique">
    <section className="welcome-strip btq-head">
      <div>
        <span className="eyebrow">{t('btq.eyebrow')}</span>
        <h2>{t('btq.title')}</h2>
        <p>{t('btq.blurb')}</p>
      </div>
    </section>
    <nav className="partner-tabs btq-tabs" aria-label={t('btq.title')}>
      {[...main, ...(main.includes(active) ? [] : [active])].map((id) => tabButton(id))}
      {more.length > 0 && <details className="btq-more-tabs" key={active}>
        <summary className="partner-tab">☰ {t('btq.moreTabs')}{more.includes('approvals') && overview.pendingApprovals > 0 && <span className="nav-badge btq-badge">{overview.pendingApprovals}</span>}</summary>
        <div className="btq-more-list">{more.map((id) => tabButton(id))}</div>
      </details>}
    </nav>
    {active === 'overview' && <OverviewTab {...common} />}
    {active === 'sell' && <SellTab {...common} />}
    {active === 'sales' && <SalesTab {...common} />}
    {active === 'products' && <ProductsTab {...common} />}
    {active === 'stock' && <StockTab {...common} />}
    {active === 'count' && <CountTab {...common} />}
    {active === 'suppliers' && <SuppliersTab {...common} />}
    {active === 'cash' && <CashTab {...common} />}
    {active === 'expenses' && <ExpensesTab {...common} />}
    {active === 'books' && <BooksTab {...common} />}
    {active === 'reports' && <ReportsTab {...common} />}
    {active === 'approvals' && <ApprovalsTab {...common} />}
    {active === 'history' && <HistoryTab {...common} />}
  </div>;
}

// ---- overview ------------------------------------------------------------------------

// The first screen answers "what needs me?" before it shows any figure: one
// line per thing waiting, each with the one button that deals with it, then
// four numbers, and everything else folded under "More figures".
function OverviewTab({ overview, can, go }) {
  const { t } = useI18n();
  const cashier = can.role === 'cashier';
  const deciding = can.decide || can.role === 'reader';
  // Only what needs somebody now: a decision for the Director, a shelf running
  // low for everybody. (The till no longer needs opening by hand: the first
  // cash sale of the day opens it.)
  const attention = [];
  if (can.decide && overview.pendingApprovals > 0) {
    attention.push({ key: 'decide', text: fill(t('btq.attn.decide'), { count: overview.pendingApprovals }), action: t('btq.tab.approvals'), to: 'approvals' });
  }
  if (overview.lowStock > 0) {
    attention.push({ key: 'low', text: fill(t('btq.attn.lowStock'), { count: overview.lowStock }), action: t('btq.seeThem'), to: 'stock' });
  }
  // The handful of things each person does, as big buttons with a picture:
  // the shop's people sell, take in stock, write down what they spent and
  // report up; the Director decides and reads.
  const actions = deciding
    ? [
      ['approvals', '✅', t('btq.big.approvals'), overview.pendingApprovals],
      ['reports', '📈', t('btq.big.reports')],
      ['sales', '🧾', t('btq.big.sales')]
    ]
    : cashier
      ? [['sell', '🛒', t('btq.big.sell')], ['stock', '📦', t('btq.big.stockLook')]]
      : [
        ['products', '➕', t('btq.big.addProduct'), 0, { add: '1' }],
        ['count', '📝', t('btq.big.reportSold')],
        ['stock', '📦', t('btq.big.stockIn'), 0, { update: '1' }],
        ['expenses', '💸', t('btq.big.spent')]
      ];
  return <>
    {attention.length > 0 && <section className="next-step next-step-warning btq-attention" aria-live="polite">
      <div className="next-step-text">
        <strong>{t('btq.needsYou')}</strong>
        <ul className="btq-attention-list">{attention.map((item) => <li key={item.key}>
          <span>{item.text}</span>
          <button type="button" className="secondary-btn" onClick={() => go(item.to)}>{item.action}</button>
        </li>)}</ul>
      </div>
    </section>}
    {/* The Director reads first and acts second; the shop's people act first,
        so their buttons come before the figures. */}
    {deciding && overview.profit && <ProfitPanel profit={overview.profit} />}
    <div className="btq-big-actions">
      {actions.map(([to, picture, label, badge, params]) => <button key={to} type="button" className="btq-big-action" onClick={() => go(to, params)}>
        <span className="btq-big-picture" aria-hidden="true">{picture}</span>
        <span>{label}</span>
        {badge > 0 && <span className="nav-badge btq-badge">{badge}</span>}
      </button>)}
    </div>
    {!deciding && overview.profit && <ProfitPanel profit={overview.profit} />}
    <div className="metric-grid btq-today-figures">
      {/* Today's sales are already the first line of the profit panel. */}
      {!overview.profit && <Metric label={t('btq.todaySales')} value={fill(t('btq.todaySalesValue'), { amount: money(overview.todaySales.total), count: overview.todaySales.count })} tone="strong" />}
      <Metric label={t('btq.lowStockCount')} value={overview.lowStock} tone={overview.lowStock ? 'warn' : ''} />
      {!cashier && <Metric label={t(can.decide ? 'btq.waitingForYou' : 'btq.pendingApprovals')} value={overview.pendingApprovals} tone={overview.pendingApprovals ? 'warn' : ''} />}
    </div>
  </>;
}

// Profit and loss in five lines, today beside the month so far: what was sold,
// what those goods cost to buy, what that leaves, what was spent, and the
// result -- called a profit or a loss in words, not only by its sign.
function ProfitPanel({ profit }) {
  const { t } = useI18n();
  const column = (label, p) => <div className="btq-pl-column">
    <h3>{label}</h3>
    <dl>
      <div><dt>{t('btq.pl.sold')}</dt><dd>{money(p.sales)}</dd></div>
      <div><dt>{t('btq.pl.boughtFor')}</dt><dd>− {money(p.cost)}</dd></div>
      <div><dt>{t('btq.pl.fromGoods')}</dt><dd>{money(p.grossProfit)}</dd></div>
      <div><dt>{t('btq.pl.spent')}</dt><dd>− {money(p.expenses)}</dd></div>
    </dl>
    <p className={`btq-pl-result ${p.net < 0 ? 'loss' : 'gain'}`}>
      <span>{t(p.net < 0 ? 'btq.pl.loss' : 'btq.pl.profit')}</span>
      <strong>{money(Math.abs(p.net))}</strong>
    </p>
  </div>;
  return <section className="panel btq-pl" aria-live="polite">
    <div className="panel-header"><div><h2>{t('btq.pl.title')}</h2><span>{t('btq.pl.live')}</span></div></div>
    <div className="btq-pl-grid">
      {column(t('btq.pl.today'), profit.today)}
      {column(t('btq.pl.month'), profit.month)}
    </div>
  </section>;
}

// ---- the till ------------------------------------------------------------------------

function SellTab({ fetchJson, onMessage, onError, changed, can, go, overview }) {
  const { t, language } = useI18n();
  const dialog = useDialog();
  const [busy, run] = useBusy();
  const [methods] = useLoad(fetchJson, '/api/boutique/payment-methods', 0, onError);
  const [lines, setLines] = useState([]);
  const [discount, setDiscount] = useState('');
  const [customer, setCustomer] = useState('');
  const [note, setNote] = useState('');
  const [payments, setPayments] = useState([{ method: 'Cash', amount: '', reference: '' }]);
  const [receipt, setReceipt] = useState(null);
  const activeMethods = (methods || []).filter((m) => m.active).map((m) => m.code);

  const totals = saleTotals(lines, discount);
  const paid = payments.reduce((sum, p) => sum + toMinor(p.amount), 0);
  const change = Math.max(0, paid - totals.total);

  const add = (v) => setLines((current) => {
    const found = current.find((l) => l.variantId === v.id);
    if (found) return current.map((l) => (l.variantId === v.id ? { ...l, quantity: Math.min(v.stockQuantity, l.quantity + 1) } : l));
    return [...current, { variantId: v.id, name: fullName(v), sku: v.sku, stock: v.stockQuantity, catalogue: v.sellingPrice, unitPrice: v.sellingPrice, quantity: 1, discount: '' }];
  });
  const update = (variantId, patch) => setLines((current) => current.map((l) => (l.variantId === variantId ? { ...l, ...patch } : l)));
  const remove = (variantId) => setLines((current) => current.filter((l) => l.variantId !== variantId));
  const reset = () => { setLines([]); setDiscount(''); setCustomer(''); setNote(''); setPayments([{ method: 'Cash', amount: '', reference: '' }]); };

  const complete = () => run(async () => {
    try {
      // Cash goes into a till so the day's cash can be counted. Rather than
      // refusing a cash sale until somebody remembers to open one, the first
      // cash sale of the day opens it, asking only what is in the drawer.
      const takesCash = payments.some((p) => p.method === 'Cash' && Number(p.amount) > 0);
      if (takesCash && !overview.mySessionId) {
        const float = await dialog.prompt({ title: t('btq.startDrawer'), label: t('btq.drawerNow'), message: t('btq.drawerHint'), initialValue: '0', required: true });
        if (float === null) return;
        await fetchJson('/api/boutique/cash/sessions', { method: 'POST', body: JSON.stringify({ openingCash: float }) });
      }
      const sale = await fetchJson('/api/boutique/sales', {
        method: 'POST',
        body: JSON.stringify({
          // A cashier sends neither price nor discount: the catalogue price is
          // charged, and the API refuses either from them anyway.
          items: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, ...(can.manage ? { unitPrice: l.unitPrice, discount: l.discount || 0 } : {}) })),
          ...(can.manage ? { discount: discount || 0 } : {}), customerName: customer, note,
          payments: payments.filter((p) => Number(p.amount) > 0)
        })
      });
      setReceipt(sale);
      reset();
      onMessage(fill(t('btq.saleDone'), { number: sale.number }));
      changed();
    } catch (error) { onError(error.message); }
  });

  if (receipt) return <Receipt sale={receipt} language={language} onNew={() => setReceipt(null)} onOpen={() => go('sales', { sale: receipt.id })} />;

  return <div className="btq-pos">
    <div className="btq-pos-left">
      <Panel title={t('btq.tab.sell')}>
        <ProductTiles fetchJson={fetchJson} lines={lines} onPick={add} disabled={busy} onError={onError} />
        {lines.length ? <div className="table-wrap"><table className="card-table btq-cart">
          <thead><tr><th>{t('btq.item')}</th><th>{t('btq.qty')}</th><th>{t('btq.unitPrice')}</th><th>{t('btq.lineDiscount')}</th><th>{t('btq.lineTotal')}</th><th>{t('table.actions')}</th></tr></thead>
          <tbody>{lines.map((l) => <tr key={l.variantId}>
            <td className="card-title-cell"><strong>{l.name}</strong><small>{l.sku} · {fill(t('btq.inStockCount'), { count: l.stock })}</small></td>
            <td data-label={t('btq.qty')}><div className="btq-qty">
              <button type="button" className="icon-btn" aria-label={t('btq.less')} onClick={() => update(l.variantId, { quantity: Math.max(1, l.quantity - 1) })}>−</button>
              <input type="number" min="1" max={l.stock} value={l.quantity} aria-label={t('btq.qty')} onChange={(e) => update(l.variantId, { quantity: Math.max(1, Math.min(l.stock, Math.trunc(Number(e.target.value) || 1))) })} />
              <button type="button" className="icon-btn" aria-label={t('btq.more')} onClick={() => update(l.variantId, { quantity: Math.min(l.stock, l.quantity + 1) })}>+</button>
            </div></td>
            <td data-label={t('btq.unitPrice')}>{can.manage
              ? <input type="number" min="0" step="1" value={l.unitPrice} aria-label={t('btq.unitPrice')} onChange={(e) => update(l.variantId, { unitPrice: e.target.value })} />
              : money(l.unitPrice)}</td>
            <td data-label={t('btq.lineDiscount')}>{can.manage
              ? <input type="number" min="0" step="1" value={l.discount} aria-label={t('btq.lineDiscount')} onChange={(e) => update(l.variantId, { discount: e.target.value })} />
              : '—'}</td>
            <td data-label={t('btq.lineTotal')}>{money(fromMinor(lineTotals(l).total))}</td>
            <td className="card-actions"><button type="button" className="text-btn" onClick={() => remove(l.variantId)}>{t('action.remove')}</button></td>
          </tr>)}</tbody>
        </table></div> : <Empty>{t('btq.cartEmpty')}</Empty>}
      </Panel>
    </div>
    <div className="btq-pos-right">
      <Panel title={t('btq.payment')}>
        <div className="btq-totals">
          <Fact label={t('btq.subtotal')} value={money(fromMinor(totals.subtotal))} />
          <Fact label={t('btq.discount')} value={money(fromMinor(totals.discount))} />
          <Fact label={t('btq.total')} value={<span className="btq-grand">{money(fromMinor(totals.total))}</span>} />
        </div>
        {payments.map((p, index) => <div className="form-grid btq-payment-row" key={index}>
          <Field label={t('btq.method')}><select value={p.method} onChange={(e) => setPayments(payments.map((x, i) => (i === index ? { ...x, method: e.target.value } : x)))}>
            {activeMethods.map((code) => <option key={code} value={code}>{t(`btq.method.${code}`)}</option>)}
          </select></Field>
          <Field label={t('btq.amount')}><input type="number" min="0" step="1" value={p.amount} onChange={(e) => setPayments(payments.map((x, i) => (i === index ? { ...x, amount: e.target.value } : x)))} /></Field>
          {/* Cash has no reference; mobile money, card and bank do. */}
          {p.method !== 'Cash' && <Field label={t('btq.reference')}><input value={p.reference} maxLength="100" onChange={(e) => setPayments(payments.map((x, i) => (i === index ? { ...x, reference: e.target.value } : x)))} /></Field>}
        </div>)}
        <div className="button-row">
          <button type="button" className="text-btn" onClick={() => setPayments([...payments, { method: activeMethods[0] || 'Cash', amount: '', reference: '' }])}>{t('btq.splitPayment')}</button>
          <button type="button" className="text-btn" onClick={() => setPayments(payments.map((p, i) => (i === 0 ? { ...p, amount: String(fromMinor(Math.max(0, totals.total - payments.filter((_, j) => j !== 0).reduce((s, x) => s + toMinor(x.amount), 0)))) } : p)))}>{t('btq.exactAmount')}</button>
        </div>
        <div className="btq-totals">
          <Fact label={t('btq.paid')} value={money(fromMinor(paid))} />
          <Fact label={t('btq.change')} value={money(fromMinor(change))} />
        </div>
        {/* Most sales need none of these: folded, open once something is in them. */}
        <details className="btq-sale-options" open={Boolean(discount || customer || note) || undefined}>
          <summary>{t(can.manage ? 'btq.moreOptions' : 'btq.moreOptionsCashier')}</summary>
          <div className="form-grid">
            {can.manage && <Field label={t('btq.saleDiscount')}><input type="number" min="0" step="1" value={discount} onChange={(e) => setDiscount(e.target.value)} /></Field>}
            <Field label={t('btq.customer')}><input value={customer} maxLength="150" onChange={(e) => setCustomer(e.target.value)} /></Field>
            <Field label={t('field.notes')} wide><textarea rows="2" value={note} maxLength="1000" onChange={(e) => setNote(e.target.value)} /></Field>
          </div>
        </details>
        <div className="form-submit-bar">
          <button type="button" className="primary-btn big-action" disabled={busy || !lines.length || paid < totals.total} onClick={complete}>{t('btq.completeSale')}</button>
        </div>
        {lines.length > 0 && paid < totals.total && <p className="field-hint over-budget">{t('btq.notEnoughPaid')}</p>}
      </Panel>
    </div>
  </div>;
}

// The shop's products as buttons: tap one to add it to the sale, tap again
// for one more. A small shop sells the same few dozen things all day, and
// typing "sug" for sugar on every sale is slower than one tap. Each button
// shows the price and how many are left; one with nothing left is greyed out.
// The search box above still finds anything by name, code or barcode.
function ProductTiles({ fetchJson, lines, onPick, disabled, onError }) {
  const { t } = useI18n();
  const [products] = useLoad(fetchJson, '/api/boutique/products?status=active', 0, onError);
  const [filter, setFilter] = useState('');
  if (!products) return null;
  // Typing a barcode or a code and pressing Enter adds the one product it
  // matches, the way a scanner works.
  const exact = (text) => (Array.isArray(products) ? products : []).flatMap((product) => (product.variants || []).map((v) => ({ ...v, productName: product.name, productUnit: product.unit })))
    .filter((v) => [v.sku, v.barcode].some((code) => code && code.toLowerCase() === text.trim().toLowerCase()));
  const list = (Array.isArray(products) ? products : products.items || [])
    .flatMap((product) => (product.variants || []).filter((v) => v.status !== 'archived').map((v) => ({ ...v, productName: product.name, productUnit: product.unit })))
    .filter((v) => !filter || `${v.productName} ${v.size || ''} ${v.color || ''} ${v.sku || ''} ${v.barcode || ''}`.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => (a.stockQuantity > 0) === (b.stockQuantity > 0) ? a.productName.localeCompare(b.productName) : (a.stockQuantity > 0 ? -1 : 1))
    .slice(0, 60);
  const inSale = (id) => lines.find((l) => l.variantId === id)?.quantity || 0;
  return <div className="btq-tiles-wrap">
    <div className="btq-tiles-head"><strong>{t('btq.tapToAdd')}</strong>
      <input type="search" value={filter} placeholder={t('btq.filterTiles')} aria-label={t('btq.filterTiles')} onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => { if (e.key !== 'Enter') return; const found = exact(filter); if (found.length === 1) { e.preventDefault(); onPick(found[0]); setFilter(''); } }} /></div>
    <div className="btq-tiles">
      {list.map((v) => <button key={v.id} type="button" className={`btq-tile${inSale(v.id) ? ' in-sale' : ''}`} disabled={disabled || v.stockQuantity <= inSale(v.id)} onClick={() => onPick(v)}>
        <strong>{fullName(v)}</strong>
        <span className="btq-tile-price">{money(v.sellingPrice)}</span>
        <small>{v.stockQuantity > 0 ? fill(t('btq.leftCount'), { count: qty(v.stockQuantity, v.productUnit) }) : t('btq.stockState.out')}</small>
        {inSale(v.id) > 0 && <span className="btq-tile-count" aria-label={fill(t('btq.inSaleCount'), { count: inSale(v.id) })}>{inSale(v.id)}</span>}
      </button>)}
    </div>
  </div>;
}

// The receipt the customer gets: on screen, and printed with the browser's
// own print dialog (the page's print stylesheet hides everything else).
function Receipt({ sale, language, onNew, onOpen }) {
  const { t } = useI18n();
  return <Panel title={fill(t('btq.receiptFor'), { number: sale.number })} action={onOpen ? t('btq.openSale') : null} onAction={onOpen}>
    <div className="btq-receipt" id="btq-receipt">
      <h3>{t('btq.title')}</h3>
      <p>{sale.number} · {formatDate(sale.soldOn, language)} · {sale.cashierName}</p>
      {sale.customerName && <p>{t('btq.customer')}: {sale.customerName}</p>}
      <table><thead><tr><th>{t('btq.item')}</th><th>{t('btq.qty')}</th><th>{t('btq.unitPrice')}</th><th>{t('btq.lineTotal')}</th></tr></thead>
        <tbody>{(sale.items || []).map((i) => <tr key={i.id}><td>{i.productName} {variantLabel(i) && `(${variantLabel(i)})`}</td><td>{i.quantity}</td><td>{money(i.unitPrice)}</td><td>{money(i.lineTotal)}</td></tr>)}</tbody></table>
      <div className="btq-receipt-totals">
        {sale.discount > 0 && <p>{t('btq.discount')}: {money(sale.discount)}</p>}
        <p><strong>{t('btq.total')}: {money(sale.total)}</strong></p>
        {(sale.payments || []).map((p) => <p key={p.id}>{t(`btq.method.${p.method}`)}: {money(p.amount)}{p.reference && ` (${p.reference})`}</p>)}
        {sale.changeGiven > 0 && <p>{t('btq.change')}: {money(sale.changeGiven)}</p>}
      </div>
      <p className="btq-receipt-thanks">{t('btq.thanks')}</p>
    </div>
    <div className="button-row">
      <button type="button" className="secondary-btn" onClick={() => window.print()}>{t('btq.print')}</button>
      {onNew && <button type="button" className="primary-btn" onClick={onNew}>{t('btq.newSale')}</button>}
    </div>
  </Panel>;
}

// ---- sales --------------------------------------------------------------------------

function SalesTab({ fetchJson, onMessage, onError, changed, can, go, query }) {
  const { t, language } = useI18n();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [tick, setTick] = useState(0);
  const path = `/api/boutique/sales?limit=200${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}${status ? `&status=${status}` : ''}${search ? `&search=${encodeURIComponent(search)}` : ''}`;
  const [sales] = useLoad(fetchJson, path, tick, onError);
  const openId = query.get('sale');
  const refresh = () => { setTick((n) => n + 1); changed(); };
  return <>
    {openId && <SaleDetail saleId={openId} fetchJson={fetchJson} onMessage={onMessage} onError={onError} can={can} onClose={() => go('sales')} onChanged={refresh} />}
    <Panel title={t('btq.tab.sales')} subtitle={sales ? String(sales.length) : ''}>
      <div className="filter-grid">
        <Field label={t('btq.from')}><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label={t('btq.to')}><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label={t('field.status')}><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">{t('btq.all')}</option>{['completed', 'void_requested', 'voided'].map((s) => <option key={s} value={s}>{t(`btq.saleStatus.${s}`)}</option>)}</select></Field>
        <Field label={t('btq.search')}><input type="search" value={search} onChange={(e) => setSearch(e.target.value)} /></Field>
      </div>
      {sales?.length ? <div className="table-wrap"><table className="card-table">
        <thead><tr><th>{t('btq.number')}</th><th>{t('table.date')}</th><th>{t('btq.cashier')}</th><th>{t('btq.customer')}</th><th>{t('btq.items')}</th><th>{t('btq.total')}</th><th>{t('field.status')}</th></tr></thead>
        <tbody>{sales.map((s) => <tr key={s.id} className="clickable-row" onClick={() => go('sales', { sale: s.id })}>
          <td className="card-title-cell"><strong>{s.number}</strong></td>
          <td data-label={t('table.date')}>{formatDate(s.soldOn, language)}</td>
          <td data-label={t('btq.cashier')}>{s.cashierName}</td>
          <td data-label={t('btq.customer')}>{s.customerName || '—'}</td>
          <td data-label={t('btq.items')}>{s.itemCount}</td>
          <td data-label={t('btq.total')}>{money(s.total)}</td>
          <td data-label={t('field.status')}><Badge tone={SALE_TONE[s.status]}>{t(`btq.saleStatus.${s.status}`)}</Badge></td>
        </tr>)}</tbody>
      </table></div> : <Empty>{t('btq.noSales')}</Empty>}
    </Panel>
  </>;
}

function SaleDetail({ saleId, fetchJson, onMessage, onError, can, onClose, onChanged }) {
  const { t, language } = useI18n();
  const dialog = useDialog();
  const [busy, run] = useBusy();
  const [tick, setTick] = useState(0);
  const [sale] = useLoad(fetchJson, `/api/boutique/sales/${encodeURIComponent(saleId)}`, tick, onError);
  const [returning, setReturning] = useState(false);
  const [showReceipt, setShowReceipt] = useState(false);
  const refresh = () => { setTick((n) => n + 1); onChanged(); };

  const askVoid = () => run(async () => {
    const reason = await dialog.prompt({ title: t('btq.voidSale'), label: t('btq.reason'), message: t('btq.voidHint'), required: true, minLength: 10, multiline: true });
    if (reason === null) return;
    try {
      const result = await fetchJson(`/api/boutique/sales/${sale.id}/void`, { method: 'POST', body: JSON.stringify({ reason }) });
      onMessage(result.status === 'voided' ? t('btq.voided') : t('btq.voidAsked'));
      refresh();
    } catch (error) { onError(error.message); }
  });
  const decideVoid = (approve) => run(async () => {
    const note = approve ? '' : await dialog.prompt({ title: t('btq.refuseVoid'), label: t('btq.reason'), required: true, minLength: 10, multiline: true });
    if (note === null) return;
    try {
      await fetchJson(`/api/boutique/sales/${sale.id}/void-decision`, { method: 'POST', body: JSON.stringify({ approve, note }) });
      onMessage(approve ? t('btq.voided') : t('btq.voidRefused'));
      refresh();
    } catch (error) { onError(error.message); }
  });

  if (!sale) return <DetailView onClose={onClose} label={t('btq.tab.sales')}><div className="loading-state"><span className="spinner" /></div></DetailView>;
  const returnable = sale.status === 'completed' && sale.items.some((i) => i.returnedQuantity < i.quantity);
  return <DetailView onClose={onClose} label={sale.number}>
    <section className="panel detail-panel">
      <div className="panel-header"><div><h2>{sale.number}</h2><span>{formatDate(sale.soldOn, language)} · {sale.cashierName}</span></div>
        <button className="text-btn" type="button" onClick={onClose}>{t('action.close')}</button></div>
      <div className="detail-facts">
        <Fact label={t('field.status')} value={<Badge tone={SALE_TONE[sale.status]}>{t(`btq.saleStatus.${sale.status}`)}</Badge>} />
        <Fact label={t('btq.total')} value={money(sale.total)} />
        <Fact label={t('btq.paid')} value={money(sale.paid)} />
        <Fact label={t('btq.change')} value={money(sale.changeGiven)} />
        <Fact label={t('btq.customer')} value={sale.customerName || '—'} />
        {sale.exchangeOfReturnId && <Fact label={t('btq.exchangeOf')} value={t('btq.yes')} />}
      </div>
      {sale.voidReason && <p className="admin-note"><strong>{t('btq.voidReason')}:</strong> {sale.voidReason}</p>}
      <div className="table-wrap"><table className="card-table">
        <thead><tr><th>{t('btq.item')}</th><th>{t('btq.qty')}</th><th>{t('btq.unitPrice')}</th><th>{t('btq.lineDiscount')}</th><th>{t('btq.lineTotal')}</th><th>{t('btq.returned')}</th></tr></thead>
        <tbody>{sale.items.map((i) => <tr key={i.id}>
          <td className="card-title-cell"><strong>{i.productName}</strong><small>{i.sku} {variantLabel(i)}</small></td>
          <td data-label={t('btq.qty')}>{i.quantity}</td><td data-label={t('btq.unitPrice')}>{money(i.unitPrice)}</td>
          <td data-label={t('btq.lineDiscount')}>{money(i.discount)}</td><td data-label={t('btq.lineTotal')}>{money(i.lineTotal)}</td>
          <td data-label={t('btq.returned')}>{i.returnedQuantity}</td>
        </tr>)}</tbody>
      </table></div>
      <h3 className="form-section-title">{t('btq.payment')}</h3>
      <ul className="history-list">{sale.payments.map((p) => <li key={p.id}>{t(`btq.method.${p.method}`)}: {money(p.amount)}{p.reference && ` (${p.reference})`}</li>)}</ul>
      {sale.returns.length > 0 && <>
        <h3 className="form-section-title">{t('btq.returns')}</h3>
        <ul className="history-list">{sale.returns.map((r) => <li key={r.id}>
          <strong>{r.number}</strong> · {t(`btq.returnKind.${r.kind}`)} · {money(r.value)}
          {r.refundTotal > 0 && ` · ${fill(t('btq.refundedBy'), { amount: money(r.refundTotal), method: t(`btq.method.${r.refundMethod}`) })}`}
          {r.exchangeSaleNumber && ` · ${fill(t('btq.newSaleNumber'), { number: r.exchangeSaleNumber })}`} — {r.reason}
        </li>)}</ul>
      </>}
      <div className="button-row">
        <button type="button" className="secondary-btn" onClick={() => setShowReceipt((s) => !s)}>{t('btq.receipt')}</button>
        {can.sell && returnable && <button type="button" className="secondary-btn" disabled={busy} onClick={() => setReturning((r) => !r)}>{t('btq.returnOrExchange')}</button>}
        {can.manage && sale.status === 'completed' && <button type="button" className="danger-btn" disabled={busy} onClick={askVoid}>{t('btq.voidSale')}</button>}
        {can.decide && sale.status === 'void_requested' && <>
          <button type="button" className="primary-btn" disabled={busy} onClick={() => decideVoid(true)}>{t('btq.approveVoid')}</button>
          <button type="button" className="danger-btn" disabled={busy} onClick={() => decideVoid(false)}>{t('btq.refuseVoid')}</button>
        </>}
      </div>
      {showReceipt && <Receipt sale={sale} language={language} />}
      {returning && <ReturnForm sale={sale} fetchJson={fetchJson} can={can} busy={busy} run={run} onMessage={onMessage} onError={onError} onDone={() => { setReturning(false); refresh(); }} />}
    </section>
  </DetailView>;
}

function ReturnForm({ sale, fetchJson, can, busy, run, onMessage, onError, onDone }) {
  const { t } = useI18n();
  const [methods] = useLoad(fetchJson, '/api/boutique/payment-methods', 0, onError);
  const [quantities, setQuantities] = useState({});
  const [restock, setRestock] = useState({});
  const [reason, setReason] = useState('');
  const [refundMethod, setRefundMethod] = useState('Cash');
  const [exchange, setExchange] = useState(false);
  const [newLines, setNewLines] = useState([]);
  const [newPayments, setNewPayments] = useState([{ method: 'Cash', amount: '' }]);
  const activeMethods = (methods || []).filter((m) => m.active).map((m) => m.code);
  const value = sale.items.reduce((sum, i) => sum + Math.round(toMinor(i.lineTotal) / i.quantity) * (Number(quantities[i.id]) || 0), 0);
  const newTotal = saleTotals(newLines, 0).total;
  const credit = exchange ? Math.min(value, newTotal) : 0;
  const refund = value - credit;
  const stillToPay = Math.max(0, newTotal - credit);

  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      try {
        const body = {
          items: sale.items.filter((i) => Number(quantities[i.id]) > 0).map((i) => ({ saleItemId: i.id, quantity: Number(quantities[i.id]), restock: restock[i.id] !== false })),
          reason, refundMethod,
          exchange: exchange ? { items: newLines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })), payments: newPayments.filter((p) => Number(p.amount) > 0) } : undefined
        };
        const result = await fetchJson(`/api/boutique/sales/${sale.id}/returns`, { method: 'POST', body: JSON.stringify(body) });
        onMessage(result.exchangeSale ? fill(t('btq.exchangeDone'), { number: result.exchangeSale.number }) : t('btq.returnDone'));
        onDone();
      } catch (error) { onError(error.message); }
    });
  };
  return <form className="decision-form" onSubmit={submit}>
    <h3 className="form-section-title">{t('btq.returnOrExchange')}</h3>
    <div className="table-wrap"><table className="card-table">
      <thead><tr><th>{t('btq.item')}</th><th>{t('btq.canReturn')}</th><th>{t('btq.returnQty')}</th><th>{t('btq.backOnShelf')}</th></tr></thead>
      <tbody>{sale.items.map((i) => <tr key={i.id}>
        <td className="card-title-cell"><strong>{i.productName}</strong><small>{i.sku} {variantLabel(i)}</small></td>
        <td data-label={t('btq.canReturn')}>{i.quantity - i.returnedQuantity}</td>
        <td data-label={t('btq.returnQty')}><input type="number" min="0" max={i.quantity - i.returnedQuantity} value={quantities[i.id] || ''} aria-label={t('btq.returnQty')} onChange={(e) => setQuantities({ ...quantities, [i.id]: e.target.value })} /></td>
        {/* Keeping a returned item off the shelf is a write-off: the manager's
            choice, not the till's. A cashier's return always restocks. */}
        <td data-label={t('btq.backOnShelf')}>{can.manage
          ? <input type="checkbox" checked={restock[i.id] !== false} aria-label={t('btq.backOnShelf')} onChange={(e) => setRestock({ ...restock, [i.id]: e.target.checked })} />
          : t('btq.yes')}</td>
      </tr>)}</tbody>
    </table></div>
    <div className="form-grid">
      <Field label={t('btq.reason')} wide><input required minLength="3" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <label className="check-field"><input type="checkbox" checked={exchange} onChange={(e) => setExchange(e.target.checked)} /><span>{t('btq.exchangeInstead')}</span></label>
    </div>
    {exchange && <>
      <VariantSearch fetchJson={fetchJson} onPick={(v) => setNewLines((c) => (c.some((l) => l.variantId === v.id) ? c : [...c, { variantId: v.id, name: fullName(v), quantity: 1, unitPrice: v.sellingPrice }]))} />
      {newLines.length > 0 && <ul className="history-list">{newLines.map((l) => <li key={l.variantId}>
        {l.name} × <input type="number" min="1" value={l.quantity} aria-label={t('btq.qty')} onChange={(e) => setNewLines(newLines.map((x) => (x.variantId === l.variantId ? { ...x, quantity: Math.max(1, Number(e.target.value) || 1) } : x)))} /> · {money(l.unitPrice)}
        <button type="button" className="text-btn" onClick={() => setNewLines(newLines.filter((x) => x.variantId !== l.variantId))}>{t('action.remove')}</button>
      </li>)}</ul>}
      <div className="btq-totals">
        <Fact label={t('btq.newSaleTotal')} value={money(fromMinor(newTotal))} />
        <Fact label={t('btq.creditApplied')} value={money(fromMinor(credit))} />
        <Fact label={t('btq.stillToPay')} value={money(fromMinor(stillToPay))} />
      </div>
      {stillToPay > 0 && newPayments.map((p, index) => <div className="form-grid" key={index}>
        <Field label={t('btq.method')}><select value={p.method} onChange={(e) => setNewPayments(newPayments.map((x, i) => (i === index ? { ...x, method: e.target.value } : x)))}>{activeMethods.map((code) => <option key={code} value={code}>{t(`btq.method.${code}`)}</option>)}</select></Field>
        <Field label={t('btq.amount')}><input type="number" min="0" value={p.amount} onChange={(e) => setNewPayments(newPayments.map((x, i) => (i === index ? { ...x, amount: e.target.value } : x)))} /></Field>
      </div>)}
    </>}
    <div className="btq-totals">
      <Fact label={t('btq.returnValue')} value={money(fromMinor(value))} />
      <Fact label={t('btq.refund')} value={money(fromMinor(refund))} />
    </div>
    {refund > 0 && <Field label={t('btq.refundMethod')}><select value={refundMethod} onChange={(e) => setRefundMethod(e.target.value)}>{BOUTIQUE_PAYMENT_METHODS.map((m) => <option key={m} value={m}>{t(`btq.method.${m}`)}</option>)}</select></Field>}
    <div className="form-submit-bar"><button className="primary-btn" type="submit" disabled={busy || value <= 0 || (exchange && !newLines.length)}>{exchange ? t('btq.recordExchange') : t('btq.recordReturn')}</button></div>
    {!can.manage && <p className="field-hint">{t('btq.cashierReturnHint')}</p>}
  </form>;
}

// ---- products ------------------------------------------------------------------------

const emptyVariant = () => ({ sku: '', barcode: '', size: '', color: '', costPrice: '', sellingPrice: '', reorderLevel: '0', openingStock: '0' });

// A key per opened form, sent with the save so a second press of the same
// button is recognised by the API instead of adding the product (or the
// stock) twice. randomUUID needs a secure page; the fallback is for an old
// browser on plain http, where uniqueness only has to hold for one form.
export function newRequestKey() {
  try { if (window.crypto?.randomUUID) return window.crypto.randomUUID(); } catch { /* fall through */ }
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// The simple product form: what a shopkeeper knows about a product when it
// arrives -- its name, what kind of thing it is, how many there are and what
// one sells for. Everything else is folded under "More details" and optional.
const emptyProduct = () => ({
  name: '', productType: 'groceries', quantity: '', unit: '', price: '', costPrice: '', reorderLevel: '',
  barcode: '', sku: '', brand: '', description: '', requestKey: newRequestKey()
});

// The checks the API makes, made first here so the message sits beside the
// field it is about and nothing typed is lost. The API still decides.
function productProblems(form, t) {
  const problems = {};
  const whole = (value) => value === '' || (Number.isInteger(Number(value)) && Number(value) >= 0);
  if (!form.name.trim()) problems.name = t('btq.err.name');
  if (form.price === '' || !(Number(form.price) >= 0)) problems.price = t('btq.err.price');
  if (form.quantity === '' || !whole(form.quantity)) problems.quantity = t('btq.err.quantity');
  if (form.costPrice === '' || !(Number(form.costPrice) >= 0)) problems.costPrice = t('btq.err.buyingPrice');
  if (!whole(form.reorderLevel)) problems.reorderLevel = t('btq.err.quantity');
  if (!form.unit.trim()) problems.unit = t('btq.err.unit');
  return problems;
}

// Stock status in words as well as colour, so it reads the same on a
// black-and-white printout and to somebody who cannot tell red from green.
export function stockStatus(quantity, reorderLevel) {
  if (Number(quantity) <= 0) return { key: 'out', tone: 'stopped' };
  if (Number(quantity) <= Number(reorderLevel || 0)) return { key: 'low', tone: 'waiting' };
  return { key: 'ok', tone: 'done' };
}

function FieldError({ children }) {
  return children ? <small className="field-error" role="alert">{children}</small> : null;
}

function ProductsTab({ fetchJson, upload, onMessage, onError, changed, can, go, query }) {
  const { t } = useI18n();
  const dialog = useDialog();
  const [busy, run] = useBusy();
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('active');
  const [tick, setTick] = useState(0);
  const [products] = useLoad(fetchJson, `/api/boutique/products?status=${status}${type ? `&type=${type}` : ''}${search ? `&search=${encodeURIComponent(search)}` : ''}`, tick, onError);
  const [form, setForm] = useState(emptyProduct);
  const [problems, setProblems] = useState({});
  const openId = query.get('product');
  const adding = query.get('add') === '1';
  const refresh = () => { setTick((n) => n + 1); changed(); };
  const set = (patch) => { setForm({ ...form, ...patch }); setProblems({}); };

  const submit = (e) => {
    e.preventDefault();
    const found = productProblems(form, t);
    setProblems(found);
    if (Object.keys(found).length) return;
    run(async () => {
      try {
        const created = await fetchJson('/api/boutique/products', {
          method: 'POST',
          body: JSON.stringify({
            name: form.name, productType: form.productType, unit: form.unit, brand: form.brand, description: form.description, requestKey: form.requestKey,
            variants: [{ sku: form.sku, barcode: form.barcode, sellingPrice: form.price, costPrice: form.costPrice || 0, reorderLevel: form.reorderLevel || 0, openingStock: form.quantity }]
          })
        });
        onMessage(fill(t('btq.productAdded'), { name: created.name }));
        // Only a save that worked clears the form; a refusal keeps every field.
        setForm(emptyProduct());
        refresh();
        go('products');
      } catch (error) { onError(error.message); }
    });
  };

  // Changing the price of a one-version product straight from the list. A
  // product with several versions opens, because "which one?" needs the list.
  const changePrice = (product) => run(async () => {
    const variant = product.variants[0];
    const typed = await dialog.prompt({
      title: fill(t('btq.changePriceFor'), { name: product.name }),
      label: fill(t('btq.newPriceLabel'), { current: money(variant.sellingPrice) }),
      initialValue: String(variant.sellingPrice), required: true
    });
    if (typed === null) return;
    if (!(Number(typed) >= 0) || typed.trim() === '') { onError(t('btq.err.price')); return; }
    try {
      await fetchJson(`/api/boutique/variants/${variant.id}`, { method: 'PUT', body: JSON.stringify({ sellingPrice: typed }) });
      onMessage(fill(t('btq.priceChanged'), { name: product.name, price: money(typed) }));
      refresh();
    } catch (error) { onError(error.message); }
  });

  return <>
    {/* The usual units, offered by every "Counted in" box on this tab. */}
    <datalist id="btq-units">{UNIT_SUGGESTIONS.map((u) => <option key={u} value={t(`btq.unit.${u}`)} />)}</datalist>
    {openId && <ProductDetail productId={openId} fetchJson={fetchJson} upload={upload} onMessage={onMessage} onError={onError} can={can} onClose={() => go('products')} onChanged={refresh} go={go} />}
    <section className="toolbar-row">
      <div className="filter-group">
        <input type="search" value={search} placeholder={t('btq.searchProducts')} aria-label={t('btq.searchProducts')} onChange={(e) => setSearch(e.target.value)} />
        <select value={type} aria-label={t('btq.productType')} onChange={(e) => setType(e.target.value)}><option value="">{t('btq.allTypes')}</option>{PRODUCT_CATEGORIES.map((p) => <option key={p} value={p}>{t(`btq.type.${p}`)}</option>)}</select>
        <select value={status} aria-label={t('field.status')} onChange={(e) => setStatus(e.target.value)}><option value="active">{t('btq.activeOnly')}</option><option value="all">{t('btq.all')}</option></select>
      </div>
      {can.manage && <button className="primary-btn big-action" type="button" onClick={() => go('products', { add: adding ? undefined : '1' })}>{t('btq.addProduct')}</button>}
    </section>
    {can.manage && adding && <form className="form-panel" onSubmit={submit} noValidate>
      <div className="panel-header"><div><h2>{t('btq.addProduct')}</h2><span>{t('btq.addProductBlurb')}</span></div></div>
      <div className="form-grid">
        <Field label={`${t('btq.productName')} *`}>
          <input maxLength="200" value={form.name} placeholder={t('btq.productNameExample')} aria-invalid={Boolean(problems.name)} onChange={(e) => set({ name: e.target.value })} />
          <FieldError>{problems.name}</FieldError>
        </Field>
        <Field label={`${t('btq.productType')} *`}>
          <select value={form.productType} onChange={(e) => set({ productType: e.target.value })}>{PRODUCT_CATEGORIES.map((p) => <option key={p} value={p}>{t(`btq.type.${p}`)}</option>)}</select>
        </Field>
        {/* The buying price is on the form itself, not folded away: without
            it the shop cannot work out its profit. */}
        <Field label={`${t('btq.buyingPrice')} (RWF) *`}>
          <input type="number" inputMode="decimal" min="0" step="1" value={form.costPrice} placeholder="200" aria-invalid={Boolean(problems.costPrice)} onChange={(e) => set({ costPrice: e.target.value })} />
          <small className="field-hint">{t('btq.buyingPriceHint')}</small>
          <FieldError>{problems.costPrice}</FieldError>
        </Field>
        <Field label={`${t('btq.sellingPricePerUnit')} (RWF) *`}>
          <input type="number" inputMode="decimal" min="0" step="1" value={form.price} placeholder="300" aria-invalid={Boolean(problems.price)} onChange={(e) => set({ price: e.target.value })} />
          <small className="field-hint">{t('btq.pricePerUnitHint')}</small>
          <FieldError>{problems.price}</FieldError>
        </Field>
        <Field label={`${t('btq.quantityInStock')} *`}>
          <input type="number" inputMode="numeric" min="0" step="1" value={form.quantity} placeholder="40" aria-invalid={Boolean(problems.quantity)} onChange={(e) => set({ quantity: e.target.value })} />
          <small className="field-hint">{t('btq.quantityInStockHint')}</small>
          <FieldError>{problems.quantity}</FieldError>
        </Field>
        {/* What the quantity is counted in, right beside it: 50 kg of sugar,
            40 bottles of water. Typed freely, with the usual ones offered. */}
        <Field label={`${t('btq.countedIn')} *`}>
          <input list="btq-units" maxLength="30" value={form.unit} placeholder={t('btq.countedInExample')} aria-invalid={Boolean(problems.unit)} onChange={(e) => set({ unit: e.target.value })} />
          <small className="field-hint">{t('btq.countedInHint')}</small>
          <FieldError>{problems.unit}</FieldError>
        </Field>
      </div>
      {/* The profit one piece makes, worked out as it is typed. */}
      {form.price !== '' && form.costPrice !== '' && Number(form.price) >= 0 && Number(form.costPrice) >= 0 && <p className="field-hint">
        {fill(t('btq.profitPerUnit'), { amount: money(Number(form.price) - Number(form.costPrice)) })}
      </p>}
      <details className="form-more">
        <summary>{t('btq.moreDetails')}</summary>
        <div className="form-grid">
          <Field label={`${t('btq.lowStockAt')} ${t('btq.optional')}`}>
            <input type="number" inputMode="numeric" min="0" step="1" value={form.reorderLevel} placeholder="5" onChange={(e) => set({ reorderLevel: e.target.value })} />
            <small className="field-hint">{t('btq.lowStockAtHint')}</small>
            <FieldError>{problems.reorderLevel}</FieldError>
          </Field>
          <Field label={`${t('btq.barcode')} ${t('btq.optional')}`}><input maxLength="60" value={form.barcode} onChange={(e) => set({ barcode: e.target.value })} /></Field>
          <Field label={`${t('btq.sku')} ${t('btq.optional')}`}><input maxLength="60" value={form.sku} onChange={(e) => set({ sku: e.target.value })} /><small className="field-hint">{t('btq.skuHint')}</small></Field>
          <Field label={`${t('btq.brand')} ${t('btq.optional')}`}><input maxLength="100" value={form.brand} onChange={(e) => set({ brand: e.target.value })} /></Field>
          <Field label={`${t('field.description')} ${t('btq.optional')}`} wide><textarea rows="2" maxLength="2000" value={form.description} onChange={(e) => set({ description: e.target.value })} /></Field>
        </div>
      </details>
      <p className="field-hint">{t('btq.requiredHint')}</p>
      <div className="form-submit-bar">
        <button type="button" className="text-btn" onClick={() => go('products')}>{t('action.cancel')}</button>
        <button className="primary-btn big-action" type="submit" disabled={busy}>{t('btq.saveProduct')}</button>
      </div>
    </form>}
    <Panel title={t('btq.catalogue')} subtitle={products ? String(products.length) : ''}>
      {!products ? <div className="compact-loading"><span className="spinner" /></div> : products.length ? <div className="table-wrap"><table className="card-table">
        <thead><tr><th>{t('btq.product')}</th><th>{t('btq.productType')}</th><th>{t('btq.inStock')}</th><th>{t('btq.pricePerUnit')}</th><th>{t('btq.stockStatus')}</th>{can.manage && <th>{t('table.actions')}</th>}</tr></thead>
        <tbody>{products.map((p) => {
          const prices = p.variants.map((v) => Number(v.sellingPrice));
          const lowest = prices.length ? Math.min(...prices) : 0;
          const level = Math.max(0, ...p.variants.map((v) => Number(v.reorderLevel || 0)));
          const state = p.status === 'active' ? stockStatus(p.stockQuantity, p.variants.length === 1 ? p.variants[0].reorderLevel : level) : null;
          return <tr key={p.id}>
            <td className="card-title-cell"><button type="button" className="text-btn" onClick={() => go('products', { product: p.id })}><strong>{p.name}</strong></button>
              {p.variants.length > 1 && <small>{fill(t('btq.versionsCount'), { count: p.variants.length })}</small>}</td>
            <td data-label={t('btq.productType')}>{t(`btq.type.${p.productType}`)}</td>
            <td data-label={t('btq.inStock')}>{qty(p.stockQuantity, p.unit)}</td>
            <td data-label={t('btq.pricePerUnit')}>{p.variants.length > 1 && new Set(prices).size > 1 ? fill(t('btq.priceFrom'), { price: money(lowest) }) : money(lowest)}</td>
            <td data-label={t('btq.stockStatus')}>{state
              ? <Badge tone={state.tone}>{t(`btq.stockState.${state.key}`)}</Badge>
              : <Badge tone="stopped">{t(`btq.itemStatus.${p.status}`)}</Badge>}</td>
            {can.manage && <td className="card-actions">
              {p.variants.length === 1
                ? <button type="button" className="secondary-btn" disabled={busy} onClick={() => changePrice(p)}>{t('btq.changePrice')}</button>
                : <button type="button" className="secondary-btn" onClick={() => go('products', { product: p.id })}>{t('btq.changePrice')}</button>}
              <button type="button" className="secondary-btn" onClick={() => go('stock', p.variants.length === 1 ? { variant: p.variants[0].id } : {})}>{t('btq.updateStock')}</button>
            </td>}
          </tr>;
        })}</tbody>
      </table></div> : <div className="empty-state"><strong>{t('btq.noProducts')}</strong>{can.manage && <span>{t('btq.noProductsHint')}</span>}</div>}
    </Panel>
  </>;
}

function ProductDetail({ productId, fetchJson, upload, onMessage, onError, can, onClose, onChanged, go }) {
  const { t } = useI18n();
  const [busy, run] = useBusy();
  const [tick, setTick] = useState(0);
  const [product] = useLoad(fetchJson, `/api/boutique/products/${encodeURIComponent(productId)}`, tick, onError);
  const [form, setForm] = useState(null);
  const [editingVariant, setEditingVariant] = useState(null);
  const [newVariant, setNewVariant] = useState(null);
  const [imageUrl, setImageUrl] = useState('');
  const refresh = () => { setTick((n) => n + 1); onChanged(); };
  useEffect(() => { if (product) setForm({ name: product.name, productType: product.productType, unit: product.unit || '', category: product.category, brand: product.brand, description: product.description, status: product.status }); }, [product]);
  // The picture is fetched with the session header and shown from a blob
  // URL, so no token ever sits in an <img src>.
  useEffect(() => {
    let url = '';
    let cancelled = false;
    if (product?.hasImage) {
      fetch(`/api/boutique/products/${product.id}/image`, { headers: { Authorization: `Bearer ${localStorage.getItem('ops-token') || ''}` } })
        .then((r) => (r.ok ? r.blob() : null)).then((blob) => { if (blob && !cancelled) { url = URL.createObjectURL(blob); setImageUrl(url); } }).catch(() => {});
    } else setImageUrl('');
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [product]);

  const dialog = useDialog();
  const save = (e) => { e.preventDefault(); run(async () => { try { await fetchJson(`/api/boutique/products/${product.id}`, { method: 'PUT', body: JSON.stringify(form) }); onMessage(t('btq.saved')); refresh(); } catch (error) { onError(error.message); } }); };
  // The price alone, shown beside the one it replaces. Only the selling
  // price is sent, so nothing else on the version can be changed by accident,
  // and sales already made keep the price they were rung up at.
  const changePrice = (v) => run(async () => {
    const typed = await dialog.prompt({
      title: fill(t('btq.changePriceFor'), { name: `${product.name}${variantLabel(v) ? ` (${variantLabel(v)})` : ''}` }),
      label: fill(t('btq.newPriceLabel'), { current: money(v.sellingPrice) }),
      initialValue: String(v.sellingPrice), required: true
    });
    if (typed === null) return;
    if (typed.trim() === '' || !(Number(typed) >= 0)) { onError(t('btq.err.price')); return; }
    try {
      await fetchJson(`/api/boutique/variants/${v.id}`, { method: 'PUT', body: JSON.stringify({ sellingPrice: typed }) });
      onMessage(fill(t('btq.priceChanged'), { name: product.name, price: money(typed) }));
      refresh();
    } catch (error) { onError(error.message); }
  });
  const saveVariant = (e) => { e.preventDefault(); run(async () => { try { await fetchJson(`/api/boutique/variants/${editingVariant.id}`, { method: 'PUT', body: JSON.stringify(editingVariant) }); setEditingVariant(null); onMessage(t('btq.saved')); refresh(); } catch (error) { onError(error.message); } }); };
  const addVariant = (e) => { e.preventDefault(); run(async () => { try { await fetchJson(`/api/boutique/products/${product.id}/variants`, { method: 'POST', body: JSON.stringify(newVariant) }); setNewVariant(null); onMessage(t('btq.saved')); refresh(); } catch (error) { onError(error.message); } }); };
  const pickImage = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    run(async () => {
      try {
        const data = new FormData();
        data.append('file', file);
        await upload(`/api/boutique/products/${product.id}/image`, data);
        onMessage(t('btq.saved'));
        refresh();
      } catch (error) { onError(error.message); }
    });
  };

  if (!product || !form) return <DetailView onClose={onClose} label={t('btq.product')}><div className="loading-state"><span className="spinner" /></div></DetailView>;
  return <DetailView onClose={onClose} label={product.name}>
    <section className="panel detail-panel">
      <div className="panel-header"><div><h2>{product.name}</h2><span>{t(`btq.type.${product.productType}`)}{product.brand && ` · ${product.brand}`}</span></div>
        <button className="text-btn" type="button" onClick={onClose}>{t('action.close')}</button></div>
      <div className="btq-product-top">
        <div className="btq-image">{imageUrl ? <img src={imageUrl} alt={product.name} /> : <span className="muted-cell">{t('btq.noPicture')}</span>}
          {can.manage && <label className="secondary-btn btq-upload"><span>{t('btq.choosePicture')}</span><input type="file" accept="image/*" hidden disabled={busy} onChange={pickImage} /></label>}
        </div>
        {can.manage ? <form className="form-grid" onSubmit={save}>
          <Field label={t('field.name')}><input required maxLength="200" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label={t('btq.productType')}><select value={form.productType} onChange={(e) => setForm({ ...form, productType: e.target.value })}>{(PRODUCT_CATEGORIES.includes(form.productType) ? PRODUCT_CATEGORIES : [...PRODUCT_CATEGORIES, form.productType]).map((p) => <option key={p} value={p}>{t(`btq.type.${p}`)}</option>)}</select></Field>
          <Field label={t('btq.countedIn')}><input list="btq-units" maxLength="30" value={form.unit} placeholder={t('btq.countedInExample')} onChange={(e) => setForm({ ...form, unit: e.target.value })} /></Field>
          <Field label={t('field.category')}><input maxLength="100" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></Field>
          <Field label={t('btq.brand')}><input maxLength="100" value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} /></Field>
          <Field label={t('field.status')}><select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}><option value="active">{t('btq.itemStatus.active')}</option><option value="archived">{t('btq.itemStatus.archived')}</option></select></Field>
          <Field label={t('field.description')} wide><textarea rows="2" maxLength="2000" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <div className="form-submit-bar"><button className="primary-btn" type="submit" disabled={busy}>{t('btq.save')}</button></div>
        </form> : <div className="detail-facts">
          <Fact label={t('field.category')} value={product.category || '—'} />
          <Fact label={t('field.description')} value={product.description || '—'} />
          <Fact label={t('field.status')} value={t(`btq.itemStatus.${product.status}`)} />
        </div>}
      </div>
      <h3 className="form-section-title">{t('btq.variants')}</h3>
      <div className="table-wrap"><table className="card-table">
        <thead><tr><th>{t('btq.sku')}</th><th>{t('btq.size')}</th><th>{t('btq.color')}</th><th>{t('btq.costPrice')}</th><th>{t('btq.sellingPrice')}</th><th>{t('btq.stock')}</th><th>{t('btq.reorderLevel')}</th><th>{t('field.status')}</th>{can.manage && <th>{t('table.actions')}</th>}</tr></thead>
        <tbody>{product.variants.map((v) => <tr key={v.id} className={v.lowStock ? 'btq-low' : undefined}>
          <td className="card-title-cell"><strong>{v.sku}</strong><small>{v.barcode}</small></td>
          <td data-label={t('btq.size')}>{v.size || '—'}</td><td data-label={t('btq.color')}>{v.color || '—'}</td>
          <td data-label={t('btq.costPrice')}>{v.costPrice === undefined ? '—' : money(v.costPrice)}</td><td data-label={t('btq.sellingPrice')}>{money(v.sellingPrice)}</td>
          <td data-label={t('btq.stock')}>{v.stockQuantity}</td><td data-label={t('btq.reorderLevel')}>{v.reorderLevel}</td>
          <td data-label={t('field.status')}>{t(`btq.itemStatus.${v.status}`)}</td>
          {can.manage && <td className="card-actions">
            <button type="button" className="secondary-btn" disabled={busy} onClick={() => changePrice(v)}>{t('btq.changePrice')}</button>
            <button type="button" className="secondary-btn" onClick={() => go('stock', { variant: v.id })}>{t('btq.updateStock')}</button>
            <button type="button" className="text-btn" onClick={() => setEditingVariant({ id: v.id, sku: v.sku, barcode: v.barcode, size: v.size, color: v.color, costPrice: v.costPrice, sellingPrice: v.sellingPrice, reorderLevel: v.reorderLevel, status: v.status })}>{t('action.edit')}</button></td>}
        </tr>)}</tbody>
      </table></div>
      {can.manage && (editingVariant || newVariant) && <form className="decision-form" onSubmit={editingVariant ? saveVariant : addVariant}>
        <h3 className="form-section-title">{editingVariant ? t('btq.editVariant') : t('btq.addVariant')}</h3>
        <VariantFields value={editingVariant || newVariant} onChange={editingVariant ? setEditingVariant : setNewVariant} withOpening={!editingVariant} withStatus={Boolean(editingVariant)} />
        <div className="form-submit-bar">
          <button type="button" className="text-btn" onClick={() => { setEditingVariant(null); setNewVariant(null); }}>{t('action.cancel')}</button>
          <button className="primary-btn" type="submit" disabled={busy}>{t('btq.save')}</button>
        </div>
      </form>}
      {can.manage && !newVariant && !editingVariant && <div className="button-row"><button type="button" className="secondary-btn" onClick={() => setNewVariant(emptyVariant())}>{t('btq.addVariant')}</button></div>}
    </section>
  </DetailView>;
}

function VariantFields({ value, onChange, withOpening, withStatus }) {
  const { t } = useI18n();
  const set = (patch) => onChange({ ...value, ...patch });
  return <div className="form-grid">
    <Field label={t('btq.sku')}><input required maxLength="60" value={value.sku} onChange={(e) => set({ sku: e.target.value })} /></Field>
    <Field label={t('btq.barcode')}><input maxLength="60" value={value.barcode || ''} onChange={(e) => set({ barcode: e.target.value })} /></Field>
    <Field label={t('btq.size')}><input maxLength="40" value={value.size} onChange={(e) => set({ size: e.target.value })} /></Field>
    <Field label={t('btq.color')}><input maxLength="40" value={value.color} onChange={(e) => set({ color: e.target.value })} /></Field>
    <Field label={t('btq.costPrice')}><input type="number" min="0" step="1" required value={value.costPrice} onChange={(e) => set({ costPrice: e.target.value })} /></Field>
    <Field label={t('btq.sellingPrice')}><input type="number" min="0" step="1" required value={value.sellingPrice} onChange={(e) => set({ sellingPrice: e.target.value })} /></Field>
    <Field label={t('btq.reorderLevel')}><input type="number" min="0" step="1" value={value.reorderLevel} onChange={(e) => set({ reorderLevel: e.target.value })} /></Field>
    {withOpening && <Field label={t('btq.openingStock')}><input type="number" min="0" step="1" value={value.openingStock} onChange={(e) => set({ openingStock: e.target.value })} /></Field>}
    {withStatus && <Field label={t('field.status')}><select value={value.status} onChange={(e) => set({ status: e.target.value })}><option value="active">{t('btq.itemStatus.active')}</option><option value="archived">{t('btq.itemStatus.archived')}</option></select></Field>}
  </div>;
}

// ---- stock --------------------------------------------------------------------------

const emptyStockForm = () => ({ variant: null, kind: 'received', quantity: '', reason: '', requestKey: newRequestKey() });

// What the shelf will hold once this change is made, worked out the same way
// the API works it out (ADDING_ADJUSTMENTS, a count replaces). Null when the
// quantity is not a usable whole number yet.
function stockAfter(kind, quantity, onShelf) {
  if (quantity === '' || !Number.isInteger(Number(quantity)) || Number(quantity) < 0) return null;
  const n = Number(quantity);
  if (kind === 'count') return n;
  return ADDING_ADJUSTMENTS.includes(kind) ? onShelf + n : onShelf - n;
}

function StockTab({ fetchJson, onMessage, onError, changed, can, query }) {
  const { t, language } = useI18n();
  const [busy, run] = useBusy();
  const [search, setSearch] = useState('');
  const [low, setLow] = useState(false);
  const [tick, setTick] = useState(0);
  const [stock] = useLoad(fetchJson, `/api/boutique/stock?${low ? 'low=1&' : ''}${search ? `search=${encodeURIComponent(search)}` : ''}`, tick, onError);
  const [movements] = useLoad(fetchJson, '/api/boutique/stock/movements?limit=60', tick, onError);
  // The adjustments queue is the manager's and the Director's; a cashier is
  // refused it, so the screen does not ask.
  const [adjustments] = useLoad(fetchJson, can.role === 'cashier' ? null : '/api/boutique/stock/adjustments', tick, onError);
  const [form, setForm] = useState(emptyStockForm);
  const [problem, setProblem] = useState('');
  const refresh = () => { setTick((n) => n + 1); changed(); };
  // "Update stock" on a product opens this tab with ?variant=<id>: the item
  // is chosen already, so the only question left is what happened to it.
  const wanted = query?.get('variant');
  // "Stock came in" from Today opens straight on the form.
  const toForm = query?.get('update');
  useEffect(() => {
    if (toForm) document.getElementById('stock-update')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [toForm]);
  useEffect(() => {
    if (!wanted || !stock?.items) return;
    const found = stock.items.find((v) => String(v.id) === String(wanted));
    if (found) {
      setForm((current) => (current.variant?.id === found.id ? current : { ...current, variant: found }));
      document.getElementById('stock-update')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [wanted, stock]);
  const onShelf = form.variant ? Number(form.variant.stockQuantity) : 0;
  const after = form.variant ? stockAfter(form.kind, form.quantity, onShelf) : null;
  const needsReason = form.kind !== 'received';
  const submit = (e) => {
    e.preventDefault();
    if (!form.variant) { setProblem(t('btq.err.pickItem')); return; }
    if (after === null || (form.kind !== 'count' && Number(form.quantity) < 1)) { setProblem(t('btq.err.quantity')); return; }
    if (after < 0) { setProblem(fill(t('btq.err.notEnough'), { count: onShelf })); return; }
    if (needsReason && form.reason.trim().length < 5) { setProblem(t('btq.err.reason')); return; }
    setProblem('');
    run(async () => {
      try {
        const result = await fetchJson('/api/boutique/stock/adjustments', { method: 'POST', body: JSON.stringify({ variantId: form.variant.id, kind: form.kind, quantity: form.quantity, reason: form.reason, requestKey: form.requestKey }) });
        onMessage(result.status === 'approved'
          ? fill(t('btq.stockUpdated'), { name: fullName(form.variant), count: after })
          : t('btq.adjustmentAsked'));
        setForm(emptyStockForm());
        refresh();
      } catch (error) { onError(error.message); }
    });
  };
  return <>
    <Panel title={t('btq.tab.stock')} subtitle={stock ? (stock.value === null ? String(stock.pieces) : `${stock.pieces} · ${money(stock.value)}`) : ''}>
      <div className="filter-grid">
        <Field label={t('btq.search')}><input type="search" value={search} onChange={(e) => setSearch(e.target.value)} /></Field>
        <label className="check-field"><input type="checkbox" checked={low} onChange={(e) => setLow(e.target.checked)} /><span>{t('btq.lowStockOnly')}</span></label>
      </div>
      {stock?.items?.length ? <div className="table-wrap"><table className="card-table">
        <thead><tr><th>{t('btq.product')}</th><th>{t('btq.inStock')}</th><th>{t('btq.pricePerUnit')}</th>{can.manage && <th>{t('table.actions')}</th>}</tr></thead>
        <tbody>{stock.items.map((v) => {
          const state = stockStatus(v.stockQuantity, v.reorderLevel);
          return <tr key={v.id} className={state.key !== 'ok' ? 'btq-low' : undefined}>
            {/* Name, how many, whether that is enough, the price: what a
                shopkeeper looks for. The rest is small print under the name. */}
            <td className="card-title-cell"><strong>{fullName(v)}</strong>
              <small>{t(`btq.type.${v.productType}`)} · {fill(t('btq.warnAt'), { count: v.reorderLevel })}{v.costPrice === undefined ? '' : ` · ${t('btq.value')} ${money(v.stockQuantity * v.costPrice)}`}</small></td>
            <td data-label={t('btq.inStock')}><span className="btq-stock-qty">{qty(v.stockQuantity, v.productUnit)}</span> <Badge tone={state.tone}>{t(`btq.stockState.${state.key}`)}</Badge></td>
            <td data-label={t('btq.pricePerUnit')}>{money(v.sellingPrice)}</td>
            {can.manage && <td className="card-actions"><button type="button" className="secondary-btn" onClick={() => {
              setForm({ ...emptyStockForm(), variant: v });
              setProblem('');
              document.getElementById('stock-update')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}>{t('btq.updateStock')}</button></td>}
          </tr>;
        })}</tbody>
      </table></div> : <Empty>{t('btq.noStock')}</Empty>}
    </Panel>
    {can.manage && <form className="form-panel" id="stock-update" onSubmit={submit} noValidate>
      <div className="panel-header"><div><h2>{t('btq.updateStock')}</h2><span>{can.decide ? t('btq.adjustDirectorHint') : t('btq.adjustManagerHint')}</span></div></div>
      <h3 className="form-section-title">1. {t('btq.step.which')}</h3>
      {form.variant
        ? <p className="btq-picked"><strong>{fullName(form.variant)}</strong> · {fill(t('btq.inStockCount'), { count: qty(onShelf, form.variant.productUnit) })}
          <button type="button" className="text-btn" onClick={() => setForm({ ...form, variant: null })}>{t('btq.pickAnother')}</button></p>
        : <VariantSearch fetchJson={fetchJson} onPick={(v) => { setForm({ ...form, variant: v }); setProblem(''); }} placeholder={t('btq.pickVariant')} />}
      <h3 className="form-section-title">2. {t('btq.step.what')}</h3>
      <div className="btq-kind-choices" role="radiogroup" aria-label={t('btq.step.what')}>
        {ADJUSTMENT_KINDS.map((k) => <label key={k} className={`btq-kind-choice${form.kind === k ? ' is-chosen' : ''}`}>
          <input type="radio" name="stock-kind" value={k} checked={form.kind === k} onChange={() => { setForm({ ...form, kind: k }); setProblem(''); }} />
          <span><strong>{t(`btq.kind.${k}`)}</strong><small>{t(`btq.kindHint.${k}`)}</small></span>
        </label>)}
      </div>
      <h3 className="form-section-title">3. {t('btq.step.howMany')}</h3>
      <div className="form-grid">
        <Field label={`${form.kind === 'count' ? t('btq.countedQty') : t('btq.qty')} *`}>
          <input type="number" inputMode="numeric" min="0" step="1" value={form.quantity} placeholder="10" onChange={(e) => { setForm({ ...form, quantity: e.target.value }); setProblem(''); }} />
        </Field>
        <Field label={needsReason ? `${t('btq.reason')} *` : `${t('btq.reason')} ${t('btq.optional')}`} wide>
          <input maxLength="1000" value={form.reason} placeholder={t(`btq.reasonExample.${form.kind}`)} onChange={(e) => { setForm({ ...form, reason: e.target.value }); setProblem(''); }} />
        </Field>
      </div>
      {/* Before and after, side by side: the difference between "add 10" and
          "there are now 10" is exactly the mistake this form exists to stop. */}
      {form.variant && <div className="btq-stock-preview" aria-live="polite">
        <Fact label={t('btq.stockNow')} value={qty(onShelf, form.variant.productUnit)} />
        <Fact label={t('btq.change')} value={after === null ? '—' : (after - onShelf > 0 ? `+${after - onShelf}` : String(after - onShelf))} />
        <Fact label={t('btq.stockAfterUpdate')} value={after === null ? '—' : <strong className={after < 0 ? 'over-budget' : undefined}>{qty(after, form.variant.productUnit)}</strong>} />
      </div>}
      {!can.decide && <p className="field-hint">{t('btq.waitsForDirector')}</p>}
      {problem && <p className="field-error" role="alert">{problem}</p>}
      <div className="form-submit-bar"><button className="primary-btn big-action" type="submit" disabled={busy}>{can.decide ? t('btq.saveStock') : t('btq.askAdjustment')}</button></div>
    </form>}
    {adjustments?.length > 0 && <Panel title={t('btq.adjustments')}>
      <div className="table-wrap"><table className="card-table">
        <thead><tr><th>{t('btq.item')}</th><th>{t('btq.adjustmentKind')}</th><th>{t('btq.qty')}</th><th>{t('btq.change')}</th><th>{t('btq.reason')}</th><th>{t('field.status')}</th><th>{t('btq.askedBy')}</th></tr></thead>
        <tbody>{adjustments.map((a) => <tr key={a.id}>
          <td className="card-title-cell"><strong>{a.productName}</strong><small>{a.sku} {variantLabel(a)}</small></td>
          <td data-label={t('btq.adjustmentKind')}>{t(`btq.kind.${a.kind}`)}</td><td data-label={t('btq.qty')}>{a.quantity}</td>
          <td data-label={t('btq.change')}>{a.delta > 0 ? `+${a.delta}` : a.delta}</td>
          <td data-label={t('btq.reason')}>{a.reason}{a.decisionNote && ` — ${a.decisionNote}`}</td>
          <td data-label={t('field.status')}><Badge tone={APPROVAL_TONE[a.status]}>{t(`btq.approval.${a.status}`)}</Badge></td>
          <td data-label={t('btq.askedBy')}>{a.requestedByName} · {formatDate(a.createdAt, language)}</td>
        </tr>)}</tbody>
      </table></div>
    </Panel>}
    <Section title={t('btq.ledger')} count={movements?.length || 0}>
      {movements?.length ? <div className="table-wrap"><table className="card-table">
        <thead><tr><th>{t('btq.item')}</th><th>{t('table.date')}</th><th>{t('btq.movementKind')}</th><th>{t('btq.change')}</th><th>{t('btq.balanceAfter')}</th><th>{t('field.notes')}</th><th>{t('expense.recordedBy')}</th></tr></thead>
        <tbody>{movements.map((m) => <tr key={m.id}>
          <td className="card-title-cell"><strong>{m.productName}</strong><small>{m.sku} {variantLabel(m)}</small></td>
          <td data-label={t('table.date')}>{formatDate(m.createdAt, language)}</td>
          <td data-label={t('btq.movementKind')}>{t(`btq.kind.${m.kind}`)}</td>
          <td data-label={t('btq.change')}>{m.quantity > 0 ? `+${m.quantity}` : m.quantity}</td>
          <td data-label={t('btq.balanceAfter')}>{m.balanceAfter}</td>
          <td data-label={t('field.notes')}>{m.note || '—'}</td>
          <td data-label={t('expense.recordedBy')}>{m.recordedByName || '—'}</td>
        </tr>)}</tbody>
      </table></div> : <Empty>{t('btq.noMovements')}</Empty>}
    </Section>
  </>;
}

// Stock and profit, product by product, for the period on screen. The row
// reads left to right the way the shop thinks about it -- had, came in, sold,
// lost, left -- and then the money. Every figure is the API's (stockProfit in
// routes/boutique.js); the totals line is the sum of the rows.
function StockProfitPanel({ data }) {
  const { t } = useI18n();
  // Per product, only what the owner asks: how many sold, how many are left,
  // the money they brought and the profit on them. The full stock movement
  // (start, came in, damaged) is in the Stock tab and the exported report.
  const rows = data.rows.filter((r) => r.sold || r.closing);
  return <Panel title={t('btq.sp.title')}>
    {rows.length ? <div className="table-wrap"><table className="card-table btq-stock-profit">
      <thead><tr><th>{t('btq.product')}</th><th>{t('btq.sp.sold')}</th><th>{t('btq.sp.closing')}</th><th>{t('btq.sp.revenue')}</th><th>{t('btq.sp.profit')}</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.variantId}>
        <td className="card-title-cell"><strong>{fullName(r)}</strong></td>
        <td data-label={t('btq.sp.sold')}><strong>{qty(r.sold, r.unit)}</strong></td>
        <td data-label={t('btq.sp.closing')}>{qty(r.closing, r.unit)}</td>
        <td data-label={t('btq.sp.revenue')}>{money(r.revenue)}</td>
        <td data-label={t('btq.sp.profit')}><strong className={r.profit < 0 ? 'over-budget' : undefined}>{money(r.profit)}</strong></td>
      </tr>)}</tbody>
    </table></div> : <Empty>{t('btq.nothingInPeriod')}</Empty>}
    {/* The totals as plain lines under the table, not a table row: a row
        drawn as a card on a phone ran its labels into its figures. */}
    {rows.length > 0 && <div className="btq-stock-preview">
      <Fact label={t('btq.sp.sold')} value={<strong>{data.totals.sold}</strong>} />
      <Fact label={t('btq.sp.revenue')} value={<strong>{money(data.totals.revenue)}</strong>} />
      <Fact label={t('btq.sp.profit')} value={<strong>{money(data.totals.profit)}</strong>} />
    </div>}
  </Panel>;
}

// ---- counting the shelf --------------------------------------------------------------
//
// For a shop that sells over the counter without ringing each sale up: count
// what is left, and the shop works out what was sold. One list of products,
// one box each -- "how many are left?" -- and beside it what that means
// (sold, and the money) before anything is saved. Boxes left empty are not
// counted. The API decides the figures; the preview here uses the same rule
// (what the shelf should hold − what is left) and the same prices.
function CountTab({ fetchJson, onMessage, onError, changed, can }) {
  const { t, language } = useI18n();
  const dialog = useDialog();
  const [busy, run] = useBusy();
  const [tick, setTick] = useState(0);
  const [search, setSearch] = useState('');
  const [stock] = useLoad(fetchJson, '/api/boutique/stock', tick, onError);
  const [counts] = useLoad(fetchJson, '/api/boutique/shelf-counts', tick, onError);
  const [left, setLeft] = useState({});
  const [note, setNote] = useState('');
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const refresh = () => { setTick((n) => n + 1); changed(); };

  const items = stock?.items || [];
  const shown = search.trim() ? items.filter((v) => fullName(v).toLowerCase().includes(search.trim().toLowerCase()) || String(v.sku).toLowerCase().includes(search.trim().toLowerCase())) : items;
  // One line per box filled in, with its problem if the number cannot be
  // right. Nothing here is saved until the button is pressed.
  const lines = items.filter((v) => left[v.id] !== undefined && left[v.id] !== '').map((v) => {
    const raw = left[v.id];
    const n = Number(raw);
    const whole = Number.isInteger(n) && n >= 0;
    const problem = !whole ? t('btq.err.quantity') : n > v.stockQuantity ? fill(t('btq.count.tooMany'), { count: qty(v.stockQuantity, v.productUnit) }) : '';
    const sold = whole && !problem ? v.stockQuantity - n : 0;
    return { v, counted: n, sold, problem, revenue: sold * Number(v.sellingPrice || 0), cost: sold * Number(v.costPrice || 0) };
  });
  const problems = lines.filter((l) => l.problem);
  const total = lines.reduce((sum, l) => ({ sold: sum.sold + l.sold, revenue: sum.revenue + l.revenue, cost: sum.cost + l.cost }), { sold: 0, revenue: 0, cost: 0 });
  const lineFor = (id) => lines.find((l) => l.v.id === id);

  const save = () => run(async () => {
    const ok = await dialog.confirm({
      title: t('btq.count.confirmTitle'),
      message: fill(t('btq.count.confirmBody'), { products: lines.length, sold: total.sold, revenue: money(total.revenue), profit: money(total.revenue - total.cost) }),
      confirmLabel: t('btq.count.save')
    });
    if (!ok) return;
    try {
      const saved = await fetchJson('/api/boutique/shelf-counts', { method: 'POST', body: JSON.stringify({ note, requestKey, lines: lines.map((l) => ({ variantId: l.v.id, counted: l.counted })) }) });
      onMessage(fill(t('btq.count.saved'), { sold: saved.pieces, revenue: money(saved.revenue), profit: money(saved.profit) }));
      setLeft({});
      setNote('');
      setRequestKey(newRequestKey());
      refresh();
    } catch (error) { onError(error.message); }
  });

  const undo = (count) => run(async () => {
    const reason = await dialog.prompt({ title: t('btq.count.undoTitle'), message: t('btq.count.undoBody'), label: t('btq.reason'), required: true, minLength: 10, multiline: true, danger: true, confirmLabel: t('btq.count.undo') });
    if (reason === null) return;
    try {
      await fetchJson(`/api/boutique/shelf-counts/${count.id}/void`, { method: 'POST', body: JSON.stringify({ reason }) });
      onMessage(t('btq.count.undone'));
      refresh();
    } catch (error) { onError(error.message); }
  });

  return <>
    {can.manage && <section className="form-panel">
      <div className="panel-header"><div><h2>{t('btq.count.title')}</h2><span>{t('btq.count.blurb')}</span></div></div>
      <p className="field-hint">{t('btq.count.example')}</p>
      <div className="filter-grid">
        <Field label={t('btq.search')}><input type="search" value={search} placeholder={t('btq.searchProducts')} onChange={(e) => setSearch(e.target.value)} /></Field>
      </div>
      {!stock ? <div className="compact-loading"><span className="spinner" /></div> : shown.length ? <div className="table-wrap"><table className="card-table btq-count">
        <thead><tr><th>{t('btq.product')}</th><th>{t('btq.count.shouldHave')}</th><th>{t('btq.count.leftNow')}</th><th>{t('btq.count.sold')}</th><th>{t('btq.count.sales')}</th></tr></thead>
        <tbody>{shown.map((v) => {
          const line = lineFor(v.id);
          return <tr key={v.id} className={line?.problem ? 'btq-low' : undefined}>
            <td className="card-title-cell"><strong>{fullName(v)}</strong><small>{money(v.sellingPrice)} · {v.sku}</small></td>
            <td data-label={t('btq.count.shouldHave')}>{qty(v.stockQuantity, v.productUnit)}</td>
            <td data-label={t('btq.count.leftNow')}>
              <input type="number" inputMode="numeric" min="0" step="1" value={left[v.id] ?? ''} aria-label={`${t('btq.count.leftNow')}: ${fullName(v)}`}
                aria-invalid={Boolean(line?.problem)} onChange={(e) => setLeft({ ...left, [v.id]: e.target.value })} />
              {line?.problem && <FieldError>{line.problem}</FieldError>}
            </td>
            <td data-label={t('btq.count.sold')}>{line && !line.problem ? <strong>{qty(line.sold, v.productUnit)}</strong> : '—'}</td>
            <td data-label={t('btq.count.sales')}>{line && !line.problem ? money(line.revenue) : '—'}</td>
          </tr>;
        })}</tbody>
      </table></div> : <Empty>{t('btq.noStock')}</Empty>}
      {/* The whole count in one sentence before it is saved. */}
      {lines.length > 0 && <div className="btq-stock-preview" aria-live="polite">
        <Fact label={t('btq.count.productsCounted')} value={lines.length} />
        <Fact label={t('btq.count.sold')} value={total.sold} />
        <Fact label={t('btq.count.sales')} value={<strong>{money(total.revenue)}</strong>} />
        <Fact label={t('btq.count.profit')} value={money(total.revenue - total.cost)} />
      </div>}
      <Field label={`${t('field.notes')} ${t('btq.optional')}`} wide><input maxLength="1000" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      {problems.length > 0 && <p className="field-error" role="alert">{t('btq.count.fixFirst')}</p>}
      <div className="form-submit-bar">
        <button type="button" className="primary-btn big-action" disabled={busy || !lines.length || problems.length > 0} onClick={save}>{t('btq.count.save')}</button>
      </div>
    </section>}
    <Panel title={t('btq.count.history')}>
      {!counts ? <div className="compact-loading"><span className="spinner" /></div> : counts.length ? <div className="table-wrap"><table className="card-table">
        <thead><tr><th>{t('table.date')}</th><th>{t('btq.count.productsCounted')}</th><th>{t('btq.count.sold')}</th><th>{t('btq.count.sales')}</th><th>{t('btq.count.profit')}</th><th>{t('field.status')}</th>{can.decide && <th>{t('table.actions')}</th>}</tr></thead>
        <tbody>{counts.map((c) => <tr key={c.id} className={c.status === 'voided' ? 'btq-voided' : undefined}>
          <td className="card-title-cell"><strong>{formatDate(c.countedOn, language)}</strong><small>{c.countedByName}{c.note ? ` · ${c.note}` : ''}</small></td>
          <td data-label={t('btq.count.productsCounted')}>{c.lineCount}</td>
          <td data-label={t('btq.count.sold')}>{c.pieces}</td>
          <td data-label={t('btq.count.sales')}>{money(c.revenue)}</td>
          <td data-label={t('btq.count.profit')}>{money(c.profit)}</td>
          <td data-label={t('field.status')}><Badge tone={c.status === 'voided' ? 'stopped' : 'done'}>{t(`btq.countStatus.${c.status}`)}</Badge>{c.voidReason && <small> {c.voidReason}</small>}</td>
          {can.decide && <td className="card-actions">{c.status === 'recorded' && <button type="button" className="danger-btn outlined" disabled={busy} onClick={() => undo(c)}>{t('btq.count.undo')}</button>}</td>}
        </tr>)}</tbody>
      </table></div> : <Empty>{t('btq.count.none')}</Empty>}
    </Panel>
  </>;
}

// ---- suppliers and purchases --------------------------------------------------------

function SuppliersTab({ fetchJson, onMessage, onError, changed, can, go, query }) {
  const { t, language } = useI18n();
  const [busy, run] = useBusy();
  const [tick, setTick] = useState(0);
  const [suppliers] = useLoad(fetchJson, '/api/boutique/suppliers', tick, onError);
  const [orders] = useLoad(fetchJson, '/api/boutique/purchases', tick, onError);
  const [supplierForm, setSupplierForm] = useState({ name: '', contactName: '', phone: '', email: '', address: '', notes: '' });
  const [orderForm, setOrderForm] = useState({ supplierId: '', expectedOn: '', notes: '', lines: [] });
  const [showOrderForm, setShowOrderForm] = useState(false);
  const refresh = () => { setTick((n) => n + 1); changed(); };
  const openSupplier = query.get('supplier');
  const openOrder = query.get('order');

  const addSupplier = (e) => { e.preventDefault(); run(async () => { try { await fetchJson('/api/boutique/suppliers', { method: 'POST', body: JSON.stringify(supplierForm) }); onMessage(t('btq.saved')); setSupplierForm({ name: '', contactName: '', phone: '', email: '', address: '', notes: '' }); refresh(); } catch (error) { onError(error.message); } }); };
  const raiseOrder = (e) => {
    e.preventDefault();
    run(async () => {
      try {
        const created = await fetchJson('/api/boutique/purchases', { method: 'POST', body: JSON.stringify({ supplierId: orderForm.supplierId, expectedOn: orderForm.expectedOn || undefined, notes: orderForm.notes, items: orderForm.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitCost: l.unitCost })) }) });
        onMessage(fill(t('btq.orderRaised'), { reference: created.reference }));
        setOrderForm({ supplierId: '', expectedOn: '', notes: '', lines: [] });
        setShowOrderForm(false);
        refresh();
        go('suppliers', { order: created.id });
      } catch (error) { onError(error.message); }
    });
  };

  return <>
    {openSupplier && <SupplierDetail supplierId={openSupplier} fetchJson={fetchJson} onMessage={onMessage} onError={onError} can={can} onClose={() => go('suppliers')} onChanged={refresh} onOpenOrder={(id) => go('suppliers', { order: id })} />}
    {openOrder && <OrderDetail orderId={openOrder} fetchJson={fetchJson} onMessage={onMessage} onError={onError} can={can} onClose={() => go('suppliers')} onChanged={refresh} />}
    <Panel title={t('btq.suppliers')} subtitle={suppliers ? String(suppliers.length) : ''}>
      {suppliers?.length ? <div className="table-wrap"><table className="card-table">
        <thead><tr><th>{t('field.name')}</th><th>{t('btq.contact')}</th><th>{t('btq.orders')}</th><th>{t('btq.billed')}</th><th>{t('btq.paid')}</th><th>{t('btq.owed')}</th></tr></thead>
        <tbody>{suppliers.map((s) => <tr key={s.id} className="clickable-row" onClick={() => go('suppliers', { supplier: s.id })}>
          <td className="card-title-cell"><strong>{s.name}</strong></td>
          <td data-label={t('btq.contact')}>{[s.contactName, s.phone].filter(Boolean).join(' · ') || '—'}</td>
          <td data-label={t('btq.orders')}>{s.orderCount}</td><td data-label={t('btq.billed')}>{money(s.billed)}</td>
          <td data-label={t('btq.paid')}>{money(s.paid)}</td><td data-label={t('btq.owed')}><span className={s.owed > 0 ? 'over-budget' : undefined}>{money(s.owed)}</span></td>
        </tr>)}</tbody>
      </table></div> : <Empty>{t('btq.noSuppliers')}</Empty>}
      {can.manage && <form className="decision-form" onSubmit={addSupplier}>
        <h3 className="form-section-title">{t('btq.addSupplier')}</h3>
        <div className="form-grid">
          <Field label={t('field.name')}><input required maxLength="200" value={supplierForm.name} onChange={(e) => setSupplierForm({ ...supplierForm, name: e.target.value })} /></Field>
          <Field label={t('btq.contact')}><input maxLength="150" value={supplierForm.contactName} onChange={(e) => setSupplierForm({ ...supplierForm, contactName: e.target.value })} /></Field>
          <Field label={t('btq.phone')}><input maxLength="50" value={supplierForm.phone} onChange={(e) => setSupplierForm({ ...supplierForm, phone: e.target.value })} /></Field>
          <Field label={t('btq.email')}><input type="email" maxLength="255" value={supplierForm.email} onChange={(e) => setSupplierForm({ ...supplierForm, email: e.target.value })} /></Field>
          <Field label={t('btq.address')} wide><input maxLength="1000" value={supplierForm.address} onChange={(e) => setSupplierForm({ ...supplierForm, address: e.target.value })} /></Field>
        </div>
        <div className="form-submit-bar"><button className="primary-btn" type="submit" disabled={busy}>{t('btq.addSupplier')}</button></div>
      </form>}
    </Panel>
    <Panel title={t('btq.purchaseOrders')} subtitle={orders ? String(orders.length) : ''} action={can.manage ? t('btq.newOrder') : null} onAction={() => setShowOrderForm((s) => !s)}>
      {can.manage && showOrderForm && <form className="decision-form" onSubmit={raiseOrder}>
        <div className="form-grid">
          <Field label={t('btq.supplier')}><select required value={orderForm.supplierId} onChange={(e) => setOrderForm({ ...orderForm, supplierId: e.target.value })}><option value="">—</option>{(suppliers || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <Field label={t('btq.expectedOn')}><input type="date" value={orderForm.expectedOn} onChange={(e) => setOrderForm({ ...orderForm, expectedOn: e.target.value })} /></Field>
          <Field label={t('field.notes')} wide><input maxLength="2000" value={orderForm.notes} onChange={(e) => setOrderForm({ ...orderForm, notes: e.target.value })} /></Field>
        </div>
        <VariantSearch fetchJson={fetchJson} onPick={(v) => setOrderForm((c) => (c.lines.some((l) => l.variantId === v.id) ? c : { ...c, lines: [...c.lines, { variantId: v.id, name: fullName(v), sku: v.sku, quantity: 1, unitCost: v.costPrice }] }))} placeholder={t('btq.pickVariant')} />
        {orderForm.lines.length > 0 && <div className="table-wrap"><table className="card-table">
          <thead><tr><th>{t('btq.item')}</th><th>{t('btq.qty')}</th><th>{t('btq.unitCost')}</th><th>{t('table.actions')}</th></tr></thead>
          <tbody>{orderForm.lines.map((l) => <tr key={l.variantId}>
            <td className="card-title-cell"><strong>{l.name}</strong><small>{l.sku}</small></td>
            <td data-label={t('btq.qty')}><input type="number" min="1" value={l.quantity} aria-label={t('btq.qty')} onChange={(e) => setOrderForm({ ...orderForm, lines: orderForm.lines.map((x) => (x.variantId === l.variantId ? { ...x, quantity: e.target.value } : x)) })} /></td>
            <td data-label={t('btq.unitCost')}><input type="number" min="0" value={l.unitCost} aria-label={t('btq.unitCost')} onChange={(e) => setOrderForm({ ...orderForm, lines: orderForm.lines.map((x) => (x.variantId === l.variantId ? { ...x, unitCost: e.target.value } : x)) })} /></td>
            <td className="card-actions"><button type="button" className="text-btn" onClick={() => setOrderForm({ ...orderForm, lines: orderForm.lines.filter((x) => x.variantId !== l.variantId) })}>{t('action.remove')}</button></td>
          </tr>)}</tbody>
        </table></div>}
        <div className="form-submit-bar"><button className="primary-btn" type="submit" disabled={busy || !orderForm.lines.length}>{t('btq.raiseOrder')}</button></div>
      </form>}
      {orders?.length ? <div className="table-wrap"><table className="card-table">
        <thead><tr><th>{t('btq.reference')}</th><th>{t('btq.supplier')}</th><th>{t('table.date')}</th><th>{t('btq.orderedValue')}</th><th>{t('btq.receivedValue')}</th><th>{t('field.status')}</th></tr></thead>
        <tbody>{orders.map((o) => <tr key={o.id} className="clickable-row" onClick={() => go('suppliers', { order: o.id })}>
          <td className="card-title-cell"><strong>{o.reference}</strong>{o.invoiceNumber && <small>{o.invoiceNumber}</small>}</td>
          <td data-label={t('btq.supplier')}>{o.supplierName}</td><td data-label={t('table.date')}>{formatDate(o.orderedOn, language)}</td>
          <td data-label={t('btq.orderedValue')}>{money(o.orderedValue)}</td><td data-label={t('btq.receivedValue')}>{money(o.receivedValue)}</td>
          <td data-label={t('field.status')}><Badge tone={PO_TONE[o.status]}>{t(`btq.poStatus.${o.status}`)}</Badge></td>
        </tr>)}</tbody>
      </table></div> : <Empty>{t('btq.noOrders')}</Empty>}
    </Panel>
  </>;
}

function SupplierDetail({ supplierId, fetchJson, onMessage, onError, can, onClose, onChanged, onOpenOrder }) {
  const { t, language } = useI18n();
  const [busy, run] = useBusy();
  const [tick, setTick] = useState(0);
  const [supplier] = useLoad(fetchJson, `/api/boutique/suppliers/${encodeURIComponent(supplierId)}`, tick, onError);
  const [pay, setPay] = useState({ amount: '', method: 'Cash', paidOn: todayLocal(), orderId: '', reference: '' });
  const refresh = () => { setTick((n) => n + 1); onChanged(); };
  const submit = (e) => { e.preventDefault(); run(async () => { try { await fetchJson(`/api/boutique/suppliers/${supplier.id}/payments`, { method: 'POST', body: JSON.stringify({ ...pay, orderId: pay.orderId || undefined }) }); onMessage(t('btq.paymentRecorded')); setPay({ ...pay, amount: '', reference: '' }); refresh(); } catch (error) { onError(error.message); } }); };
  if (!supplier) return <DetailView onClose={onClose} label={t('btq.supplier')}><div className="loading-state"><span className="spinner" /></div></DetailView>;
  return <DetailView onClose={onClose} label={supplier.name}>
    <section className="panel detail-panel">
      <div className="panel-header"><div><h2>{supplier.name}</h2><span>{[supplier.contactName, supplier.phone, supplier.email].filter(Boolean).join(' · ')}</span></div>
        <button className="text-btn" type="button" onClick={onClose}>{t('action.close')}</button></div>
      <div className="detail-facts">
        <Fact label={t('btq.billed')} value={money(supplier.billed)} />
        <Fact label={t('btq.paid')} value={money(supplier.paid)} />
        <Fact label={t('btq.owed')} value={<span className={supplier.owed > 0 ? 'over-budget' : undefined}>{money(supplier.owed)}</span>} />
      </div>
      <h3 className="form-section-title">{t('btq.purchaseOrders')}</h3>
      {supplier.orders.length ? <ul className="history-list">{supplier.orders.map((o) => <li key={o.id}><button type="button" className="text-btn" onClick={() => onOpenOrder(o.id)}>{o.reference}</button> · {formatDate(o.orderedOn, language)} · {money(o.invoiceTotal ?? o.receivedValue)} · {t(`btq.poStatus.${o.status}`)}</li>)}</ul> : <p className="field-hint">{t('btq.noOrders')}</p>}
      <h3 className="form-section-title">{t('btq.paymentsMade')}</h3>
      {supplier.payments.length ? <ul className="history-list">{supplier.payments.map((p) => <li key={p.id}>{formatDate(p.paidOn, language)} · {money(p.amount)} · {t(`btq.method.${p.method}`)}{p.orderReference && ` · ${p.orderReference}`}{p.reference && ` · ${p.reference}`}</li>)}</ul> : <p className="field-hint">{t('btq.noPayments')}</p>}
      {can.manage && <form className="decision-form" onSubmit={submit}>
        <h3 className="form-section-title">{t('btq.recordPayment')}</h3>
        <div className="form-grid">
          <Field label={t('btq.amount')}><input type="number" min="1" required value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></Field>
          <Field label={t('btq.method')}><select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>{BOUTIQUE_PAYMENT_METHODS.map((m) => <option key={m} value={m}>{t(`btq.method.${m}`)}</option>)}</select></Field>
          <Field label={t('table.date')}><input type="date" required value={pay.paidOn} onChange={(e) => setPay({ ...pay, paidOn: e.target.value })} /></Field>
          <Field label={t('btq.purchaseOrder')}><select value={pay.orderId} onChange={(e) => setPay({ ...pay, orderId: e.target.value })}><option value="">—</option>{supplier.orders.map((o) => <option key={o.id} value={o.id}>{o.reference}</option>)}</select></Field>
          <Field label={t('btq.reference')}><input maxLength="100" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></Field>
        </div>
        <div className="form-submit-bar"><button className="primary-btn" type="submit" disabled={busy}>{t('btq.recordPayment')}</button></div>
      </form>}
    </section>
  </DetailView>;
}

function OrderDetail({ orderId, fetchJson, onMessage, onError, can, onClose, onChanged }) {
  const { t, language } = useI18n();
  const dialog = useDialog();
  const [busy, run] = useBusy();
  const [tick, setTick] = useState(0);
  const [order] = useLoad(fetchJson, `/api/boutique/purchases/${encodeURIComponent(orderId)}`, tick, onError);
  const [receiving, setReceiving] = useState({});
  const [invoice, setInvoice] = useState({ invoiceNumber: '', invoiceTotal: '' });
  useEffect(() => { if (order) setInvoice({ invoiceNumber: order.invoiceNumber, invoiceTotal: order.invoiceTotal ?? '' }); }, [order]);
  const refresh = () => { setTick((n) => n + 1); onChanged(); };
  const receive = (e) => {
    e.preventDefault();
    run(async () => {
      try {
        const items = order.items.filter((i) => Number(receiving[i.variantId]) > 0).map((i) => ({ variantId: i.variantId, quantity: Number(receiving[i.variantId]) }));
        await fetchJson(`/api/boutique/purchases/${order.id}/receive`, { method: 'POST', body: JSON.stringify({ items }) });
        onMessage(t('btq.received'));
        setReceiving({});
        refresh();
      } catch (error) { onError(error.message); }
    });
  };
  const saveInvoice = (e) => { e.preventDefault(); run(async () => { try { await fetchJson(`/api/boutique/purchases/${order.id}/invoice`, { method: 'PUT', body: JSON.stringify(invoice) }); onMessage(t('btq.saved')); refresh(); } catch (error) { onError(error.message); } }); };
  const cancel = () => run(async () => {
    const reason = await dialog.prompt({ title: t('btq.cancelOrder'), label: t('btq.reason'), required: true, multiline: true });
    if (reason === null) return;
    try { await fetchJson(`/api/boutique/purchases/${order.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }); onMessage(t('btq.saved')); refresh(); } catch (error) { onError(error.message); }
  });
  if (!order) return <DetailView onClose={onClose} label={t('btq.purchaseOrder')}><div className="loading-state"><span className="spinner" /></div></DetailView>;
  const open = ['ordered', 'partially_received'].includes(order.status);
  return <DetailView onClose={onClose} label={order.reference}>
    <section className="panel detail-panel">
      <div className="panel-header"><div><h2>{order.reference}</h2><span>{order.supplierName} · {formatDate(order.orderedOn, language)}</span></div>
        <button className="text-btn" type="button" onClick={onClose}>{t('action.close')}</button></div>
      <div className="detail-facts">
        <Fact label={t('field.status')} value={<Badge tone={PO_TONE[order.status]}>{t(`btq.poStatus.${order.status}`)}</Badge>} />
        <Fact label={t('btq.orderedValue')} value={money(order.orderedValue)} />
        <Fact label={t('btq.receivedValue')} value={money(order.receivedValue)} />
        <Fact label={t('btq.invoiceTotal')} value={order.invoiceTotal === null ? '—' : money(order.invoiceTotal)} />
        {order.expectedOn && <Fact label={t('btq.expectedOn')} value={formatDate(order.expectedOn, language)} />}
      </div>
      {order.cancelReason && <p className="admin-note">{order.cancelReason}</p>}
      <form onSubmit={receive}>
        <div className="table-wrap"><table className="card-table">
          <thead><tr><th>{t('btq.item')}</th><th>{t('btq.ordered')}</th><th>{t('btq.receivedQty')}</th><th>{t('btq.unitCost')}</th>{can.manage && open && <th>{t('btq.receiveNow')}</th>}</tr></thead>
          <tbody>{order.items.map((i) => <tr key={i.id}>
            <td className="card-title-cell"><strong>{i.productName}</strong><small>{i.sku} {variantLabel(i)}</small></td>
            <td data-label={t('btq.ordered')}>{i.quantityOrdered}</td><td data-label={t('btq.receivedQty')}>{i.quantityReceived}</td>
            <td data-label={t('btq.unitCost')}>{money(i.unitCost)}</td>
            {can.manage && open && <td data-label={t('btq.receiveNow')}><input type="number" min="0" max={i.quantityOrdered - i.quantityReceived} value={receiving[i.variantId] || ''} aria-label={t('btq.receiveNow')} onChange={(e) => setReceiving({ ...receiving, [i.variantId]: e.target.value })} /></td>}
          </tr>)}</tbody>
        </table></div>
        {can.manage && open && <div className="form-submit-bar">
          <button type="button" className="text-btn" disabled={busy || order.status !== 'ordered'} onClick={cancel}>{t('btq.cancelOrder')}</button>
          <button className="primary-btn" type="submit" disabled={busy}>{t('btq.recordDelivery')}</button>
        </div>}
      </form>
      {order.receipts.length > 0 && <><h3 className="form-section-title">{t('btq.deliveries')}</h3>
        <ul className="history-list">{order.receipts.map((r) => <li key={r.id}>{formatDate(r.receivedOn, language)} · {r.pieces} · {money(r.value)} · {r.receivedByName}</li>)}</ul></>}
      {can.manage && order.status !== 'cancelled' && <form className="decision-form" onSubmit={saveInvoice}>
        <h3 className="form-section-title">{t('btq.invoice')}</h3>
        <div className="form-grid">
          <Field label={t('btq.invoiceNumber')}><input maxLength="100" value={invoice.invoiceNumber} onChange={(e) => setInvoice({ ...invoice, invoiceNumber: e.target.value })} /></Field>
          <Field label={t('btq.invoiceTotal')}><input type="number" min="0" value={invoice.invoiceTotal} onChange={(e) => setInvoice({ ...invoice, invoiceTotal: e.target.value })} /></Field>
        </div>
        <div className="form-submit-bar"><button className="primary-btn" type="submit" disabled={busy}>{t('btq.save')}</button></div>
      </form>}
      {order.payments.length > 0 && <><h3 className="form-section-title">{t('btq.paymentsMade')}</h3>
        <ul className="history-list">{order.payments.map((p) => <li key={p.id}>{formatDate(p.paidOn, language)} · {money(p.amount)} · {t(`btq.method.${p.method}`)}</li>)}</ul></>}
    </section>
  </DetailView>;
}

// ---- cash ---------------------------------------------------------------------------

function CashTab({ fetchJson, onMessage, onError, changed, can, go, query }) {
  const { t, language } = useI18n();
  const [busy, run] = useBusy();
  const [tick, setTick] = useState(0);
  const [current] = useLoad(fetchJson, '/api/boutique/cash/sessions/current', tick, onError);
  const [sessions] = useLoad(fetchJson, '/api/boutique/cash/sessions', tick, onError);
  const [openForm, setOpenForm] = useState({ openingCash: '0' });
  const [move, setMove] = useState({ kind: 'payout', amount: '', reason: '' });
  const [close, setClose] = useState({ countedCash: '', counted: {}, note: '' });
  const openId = query.get('session');
  const refresh = () => { setTick((n) => n + 1); changed(); };
  const post = (path, body, done) => run(async () => { try { await fetchJson(path, { method: 'POST', body: JSON.stringify(body) }); onMessage(done); refresh(); } catch (error) { onError(error.message); } });

  return <>
    {openId && <SessionDetail sessionId={openId} fetchJson={fetchJson} onError={onError} onClose={() => go('cash')} />}
    {can.sell && (current ? <Panel title={t('btq.myTill')} subtitle={`${t('btq.openedAt')} ${formatDate(current.openedAt, language)}`}>
      <div className="metric-grid metric-grid-4">
        <Metric label={t('btq.openingCash')} value={money(current.openingCash)} />
        <Metric label={t('btq.cashTaken')} value={money(current.figures.cashTaken)} />
        <Metric label={t('btq.change')} value={money(current.figures.changeGiven)} />
        <Metric label={t('btq.cashRefunded')} value={money(current.figures.cashRefunded)} />
        <Metric label={t('btq.cashExpenses')} value={money(current.figures.cashExpenses)} />
        <Metric label={t('btq.payouts')} value={money(current.figures.payouts)} />
        <Metric label={t('btq.cashIn')} value={money(current.figures.cashIn)} />
        <Metric label={t('btq.expectedCash')} value={money(current.expectedCash)} tone="strong" />
      </div>
      <div className="detail-facts">{Object.entries(current.expectedByMethod).map(([method, value]) => <Fact key={method} label={t(`btq.method.${method}`)} value={money(value)} />)}</div>
      {current.movements.length > 0 && <ul className="history-list">{current.movements.map((m) => <li key={m.id}>{t(`btq.cashKind.${m.kind}`)} · {money(m.amount)} · {m.reason}</li>)}</ul>}
      <form className="decision-form" onSubmit={(e) => { e.preventDefault(); post(`/api/boutique/cash/sessions/${current.id}/movements`, move, t('btq.saved')); setMove({ kind: 'payout', amount: '', reason: '' }); }}>
        <h3 className="form-section-title">{t('btq.cashMovement')}</h3>
        <div className="form-grid">
          <Field label={t('btq.movementKind')}><select value={move.kind} onChange={(e) => setMove({ ...move, kind: e.target.value })}><option value="payout">{t('btq.cashKind.payout')}</option><option value="cash_in">{t('btq.cashKind.cash_in')}</option></select></Field>
          <Field label={t('btq.amount')}><input type="number" min="1" required value={move.amount} onChange={(e) => setMove({ ...move, amount: e.target.value })} /></Field>
          <Field label={t('btq.reason')} wide><input required maxLength="1000" value={move.reason} onChange={(e) => setMove({ ...move, reason: e.target.value })} /></Field>
        </div>
        <div className="form-submit-bar"><button className="secondary-btn" type="submit" disabled={busy}>{t('btq.save')}</button></div>
      </form>
      <form className="decision-form" onSubmit={(e) => { e.preventDefault(); post(`/api/boutique/cash/sessions/${current.id}/close`, { countedCash: close.countedCash, countedByMethod: close.counted, note: close.note }, t('btq.tillClosed')); }}>
        <h3 className="form-section-title">{t('btq.closeTill')}</h3>
        <p className="field-hint">{t('btq.closeHint')}</p>
        <div className="form-grid">
          <Field label={t('btq.countedCash')}><input type="number" min="0" required value={close.countedCash} onChange={(e) => setClose({ ...close, countedCash: e.target.value })} /></Field>
          {Object.keys(current.expectedByMethod).map((method) => <Field key={method} label={`${t(`btq.method.${method}`)} (${t('btq.counted')})`}><input type="number" min="0" value={close.counted[method] || ''} onChange={(e) => setClose({ ...close, counted: { ...close.counted, [method]: e.target.value } })} /></Field>)}
          <Field label={t('field.notes')} wide><input maxLength="1000" value={close.note} onChange={(e) => setClose({ ...close, note: e.target.value })} /></Field>
        </div>
        {close.countedCash !== '' && <p className="field-hint">{fill(t('btq.varianceWillBe'), { amount: money(Number(close.countedCash) - current.expectedCash) })}</p>}
        <div className="form-submit-bar"><button className="primary-btn" type="submit" disabled={busy}>{t('btq.closeTill')}</button></div>
      </form>
    </Panel> : <form className="form-panel" onSubmit={(e) => { e.preventDefault(); post('/api/boutique/cash/sessions', openForm, t('btq.tillOpened')); }}>
      <div className="panel-header"><div><h2>{t('btq.openTill')}</h2><span>{t('btq.openTillHint')}</span></div></div>
      <div className="form-grid"><Field label={t('btq.openingCash')}><input type="number" min="0" required value={openForm.openingCash} onChange={(e) => setOpenForm({ openingCash: e.target.value })} /></Field></div>
      <div className="form-submit-bar"><button className="primary-btn big-action" type="submit" disabled={busy}>{t('btq.openTill')}</button></div>
    </form>)}
    <Panel title={t('btq.tillHistory')}>
      {sessions?.length ? <div className="table-wrap"><table className="card-table">
        <thead><tr><th>{t('btq.cashier')}</th><th>{t('btq.openedAt')}</th><th>{t('field.status')}</th><th>{t('btq.openingCash')}</th><th>{t('btq.expectedCash')}</th><th>{t('btq.countedCash')}</th><th>{t('btq.variance')}</th></tr></thead>
        <tbody>{sessions.map((s) => <tr key={s.id} className="clickable-row" onClick={() => go('cash', { session: s.id })}>
          <td className="card-title-cell"><strong>{s.openedByName}</strong></td>
          <td data-label={t('btq.openedAt')}>{formatDate(s.openedAt, language)}</td>
          <td data-label={t('field.status')}><Badge tone={s.status === 'open' ? 'active' : 'done'}>{t(`btq.sessionStatus.${s.status}`)}</Badge></td>
          <td data-label={t('btq.openingCash')}>{money(s.openingCash)}</td>
          <td data-label={t('btq.expectedCash')}>{s.expectedCash === null ? '—' : money(s.expectedCash)}</td>
          <td data-label={t('btq.countedCash')}>{s.countedCash === null ? '—' : money(s.countedCash)}</td>
          <td data-label={t('btq.variance')}>{s.cashVariance === null ? '—' : <span className={s.cashVariance < 0 ? 'over-budget' : undefined}>{money(s.cashVariance)}</span>}</td>
        </tr>)}</tbody>
      </table></div> : <Empty>{t('btq.noSessions')}</Empty>}
    </Panel>
  </>;
}

function SessionDetail({ sessionId, fetchJson, onError, onClose }) {
  const { t, language } = useI18n();
  const [session] = useLoad(fetchJson, `/api/boutique/cash/sessions/${encodeURIComponent(sessionId)}`, 0, onError);
  if (!session) return <DetailView onClose={onClose} label={t('btq.till')}><div className="loading-state"><span className="spinner" /></div></DetailView>;
  const f = session.figures || {};
  return <DetailView onClose={onClose} label={t('btq.till')}>
    <section className="panel detail-panel">
      <div className="panel-header"><div><h2>{session.openedByName}</h2><span>{formatDate(session.openedAt, language)} · {t(`btq.sessionStatus.${session.status}`)}{session.closedByName && ` · ${session.closedByName}`}</span></div>
        <button className="text-btn" type="button" onClick={onClose}>{t('action.close')}</button></div>
      <div className="detail-facts">
        <Fact label={t('btq.openingCash')} value={money(session.openingCash)} />
        <Fact label={t('btq.cashTaken')} value={money(f.cashTaken)} />
        <Fact label={t('btq.change')} value={money(f.changeGiven)} />
        <Fact label={t('btq.cashRefunded')} value={money(f.cashRefunded)} />
        <Fact label={t('btq.cashExpenses')} value={money(f.cashExpenses)} />
        <Fact label={t('btq.payouts')} value={money(f.payouts)} />
        <Fact label={t('btq.cashIn')} value={money(f.cashIn)} />
        <Fact label={t('btq.expectedCash')} value={money(session.expectedCash)} />
        <Fact label={t('btq.countedCash')} value={session.countedCash === null ? '—' : money(session.countedCash)} />
        <Fact label={t('btq.variance')} value={session.cashVariance === null ? '—' : money(session.cashVariance)} />
      </div>
      <h3 className="form-section-title">{t('btq.otherMethods')}</h3>
      <div className="detail-facts">{Object.entries(session.expectedByMethod).map(([method, value]) => <Fact key={method} label={t(`btq.method.${method}`)}
        value={`${money(value)}${session.countedByMethod[method] !== undefined && session.countedByMethod[method] !== null ? ` / ${money(session.countedByMethod[method])}` : ''}`} />)}</div>
      {session.movements.length > 0 && <ul className="history-list">{session.movements.map((m) => <li key={m.id}>{t(`btq.cashKind.${m.kind}`)} · {money(m.amount)} · {m.reason}</li>)}</ul>}
      {session.note && <p className="admin-note">{session.note}</p>}
    </section>
  </DetailView>;
}

// ---- expenses -----------------------------------------------------------------------

function ExpensesTab({ fetchJson, onMessage, onError, changed, can, overview }) {
  const { t, language } = useI18n();
  const dialog = useDialog();
  const [busy, run] = useBusy();
  const [tick, setTick] = useState(0);
  const [expenses] = useLoad(fetchJson, '/api/boutique/expenses', tick, onError);
  const [form, setForm] = useState({ category: EXPENSE_CATEGORIES[0], description: '', amount: '', method: 'Cash', spentOn: todayLocal(), fromTill: false });
  const refresh = () => { setTick((n) => n + 1); changed(); };
  const submit = (e) => { e.preventDefault(); run(async () => { try { await fetchJson('/api/boutique/expenses', { method: 'POST', body: JSON.stringify(form) }); onMessage(t('btq.saved')); setForm({ ...form, description: '', amount: '' }); refresh(); } catch (error) { onError(error.message); } }); };
  const voidExpense = (expense) => run(async () => {
    const reason = await dialog.prompt({ title: t('btq.voidExpense'), label: t('btq.reason'), required: true, minLength: 10, multiline: true });
    if (reason === null) return;
    try { await fetchJson(`/api/boutique/expenses/${expense.id}/void`, { method: 'POST', body: JSON.stringify({ reason }) }); onMessage(t('btq.saved')); refresh(); } catch (error) { onError(error.message); }
  });
  return <>
    {can.manage && <form className="form-panel" onSubmit={submit}>
      <div className="panel-header"><div><h2>{t('btq.recordExpense')}</h2><span>{t('btq.expenseHint')}</span></div></div>
      <div className="form-grid">
        <Field label={t('field.category')}><select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{categoryLabel(c, t)}</option>)}</select></Field>
        <Field label={t('btq.amount')}><input type="number" min="1" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
        <Field label={t('btq.method')}><select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value, fromTill: e.target.value === 'Cash' ? form.fromTill : false })}>{BOUTIQUE_PAYMENT_METHODS.map((m) => <option key={m} value={m}>{t(`btq.method.${m}`)}</option>)}</select></Field>
        <Field label={t('table.date')}><input type="date" required value={form.spentOn} onChange={(e) => setForm({ ...form, spentOn: e.target.value })} /></Field>
        <Field label={t('field.description')} wide><input required maxLength="1000" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        {form.method === 'Cash' && overview.mySessionId && <label className="check-field"><input type="checkbox" checked={form.fromTill} onChange={(e) => setForm({ ...form, fromTill: e.target.checked })} /><span>{t('btq.fromTill')}</span></label>}
      </div>
      <div className="form-submit-bar"><button className="primary-btn" type="submit" disabled={busy}>{t('btq.recordExpense')}</button></div>
    </form>}
    <Panel title={t('btq.tab.expenses')} subtitle={expenses ? money(expenses.filter((e) => e.status === 'active').reduce((s, e) => s + e.amount, 0)) : ''}>
      {expenses?.length ? <div className="table-wrap"><table className="card-table">
        <thead><tr><th>{t('field.description')}</th><th>{t('field.category')}</th><th>{t('table.date')}</th><th>{t('btq.method')}</th><th>{t('btq.amount')}</th><th>{t('field.status')}</th><th>{t('expense.recordedBy')}</th>{can.decide && <th>{t('table.actions')}</th>}</tr></thead>
        <tbody>{expenses.map((x) => <tr key={x.id} className={x.status === 'voided' ? 'btq-voided' : undefined}>
          <td className="card-title-cell"><strong>{x.description}</strong>{x.voidReason && <small>{x.voidReason}</small>}</td>
          <td data-label={t('field.category')}>{categoryLabel(x.category, t)}</td><td data-label={t('table.date')}>{formatDate(x.spentOn, language)}</td>
          <td data-label={t('btq.method')}>{t(`btq.method.${x.method}`)}{x.sessionId && ` · ${t('btq.fromTill')}`}</td>
          <td data-label={t('btq.amount')}>{money(x.amount)}</td>
          <td data-label={t('field.status')}><Badge tone={x.status === 'active' ? 'done' : 'stopped'}>{t(`btq.expenseStatus.${x.status}`)}</Badge></td>
          <td data-label={t('expense.recordedBy')}>{x.recordedByName}</td>
          {can.decide && <td className="card-actions">{x.status === 'active' && <button type="button" className="danger-btn" disabled={busy} onClick={() => voidExpense(x)}>{t('btq.voidExpense')}</button>}</td>}
        </tr>)}</tbody>
      </table></div> : <Empty>{t('btq.noExpenses')}</Empty>}
    </Panel>
  </>;
}

// ---- the books and the reports ---------------------------------------------------------

function PeriodPicker({ period, setPeriod, withPeriods = true }) {
  const { t } = useI18n();
  return <div className="filter-grid">
    {withPeriods && <Field label={t('btq.period')}><select value={period.period} onChange={(e) => setPeriod({ ...period, period: e.target.value })}>{REPORT_PERIODS.map((p) => <option key={p} value={p}>{t(`btq.period.${p}`)}</option>)}</select></Field>}
    {period.period === 'daily' && <Field label={t('table.date')}><input type="date" value={period.date} onChange={(e) => setPeriod({ ...period, date: e.target.value })} /></Field>}
    {period.period === 'weekly' && <Field label={t('btq.weekStarting')}><input type="date" value={period.start} onChange={(e) => setPeriod({ ...period, start: e.target.value })} /></Field>}
    {period.period === 'monthly' && <Field label={t('btq.month')}><input type="month" value={period.month} onChange={(e) => setPeriod({ ...period, month: e.target.value })} /></Field>}
    {period.period === 'custom' && <>
      <Field label={t('btq.from')}><input type="date" value={period.start} onChange={(e) => setPeriod({ ...period, start: e.target.value })} /></Field>
      <Field label={t('btq.to')}><input type="date" value={period.end} onChange={(e) => setPeriod({ ...period, end: e.target.value })} /></Field>
    </>}
  </div>;
}

function periodQuery(period) {
  if (period.period === 'daily') return `period=daily&date=${period.date}`;
  if (period.period === 'weekly') return `period=weekly&start=${period.start}`;
  if (period.period === 'monthly') return `period=monthly&month=${period.month}`;
  return `period=custom&start=${period.start}&end=${period.end}`;
}
const defaultPeriod = (kind) => {
  const today = todayLocal();
  return { period: kind, date: today, start: today.slice(0, 8) + '01', end: today, month: today.slice(0, 7) };
};

// The four numbers an owner asks first -- sold, kept, spent, earned -- and the
// working behind them folded away, so the answer is never buried in twelve tiles.
function FinanceGrid({ f }) {
  const { t } = useI18n();
  return <>
    <div className="metric-grid metric-grid-4">
      <Metric label={t('btq.netSales')} value={`${money(f.netSales)} · ${f.sales.count}`} tone="strong" />
      <Metric label={t('btq.grossProfit')} value={money(f.grossProfit)} tone="strong" />
      <Metric label={t('btq.expensesTotal')} value={money(f.expenses.total)} />
      <Metric label={t('btq.netProfit')} value={money(f.netProfit)} tone={f.netProfit < 0 ? 'warn' : 'strong'} />
    </div>
    <Section title={t('btq.moreFigures')}>
    <div className="metric-grid metric-grid-4 btq-more">
      <Metric label={t('btq.grossSales')} value={money(f.sales.gross)} />
      <Metric label={t('btq.discounts')} value={money(f.discounts)} />
      <Metric label={t('btq.returnsValue')} value={money(f.returns.value)} />
      <Metric label={t('btq.costOfSales')} value={money(f.costOfSales)} />
      <Metric label={t('btq.paymentsReceived')} value={money(f.paymentsReceived)} />
      <Metric label={t('btq.inventoryValue')} value={money(f.inventory.value)} />
      <Metric label={t('btq.purchasesReceived')} value={money(f.purchases.value)} />
      <Metric label={t('btq.owedToSuppliers')} value={money(f.supplierBalance)} />
    </div>
    <div className="table-wrap"><table className="card-table">
      <thead><tr><th>{t('btq.method')}</th><th>{t('btq.taken')}</th><th>{t('btq.change')}</th><th>{t('btq.refunded')}</th><th>{t('btq.receivedMoney')}</th></tr></thead>
      <tbody>{f.paymentsByMethod.map((m) => <tr key={m.method}>
        <td className="card-title-cell"><strong>{t(`btq.method.${m.method}`)}</strong></td>
        <td data-label={t('btq.taken')}>{money(m.taken)}</td><td data-label={t('btq.change')}>{money(m.changeGiven)}</td>
        <td data-label={t('btq.refunded')}>{money(m.refunded)}</td><td data-label={t('btq.receivedMoney')}>{money(m.received)}</td>
      </tr>)}</tbody>
    </table></div>
    </Section>
  </>;
}

function BooksTab({ fetchJson, onError }) {
  const { t } = useI18n();
  const [period, setPeriod] = useState(() => defaultPeriod('custom'));
  const [finance] = useLoad(fetchJson, `/api/boutique/finance?${periodQuery(period)}`, 0, onError);
  return <Panel title={t('btq.tab.books')}>
    <PeriodPicker period={period} setPeriod={setPeriod} withPeriods={false} />
    {finance ? <FinanceGrid f={finance} /> : <div className="loading-state"><span className="spinner" /></div>}
  </Panel>;
}

// The Boutique Manager's line to the Director: a report sent with its figures
// frozen, or an issue raised, and the Director's answers to both. Nobody in
// between. Shown on the Reports tab to the manager (to send) and to the
// Director and the General Manager (to read).
function ToDirectorPanel({ fetchJson, onMessage, onError, changed, can, period, query }) {
  const { t, language } = useI18n();
  const dialog = useDialog();
  const [busy, run] = useBusy();
  const [tick, setTick] = useState(0);
  const [submissions] = useLoad(fetchJson, '/api/boutique/submissions', tick, onError);
  const [open, setOpen] = useState(query.get('submission') || '');
  const refresh = () => { setTick((n) => n + 1); changed(); };
  // Two buttons, not two forms always open: the report is the period already
  // on screen (the API titles it by its dates), so all the manager adds is an
  // optional note; an issue is asked as its subject, then what happened.
  const sendReport = () => run(async () => {
    const note = await dialog.prompt({ title: t('btq.sendReport'), label: t('btq.reportNote'), multiline: true });
    if (note === null) return;
    try {
      await fetchJson('/api/boutique/submissions/report', { method: 'POST', body: JSON.stringify({ ...periodBody(period), note }) });
      onMessage(t('btq.reportSent'));
      refresh();
    } catch (error) { onError(error.message); }
  });
  const raise = () => run(async () => {
    const title = await dialog.prompt({ title: t('btq.raiseIssue'), label: t('btq.issueTitle'), required: true });
    if (title === null) return;
    // Titled with the subject just typed: a second dialog under the same title
    // would be the same element, and would keep the subject in its box.
    const note = await dialog.prompt({ title: title.trim(), label: t('btq.issueBody'), required: true, minLength: 10, multiline: true });
    if (note === null) return;
    try {
      await fetchJson('/api/boutique/submissions/incident', { method: 'POST', body: JSON.stringify({ title, note }) });
      onMessage(t('btq.issueSent'));
      refresh();
    } catch (error) { onError(error.message); }
  });
  // Only the Boutique Manager sends: the Director is who it is sent to.
  return <Panel title={t('btq.toDirector')}>
    {can.role === 'manager' && <div className="button-row">
      <button type="button" className="primary-btn big-action" disabled={busy} onClick={sendReport}>{t('btq.sendReport')}</button>
      <button type="button" className="secondary-btn" disabled={busy} onClick={raise}>{t('btq.raiseIssue')}</button>
    </div>}
    <Section title={t('btq.submissions')} count={submissions?.length ?? null} defaultOpen={Boolean(open)}>
      <SubmissionList submissions={submissions} fetchJson={fetchJson} open={open} setOpen={setOpen} language={language} />
    </Section>
  </Panel>;
}

function periodBody(period) {
  if (period.period === 'daily') return { period: 'daily', date: period.date };
  if (period.period === 'weekly') return { period: 'weekly', start: period.start };
  if (period.period === 'monthly') return { period: 'monthly', month: period.month };
  return { period: 'custom', start: period.start, end: period.end };
}

const SUBMISSION_TONE = { submitted: 'waiting', accepted: 'done', returned: 'stopped' };

// Each submission as a line; the open one shows its note, the Director's
// answer and, for a report, the key figures as they were when it was sent.
function SubmissionList({ submissions, fetchJson, open, setOpen, language, decide, busy }) {
  const { t } = useI18n();
  const [detail, setDetail] = useState(null);
  useEffect(() => {
    if (!open) { setDetail(null); return; }
    let cancelled = false;
    fetchJson(`/api/boutique/submissions/${encodeURIComponent(open)}`).then((row) => { if (!cancelled) setDetail(row); }).catch(() => {});
    return () => { cancelled = true; };
  }, [open, fetchJson]);
  if (!submissions) return <div className="compact-loading"><span className="spinner" /></div>;
  if (!submissions.length) return <Empty>{t('btq.noSubmissions')}</Empty>;
  return <ul className="decision-list">{submissions.map((s) => <li className="decision-card" key={s.id}>
    <div className="decision-card-main">
      <span className="decision-card-kind">{t(`btq.subKind.${s.kind}`)}</span>
      <strong><button type="button" className="text-btn" onClick={() => setOpen(String(open) === String(s.id) ? '' : String(s.id))}>{s.title}</button> <Badge tone={SUBMISSION_TONE[s.status]}>{t(`btq.subStatus.${s.status}`)}</Badge></strong>
      <span className="decision-card-meta">{fill(t('btq.sentBy'), { name: s.submittedByName })} · {formatDate(s.submittedAt, language)}{s.decidedByName && ` · ${fill(t('btq.answeredBy'), { name: s.decidedByName })} · ${formatDate(s.decidedAt, language)}`}</span>
      {String(open) === String(s.id) && <div className="detail-notes">
        {s.note && <p>{s.note}</p>}
        {s.decisionNote && <p className="admin-note"><strong>{t('btq.decisionNote')}:</strong> {s.decisionNote}</p>}
        {detail?.snapshot?.finance && <div className="detail-facts">
          <Fact label={t('btq.netSales')} value={money(detail.snapshot.finance.netSales)} />
          <Fact label={t('btq.netProfit')} value={money(detail.snapshot.finance.netProfit)} />
          <Fact label={t('btq.inventoryValue')} value={money(detail.snapshot.finance.inventory.value)} />
          <Fact label={t('btq.owedToSuppliers')} value={money(detail.snapshot.finance.supplierBalance)} />
          <Fact label={t('btq.lowStockCount')} value={detail.snapshot.inventory?.lowStock?.length ?? 0} />
          <Fact label={t('btq.expensesTotal')} value={money(detail.snapshot.finance.expenses.total)} />
        </div>}
      </div>}
    </div>
    {decide && s.status === 'submitted' && <div className="decision-card-actions">
      <button type="button" className="primary-btn" disabled={busy} onClick={() => decide(s, 'accepted')}>{t('btq.accept')}</button>
      <button type="button" className="danger-btn" disabled={busy} onClick={() => decide(s, 'returned')}>{t('btq.returnWithNote')}</button>
    </div>}
  </li>)}</ul>;
}

function ReportsTab({ fetchJson, onMessage, onError, changed, can, query }) {
  const { t, language } = useI18n();
  const [period, setPeriod] = useState(() => defaultPeriod('daily'));
  const [report] = useLoad(fetchJson, `/api/boutique/reports?${periodQuery(period)}`, 0, onError);
  return <>
    {/* A folded section prints folded: open them all first, so the paper
        carries the whole report and not a list of headings. */}
    <Panel title={t('btq.tab.reports')} action={t('btq.print')} onAction={() => { document.querySelectorAll('.boutique details').forEach((d) => { d.open = true; }); window.print(); }}>
      <PeriodPicker period={period} setPeriod={setPeriod} />
      {report && <p className="field-hint">{formatDate(report.period.start, language)} – {formatDate(report.period.end, language)}</p>}
      {report ? <FinanceGrid f={report.finance} /> : <div className="loading-state"><span className="spinner" /></div>}
    </Panel>
    <ToDirectorPanel fetchJson={fetchJson} onMessage={onMessage} onError={onError} changed={changed} can={can} period={period} query={query} />
    {report?.stockProfit && <StockProfitPanel data={report.stockProfit} />}
  </>;
}

// ---- approvals and history ------------------------------------------------------------

function ApprovalsTab({ fetchJson, onMessage, onError, changed, can, go, query }) {
  const { t, language } = useI18n();
  const dialog = useDialog();
  const [busy, run] = useBusy();
  const [tick, setTick] = useState(0);
  const [queue] = useLoad(fetchJson, '/api/boutique/approvals', tick, onError);
  // ?submission=<id> from the bell opens that one.
  const [openSubmission, setOpenSubmission] = useState(query.get('submission') || '');
  const refresh = () => { setTick((n) => n + 1); changed(); };
  const decide = (path, approve, done) => run(async () => {
    const note = approve ? '' : await dialog.prompt({ title: t('btq.refuse'), label: t('btq.reason'), required: true, minLength: 10, multiline: true });
    if (note === null) return;
    try { await fetchJson(path, { method: 'POST', body: JSON.stringify({ approve, note }) }); onMessage(done); refresh(); } catch (error) { onError(error.message); }
  });
  const decideSubmission = (submission, decision) => run(async () => {
    const note = decision === 'accepted'
      ? (await dialog.prompt({ title: t('btq.accept'), label: t('btq.decisionNote'), multiline: true })) ?? null
      : await dialog.prompt({ title: t('btq.returnWithNote'), label: t('btq.decisionNote'), required: true, minLength: 10, multiline: true });
    if (note === null) return;
    try {
      await fetchJson(`/api/boutique/submissions/${submission.id}/decision`, { method: 'POST', body: JSON.stringify({ decision, note }) });
      onMessage(decision === 'accepted' ? t('btq.accepted') : t('btq.returned'));
      refresh();
    } catch (error) { onError(error.message); }
  });
  if (!queue) return <div className="loading-state"><span className="spinner" /></div>;
  // Only the kinds that have something waiting are drawn, and an empty queue
  // is one plain sentence rather than three empty boxes.
  if (!queue.submissions.length && !queue.adjustments.length && !queue.voids.length) {
    return <section className="next-step next-step-done btq-attention"><div className="next-step-text"><strong>{t('btq.allClear')}</strong></div></section>;
  }
  return <>
    {/* What the Boutique Manager sent straight up: reports and issues. The
        Director answers here; the manager and the General Manager read. */}
    {queue.submissions.length > 0 && <Panel title={t('btq.fromManager')} subtitle={String(queue.submissions.length)}>
      <SubmissionList submissions={queue.submissions} fetchJson={fetchJson} open={openSubmission} setOpen={setOpenSubmission} language={language}
        decide={can.decide ? decideSubmission : null} busy={busy} />
    </Panel>}
    {queue.adjustments.length > 0 && <Panel title={t('btq.adjustments')} subtitle={String(queue.adjustments.length)}>
      <ul className="decision-list">{queue.adjustments.map((a) => <li className="decision-card" key={a.id}>
        <div className="decision-card-main">
          <span className="decision-card-kind">{t(`btq.kind.${a.kind}`)}</span>
          <strong>{a.productName} · {a.sku} {variantLabel(a)}</strong>
          <span className="decision-card-meta">{a.kind === 'count' ? fill(t('btq.countedTo'), { count: a.quantity, delta: a.delta }) : `${a.delta > 0 ? '+' : '−'}${qty(Math.abs(a.delta), a.productUnit)}`} · {a.requestedByName} · {formatDate(a.createdAt, language)}</span>
          {a.onShelf !== null && a.onShelf !== undefined && <span className="btq-shelf-after">{fill(t('btq.shelfAfter'), { now: qty(a.onShelf, a.productUnit), after: qty(a.onShelf + a.delta, a.productUnit) })}</span>}
          {a.reason && <p>{a.reason}</p>}
        </div>
        {can.decide && <div className="decision-card-actions">
          <button type="button" className="primary-btn" disabled={busy} onClick={() => decide(`/api/boutique/stock/adjustments/${a.id}/decision`, true, t('btq.adjusted'))}>{t('btq.approve')}</button>
          <button type="button" className="danger-btn" disabled={busy} onClick={() => decide(`/api/boutique/stock/adjustments/${a.id}/decision`, false, t('btq.refused'))}>{t('btq.refuse')}</button>
        </div>}
      </li>)}</ul>
    </Panel>}
    {queue.voids.length > 0 && <Panel title={t('btq.voidRequests')} subtitle={String(queue.voids.length)}>
      <ul className="decision-list">{queue.voids.map((s) => <li className="decision-card" key={s.id}>
        <div className="decision-card-main">
          <span className="decision-card-kind">{t('btq.voidSale')}</span>
          <strong><button type="button" className="text-btn" onClick={() => go('sales', { sale: s.id })}>{s.number}</button> · {money(s.total)}</strong>
          <span className="decision-card-meta">{s.cashierName} · {formatDate(s.soldOn, language)}</span>
          <p>{s.voidReason}</p>
        </div>
        {can.decide && <div className="decision-card-actions">
          <button type="button" className="primary-btn" disabled={busy} onClick={() => decide(`/api/boutique/sales/${s.id}/void-decision`, true, t('btq.voided'))}>{t('btq.approve')}</button>
          <button type="button" className="danger-btn" disabled={busy} onClick={() => decide(`/api/boutique/sales/${s.id}/void-decision`, false, t('btq.voidRefused'))}>{t('btq.refuse')}</button>
        </div>}
      </li>)}</ul>
    </Panel>}
  </>;
}

function HistoryTab({ fetchJson, onError }) {
  const { t, language } = useI18n();
  const [trail] = useLoad(fetchJson, '/api/boutique/audit?limit=200', 0, onError);
  const label = (action) => { const key = `btq.trail.${action}`; const text = t(key); return text === key ? action : text; };
  const detail = (d) => Object.entries(d || {}).filter(([, v]) => v !== null && v !== undefined && v !== '' && typeof v !== 'object').map(([k, v]) => `${k}: ${v}`).join(' · ');
  return <Panel title={t('btq.tab.history')}>
    {trail?.length ? <div className="table-wrap"><table className="card-table">
      <thead><tr><th>{t('table.date')}</th><th>{t('btq.who')}</th><th>{t('btq.what')}</th><th>{t('btq.details')}</th></tr></thead>
      <tbody>{trail.map((row) => <tr key={row.id}>
        <td className="card-title-cell"><strong>{formatDate(row.createdAt, language)}</strong><small>{new Date(row.createdAt).toLocaleTimeString(language)}</small></td>
        <td data-label={t('btq.who')}>{row.actorName || '—'}</td>
        <td data-label={t('btq.what')}>{label(row.action)}{row.entityId ? ` #${row.entityId}` : ''}</td>
        <td data-label={t('btq.details')}>{detail(row.details) || '—'}</td>
      </tr>)}</tbody>
    </table></div> : <Empty>{t('btq.nothingInPeriod')}</Empty>}
  </Panel>;
}

export const BOUTIQUE_TABS = TABS;
