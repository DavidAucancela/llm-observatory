import { readCssVar } from './chartColors';

// Canonical provider color/label maps — single source shared by the spend
// cards (RangeSpend/ProviderBreakdown/TopModels) and the chart's per-model
// shading below, so a provider's hue is defined exactly once.
export const PROVIDER_COLORS = {
  anthropic: 'var(--anthropic)',
  openai: 'var(--openai)',
  gemini: 'var(--gemini)',
  grok: 'var(--grok)',
  kimi: 'var(--kimi)',
  deepinfra: 'var(--deepinfra)',
};

export const PROVIDER_LABELS = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  grok: 'Grok',
  kimi: 'Kimi',
  deepinfra: 'DeepInfra',
};

// Matches index.css's :root values — used only as a fallback when
// readCssVar can't resolve the live custom property (e.g. no themed root in
// the DOM yet), same fallback pattern as chartColors.js's readChartPalette.
const PROVIDER_HEX_FALLBACK = {
  anthropic: '#D97706',
  openai: '#059669',
  gemini: '#4285F4',
  grok: '#3F3F46',
  kimi: '#0D9488',
  deepinfra: '#7C3AED',
};

// Lightness deltas (HSL percentage points) applied per index-within-provider
// — capped at 4 variants (realistic per-provider model counts), 5th+ model
// of the same provider wraps via modulo. Adjusting L only (not mixing toward
// white/black in RGB/oklab) keeps hue and saturation intact, so every shade
// still reads as "that provider's color" — the earlier white/black-mix
// approach washed the lightest/darkest steps out to near-invisible against
// the dark/light theme backgrounds respectively. Symmetric deltas work in
// both themes without a dark/light branch, since final L is clamped to a
// range that stays legible against either background.
const LIGHTNESS_DELTAS = [0, 14, -14, 24];
const MIN_LIGHTNESS = 22;
const MAX_LIGHTNESS = 82;

function resolveProviderHex(provider) {
  const varName = `--${provider}`;
  const fallback = PROVIDER_HEX_FALLBACK[provider] || '#64748B';
  return readCssVar(varName, fallback);
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const num = parseInt(full, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function rgbToHex({ r, g, b }) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return '#' + [r, g, b].map(v => clamp(v).toString(16).padStart(2, '0')).join('');
}

function rgbToHsl({ r, g, b }) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  switch (max) {
    case rn: h = (gn - bn) / d + (gn < bn ? 6 : 0); break;
    case gn: h = (bn - rn) / d + 2; break;
    default: h = (rn - gn) / d + 4;
  }
  return { h: h * 60, s: s * 100, l: l * 100 };
}

function hslToRgb({ h, s, l }) {
  const sn = s / 100, ln = l / 100;
  if (sn === 0) { const v = ln * 255; return { r: v, g: v, b: v }; }
  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  const hue2rgb = (t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const hn = h / 360;
  return {
    r: hue2rgb(hn + 1 / 3) * 255,
    g: hue2rgb(hn) * 255,
    b: hue2rgb(hn - 1 / 3) * 255,
  };
}

// Shifts a hex color's lightness by a fixed step-index delta, hue/saturation
// unchanged. Shared by both the three.js (literal hex) and 2D/DOM paths —
// unlike a CSS color-mix() string, a plain hex works everywhere (canvas,
// three.js Color, and any DOM style) so there's no need for two formats.
function shadeHex(hex, indexWithinProvider) {
  const delta = LIGHTNESS_DELTAS[indexWithinProvider % LIGHTNESS_DELTAS.length];
  if (delta === 0) return hex;
  const hsl = rgbToHsl(hexToRgb(hex));
  const l = Math.max(MIN_LIGHTNESS, Math.min(MAX_LIGHTNESS, hsl.l + delta));
  return rgbToHex(hslToRgb({ h: hsl.h, s: hsl.s, l }));
}

// For three.js (MetricSurface3D) — returns a literal hex string (its Color
// parser doesn't run through the DOM's computed-style resolver, so a CSS
// custom property or function string won't parse there).
export function shadeForModelRGB(provider, indexWithinProvider) {
  if (!provider) return '#64748B'; // "Other" bucket — neutral slate
  return shadeHex(resolveProviderHex(provider), indexWithinProvider);
}

// For 2D/DOM contexts (Recharts, legend dots) — same literal-hex shading;
// components already re-render on theme change (dark-mode toggle flows down
// as a prop from App.jsx), so there's no need for a CSS-native color-mix()
// string to "stay live" on its own.
export function shadeForModelCSS(provider, indexWithinProvider) {
  if (!provider) return '#64748B';
  return shadeHex(resolveProviderHex(provider), indexWithinProvider);
}

// Walks an ordered model list once, assigning each model a 0-based index
// within its own provider (e.g. two Anthropic models get 0 and 1, so their
// colors are two distinct shades of the same hue). Models with no known
// provider (the synthetic "Other" bucket) get provider: null — colorForModel
// falls back to the fixed neutral slate for those. Pure function of
// (models order, modelToProvider) so every consumer (2D chart, 3D chart,
// legend) computes the identical mapping independently, no shared state needed.
export function modelProviderIndices(models, modelToProvider) {
  const counters = {};
  return models.map((model) => {
    const provider = modelToProvider[model] || null;
    if (!provider) return { provider: null, index: 0 };
    const index = counters[provider] || 0;
    counters[provider] = index + 1;
    return { provider, index };
  });
}
