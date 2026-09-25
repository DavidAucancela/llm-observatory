import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import ProviderBadge from '../components/ProviderBadge';
import ModelCostBreakdown from '../components/ModelCostBreakdown';
import TopBar from '../components/TopBar';
import CoverageBanner from '../components/CoverageBanner';
import { formatCost, fmtLatency, fmtCompact } from '../utils/fmt';
import { useApi } from '../hooks/useApi';
import { useRangeFilter } from '../hooks/useRangeFilter';
import { RANGE_PRESETS, buildRangeParams, rangeLabel } from '../utils/dateRange';

const RANGES = RANGE_PRESETS;

const PROVIDER_COLORS = { anthropic: '#D97706', openai: '#059669', gemini: '#4285F4', grok: '#3F3F46', kimi: '#0D9488', deepinfra: '#7C3AED' };

function parseModel(m) {
  return {
    ...m,
    total_cost:        parseFloat(m.total_cost)   || 0,
    requests:          parseInt(m.requests, 10)   || 0,
    total_tokens:      parseInt(m.total_tokens, 10) || 0,
    avg_latency:       parseFloat(m.avg_latency)  || 0,
    // Cost split + token detail behind the breakdown chart (added to
    // GET /api/metrics/summary's by_model rows).
    input_tokens:       parseInt(m.input_tokens, 10)       || 0,
    output_tokens:      parseInt(m.output_tokens, 10)      || 0,
    cache_read_tokens:  parseInt(m.cache_read_tokens, 10)  || 0,
    cache_write_tokens: parseInt(m.cache_write_tokens, 10) || 0,
    error_count:        parseInt(m.error_count, 10)        || 0,
    input_cost:         parseFloat(m.input_cost)         || 0,
    output_cost:        parseFloat(m.output_cost)        || 0,
    unattributed_cost:  parseFloat(m.unattributed_cost)  || 0,
  };
}

const PROVIDER_LABELS = { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Gemini', grok: 'Grok', kimi: 'Kimi', deepinfra: 'DeepInfra' };

// Cost per 1K tokens vs. avg latency, bubble sized by request volume — answers
// "which model is actually worth using", which sorting-by-total-cost alone
// can't (a cheap-but-heavily-used model looks "expensive" by total spend).
function EfficiencyScatter({ models }) {
  const { t } = useTranslation();

  const points = models
    .filter(m => m.total_tokens > 0)
    .map(m => ({ ...m, costPer1k: (m.total_cost / m.total_tokens) * 1000 }));

  if (points.length < 2) return null;

  const W = 560, H = 300;
  const padL = 58, padR = 16, padT = 16, padB = 34;
  const maxLatency = Math.max(...points.map(p => p.avg_latency), 1);
  const maxCost    = Math.max(...points.map(p => p.costPer1k), 0.0001);
  const maxRequests = Math.max(...points.map(p => p.requests), 1);

  const x = (v) => padL + (v / maxLatency) * (W - padL - padR);
  const y = (v) => (H - padB) - (v / maxCost) * (H - padB - padT);
  const r = (reqs) => 5 + Math.sqrt(reqs / maxRequests) * 16;

  const cheapest = points.reduce((a, b) => (b.costPer1k < a.costPer1k ? b : a));
  const priciest = points.reduce((a, b) => (b.costPer1k > a.costPer1k ? b : a));
  const providers = [...new Set(points.map(p => p.provider))];

  return (
    <div className="obs-card" style={{ padding: '16px 20px', marginBottom: 28 }}>
      <div className="obs-section-label" style={{ marginBottom: 4 }}>{t('models.efficiencyTitle')}</div>
      <div style={{ fontSize: 11, color: 'var(--faint)', marginBottom: 14 }}>{t('models.efficiencySubtitle')}</div>

      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 400px', minWidth: 280 }}>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}>
            <g stroke="var(--border-soft)" strokeWidth="1">
              <line x1={padL} y1={padT} x2={padL} y2={H - padB} />
              <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} />
            </g>

            {points.map(p => (
              <circle
                key={`${p.provider}-${p.model}`}
                cx={x(p.avg_latency)} cy={y(p.costPer1k)} r={r(p.requests)}
                fill={PROVIDER_COLORS[p.provider] ?? 'var(--text)'} fillOpacity="0.72"
              >
                <title>{`${p.model}\n${formatCost(p.costPer1k, { small: true })} / 1K tokens\n${fmtLatency(p.avg_latency)}\n${p.requests.toLocaleString()} reqs`}</title>
              </circle>
            ))}

            {/* Direct labels only on the two standouts — never one per point */}
            <text x={x(cheapest.avg_latency)} y={Math.max(10, y(cheapest.costPer1k) - r(cheapest.requests) - 6)} textAnchor="middle" fontSize="10" fontWeight="600" fill="var(--text)">
              {cheapest.model}
            </text>
            {priciest.model !== cheapest.model && (
              <text x={x(priciest.avg_latency)} y={Math.max(10, y(priciest.costPer1k) - r(priciest.requests) - 6)} textAnchor="middle" fontSize="10" fontWeight="600" fill="var(--text)">
                {priciest.model}
              </text>
            )}

            <text x={padL} y={H - padB + 18} fontSize="10" fill="var(--faint)" fontFamily="var(--font-mono)">0ms</text>
            <text x={W - padR} y={H - padB + 18} textAnchor="end" fontSize="10" fill="var(--faint)" fontFamily="var(--font-mono)">{fmtLatency(maxLatency)}</text>
            <text x={(padL + W - padR) / 2} y={H - 4} textAnchor="middle" fontSize="10.5" fill="var(--muted)">{t('models.axisLatency')}</text>

            <text x={padL - 10} y={H - padB} textAnchor="end" fontSize="10" fill="var(--faint)" fontFamily="var(--font-mono)">$0</text>
            <text x={padL - 10} y={padT + 8} textAnchor="end" fontSize="10" fill="var(--faint)" fontFamily="var(--font-mono)">{formatCost(maxCost, { small: true })}</text>
            <text transform={`translate(14 ${(padT + H - padB) / 2}) rotate(-90)`} textAnchor="middle" fontSize="10.5" fill="var(--muted)">{t('models.axisCostPer1k')}</text>
          </svg>
        </div>

        <div style={{ flex: '0 0 160px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div className="obs-section-label" style={{ fontSize: 10, marginBottom: 6 }}>{t('activity.providerColumn')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {providers.map(p => (
                <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, color: 'var(--muted)' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: PROVIDER_COLORS[p] ?? 'var(--text)', flexShrink: 0 }} />
                  {PROVIDER_LABELS[p] ?? p}
                </div>
              ))}
            </div>
          </div>
          <div style={{
            fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.5, background: 'var(--page)',
            border: '1px solid var(--border)', borderRadius: 8, padding: '9px 10px',
          }}>
            {t('models.efficiencyBestValue', { model: cheapest.model })}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Models({ darkMode, onToggleDarkMode }) {
  const { range, setRange, customRange, setCustomRange } = useRangeFilter('7d');
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const { apiFetch } = useApi();
  const { t, i18n } = useTranslation();
  const rangeParams = buildRangeParams(range, customRange);
  const rangeQuery  = new URLSearchParams(rangeParams).toString();

  useEffect(() => {
    setLoading(true);
    apiFetch(`/api/metrics/summary?${rangeQuery}`)
      .then(r => r.json())
      .then(d => { setSummary(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [rangeQuery]);

  const rangeLabelText = rangeLabel(range, customRange, t, i18n.language);

  const allModels = (summary?.by_model || []).map(parseModel);

  return (
    <main className="obs-main obs-fade-in">
      <TopBar
        title={t('activity.modelsTab')}
        ranges={RANGES}
        range={range}
        onRangeChange={setRange}
        customRange={customRange}
        onCustomRangeApply={setCustomRange}
        darkMode={darkMode}
        onToggleDarkMode={onToggleDarkMode}
      />

      <CoverageBanner rangeParams={rangeParams} />

      <div className="obs-content" style={{ paddingTop: 0 }}>
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="obs-skeleton" style={{ height: 28, borderRadius: 3 }} />
            ))}
          </div>
        ) : (
          <>
            <EfficiencyScatter models={allModels} />

            <ModelCostBreakdown models={allModels} range={rangeLabelText} />

            <div className="obs-section-label" style={{ marginBottom: 8 }}>{t('activity.allModels')}</div>
            <div className="obs-table-wrap">
              <table className="obs-table">
                <thead>
                  <tr>
                    <th>{t('activity.modelColumn')}</th>
                    <th>{t('activity.providerColumn')}</th>
                    <th className="col-num">{t('activity.requestsCol')}</th>
                    <th className="col-num">{t('activity.tokensCol')}</th>
                    <th className="col-num">{t('activity.totalCostCol')}</th>
                    <th className="col-num">{t('activity.avgLatencyCol')}</th>
                  </tr>
                </thead>
                <tbody>
                  {allModels.length === 0 ? (
                    <tr><td colSpan={6}><div className="obs-empty"><div className="obs-empty-title">{t('common.noData')}</div></div></td></tr>
                  ) : [...allModels].sort((a, b) => b.requests - a.requests).map(m => (
                    <tr key={`${m.provider}-${m.model}`} style={{ cursor: 'default' }}>
                      <td className="col-mono">{m.model}</td>
                      <td><ProviderBadge provider={m.provider} /></td>
                      <td className="col-num">{m.requests.toLocaleString()}</td>
                      <td className="col-num">{fmtCompact(m.total_tokens)}</td>
                      <td className="col-num">{formatCost(m.total_cost, { small: true })}</td>
                      <td className="col-num col-muted">{fmtLatency(m.avg_latency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
