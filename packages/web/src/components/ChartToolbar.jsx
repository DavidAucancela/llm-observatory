import React from 'react';
import { useTranslation } from 'react-i18next';
import { colorForModel } from '../utils/chartColors';
import { modelProviderIndices } from '../utils/providerColors';
import { shortModelName } from '../utils/modelAlias';

function IconHelp() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 2-3 4" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function IconRefresh({ spinning }) {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      style={{ animation: spinning ? 'spin 1s linear infinite' : 'none' }}>
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}

// ── 3D camera-control icons ── (moved here with the nav cluster itself from
// MetricSurface3D's old on-canvas .ms3d-nav overlay)
function IconRotateLeft() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 14 4 9 9 4" /><path d="M20 20v-7a4 4 0 0 0-4-4H4" />
    </svg>
  );
}
function IconRotateRight() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 14 20 9 15 4" /><path d="M4 20v-7a4 4 0 0 1 4-4h12" />
    </svg>
  );
}
function IconZoomIn() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  );
}
function IconZoomOut() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  );
}
function IconOrbitLock({ locked }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      {locked ? <path d="M8 11V7a4 4 0 0 1 8 0v4" /> : <path d="M8 11V7a4 4 0 0 1 7.5-2" />}
    </svg>
  );
}
function IconAutoRotate() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-3-6.7" /><polyline points="21 4 21 9 16 9" />
    </svg>
  );
}
function IconResetView() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}

// Preset viewpoints + step zoom/rotate + orbit-lock/auto-rotate/reset for the
// 3D view. `chart3d` is the control surface Dashboard wires to MetricSurface3D
// (imperative camera actions via ref + the orbitLocked/autoRotateOn state it
// owns); the whole block only renders in 3D mode. It is a
// .dash-chart-rail-section like the legend and the foot — same border-top,
// same short section label, same control height — so the merged camera cluster
// reads as one more block of the panel rather than a transplanted overlay.
// Rows are full-width grids of equal-size cells (4 / 4 / 3), never a 4-column
// row left with a hole in it.
function Chart3DControls({ chart3d, collapsed, t }) {
  const tab = collapsed ? -1 : 0;
  return (
    <div className="dash-chart-rail-section dash-chart-rail-3d" role="group" aria-label={t('dashboard.nav3dLabel')}>
      <div className="obs-section-label dash-chart-rail-section-label">{t('dashboard.nav3dShort')}</div>
      <div className="dash-chart-rail-3d-views">
        <button type="button" tabIndex={tab} onClick={() => chart3d.onView('iso')} title={t('dashboard.view3dIso')}>{t('dashboard.view3dIsoShort')}</button>
        <button type="button" tabIndex={tab} onClick={() => chart3d.onView('front')} title={t('dashboard.view3dFront')}>{t('dashboard.view3dFrontShort')}</button>
        <button type="button" tabIndex={tab} onClick={() => chart3d.onView('top')} title={t('dashboard.view3dTop')}>{t('dashboard.view3dTopShort')}</button>
        <button type="button" tabIndex={tab} onClick={() => chart3d.onView('side')} title={t('dashboard.view3dSide')}>{t('dashboard.view3dSideShort')}</button>
      </div>
      <div className="dash-chart-rail-3d-row">
        <button type="button" tabIndex={tab} onClick={() => chart3d.onRotate(Math.PI / 4)} title={t('dashboard.rotateLeft')} aria-label={t('dashboard.rotateLeft')}><IconRotateLeft /></button>
        <button type="button" tabIndex={tab} onClick={() => chart3d.onRotate(-Math.PI / 4)} title={t('dashboard.rotateRight')} aria-label={t('dashboard.rotateRight')}><IconRotateRight /></button>
        <button type="button" tabIndex={tab} onClick={() => chart3d.onZoom(0.8)} title={t('dashboard.zoomIn')} aria-label={t('dashboard.zoomIn')}><IconZoomIn /></button>
        <button type="button" tabIndex={tab} onClick={() => chart3d.onZoom(1.25)} title={t('dashboard.zoomOut')} aria-label={t('dashboard.zoomOut')}><IconZoomOut /></button>
      </div>
      <div className="dash-chart-rail-3d-row dash-chart-rail-3d-row--trio">
        <button
          type="button"
          tabIndex={tab}
          className={chart3d.orbitLocked ? 'is-active' : ''}
          aria-pressed={chart3d.orbitLocked}
          onClick={chart3d.onToggleOrbitLock}
          title={chart3d.orbitLocked ? t('dashboard.orbitUnlock') : t('dashboard.orbitLock')}
          aria-label={chart3d.orbitLocked ? t('dashboard.orbitUnlock') : t('dashboard.orbitLock')}
        >
          <IconOrbitLock locked={chart3d.orbitLocked} />
        </button>
        <button
          type="button"
          tabIndex={tab}
          className={chart3d.autoRotateOn ? 'is-active' : ''}
          aria-pressed={chart3d.autoRotateOn}
          onClick={chart3d.onToggleAutoRotate}
          title={t('dashboard.autoRotateToggle')}
          aria-label={t('dashboard.autoRotateToggle')}
        >
          <IconAutoRotate />
        </button>
        <button type="button" tabIndex={tab} onClick={chart3d.onReset} title={t('dashboard.resetView')} aria-label={t('dashboard.resetView')}><IconResetView /></button>
      </div>
    </div>
  );
}

// Points "right" — the rail sits on the card's right edge, so collapsing
// tucks it away in that direction.
function IconCollapse() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

// Points "left" — used on the floating expand tab left behind once the rail
// is collapsed, so its direction reads as "bring the rail back" from the right.
export function IconExpand() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

// Same rotate/zoom/pan/click iconography that used to live in
// MetricSurface3D's always-on .ms3d-controls-card overlay. Rendered as a
// banner along the bottom edge of the chart plot itself (Dashboard.jsx mounts
// this inside .dash-chart-body, not the rail) since the hints describe how to
// interact with the plot — anchoring them there beats a popover tucked in the
// rail, which can end up far from the chart when the rail sits on the right.
export function ChartHintBanner({ chartView, open, modelCount = 0 }) {
  const { t } = useTranslation();
  if (!open) return null;

  return (
    <div className="dash-chart-hint-banner" role="status">
      <div className="dash-chart-hint-banner-row">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9 9V4.5a1.5 1.5 0 0 1 3 0V9" />
          <path d="M12 9V3.5a1.5 1.5 0 0 1 3 0V9" />
          <path d="M15 9.5V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-2c-2.5 0-3.5-1-5-3l-2.7-4a1.4 1.4 0 0 1 2-2L6 12" />
        </svg>
        {t('dashboard.legendClickHint')}
      </div>
      {modelCount > 4 && (
        <div className="dash-chart-hint-banner-row">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v4l3 2" />
          </svg>
          {t('dashboard.legendIsolateHint')}
        </div>
      )}
      {chartView === '3d' && (
        <>
          <div className="dash-chart-hint-banner-row">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2 2 7l10 5 10-5-10-5Z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
            </svg>
            {t('dashboard.controlViews')}
          </div>
          <div className="dash-chart-hint-banner-row">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="9" cy="7" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="9" cy="17" r="1" />
              <circle cx="15" cy="7" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="15" cy="17" r="1" />
            </svg>
            {t('dashboard.controlRotate')}
          </div>
          <div className="dash-chart-hint-banner-row">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              <line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" />
            </svg>
            {t('dashboard.controlZoom')}
          </div>
          <div className="dash-chart-hint-banner-row">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="5 9 2 12 5 15" /><polyline points="9 5 12 2 15 5" />
              <polyline points="15 19 12 22 9 19" /><polyline points="19 9 22 12 19 15" />
              <line x1="2" y1="12" x2="22" y2="12" /><line x1="12" y1="2" x2="12" y2="22" />
            </svg>
            {t('dashboard.controlPan')}
          </div>
          <div className="dash-chart-hint-banner-row">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="9" cy="7" r="1" /><circle cx="15" cy="7" r="1" />
            </svg>
            {t('dashboard.controlClick')}
          </div>
        </>
      )}
    </div>
  );
}

function ViewToggle({ chartView, onSetChartView, className, tabIndex }) {
  const { t } = useTranslation();
  return (
    <div className={`obs-range-picker${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className={`obs-range-btn${chartView === '3d' ? ' active' : ''}`}
        title={t('dashboard.view3D')}
        tabIndex={tabIndex}
        onClick={() => onSetChartView('3d')}
      >3D</button>
      <button
        type="button"
        className={`obs-range-btn${chartView === '2d' ? ' active' : ''}`}
        title={t('dashboard.view2D')}
        tabIndex={tabIndex}
        onClick={() => onSetChartView('2d')}
      >2D</button>
    </div>
  );
}

// Unifies the four dashboard chart controls that used to be scattered across
// the page header, the chart card's own mini-header, and floating overlays
// inside MetricSurface3D's canvas: model legend, usage hint, refresh, and the
// 2D/3D toggle. Laid out as a vertical rail down the chart card's right edge so
// the chart body keeps the card's full height — a horizontal bar on top stole
// ~40px of chart height on every viewport.
//
// The rail always stays mounted (collapsing only toggles a class + CSS
// transition, it used to be an unmount) so collapse/expand animates instead of
// snapping. A second, always-mounted overlay (`.dash-chart-collapsed-controls`,
// absolutely positioned — flex items with position:absolute drop out of
// .dash-chart-card's row layout, same trick the old standalone expand tab
// used) fades in opposite the rail and carries a compact 2D/3D toggle plus the
// expand button, so switching chart view doesn't require reopening the rail.
export default function ChartToolbar({
  title, models, hiddenModels, onToggleModel, onIsolateModel,
  chartView, onSetChartView, onRefresh, syncing,
  collapsed, onToggleCollapsed,
  hintOpen, onToggleHint,
  showCompare, comparePrev, onToggleCompare, compareDelta,
  modelToProvider = {},
  chart3d = null,
}) {
  const { t } = useTranslation();
  const providerIndices = React.useMemo(
    () => modelProviderIndices(models, modelToProvider),
    [models, modelToProvider]
  );

  return (
    <>
      <div className={`dash-chart-rail${collapsed ? ' dash-chart-rail--collapsed' : ''}`} aria-hidden={collapsed}>
        <div className="dash-chart-rail-head">
          <div className="obs-section-label dash-chart-rail-title">{title}</div>
          <button
            type="button"
            className="dash-chart-collapse-btn"
            title={t('dashboard.collapseToolbar')}
            aria-label={t('dashboard.collapseToolbar')}
            tabIndex={collapsed ? -1 : 0}
            onClick={onToggleCollapsed}
          >
            <IconCollapse />
          </button>
        </div>

        <div className="dash-chart-rail-section dash-chart-rail-legend-block">
          <div className="obs-section-label dash-chart-rail-section-label">{t('dashboard.railModels')}</div>
          <div className="dash-chart-rail-legend">
            {models.map((model, mi) => (
              <button
                key={model}
                type="button"
                className="dash-chart-rail-legend-item"
                style={{ opacity: hiddenModels.has(model) ? 0.4 : 1 }}
                title={model === 'Other' ? t('dashboard.other') : model}
                tabIndex={collapsed ? -1 : 0}
                onClick={() => onToggleModel(model)}
                onDoubleClick={() => onIsolateModel?.(model)}
              >
                <span
                  className="dash-chart-rail-legend-dot"
                  style={{ background: colorForModel(providerIndices[mi].provider, providerIndices[mi].index) }}
                />
                <span className="dash-chart-rail-legend-name">
                  {model === 'Other' ? t('dashboard.other') : shortModelName(model)}
                </span>
              </button>
            ))}

            {showCompare && (
              <>
                <div className="dash-chart-rail-legend-separator" />
                <button
                  type="button"
                  className={`dash-chart-rail-legend-compare${comparePrev ? ' active' : ''}`}
                  title={t('dashboard.comparePrevToggle')}
                  tabIndex={collapsed ? -1 : 0}
                  onClick={onToggleCompare}
                >
                  <span className="dash-chart-rail-legend-compare-check">
                    {comparePrev ? '✓' : ''}
                  </span>
                  <span className="dash-chart-rail-legend-name">
                    {t('dashboard.comparePrevToggle')}
                  </span>
                  {comparePrev && typeof compareDelta === 'number' && !isNaN(compareDelta) && (
                    <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: 600, color: compareDelta > 0 ? 'var(--error)' : 'var(--success)' }}>
                      {compareDelta > 0 ? '↑' : '↓'} {Math.abs(compareDelta).toFixed(1)}%
                    </span>
                  )}
                </button>

                {/* Placeholder for an actual forecast line (distinct from
                    "vs. previous period", which overlays real historical data)
                    — disabled and badged until that's built, so it doesn't
                    read as a working toggle that silently does nothing. */}
                <button
                  type="button"
                  className="dash-chart-rail-legend-compare dash-chart-rail-legend-compare--disabled"
                  title={t('dashboard.projectionComingSoon')}
                  disabled
                  tabIndex={-1}
                >
                  <span className="dash-chart-rail-legend-compare-check" />
                  <span className="dash-chart-rail-legend-name">{t('dashboard.projectionToggle')}</span>
                  <span className="dash-chart-rail-legend-soon-badge">{t('dashboard.comingSoon')}</span>
                </button>
              </>
            )}
          </div>
        </div>

        {chart3d && <Chart3DControls chart3d={chart3d} collapsed={collapsed} t={t} />}

        <div className="dash-chart-rail-section dash-chart-rail-foot">
          <div className="obs-section-label dash-chart-rail-section-label">{t('dashboard.railView')}</div>
          <ViewToggle
            chartView={chartView}
            onSetChartView={onSetChartView}
            className="dash-chart-rail-views"
            tabIndex={collapsed ? -1 : 0}
          />

          <div className="dash-chart-rail-actions">
            <button className="obs-btn dash-chart-rail-refresh" tabIndex={collapsed ? -1 : 0} onClick={onRefresh} disabled={syncing}>
              <IconRefresh spinning={syncing} />
              {t('dashboard.refresh')}
            </button>
            <button
              type="button"
              className={`dash-chart-rail-hint-btn${hintOpen ? ' is-active' : ''}`}
              title={t('dashboard.chartHelp')}
              aria-label={t('dashboard.chartHelp')}
              aria-pressed={hintOpen}
              tabIndex={collapsed ? -1 : 0}
              onClick={onToggleHint}
            >
              {hintOpen ? <IconClose /> : <IconHelp />}
            </button>
          </div>
        </div>
      </div>

      <div className={`dash-chart-collapsed-controls${collapsed ? ' is-visible' : ''}`}>
        <ViewToggle
          chartView={chartView}
          onSetChartView={onSetChartView}
          className="dash-chart-collapsed-views"
          tabIndex={collapsed ? 0 : -1}
        />
        <button
          type="button"
          className="dash-chart-expand-tab"
          title={t('dashboard.expandToolbar')}
          aria-label={t('dashboard.expandToolbar')}
          tabIndex={collapsed ? 0 : -1}
          onClick={onToggleCollapsed}
        >
          <IconExpand />
        </button>
      </div>
    </>
  );
}
