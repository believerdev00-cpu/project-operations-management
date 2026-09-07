// Administrator-maintained reference rates (mockup section 4).
// Every revision is inserted as a new row, so the newest row is the current
// reference rate and the older rows are the rate history. A movement freezes
// the rate it was saved with onto its own record; changing the reference rate
// later never rewrites past transactions.

export const CURRENCIES = ['RWF', 'USD', 'CDF'];

export function mapRate(row) {
  return {
    id: row.id,
    rwfPerUsd: Number(row.rwf_per_usd),
    cdfPerUsd: Number(row.cdf_per_usd),
    note: row.note,
    updatedBy: row.updated_by,
    updatedByName: row.updated_by_name,
    updatedAt: row.created_at
  };
}

export async function getCurrentRate(pool) {
  const result = await pool.query('SELECT * FROM exchange_rates ORDER BY id DESC LIMIT 1');
  if (!result.rowCount) {
    return { id: null, rwfPerUsd: 1450, cdfPerUsd: 2850, note: 'Fallback default', updatedByName: 'System', updatedAt: null };
  }
  return mapRate(result.rows[0]);
}

// An amount held in `currency` expressed in all three currencies, using the
// rate pair supplied (either the current reference rate or the pair frozen
// onto the movement).
export function convertAmount(amount, currency, rwfPerUsd, cdfPerUsd) {
  const value = Number(amount || 0);
  const rwfRate = Number(rwfPerUsd) > 0 ? Number(rwfPerUsd) : 1450;
  const cdfRate = Number(cdfPerUsd) > 0 ? Number(cdfPerUsd) : 2850;

  let usd;
  if (currency === 'USD') usd = value;
  else if (currency === 'CDF') usd = value / cdfRate;
  else usd = value / rwfRate;

  return {
    usd: round2(usd),
    rwf: round2(usd * rwfRate),
    cdf: round2(usd * cdfRate)
  };
}

export function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}
