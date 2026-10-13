import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidDateOnly, earliestAvailableDay, earliestSelectableDay, monthsBackDay,
  quickRangeDates, customRangeError, buildRangeParams,
} from '../dateRange';

// These decide which dates the TopBar picker lets you choose — where the
// "filter shows nothing / asks to sync" bugs lived. `today` is always injected.
const TODAY = '2026-10-13';

describe('isValidDateOnly', () => {
  it('accepts real calendar days only', () => {
    assert.equal(isValidDateOnly('2026-02-28'), true);
    assert.equal(isValidDateOnly('2024-02-29'), true);
    for (const bad of ['2026-02-31', '2025-02-29', '2026-13-01', '2026-1-01', '', null, undefined, '2026-10-13T00:00:00Z']) {
      assert.deepEqual([bad, isValidDateOnly(bad)], [bad, false]);
    }
  });
});

describe('earliestAvailableDay / earliestSelectableDay', () => {
  it('retention edge counts today as day 1', () => {
    assert.equal(earliestAvailableDay(TODAY, 1), TODAY);
    assert.equal(earliestAvailableDay(TODAY, 1095), '2023-10-15');
  });
  it('never offers days before the first record, nor before retention', () => {
    assert.equal(earliestSelectableDay(TODAY, 1095, '2023-11-01'), '2023-11-01');
    assert.equal(earliestSelectableDay(TODAY, 1095, '2019-01-01'), '2023-10-15');
    assert.equal(earliestSelectableDay(TODAY, 1095, null), '2023-10-15');
    assert.equal(earliestSelectableDay(TODAY, 1095, 'garbage'), '2023-10-15');
    assert.equal(earliestSelectableDay(TODAY, 1095, '2027-01-01'), TODAY); // clock skew: a future first record caps at today
  });
});

describe('monthsBackDay / quickRangeDates', () => {
  it('clamps the day of month for short months', () => {
    assert.equal(monthsBackDay(1, '2026-03-31'), '2026-02-28');
    assert.equal(monthsBackDay(12, '2024-02-29'), '2023-02-28');
    assert.equal(monthsBackDay(24, TODAY), '2024-10-13');
  });
  it('a shortcut never starts before the selectable minimum', () => {
    assert.deepEqual(quickRangeDates(24, TODAY, '2025-01-01'), { start: '2025-01-01', end: TODAY });
    assert.deepEqual(quickRangeDates(3, TODAY, '2025-01-01'), { start: '2026-07-13', end: TODAY });
    assert.deepEqual(quickRangeDates(null, TODAY, '2023-11-01'), { start: '2023-11-01', end: TODAY });
  });
});

describe('customRangeError', () => {
  const err = (s, e, first = null) => customRangeError(s, e, TODAY, 1095, first);
  it('incomplete input explains nothing yet', () => {
    assert.equal(err('', '2026-10-01'), null);
  });
  it('explains each limit with its own message', () => {
    assert.equal(err('2026-02-31', '2026-03-01'), 'topbar.rangeErrInvalid');
    assert.equal(err('2026-10-05', '2026-10-01'), 'topbar.rangeErrOrder');
    assert.equal(err('2026-10-01', '2026-10-14'), 'topbar.rangeErrFuture');
    assert.equal(customRangeError('2020-01-01', TODAY, TODAY, 9999), 'topbar.rangeErrTooLong');
    assert.equal(err('2023-01-01', '2023-06-01'), 'topbar.rangeErrRetention');
    assert.equal(err('2023-11-01', '2023-12-01', '2024-03-01'), 'topbar.rangeErrNoData');
    assert.equal(err('2024-01-01', '2024-06-01', '2024-03-01'), 'topbar.rangeErrBeforeData');
  });
  it('a range inside the data is fine; retention is skipped when unknown', () => {
    assert.equal(err('2024-03-01', TODAY, '2024-03-01'), null);
    assert.equal(customRangeError('2023-01-01', '2023-06-01', TODAY), null);
  });
});

describe('buildRangeParams', () => {
  it('sends whole UTC days for a custom range (the end day is included)', () => {
    assert.deepEqual(buildRangeParams('custom', { start: '2026-01-01', end: '2026-01-31' }), {
      range: 'custom', start: '2026-01-01T00:00:00.000Z', end: '2026-01-31T23:59:59.999Z',
    });
    assert.deepEqual(buildRangeParams('custom', { start: '2026-01-01' }), { range: 'custom' });
    assert.deepEqual(buildRangeParams('7d'), { range: '7d' });
  });
});
