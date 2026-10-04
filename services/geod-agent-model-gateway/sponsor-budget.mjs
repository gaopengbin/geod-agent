/** Calendar periods are derived by the server; client requests never choose one. */
export function sponsorBudgetWindow(provider, now = Date.now()) {
  const period = provider.budgetPeriod ?? 'lifetime';
  if (!['lifetime', 'month'].includes(period)) throw new Error('Invalid sponsored budget period');
  if (period === 'lifetime') return {start: null, end: null};
  const start = new Date(now);
  if (!Number.isFinite(start.getTime())) throw new Error('Invalid sponsored budget clock');
  start.setUTCDate(1);start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);end.setUTCMonth(end.getUTCMonth() + 1);
  return {start: start.toISOString(), end: end.toISOString()};
}
