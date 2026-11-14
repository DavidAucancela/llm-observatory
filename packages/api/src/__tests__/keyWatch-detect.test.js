// Pure detection (services/keyWatch.js → detectKeyEvents / linkKeys) — no DB.
const { detectKeyEvents, linkKeys, modelFamily } = require('../services/keyWatch');

const DAY = 24 * 60 * 60 * 1000;
const D = '2026-11-03';
const dayStart = Date.parse(`${D}T00:00:00Z`);
const at = (dayOffset, hour = 10) => new Date(dayStart + dayOffset * DAY + hour * 3600 * 1000);

const completions = (key_id, dayOffset, { requests = 20, model = 'gpt-5.5-2026-04-23', cost = 0.02, hour = 10 } = {}) => ({
  key_id, hour: at(dayOffset, hour), kind: 'completions', model, requests,
  input_tokens: requests * 300, cached_tokens: 0, output_tokens: requests * 50, images: 0, est_cost_usd: cost,
});
const images = (key_id, dayOffset, { requests = 6, model = 'gpt-image-2-2026-04-21', hour = 14 } = {}) => ({
  key_id, hour: at(dayOffset, hour), kind: 'images', model, requests,
  input_tokens: 0, cached_tokens: 0, output_tokens: 0, images: requests, est_cost_usd: null,
});
const sdkDay = (key_id, dayOffset, requests = 20, hour = 10) => ({ key_id, hour: at(dayOffset, hour), requests, tokens: requests * 350, cost: 0.02 });

const key = (over = {}) => ({ key_id: 'key_cr2', name: 'code-review-2', linked: true, expected_unmonitored: false, prev_last_used_at: null, ...over });

// Ten days of plain completions, every one seen by the SDK.
function history(keyId = 'key_cr2') {
  const usage = [], sdk = [];
  for (let d = -10; d <= -1; d++) { usage.push(completions(keyId, d)); sdk.push(sdkDay(keyId, d)); }
  return { usage, sdk };
}

const types = (events) => events.map(e => `${e.type}:${e.severity}`).sort();

describe('detectKeyEvents — the 2026-11-03 incident', () => {
  it('flags images on a key that only ever made completions (high), even with no price for images', () => {
    const h = history();
    const usage = [...h.usage, completions('key_cr2', 0), images('key_cr2', 0)];
    const sdk = [...h.sdk, sdkDay('key_cr2', 0)];
    const events = detectKeyEvents({ keys: [key()], usage, sdk, days: [D], volume: 'requests' });

    expect(types(events)).toEqual(['key_new_capability:high']);
    const e = events[0];
    expect(e.day).toBe(D);
    expect(e.details.new_kinds).toEqual(['images']);
    expect(e.details.new_models).toEqual(['gpt-image-2']);
    expect(e.details.baseline_kinds).toEqual(['completions']);
    expect(e.details.images).toBe(6);
    expect(e.details.unpriced).toBe(true);
    expect(e.details.key_name).toBe('code-review-2');
  });

  it('also flags the usage as unmonitored when the SDK saw none of it', () => {
    const h = history();
    const usage = [...h.usage, completions('key_cr2', 0), images('key_cr2', 0)];
    // History was covered by the SDK; on the incident day, nothing reached it.
    const events = detectKeyEvents({ keys: [key()], usage, sdk: h.sdk, days: [D], volume: 'requests' });
    expect(types(events)).toEqual(['key_new_capability:high', 'key_unmonitored_usage:high']);
    const u = events.find(e => e.type === 'key_unmonitored_usage');
    expect(u.details).toMatchObject({ provider_volume: 26, sdk_volume: 0, coverage_pct: 0, volume: 'requests' });
  });
});

describe('detectKeyEvents — quiet when nothing is wrong', () => {
  it('a key fully covered by the SDK doing what it always does → nothing', () => {
    const h = history();
    const events = detectKeyEvents({
      keys: [key()], usage: [...h.usage, completions('key_cr2', 0)], sdk: [...h.sdk, sdkDay('key_cr2', 0)], days: [D],
    });
    expect(events).toEqual([]);
  });

  it('a newer snapshot of the same model is not a new capability', () => {
    const h = history();
    const events = detectKeyEvents({
      keys: [key()], usage: [...h.usage, completions('key_cr2', 0, { model: 'gpt-5.5-2026-09-01' })],
      sdk: [...h.sdk, sdkDay('key_cr2', 0)], days: [D],
    });
    expect(events).toEqual([]);
  });

  it('small gaps in SDK coverage below the thresholds don\'t alert', () => {
    const h = history();
    const events = detectKeyEvents({
      keys: [key()], usage: [...h.usage, completions('key_cr2', 0, { requests: 4, cost: 0.01 })], sdk: h.sdk, days: [D],
    });
    expect(events).toEqual([]);
  });

  it('a key younger than the minimum history has no baseline → no new-capability event', () => {
    const usage = [completions('key_cr2', -1), completions('key_cr2', 0), images('key_cr2', 0)];
    const sdk = [sdkDay('key_cr2', -1), sdkDay('key_cr2', 0, 26)];
    expect(detectKeyEvents({ keys: [key()], usage, sdk, days: [D] })).toEqual([]);
  });

  it('a day with no usage for the key produces nothing', () => {
    const h = history();
    expect(detectKeyEvents({ keys: [key()], usage: h.usage, sdk: h.sdk, days: [D] })).toEqual([]);
  });
});

describe('detectKeyEvents — linking and expected keys', () => {
  it('usage of a key the Observatory doesn\'t know → key_unknown (medium), not unmonitored', () => {
    const events = detectKeyEvents({ keys: [key({ linked: false })], usage: [completions('key_cr2', 0, { requests: 1 })], days: [D] });
    expect(types(events)).toEqual(['key_unknown:medium']);
  });

  it('a key missing from the inventory entirely is unknown too', () => {
    const events = detectKeyEvents({ keys: [], usage: [completions('key_ghost', 0)], days: [D] });
    expect(types(events)).toEqual(['key_unknown:medium']);
    expect(events[0].key_id).toBe('key_ghost');
  });

  it('expected_unmonitored silences unknown/unmonitored but NOT a new capability', () => {
    const h = history();
    const events = detectKeyEvents({
      keys: [key({ linked: false, expected_unmonitored: true })],
      usage: [...h.usage, completions('key_cr2', 0), images('key_cr2', 0)], sdk: [], days: [D],
    });
    expect(types(events)).toEqual(['key_new_capability:high']);
  });
});

describe('detectKeyEvents — spend spikes', () => {
  it('an hour far above the week\'s busiest hour is a spike', () => {
    const h = history();
    const events = detectKeyEvents({
      keys: [key()], usage: [...h.usage, completions('key_cr2', 0, { cost: 9.5 })], sdk: [...h.sdk, sdkDay('key_cr2', 0)], days: [D],
    });
    expect(types(events)).toEqual(['key_spend_spike:medium']);
    expect(events[0].details).toMatchObject({ peak_hour_usd: 9.5, baseline_hour_max_usd: 0.02, threshold_usd: 2 });
  });

  it('the $2 floor keeps a cheap key from spiking on noise', () => {
    const h = history();
    const events = detectKeyEvents({
      keys: [key()], usage: [...h.usage, completions('key_cr2', 0, { cost: 1.5 })], sdk: [...h.sdk, sdkDay('key_cr2', 0)], days: [D],
    });
    expect(events).toEqual([]);
  });
});

describe('detectKeyEvents — dormant keys', () => {
  it('used 40 days ago, silent since, used today → key_dormant_active', () => {
    const usage = [completions('key_cr2', -40), completions('key_cr2', 0, { requests: 3 })];
    const events = detectKeyEvents({ keys: [key()], usage, sdk: [sdkDay('key_cr2', 0, 3)], days: [D] });
    expect(types(events)).toEqual(['key_dormant_active:medium']);
    expect(events[0].details.last_used_before.slice(0, 10)).toBe('2026-09-24');
  });

  it('the provider\'s previous last_used_at alone is enough (OpenAI inventory)', () => {
    const events = detectKeyEvents({
      keys: [key({ prev_last_used_at: at(-60) })],
      usage: [completions('key_cr2', 0, { requests: 3 })], sdk: [sdkDay('key_cr2', 0, 3)], days: [D],
    });
    expect(types(events)).toEqual(['key_dormant_active:medium']);
  });
});

describe('detectKeyEvents — Anthropic measures coverage in tokens', () => {
  it('uses tokens when the provider reports no request counts', () => {
    const row = (d) => ({
      key_id: 'apikey_1', hour: at(d), kind: 'messages', model: 'claude-haiku-4-5-20251001', requests: null,
      input_tokens: 40000, cached_tokens: 0, output_tokens: 10000, images: 0, est_cost_usd: 0.09,
    });
    const keys = [{ key_id: 'apikey_1', name: 'bot', linked: true, expected_unmonitored: false }];
    const covered = detectKeyEvents({ keys, usage: [row(0)], sdk: [{ key_id: 'apikey_1', hour: at(0), requests: 7, tokens: 50000, cost: 0.09 }], days: [D], volume: 'tokens' });
    expect(covered).toEqual([]);
    const missed = detectKeyEvents({ keys, usage: [row(0)], sdk: [], days: [D], volume: 'tokens' });
    expect(types(missed)).toEqual(['key_unmonitored_usage:high']);
    expect(missed[0].details).toMatchObject({ volume: 'tokens', provider_volume: 50000, sdk_volume: 0, requests: null });
  });
});

describe('linkKeys', () => {
  const keys = [
    { key_id: 'k1', hint_tail: 'AAAA', linked_credential_id: null },
    { key_id: 'k2', hint_tail: 'BBBB', linked_credential_id: null },
    { key_id: 'k3', hint_tail: 'DUPE', linked_credential_id: null },
    { key_id: 'k4', hint_tail: 'DUPE', linked_credential_id: 9 },
    { key_id: 'k5', hint_tail: 'ZZZZ', linked_credential_id: null },
  ];
  const creds = [{ id: 7, key_hint: 'sk-proj-…AAAA' }, { id: 9, key_hint: 'sk-proj-…DUPE' }];
  const { linkOf, keyForHint } = linkKeys(keys, creds, new Set(['sk-proj-…BBBB', 'sk-proj-…DUPE']));

  it('links by registered credential, by SDK hint, or by hand', () => {
    expect(linkOf.get('k1')).toBe('credential');
    expect(linkOf.get('k2')).toBe('sdk');
    expect(linkOf.get('k4')).toBe('manual');
    expect(linkOf.get('k5')).toBe(null);
  });

  it('never auto-links an ambiguous tail', () => {
    expect(linkOf.get('k3')).toBe(null);
  });

  it('attributes SDK rows by tail, and an ambiguous tail only through the manual link', () => {
    expect(keyForHint('sk-proj-…AAAA')).toBe('k1');
    expect(keyForHint('sk-other…BBBB')).toBe('k2');
    expect(keyForHint('sk-proj-…DUPE')).toBe('k4');
    expect(keyForHint('sk-proj-…NONE')).toBe(null);
  });
});

it('modelFamily strips snapshot dates only', () => {
  expect(modelFamily('gpt-image-2-2026-04-21')).toBe('gpt-image-2');
  expect(modelFamily('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
  expect(modelFamily('gpt-5.5')).toBe('gpt-5.5');
});
