import React from "react";

export interface PickMarker {
  seq: number;
  x: number;
  y: number;
  /** Highlights the marker differently while its pair is still missing a side. */
  complete: boolean;
}

interface Props {
  imageDataUrl: string | null;
  markers: PickMarker[];
  onPick: (x: number, y: number) => void;
  height?: number;
  /** Disable image smoothing — appropriate for the range image (a coarse bin
   *  grid, not a photo), where interpolation would blur bin boundaries. */
  pixelated?: boolean;
  emptyLabel?: string;
}

type Mode = "pick" | "pan";

const MARKER_COLOR = "#41cd52";
const MARKER_COLOR_INCOMPLETE = "#e08a1c";

export function PickCanvas({ imageDataUrl, markers, onPick, height = 380, pixelated, emptyLabel }: Props) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [img, setImg] = React.useState<HTMLImageElement | null>(null);
  const [scale, setScale] = React.useState(1);
  const [offset, setOffset] = React.useState({ x: 0, y: 0 });
  const [mode, setMode] = React.useState<Mode>("pick");
  const fitScaleRef = React.useRef(1);
  const dragRef = React.useRef<{ startX: number; startY: number; startOffset: { x: number; y: number }; moved: boolean } | null>(null);

  // Load image
  React.useEffect(() => {
    if (!imageDataUrl) { setImg(null); return; }
    const image = new Image();
    image.onload = () => setImg(image);
    image.src = imageDataUrl;
    return () => { image.onload = null; };
  }, [imageDataUrl]);

  const fitToContainer = React.useCallback(() => {
    const c = containerRef.current;
    if (!c || !img) return;
    const cw = c.clientWidth, ch = c.clientHeight;
    const s = Math.min(cw / img.naturalWidth, ch / img.naturalHeight) * 0.96;
    fitScaleRef.current = s;
    setScale(s);
    setOffset({ x: (cw - img.naturalWidth * s) / 2, y: (ch - img.naturalHeight * s) / 2 });
  }, [img]);

  React.useEffect(() => { fitToContainer(); }, [fitToContainer]);

  React.useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const ro = new ResizeObserver(() => fitToContainer());
    ro.observe(c);
    return () => ro.disconnect();
  }, [fitToContainer]);

  const draw = React.useCallback(() => {
    const canvas = canvasRef.current;
    const c = containerRef.current;
    if (!canvas || !c) return;
    const cw = c.clientWidth, ch = c.clientHeight;
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = "#1a1a1e";
    ctx.fillRect(0, 0, cw, ch);

    if (img) {
      ctx.imageSmoothingEnabled = !pixelated;
      ctx.save();
      ctx.translate(offset.x, offset.y);
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      ctx.restore();

      for (const m of markers) {
        const px = m.x * scale + offset.x;
        const py = m.y * scale + offset.y;
        ctx.beginPath();
        ctx.arc(px, py, 7, 0, Math.PI * 2);
        ctx.fillStyle = m.complete ? MARKER_COLOR : MARKER_COLOR_INCOMPLETE;
        ctx.globalAlpha = 0.85;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "#fff";
        ctx.stroke();
        ctx.font = "600 10px 'IBM Plex Mono', monospace";
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(m.seq), px, py);
      }
    } else if (emptyLabel) {
      ctx.fillStyle = "#666";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(emptyLabel, cw / 2, ch / 2);
    }
  }, [img, scale, offset, markers, pixelated, emptyLabel]);

  React.useEffect(() => { draw(); }, [draw]);

  function toImageCoords(clientX: number, clientY: number): [number, number] | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const cx = clientX - rect.left, cy = clientY - rect.top;
    return [(cx - offset.x) / scale, (cy - offset.y) / scale];
  }

  function onWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    if (!img) return;
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const imgX = (mx - offset.x) / scale, imgY = (my - offset.y) / scale;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const minScale = fitScaleRef.current * 0.3;
    const maxScale = fitScaleRef.current * 25;
    const newScale = Math.min(maxScale, Math.max(minScale, scale * factor));
    setScale(newScale);
    setOffset({ x: mx - imgX * newScale, y: my - imgY * newScale });
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, startOffset: offset, moved: false };
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
    if (mode === "pan" && d.moved) {
      setOffset({ x: d.startOffset.x + dx, y: d.startOffset.y + dy });
    }
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || !img) return;
    if (mode === "pick" && !d.moved) {
      const coords = toImageCoords(e.clientX, e.clientY);
      if (coords && coords[0] >= 0 && coords[0] < img.naturalWidth && coords[1] >= 0 && coords[1] < img.naturalHeight) {
        onPick(coords[0], coords[1]);
      }
    }
  }

  function zoomBy(factor: number) {
    const c = containerRef.current;
    if (!c) return;
    const cx = c.clientWidth / 2, cy = c.clientHeight / 2;
    const imgX = (cx - offset.x) / scale, imgY = (cy - offset.y) / scale;
    const minScale = fitScaleRef.current * 0.3;
    const maxScale = fitScaleRef.current * 25;
    const newScale = Math.min(maxScale, Math.max(minScale, scale * factor));
    setScale(newScale);
    setOffset({ x: cx - imgX * newScale, y: cy - imgY * newScale });
  }

  return (
    <div ref={containerRef} style={{ position: "relative", height, borderRadius: 5, overflow: "hidden", border: "1px solid #333" }}>
      <canvas
        ref={canvasRef}
        style={{ display: "block", cursor: mode === "pan" ? "grab" : "crosshair", touchAction: "none" }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      <div style={{ position: "absolute", top: 8, right: 8, display: "flex", gap: 4 }}>
        <ToolBtn active={mode === "pick"} onClick={() => setMode("pick")} title="选点模式">✛</ToolBtn>
        <ToolBtn active={mode === "pan"} onClick={() => setMode("pan")} title="平移模式">✋</ToolBtn>
        <ToolBtn onClick={() => zoomBy(1.3)} title="放大">＋</ToolBtn>
        <ToolBtn onClick={() => zoomBy(1 / 1.3)} title="缩小">－</ToolBtn>
        <ToolBtn onClick={fitToContainer} title="重置视图">⤢</ToolBtn>
      </div>
    </div>
  );
}

function ToolBtn({ children, onClick, active, title }: { children: React.ReactNode; onClick: () => void; active?: boolean; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 24, height: 24, borderRadius: 4, border: "1px solid rgba(255,255,255,.15)",
        background: active ? "var(--hs-green)" : "rgba(0,0,0,.5)",
        color: "#fff", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
        padding: 0, lineHeight: 1,
      }}
    >
      {children}
    </button>
  );
}
