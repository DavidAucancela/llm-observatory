import { describe, it, expect } from 'vitest';
import {
  isValidDateOnly, earliestAvailableDay, earliestSelectableDay, monthsBackDay,
  quickRangeDates, customRangeError, buildRangeParams,
} from '../dateRange';

// These decide which dates the TopBar picker lets you choose — where the
// "filter shows nothing / asks to sync" bugs lived. `today` is always injected.
const TODAY = '2026-10-13';

describe('isValidDateOnly', () => {
  it('accepts real calendar days only', () => {
    expect(isValidDateOnly('2026-02-28')).toBe(true);
    expect(isValidDateOnly('2024-02-29')).toBe(true);
    for (const bad of ['2026-02-31', '2025-02-29', '2026-13-01', '2026-1-01', '', null, undefined, '2026-10-13T00:00:00Z']) {
      expect([bad, isValidDateOnly(bad)]).toEqual([bad, false]);
    }
  });
});

describe('earliestAvailableDay / earliestSelectableDay', () => {
  it('retention edge counts today as day 1', () => {
    expect(earliestAvailableDay(TODAY, 1)).toBe(TODAY);
    expect(earliestAvailableDay(TODAY, 1095)).toBe('2023-10-15');
  });
  it('never offers days before the first record, nor before retention', () => {
    expect(earliestSelectableDay(TODAY, 1095, '2023-11-01')).toBe('2023-11-01');
    expect(earliestSelectableDay(TODAY, 1095, '2019-01-01')).toBe('2023-10-15');
    expect(earliestSelectableDay(TODAY, 1095, null)).toBe('2023-10-15');
    expect(earliestSelectableDay(TODAY, 1095, 'garbage')).toBe('2023-10-15');
    expect(earliestSelectableDay(TODAY, 1095, '2027-01-01')).toBe(TODAY); // clock skew: a future first record caps at today
  });
});

describe('monthsBackDay / quickRangeDates', () => {
  it('clamps the day of month for short months', () => {
    expect(monthsBackDay(1, '2026-03-31')).toBe('2026-02-28');
    expect(monthsBackDay(12, '2024-02-29')).toBe('2023-02-28');
    expect(monthsBackDay(24, TODAY)).toBe('2024-10-13');
  });
  it('a shortcut never starts before the selectable minimum', () => {
    expect(quickRangeDates(24, TODAY, '2025-01-01')).toEqual({ start: '2025-01-01', end: TODAY });
    expect(quickRangeDates(3, TODAY, '2025-01-01')).toEqual({ start: '2026-07-13', end: TODAY });
    expect(quickRangeDates(null, TODAY, '2023-11-01')).toEqual({ start: '2023-11-01', end: TODAY });
  });
});

describe('customRangeError', () => {
  const err = (s, e, first = null) => customRangeError(s, e, TODAY, 1095, first);
  it('incomplete input explains nothing yet', () => {
    expect(err('', '2026-10-01')).toBeNull();
  });
  it('explains each limit with its own message', () => {
    expect(err('2026-02-31', '2026-03-01')).toBe('topbar.rangeErrInvalid');
    expect(err('2026-10-05', '2026-10-01')).toBe('topbar.rangeErrOrder');
    expect(err('2026-10-01', '2026-10-14')).toBe('topbar.rangeErrFuture');
    expect(customRangeError('2020-01-01', TODAY, TODAY, 9999)).toBe('topbar.rangeErrTooLong');
    expect(err('2023-01-01', '2023-06-01')).toBe('topbar.rangeErrRetention');
    expect(err('2023-11-01', '2023-12-01', '2024-03-01')).toBe('topbar.rangeErrNoData');
    expect(err('2024-01-01', '2024-06-01', '2024-03-01')).toBe('topbar.rangeErrBeforeData');
  });
  it('a range inside the data is fine; retention is skipped when unknown', () => {
    expect(err('2024-03-01', TODAY, '2024-03-01')).toBeNull();
    expect(customRangeError('2023-01-01', '2023-06-01', TODAY)).toBeNull();
  });
});

describe('buildRangeParams', () => {
  it('sends whole UTC days for a custom range (the end day is included)', () => {
    expect(buildRangeParams('custom', { start: '2026-01-01', end: '2026-01-31' })).toEqual({
      range: 'custom', start: '2026-01-01T00:00:00.000Z', end: '2026-01-31T23:59:59.999Z',
    });
    expect(buildRangeParams('custom', { start: '2026-01-01' })).toEqual({ range: 'custom' });
    expect(buildRangeParams('7d')).toEqual({ range: '7d' });
  });
});
