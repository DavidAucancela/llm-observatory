import React, { useMemo, useState, useEffect } from 'react';
import {
  ResponsiveContainer, ComposedChart, Line, Area, XAxis, YAxis,
  CartesianGrid, Tooltip, Brush,
} from 'recharts';
import { useTranslation } from 'react-i18next';
import { readChartPalette, colorForModel } from '../utils/chartColors';
import { modelProviderIndices } from '../utils/providerColors';
import { buildGrid, formatMetricValue } from '../utils/metricGrid';

// Same live-theme-follow behavior as MetricSurface3D's useThemePalette — duplicated
// here (not exported from the 3D file) to keep that file untouched functionally.
function useThemePalette() {
  const [palette, setPalette] = useState(() => readChartPalette());

  useEffect(() => {
    const target = document.querySelector('.theme-dark, .theme-light') || document.documentElement;
    const observer = new MutationObserver(() => setPalette(readChartPalette()));
    observer.observe(target, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return palette;
}

// Custom dot: only draws a marker where the bucket has real requests, not on
// every zero-filled bucket the line passes through — otherwise a sparse,
// bursty series (a couple of real hours in a mostly-empty 24h window) reads
// as a smooth "spike then decay" curve with no way to tell which points are
// actual data vs. interpolated zero.
function RealDataDot({ cx, cy, payload, dataKey, color }) {
  const requests = payload?.[`${dataKey}__reqs`] || 0;
  if (!requests || cx == null || cy == null) return null;
  return <circle cx={cx} cy={cy} r={3} fill="var(--surface, #fff)" stroke={color} strokeWidth={2} />;
}

// A busy bucket with a dozen models made the tooltip taller than the chart on
// a phone, covering what it describes; the rest collapse into "+N".
const TOOLTIP_MAX_ROWS = 6;

function CustomTooltip({ active, payload, label, metric }) {
  const { t } = useTranslation();
  if (!active || !payload?.length) return null;
  // `grid.models` (and so `payload`) is every model with activity ANYWHERE in
  // the selected range — a model quiet on this particular day still gets a
  // zero-filled point so its line stays continuous. Listing it here too just
  // clutters the popup with "0 —" rows for whichever models weren't active
  // that day; drop them the same way RealDataDot already decides "was this
  // point real" (by requests, not by the plotted value — a metric can
  // legitimately be 0 on a real datapoint). `__prev` isn't a per-model row
  // and has no `__reqs` counter, so it's kept unconditionally — except when
  // its value is null (Dashboard.jsx sets `row.__prev = prevSeries[hi] ?? null`
  // for a bucket the previous period has no data for at all): showing that
  // as "Previous period: $0.00" would misreport "no data" as "zero spend".
  const sorted = [...payload]
    .filter(entry => entry.dataKey === '__prev' ? entry.value != null : (entry.payload?.[`${entry.dataKey}__reqs`] || 0) > 0)
    .sort((a, b) => b.value - a.value);
  return (
    <div className="chart2d-tooltip">
      <div className="chart2d-tooltip-label">{label}</div>
      {sorted.length === 0 && (
        <div className="chart2d-tooltip-empty">—</div>
      )}
      {sorted.slice(0, TOOLTIP_MAX_ROWS).map(entry => {
        const requests = entry.payload?.[`${entry.dataKey}__reqs`] || 0;
        return (
          <div key={entry.dataKey} className="chart2d-tooltip-row">
            <span className="chart2d-tooltip-dot" style={{ background: entry.color }} />
            <span className="chart2d-tooltip-name">{entry.name || entry.dataKey}</span>
            <span className="chart2d-tooltip-value">{formatMetricValue(entry.value, metric)}</span>
            {entry.dataKey !== '__prev' && (
              <span className="chart2d-tooltip-reqs">{requests}×</span>
            )}
          </div>
        );
      })}
      {sorted.length > TOOLTIP_MAX_ROWS && (
        <div className="chart2d-tooltip-more">{t('dashboard.tooltipMoreModels', { count: sorted.length - TOOLTIP_MAX_ROWS })}</div>
      )}
    </div>
  );
}

// Y-axis width sized to its widest tick instead of a fixed 56px, which took
// ~15% of a phone-width chart for labels like "$1" or "12". ~6.5px per char
// at the 11px tick font, plus the gap to the plot.
function yAxisWidth(data, models, metric) {
  let max = 0;
  for (const row of data) for (const m of models) if (row[m] > max) max = row[m];
  const label = formatMetricValue(max, metric);
  return Math.min(64, Math.max(32, Math.ceil(label.length * 6.5) + 10));
}

// `prevSeries`, when given, must already be aligned index-for-index with the
// trimmed grid (see Dashboard.jsx — it slices by grid.labelOffset/hours.length
// before passing down), so this component never needs to know about trimming.
// Shared by every Line (model lines + the previous-period overlay) so the
// chart reads as one system instead of a mix of animated/static, straight/
// curved series — that mismatch (prev period smoothed + always animating,
// model lines linear + never animating) was the original bug report.
const LINE_ANIMATION_MS = 700;

// Readability with lots of data. Additive metrics (requests/tokens/cost) stack
// as areas: a dozen crossing lines was unreadable, while stacked bands show
// each model's share and the top edge is the total. Latency and error rate
// can't be summed, so they stay lines — the TOP_LINES busiest models in full,
// the rest faint so they don't bury them.
const STACKED_METRICS = new Set(['requests', 'tokens', 'cost']);
const TOP_LINES = 5;
// Past this many buckets the per-point markers merge into a solid band, and
// the full range squeezes points to a pixel or two — a brush under the plot
// opens on the latest BRUSH_WINDOW buckets and lets you drag through the rest.
const MAX_DOTS = 31;
const BRUSH_MIN_POINTS = 45;
const BRUSH_WINDOW = 30;

export default function ModelTrendChart2D({ modelTimeSeries, metric, xLabels, loading, hiddenModels = new Set(), prevSeries = null, modelToProvider = {}, onPinnedChange, onViewDetails }) {
  const { t } = useTranslation();
  const palette = useThemePalette();
  const grid = useMemo(() => buildGrid(modelTimeSeries || [], metric), [modelTimeSeries, metric]);
  const providerIndices = useMemo(() => modelProviderIndices(grid.models, modelToProvider), [grid.models, modelToProvider]);

  // "Invocation" effect on appear is the Line's own draw-in animation
  // (isAnimationActive below); once it finishes, a brief glow pulse settles it
  // (see .chart2d-draw-complete in index.css). Both play once per view — a new
  // range remounts this component (the loading skeleton replaces it), a new
  // metric changes `metric` — but not on live refreshes: replaying the draw-in
  // and glow on every incoming metric made the chart flash during bursts.
  const [settledMetric, setSettledMetric] = useState(null);
  const settled = settledMetric === metric;
  const onAnimationEnd = () => setSettledMetric(metric);

  // Real request counts per (hour, model), independent of the selected
  // metric — a metric value can legitimately be 0 on a real datapoint (e.g.
  // errorRate), so "was this bucket real" has to come from requests, not
  // from grid.values. Keyed the same way buildGrid's own cellMap is.
  const requestsByCell = useMemo(() => {
    const map = new Map();
    for (const row of modelTimeSeries || []) map.set(`${row.hour}|${row.model}`, parseInt(row.requests || 0, 10));
    return map;
  }, [modelTimeSeries]);

  const totalActivity = grid.values.reduce((sum, row) => sum + row.reduce((a, b) => a + b, 0), 0);
  // >= 1, not > 1: buildGrid trims leading/trailing empty buckets, so a range
  // with a single real day of activity legitimately collapses to one column.
  const hasEnoughData = grid.hours.length >= 1 && totalActivity > 0;

  // xLabels is indexed by the same position as the untrimmed bucket list —
  // see MetricSurface3D's buildGrid for why the alignment is safe, and why
  // grid.labelOffset must be added back to hi after trimming.
  const data = grid.hours.map((hour, hi) => {
    const row = { name: xLabels[grid.labelOffset + hi] ?? '', __bucket: hour };
    grid.models.forEach((model, mi) => {
      row[model] = grid.values[mi][hi];
      row[`${model}__reqs`] = requestsByCell.get(`${hour}|${model}`) || 0;
    });
    if (prevSeries) row.__prev = prevSeries[hi] ?? null;
    return row;
  });

  const stacked = STACKED_METRICS.has(metric);
  const showDots = data.length <= MAX_DOTS;
  const showBrush = data.length >= BRUSH_MIN_POINTS;
  const topModels = useMemo(() => {
    const totals = grid.models.map((m, mi) => [m, grid.values[mi].reduce((a, b) => a + b, 0)]);
    return new Set(totals.sort((a, b) => b[1] - a[1]).slice(0, TOP_LINES).map(([m]) => m));
  }, [grid]);

  // Click a bucket to pin a card (same one the 3D bar uses) listing the
  // visible models active in it, with a link to those requests.
  const [pinnedIndex, setPinnedIndex] = useState(null);
  const pinnedRow = pinnedIndex != null ? data[pinnedIndex] : null;
  useEffect(() => { setPinnedIndex(null); }, [metric, grid.hours.length, grid.hours[0]]);
  useEffect(() => { onPinnedChange?.(pinnedRow != null); }, [pinnedRow != null]);
  const pinnedModels = pinnedRow
    ? grid.models
        .map((model, mi) => ({ model, mi, value: pinnedRow[model], requests: pinnedRow[`${model}__reqs`] }))
        .filter(r => !hiddenModels.has(r.model) && r.requests > 0)
        .sort((a, b) => b.value - a.value)
    : [];

  if (loading) {
    return <div className="obs-skeleton" style={{ height: '100%', borderRadius: 4 }} />;
  }

  if (!hasEnoughData) {
    return (
      <div style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t('dashboard.notEnoughData')}</span>
      </div>
    );
  }

  return (
    <div className="chart2d-wrap">
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart
        data={data}
        margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
        // "Complete" effect: a brief glow pulse across every line's group
        // once its draw-in animation finishes (see the keyframe in
        // index.css) — Recharts applies a component's className to its
        // rendered <svg>, so this reaches every descendant .recharts-line.
        className={settled ? 'chart2d-draw-complete' : ''}
        onClick={(e) => {
          if (e?.activeTooltipIndex == null) return;
          setPinnedIndex(prev => (prev === e.activeTooltipIndex ? null : e.activeTooltipIndex));
        }}
        style={{ cursor: 'pointer' }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke={palette.border} vertical={false} />
        <XAxis dataKey="name" stroke={palette.muted} tick={{ fontSize: 11, fill: palette.muted }} tickLine={false} axisLine={{ stroke: palette.border }} interval="preserveStartEnd" minTickGap={28} />
        <YAxis
          stroke={palette.muted}
          tick={{ fontSize: 11, fill: palette.muted }}
          tickLine={false}
          axisLine={false}
          width={yAxisWidth(data, grid.models, metric)}
          tickFormatter={(v) => formatMetricValue(v, metric)}
        />
        <Tooltip content={<CustomTooltip metric={metric} />} cursor={{ stroke: palette.border }} />
        {grid.models.map((model, mi) => {
          const { provider, index } = providerIndices[mi];
          const color = colorForModel(provider, index);
          return (
            stacked ? (
              <Area
                key={model}
                dataKey={model}
                stackId="models"
                type="linear"
                stroke={color}
                strokeWidth={1.5}
                fill={color}
                fillOpacity={0.55}
                dot={false}
                hide={hiddenModels.has(model)}
                activeDot={{ r: 3 }}
                isAnimationActive={!settled}
                animationDuration={LINE_ANIMATION_MS}
                animationEasing="ease-out"
                onAnimationEnd={onAnimationEnd}
              />
            ) : (
              <Line
                key={model}
                dataKey={model}
                // linear, not monotone: monotone smoothing can overshoot between
                // two very different consecutive bucket values, exaggerating
                // what's really just a couple of isolated datapoints.
                type="linear"
                stroke={color}
                strokeWidth={topModels.has(model) ? 2 : 1.25}
                strokeOpacity={topModels.has(model) ? 1 : 0.35}
                dot={showDots ? (props) => <RealDataDot key={`${model}-${props.payload?.name}`} {...props} color={color} /> : false}
                hide={hiddenModels.has(model)}
                activeDot={{ r: 4 }}
                isAnimationActive={!settled}
                animationDuration={LINE_ANIMATION_MS}
                animationEasing="ease-out"
                onAnimationEnd={onAnimationEnd}
              />
            )
          );
        })}
        {prevSeries && (
          <Line
            dataKey="__prev"
            name={t('dashboard.prevPeriodLabel')}
            type="linear"
            stroke={palette.muted}
            strokeWidth={2}
            strokeDasharray="5 4"
            dot={false}
            activeDot={{ r: 3 }}
            isAnimationActive={!settled}
            animationDuration={LINE_ANIMATION_MS}
            animationEasing="ease-out"
            onAnimationEnd={onAnimationEnd}
          />
        )}
        {showBrush && (
          <Brush
            dataKey="name"
            height={22}
            travellerWidth={10}
            startIndex={data.length - BRUSH_WINDOW}
            stroke={palette.muted}
            fill="transparent"
            tickFormatter={() => ''}
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
    {pinnedRow && (
      <div className="ms3d-summary-card">
        <button
          type="button"
          className="ms3d-summary-close"
          aria-label={t('dashboard.cellSummaryClose')}
          onClick={() => setPinnedIndex(null)}
        >×</button>
        <div className="ms3d-summary-header">
          <div>
            <div className="ms3d-summary-model">{pinnedRow.name}</div>
            <div className="ms3d-summary-bucket">{t('dashboard.bucketModels', { count: pinnedModels.length })}</div>
          </div>
        </div>
        <div className="ms3d-summary-grid">
          {pinnedModels.length === 0 && <div className="chart2d-tooltip-empty">—</div>}
          {pinnedModels.map(({ model, mi, value, requests }) => (
            <div key={model} className="ms3d-summary-row">
              <span className="chart2d-pin-name">
                <span className="chart2d-tooltip-dot" style={{ background: colorForModel(providerIndices[mi].provider, providerIndices[mi].index) }} />
                {model === 'Other' ? t('dashboard.other') : model}
              </span>
              <strong>{formatMetricValue(value, metric)} <em className="chart2d-tooltip-reqs">{requests}×</em></strong>
            </div>
          ))}
        </div>
        {onViewDetails && pinnedModels.length > 0 && (
          <button
            type="button"
            className="obs-btn obs-btn-primary ms3d-summary-details"
            onClick={() => onViewDetails({
              bucket: pinnedRow.__bucket,
              // "Other" is an aggregate, not a model the API can filter on —
              // if it's in the bucket, don't narrow by model at all.
              models: pinnedModels.some(r => r.model === 'Other') ? null : pinnedModels.map(r => r.model),
            })}
          >
            {t('dashboard.cellSummaryViewDetails')} →
          </button>
        )}
      </div>
    )}
    </div>
  );
}
