import { useState, useCallback } from 'react';
import { RANGE_PRESETS, customRangeError } from '../utils/dateRange';

const RANGE_KEY = 'obs-range';
const START_KEY = 'obs-range-start';
const END_KEY   = 'obs-range-end';

function readStored(key) {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}
function writeStored(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode / quota: keep in-memory state */ }
}

// Whatever was persisted may be stale or hand-edited (a preset that no longer
// exists, `custom` with no dates, an impossible date). Fall back to the page's
// default instead of sending the API a window it will reject.
function sanitize(defaultRange) {
  const start = readStored(START_KEY);
  const end   = readStored(END_KEY);
  const customOk = Boolean(start && end) && customRangeError(start, end) === null;
  const stored = readStored(RANGE_KEY);
  const range = stored === 'custom'
    ? (customOk ? 'custom' : defaultRange)
    : (RANGE_PRESETS.includes(stored) ? stored : defaultRange);
  return { range, customRange: customOk ? { start, end } : { start: '', end: '' } };
}

/**
 * Shared range-picker state (preset + optional custom start/end) backing the
 * TopBar date filter. Persisted under the same localStorage keys on every
 * page, matching the pre-existing behavior where switching range on one page
 * carried over to the others.
 */
export function useRangeFilter(defaultRange = '7d') {
  const [initial] = useState(() => sanitize(defaultRange));
  const [range, setRangeRaw] = useState(initial.range);
  const [customRange, setCustomRangeRaw] = useState(initial.customRange);

  const setRange = useCallback((r) => {
    setRangeRaw(r);
    writeStored(RANGE_KEY, r);
  }, []);

  const setCustomRange = useCallback(({ start, end }) => {
    setCustomRangeRaw({ start, end });
    writeStored(START_KEY, start);
    writeStored(END_KEY, end);
    setRangeRaw('custom');
    writeStored(RANGE_KEY, 'custom');
  }, []);

  return { range, setRange, customRange, setCustomRange };
}
