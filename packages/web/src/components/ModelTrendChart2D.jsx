import React, { useMemo, useState, useEffect } from 'react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip,
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

function CustomTooltip({ active, payload, label, metric }) {
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
      {sorted.map(entry => {
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
    </div>
  );
}

// `prevSeries`, when given, must already be aligned index-for-index with the
// trimmed grid (see Dashboard.jsx — it slices by grid.labelOffset/hours.length
// before passing down), so this component never needs to know about trimming.
// Shared by every Line (model lines + the previous-period overlay) so the
// chart reads as one system instead of a mix of animated/static, straight/
// curved series — that mismatch (prev period smoothed + always animating,
// model lines linear + never animating) was the original bug report.
const LINE_ANIMATION_MS = 700;

export default function ModelTrendChart2D({ modelTimeSeries, metric, xLabels, loading, hiddenModels = new Set(), prevSeries = null, modelToProvider = {} }) {
  const { t } = useTranslation();
  const palette = useThemePalette();
  const grid = useMemo(() => buildGrid(modelTimeSeries || [], metric), [modelTimeSeries, metric]);
  const providerIndices = useMemo(() => modelProviderIndices(grid.models, modelToProvider), [grid.models, modelToProvider]);

  // "Invocation" effect on appear is the Line's own draw-in animation
  // (isAnimationActive below); this flag drives a distinct "settle" effect
  // once that finishes — a brief glow pulse (see .chart2d-draw-complete in
  // index.css) instead of the lines just stopping. Reset whenever the
  // series actually changes (new range, new live metric, toggled metric) so
  // the reveal replays instead of only ever firing once per page load.
  const [justRevealed, setJustRevealed] = useState(false);
  useEffect(() => { setJustRevealed(false); }, [modelTimeSeries, metric]);

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
    const row = { name: xLabels[grid.labelOffset + hi] ?? '' };
    grid.models.forEach((model, mi) => {
      row[model] = grid.values[mi][hi];
      row[`${model}__reqs`] = requestsByCell.get(`${hour}|${model}`) || 0;
    });
    if (prevSeries) row.__prev = prevSeries[hi] ?? null;
    return row;
  });

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
    <ResponsiveContainer width="100%" height="100%">
      <LineChart
        data={data}
        margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
        // "Complete" effect: a brief glow pulse across every line's group
        // once its draw-in animation finishes (see the keyframe in
        // index.css) — Recharts applies a component's className to its
        // rendered <svg>, so this reaches every descendant .recharts-line.
        className={justRevealed ? 'chart2d-draw-complete' : ''}
      >
        <CartesianGrid strokeDasharray="3 3" stroke={palette.border} vertical={false} />
        <XAxis dataKey="name" stroke={palette.muted} tick={{ fontSize: 11, fill: palette.muted }} tickLine={false} axisLine={{ stroke: palette.border }} />
        <YAxis
          stroke={palette.muted}
          tick={{ fontSize: 11, fill: palette.muted }}
          tickLine={false}
          axisLine={false}
          width={56}
          tickFormatter={(v) => formatMetricValue(v, metric)}
        />
        <Tooltip content={<CustomTooltip metric={metric} />} cursor={{ stroke: palette.border }} />
        {grid.models.map((model, mi) => {
          const { provider, index } = providerIndices[mi];
          const color = colorForModel(provider, index);
          return (
            <Line
              key={model}
              dataKey={model}
              // linear, not monotone: monotone smoothing can overshoot between
              // two very different consecutive bucket values (e.g. a burst hour
              // next to an empty one), exaggerating the shape of what's really
              // just a couple of isolated datapoints — linear draws exactly
              // what the buckets say, no more. The previous-period line below
              // uses the same type now, for the same reason (it used to be
              // "monotone" — curved — while these were straight, an
              // inconsistency with no data-shape justification).
              type="linear"
              stroke={color}
              strokeWidth={2}
              dot={(props) => <RealDataDot key={`${model}-${props.payload?.name}`} {...props} color={color} />}
              hide={hiddenModels.has(model)}
              activeDot={{ r: 4 }}
              isAnimationActive
              animationDuration={LINE_ANIMATION_MS}
              animationEasing="ease-out"
              onAnimationEnd={() => setJustRevealed(true)}
            />
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
            isAnimationActive
            animationDuration={LINE_ANIMATION_MS}
            animationEasing="ease-out"
            onAnimationEnd={() => setJustRevealed(true)}
          />
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}
