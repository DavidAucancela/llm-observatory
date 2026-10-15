import React, { useMemo, useRef, useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Html, Grid, ContactShadows } from '@react-three/drei';
import { useTranslation } from 'react-i18next';
import { readChartPalette, colorForModel } from '../utils/chartColors';
import { modelProviderIndices } from '../utils/providerColors';
import { buildGrid, formatMetricValue } from '../utils/metricGrid';
import { useCoarsePointer } from '../hooks/useCoarsePointer';
import * as THREE from 'three';

// On touch, one finger must scroll the page — OrbitControls' default one-finger
// rotate (plus its `touch-action: none`, overridden by .ms3d-wrap--touch in
// index.css) trapped the whole dashboard under a finger landing on the chart.
// Two fingers rotate + zoom instead; a tap still pins a bar.
const MOUSE_TOUCHES = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
const FINGER_TOUCHES = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };

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
// The Canvas renders on demand (frameloop="demand"): nothing draws while the
// scene is still, and anything animating calls invalidate() for its next
// frame. The first frame after an idle stretch reports the whole idle time as
// its delta, which would make every damp() jump straight to its target —
// clamped so animations still ease in after a pause.
const MAX_FRAME_DELTA = 1 / 30;
// A damped value this close to its target counts as settled (stops asking
// for frames).
const SETTLE_EPSILON = 1e-3;
// Above this many days of span (roughly the 30d/90d ranges), thin the bars
// so front-row bars stop occluding back rows — see the isDense derivation (spanDays, not raw bucket count, since 24h
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
// cameraDistance is tuned against the desktop chart box, which
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
// Default view: from the front, raised ~31° so the rows behind the front one
// and the bar tops read (the first cut, ~18°, looked nearly edge-on), and
// close enough that the bar field fills the frame. The old default was a
// 3/4 corner view from cameraDistance, tuned to leave room around the grid —
// it opened looking at the chart from the side and far away.
const FRONT_DIR = new THREE.Vector3(0, 0.6, 0.98).normalize();
const VIEW_TARGET = new THREE.Vector3(0, MAX_HEIGHT / 3, 0);
// Breathing room around the bar field when fitting it to the frame.
const FIT_MARGIN = 1.08;

// Distance along FRONT_DIR at which the whole bar field (all columns wide, the
// tallest bar high) fits a camera with this vertical FOV and aspect. Measured
// to the grid's center plane, plus half its depth so the front row and the
// axis labels in front of it fit too.
function frontFitDistance({ columns, rows, fov, aspect }) {
  const tanV = Math.tan(THREE.MathUtils.degToRad(fov / 2));
  const tanH = tanV * Math.max(aspect, 0.1);
  const width = Math.max(columns, 1) * SPACING;
  const depth = (Math.max(rows, 1) + 1) * SPACING;
  const byWidth = (width / 2) / tanH;
  const byHeight = (MAX_HEIGHT - VIEW_TARGET.y + 0.4) / tanV;
  return Math.max(byWidth, byHeight) * FIT_MARGIN + depth / 2;
}

function frontPosition(distance) {
  return VIEW_TARGET.clone().addScaledVector(FRONT_DIR, distance);
}
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

  useFrame((state, rawDelta) => {
    const delta = Math.min(rawDelta, MAX_FRAME_DELTA);
    const revealed = performance.now() - revealStart >= revealDelay;
    const targetH = revealed ? Math.max(targetHeight, 0.01) : 0.01;
    const targetLift = isActiveCell ? HOVER_LIFT : 0;
    const targetOpacity = isActiveCell ? 1 : dimmed ? DIMMED_OPACITY : (hasValue ? 1 : EMPTY_OPACITY);
    const targetEmissive = isActiveCell ? 0.6 : 0;
    const material = materialRef.current;
    // Settled bars skip the work and stop requesting frames — with ~500 bars
    // on a 90d range, a still chart now costs nothing instead of a full
    // render 60 times a second.
    if (revealed && Math.abs(currentHeight.current - targetH) < SETTLE_EPSILON
        && Math.abs(currentLift.current - targetLift) < SETTLE_EPSILON
        && (!material || (Math.abs(material.opacity - targetOpacity) < SETTLE_EPSILON
          && Math.abs(material.emissiveIntensity - targetEmissive) < SETTLE_EPSILON))) {
      return;
    }
    currentHeight.current = THREE.MathUtils.damp(currentHeight.current, targetH, DAMP_LAMBDA, delta);
    currentLift.current = THREE.MathUtils.damp(currentLift.current, targetLift, DAMP_LAMBDA, delta);
    if (meshRef.current) {
      meshRef.current.scale.y = currentHeight.current;
      meshRef.current.position.y = currentHeight.current / 2 + currentLift.current;
    }
    if (material) {
      material.opacity = THREE.MathUtils.damp(material.opacity, targetOpacity, DAMP_LAMBDA, delta);
      material.emissiveIntensity = THREE.MathUtils.damp(material.emissiveIntensity, targetEmissive, DAMP_LAMBDA, delta);
    }
    state.invalidate();
  });

  return (
    <mesh
      ref={meshRef}
      position={[position[0], 0, position[2]]}
      // A tap fires pointerover but never a matching pointerout, so on touch
      // the hover tooltip stuck on the last bar touched. Taps pin instead.
      onPointerOver={(e) => { e.stopPropagation(); if (e.pointerType !== 'touch') onHover(); }}
      onPointerOut={(e) => { e.stopPropagation(); if (e.pointerType !== 'touch') onUnhover(); }}
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
  useFrame(({ clock, invalidate }) => {
    if (!ref.current) return;
    const pulse = 1 + Math.sin(clock.elapsedTime * 3) * 0.08;
    ref.current.scale.set(pulse, pulse, 1);
    invalidate(); // keeps pulsing only while a bar is focused
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
function Scene({ touch, grid, metric, xLabels, palette, gridSpan, cameraDistance, minCameraDistance, barSize, labelFontSize, controlsRef, frameRef, navGoalRef, invalidateRef, orbitLocked, autoRotateOn, hovered, pinned, onHoverChange, onUnhoverChange, onPinToggle, hiddenModels, providerIndices }) {
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
  const { size, camera, invalidate } = useThree();
  // Lets the imperative nav handlers (outside the Canvas) wake the on-demand
  // loop after staging a navGoalRef.
  if (invalidateRef) invalidateRef.current = invalidate;
  // Any React-side change (hover, pin, palette, new data) needs a frame;
  // the bars then keep requesting frames until they settle.
  useEffect(() => { invalidate(); });
  const aspect = size.width / Math.max(size.height, 1);
  const aspectScale = aspect > 0 && aspect < REFERENCE_ASPECT
    ? Math.min(REFERENCE_ASPECT / aspect, MAX_ASPECT_COMPENSATION)
    : 1;
  const effectiveCameraDistance = cameraDistance * aspectScale;
  // The front view's own distance comes from the real frame (aspect, FOV), so
  // it fills the chart on a wide desktop box and on a near-square phone alike.
  // Never farther than the old framing, though: fitting all 90 daily columns
  // across a phone would pull back ~1.5x past it and shrink the bars to
  // slivers — there the front view crops the sides instead (drag to pan).
  const fitDistance = Math.max(
    Math.min(
      frontFitDistance({ columns: hours.length, rows: models.length, fov: camera.fov, aspect }),
      effectiveCameraDistance,
    ),
    Math.min(effectiveCameraDistance * 0.4, minCameraDistance),
  );
  // Fog, grid fade and max zoom-out clear the farthest framing (3/4 view).
  const viewDistance = effectiveCameraDistance;

  // Reframe to the front view whenever the framing changes — container resize
  // (breakpoint switch, sidebar collapse) or a range switch. Doesn't fire on
  // the user's own drag/zoom since those don't touch these deps, so it won't
  // fight manual navigation.
  useEffect(() => {
    camera.position.copy(frontPosition(fitDistance));
    camera.updateProjectionMatrix();
    if (frameRef) frameRef.current = { distance: effectiveCameraDistance, fitDistance };
    const controls = controlsRef.current;
    if (controls) {
      controls.target.copy(VIEW_TARGET);
      controls.update();
    }
  }, [fitDistance, effectiveCameraDistance, camera, controlsRef, frameRef]);

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
      const focusDistance = Math.max(Math.min(fitDistance * 0.6, effectiveCameraDistance / 3), minCameraDistance);
      dollyGoalRef.current.target.set(pinned.x, pinned.height / 2, pinned.z);
      dollyGoalRef.current.position.copy(dollyGoalRef.current.target).addScaledVector(FRONT_DIR, focusDistance);
    } else {
      dollyGoalRef.current.target.copy(VIEW_TARGET);
      dollyGoalRef.current.position.copy(frontPosition(fitDistance));
    }
  }
  useFrame((state, rawDelta) => {
    if (performance.now() > dollyUntilRef.current) return;
    const controls = controlsRef.current;
    if (!controls) return;
    const delta = Math.min(rawDelta, MAX_FRAME_DELTA);
    state.invalidate();
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
  useFrame((state, rawDelta) => {
    const goal = navGoalRef?.current;
    if (!goal) return;
    const controls = controlsRef.current;
    if (!controls) return;
    if (performance.now() > goal.until) { navGoalRef.current = null; return; }
    const delta = Math.min(rawDelta, MAX_FRAME_DELTA);
    state.invalidate();
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

  // OrbitControls advances autoRotate inside its own update(), which only
  // runs on rendered frames — keep frames coming while it's spinning.
  useFrame((state) => { if (autoRotate) state.invalidate(); });

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
  // the edge facing the default front camera (FRONT_DIR), so they read in the
  // foreground instead of being occluded by the bar field.
  const labelZ = offsetZ + models.length * SPACING;
  const labelIndices = pickLabelIndices(hours.length);

  // Built once per data/theme change instead of two THREE.Color allocations
  // per bar per render (hover alone re-renders the whole field).
  const barColors = useMemo(() => {
    const surface = new THREE.Color(palette.surface);
    return values.map((row, mi) => {
      const { provider, index } = providerIndices[mi];
      const base = new THREE.Color(colorForModel(provider, index, { forThreeJs: true }));
      return row.map(value => {
        const ratio = value / max;
        return base.clone().lerp(surface, value > 0 ? (1 - ratio) * 0.45 : 0.78);
      });
    });
  }, [values, max, providerIndices, palette.surface]);

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
      <fog attach="fog" args={[palette.surface, viewDistance * 0.9, viewDistance * 2.3]} />
      <hemisphereLight args={[palette.text, palette.surface, 0.3]} />
      <ambientLight intensity={0.4} />
      <directionalLight position={[6, 10, 6]} intensity={0.75} />
      <directionalLight position={[-7, 5, -6]} intensity={0.3} color={palette.accent} />
      <Grid
        args={[gridSpan + 2, gridSpan + 2]}
        position={[0, 0, 0]}
        cellColor={palette.gridLine}
        sectionColor={palette.gridLine}
        fadeDistance={viewDistance * 2}
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
          const { provider } = providerIndices[mi];
          const barColor = barColors[mi][hi];
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
        touches={touch ? FINGER_TOUCHES : MOUSE_TOUCHES}
        autoRotate={autoRotate}
        autoRotateSpeed={AUTO_ROTATE_SPEED}
        onStart={pauseAutoRotate}
        onEnd={scheduleAutoRotate}
        minDistance={Math.min(effectiveCameraDistance * 0.4, minCameraDistance)}
        maxDistance={viewDistance * 1.8}
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
  const touch = useCoarsePointer();
  const webglOk = useMemo(() => checkWebGLSupport(), []);
  const controlsRef = useRef();
  // Populated by Scene with the live aspect-compensated framing (see
  // REFERENCE_ASPECT above) — resetView reads it instead of the raw
  // pre-aspect cameraDistance so the reset button reframes to what's actually
  // on screen, not the desktop-tuned default.
  const frameRef = useRef({ distance: 0, fitDistance: 0 });
  const grid = useMemo(() => buildGrid(modelTimeSeries || [], metric), [modelTimeSeries, metric]);
  const providerIndices = useMemo(() => modelProviderIndices(grid.models, modelToProvider), [grid.models, modelToProvider]);
  const [hovered, setHovered] = useState(null);
  const [pinned, setPinned] = useState(null);
  // Staged by the camera-control handlers (exposed via ref), consumed by
  // Scene's fly-to useFrame.
  const navGoalRef = useRef(null);
  const invalidateRef = useRef(null);
  const setNavGoal = (goal) => { navGoalRef.current = goal; invalidateRef.current?.(); };

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
  // Long custom ranges come back in weekly/monthly buckets (bucket_unit), so
  // once a bucket is a day or wider, density is the bucket count itself — 36
  // monthly bars must frame like ~36 daily bars, not like 3 years of them.
  const firstMs = grid.hours.length > 1 ? new Date(grid.hours[0]).getTime() : 0;
  const lastMs  = grid.hours.length > 1 ? new Date(grid.hours[grid.hours.length - 1]).getTime() : 0;
  const stepDays = grid.hours.length > 1 ? (new Date(grid.hours[1]).getTime() - firstMs) / 86_400_000 : 0;
  const spanDays = stepDays >= 1 ? grid.hours.length - 1 : (lastMs - firstMs) / 86_400_000;
  const { zoom: zoomFactor, minDist: minCameraDistance } = densityFraming(spanDays);
  const cameraDistance = (gridSpan * 1.4 + 5) * zoomFactor;
  const isDense = spanDays > DENSE_THRESHOLD;
  const barSize = isDense ? BAR_SIZE * 0.6 : BAR_SIZE;
  const labelFontSize = Math.max(
    BASE_LABEL_FONT_SIZE,
    BASE_LABEL_FONT_SIZE * Math.sqrt(gridSpan / BASE_LABEL_GRID_SPAN)
  );

  // Read Scene's aspect-compensated framing when it's available, else the raw
  // desktop-tuned defaults above.
  const framing = () => (frameRef.current.distance ? frameRef.current : { distance: cameraDistance, fitDistance: cameraDistance });

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
    controls.object.position.copy(frontPosition(framing().fitDistance));
    controls.target.copy(VIEW_TARGET);
    controls.update();
  };

  // The nudge handlers just stage a goal in navGoalRef and let Scene's fly-to
  // useFrame damp the camera there over a short settle window — no snapping,
  // and it yields to a manual orbit/pan the moment the user starts one.
  const nudgeZoom = (factor) => {
    const c = controlsRef.current;
    if (!c) return;
    const target = c.target.clone();
    const offset = c.object.position.clone().sub(target);
    const { distance, fitDistance: fit } = framing();
    const maxLen = Math.max(distance, fit) * 1.8;
    const len = THREE.MathUtils.clamp(offset.length() * factor, minCameraDistance, maxLen);
    setNavGoal({ position: target.clone().add(offset.setLength(len)), target, until: performance.now() + 450 });
  };

  const nudgeRotate = (radians) => {
    const c = controlsRef.current;
    if (!c) return;
    const target = c.target.clone();
    const offset = c.object.position.clone().sub(target).applyAxisAngle(new THREE.Vector3(0, 1, 0), radians);
    setNavGoal({ position: target.clone().add(offset), target, until: performance.now() + 550 });
  };

  useImperativeHandle(ref, () => ({ nudgeZoom, nudgeRotate, resetView }));

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
    <div className={`ms3d-wrap${touch ? ' ms3d-wrap--touch' : ''}`}>
      <Canvas3DErrorBoundary fallback={<Unsupported3DFallback onSwitchTo2D={onSwitchTo2D} t={t} />}>
        <Canvas
          frameloop="demand"
          resize={{ scroll: false, debounce: 0 }}
          dpr={[1, 2]}
          gl={{ alpha: true }}
          camera={{ position: frontPosition(cameraDistance).toArray(), fov: 45 }}
          onPointerMissed={() => setPinned(null)}
        >
          <Scene
            touch={touch}
            grid={grid}
            metric={metric}
            xLabels={xLabels}
            palette={palette}
            gridSpan={gridSpan}
            labelFontSize={labelFontSize}
            cameraDistance={cameraDistance}
            minCameraDistance={minCameraDistance}
            barSize={barSize}
            controlsRef={controlsRef}
            frameRef={frameRef}
            navGoalRef={navGoalRef}
            invalidateRef={invalidateRef}
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
