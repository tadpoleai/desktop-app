import React from "react";
import * as THREE from "three";

/** A marker in the same pixel (col,row) space as the source ERP/range image —
 *  col in [0,azBins), row in [0,elBins). */
export interface SphereMarker {
  seq: number;
  col: number;
  row: number;
  complete: boolean;
}

interface Props {
  imageDataUrl: string | null;
  /** Bin resolution of the source image — must match azBins/elBins the image
   *  was generated at, so (col,row) round-trips exactly through UV space. */
  azBins: number;
  elBins: number;
  /** Vertical extent the image's rows actually span, degrees. Full sphere
   *  (photo panorama / overlay): -90/90. Partial (auto-fit depth image):
   *  whatever build_range_image reported (el_min_deg/el_max_deg). */
  elMinDeg: number;
  elMaxDeg: number;
  /** Must match the invert_elevation flag the image was rendered with — flips
   *  which end of elMinDeg/elMaxDeg sits at row 0 (top). */
  invertElevation?: boolean;
  markers?: SphereMarker[];
  /** Omit for a view-only sphere (no click-to-pick) — used for the overlay
   *  preview panel, which is for visual judgment only, never for picking. */
  onPick?: (col: number, row: number) => void;
  emptyLabel?: string;
  height?: number;
}

const MARKER_COLOR = "#41cd52";
const MARKER_COLOR_INCOMPLETE = "#e08a1c";
const DEFAULT_FOV = 75;
const MIN_FOV = 20;
const MAX_FOV = 100;

/** Builds a partial-sphere BufferGeometry whose UVs are defined by the exact
 *  same formulas `build_range_image`/`direction_to_erp_pixel` use server-side
 *  (see runner/src/rangeimage.rs, runner/src/calib.rs), rather than relying on
 *  THREE.SphereGeometry's built-in UV convention — guarantees the texture
 *  lands correctly and that a click's raycast-interpolated UV maps back to
 *  the exact same (col,row) bin the pixel came from, with no separate
 *  trig-based inverse needed (Three.js's Raycaster already interpolates UV at
 *  the hit point for us).
 *
 *  Coordinate convention matches the rest of this project (z-up, lon =
 *  atan2(y,x), lat = asin(z/r)) — the camera is configured with `up=(0,0,1)`
 *  to match, rather than remapping axes.
 */
function buildSphereGeometry(elMinDeg: number, elMaxDeg: number, invertElevation: boolean, segments = 96): THREE.BufferGeometry {
  const radius = 50;
  const azSegments = segments * 2;
  const elSegments = Math.max(8, Math.round(segments * (Math.abs(elMaxDeg - elMinDeg) / 180)));
  const elMin = (elMinDeg * Math.PI) / 180;
  const elMax = (elMaxDeg * Math.PI) / 180;

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let row = 0; row <= elSegments; row++) {
    const rowFrac = row / elSegments;
    const el = invertElevation ? elMin + rowFrac * (elMax - elMin) : elMax - rowFrac * (elMax - elMin);
    for (let col = 0; col <= azSegments; col++) {
      const colFrac = col / azSegments;
      // u = 0.5 - lon/(2*pi)  =>  lon = (0.5 - u) * 2*pi
      const lon = (0.5 - colFrac) * 2 * Math.PI;
      const x = radius * Math.cos(el) * Math.cos(lon);
      const y = radius * Math.cos(el) * Math.sin(lon);
      const z = radius * Math.sin(el);
      positions.push(x, y, z);
      uvs.push(colFrac, rowFrac);
    }
  }

  const rowStride = azSegments + 1;
  for (let row = 0; row < elSegments; row++) {
    for (let col = 0; col < azSegments; col++) {
      const a = row * rowStride + col;
      const b = a + rowStride;
      const c = a + 1;
      const d = b + 1;
      // Winding order chosen so face normals point inward (toward the
      // camera, which sits at the sphere's center) — verified empirically:
      // the opposite winding rendered nothing with BackSide (culled) and a
      // mirrored image with DoubleSide (seeing the geometric back of each
      // triangle from inside looks mirrored, a separate effect from culling).
      // invertElevation reverses whether increasing `row` moves +Z or -Z
      // (which end of [elMin,elMax] sits at row 0), which also flips the
      // mesh's effective handedness — needs the opposite winding to match,
      // confirmed empirically (partial-range + invertElevation=true rendered
      // nothing/unhittable with the non-inverted winding).
      if (invertElevation) {
        indices.push(a, b, c, b, d, c);
      } else {
        indices.push(a, c, b, b, c, d);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function makeMarkerSprite(seq: number, complete: boolean): THREE.Sprite {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2);
  ctx.fillStyle = complete ? MARKER_COLOR : MARKER_COLOR_INCOMPLETE;
  ctx.globalAlpha = 0.9;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
  ctx.font = "600 28px 'IBM Plex Mono', monospace";
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(seq), size / 2, size / 2 + 1);

  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, sizeAttenuation: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(0.05, 0.05, 1);
  sprite.renderOrder = 999;
  return sprite;
}

export function SphereViewer({ imageDataUrl, azBins, elBins, elMinDeg, elMaxDeg, invertElevation, markers, onPick, emptyLabel, height = 380 }: Props) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const rendererRef = React.useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = React.useRef<THREE.Scene | null>(null);
  const cameraRef = React.useRef<THREE.PerspectiveCamera | null>(null);
  const meshRef = React.useRef<THREE.Mesh | null>(null);
  const markersGroupRef = React.useRef<THREE.Group | null>(null);
  const raycasterRef = React.useRef(new THREE.Raycaster());
  const yawPitchRef = React.useRef({ yaw: 0, pitch: 0 });
  const fovRef = React.useRef(DEFAULT_FOV);
  const dragRef = React.useRef<{ startX: number; startY: number; lastX: number; lastY: number; button: number; moved: boolean } | null>(null);
  const animRef = React.useRef<number | null>(null);
  const applyLookDirectionRef = React.useRef<() => void>(() => {});
  const onPickRef = React.useRef(onPick);
  onPickRef.current = onPick;
  const [hasImage, setHasImage] = React.useState(false);

  // ── One-time scene setup ──────────────────────────────────────────────────
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(DEFAULT_FOV, 1, 0.1, 200);
    camera.up.set(0, 0, 1);
    camera.position.set(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    const markersGroup = new THREE.Group();
    scene.add(markersGroup);

    sceneRef.current = scene;
    cameraRef.current = camera;
    rendererRef.current = renderer;
    markersGroupRef.current = markersGroup;

    function resize() {
      const w = container!.clientWidth, h = container!.clientHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    function applyLookDirection() {
      const { yaw, pitch } = yawPitchRef.current;
      const dir = new THREE.Vector3(Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch));
      camera.lookAt(dir);
      camera.fov = fovRef.current;
      camera.updateProjectionMatrix();
    }
    applyLookDirectionRef.current = applyLookDirection;
    applyLookDirection();

    function animate() {
      animRef.current = requestAnimationFrame(animate);
      renderer.render(scene, camera);
    }
    animate();

    function onMouseDown(e: MouseEvent) {
      // Middle button (held) rotates the view; left button is click-only, for
      // picking. Left-button *drag* deliberately does not rotate: on the
      // actual deployment target (Ubuntu 22.04, WebKitGTK, behind a remote-
      // desktop client), left-button drag never reliably reaches this
      // handler at all — confirmed by the previous window-level-mousemove
      // fix (which correctly fixed rotation in local headless testing) still
      // not fixing it there, meaning the events are being claimed before
      // they ever reach the page, most likely by the remote-desktop client
      // itself (screen/window drag gestures commonly claim the primary
      // button). Middle button is essentially never claimed by such clients.
      if (e.button !== 1 && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = { startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, button: e.button, moved: false };
    }
    function onMouseMove(e: MouseEvent) {
      const d = dragRef.current;
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      const totalDx = e.clientX - d.startX, totalDy = e.clientY - d.startY;
      const dx = e.clientX - d.lastX, dy = e.clientY - d.lastY;
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      // Track "moved" for every button — a left-button drag must not fall
      // through to onMouseUp's click-to-pick using the dragged-to position
      // (that's a real bug this exact refactor introduced: early-returning
      // before this check for non-middle buttons left `moved` permanently
      // false on left-drag, so a left-drag-then-release picked wherever the
      // cursor ended up instead of correctly picking nothing).
      if (Math.abs(totalDx) > 3 || Math.abs(totalDy) > 3) d.moved = true;
      if (d.button === 1 && d.moved) {
        // Scale drag sensitivity with current FOV so zooming in also slows
        // down the apparent look-around speed (matches a real camera).
        const sensitivity = (0.0025 * fovRef.current) / DEFAULT_FOV;
        yawPitchRef.current.yaw -= dx * sensitivity;
        yawPitchRef.current.pitch = Math.max(
          -Math.PI / 2 + 0.05,
          Math.min(Math.PI / 2 - 0.05, yawPitchRef.current.pitch + dy * sensitivity)
        );
        applyLookDirection();
      }
    }
    function onMouseUp(e: MouseEvent) {
      const d = dragRef.current;
      dragRef.current = null;
      // Only a primary-button click selects a calibration point.
      if (!d || d.button !== 0 || d.moved || !onPickRef.current || !meshRef.current) return;
      const rect = renderer.domElement.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1));
      raycasterRef.current.setFromCamera(ndc, camera);
      const hits = raycasterRef.current.intersectObject(meshRef.current, false);
      if (hits.length > 0 && hits[0].uv) {
        const col = hits[0].uv.x * azBins;
        const row = hits[0].uv.y * elBins;
        onPickRef.current(col, row);
      }
    }
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      fovRef.current = Math.max(MIN_FOV, Math.min(MAX_FOV, fovRef.current * (e.deltaY < 0 ? 0.9 : 1 / 0.9)));
      applyLookDirection();
    }
    function onContextMenu(e: MouseEvent) {
      // This is an application viewport, not a browser document. Suppress the
      // WebKit developer-style menu so Reload cannot accidentally discard the
      // current calibration state.
      e.preventDefault();
      e.stopPropagation();
    }

    const dom = renderer.domElement;
    dom.style.touchAction = "none";
    dom.style.userSelect = "none";
    // Use classic mouse events and listen for move/up on window. Pointer
    // capture is unreliable in the Ubuntu WebKitGTK + remote desktop setup;
    // window-level mouse events keep arriving even outside the canvas.
    dom.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove, { passive: false });
    window.addEventListener("mouseup", onMouseUp);
    dom.addEventListener("wheel", onWheel, { passive: false });
    dom.addEventListener("contextmenu", onContextMenu);

    return () => {
      ro.disconnect();
      dom.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      dom.removeEventListener("wheel", onWheel);
      dom.removeEventListener("contextmenu", onContextMenu);
      if (animRef.current) cancelAnimationFrame(animRef.current);
      renderer.dispose();
      container.removeChild(dom);
    };
    // Scene/camera/renderer set up once per mount; azBins/elBins only matter
    // at pick time (read via closure-captured props, stable enough here).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Geometry rebuild when the elevation range/orientation changes ────────
  React.useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const geo = buildSphereGeometry(elMinDeg, elMaxDeg, !!invertElevation);
    const material = new THREE.MeshBasicMaterial({ color: 0x1a1a1e, side: THREE.BackSide });
    const mesh = new THREE.Mesh(geo, material);
    if (meshRef.current) {
      scene.remove(meshRef.current);
      meshRef.current.geometry.dispose();
      (meshRef.current.material as THREE.Material).dispose();
    }
    scene.add(mesh);
    meshRef.current = mesh;
    return () => {
      scene.remove(mesh);
      geo.dispose();
      material.dispose();
    };
  }, [elMinDeg, elMaxDeg, invertElevation]);

  // ── Texture load ──────────────────────────────────────────────────────────
  React.useEffect(() => {
    if (!imageDataUrl) { setHasImage(false); return; }
    let cancelled = false;
    new THREE.TextureLoader().load(imageDataUrl, (texture) => {
      if (cancelled || !meshRef.current) return;
      // Three.js defaults flipY=true (auto-corrects the WebGL/image Y
      // convention mismatch) — but our UV.y is already defined directly
      // against rowFrac (0=top of source image, matching el=elMax), so the
      // default flip double-flips it. Empirically confirmed: text rendered
      // upside-down at every tessellation density until this was set.
      texture.flipY = false;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      const material = meshRef.current.material as THREE.MeshBasicMaterial;
      material.map = texture;
      material.color.set(0xffffff);
      material.needsUpdate = true;
      setHasImage(true);
    });
    return () => { cancelled = true; };
  }, [imageDataUrl, elMinDeg, elMaxDeg, invertElevation]);

  // ── Markers ────────────────────────────────────────────────────────────────
  React.useEffect(() => {
    const group = markersGroupRef.current;
    if (!group) return;
    while (group.children.length) {
      const child = group.children.pop()!;
      if (child instanceof THREE.Sprite) {
        child.material.map?.dispose();
        child.material.dispose();
      }
    }
    const elMin = (elMinDeg * Math.PI) / 180;
    const elMax = (elMaxDeg * Math.PI) / 180;
    for (const m of markers ?? []) {
      const colFrac = m.col / azBins;
      const rowFrac = m.row / elBins;
      const el = invertElevation ? elMin + rowFrac * (elMax - elMin) : elMax - rowFrac * (elMax - elMin);
      const lon = (0.5 - colFrac) * 2 * Math.PI;
      const r = 48; // just inside the 50-radius sphere, toward the camera
      const sprite = makeMarkerSprite(m.seq, m.complete);
      sprite.position.set(r * Math.cos(el) * Math.cos(lon), r * Math.cos(el) * Math.sin(lon), r * Math.sin(el));
      group.add(sprite);
    }
  }, [markers, azBins, elBins, elMinDeg, elMaxDeg, invertElevation]);

  function resetView() {
    yawPitchRef.current = { yaw: 0, pitch: 0 };
    fovRef.current = DEFAULT_FOV;
    applyLookDirectionRef.current();
  }

  return (
    <div ref={containerRef} style={{ position: "relative", height, borderRadius: 5, overflow: "hidden", border: "1px solid #333", background: "#1a1a1e", touchAction: "none" }}>
      {!hasImage && emptyLabel && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#666", fontSize: 12, pointerEvents: "none" }}>
          {emptyLabel}
        </div>
      )}
      <div style={{ position: "absolute", top: 8, right: 8, display: "flex", gap: 4 }}>
        <ToolBtn onClick={resetView} title="重置视角">⤢</ToolBtn>
      </div>
      <div style={{ position: "absolute", bottom: 8, left: 8, fontSize: 10, color: "rgba(255,255,255,.5)", pointerEvents: "none" }}>
        鼠标中键拖动查看方向 · 滚轮缩放{onPick ? " · 左键点击选点" : ""}
      </div>
    </div>
  );
}

function ToolBtn({ children, onClick, title }: { children: React.ReactNode; onClick: () => void; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 24, height: 24, borderRadius: 4, border: "1px solid rgba(255,255,255,.15)",
        background: "rgba(0,0,0,.5)", color: "#fff", fontSize: 12, cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 0, lineHeight: 1,
      }}
    >
      {children}
    </button>
  );
}
