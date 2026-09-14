import { useState, useCallback } from 'react';

const RANGE_KEY = 'obs-range';
const START_KEY = 'obs-range-start';
const END_KEY   = 'obs-range-end';

/**
 * Shared range-picker state (preset + optional custom start/end) backing the
 * TopBar date filter. Persisted under the same localStorage keys on every
 * page, matching the pre-existing behavior where switching range on one page
 * carried over to the others.
 */
export function useRangeFilter(defaultRange = '7d') {
  const [range, setRangeRaw] = useState(() => localStorage.getItem(RANGE_KEY) || defaultRange);
  const [customRange, setCustomRangeRaw] = useState(() => ({
    start: localStorage.getItem(START_KEY) || '',
    end:   localStorage.getItem(END_KEY)   || '',
  }));

  const setRange = useCallback((r) => {
    setRangeRaw(r);
    localStorage.setItem(RANGE_KEY, r);
  }, []);

  const setCustomRange = useCallback(({ start, end }) => {
    setCustomRangeRaw({ start, end });
    localStorage.setItem(START_KEY, start);
    localStorage.setItem(END_KEY, end);
    setRangeRaw('custom');
    localStorage.setItem(RANGE_KEY, 'custom');
  }, []);

  return { range, setRange, customRange, setCustomRange };
}
