import React, { useMemo, useRef, useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Html, Grid, ContactShadows } from '@react-three/drei';
import { useTranslation } from 'react-i18next';
import { readChartPalette, colorForModel } from '../utils/chartColors';
import { modelProviderIndices } from '../utils/providerColors';
import { buildGrid, formatMetricValue } from '../utils/metricGrid';
import * as THREE from 'three';

const BAR_SIZE = 0.62;
const SPACING  = 0.9;
const MAX_HEIGHT = 3.6;
// A day with real (if comparatively tiny) activity would otherwise scale to a
// near-zero height next to a much larger max in the same grid — e.g. a demo
// dataset that ramps up over 30 days makes early days ~1.5% of the tallest
// bar, which rounds to a sliver indistinguishable from the true-zero ghost
// cells. Flooring nonzero bars to a small but visible height keeps "small
// but real" and "no data" readable apart; color saturation (still driven by
// the true ratio) is what still communicates relative magnitude.
const MIN_VISIBLE_HEIGHT = MAX_HEIGHT * 0.035;
const DAMP_LAMBDA = 6;
// Above this many days of span (roughly the 30d/90d ranges), thin the bars
// and flatten the camera angle so front-row bars stop occluding back rows —
// see Scene's isDense derivation (spanDays, not raw bucket count, since 24h
// uses hourly buckets while 30d/90d use daily buckets).
const DENSE_THRESHOLD = 14;
const MAX_AXIS_LABELS = 7;
// Axis label font size was a fixed 0.32 world units — fine at 7d (gridSpan
// ~7), but the same absolute size reads as illegibly tiny once the camera
// pulls back for 30d/90d (gridSpan up to ~80+), since the labels shrink
// relative to everything else in the scene without this. BASE_LABEL_GRID_SPAN
// is the gridSpan where 0.32 was tuned to look right (roughly the default 7d
// view) — scaling by sqrt keeps the growth sub-linear so 90d labels stay
// legible without ballooning past the bars.
const BASE_LABEL_FONT_SIZE = 0.32;
const BASE_LABEL_GRID_SPAN = 7.2;
// OrbitControls' old minDistance (cameraDistance * 0.4) grows right along
// with cameraDistance, so at 90d the closest zoom still left the camera ~47
// units away — too far to read individual bars. Capping it at a small,
// scene-size-independent constant means you can always zoom in tight on a
// handful of bars no matter how many buckets are in view.
const MIN_CAMERA_DISTANCE = 8;
// The default camera distance grows with gridSpan, which is right for a
// short range but wrong for a long one: those pack many more (already-
// thinned, see isDense) bars into view, so pulling the default framing
// *closer* — not farther — is what keeps individual bars legible and
// clickable, and the longer the range the closer still it needs to start.
// This used to be a lookup table keyed by the preset range string ('24h'/
// '7d'/'30d'/'90d'), but the custom date-range picker can produce any span at
// all, not just those four — so both are now a continuous function of the
// actual span (days) covered by the grid (see spanDays below), log-
// interpolated between two tuned anchors (what used to be the '30d' and '90d'
// table entries) and clamped past them so an arbitrarily long custom range
// still gets a sane camera instead of silently reusing the "not dense"
// default a missing table key would fall back to.
const DENSITY_ANCHOR_LOW  = { days: 30, zoom: 0.6,  minDist: 5.5 };
const DENSITY_ANCHOR_HIGH = { days: 90, zoom: 0.36, minDist: 3.5 };

function densityFraming(spanDays) {
  if (spanDays <= DENSE_THRESHOLD) return { zoom: 1, minDist: MIN_CAMERA_DISTANCE };
  const clampedDays = Math.min(Math.max(spanDays, DENSITY_ANCHOR_LOW.days), 365);
  const t = (Math.log(clampedDays) - Math.log(DENSITY_ANCHOR_LOW.days)) /
            (Math.log(DENSITY_ANCHOR_HIGH.days) - Math.log(DENSITY_ANCHOR_LOW.days));
  const lerp = (a, b) => a + (b - a) * t;
  return {
    zoom:    Math.max(0.2, lerp(DENSITY_ANCHOR_LOW.zoom, DENSITY_ANCHOR_HIGH.zoom)),
    minDist: Math.max(2.5, lerp(DENSITY_ANCHOR_LOW.minDist, DENSITY_ANCHOR_HIGH.minDist)),
  };
}
// cameraDistance/cameraYRatio are tuned against the desktop chart box, which
// is wide and short (rail beside the plot). On mobile the box goes nearly
// square (rail moves above the plot, height fixed at 340px) — with a fixed
// vertical FOV, a narrower aspect ratio means a narrower horizontal FOV too,
// so the same distance shows visibly less width and the scene reads as a
// different size/zoom level between breakpoints. REFERENCE_ASPECT approximates
// the desktop box's width/height ratio the constants above were tuned for;
// below it we pull the camera back proportionally so the visible width stays
// roughly consistent. Capped so extremely narrow phones don't zoom out so far
// the bars become illegibly small.
const REFERENCE_ASPECT = 2.2;
const MAX_ASPECT_COMPENSATION = 1.6;
// Idle time before the camera resumes auto-rotating after a drag/zoom/pan,
// a bar hover, or a pinned tooltip — long enough to read a tooltip without
// the scene drifting under it.
const AUTO_ROTATE_IDLE_MS = 3000;
const AUTO_ROTATE_SPEED = 0.55;
// Diagonal "wave" stagger for the entrance animation: each bar's grow-in is
// delayed proportionally to its (hour, model) grid position, so the surface
// fills in sweeping from the front-left corner instead of popping in at once.
const REVEAL_STEP_MS = 14;
const HOVER_LIFT = 0.22;
const DIMMED_OPACITY = 0.32;
// Cells with no data (zero-fill buckets) render as a faint ghost box instead
// of a solid bar, so the eye reads "no activity" at a glance rather than
// mistaking them for a real (if small) value.
const EMPTY_OPACITY = 0.22;

// Axis labels used to be drei's <Text>/<Billboard>, which render glyphs via
// troika-three-text — that needs the ANGLE_instanced_arrays extension to
// generate its SDF font atlas, and on browsers/GPUs without it (software
// rendering, hardware acceleration disabled, some driver combos) troika threw
// an unhandled promise rejection that broke the WebGL context and left the
// canvas blank with no visible error. Labels are now plain canvas-texture
// sprites (see CanvasTextSprite below) instead, which only need a working
// WebGL context — no special extension — so this probe just checks that
// *any* WebGL context can be created at all, the genuine floor below which
// nothing in the scene (not just labels) can render. Cached at module scope
// since the probe is cheap but there's no reason to repeat it on every mount.
let webglSupported = null;
function checkWebGLSupport() {
  if (webglSupported !== null) return webglSupported;
  try {
    const canvas = document.createElement('canvas');
    webglSupported = !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    webglSupported = false;
  }
  return webglSupported;
}

// Defense in depth for the same failure mode: if the capability probe passes
// but the Canvas subtree still throws for some other reason, degrade to the
// fallback UI instead of leaving a half-crashed blank canvas on screen.
class Canvas3DErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

function Unsupported3DFallback({ onSwitchTo2D, t }) {
  return (
    <div className="ms3d-fallback">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 2 2 7l10 5 10-5-10-5Z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </svg>
      <p>{t('dashboard.chart3dUnsupported')}</p>
      {onSwitchTo2D && (
        <button type="button" className="obs-btn obs-btn-primary" onClick={onSwitchTo2D}>
          {t('dashboard.chart3dSwitchTo2D')}
        </button>
      )}
    </div>
  );
}

function Bar({ targetHeight, size, color, position, isActiveCell, dimmed, hasValue, revealDelay, revealStart, onHover, onUnhover, onClick }) {
  const meshRef = useRef();
  const materialRef = useRef();
  const currentHeight = useRef(0.01);
  const currentLift = useRef(0);

  // A fresh revealStart timestamp means the grid's shape just changed (range
  // or metric switch) — snap back to zero so the stagger reveal is visible
  // again instead of just re-damping from whatever height it already had.
  useEffect(() => {
    currentHeight.current = 0.01;
  }, [revealStart]);

  useFrame((_, delta) => {
    const revealed = performance.now() - revealStart >= revealDelay;
    const targetH = revealed ? Math.max(targetHeight, 0.01) : 0.01;
    currentHeight.current = THREE.MathUtils.damp(currentHeight.current, targetH, DAMP_LAMBDA, delta);
    currentLift.current = THREE.MathUtils.damp(currentLift.current, isActiveCell ? HOVER_LIFT : 0, DAMP_LAMBDA, delta);
    if (meshRef.current) {
      meshRef.current.scale.y = currentHeight.current;
      meshRef.current.position.y = currentHeight.current / 2 + currentLift.current;
    }
    if (materialRef.current) {
      const targetOpacity = isActiveCell ? 1 : dimmed ? DIMMED_OPACITY : (hasValue ? 1 : EMPTY_OPACITY);
      materialRef.current.opacity = THREE.MathUtils.damp(materialRef.current.opacity, targetOpacity, DAMP_LAMBDA, delta);
      materialRef.current.emissiveIntensity = THREE.MathUtils.damp(materialRef.current.emissiveIntensity, isActiveCell ? 0.6 : 0, DAMP_LAMBDA, delta);
    }
  });

  return (
    <mesh
      ref={meshRef}
      position={[position[0], 0, position[2]]}
      onPointerOver={(e) => { e.stopPropagation(); onHover(); }}
      onPointerOut={(e) => { e.stopPropagation(); onUnhover(); }}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >
      <boxGeometry args={[size, 1, size]} />
      <meshStandardMaterial
        ref={materialRef}
        color={color}
        emissive={color}
        emissiveIntensity={0}
        roughness={0.32}
        metalness={0.15}
        transparent
        opacity={1}
      />
    </mesh>
  );
}

// Floor ring under the active (hovered or pinned) bar — a lightweight focus
// indicator that pulses gently so it reads clearly against the grid even
// when the camera is auto-rotating.
function FocusRing({ x, z, color }) {
  const ref = useRef();
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const pulse = 1 + Math.sin(clock.elapsedTime * 3) * 0.08;
    ref.current.scale.set(pulse, pulse, 1);
  });
  return (
    <mesh ref={ref} position={[x, 0.02, z]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0.4, 0.5, 32]} />
      <meshBasicMaterial color={color} transparent opacity={0.7} depthWrite={false} />
    </mesh>
  );
}

// Renders text as a camera-facing sprite backed by a plain 2D canvas texture,
// replacing drei's <Text>/<Billboard> (troika-three-text) — see
// checkWebGLSupport above for why: troika's SDF glyph generation needs
// ANGLE_instanced_arrays, which isn't universally available, while a canvas
// texture only needs a working WebGL context to display, same as everything
// else in this scene. THREE.Sprite is camera-facing by default, so this also
// replaces <Billboard> — no separate wrapper needed. Canvas is rebuilt only
// when text/color/fontSize actually change (useMemo), not every frame.
const LABEL_CANVAS_SCALE = 72; // px per world unit of fontSize — tuned for crisp text at typical camera distances
function CanvasTextSprite({ text, color, fontSize, position }) {
  const { texture, aspect } = useMemo(() => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const pxSize = fontSize * LABEL_CANVAS_SCALE;
    const padding = pxSize * 0.25;
    ctx.font = `600 ${pxSize}px Inter, sans-serif`;
    const textWidth = ctx.measureText(text).width;
    canvas.width = Math.max(1, Math.ceil(textWidth + padding * 2));
    canvas.height = Math.ceil(pxSize + padding * 2);
    // Resizing the canvas resets its 2D context state, so font/fill have to
    // be re-applied after setting width/height above.
    ctx.font = `600 ${pxSize}px Inter, sans-serif`;
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return { texture: tex, aspect: canvas.width / canvas.height };
  }, [text, color, fontSize]);

  useEffect(() => () => texture.dispose(), [texture]);

  const height = fontSize * 1.3;
  const width = height * aspect;

  return (
    <sprite position={position} scale={[width, height, 1]}>
      <spriteMaterial map={texture} transparent depthWrite={false} />
    </sprite>
  );
}

// Picks up to MAX_AXIS_LABELS bucket indices to label on the floor: always
// the first and last bucket, plus evenly-spaced steps between — avoids
// rendering one label per bucket (unreadable clutter at 30d/90d).
function pickLabelIndices(count) {
  if (count <= 1) return [0].slice(0, count);
  const step = Math.max(1, Math.ceil(count / (MAX_AXIS_LABELS - 1)));
  const indices = new Set();
  for (let i = 0; i < count; i += step) indices.add(i);
  indices.add(count - 1);
  return [...indices].sort((a, b) => a - b);
}

// xLabels is indexed by the same position as the untrimmed bucket list —
// safe because both come from queries sharing the exact same
// tsSeriesStart/tsSeriesEnd/bucketUnit zero-fill (metrics.js summary route),
// so they always produce the same bucket count in the same order. Since
// buildGrid trims leading/trailing empty buckets, every grid.hours index hi
// must be offset by grid.labelOffset to land back on the right xLabels entry.
// `?? ''` below is just a guard, not the real defense.
function Scene({ grid, metric, xLabels, palette, gridSpan, cameraDistance, cameraYRatio, minCameraDistance, barSize, labelFontSize, controlsRef, frameRef, navGoalRef, orbitLocked, autoRotateOn, hovered, pinned, onHoverChange, onUnhoverChange, onPinToggle, hiddenModels, providerIndices }) {
  const { hours, models, values, rawValues, columnTotals, max, labelOffset } = grid;
  const [autoRotate, setAutoRotate] = useState(false);
  const autoRotateOnRef = useRef(autoRotateOn);
  const idleTimerRef = useRef(null);

  // Auto-rotation is opt-in now (a toggle in the on-canvas nav cluster) — a
  // scene that quietly starts drifting under the cursor was the single most
  // disorienting part of the old free-orbit-only navigation. When the user
  // turns it on we mirror that into local state; when off we also cancel any
  // pending idle-resume timer so it can't sneak back.
  useEffect(() => {
    autoRotateOnRef.current = autoRotateOn;
    if (autoRotateOn) {
      setAutoRotate(true);
    } else {
      setAutoRotate(false);
      clearTimeout(idleTimerRef.current);
    }
  }, [autoRotateOn]);
  const { size, camera } = useThree();
  const aspect = size.width / Math.max(size.height, 1);
  const aspectScale = aspect > 0 && aspect < REFERENCE_ASPECT
    ? Math.min(REFERENCE_ASPECT / aspect, MAX_ASPECT_COMPENSATION)
    : 1;
  const effectiveCameraDistance = cameraDistance * aspectScale;

  // Reframe whenever the aspect-compensated distance changes — container
  // resize (breakpoint switch, sidebar collapse) or a range/zoom change.
  // Doesn't fire on the user's own drag/zoom since those don't touch these
  // deps, so it won't fight manual navigation.
  useEffect(() => {
    camera.position.set(effectiveCameraDistance * 0.7, effectiveCameraDistance * cameraYRatio, effectiveCameraDistance * 0.7);
    camera.updateProjectionMatrix();
    if (frameRef) frameRef.current = { distance: effectiveCameraDistance, yRatio: cameraYRatio };
    controlsRef.current?.update();
  }, [effectiveCameraDistance, cameraYRatio, camera, controlsRef, frameRef]);

  // Dollies the camera in toward a pinned bar so it reads as "brought to the
  // foreground" instead of just growing a tooltip in place. This only runs
  // for a short settle window right after pin/unpin (dollyUntilRef), not on
  // every frame — otherwise it would fight the user's own OrbitControls drag
  // once they start orbiting the now-focused bar (or the scene generally,
  // after unpinning). Distance shrinks to roughly a third of the default
  // framing, floored at minCameraDistance so dense (30d/90d) ranges don't
  // overshoot into the bar.
  const DOLLY_SETTLE_MS = 700;
  const dollyUntilRef = useRef(0);
  const dollyGoalRef = useRef({ position: new THREE.Vector3(), target: new THREE.Vector3() });
  const prevPinnedKeyRef = useRef(null);
  const pinnedKey = pinned?.key ?? null;
  if (pinnedKey !== prevPinnedKeyRef.current) {
    prevPinnedKeyRef.current = pinnedKey;
    dollyUntilRef.current = performance.now() + DOLLY_SETTLE_MS;
    if (pinned) {
      const focusDistance = Math.max(effectiveCameraDistance / 3, minCameraDistance);
      const dir = new THREE.Vector3(0.7, cameraYRatio, 0.7).normalize();
      dollyGoalRef.current.target.set(pinned.x, pinned.height / 2, pinned.z);
      dollyGoalRef.current.position.copy(dollyGoalRef.current.target).addScaledVector(dir, focusDistance);
    } else {
      dollyGoalRef.current.target.set(0, MAX_HEIGHT / 3, 0);
      dollyGoalRef.current.position.set(effectiveCameraDistance * 0.7, effectiveCameraDistance * cameraYRatio, effectiveCameraDistance * 0.7);
    }
  }
  useFrame((_, delta) => {
    if (performance.now() > dollyUntilRef.current) return;
    const controls = controlsRef.current;
    if (!controls) return;
    const { position: wantPosition, target: wantTarget } = dollyGoalRef.current;
    camera.position.set(
      THREE.MathUtils.damp(camera.position.x, wantPosition.x, DAMP_LAMBDA, delta),
      THREE.MathUtils.damp(camera.position.y, wantPosition.y, DAMP_LAMBDA, delta),
      THREE.MathUtils.damp(camera.position.z, wantPosition.z, DAMP_LAMBDA, delta),
    );
    controls.target.set(
      THREE.MathUtils.damp(controls.target.x, wantTarget.x, DAMP_LAMBDA, delta),
      THREE.MathUtils.damp(controls.target.y, wantTarget.y, DAMP_LAMBDA, delta),
      THREE.MathUtils.damp(controls.target.z, wantTarget.z, DAMP_LAMBDA, delta),
    );
    controls.update();
  });

  // Smoothly flies the camera to a goal set by the on-canvas nav cluster
  // (preset viewpoints, step zoom, 45° rotate). Same damp-for-a-settle-window
  // pattern as the pin dolly above: it only runs while performance.now() is
  // before goal.until, then clears itself so it never fights a subsequent
  // manual orbit/pan.
  useFrame((_, delta) => {
    const goal = navGoalRef?.current;
    if (!goal) return;
    const controls = controlsRef.current;
    if (!controls) return;
    if (performance.now() > goal.until) { navGoalRef.current = null; return; }
    camera.position.set(
      THREE.MathUtils.damp(camera.position.x, goal.position.x, DAMP_LAMBDA, delta),
      THREE.MathUtils.damp(camera.position.y, goal.position.y, DAMP_LAMBDA, delta),
      THREE.MathUtils.damp(camera.position.z, goal.position.z, DAMP_LAMBDA, delta),
    );
    controls.target.set(
      THREE.MathUtils.damp(controls.target.x, goal.target.x, DAMP_LAMBDA, delta),
      THREE.MathUtils.damp(controls.target.y, goal.target.y, DAMP_LAMBDA, delta),
      THREE.MathUtils.damp(controls.target.z, goal.target.z, DAMP_LAMBDA, delta),
    );
    controls.update();
  });

  const pauseAutoRotate = () => {
    clearTimeout(idleTimerRef.current);
    setAutoRotate(false);
  };
  const scheduleAutoRotate = () => {
    clearTimeout(idleTimerRef.current);
    if (!autoRotateOnRef.current) return;
    idleTimerRef.current = setTimeout(() => {
      if (autoRotateOnRef.current) setAutoRotate(true);
    }, AUTO_ROTATE_IDLE_MS);
  };

  useEffect(() => {
    scheduleAutoRotate();
    return () => clearTimeout(idleTimerRef.current);
  }, []);

  // Keep rotation paused for as long as a tooltip is pinned open, regardless
  // of whether OrbitControls itself fired a start/end (a plain click may not).
  useEffect(() => {
    if (pinned) pauseAutoRotate(); else scheduleAutoRotate();
  }, [pinned]);

  // structureKey changes only when the set of buckets/models changes (range
  // or filter switch) — NOT on every value update from a live socket refetch,
  // which would otherwise replay the grow-in animation on every new metric.
  const structureKey = `${hours.join(',')}|${models.join(',')}`;
  const revealStartRef = useRef(performance.now());
  const prevStructureKeyRef = useRef(structureKey);
  if (structureKey !== prevStructureKeyRef.current) {
    prevStructureKeyRef.current = structureKey;
    revealStartRef.current = performance.now();
  }

  const offsetX = -((hours.length - 1) * SPACING) / 2;
  const offsetZ = -((models.length - 1) * SPACING) / 2;
  // Labels sit one step beyond the last model row, on the +Z side — that's
  // the edge nearest the default camera corner (see cameraYRatio/position in
  // MetricSurface3D), so they read in the foreground instead of being
  // occluded by the bar field.
  const labelZ = offsetZ + models.length * SPACING;
  const labelIndices = pickLabelIndices(hours.length);

  // Hover always previews on top of a pin (the mouse is literally over it);
  // otherwise fall back to whatever's pinned.
  const active = hovered || pinned;

  return (
    <>
      {/* No flat scene background here on purpose — Canvas is transparent
          (gl alpha) so the CSS gradient on .ms3d-wrap shows through instead
          of a plain fill. Fog fades the grid/bars toward that same surface
          tone at distance, blending the geometry into the gradient instead
          of cutting off at a hard edge. */}
      <fog attach="fog" args={[palette.surface, effectiveCameraDistance * 0.9, effectiveCameraDistance * 2.3]} />
      <hemisphereLight args={[palette.text, palette.surface, 0.3]} />
      <ambientLight intensity={0.4} />
      <directionalLight position={[6, 10, 6]} intensity={0.75} />
      <directionalLight position={[-7, 5, -6]} intensity={0.3} color={palette.accent} />
      <Grid
        args={[gridSpan + 2, gridSpan + 2]}
        position={[0, 0, 0]}
        cellColor={palette.gridLine}
        sectionColor={palette.gridLine}
        fadeDistance={effectiveCameraDistance * 2}
        infiniteGrid={false}
      />
      <ContactShadows
        position={[0, 0.01, 0]}
        scale={gridSpan + 6}
        blur={2.4}
        far={MAX_HEIGHT}
        opacity={0.4}
        color={palette.shadow}
      />
      {models.map((model, mi) => (
        hiddenModels.has(model) ? null : values[mi].map((value, hi) => {
          const ratio = value / max;
          const height = value > 0 ? Math.max(ratio * MAX_HEIGHT, MIN_VISIBLE_HEIGHT) : ratio * MAX_HEIGHT;
          const x = offsetX + hi * SPACING;
          const z = offsetZ + mi * SPACING;
          const key = `${mi}-${hi}`;
          const hasValue = value > 0;
          // Taller/higher-value bars stay fully saturated; low-value bars fade
          // toward the scene surface color, so magnitude reads through color
          // as well as height. Zero-value cells fade much further — they're a
          // placeholder marker, not a real (if small) data point.
          const { provider, index } = providerIndices[mi];
          const barColor = new THREE.Color(colorForModel(provider, index, { forThreeJs: true }))
            .lerp(new THREE.Color(palette.surface), hasValue ? (1 - ratio) * 0.45 : 0.78);
          const cellInfo = { key, model, provider, hour: xLabels[labelOffset + hi] ?? '', value, x, z, height, color: barColor, raw: rawValues[mi][hi], bucketTotal: columnTotals?.[hi], metric };
          const isActiveCell = !!active && active.key === key;
          const isActiveRow = !!active && active.model === model;
          return (
            <Bar
              key={key}
              targetHeight={height}
              size={barSize}
              color={barColor}
              position={[x, 0, z]}
              isActiveCell={isActiveCell}
              dimmed={!!active && !isActiveRow}
              hasValue={hasValue}
              revealDelay={(hi + mi) * REVEAL_STEP_MS}
              revealStart={revealStartRef.current}
              onHover={() => { onHoverChange(cellInfo); pauseAutoRotate(); }}
              onUnhover={() => { onUnhoverChange(key); scheduleAutoRotate(); }}
              onClick={() => onPinToggle(cellInfo)}
            />
          );
        })
      ))}
      {labelIndices.map(hi => (
        <CanvasTextSprite
          key={hi}
          text={xLabels[labelOffset + hi] ?? ''}
          color={palette.text}
          fontSize={labelFontSize}
          position={[offsetX + hi * SPACING, 0.05, labelZ]}
        />
      ))}
      {active && <FocusRing x={active.x} z={active.z} color={active.color} />}
      {active && (
        // Anchored to this bar's own height (not a fixed MAX_HEIGHT) — a
        // fixed anchor left the tooltip floating far above short bars,
        // reading as detached/misplaced instead of pointing at the bar.
        <Html position={[active.x, active.height + 0.55, active.z]} center style={{ pointerEvents: 'none' }}>
          <div className={`ms3d-tooltip${pinned && pinned.key === active.key ? ' ms3d-tooltip--pinned' : ''}`}>
            <div className="ms3d-tooltip-model">{active.model}</div>
            <div className="ms3d-tooltip-bucket">{active.hour}</div>
            <div className="ms3d-tooltip-value">{formatMetricValue(active.value, metric)}</div>
          </div>
        </Html>
      )}
      <OrbitControls
        ref={controlsRef}
        enablePan
        enableRotate={!orbitLocked}
        autoRotate={autoRotate}
        autoRotateSpeed={AUTO_ROTATE_SPEED}
        onStart={pauseAutoRotate}
        onEnd={scheduleAutoRotate}
        minDistance={Math.min(effectiveCameraDistance * 0.4, minCameraDistance)}
        maxDistance={effectiveCameraDistance * 1.8}
        maxPolarAngle={Math.PI / 2.1}
        target={[0, MAX_HEIGHT / 3, 0]}
        makeDefault
      />
    </>
  );
}

// Three.js needs literal RGB baked into the scene, but the theme toggle just
// flips a CSS class on the app root (App.jsx: .theme-dark/.theme-light) —
// nothing re-renders this component on its own, so without watching for that
// class change the canvas keeps whichever palette it happened to mount with.
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

// Camera controls (preset viewpoints, step zoom/rotate, orbit-lock,
// auto-rotate, reset) used to render as an on-canvas overlay here. They now
// live in the shared ChartToolbar rail alongside the model legend and the
// 2D/3D switch, so every dashboard-chart control sits in one panel. Dashboard
// owns `orbitLocked`/`autoRotateOn` (passed back down as props) and drives the
// imperative camera actions through the ref exposed by useImperativeHandle
// below.
function MetricSurface3D({
  modelTimeSeries, metric, xLabels, loading,
  hiddenModels = new Set(), onSwitchTo2D, modelToProvider = {}, otherModels = [],
  orbitLocked = false, autoRotateOn = false,
}, ref) {
  const { t } = useTranslation();
  const palette = useThemePalette();
  const webglOk = useMemo(() => checkWebGLSupport(), []);
  const controlsRef = useRef();
  // Populated by Scene with the live aspect-compensated framing (see
  // REFERENCE_ASPECT above) — resetView reads it instead of the raw
  // pre-aspect cameraDistance so the reset button reframes to what's actually
  // on screen, not the desktop-tuned default.
  const frameRef = useRef({ distance: 0, yRatio: 0.55 });
  const grid = useMemo(() => buildGrid(modelTimeSeries || [], metric), [modelTimeSeries, metric]);
  const providerIndices = useMemo(() => modelProviderIndices(grid.models, modelToProvider), [grid.models, modelToProvider]);
  const [hovered, setHovered] = useState(null);
  const [pinned, setPinned] = useState(null);
  // Staged by the camera-control handlers (exposed via ref), consumed by
  // Scene's fly-to useFrame.
  const navGoalRef = useRef(null);

  // The pinned/hovered cell references a specific grid coordinate (`mi-hi`) and
  // caches that cell's values at pin time. When the grid's shape changes — a
  // date-range switch, a metric switch, buildGrid re-trimming empty buckets —
  // that key now points at a different cell (or none), so the summary card and
  // its focus ring were left highlighting a bar that no longer represents what
  // the card shows. Drop both whenever the bucket/model structure changes. This
  // key intentionally ignores value-only updates (live socket refetches keep
  // the same buckets/models) so a pinned card survives a real-time refresh.
  const structureKey = `${grid.hours.join(',')}|${grid.models.join(',')}`;
  useEffect(() => {
    setPinned(null);
    setHovered(null);
  }, [structureKey]);

  const handlePinToggle = (cellInfo) => {
    setPinned(prev => (prev && prev.key === cellInfo.key ? null : cellInfo));
  };

  const totalActivity = grid.values.reduce((sum, row) => sum + row.reduce((a, b) => a + b, 0), 0);
  // >= 1, not > 1: buildGrid now trims leading/trailing empty buckets, so a
  // range with a single real day of activity legitimately collapses to one
  // column — that's still real data worth showing, not "not enough data".
  const hasEnoughData = grid.hours.length >= 1 && totalActivity > 0;

  // ── Camera framing constants + imperative controls ──
  // Computed before the early returns (and the useImperativeHandle below) so
  // the ref the ChartToolbar rail calls into is always populated, even on the
  // loading / unsupported / no-data renders. Only `grid` feeds these, valid
  // at this point.
  const gridSpan = Math.max(grid.hours.length, grid.models.length, 1) * SPACING;
  // Density must key off the actual time span (days), not raw bucket count:
  // 24h uses hourly buckets (25 buckets for ~1 day) while a multi-week range
  // uses daily buckets (one bucket per day) — comparing bucket counts
  // directly against DENSE_THRESHOLD misclassified 24h (25 buckets) as
  // dense, shrinking bars and flattening the camera even with a single real
  // data point. Computed first since zoomFactor/minCameraDistance below now
  // derive from it too (see densityFraming).
  const spanDays = grid.hours.length > 1
    ? (new Date(grid.hours[grid.hours.length - 1]) - new Date(grid.hours[0])) / 86_400_000
    : 0;
  const { zoom: zoomFactor, minDist: minCameraDistance } = densityFraming(spanDays);
  const cameraDistance = (gridSpan * 1.4 + 5) * zoomFactor;
  const isDense = spanDays > DENSE_THRESHOLD;
  const barSize = isDense ? BAR_SIZE * 0.6 : BAR_SIZE;
  const cameraYRatio = isDense ? 0.85 : 0.55;
  const labelFontSize = Math.max(
    BASE_LABEL_FONT_SIZE,
    BASE_LABEL_FONT_SIZE * Math.sqrt(gridSpan / BASE_LABEL_GRID_SPAN)
  );

  // Read Scene's aspect-compensated framing when it's available, else the raw
  // desktop-tuned defaults above.
  const framing = () => (frameRef.current.distance ? frameRef.current : { distance: cameraDistance, yRatio: cameraYRatio });

  // Don't rely on OrbitControls' own reset() — it restores whatever
  // position/target existed when the controls were constructed, which is only
  // this range's default framing if the user hasn't switched ranges since
  // mount (the Canvas persists across range switches, it doesn't remount).
  // Recomputing from the current framing always reframes correctly for
  // whatever range is showing right now.
  const resetView = () => {
    setPinned(null);
    const controls = controlsRef.current;
    if (!controls) return;
    const { distance, yRatio } = framing();
    controls.object.position.set(distance * 0.7, distance * yRatio, distance * 0.7);
    controls.target.set(0, MAX_HEIGHT / 3, 0);
    controls.update();
  };

  // The fly-to / nudge handlers just stage a goal in navGoalRef and let
  // Scene's fly-to useFrame damp the camera there over a short settle window —
  // no snapping, and it yields to a manual orbit/pan the moment the user
  // starts one.
  const flyToView = (kind) => {
    setPinned(null);
    const { distance: d, yRatio } = framing();
    const target = new THREE.Vector3(0, MAX_HEIGHT / 3, 0);
    let position;
    switch (kind) {
      case 'front': position = new THREE.Vector3(0, d * 0.32, d * 0.98); break;
      case 'top':   position = new THREE.Vector3(0.001, d * 1.45, 0.001); break;
      case 'side':  position = new THREE.Vector3(d * 0.98, d * 0.32, 0); break;
      default:      position = new THREE.Vector3(d * 0.7, d * yRatio, d * 0.7); break; // iso / 3-quarter
    }
    navGoalRef.current = { position, target, until: performance.now() + 700 };
  };

  const nudgeZoom = (factor) => {
    const c = controlsRef.current;
    if (!c) return;
    const target = c.target.clone();
    const offset = c.object.position.clone().sub(target);
    const maxLen = framing().distance * 1.8;
    const len = THREE.MathUtils.clamp(offset.length() * factor, minCameraDistance, maxLen);
    navGoalRef.current = { position: target.clone().add(offset.setLength(len)), target, until: performance.now() + 450 };
  };

  const nudgeRotate = (radians) => {
    const c = controlsRef.current;
    if (!c) return;
    const target = c.target.clone();
    const offset = c.object.position.clone().sub(target).applyAxisAngle(new THREE.Vector3(0, 1, 0), radians);
    navGoalRef.current = { position: target.clone().add(offset), target, until: performance.now() + 550 };
  };

  useImperativeHandle(ref, () => ({ flyToView, nudgeZoom, nudgeRotate, resetView }));

  if (loading) {
    return <div className="obs-skeleton" style={{ height: '100%', borderRadius: 4 }} />;
  }

  if (!webglOk) {
    return <Unsupported3DFallback onSwitchTo2D={onSwitchTo2D} t={t} />;
  }

  if (!hasEnoughData) {
    return (
      <div style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t('dashboard.notEnoughData')}</span>
      </div>
    );
  }

  return (
    <div className="ms3d-wrap">
      <Canvas3DErrorBoundary fallback={<Unsupported3DFallback onSwitchTo2D={onSwitchTo2D} t={t} />}>
        <Canvas
          resize={{ scroll: false, debounce: 0 }}
          dpr={[1, 2]}
          gl={{ alpha: true }}
          camera={{ position: [cameraDistance * 0.7, cameraDistance * cameraYRatio, cameraDistance * 0.7], fov: 45 }}
          onPointerMissed={() => setPinned(null)}
        >
          <Scene
            grid={grid}
            metric={metric}
            xLabels={xLabels}
            palette={palette}
            gridSpan={gridSpan}
            labelFontSize={labelFontSize}
            cameraDistance={cameraDistance}
            cameraYRatio={cameraYRatio}
            minCameraDistance={minCameraDistance}
            barSize={barSize}
            controlsRef={controlsRef}
            frameRef={frameRef}
            navGoalRef={navGoalRef}
            orbitLocked={orbitLocked}
            autoRotateOn={autoRotateOn}
            hovered={hovered}
            pinned={pinned}
            onHoverChange={setHovered}
            onUnhoverChange={(key) => setHovered(prev => (prev && prev.key === key ? null : prev))}
            onPinToggle={handlePinToggle}
            hiddenModels={hiddenModels}
            providerIndices={providerIndices}
          />
        </Canvas>
      </Canvas3DErrorBoundary>

      {pinned && (
        // Docked in screen space (outside the Canvas), not floating in 3D
        // like the hover tooltip — the camera dollies the pinned bar toward
        // this corner (see Scene's dolly effect) so the card reads as the
        // foreground detail panel for whatever the camera just moved to.
        <div className="ms3d-summary-card">
          <button
            type="button"
            className="ms3d-summary-close"
            aria-label={t('dashboard.cellSummaryClose')}
            onClick={() => setPinned(null)}
          >
            ×
          </button>
          <div className="ms3d-summary-header">
            <span className="ms3d-summary-swatch" style={{ background: `#${pinned.color.getHexString()}` }} />
            <div>
              <div className="ms3d-summary-model">{pinned.model}</div>
              <div className="ms3d-summary-bucket">{pinned.hour}</div>
            </div>
          </div>
          <div className="ms3d-summary-grid">
            <div className="ms3d-summary-row">
              <span>{t('dashboard.cellSummaryRequests')}</span>
              <strong>{formatMetricValue(pinned.raw.requests, 'requests')}</strong>
            </div>
            <div className="ms3d-summary-row">
              <span>{t('dashboard.cellSummaryTokens')}</span>
              <strong>{formatMetricValue(pinned.raw.tokens, 'tokens')}</strong>
            </div>
            <div className="ms3d-summary-row">
              <span>{t('dashboard.cellSummaryCost')}</span>
              <strong>{formatMetricValue(pinned.raw.cost, 'cost')}</strong>
            </div>
            <div className="ms3d-summary-row">
              <span>{t('dashboard.cellSummaryLatency')}</span>
              <strong>{formatMetricValue(pinned.raw.latency, 'latency')}</strong>
            </div>
            <div className="ms3d-summary-row">
              <span>{t('dashboard.cellSummaryErrorRate')}</span>
              <strong>{formatMetricValue(pinned.raw.errorRate, 'errorRate')}</strong>
            </div>
            <div className="ms3d-summary-row ms3d-summary-row--sub">
              <span>{t('dashboard.cellSummaryInputTokens')}</span>
              <strong>{formatMetricValue(pinned.raw.inputTokens, 'tokens')}</strong>
            </div>
            <div className="ms3d-summary-row ms3d-summary-row--sub">
              <span>{t('dashboard.cellSummaryOutputTokens')}</span>
              <strong>{formatMetricValue(pinned.raw.outputTokens, 'tokens')}</strong>
            </div>
            {pinned.raw.cacheReadTokens > 0 && (
              <div className="ms3d-summary-row ms3d-summary-row--sub">
                <span>{t('dashboard.cellSummaryCacheRead')}</span>
                <strong>{formatMetricValue(pinned.raw.cacheReadTokens, 'tokens')}</strong>
              </div>
            )}
            {pinned.raw.cacheWriteTokens > 0 && (
              <div className="ms3d-summary-row ms3d-summary-row--sub">
                <span>{t('dashboard.cellSummaryCacheWrite')}</span>
                <strong>{formatMetricValue(pinned.raw.cacheWriteTokens, 'tokens')}</strong>
              </div>
            )}
            {['requests', 'tokens', 'cost'].includes(pinned.metric) && pinned.bucketTotal?.[pinned.metric] > 0 && (
              <div className="ms3d-summary-row ms3d-summary-row--sub">
                <span>{t('dashboard.cellSummaryBucketShare')}</span>
                <strong>{formatMetricValue(pinned.value / pinned.bucketTotal[pinned.metric], 'errorRate')}</strong>
              </div>
            )}
          </div>
          {pinned.model === 'Other' && otherModels.length > 0 && (
            <div className="ms3d-summary-other">
              <div className="ms3d-summary-other-label" title={t('dashboard.cellSummaryOtherModelsHint')}>
                {t('dashboard.cellSummaryOtherModels')}
              </div>
              <ul className="ms3d-summary-other-list">
                {otherModels.slice(0, 5).map(m => (
                  <li key={m.model}><span>{m.model}</span><em>{formatMetricValue(m.requests, 'requests')}</em></li>
                ))}
              </ul>
              {otherModels.length > 5 && (
                <div className="ms3d-summary-other-more">
                  {t('dashboard.cellSummaryOtherMore', { count: otherModels.length - 5 })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

    </div>
  );
}

export default forwardRef(MetricSurface3D);
