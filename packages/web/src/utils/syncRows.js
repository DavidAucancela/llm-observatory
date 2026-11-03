// Rows the sync inserts (`prompt_preview = 'sync:<provider>'`, see
// api/src/services/syncImport.js) are not API calls: each one is the day's gap
// between what the provider reports and what the SDK booked. Their timestamp is
// the UTC day start and their latency is always 0.
export function isSyncAdjustment(row) {
  return typeof row?.prompt_preview === 'string' && row.prompt_preview.startsWith('sync:');
}
