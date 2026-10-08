// ─────────────────────────────────────────────────────────────────────────────
// DocumentViewer.tsx
//
// Phase 3: Per-tab PDF canvas + Konva markup overlay extracted from App.tsx.
//
// Ghost Tab Strategy:
//   - ALL open DocumentViewers are mounted simultaneously (one per tab).
//   - Inactive viewers have `display: none` applied to their root <main>.
//     This preserves canvas context allocations so switching back is instant.
//   - Only the ACTIVE viewer processes mouse events, keyboard shortcuts, and
//     writes to the shared Zustand root-proxy fields.
//
// Data flow:
//   - pdfBytes  → per-tab from documents[tabId].pdfBytes via usePdfBytes().
//                 Changing bytes (file-open, page-insert) triggers pdfDoc reload.
//   - pdfDoc    → local React state, derived from pdfBytes in a useEffect.
//   - All other markup state (shapes, scale, pageNum, etc.) → root-level proxy,
//     always pointing at the ACTIVE tab's data.  Only the active viewer mutates
//     these fields, so correctness is guaranteed by the isActive gate.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useRef, useEffect } from 'react';
import Konva from 'konva';
import * as pdfjsLib from 'pdfjs-dist';
import {
  Stage, Layer, Rect, Circle, Line, Transformer,
  Text, Group, Path, Shape, RegularPolygon
} from 'react-konva';
import { useStore } from '../store/useStore';
import { useShallow } from 'zustand/react/shallow';
import { usePdfBytes } from '../store/useDocumentStore';
import { acquirePdfDoc, releasePdfDoc } from '../utils/pdfDocumentManager';
import type { ShapeData, Guide } from '../store/types';
import { PatternEngine } from '../utils/PatternEngine';
import { extractVectorsFromOps, GridSpatialIndex, getNearestPointOnSegment } from '../utils/vectorSnapper';
import type { VectorSegment } from '../utils/vectorSnapper';
import { MarksShapeRenderer, isMarkType, isLineMark, isBoxMark, getDefaultMarkSize } from './MarksRenderer';
import { TableRenderer } from './TableRenderer';
import { MasterUnderlayLayer, MasterBgCanvas } from './MasterPageUnderlay';
import { deserializeMasterPages } from '../utils/pdfExporter';
import { getSpreads } from '../utils/spreadLayout';

// (Worker URL is configured once in ../utils/pdfDocumentManager.)

// ─── Constants ────────────────────────────────────────────────────────────────

const POINT_BASED_TYPES = [
  'line', 'arrow', 'measure_length', 'measure_area',
  'cloud', 'callout', 'polyline', 'polygon', 'spline', 'arc',
  'freehand', 'brush', 'highlight'
];

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/** Snap a drag/draw vector to the nearest 45° axis when Shift is held. */
function shiftConstrain(
  originX: number, originY: number, x: number, y: number
): { x: number; y: number } {
  const dx = x - originX;
  const dy = y - originY;
  const angle = Math.atan2(dy, dx);
  const snap = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
  const dist = Math.sqrt(dx * dx + dy * dy);
  return { x: originX + dist * Math.cos(snap), y: originY + dist * Math.sin(snap) };
}

/**
 * Snaps `pos` to the nearest guide within SNAP_THRESHOLD canvas units.
 * Returns `pos` unchanged when snap is disabled or no guide is close enough.
 */
const calculateSnap = (
  pos: number,
  guides: Guide[],
  orientation: 'horizontal' | 'vertical',
  scale: number,
  snapEnabled: boolean,
  sensitivity: number = 10
): number => {
  if (!snapEnabled) return pos;
  const SNAP_THRESHOLD = sensitivity / scale;
  let closest = pos;
  let minDiff = SNAP_THRESHOLD;
  guides.filter(g => g.orientation === orientation).forEach(g => {
    const diff = Math.abs(pos - g.position);
    if (diff < minDiff) { minDiff = diff; closest = g.position; }
  });
  return closest;
};

interface ShapeAABB {
  minX: number;
  maxX: number;
  centerX: number;
  minY: number;
  maxY: number;
  centerY: number;
}

const getShapeAABB = (shape: ShapeData, cx: number, cy: number, rotDeg: number): ShapeAABB => {
  const type = shape.type || '';
  if (POINT_BASED_TYPES.includes(type)) {
    if (!shape.points || shape.points.length === 0) {
      return { minX: cx, maxX: cx, centerX: cx, minY: cy, maxY: cy, centerY: cy };
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const offsetX = cx - (shape.x || 0);
    const offsetY = cy - (shape.y || 0);
    for (let i = 0; i < shape.points.length; i += 2) {
      const px = (shape.points[i] ?? 0) + offsetX;
      const py = (shape.points[i + 1] ?? 0) + offsetY;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    if (type === 'cloud') {
      const pad = shape.radius || 20;
      minX -= pad; maxX += pad;
      minY -= pad; maxY += pad;
    }
    return {
      minX,
      maxX,
      centerX: (minX + maxX) / 2,
      minY,
      maxY,
      centerY: (minY + maxY) / 2
    };
  }

  let localCorners: { x: number; y: number }[] = [];
  if (type === 'circle') {
    const rx = shape.width !== undefined ? shape.width / 2 : (shape.radius || 50);
    const ry = shape.height !== undefined ? shape.height / 2 : (shape.radius || 50);
    localCorners = [
      { x: -rx, y: -ry },
      { x: rx, y: -ry },
      { x: rx, y: ry },
      { x: -rx, y: ry }
    ];
  } else {
    const w = shape.width || 0;
    const h = shape.height || 0;
    localCorners = [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h }
    ];
  }

  const rotRad = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rotRad);
  const sin = Math.sin(rotRad);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const p of localCorners) {
    const px = cx + (p.x * cos - p.y * sin);
    const py = cy + (p.x * sin + p.y * cos);
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }

  return {
    minX,
    maxX,
    centerX: (minX + maxX) / 2,
    minY,
    maxY,
    centerY: (minY + maxY) / 2
  };
};

/** Build a regular polygon's point array from centre, radius and side count. */
function buildPolygonPoints(
  cx: number, cy: number, radius: number, sides: number
): number[] {
  const pts: number[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = (Math.PI * 2 * i) / sides - Math.PI / 2;
    pts.push(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
  }
  return pts;
}



/** Build the SVG path data for a revision-cloud scallop chain. */
function buildCloudSvgPath(pts: number[], bumpSize = 25): string {
  if (pts.length < 4) return '';
  let path = `M ${pts[0]} ${pts[1]}`;
  for (let i = 0; i < pts.length - 2; i += 2) {
    const x1 = pts[i], y1 = pts[i + 1];
    const x2 = pts[i + 2], y2 = pts[i + 3];
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) { path += ` L ${x2} ${y2}`; continue; }
    const arcCount = Math.max(1, Math.round(len / (bumpSize * 1.5)));
    const stepX = dx / arcCount;
    const stepY = dy / arcCount;
    const nx = -dy / len, ny = dx / len;
    for (let j = 0; j < arcCount; j++) {
      const pAx = x1 + stepX * j, pAy = y1 + stepY * j;
      const pBx = x1 + stepX * (j + 1), pBy = y1 + stepY * (j + 1);
      const amx = (pAx + pBx) / 2, amy = (pAy + pBy) / 2;
      const cx = amx + nx * bumpSize, cy = amy + ny * bumpSize;
      if (j === 0 && i !== 0) path += ` L ${pAx} ${pAy}`;
      path += ` Q ${cx} ${cy} ${pBx} ${pBy}`;
    }
  }
  return path;
}

/** Format a real-world measurement in feet/inches/sixteenths. */
function formatImperial(real_inches: number) {
  const feet = Math.floor(real_inches / 12);
  const inches = real_inches % 12;
  const sixteenths = Math.round(inches * 16);
  if (sixteenths === 192) return `${feet + 1}'-0"`;
  const wholeInches = Math.floor(sixteenths / 16);
  const rem = sixteenths % 16;
  if (rem === 0) {
    if (feet === 0) return `${wholeInches}"`;
    return wholeInches === 0 ? `${feet}'-0"` : `${feet}'-${wholeInches}"`;
  }
  let num = rem, den = 16;
  while (num % 2 === 0 && den % 2 === 0) { num /= 2; den /= 2; }
  if (feet === 0)
    return wholeInches === 0 ? `${num}/${den}"` : `${wholeInches} ${num}/${den}"`;
  return wholeInches === 0 ? `${feet}'-${num}/${den}"` : `${feet}'-${wholeInches} ${num}/${den}"`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/** CSS-pixel ruler along the top or left edge of the canvas. */
const RulerCanvas = ({
  vertical, size, scale, calibration, viewportSize, panOffset, pdfBounds,
}: {
  vertical?: boolean; size: number; scale: number;
  calibration: number; viewportSize: number; panOffset: number; pdfBounds: number;
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = (vertical ? 30 : viewportSize) * dpr;
    canvas.height = (vertical ? viewportSize : 30) * dpr;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#1e1e1e';
    ctx.clearRect(0, 0, canvas.width, canvas.height); // Clear the whole canvas

    // Page Highlight Background — pdfBounds is already viewport.width (pdf_points × scale),
    // so do NOT multiply by scale again here.
    ctx.fillStyle = 'rgba(77, 166, 255, 0.22)';
    if (vertical) {
      ctx.fillRect(0, panOffset, canvas.width, pdfBounds);
    } else {
      ctx.fillRect(panOffset, 0, pdfBounds, canvas.height);
    }

    // Apply pan offset to canvas drawing contexts
    ctx.save();
    if (vertical) {
      ctx.translate(0, panOffset);
    } else {
      ctx.translate(panOffset, 0);
    }

    ctx.strokeStyle = '#444'; ctx.lineWidth = 1;
    ctx.font = '9px monospace'; ctx.fillStyle = '#aaa';
    const pointsPerUnit = 72.0;
    const unitStep = pointsPerUnit * scale;
    const mmStep = (pointsPerUnit / 25.4) * scale;
    
    // Calculate adaptive step size for inches (major ticks)
    // We want the spacing between labeled ticks to be at least 50 pixels to prevent overlap.
    const allowedSteps = [1, 2, 4, 6, 12, 24, 48, 96, 120, 240, 480];
    let inchStep = 1;
    for (const step of allowedSteps) {
      if (step * unitStep >= 50) {
        inchStep = step;
        break;
      }
      inchStep = step; // fallback
    }

    // Calculate adaptive step size for millimeters (minor ticks)
    // We want the spacing between minor ticks to be at least 8 pixels.
    const allowedMmSteps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
    let mmInterval = 1;
    for (const step of allowedMmSteps) {
      if (step * mmStep >= 8) {
        mmInterval = step;
        break;
      }
      mmInterval = step; // fallback
    }

    // We adjust the viewport looping to draw beyond the viewport slightly to cover the translation
    const startMMSegment = Math.floor( -panOffset / (mmStep * mmInterval) ) * mmInterval;
    const endMMSegment = Math.ceil( (viewportSize - panOffset) / (mmStep * mmInterval) ) * mmInterval;
    
    ctx.beginPath(); ctx.strokeStyle = '#444';
    for (let i = startMMSegment; i <= endMMSegment; i += mmInterval) {
      const pos = i * mmStep;
      if (vertical) { ctx.moveTo(18, pos); ctx.lineTo(30, pos); }
      else          { ctx.moveTo(pos, 18); ctx.lineTo(pos, 30); }
    }
    ctx.stroke();
    
    const startInches = Math.floor( -panOffset / (unitStep * inchStep) ) * inchStep;
    const endInches = Math.ceil( (viewportSize - panOffset) / (unitStep * inchStep) ) * inchStep;

    ctx.strokeStyle = '#4da6ff'; ctx.fillStyle = '#4da6ff'; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = startInches; i <= endInches; i += inchStep) {
      const pos = i * unitStep;
      if (vertical) {
        ctx.moveTo(0, pos); ctx.lineTo(30, pos);
        ctx.save(); ctx.translate(12, pos + 12); ctx.rotate(-Math.PI / 2);
        ctx.fillText(`${i}"`, 0, 0); ctx.restore();
      } else {
        ctx.moveTo(pos, 0); ctx.lineTo(pos, 30);
        ctx.fillText(`${i}"`, pos + 4, 12);
      }
      if (i > 0 && i % (inchStep * 2) === 0) {
        ctx.fillStyle = '#888';
        const mmVal = Math.round(i * 25.4);
        if (vertical) ctx.fillText(`${mmVal}mm`, 2, pos - 4);
        else          ctx.fillText(`${mmVal}mm`, pos - 25, 25);
        ctx.fillStyle = '#4da6ff';
      }
    }
    ctx.stroke();
    ctx.restore();
  }, [vertical, size, scale, calibration, viewportSize, panOffset, pdfBounds]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: vertical ? 30 : viewportSize, height: vertical ? viewportSize : 30, display: 'block' }}
    />
  );
};

/** Konva-compatible image renderer that loads via an HTML Image element. */
const CustomImage = ({ shape, commonProps }: { shape: ShapeData; commonProps: any }) => {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (shape.imageUrl) {
      const i = new window.Image();
      i.onload = () => setImg(i);
      i.src = shape.imageUrl;
    }
  }, [shape.imageUrl]);
  if (!img) return null;
  const scaleX = shape.width  ? shape.width  / img.naturalWidth  : 1;
  const scaleY = shape.height ? shape.height / img.naturalHeight : 1;
  return (
    <Rect
      {...commonProps}
      x={shape.x} y={shape.y}
      width={shape.width} height={shape.height}
      fillPatternImage={img}
      fillPatternScaleX={scaleX} fillPatternScaleY={scaleY}
      fillPatternOffset={{ x: 0, y: 0 }}
      fillPatternRepeat="no-repeat"
      stroke={shape.strokeColor} strokeWidth={shape.strokeWidth}
    />
  );
};

// ─── ContentBoxRenderer ─────────────────────────────────────────────────────────────────────────

const ContentBoxRenderer = ({
  shape, commonProps, updateShape, pushToHistory, isSelected, scale, spreadOffsetX,
}: {
  shape: ShapeData;
  commonProps: any;
  updateShape: (id: string, updates: Partial<ShapeData>) => void;
  pushToHistory: () => void;
  isSelected: boolean;
  scale: number;
  spreadOffsetX: number;
}) => {
  const [assetImg, setAssetImg] = useState<HTMLImageElement | null>(null);

  // Load / reload the asset image whenever the URL changes.
  useEffect(() => {
    if (!shape.assetUrl) { setAssetImg(null); return; }
    const img = new window.Image();
    img.onload = () => setAssetImg(img);
    img.src = shape.assetUrl;
  }, [shape.assetUrl]);

  const fw = shape.width  || 0;
  const fh = shape.height || 0;
  const isContentMode = shape.contentMode === 'content';

  // Asset transform: defaults to filling the frame when no assetTransform yet.
  const at = shape.assetTransform || { x: 0, y: 0, width: fw, height: fh };
  const ax = at.x, ay = at.y, aw = at.width, ah = at.height;

  // Visual border styling
  const hasExplicitStroke = shape.strokeColor && shape.strokeColor !== 'transparent';
  let strokeColorVal = 'transparent';
  if (hasExplicitStroke) {
    strokeColorVal = shape.strokeColor!;
  } else if (isContentMode) {
    strokeColorVal = '#f97316';
  } else if (isSelected) {
    strokeColorVal = '#4da6ff';
  } else if (shape.strokeColor !== 'transparent') {
    strokeColorVal = 'rgba(77,166,255,0.55)';
  }

  const strokeWidthVal = hasExplicitStroke
    ? (shape.strokeWidth ?? 1) / scale
    : ((isSelected || isContentMode ? 1.5 : 1) / scale);

  const dashVal = hasExplicitStroke
    ? undefined
    : (isContentMode ? undefined : [5 / scale, 4 / scale]);

  // Content-mode handle size (in canvas units)
  const H = 8 / scale;

  return (
    /* ── Outer Group: NO clip — border, hit rect, and handles are always visible ── */
    <Group 
      {...commonProps} 
      draggable={isContentMode ? false : commonProps.draggable} 
      x={shape.x} y={shape.y}
      rotation={shape.rotation || 0}
    >

      {/* Transparent hit rect: makes clicking anywhere inside the empty frame work */}
      <Rect 
        x={0} y={0} width={fw} height={fh} 
        fill="rgba(0,0,0,0)" 
        onDblClick={commonProps.onDblClick}
      />

      {/* Frame border — OUTSIDE the clip group so it's never cut off */}
      <Rect
        x={0} y={0} width={fw} height={fh}
        fill="transparent"
        stroke={strokeColorVal}
        strokeWidth={strokeWidthVal}
        dash={dashVal}
        listening={false}
      />

      {/* ── Inner Group: clips image + placeholder to the frame bounds ── */}
      <Group clipX={0} clipY={0} clipWidth={fw} clipHeight={fh} listening={false}>
        {assetImg && (
          <Rect
            x={ax} y={ay} width={aw} height={ah}
            fillPatternImage={assetImg}
            fillPatternScaleX={aw / assetImg.naturalWidth}
            fillPatternScaleY={ah / assetImg.naturalHeight}
            fillPatternOffset={{ x: 0, y: 0 }}
            fillPatternRepeat="no-repeat"
            stroke="transparent" strokeWidth={0}
            listening={false}
          />
        )}
        {!assetImg && (
          <>
            <Line points={[0, 0, fw, fh]} stroke="rgba(77,166,255,0.35)" strokeWidth={1 / scale} listening={false} />
            <Line points={[fw, 0, 0, fh]} stroke="rgba(77,166,255,0.35)" strokeWidth={1 / scale} listening={false} />
            <Text
              x={fw / 2 - 80} y={fh / 2 - 8} width={160} height={16}
              text="Drop image or PDF here"
              fill="rgba(77,166,255,0.5)"
              fontSize={Math.max(9, Math.min(14, fw / 10))}
              fontFamily="Inter" align="center" listening={false}
            />
          </>
        )}
      </Group>

      {/* Content-mode draggable overlay: invisible rect (using rgba(0,0,0,0) fill so clicks hit it)
          that matches the asset bounds and allows panning the image. Lives OUTSIDE the clip. */}
      {isContentMode && assetImg && (
        <Rect
          x={ax} y={ay} width={aw} height={ah}
          fill="rgba(0,0,0,0)"
          stroke="#f97316" strokeWidth={1.5 / scale}
          draggable={true}
          onDblClick={commonProps.onDblClick}
          onDragStart={(e: any) => { e.cancelBubble = true; pushToHistory(); }}
          onDragMove={(e: any) => {
            e.cancelBubble = true;
            updateShape(shape.id, { assetTransform: { ...at, x: e.target.x(), y: e.target.y() } });
          }}
          onDragEnd={(e: any) => {
            e.cancelBubble = true;
            const finalX = e.target.x(), finalY = e.target.y();
            e.target.x(ax); e.target.y(ay);
            updateShape(shape.id, { assetTransform: { ...at, x: finalX, y: finalY } });
          }}
        />
      )}

      {/* Content-mode resize handles (8 squares around the asset, OUTSIDE clip) */}
      {isContentMode && isSelected && [
        { key: 'nw', cx: ax,          cy: ay,          cursor: 'nwse-resize', dx: -1, dy: -1 },
        { key: 'ne', cx: ax + aw,     cy: ay,          cursor: 'nesw-resize', dx:  1, dy: -1 },
        { key: 'sw', cx: ax,          cy: ay + ah,     cursor: 'nesw-resize', dx: -1, dy:  1 },
        { key: 'se', cx: ax + aw,     cy: ay + ah,     cursor: 'nwse-resize', dx:  1, dy:  1 },
        { key: 'n',  cx: ax + aw / 2, cy: ay,          cursor: 'ns-resize',   dx:  0, dy: -1 },
        { key: 's',  cx: ax + aw / 2, cy: ay + ah,     cursor: 'ns-resize',   dx:  0, dy:  1 },
        { key: 'w',  cx: ax,          cy: ay + ah / 2, cursor: 'ew-resize',   dx: -1, dy:  0 },
        { key: 'e',  cx: ax + aw,     cy: ay + ah / 2, cursor: 'ew-resize',   dx:  1, dy:  0 },
      ].map(({ key, cx, cy, cursor, dx, dy }) => (
        <Rect
          key={`${shape.id}-ch-${key}`}
          x={cx - H / 2} y={cy - H / 2}
          width={H} height={H}
          fill="white" stroke="#f97316" strokeWidth={1.5 / scale}
          draggable
          onMouseEnter={(e: any) => { const st = e.target.getStage(); if (st) st.container().style.cursor = cursor; }}
          onMouseLeave={(e: any) => { const st = e.target.getStage(); if (st) st.container().style.cursor = 'default'; }}
          onDragStart={(e: any) => { e.cancelBubble = true; pushToHistory(); }}
          onDragMove={(e: any) => {
            e.cancelBubble = true;
            const px = e.target.x() + H / 2;
            const py = e.target.y() + H / 2;
            const isShift = e.evt && e.evt.shiftKey;
            const originalRatio = assetImg ? assetImg.naturalWidth / assetImg.naturalHeight : 1;

            let nx = at.x, ny = at.y, nw = at.width, nh = at.height;
            if (dx === -1) { const delta = px - ax; nx = ax + delta; nw = Math.max(10, aw - delta); }
            if (dx ===  1) { nw = Math.max(10, px - ax); }
            if (dy === -1) { const delta = py - ay; ny = ay + delta; nh = Math.max(10, ah - delta); }
            if (dy ===  1) { nh = Math.max(10, py - ay); }

            if (isShift) {
              // Proportional scaling
              if (key === 'e' || key === 'w' || key === 'se' || key === 'sw' || key === 'ne' || key === 'nw') {
                nh = nw / originalRatio;
              } else if (key === 'n' || key === 's') {
                nw = nh * originalRatio;
              }
              // Adjust positions based on anchor points
              if (key === 'sw' || key === 'w' || key === 'nw') {
                nx = (ax + aw) - nw;
              }
              if (key === 'ne' || key === 'n' || key === 'nw') {
                ny = (ay + ah) - nh;
              }
            }

            // Reset handle position so Konva doesn’t move it; we control it via state
            e.target.x(cx - H / 2); e.target.y(cy - H / 2);
            updateShape(shape.id, { assetTransform: { x: nx, y: ny, width: nw, height: nh } });
          }}
          onDragEnd={(e: any) => { e.cancelBubble = true; e.target.x(cx - H / 2); e.target.y(cy - H / 2); }}
        />
      ))}

      {/* Frame-boundary resize handles (8 squares around the frame, visible in content mode) */}
      {isContentMode && isSelected && [
        { key: 'nw', cx: 0,      cy: 0,      cursor: 'nwse-resize', dx: -1, dy: -1 },
        { key: 'ne', cx: fw,     cy: 0,      cursor: 'nesw-resize', dx:  1, dy: -1 },
        { key: 'sw', cx: 0,      cy: fh,     cursor: 'nesw-resize', dx: -1, dy:  1 },
        { key: 'se', cx: fw,     cy: fh,     cursor: 'nwse-resize', dx:  1, dy:  1 },
        { key: 'n',  cx: fw / 2, cy: 0,      cursor: 'ns-resize',   dx:  0, dy: -1 },
        { key: 's',  cx: fw / 2, cy: fh,     cursor: 'ns-resize',   dx:  0, dy:  1 },
        { key: 'w',  cx: 0,      cy: fh / 2, cursor: 'ew-resize',   dx: -1, dy:  0 },
        { key: 'e',  cx: fw,     cy: fh / 2, cursor: 'ew-resize',   dx:  1, dy:  0 },
      ].map(({ key, cx, cy, cursor, dx, dy }) => (
        <Rect
          key={`${shape.id}-fh-${key}`}
          x={cx - H / 2} y={cy - H / 2}
          width={H} height={H}
          fill="white" stroke="#4da6ff" strokeWidth={1.5 / scale}
          dash={[2 / scale, 2 / scale]}
          draggable
          onMouseEnter={(e: any) => { const st = e.target.getStage(); if (st) st.container().style.cursor = cursor; }}
          onMouseLeave={(e: any) => { const st = e.target.getStage(); if (st) st.container().style.cursor = 'default'; }}
          onDragStart={(e: any) => { e.cancelBubble = true; pushToHistory(); }}
          onDragMove={(e: any) => {
            e.cancelBubble = true;
            const px = e.target.x() + H / 2;
            const py = e.target.y() + H / 2;
            
            let nx = shape.x, ny = shape.y;
            let nw = fw, nh = fh;
            let nAx = ax, nAy = ay;

            if (dx === -1) {
              const deltaX = px;
              nw = Math.max(20, fw - deltaX);
              const actualDeltaX = fw - nw;
              nx = shape.x + actualDeltaX;
              nAx = ax - actualDeltaX;
            } else if (dx === 1) {
              nw = Math.max(20, px);
            }

            if (dy === -1) {
              const deltaY = py;
              nh = Math.max(20, fh - deltaY);
              const actualDeltaY = fh - nh;
              ny = shape.y + actualDeltaY;
              nAy = ay - actualDeltaY;
            } else if (dy === 1) {
              nh = Math.max(20, py);
            }

            e.target.x(cx - H / 2); e.target.y(cy - H / 2);
            updateShape(shape.id, {
              x: nx - spreadOffsetX,
              y: ny,
              width: nw,
              height: nh,
              assetTransform: { ...at, x: nAx, y: nAy }
            });
          }}
          onDragEnd={(e: any) => { e.cancelBubble = true; e.target.x(cx - H / 2); e.target.y(cy - H / 2); }}
        />
      ))}
    </Group>
  );
};

const tauriLog = (msg: string) => {
  console.log(msg);
  import('@tauri-apps/api/core').then(({ invoke }) => {
    invoke('debug_log', { msg }).catch(err => console.error("Tauri log error:", err));
  }).catch(() => {});
};

// ─── DocumentViewer ───────────────────────────────────────────────────────────

interface DocumentViewerProps {
  /** The tab this viewer belongs to. Used to read per-tab pdfBytes. */
  tabId: string;
  /** When false the viewer is hidden (display:none). Events are suppressed. */
  isActive: boolean;
}

export const DocumentViewer = React.memo(function DocumentViewer({ tabId, isActive }: DocumentViewerProps) {

  // ── Local state ─────────────────────────────────────────────────────────────

  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [viewport, setViewport] = useState<pdfjsLib.PageViewport | null>(null);
  const [visibleBox, setVisibleBox] = useState({ x: 0, y: 0, w: 0, h: 0 });
  const [isInteracting, setIsInteracting] = useState(false);

  // ── Stage size — tracked dynamically so Konva pointer coords stay correct
  // after sleep/wake (Windows can change DPI, resizing the window without
  // triggering a React re-render that would refresh window.innerWidth/Height).
  const [stageSize, setStageSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [selectionBox, setSelectionBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [inlineEditText, setInlineEditText] = useState<{
    id: string; cellId?: string; text: string; x: number; y: number; w: number; h: number;
    fontSize: number; fontFamily: string; strokeColor: string;
    isBold: boolean; isItalic: boolean; isUnderline: boolean; isStrike: boolean;
  } | null>(null);

  const [activeSnap, setActiveSnap] = useState<{ type: 'endpoint' | 'midpoint' | 'nearest'; x: number; y: number } | null>(null);
  const [parallelSnapGuide, setParallelSnapGuide] = useState<{ start: { x: number; y: number }; end: { x: number; y: number } } | null>(null);
  const [smartGuides, setSmartGuides] = useState<{ vertical: number | null; horizontal: number | null }>({
    vertical: null,
    horizontal: null
  });
  const [vectorsLoading, setVectorsLoading] = useState<Record<number, boolean>>({});

  // Brush Resize State
  const isResizingBrushRef = useRef(false);
  const brushResizeStartXRef = useRef(0);
  const initialBrushThicknessRef = useRef(12);
  const [previewCursor, setPreviewCursor] = useState({ x: 0, y: 0 });
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 });
  const lastMidClickRef = useRef<number>(0);

  // Guide Drag-from-Ruler State
  const [draggingFromRuler, setDraggingFromRuler] = useState<{ orientation: 'horizontal' | 'vertical' } | null>(null);
  const [guidePreviewPos, setGuidePreviewPos] = useState({ x: 0, y: 0 });

  // ── Refs ────────────────────────────────────────────────────────────────────

  const pdfBytesRef         = useRef<Uint8Array | null>(null);
  const stageRef            = useRef<any>(null);
  const trRef               = useRef<any>(null);
  const workspaceRef        = useRef<HTMLDivElement>(null);
  const baseCanvasRef       = useRef<HTMLCanvasElement>(null);
  const highResCanvasRef    = useRef<HTMLCanvasElement>(null);
  const renderLockRef       = useRef<Promise<any>>(Promise.resolve());
  const isDrawingRef        = useRef(false);
  const newShapeIdRef       = useRef<string | null>(null);
  const drawOriginRef       = useRef<{ x: number, y: number } | null>(null);
  const shiftDownRef        = useRef(false);
  const polygonCenterRef    = useRef<{ x: number; y: number } | null>(null);
  const interactionTimeoutRef = useRef<number | null>(null);
  // Replaced promise-chain queue with a serial counter — only the latest render
  // actually runs; all superseded renders cancel their PDF.js tasks immediately.
  const renderSerialRef     = useRef(0);
  const mousePosRef         = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragInitialRotRef   = useRef<number>(0);
  const snappedOffsetRef    = useRef<{ dx: number; dy: number; vertical: number | null; horizontal: number | null }>({
    dx: 0,
    dy: 0,
    vertical: null,
    horizontal: null
  });
  const snapCalculatedThisFrameRef = useRef<boolean>(false);
  const dragStartMouseOffsetRef = useRef<{ x: number; y: number } | null>(null);
  const dragStartMousePosRef = useRef<{ x: number; y: number } | null>(null);
  const dragLeaderIdRef = useRef<string | null>(null);
  // Tracks whether the Konva Stage is currently being natively dragged.
  // While true, we must NOT write panOffset to Zustand (avoids the tug-of-war
  // re-render loop that causes violent pan jitter).
  const isStageDraggingRef  = useRef(false);
  const hasClonedThisDragRef = useRef(false);
  // Prevents auto-fit from re-running on sleep/wake if the user already
  // has a zoom level set (avoids overwriting their custom zoom with a
  // freshly-computed fitScale based on potentially different window dims).
  const hasAutoFittedRef    = useRef(false);
  // Stores the PDF page's native (scale-1.0) pixel dimensions.
  // Used to compute the base canvas CSS size as `nativeW * scale` synchronously
  // inside each render, avoiding the one-frame async lag from viewport.width
  // that caused a visible size snap on every zoom tick.
  const pdfNativeSizeRef    = useRef<{ w: number; h: number } | null>(null);
  // Mirrors the `viewport` React state but updated synchronously (no re-render).
  // Rendering effects read this ref so they always have fresh dimensions even
  // during active zooming, without waiting for the debounced state flush.
  const viewportRef         = useRef<pdfjsLib.PageViewport | null>(null);
  // Timer id for the debounced setViewport call (Fix 2).
  const viewportDebounceRef = useRef<number | null>(null);

  // Vector snapping cache and grid index refs
  const pageVectorsRef = useRef<Record<number, VectorSegment[]>>({});
  const pageGridIndicesRef = useRef<Record<number, GridSpatialIndex>>({});

  // ── Store ───────────────────────────────────────────────────────────────────
  // Per-tab: read pdfBytes from documents[tabId] directly (bypasses root proxy)
  const pdfBytes = usePdfBytes(tabId);
  const savingStatus = useStore((s) => s.savingStatus?.[tabId] ?? null);

  // Root-level proxies — always reflect the ACTIVE tab.
  // Selector + shallow compare: re-render only when one of these fields changes,
  // and subscribe to ONLY this tab's document (not the whole `documents` map).
  const {
    activeTool,
    addShape, updateShape,
    strokeColor, strokeWidth, activeDash,
    setSelectedShapeIds,
    pushToHistory, deleteShapes,
    isScaleMode,
    setPageNum,
    setNumPages,
    brushThickness,
    showGuides, snapEnabled,
    selectedGuideId, setSelectedGuideId, guideSelectionEnabled, snapSensitivity,
    masterPages: storeMasterPages,
    centerSnapEnabled,
  } = useStore(useShallow((s) => ({
    activeTool: s.activeTool,
    addShape: s.addShape, updateShape: s.updateShape,
    strokeColor: s.strokeColor, strokeWidth: s.strokeWidth, activeDash: s.activeDash,
    setSelectedShapeIds: s.setSelectedShapeIds,
    pushToHistory: s.pushToHistory, deleteShapes: s.deleteShapes,
    isScaleMode: s.isScaleMode,
    setPageNum: s.setPageNum,
    setNumPages: s.setNumPages,
    brushThickness: s.brushThickness,
    showGuides: s.showGuides, snapEnabled: s.snapEnabled,
    selectedGuideId: s.selectedGuideId, setSelectedGuideId: s.setSelectedGuideId,
    guideSelectionEnabled: s.guideSelectionEnabled, snapSensitivity: s.snapSensitivity,
    masterPages: s.masterPages,
    centerSnapEnabled: s.centerSnapEnabled,
  })));

  const doc = useStore((s) => s.documents[tabId]);
  const masterPages = doc?.masterPages || storeMasterPages || [];
  const shapes = doc?.shapes || [];
  const selectedShapeIds = doc?.selectedShapeIds || [];
  const scale = doc?.scale || 1.0;
  const scaleCalibration = doc?.scaleCalibration || 1.0;
  const layersVisible = doc?.layersVisible || { base: true, active: true, chest: true };
  const pageNum = doc?.pageNum || 1;
  const panOffset = doc?.panOffset || { x: 0, y: 0 };

  // ── Spread layout ────────────────────────────────────────────────────────
  const isMasterTab = tabId.startsWith('__master__');
  const masterId = isMasterTab ? tabId.substring('__master__'.length) : '';
  const currentMaster = isMasterTab ? masterPages.find(m => m.id === masterId) : null;
  const isBlankMaster = isMasterTab && currentMaster && !currentMaster.backgroundPdfBytes;

  const isSpread = doc?.isSpread || false;
  const hasFrontCover = doc?.hasFrontCover || false;
  const hasBackCover = doc?.hasBackCover || false;
  const activeSpreadIndex = doc?.activeSpreadIndex || 0;
  const numPages = doc?.numPages || 0;

  // Page pairing — mirrors LeftSidePanel and RightSidePanel getSpreads logic
  const activeSpreads = getSpreads(numPages, hasFrontCover, hasBackCover);
  const currentSpread = activeSpreads[activeSpreadIndex] || null;
  const spreadLeftPage = isSpread && currentSpread ? currentSpread.pages[0] : pageNum;
  const spreadRightPage = isSpread && currentSpread && currentSpread.pages.length > 1 ? currentSpread.pages[1] : -1;
  // True when the current spread actually has a right page
  const spreadHasRight = isSpread && (isMasterTab ? true : (spreadRightPage > 0 && spreadRightPage <= numPages));
  const bleedOffset = doc?.bleedOffset ?? 0;
  const showBleedGuides = doc?.showBleedGuides ?? true;

  const guides = doc?.guides || [];

  const getEffectiveGuides = (): Guide[] => {
    if (!doc) return [];
    const docGuides = doc.guides || [];
    if (isMasterTab) return docGuides;

    const masterGuides: Guide[] = [];
    const assignments = doc.masterPageAssignments || {};
    const currentMasterPages = doc.masterPages || storeMasterPages || [];

    const documentPageWidth = pdfNativeSizeRef.current?.w || 612;
    const documentPageHeight = pdfNativeSizeRef.current?.h || 792;

    const addMasterGuides = (masterId: string | null, isRightSide: boolean) => {
      const master = masterId ? currentMasterPages.find(m => m.id === masterId) : null;
      if (!master || !master.guides) return;

      const offsetX = (documentPageWidth - master.pageWidth) / 2;
      const offsetY = (documentPageHeight - master.pageHeight) / 2;
      const docRightPageOffset = documentPageWidth; // Adjacent pages, no gap

      master.guides.forEach(g => {
        let isIncluded = false;
        let finalPos = g.position;

        if (master.isSpread) {
          if (isRightSide) {
            if (g.orientation === 'vertical' && g.position >= master.pageWidth) {
              isIncluded = true;
              finalPos = g.position - master.pageWidth + docRightPageOffset + offsetX;
            } else if (g.orientation === 'horizontal') {
              isIncluded = true;
              finalPos = g.position + offsetY;
            }
          } else {
            if (g.orientation === 'vertical' && g.position < master.pageWidth) {
              isIncluded = true;
              finalPos = g.position + offsetX;
            } else if (g.orientation === 'horizontal') {
              isIncluded = true;
              finalPos = g.position + offsetY;
            }
          }
        } else {
          isIncluded = true;
          if (g.orientation === 'vertical') {
            finalPos = g.position + (isRightSide ? docRightPageOffset + offsetX : offsetX);
          } else {
            finalPos = g.position + offsetY;
          }
        }

        if (isIncluded) {
          masterGuides.push({
            id: `master-${master.id}-${g.id}`,
            orientation: g.orientation,
            position: finalPos,
          });
        }
      });
    };

    // Left page (or single page)
    const leftMasterId = assignments[spreadLeftPage] ?? null;
    addMasterGuides(leftMasterId, false);

    // Right page (if spread active)
    if (isSpread && spreadHasRight) {
      const rightMasterId = assignments[spreadRightPage] ?? null;
      addMasterGuides(rightMasterId, true);
    }

    // ── Virtual centre guides (injected when Centre Snap is on) ──────────────
    // These are not persisted; they live only in the effective-guides list
    // so that every snap code-path (drag, draw, Transformer) sees them.
    const liveCenterSnap = useStore.getState().centerSnapEnabled;
    if (liveCenterSnap) {
      const pageW = documentPageWidth;
      const pageH = documentPageHeight;

      // Horizontal centre (same for every page/side)
      const hCentreId = '__centre-h__';
      if (!docGuides.some(g => g.id === hCentreId) && !masterGuides.some(g => g.id === hCentreId)) {
        masterGuides.push({ id: hCentreId, orientation: 'horizontal', position: pageH / 2 });
      }

      // Vertical centre of left page (or single page)
      const vCentreLeftId = '__centre-v-left__';
      if (!docGuides.some(g => g.id === vCentreLeftId) && !masterGuides.some(g => g.id === vCentreLeftId)) {
        masterGuides.push({ id: vCentreLeftId, orientation: 'vertical', position: pageW / 2 });
      }

      // Vertical centre of right page (spread only)
      if (isSpread && spreadHasRight) {
        const vCentreRightId = '__centre-v-right__';
        if (!docGuides.some(g => g.id === vCentreRightId) && !masterGuides.some(g => g.id === vCentreRightId)) {
          masterGuides.push({ id: vCentreRightId, orientation: 'vertical', position: pageW + pageW / 2 });
        }

        // Centre of the FULL spread (left-edge to right-edge) = spine at x=pageW
        const vCentreSpreadId = '__centre-v-spread__';
        if (!docGuides.some(g => g.id === vCentreSpreadId) && !masterGuides.some(g => g.id === vCentreSpreadId)) {
          masterGuides.push({ id: vCentreSpreadId, orientation: 'vertical', position: pageW });
        }
      }
    }

    return [...docGuides, ...masterGuides];
  };

  const getSnappedCanvasPos = (pos: { x: number; y: number }) => {
    const stage = stageRef.current;
    if (!stage) return pos;
    const liveGuides = getEffectiveGuides();
    const liveSnap = useStore.getState().snapEnabled;
    const liveSens = useStore.getState().snapSensitivity;
    if (!liveSnap || liveGuides.length === 0) return pos;

    const canvasX = (pos.x - stage.x()) / scale;
    const canvasY = (pos.y - stage.y()) / scale;
    const snapX = calculateSnap(canvasX, liveGuides, 'vertical',   scale, liveSnap, liveSens);
    const snapY = calculateSnap(canvasY, liveGuides, 'horizontal', scale, liveSnap, liveSens);
    return { x: snapX * scale + stage.x(), y: snapY * scale + stage.y() };
  };

  const updateHandlesPosition = (id: string, dx: number, dy: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    const s = shapes.find(x => x.id === id);
    if (s) {
      // 1. Vertex handles
      if (s.points) {
        for (let i = 0; i < s.points.length; i += 2) {
          const h = stage.findOne(`#vertex-handle-${id}-${i}`);
          if (h) {
            const ix = h.getAttr('dragInitialX');
            const iy = h.getAttr('dragInitialY');
            if (ix !== undefined && iy !== undefined) {
              h.x(ix + dx);
              h.y(iy + dy);
            }
          }
        }
      }
      // 2. Callout handles
      if (s.type === 'callout') {
        ['box', 'width', 'height', 'corner'].forEach(suffix => {
          const h = stage.findOne(`#callout-handle-${id}-${suffix}`);
          if (h) {
            const ix = h.getAttr('dragInitialX');
            const iy = h.getAttr('dragInitialY');
            if (ix !== undefined && iy !== undefined) {
              h.x(ix + dx);
              h.y(iy + dy);
            }
          }
        });
      }
      // 3. Arrow/Spline text handles
      if (['arrow', 'spline'].includes(s.type)) {
        ['width', 'height', 'corner'].forEach(suffix => {
          const h = stage.findOne(`#arrow-text-handle-${id}-${suffix}`);
          if (h) {
            const ix = h.getAttr('dragInitialX');
            const iy = h.getAttr('dragInitialY');
            if (ix !== undefined && iy !== undefined) {
              h.x(ix + dx);
              h.y(iy + dy);
            }
          }
        });
      }
    }
  };

  const updateChildCallouts = (parentId: string, dx: number, dy: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    shapes.forEach(child => {
      if (child.type === 'callout' && child.parentId === parentId) {
        const childNode = stage.findOne(`#shape-${child.id}`);
        if (childNode) {
          const ix = childNode.getAttr('dragInitialX');
          const iy = childNode.getAttr('dragInitialY');
          if (ix !== undefined && iy !== undefined) {
            childNode.x(ix + dx);
            childNode.y(iy + dy);
          }
        }
        ['box', 'width', 'height', 'corner'].forEach(suffix => {
          const h = stage.findOne(`#callout-handle-${child.id}-${suffix}`);
          if (h) {
            const ix = h.getAttr('dragInitialX');
            const iy = h.getAttr('dragInitialY');
            if (ix !== undefined && iy !== undefined) {
              h.x(ix + dx);
              h.y(iy + dy);
            }
          }
        });
      }
    });
  };

  const getVectorSnap = (
    stageX: number,
    stageY: number
  ) => {
    const liveSnap = useStore.getState().vectorSnapEnabled;
    if (!liveSnap) return null;

    const liveSens = useStore.getState().snapSensitivity;
    const searchRadiusPage = liveSens / scale;

    const pdfPageW = pdfNativeSizeRef.current?.w ?? 0;
    const spineGap = 0; // Adjacent pages, no gap
    const onRightPage = !isMasterTab && spreadHasRight && isSpread && pdfPageW > 0 && stageX >= pdfPageW + spineGap;
    const pageOfCoord = isSpread ? (onRightPage ? spreadRightPage : spreadLeftPage) : pageNum;
    
    const pageX = onRightPage ? stageX - pdfPageW - spineGap : stageX;
    const pageY = stageY;

    const pageGridIndex = pageGridIndicesRef.current[pageOfCoord];
    if (!pageGridIndex) return null;

    const nearbySegments = pageGridIndex.query(pageX, pageY, searchRadiusPage);
    if (nearbySegments.length === 0) return null;

    let bestSnap: { x: number; y: number; type: 'endpoint' | 'midpoint' | 'nearest'; distance: number } | null = null;

    const checkSnapCandidate = (cx: number, cy: number, type: 'endpoint' | 'midpoint' | 'nearest', isNearest = false) => {
      const dx = cx - pageX;
      const dy = cy - pageY;
      const distScreen = Math.sqrt(dx * dx + dy * dy) * scale;
      if (distScreen <= liveSens) {
        const compareDist = isNearest ? distScreen * 1.5 : distScreen;
        if (!bestSnap || compareDist < bestSnap.distance) {
          bestSnap = { x: cx, y: cy, type, distance: compareDist };
        }
      }
    };

    for (const seg of nearbySegments) {
      checkSnapCandidate(seg.start.x, seg.start.y, 'endpoint');
      checkSnapCandidate(seg.end.x, seg.end.y, 'endpoint');
      checkSnapCandidate(seg.mid.x, seg.mid.y, 'midpoint');

      const nearest = getNearestPointOnSegment({ x: pageX, y: pageY }, seg.start, seg.end);
      checkSnapCandidate(nearest.x, nearest.y, 'nearest', true);
    }

    if (bestSnap) {
      const snappedStageX = onRightPage ? (bestSnap as any).x + pdfPageW + spineGap : (bestSnap as any).x;
      const snappedStageY = (bestSnap as any).y;
      return {
        type: (bestSnap as any).type,
        x: snappedStageX,
        y: snappedStageY,
        pageX: (bestSnap as any).x,
        pageY: (bestSnap as any).y,
        page: pageOfCoord,
      };
    }

    return null;
  };

  const getParallelSnap = (
    stageX: number,
    stageY: number,
    excludeShapeId: string,
    currentRotation: number
  ) => {
    const liveSnap = useStore.getState().snapEnabled;
    if (!liveSnap) return null;

    const liveSens = useStore.getState().snapSensitivity;

    const pdfPageW = pdfNativeSizeRef.current?.w ?? 0;
    const spineGap = 0; // Adjacent pages, no gap
    const onRightPage = !isMasterTab && spreadHasRight && isSpread && pdfPageW > 0 && stageX >= pdfPageW + spineGap;
    const pageOfCoord = isSpread ? (onRightPage ? spreadRightPage : spreadLeftPage) : pageNum;

    const pageX = onRightPage ? stageX - pdfPageW - spineGap : stageX;
    const pageY = stageY;

    // 1. Gather all line segments from PDF CAD vectors
    const cadSegments = pageVectorsRef.current[pageOfCoord] || [];

    // 2. Gather line segments from other markup shapes
    const markupSegments: VectorSegment[] = [];
    shapes.forEach(s => {
      if (s.id === excludeShapeId) return;
      if (!isMasterTab && s.page !== pageOfCoord) return;

      if (POINT_BASED_TYPES.includes(s.type)) {
        if (!s.points || s.points.length < 4) return;
        for (let i = 0; i < s.points.length - 2; i += 2) {
          markupSegments.push({
            start: { x: s.points[i], y: s.points[i+1] },
            end: { x: s.points[i+2], y: s.points[i+3] },
            mid: { x: (s.points[i] + s.points[i+2]) / 2, y: (s.points[i+1] + s.points[i+3]) / 2 }
          });
        }
        if ((s.closed || s.type === 'polygon' || s.type === 'measure_area') && s.points.length >= 6) {
          const len = s.points.length;
          markupSegments.push({
            start: { x: s.points[len-2], y: s.points[len-1] },
            end: { x: s.points[0], y: s.points[1] },
            mid: { x: (s.points[len-2] + s.points[0]) / 2, y: (s.points[len-1] + s.points[1]) / 2 }
          });
        }
      } else {
        const w = s.width || 0;
        const h = s.height || 0;
        if (w === 0 && h === 0) return;

        const rot = (s.rotation || 0) * Math.PI / 180;
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);

        // Calculate global corners of the shape
        const corners = [
          { x: s.x, y: s.y },
          { x: s.x + w * cos, y: s.y + w * sin },
          { x: s.x + w * cos - h * sin, y: s.y + w * sin + h * cos },
          { x: s.x - h * sin, y: s.y + h * cos }
        ];

        for (let i = 0; i < 4; i++) {
          const next = (i + 1) % 4;
          markupSegments.push({
            start: corners[i],
            end: corners[next],
            mid: { x: (corners[i].x + corners[next].x) / 2, y: (corners[i].y + corners[next].y) / 2 }
          });
        }
      }
    });

    const allSegments = [...cadSegments, ...markupSegments];
    if (allSegments.length === 0) return null;

    let bestSnap: {
      x: number;
      y: number;
      segment: VectorSegment;
      distance: number;
    } | null = null;

    for (const seg of allSegments) {
      const nearest = getNearestPointOnSegment({ x: pageX, y: pageY }, seg.start, seg.end);
      const distScreen = nearest.dist * scale;
      if (distScreen <= liveSens) {
        if (!bestSnap || distScreen < bestSnap.distance) {
          bestSnap = {
            x: nearest.x,
            y: nearest.y,
            segment: seg,
            distance: distScreen
          };
        }
      }
    }

    if (bestSnap) {
      const snappedStageX = onRightPage ? bestSnap.x + pdfPageW + spineGap : bestSnap.x;
      const snappedStageY = bestSnap.y;

      const seg = bestSnap.segment;
      const dx = seg.end.x - seg.start.x;
      const dy = seg.end.y - seg.start.y;
      const angleRad = Math.atan2(dy, dx);
      const angleDeg = (angleRad * 180 / Math.PI);

      // Candidate angles: parallel/perpendicular to the line
      const candidates = [angleDeg, angleDeg + 90, angleDeg + 180, angleDeg - 90];
      let bestAngle = currentRotation;
      let minDiff = Infinity;

      for (const cand of candidates) {
        // Normalize difference between cand and currentRotation to [-180, 180]
        let diff = (cand - currentRotation) % 360;
        if (diff > 180) diff -= 360;
        if (diff < -180) diff += 360;

        if (Math.abs(diff) < minDiff) {
          minDiff = Math.abs(diff);
          // Keep best angle within [0, 360) range or let Konva handle it
          bestAngle = (cand + 360) % 360;
        }
      }

      return {
        x: snappedStageX,
        y: snappedStageY,
        rotation: bestAngle,
        segment: {
          start: {
            x: onRightPage ? seg.start.x + pdfPageW + spineGap : seg.start.x,
            y: seg.start.y
          },
          end: {
            x: onRightPage ? seg.end.x + pdfPageW + spineGap : seg.end.x,
            y: seg.end.y
          },
          mid: {
            x: onRightPage ? seg.mid.x + pdfPageW + spineGap : seg.mid.x,
            y: seg.mid.y
          }
        }
      };
    }

    return null;
  };

  const getParallelSnapForDrawing = (
    originX: number,
    originY: number,
    mouseX: number,
    mouseY: number,
    excludeShapeId: string
  ) => {
    const liveSnap = useStore.getState().snapEnabled;
    if (!liveSnap) return null;

    const liveSens = useStore.getState().snapSensitivity;

    const pdfPageW = pdfNativeSizeRef.current?.w ?? 0;
    const spineGap = 0; // Adjacent pages, no gap
    const onRightPage = !isMasterTab && spreadHasRight && isSpread && pdfPageW > 0 && mouseX >= pdfPageW + spineGap;
    const pageOfCoord = isSpread ? (onRightPage ? spreadRightPage : spreadLeftPage) : pageNum;

    const pageX = onRightPage ? mouseX - pdfPageW - spineGap : mouseX;
    const pageY = mouseY;

    // 1. Gather all line segments from PDF CAD vectors
    const cadSegments = pageVectorsRef.current[pageOfCoord] || [];

    // 2. Gather line segments from other markup shapes
    const markupSegments: VectorSegment[] = [];
    shapes.forEach(s => {
      if (s.id === excludeShapeId) return;
      if (!isMasterTab && s.page !== pageOfCoord) return;

      if (POINT_BASED_TYPES.includes(s.type)) {
        if (!s.points || s.points.length < 4) return;
        for (let i = 0; i < s.points.length - 2; i += 2) {
          markupSegments.push({
            start: { x: s.points[i], y: s.points[i+1] },
            end: { x: s.points[i+2], y: s.points[i+3] },
            mid: { x: (s.points[i] + s.points[i+2]) / 2, y: (s.points[i+1] + s.points[i+3]) / 2 }
          });
        }
        if ((s.closed || s.type === 'polygon' || s.type === 'measure_area') && s.points.length >= 6) {
          const len = s.points.length;
          markupSegments.push({
            start: { x: s.points[len-2], y: s.points[len-1] },
            end: { x: s.points[0], y: s.points[1] },
            mid: { x: (s.points[len-2] + s.points[0]) / 2, y: (s.points[len-1] + s.points[1]) / 2 }
          });
        }
      } else {
        const w = s.width || 0;
        const h = s.height || 0;
        if (w === 0 && h === 0) return;

        const rot = (s.rotation || 0) * Math.PI / 180;
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);

        // Calculate global corners of the shape
        const corners = [
          { x: s.x, y: s.y },
          { x: s.x + w * cos, y: s.y + w * sin },
          { x: s.x + w * cos - h * sin, y: s.y + w * sin + h * cos },
          { x: s.x - h * sin, y: s.y + h * cos }
        ];

        for (let i = 0; i < 4; i++) {
          const next = (i + 1) % 4;
          markupSegments.push({
            start: corners[i],
            end: corners[next],
            mid: { x: (corners[i].x + corners[next].x) / 2, y: (corners[i].y + corners[next].y) / 2 }
          });
        }
      }
    });

    const allSegments = [...cadSegments, ...markupSegments];
    if (allSegments.length === 0) return null;

    let bestSnap: {
      x: number;
      y: number;
      segment: VectorSegment;
      distance: number;
      angle: number;
    } | null = null;

    const dxMouse = pageX - originX;
    const dyMouse = pageY - originY;
    const mouseAngle = Math.atan2(dyMouse, dxMouse);

    for (const seg of allSegments) {
      const segAngle = Math.atan2(seg.end.y - seg.start.y, seg.end.x - seg.start.x);

      // Candidate angles: parallel (0, PI) or perpendicular (PI/2, -PI/2) to the segment
      const candidates = [segAngle, segAngle + Math.PI / 2, segAngle + Math.PI, segAngle - Math.PI / 2];
      let bestCandAngle = mouseAngle;
      let minDiff = Infinity;

      for (const cand of candidates) {
        let diff = (cand - mouseAngle) % (Math.PI * 2);
        if (diff > Math.PI) diff -= Math.PI * 2;
        if (diff < -Math.PI) diff += Math.PI * 2;

        if (Math.abs(diff) < minDiff) {
          minDiff = Math.abs(diff);
          bestCandAngle = cand;
        }
      }

      // Check if mouse angle is close to this candidate (threshold: 15 degrees = 0.26 radians)
      if (minDiff <= 0.26) {
        // Calculate perpendicular distance to the segment
        const nearest = getNearestPointOnSegment({ x: pageX, y: pageY }, seg.start, seg.end);
        const distScreen = nearest.dist * scale;

        if (distScreen <= liveSens) {
          // Project mouse position onto the line passing through originX, originY with angle bestCandAngle
          const L = Math.sqrt(dxMouse * dxMouse + dyMouse * dyMouse);
          const snappedPageX = originX + L * Math.cos(bestCandAngle);
          const snappedPageY = originY + L * Math.sin(bestCandAngle);

          // Snapping is prioritized for segments closest to the mouse cursor
          if (!bestSnap || distScreen < bestSnap.distance) {
            bestSnap = {
              x: onRightPage ? snappedPageX + pdfPageW + spineGap : snappedPageX,
              y: snappedPageY,
              segment: seg,
              distance: distScreen,
              angle: bestCandAngle
            };
          }
        }
      }
    }

    if (bestSnap) {
      const seg = bestSnap.segment;
      return {
        x: bestSnap.x,
        y: bestSnap.y,
        segment: {
          start: {
            x: onRightPage ? seg.start.x + pdfPageW + spineGap : seg.start.x,
            y: seg.start.y
          },
          end: {
            x: onRightPage ? seg.end.x + pdfPageW + spineGap : seg.end.x,
            y: seg.end.y
          },
          mid: {
            x: onRightPage ? seg.mid.x + pdfPageW + spineGap : seg.mid.x,
            y: seg.mid.y
          }
        }
      };
    }

    return null;
  };

  const getManualGuidesSnap = (
    dx: number,
    dy: number,
    selectedIds: string[]
  ) => {
    const stage = stageRef.current;
    if (!stage) return null;
    const liveGuides = getEffectiveGuides();
    const liveSnap = useStore.getState().snapEnabled;
    const liveSens = useStore.getState().snapSensitivity;
    if (!liveSnap || liveGuides.length === 0) return null;

    let selMinX = Infinity, selMaxX = -Infinity;
    let selMinY = Infinity, selMaxY = -Infinity;

    selectedIds.forEach(id => {
      const s = shapes.find(x => x.id === id);
      if (!s) return;
      const otherOffsetX = (!isMasterTab && spreadHasRight && isSpread && s.page === spreadRightPage && pdfNativeSizeRef.current)
        ? pdfNativeSizeRef.current.w
        : 0;
      const aabb = getShapeAABB(s, s.x + otherOffsetX, s.y, s.rotation || 0);
      if (aabb.minX < selMinX) selMinX = aabb.minX;
      if (aabb.maxX > selMaxX) selMaxX = aabb.maxX;
      if (aabb.minY < selMinY) selMinY = aabb.minY;
      if (aabb.maxY > selMaxY) selMaxY = aabb.maxY;
    });

    if (selMinX === Infinity) return null;

    const w = selMaxX - selMinX;
    const h = selMaxY - selMinY;

    const canvasX = selMinX + dx;
    const canvasY = selMinY + dy;
    const SNAP_THRESH = liveSens / scale;

    let bestXOffset = 0;
    let minDiffX = SNAP_THRESH;
    let activeVGuide: number | null = null;
    liveGuides.filter(g => g.orientation === 'vertical').forEach(g => {
      [canvasX, canvasX + w, canvasX + w / 2].forEach(edge => {
        const diff = Math.abs(edge - g.position);
        if (diff < minDiffX) {
          minDiffX = diff;
          bestXOffset = g.position - edge;
          activeVGuide = g.position;
        }
      });
    });

    let bestYOffset = 0;
    let minDiffY = SNAP_THRESH;
    let activeHGuide: number | null = null;
    liveGuides.filter(g => g.orientation === 'horizontal').forEach(g => {
      [canvasY, canvasY + h, canvasY + h / 2].forEach(edge => {
        const diff = Math.abs(edge - g.position);
        if (diff < minDiffY) {
          minDiffY = diff;
          bestYOffset = g.position - edge;
          activeHGuide = g.position;
        }
      });
    });

    if (activeVGuide !== null || activeHGuide !== null) {
      return {
        dx: dx + bestXOffset,
        dy: dy + bestYOffset,
        vertical: activeVGuide,
        horizontal: activeHGuide
      };
    }
    return null;
  };

  const getSmartGuidesSnap = (
    dx: number,
    dy: number,
    selectedIds: string[],
    pageOfShape: number
  ) => {
    const liveSnap = useStore.getState().snapEnabled;
    if (!liveSnap) return null;

    const liveSens = useStore.getState().snapSensitivity;
    const limitDiff = liveSens / scale;

    let bestXOffset = 0;
    let minDiffX = limitDiff;
    let activeVGuide: number | null = null;

    let bestYOffset = 0;
    let minDiffY = limitDiff;
    let activeHGuide: number | null = null;

    // 1. Calculate selection AABB at shifted position
    let selMinX = Infinity, selMaxX = -Infinity;
    let selMinY = Infinity, selMaxY = -Infinity;

    selectedIds.forEach(id => {
      const s = shapes.find(x => x.id === id);
      if (!s) return;
      const otherOffsetX = (!isMasterTab && spreadHasRight && isSpread && s.page === spreadRightPage && pdfNativeSizeRef.current)
        ? pdfNativeSizeRef.current.w
        : 0;
      const aabb = getShapeAABB(s, s.x + otherOffsetX, s.y, s.rotation || 0);
      if (aabb.minX < selMinX) selMinX = aabb.minX;
      if (aabb.maxX > selMaxX) selMaxX = aabb.maxX;
      if (aabb.minY < selMinY) selMinY = aabb.minY;
      if (aabb.maxY > selMaxY) selMaxY = aabb.maxY;
    });

    if (selMinX === Infinity) return null;

    const shiftedSel = {
      minX: selMinX + dx,
      maxX: selMaxX + dx,
      centerX: (selMinX + selMaxX) / 2 + dx,
      minY: selMinY + dy,
      maxY: selMaxY + dy,
      centerY: (selMinY + selMaxY) / 2 + dy
    };

    // 2. Iterate non-selected shapes
    shapes.forEach(s => {
      if (selectedIds.includes(s.id)) return;
      if (!isMasterTab && s.page !== pageOfShape) return;

      const otherOffsetX = (!isMasterTab && spreadHasRight && isSpread && s.page === spreadRightPage && pdfNativeSizeRef.current)
        ? pdfNativeSizeRef.current.w
        : 0;

      const otherAABB = getShapeAABB(s, s.x + otherOffsetX, s.y, s.rotation || 0);

      // X-snapping (Vertical guides)
      const srcX = [shiftedSel.minX, shiftedSel.maxX, shiftedSel.centerX];
      const tgtX = [otherAABB.minX, otherAABB.maxX, otherAABB.centerX];

      srcX.forEach(src => {
        tgtX.forEach(tgt => {
          const diff = Math.abs(tgt - src);
          if (diff < minDiffX) {
            minDiffX = diff;
            bestXOffset = tgt - src;
            activeVGuide = tgt;
          }
        });
      });

      // Y-snapping (Horizontal guides)
      const srcY = [shiftedSel.minY, shiftedSel.maxY, shiftedSel.centerY];
      const tgtY = [otherAABB.minY, otherAABB.maxY, otherAABB.centerY];

      srcY.forEach(src => {
        tgtY.forEach(tgt => {
          const diff = Math.abs(tgt - src);
          if (diff < minDiffY) {
            minDiffY = diff;
            bestYOffset = tgt - src;
            activeHGuide = tgt;
          }
        });
      });
    });

    if (activeVGuide !== null || activeHGuide !== null) {
      return {
        dx: dx + bestXOffset,
        dy: dy + bestYOffset,
        vertical: activeVGuide,
        horizontal: activeHGuide
      };
    }

    return null;
  };

  const handleImageDrop = (url: string, clientX: number, clientY: number) => {
    tauriLog("handleImageDrop starting: clientX=" + clientX + " clientY=" + clientY + " urlLength=" + url.length);
    const ws = workspaceRef.current;
    if (!ws) { tauriLog("workspaceRef is null"); return; }
    const wrapper = ws.querySelector('.canvas-wrapper');
    if (!wrapper) { tauriLog("canvas-wrapper not found"); return; }
    const rect = wrapper.getBoundingClientRect();
    tauriLog("wrapper rect: left=" + rect.left + " top=" + rect.top + " width=" + rect.width + " height=" + rect.height);

    const state = useStore.getState();
    const aid = state.activeTabId;
    if (!aid || !state.documents[aid]) { tauriLog("no active tab or doc: aid=" + aid); return; }
    const docState = state.documents[aid];

    const currentScale = docState.scale || 1;
    const currentPanOffset = docState.panOffset || { x: 0, y: 0 };
    const stageX = (clientX - rect.left - currentPanOffset.x) / currentScale;
    const stageY = (clientY - rect.top - currentPanOffset.y) / currentScale;
    tauriLog("calculated stage coords: stageX=" + stageX + " stageY=" + stageY + " scale=" + currentScale + " pan=" + JSON.stringify(currentPanOffset));

    let targetPage = docState.pageNum || 1;
    let localX = stageX;
    let localY = stageY;
    if (docState.isSpread && pdfNativeSizeRef.current) {
      const pageWidth = pdfNativeSizeRef.current.w;
      const gap = 4; // gap is a constant 4 points, zoom-independent in stage units
      const hasCoverPage = docState.hasFrontCover || false;
      const hasBackCover = docState.hasBackCover || false;
      const activeSpreadIndex = docState.activeSpreadIndex || 0;
      const numPages = docState.numPages || 0;
      
      const activeSpreads = getSpreads(numPages, hasCoverPage, hasBackCover);
      const currentSpread = activeSpreads[activeSpreadIndex] || null;
      const leftPage = currentSpread ? currentSpread.pages[0] : (docState.pageNum || 1);
      const rightPage = currentSpread && currentSpread.pages.length > 1 ? currentSpread.pages[1] : -1;
      const hasRight = rightPage > 0 && rightPage <= numPages;

      const onRightPage = !isMasterTab && hasRight && pageWidth > 0 && stageX >= pageWidth + gap;
      tauriLog("spread calculation: pageWidth=" + pageWidth + " gap=" + gap + " leftPage=" + leftPage + " rightPage=" + rightPage + " onRightPage=" + onRightPage);
      if (onRightPage) {
        targetPage = rightPage;
        localX = stageX - pageWidth - gap;
      } else {
        targetPage = leftPage;
      }
    }

    tauriLog("final page-relative coords: targetPage=" + targetPage + " localX=" + localX + " localY=" + localY);

    const hitBox = docState.shapes.find(s => {
      const match = s.type === 'content_box' &&
        s.page === targetPage &&
        localX >= s.x && localX <= s.x + (s.width || 0) &&
        localY >= s.y && localY <= s.y + (s.height || 0);
      return match;
    });

    tauriLog("hitBox check: found=" + (hitBox ? JSON.stringify({ id: hitBox.id, x: hitBox.x, y: hitBox.y, w: hitBox.width, h: hitBox.height }) : "none"));
    tauriLog("all content_boxes on page " + targetPage + ": " + JSON.stringify(
      docState.shapes.filter(s => s.type === 'content_box' && s.page === targetPage).map(s => ({ id: s.id, x: s.x, y: s.y, w: s.width, h: s.height }))
    ));

    const img = new window.Image();
    img.onload = () => {
      tauriLog("image loaded: naturalWidth=" + img.naturalWidth + " naturalHeight=" + img.naturalHeight);
      state.pushToHistory();
      if (hitBox) {
        const fw = hitBox.width || 200;
        const fh = hitBox.height || 200;
        const ratio = Math.min(fw / img.naturalWidth, fh / img.naturalHeight);
        const iw = img.naturalWidth  * ratio;
        const ih = img.naturalHeight * ratio;
        const ix = (fw - iw) / 2;
        const iy = (fh - ih) / 2;
        tauriLog("updating content box with image asset");
        state.updateShape(hitBox.id, {
          assetUrl: url,
          assetTransform: { x: ix, y: iy, width: iw, height: ih },
        });
      } else {
        const maxDim = 600;
        const ratio2 = Math.min(maxDim / img.naturalWidth, maxDim / img.naturalHeight, 1);
        const fw = (img.naturalWidth  * ratio2) / currentScale;
        const fh = (img.naturalHeight * ratio2) / currentScale;
        tauriLog("adding content box frame with image asset to canvas at: x=" + (localX - fw/2) + " y=" + (localY - fh/2));
        state.addShape({
          id: Math.random().toString(36).substring(7),
          type: 'content_box',
          x: localX - fw / 2,
          y: localY - fh / 2,
          width: fw,
          height: fh,
          strokeColor: 'transparent',
          strokeWidth: 0,
          page: targetPage,
          author: 'User',
          date: new Date().toLocaleDateString(),
          assetUrl: url,
          assetTransform: { x: 0, y: 0, width: fw, height: fh },
          contentMode: 'frame',
        } as any);
      }
      if (!state.customAssets.includes(url)) {
        state.addCustomAsset(url);
      }
    };
    img.src = url;
  };

  // Clear parallel & smart snapping guide lines when drawing/dragging completes
  useEffect(() => {
    if (!isDrawingRef.current && !dragStartMouseOffsetRef.current) {
      if (parallelSnapGuide) setParallelSnapGuide(null);
      if (smartGuides.vertical !== null || smartGuides.horizontal !== null) {
        setSmartGuides({ vertical: null, horizontal: null });
      }
    }
  });

  // ── Effect: derive pdfDoc from pdfBytes ─────────────────────────────────────
  // Runs whenever pdfBytes changes (new file opened, page inserted/deleted,
  // pristine attachment extracted). For inactive tabs the effect still runs so
  // the tab's pdfDoc is ready when the user switches to it.

  useEffect(() => {
    if (!pdfBytes) { setPdfDoc(null); return; }

    let cancelled = false;
    // Store bytes are immutable (replaced, never mutated) so no defensive copy is
    // needed here; consumers that hand bytes out (getRawPdfBytes) copy on demand.
    pdfBytesRef.current = pdfBytes;

    // Expose bytes globally so TopCommandCenter's save pipeline can read them
    // without an imperative ref tunnel.  Only the ACTIVE viewer's bytes should
    // be exposed at any given time.
    if (isActive) {
      (window as any).getRawPdfBytes = () =>
        new Uint8Array(pdfBytesRef.current!.slice(0));
    }

    const loadPdf = async () => {
      try {
        const pdf = await acquirePdfDoc(pdfBytes);
        if (cancelled) return;

        // ── Embedded-markup extraction (round-trip editability) ──────────────
        try {
          const metadata = await pdf.getMetadata();
          if (cancelled) return;
          const info = metadata?.info as any;
          if (info?.Subject?.startsWith('LAYERS_MARKUP_DATA:')) {
            try {
              const raw = JSON.parse(info.Subject.substring('LAYERS_MARKUP_DATA:'.length));
              const shapes = Array.isArray(raw) ? raw : (raw.shapes ?? []);
              const spreadConfig = raw.spreadConfig ?? null;
              const serializedMasterPages = raw.masterPages ?? null;
              const masterPages = serializedMasterPages ? deserializeMasterPages(serializedMasterPages) : null;
              const masterPageAssignments = raw.masterPageAssignments ?? null;
              const bleedConfig = raw.bleedConfig ?? null;

              if (raw.version === 2) {
                useStore.getState().loadDocumentData(
                  tabId,
                  shapes,
                  spreadConfig,
                  masterPages,
                  masterPageAssignments,
                  bleedConfig,
                  raw.guides
                );
              } else {
                if (Array.isArray(shapes)) useStore.getState().setShapes(shapes);
                if (spreadConfig?.isSpread) {
                  useStore.getState().setIsSpread(true);
                  if (spreadConfig.hasCoverPage) {
                    useStore.getState().setHasFrontCover(true);
                  }
                }
              }
            } catch { /* ignore malformed payload */ }
          }
        } catch { /* no metadata — fine */ }

        // ── Pristine attachment check ────────────────────────────────────────
        // If the file was saved by Layers it contains a LayersPristine.pdf
        // attachment (the unmodified original). Load that as the visual base.
        // We update pdfBytes in the store so the save pipeline uses the right
        // bytes, which also re-triggers this effect.  The pristine PDF itself
        // has no nested attachment so the chain terminates after one extra run.
        try {
          const attachments = await pdf.getAttachments();
          if (cancelled) return;
          if (attachments?.['LayersPristine.pdf']) {
            const pristineBytes = attachments['LayersPristine.pdf'].content;
            if (!cancelled) {
              // Updating the store re-triggers this effect with the pristine bytes.
              useStore.getState().setPdfBytes(pristineBytes);
            }
            return; // Let the re-trigger do the final setPdfDoc call.
          }
        } catch { /* no attachments — fine */ }

        if (!cancelled) {
          setPdfDoc(pdf);
          // Publish page-count to the store so TopCommandCenter can display "X of N".
          // Only the active viewer should write to shared root proxy fields.
          if (isActive) {
            setNumPages(pdf.numPages);
            const savedPage = useStore.getState().documents[tabId]?.pageNum || 1;
            setPageNum(Math.min(Math.max(1, savedPage), pdf.numPages));

            // ── Pristine A-Master Sync ─────────────────────────────────────
            // If A-Master has no shapes and no background PDF, dynamically
            // sync its page size and spread layout to match this document.
            try {
              const storeState = useStore.getState();
              const defaultMasterId = `master-a-${tabId}`;
              const docMasterPages = storeState.documents[tabId]?.masterPages || storeState.masterPages || [];
              const aMaster = docMasterPages.find(m => m.id === defaultMasterId);
              if (aMaster && aMaster.shapes.length === 0 && !aMaster.backgroundPdfBytes) {
                const page1 = await pdf.getPage(1);
                const vp1 = page1.getViewport({ scale: 1.0 });
                const docIsSpread = storeState.documents[tabId]?.isSpread || false;
                storeState.updateMasterPage(defaultMasterId, {
                  pageWidth: vp1.width,
                  pageHeight: vp1.height,
                  isSpread: docIsSpread,
                });
                // Also sync the master's virtual document tab
                const masterDoc = storeState.documents[`__master__${defaultMasterId}`];
                if (masterDoc) {
                  storeState.updateMasterPage(defaultMasterId, {});
                }
              }
            } catch { /* ignore errors during pristine sync */ }
          }
        }
      } catch (err) {
        console.error('DocumentViewer: PDF load error:', err);
      }
    };

    loadPdf();
    return () => { cancelled = true; releasePdfDoc(pdfBytes); };
    // isActive intentionally omitted — we want bytes to load eagerly even for
    // inactive tabs so the switch is instant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfBytes]);

  // ── Effect: load page CAD vectors for snapping ──────────────────────────────
  useEffect(() => {
    if (!pdfDoc || !isActive) return;

    const pagesToLoad = isSpread
      ? [Math.min(Math.max(1, spreadLeftPage), pdfDoc.numPages), spreadRightPage].filter(p => p > 0 && p <= pdfDoc.numPages)
      : [pageNum];

    pagesToLoad.forEach(async (p) => {
      if (pageVectorsRef.current[p] || vectorsLoading[p]) return;

      setVectorsLoading(prev => ({ ...prev, [p]: true }));

      try {
        const page = await pdfDoc.getPage(p);
        const vp1 = page.getViewport({ scale: 1.0 });
        const ops = await page.getOperatorList();
        const rawSegments = extractVectorsFromOps(ops);

        const segments = rawSegments.map(seg => {
          const [sx, sy] = vp1.convertToViewportPoint(seg.start.x, seg.start.y);
          const [ex, ey] = vp1.convertToViewportPoint(seg.end.x, seg.end.y);
          return {
            start: { x: sx, y: sy },
            end: { x: ex, y: ey },
            mid: { x: (sx + ex) / 2, y: (sy + ey) / 2 }
          };
        });

        pageVectorsRef.current[p] = segments;
        pageGridIndicesRef.current[p] = new GridSpatialIndex(segments);

        // Evict pages farther than 5 from current page to keep memory bounded
        Object.keys(pageVectorsRef.current).forEach((pageKey) => {
          const k = Number(pageKey);
          if (Math.abs(k - pageNum) > 5) {
            delete pageVectorsRef.current[k];
            delete pageGridIndicesRef.current[k];
          }
        });
        console.log(`[Vector Snapper] Page ${p} loaded: ${segments.length} vector segments extracted.`);
      } catch (err) {
        console.error(`Failed to load vector data for page ${p}:`, err);
      } finally {
        setVectorsLoading(prev => ({ ...prev, [p]: false }));
      }
    });
  }, [pdfDoc, pageNum, isSpread, spreadLeftPage, spreadRightPage, isActive]);

  // ── Effect: sync getRawPdfBytes and numPages when this tab becomes active ───
  useEffect(() => {
    if (!isActive) return;
    if (pdfBytesRef.current) {
      (window as any).getRawPdfBytes = () =>
        new Uint8Array(pdfBytesRef.current!.slice(0));
    }
    if (pdfDoc) setNumPages(pdfDoc.numPages);
  }, [isActive, pdfDoc, setNumPages]);

  // ── Effect: handle global mouse up to prevent brush resize getting stuck ────
  useEffect(() => {
    if (!isActive) return;
    const handleGlobalMouseUp = () => {
      isResizingBrushRef.current = false;
    };
    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
  }, [isActive]);

  // ── Effect: keep Stage dimensions in sync with the real window size ─────────
  // Fixes markup position drift after sleep/wake: Windows can change DPI while
  // the PC is asleep, resizing the window without triggering a React re-render.
  // Without this, Konva's pointer position formula uses the stale stage width
  // and silently scales all drawn coordinates by the wrong factor.
  useEffect(() => {
    const syncSize = () =>
      setStageSize({ width: window.innerWidth, height: window.innerHeight });

    // Ordinary window resize (user drags the window, monitor changes)
    window.addEventListener('resize', syncSize);

    // Wake from sleep: the browser fires visibilitychange when the screen
    // comes back on. Re-read innerWidth/Height at that moment.
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') syncSize();
    };
    document.addEventListener('visibilitychange', handleVisibility);

    // DPR change (display scaling change, e.g. 125 % → 150 %). Uses a
    // self-renewing matchMedia listener so it catches every subsequent change.
    let dprMq: MediaQueryList | null = null;
    const trackDpr = () => {
      syncSize();
      if (dprMq) dprMq.removeEventListener('change', trackDpr);
      dprMq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprMq.addEventListener('change', trackDpr);
    };
    trackDpr();

    return () => {
      window.removeEventListener('resize', syncSize);
      document.removeEventListener('visibilitychange', handleVisibility);
      dprMq?.removeEventListener('change', trackDpr);
    };
  }, []);

  // ── Effect: focus inline text editor when it opens ──────────────────────────
  useEffect(() => {
    if (inlineEditText) {
      const el = document.getElementById('inline-editor-textarea') as HTMLTextAreaElement;
      if (el) { el.focus(); el.select(); }
    }
  }, [inlineEditText?.id]);

  // ── Effect: deselect shapes on page change ──────────────────────────────────
  useEffect(() => {
    if (!isActive) return;
    setSelectedShapeIds([]);
  }, [pageNum, isActive, setSelectedShapeIds]);

  // ── Effect: wheel-to-zoom + scroll interaction flag ─────────────────────────
  useEffect(() => {
    if (!isActive || savingStatus) return;
    const ws = workspaceRef.current;
    if (!ws) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();

      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const state = useStore.getState();
      const oldScale = state.documents[tabId]?.scale || 1.0;
      const newScale = Math.max(0.1, Math.min(20, oldScale * factor));
      if (oldScale === newScale) return;

      // Measure mouse relative to canvas-wrapper — the panOffset origin.
      const canvasWrapper = ws.querySelector('.canvas-wrapper');
      const rect = (canvasWrapper ?? ws).getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // The canvas-space point under the cursor must not move after zoom.
      const oldPan = state.documents[tabId]?.panOffset || { x: 0, y: 0 };
      const canvasX = (mouseX - oldPan.x) / oldScale;
      const canvasY = (mouseY - oldPan.y) / oldScale;

      // New panOffset that keeps canvasX/Y pinned to the same screen pixel.
      const newPanX = mouseX - canvasX * newScale;
      const newPanY = mouseY - canvasY * newScale;

      // Atomic: scale + panOffset in one Zustand set → one React render.
      // Both setIsInteracting and zoomTo are in the same native event handler
      // so React 18 batches them into a single re-render — no stale intermediate.
      state.zoomTo(newScale, { x: newPanX, y: newPanY });
      setIsInteracting(true);
      if (interactionTimeoutRef.current) window.clearTimeout(interactionTimeoutRef.current);
      interactionTimeoutRef.current = window.setTimeout(() => setIsInteracting(false), 250);
    };

    const handleScroll = () => {
      if (interactionTimeoutRef.current) window.clearTimeout(interactionTimeoutRef.current);
      setIsInteracting(true);
      interactionTimeoutRef.current = window.setTimeout(() => setIsInteracting(false), 200);
    };

    ws.addEventListener('wheel', handleWheel, { passive: false });
    ws.addEventListener('scroll', handleScroll);
    return () => {
      ws.removeEventListener('wheel', handleWheel);
      ws.removeEventListener('scroll', handleScroll);
    };
  }, [isActive, tabId, savingStatus]);

  // ── Effect: Shift key tracking for constrained line drawing ─────────────────
  useEffect(() => {
    if (!isActive || savingStatus) return;
    const onDown = (e: KeyboardEvent) => { if (e.key === 'Shift') shiftDownRef.current = true;  };
    const onUp   = (e: KeyboardEvent) => { if (e.key === 'Shift') shiftDownRef.current = false; };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, [isActive, savingStatus]);

  // ── Effect: global keyboard shortcuts (Ctrl+Z, Ctrl+Y, Delete, Escape) ──────
  useEffect(() => {
    if (!isActive || savingStatus) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === 'INPUT' ||
          document.activeElement?.tagName === 'TEXTAREA') return;

      // Keyboard Zoom Shortcuts
      if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        const state = useStore.getState();
        const docState = state.documents[tabId];
        if (docState) {
          const currentScale = docState.scale || 1.0;
          const newScale = Math.min(5.0, currentScale + 0.25);
          state.zoomTo(newScale, docState.panOffset);
        }
      }
      if (e.ctrlKey && e.key === '-') {
        e.preventDefault();
        const state = useStore.getState();
        const docState = state.documents[tabId];
        if (docState) {
          const currentScale = docState.scale || 1.0;
          const newScale = Math.max(0.25, currentScale - 0.25);
          state.zoomTo(newScale, docState.panOffset);
        }
      }

      if (e.ctrlKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        useStore.getState().undo();
        useStore.getState().setActiveTool('select');
        isDrawingRef.current = false;
        newShapeIdRef.current = null;
        polygonCenterRef.current = null;
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'y') { e.preventDefault(); useStore.getState().redo(); }

      if (e.ctrlKey && e.key.toLowerCase() === 'c') {
        if (selectedShapeIds.length > 0) {
          e.preventDefault();
          const state = useStore.getState();
          const docState = state.documents[tabId];
          if (docState) {
            const copiedShapes = selectedShapeIds.map(id => docState.shapes.find(s => s.id === id)).filter(Boolean) as ShapeData[];
            state.setClipboard(copiedShapes);
          }
        }
      }

      if (e.ctrlKey && e.key.toLowerCase() === 'v') {
        const state = useStore.getState();
        const clipboard = state.clipboard;
        if (clipboard && clipboard.length > 0) {
          e.preventDefault();
          const mouseX = mousePosRef.current.x;
          const mouseY = mousePosRef.current.y;
          
          let minX = Infinity, minY = Infinity;
          clipboard.forEach(s => {
            minX = Math.min(minX, s.x);
            minY = Math.min(minY, s.y);
          });
          
          if (minX === Infinity) minX = 0;
          if (minY === Infinity) minY = 0;
          
          const dx = mouseX - minX;
          const dy = mouseY - minY;
          
          state.pushToHistory();
          const newIds: string[] = [];
          const currentDocState = state.documents[tabId];
          const currentPageNum = currentDocState ? currentDocState.pageNum : 1;
          
          clipboard.forEach(s => {
            if (s.type === 'callout' && s.parentId && clipboard.some(p => p.id === s.parentId)) {
              // This is a child callout whose parent is also copied. It will be handled when the parent is processed.
              return;
            }
            
            const newId = Math.random().toString(36).substring(7);
            newIds.push(newId);
            const newShape = { ...s, id: newId, x: s.x + dx, y: s.y + dy, page: currentPageNum };
            if (newShape.points && POINT_BASED_TYPES.includes(newShape.type as any)) {
              newShape.points = newShape.points.map((p, i) => i % 2 === 0 ? p + dx : p + dy);
            }
            state.addShape(newShape);
            
            if (s.type === 'cloud') {
              const callouts = clipboard.filter(child => child.type === 'callout' && child.parentId === s.id);
              callouts.forEach(child => {
                const childNewId = Math.random().toString(36).substring(7);
                newIds.push(childNewId);
                const newChild = { ...child, id: childNewId, x: child.x + dx, y: child.y + dy, parentId: newId, page: currentPageNum };
                if (newChild.points) {
                  newChild.points = newChild.points.map((p, i) => i % 2 === 0 ? p + dx : p + dy);
                }
                state.addShape(newChild);
              });
            }
          });
          state.setSelectedShapeIds(newIds);
        }
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        const curId = newShapeIdRef.current;
        if (curId) {
          useStore.getState().deleteShape(curId);
        }
        isDrawingRef.current     = false;
        newShapeIdRef.current    = null;
        polygonCenterRef.current = null;
        useStore.getState().setActiveTool('select');
        useStore.getState().setSelectedGuideId(null);
      } else if (['Enter', ' '].includes(e.key)) {
        e.preventDefault();
        const curId   = newShapeIdRef.current;
        // Always read the live tool from the store — no stale closure
        const liveTool = useStore.getState().activeTool;
        if (((liveTool === 'cloud' && useStore.getState().cloudMode === 'polygon') || liveTool === 'polyline' || liveTool === 'spline' || liveTool === 'arc' || liveTool === 'measure_area') && curId) {
          const shape = (useStore.getState().documents[tabId]?.shapes || []).find(s => s.id === curId);
          if (shape?.points && shape.points.length > 4) {
            // For measure_area: close the polygon on Escape/Enter
            if (liveTool === 'measure_area') {
              useStore.getState().updateShape(curId, { points: shape.points.slice(0, -2), closed: true });
            } else {
              useStore.getState().updateShape(curId, { points: shape.points.slice(0, -2) });
            }
            setSelectedShapeIds([curId]);
          } else if (shape) {
            useStore.getState().deleteShape(shape.id);
          }
        }
        isDrawingRef.current     = false;
        newShapeIdRef.current    = null;
        polygonCenterRef.current = null;
        useStore.getState().setActiveTool('select');
        useStore.getState().setSelectedGuideId(null);
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedShapeIds.length > 0) {
          deleteShapes(selectedShapeIds);
          setSelectedShapeIds([]);
        }
        const liveGuideId = useStore.getState().selectedGuideId;
        if (liveGuideId) {
          useStore.getState().removeGuide(liveGuideId);
          useStore.getState().setSelectedGuideId(null);
        }
      }

      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        if (selectedShapeIds.length > 0) {
          e.preventDefault();
          const state = useStore.getState();
          const docState = state.documents[tabId];
          if (!docState) return;
          const step = (e.shiftKey ? 10 : 1) / (docState.scale || 1.0);
          let dx = 0; let dy = 0;
          if (e.key === 'ArrowUp') dy = -step;
          if (e.key === 'ArrowDown') dy = step;
          if (e.key === 'ArrowLeft') dx = -step;
          if (e.key === 'ArrowRight') dx = step;

          state.pushToHistory();
          selectedShapeIds.forEach(id => {
            const shape = docState.shapes.find(s => s.id === id);
            if (shape) {
              if (POINT_BASED_TYPES.includes(shape.type as any) || isLineMark(shape.type)) {
                if (shape.points) {
                  const newPoints = shape.points.map((p, i) => i % 2 === 0 ? p + dx : p + dy);
                  state.updateShape(id, { points: newPoints, x: shape.x + dx, y: shape.y + dy });
                  if (shape.type === 'cloud') {
                    docState.shapes.forEach(child => {
                      if (child.type === 'callout' && child.parentId === id && child.points) {
                        state.updateShape(child.id, {
                          x: child.x + dx, y: child.y + dy,
                          points: child.points.map((p, i) => i % 2 === 0 ? p + dx : p + dy),
                        });
                      }
                    });
                  }
                }
              } else {
                state.updateShape(id, { x: shape.x + dx, y: shape.y + dy });
              }
            }
          });
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    const preventAltMenu = (e: KeyboardEvent) => {
      if (e.key === 'Alt') e.preventDefault();
    };
    window.addEventListener('keydown', preventAltMenu);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keydown', preventAltMenu);
    };
  }, [isActive, selectedShapeIds, deleteShapes, setSelectedShapeIds, savingStatus]);

  // ── Effect: paste image from clipboard (Ctrl+V) ─────────────────────────────
  useEffect(() => {
    if (!isActive || savingStatus) return;
    const handlePaste = async (e: ClipboardEvent) => {
      // Don't intercept paste inside text inputs / textareas
      if (document.activeElement?.tagName === 'INPUT' ||
          document.activeElement?.tagName === 'TEXTAREA') return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item.type.startsWith('image/')) continue;
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const img = new window.Image();
          img.onload = () => {
            const state = useStore.getState();
            const aid = state.activeTabId;
            if (!aid || !state.documents[aid]) return;
            const docState = state.documents[aid];
            const maxDim = 600;
            const ratio = Math.min(maxDim / img.naturalWidth, maxDim / img.naturalHeight, 1);
            const w = (img.naturalWidth  * ratio) / docState.scale;
            const h = (img.naturalHeight * ratio) / docState.scale;
            const panOffset = docState.panOffset || { x: 0, y: 0 };
            const currentScale = docState.scale || 1.0;
            const dropX = (-panOffset.x + stageSize.width / 2) / currentScale;
            const dropY = (-panOffset.y + stageSize.height / 2) / currentScale;

            state.addCustomAsset(dataUrl);
            state.pushToHistory();
            state.addShape({
              id: Math.random().toString(36).substring(7),
              type: 'image',
              x: dropX - w / 2,
              y: dropY - h / 2,
              width: w,
              height: h,
              imageUrl: dataUrl,
              strokeColor: 'transparent',
              strokeWidth: 0,
              page: docState.pageNum,
              author: 'User',
              date: new Date().toLocaleDateString(),
              comments: 'Pasted Image',
            });
          };
          img.src = dataUrl;
        };
        reader.readAsDataURL(file);
        break; // only handle the first image item
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [isActive, savingStatus]);

  // ── Effect: handle Pointer-based drag-and-drop of custom assets ──────────────
  useEffect(() => {
    if (!isActive || savingStatus) return;

    const handlePointerUp = (e: PointerEvent) => {
      const state = useStore.getState();
      const index = state.draggingAssetIndex;
      if (index === null) return;
      tauriLog("pointerup effect: index=" + index);
      
      // Clear dragging state and cursor
      document.body.style.cursor = '';
      state.setDraggingAssetIndex(null);

      const url = state.customAssets?.[index];
      if (!url) { tauriLog("pointerup effect: no url for index " + index); return; }
      
      const ws = workspaceRef.current;
      if (!ws) { tauriLog("pointerup effect: workspaceRef is null"); return; }
      
      const wrapper = ws.querySelector('.canvas-wrapper');
      if (!wrapper) { tauriLog("pointerup effect: canvas-wrapper not found"); return; }
      
      const rect = wrapper.getBoundingClientRect();
      tauriLog("pointerup effect client bounds check: clientX=" + e.clientX + " clientY=" + e.clientY + " bounds=" + JSON.stringify({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }));
      
      // Ensure drop is within wrapper bounds
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
        tauriLog("pointerup effect: drop outside wrapper bounds");
        return;
      }

      handleImageDrop(url, e.clientX, e.clientY);
    };
    
    const handlePointerMove = (_e: PointerEvent) => {
      // Optional: if dragging, we could update a floating preview or cursor.
      // E.g., force crosshair or grabbing cursor on body
      if (useStore.getState().draggingAssetIndex !== null) {
        // e.preventDefault(); // prevents scrolling while dragging if needed
      }
    };

    window.addEventListener('pointerup', handlePointerUp, { capture: true });
    window.addEventListener('pointermove', handlePointerMove, { capture: true });
    
    return () => {
      document.body.style.cursor = ''; // Ensure cursor resets if component unmounts
      window.removeEventListener('pointerup', handlePointerUp, { capture: true });
      window.removeEventListener('pointermove', handlePointerMove, { capture: true });
    };
  }, [isActive]);

  // ── Effect: auto-fit PDF to viewport on first load ──────────────────────────
  // hasAutoFittedRef ensures we ONLY auto-fit once per PDF load. Without this
  // guard, sleep/wake cycles can flip `isActive` which re-triggers the effect,
  // silently recomputing fitScale from new window dimensions and overwriting
  // the user's current zoom — shifting all subsequent markup coordinates.
  useEffect(() => {
    if (!pdfDoc || !workspaceRef.current || !isActive) return;
    // Skip if we already fitted for this PDF (e.g. tab became active again after sleep).
    // The user's zoom/pan is already correct; re-fitting would change `scale` and break
    // the coordinate space for any new shapes drawn after waking.
    if (hasAutoFittedRef.current) return;
    hasAutoFittedRef.current = true;
    const performAutoFit = async () => {
      try {
        const page = await pdfDoc.getPage(1);
        const vp   = page.getViewport({ scale: 1.0 });
        const ws   = workspaceRef.current;
        if (!ws) return;
        const availW = ws.clientWidth  - 100;
        const availH = ws.clientHeight - 100;
        const fitScale = Math.min(availW / vp.width, availH / vp.height);
        const ptsW = Math.round(vp.width), ptsH = Math.round(vp.height);
        const aspect = Math.max(ptsW, ptsH) / Math.min(ptsW, ptsH);
        let bestCalibration = 72.0;
        if      (Math.abs(aspect - 1.5)   < 0.05) bestCalibration = ptsW > ptsH ? ptsW / 36 : ptsW / 24;
        else if (Math.abs(aspect - 1.333) < 0.05) bestCalibration = ptsW > ptsH ? ptsW / 48 : ptsW / 36;
        else if (Math.abs(aspect - 1.4)   < 0.05) bestCalibration = ptsW > ptsH ? ptsW / 42 : ptsW / 30;
        else                                       bestCalibration = ptsW > ptsH ? ptsW / 36 : ptsW / 24;
        // Center the page in the canvas-wrapper (workspace minus 30px rulers).
        const cwW = ws.clientWidth  - 30;
        const cwH = ws.clientHeight - 30;
        const pageW = vp.width  * fitScale;
        const pageH = vp.height * fitScale;
        const centerX = Math.max(20, (cwW - pageW) / 2);
        const centerY = Math.max(20, (cwH - pageH) / 2);

        // Apply pan+zoom and calibration synchronously.
        // This prevents the base-canvas effect from starting a render, being interrupted 16ms later,
        // and causing a PDF.js canvas lock bug.
        useStore.getState().zoomTo(fitScale, { x: centerX, y: centerY });
        useStore.getState().setScaleCalibration?.(bestCalibration);
      } catch (err) { console.error('Auto-fit failed:', err); }
    };
    performAutoFit();
  }, [pdfDoc, isActive]);

  // Reset the auto-fit guard when a new PDF is loaded so fresh documents
  // always get fitted correctly.
  useEffect(() => {
    hasAutoFittedRef.current = false;
  }, [pdfDoc]);


  // ── Effect: update PDF.js viewport when scale/page changes ──────────────────
  // Fix 2: write to viewportRef synchronously every tick so rendering effects
  // always have fresh dimensions. Only flush to React state (setViewport) after
  // a 250 ms debounce to avoid a full re-render on every wheel event.
  useEffect(() => {
    if (!pdfDoc || !isActive) return;
    let cancelled = false;
    pdfDoc.getPage(pageNum)
      .then(page => {
        if (!cancelled) {
          const vp = page.getViewport({ scale });
          // Store native dimensions (at scale 1) so JSX can compute
          // `nativeW * scale` synchronously, avoiding the async size-snap.
          const w = vp.width / scale;
          const h = vp.height / scale;
          pdfNativeSizeRef.current = { w, h };
          useStore.getState().setPageDimensions?.(w, h);
          // Always update the ref immediately — no render cost.
          viewportRef.current = vp;
          // Debounce the state update to avoid a re-render on every zoom tick.
          if (viewportDebounceRef.current !== null)
            window.clearTimeout(viewportDebounceRef.current);
          viewportDebounceRef.current = window.setTimeout(() => {
            if (!cancelled) setViewport(vp);
            viewportDebounceRef.current = null;
          }, 200);
        }
      })
      .catch(err => console.error('Viewport update error:', err));
    return () => {
      cancelled = true;
      if (viewportDebounceRef.current !== null) {
        window.clearTimeout(viewportDebounceRef.current);
        viewportDebounceRef.current = null;
      }
    };
  }, [pdfDoc, pageNum, scale, isActive]);

  // Effect: for blank master page, sync mock viewport and native dimensions
  useEffect(() => {
    if (!isBlankMaster || !currentMaster || !isActive) return;
    const w = currentMaster.pageWidth;
    const h = currentMaster.pageHeight;
    pdfNativeSizeRef.current = { w, h };
    useStore.getState().setPageDimensions?.(w, h);
    const vp = {
      width: w * scale,
      height: h * scale,
    } as any;
    viewportRef.current = vp;
    setViewport(vp);
  }, [isBlankMaster, currentMaster?.pageWidth, currentMaster?.pageHeight, scale, isActive]);

  // ── Effect: update visible bounding box after scroll/zoom settles ────────────
  useEffect(() => {
    if (!isInteracting && viewport && workspaceRef.current && isActive) {
      requestAnimationFrame(() => {
        const ws = workspaceRef.current!;
        const pad = 100;
        const x = Math.max(0, ws.scrollLeft - pad);
        const y = Math.max(0, ws.scrollTop  - pad);
        const w = Math.max(0, Math.min(ws.clientWidth + pad * 2, viewport.width * (isSpread ? 2 : 1) - x));
        const h = Math.max(0, Math.min(ws.clientHeight + pad * 2, viewport.height - y));
        setVisibleBox(prev =>
          Math.abs(prev.x - x) < 5 && Math.abs(prev.y - y) < 5 && prev.w === w && prev.h === h
            ? prev : { x, y, w, h }
        );
      });
    }
  }, [isInteracting, viewport, isActive, isSpread]);

  // ── Effect: base-canvas PDF raster render ───────────────────────────────────
  // Uses the same serial-counter pattern as the hi-res effect so that rapid
  // page changes don't leave stale renders writing to a recycled canvas.
  // In spread mode: renders both left AND right pages side-by-side on one canvas.
  const baseRenderSerialRef = useRef(0);
  useEffect(() => {
    if (!baseCanvasRef.current || !isActive) return;
    if (!pdfDoc && !isBlankMaster) return;

    const mySerial = ++baseRenderSerialRef.current;
    let renderTaskObj: any = null;
    let renderTaskObj2: any = null;

    const timeoutId = setTimeout(() => {
      const run = async () => {
        try {
        if (isBlankMaster && currentMaster) {
          const canvas = baseCanvasRef.current!;
          const ctx    = canvas.getContext('2d');
          if (!ctx) return;
          const w_native = currentMaster.pageWidth;
          const h_native = currentMaster.pageHeight;
          const hasRight = currentMaster.isSpread;
          
          const totalWPoints = w_native * (hasRight ? 2 : 1);
          const targetCanvasW = totalWPoints * (scaleCalibration / 72.0);
          canvas.width  = Math.round(targetCanvasW);
          canvas.height = Math.round(h_native * (scaleCalibration / 72.0));


          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          if (currentMaster.isSpread) {
            ctx.strokeStyle = '#cccccc';
            ctx.lineWidth = 1;
            ctx.setLineDash([5, 5]);
            ctx.beginPath();
            ctx.moveTo(canvas.width / 2, 0);
            ctx.lineTo(canvas.width / 2, canvas.height);
            ctx.stroke();
          }
          return;
        }

        if (!pdfDoc) return;

        if (isSpread) {
          // ── Spread mode: render left + right pages side-by-side ──────────
          const leftPage  = await pdfDoc.getPage(Math.min(Math.max(1, spreadLeftPage), pdfDoc.numPages));
          const rightPage = spreadRightPage > 0 && pdfDoc.numPages >= spreadRightPage
            ? await pdfDoc.getPage(spreadRightPage)
            : null;
          if (mySerial !== baseRenderSerialRef.current) return;

          const canvas = baseCanvasRef.current!;
          const ctx    = canvas.getContext('2d');
          if (!ctx) return;

          // Compute exact proportional dimensions to avoid rounding-induced drift
          const tempVp = leftPage.getViewport({ scale: 1.0 });
          const pageW = pdfNativeSizeRef.current?.w ?? tempVp.width;
          const pageH = pdfNativeSizeRef.current?.h ?? tempVp.height;
          const hasRight = !!rightPage;
          
          const totalWPoints = pageW * (hasRight ? 2 : 1);
          const targetCanvasW = totalWPoints * (scaleCalibration / 72.0);
          canvas.width  = Math.round(targetCanvasW);
          canvas.height = Math.round(pageH * (scaleCalibration / 72.0));

          const scaleX = canvas.width / totalWPoints;
          const vp = leftPage.getViewport({ scale: scaleX });

          // Fill background
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          // Acquire render lock
          let resolveLock: () => void = () => {};
          const lockAcquired = (async () => {
            try { await renderLockRef.current; } catch {}
          })();
          renderLockRef.current = new Promise<void>((resolve) => { resolveLock = resolve; });
          await lockAcquired;

          if (mySerial !== baseRenderSerialRef.current) {
            resolveLock();
            return;
          }

          try {
            // Render left page
            renderTaskObj = leftPage.render({ canvasContext: ctx, viewport: vp } as any);
            await renderTaskObj.promise;
            
            if (mySerial === baseRenderSerialRef.current && rightPage) {
              const rightPageX = pageW * scaleX;
              const vpRight = rightPage.getViewport({ scale: scaleX });
              ctx.save();
              ctx.translate(rightPageX, 0);
              renderTaskObj2 = rightPage.render({ canvasContext: ctx, viewport: vpRight } as any);
              await renderTaskObj2.promise;
              ctx.restore();
            }
          } finally {
            resolveLock();
          }
        } else {
          // ── Single-page mode (original behaviour) ────────────────────────
          const page = await pdfDoc.getPage(pageNum);
          if (mySerial !== baseRenderSerialRef.current) return;
          const canvas = baseCanvasRef.current!;
          const ctx    = canvas.getContext('2d');
          if (!ctx) return;
          const vp = page.getViewport({ scale: scaleCalibration / 72.0 });
          canvas.width  = Math.max(1, Math.round(vp.width));
          canvas.height = Math.max(1, Math.round(vp.height));
          
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          // Acquire render lock
          let resolveLock: () => void = () => {};
          const lockAcquired = (async () => {
            try { await renderLockRef.current; } catch {}
          })();
          renderLockRef.current = new Promise<void>((resolve) => { resolveLock = resolve; });
          await lockAcquired;

          if (mySerial !== baseRenderSerialRef.current) {
            resolveLock();
            return;
          }

          try {
            renderTaskObj = page.render({ canvasContext: ctx, viewport: vp } as any);
            await renderTaskObj.promise;
          } finally {
            resolveLock();
          }
        }
      } catch (err) {
        if (mySerial === baseRenderSerialRef.current)
          console.error('Base canvas render error:', err);
      }
    };

    run();
    }, 50);

    return () => {
      clearTimeout(timeoutId);
      baseRenderSerialRef.current = Math.max(baseRenderSerialRef.current, mySerial + 1);
      // DO NOT cancel the render task to avoid PDF.js context locking bugs on rapid auto-fit calibration changes!
      // renderTaskObj?.cancel();
      // renderTaskObj2?.cancel();
    };
  }, [pdfDoc, pageNum, scaleCalibration, isActive, isSpread, spreadLeftPage, spreadRightPage, isBlankMaster, currentMaster?.pageWidth, currentMaster?.pageHeight, currentMaster?.isSpread, !!viewport]);

  // ── Effect: hi-res TILED render ─────────────────────────────────────────────
  // Fix 1: Only rasterize the visible viewport region of the PDF page, not the
  // entire page. This keeps canvas size at ~screen pixels regardless of zoom,
  // eliminating the old MAX_DIMENSION/SAFE_AREA cap that caused blurry text.
  //
  // Fix 3: Serial counter replaces the .then() promise chain. Each invocation
  // increments renderSerialRef. Any render whose serial no longer matches the
  // current counter cancels its PDF.js task immediately and exits.
  useEffect(() => {
    if (!pdfDoc || !highResCanvasRef.current || !viewport || isInteracting || !isActive) return;

    // Claim this render slot.
    const mySerial = ++renderSerialRef.current;
    let renderTaskObj: any = null;

    const runRender = async () => {
      try {
        const page = await pdfDoc.getPage(pageNum);
        if (mySerial !== renderSerialRef.current) return; // superseded

        const dpr    = window.devicePixelRatio || 1;
        const canvas = highResCanvasRef.current!;
        const ctx    = canvas.getContext('2d');
        if (!ctx) return;

        const renderScale = scale * dpr; // always full quality — no cap needed
        const fullVp = page.getViewport({ scale: renderScale });

        // ── Compute the visible sub-rectangle in device pixels ───────────────
        // panOffset is the CSS-pixel position of the page top-left inside the
        // canvas-wrapper. The visible strip of the PDF is whatever part of the
        // page falls inside the workspace bounding rect.
        const ws = workspaceRef.current;
        const wsW = ws ? ws.clientWidth  : window.innerWidth;
        const wsH = ws ? ws.clientHeight : window.innerHeight;

        const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

        // In spread mode, offset the page overlay if we are on the right page
        const pageW = pdfNativeSizeRef.current?.w ?? 0;
        const pageOffsetX = (isSpread && pageNum === spreadRightPage && pageW > 0)
          ? pageW * scale
          : 0;
        const effPanOffsetX = panOffset.x + pageOffsetX;

        // In device pixels:
        const visLeft   = clamp(-effPanOffsetX * dpr, 0, fullVp.width);
        const visTop    = clamp(-panOffset.y * dpr, 0, fullVp.height);
        const visRight  = clamp((wsW - effPanOffsetX) * dpr, 0, fullVp.width);
        const visBottom = clamp((wsH - panOffset.y) * dpr, 0, fullVp.height);

        const tileW = Math.max(1, Math.round(visRight  - visLeft));
        const tileH = Math.max(1, Math.round(visBottom - visTop));

        if (mySerial !== renderSerialRef.current) return; // superseded while computing

        canvas.width  = tileW;
        canvas.height = tileH;

        // CSS size = device pixels / dpr so the tile covers exactly the visible
        // screen area at 1:1 physical pixels.
        canvas.style.width  = `${tileW / dpr}px`;
        canvas.style.height = `${tileH / dpr}px`;

        // Position the tile so it aligns with the visible portion of the page.
        // effPanOffsetX/y places the page origin; we then shift right/down by the
        // crop origin (visLeft/visTop converted back to CSS pixels).
        canvas.style.transform =
          `translate(${effPanOffsetX + visLeft / dpr}px, ${panOffset.y + visTop / dpr}px)`;

        // getViewport offsetX/Y shifts the PDF coordinate system so that
        // device-pixel (visLeft, visTop) maps to canvas pixel (0, 0).
        const hiResVp = page.getViewport({
          scale: renderScale,
          offsetX: -visLeft,
          offsetY: -visTop,
        });

        // Acquire render lock
        let resolveLock: () => void = () => {};
        const lockAcquired = (async () => {
          try { await renderLockRef.current; } catch {}
        })();
        renderLockRef.current = new Promise<void>((resolve) => { resolveLock = resolve; });
        await lockAcquired;

        if (mySerial !== renderSerialRef.current) {
          resolveLock();
          return;
        }

        try {
          renderTaskObj = page.render({ canvasContext: ctx, viewport: hiResVp } as any);
          await renderTaskObj.promise;
        } finally {
          resolveLock();
        }
      } catch (err) {
        if (mySerial === renderSerialRef.current)
          console.error('Hi-res render error:', err);
      }
    };

    runRender();

    return () => {
      // Invalidate this render slot; the running task will self-cancel on next
      // serial check. Also hard-cancel any in-flight PDF.js task.
      renderSerialRef.current = Math.max(renderSerialRef.current, mySerial + 1) - 1 + 1;
      renderTaskObj?.cancel();
    };
  }, [pdfDoc, pageNum, scale, panOffset, viewport, isInteracting, isActive, isSpread, spreadLeftPage, spreadRightPage]);

  // ── Effect: bind Konva Transformer to selected shapes ───────────────────────
  useEffect(() => {
    if (!isActive) return;
    if (selectedShapeIds.length > 0 && trRef.current && stageRef.current) {
      const nodes = selectedShapeIds
        .map(id => stageRef.current.findOne(`#shape-${id}`))
        .filter(Boolean);
      const singleShape = selectedShapeIds.length === 1
        ? shapes.find(s => s.id === selectedShapeIds[0]) : null;
      const isNodeMode = !!(singleShape && (
        singleShape.type === 'callout' ||
        (singleShape.type === 'content_box' && singleShape.contentMode === 'content') ||
        (POINT_BASED_TYPES.includes(singleShape.type) && singleShape.type !== 'polygon' && !isScaleMode)
      ));
      if (nodes.length > 0 && !isNodeMode) {
        trRef.current.nodes(nodes);
        trRef.current.getLayer().batchDraw();
        trRef.current.update();
      } else {
        trRef.current.nodes([]);
      }
    } else if (trRef.current) {
      trRef.current.nodes([]);
    }
  }, [selectedShapeIds, activeTool, shapes, isScaleMode, scale, isActive]);

  // ── Effect: reset contentMode to 'frame' on deselect ────────────────────────
  useEffect(() => {
    if (!isActive) return;
    const allShapes = doc?.shapes || [];
    allShapes.forEach(shape => {
      if (shape.type === 'content_box' &&
          shape.contentMode === 'content' &&
          !selectedShapeIds.includes(shape.id)) {
        updateShape(shape.id, { contentMode: 'frame' });
      }
    });
  }, [selectedShapeIds, doc?.shapes, isActive, updateShape]);

  // Clear selection when switching away from select tool
  // (but keep it so the Transformer can still show on any tool)

  // ── Event handlers ──────────────────────────────────────────────────────────

  const handleMouseDown = (e: any) => {
    if (!isActive) return;

    if (e.evt && e.evt.button === 1) { // Middle mouse button
      e.evt.preventDefault();
      const now = Date.now();
      if (now - lastMidClickRef.current < 300) {
        // Double click detected! Zoom and center the page.
        const ws = workspaceRef.current;
        if (ws) {
          let pageW = 612;
          let pageH = 792;
          if (pdfNativeSizeRef.current) {
            pageW = pdfNativeSizeRef.current.w;
            pageH = pdfNativeSizeRef.current.h;
          } else if (viewport) {
            pageW = viewport.width / scale;
            pageH = viewport.height / scale;
          }
          const totalWPoints = pageW * (isSpread && spreadHasRight ? 2 : 1);
          const totalHPoints = pageH;
          const cwW = ws.clientWidth - 30; // subtract ruler width (30px)
          const cwH = ws.clientHeight - 30; // subtract ruler height (30px)
          const padding = 40; // padding around the page
          const availW = Math.max(100, cwW - padding * 2);
          const availH = Math.max(100, cwH - padding * 2);
          const fitScale = Math.min(availW / totalWPoints, availH / totalHPoints);
          const clampedScale = Math.max(0.1, Math.min(20, fitScale));
          const contentW = totalWPoints * clampedScale;
          const contentH = totalHPoints * clampedScale;
          const centerX = Math.max(20, (cwW - contentW) / 2);
          const centerY = Math.max(20, (cwH - contentH) / 2);
          useStore.getState().zoomTo(clampedScale, { x: centerX, y: centerY });
        }
      }
      lastMidClickRef.current = now;
      return; // Stop other tool logic from firing
    }

    // ── Brush Resize Interception ────────────────────────────────────────────
    if (activeTool === 'brush' && e.evt.button === 2 && e.evt.altKey) {
      e.evt.preventDefault();
      e.cancelBubble = true;
      isResizingBrushRef.current = true;
      brushResizeStartXRef.current = e.evt.clientX;
      initialBrushThicknessRef.current = useStore.getState().brushThickness;
      
      // Seed preview cursor position immediately
      const stage = e.target.getStage();
      const ptr   = stage.getPointerPosition();
      if (ptr) {
        setPreviewCursor({
          x: ptr.x / scale + visibleBox.x / scale,
          y: ptr.y / scale + visibleBox.y / scale
        });
      }
      return;
    }

    // Ignore middle (1) and right (2) clicks — middle click is for panning
    if (e.evt && e.evt.button !== 0) return;

    // ── Prevent Drawing When Interacting With Handles or Selected Shapes ────
    const target = e.target;
    const isTransformer = target.getParent()?.className === 'Transformer';
    const isCustomHandle = target.name() === 'vertex-handle' || target.name() === 'callout-handle' || target.name() === 'arrow-text-handle';
    
    let clickedSelectedShape = false;
    let clickedContentBoxId = null;
    let node = target;
    dragLeaderIdRef.current = null;
    while (node) {
      if (node.id() && node.id().startsWith('shape-')) {
        const shapeId = node.id().substring(6);
        dragLeaderIdRef.current = shapeId;
        if (selectedShapeIds.includes(shapeId)) {
          clickedSelectedShape = true;
        }
        const clickedShape = shapes.find(s => s.id === shapeId);
        if (clickedShape && clickedShape.type === 'content_box') {
          clickedContentBoxId = shapeId;
        }
        break;
      }
      node = node.getParent();
    }

    if (isTransformer || isCustomHandle || (clickedSelectedShape && !isDrawingRef.current)) {
      return; // Let Konva natively drag the handle or selected shape without starting a new shape
    }

    if (activeTool === 'content_box' && clickedContentBoxId) {
      setSelectedShapeIds([clickedContentBoxId]);
      useStore.getState().setActiveTool('select');
      return;
    }

    // ── Text-capable shape intercept ─────────────────────────────────────────
    // When any drawing tool is active and the user clicks on a text/callout/cloud/arrow/spline,
    // select the shape instead of starting a new drawing point.  This also ensures that
    // the second click of a double-click finds the shape already selected → returns early
    // → the subsequent dblclick event fires cleanly and opens the inline editor.
    if (activeTool !== 'select' && activeTool !== 'pan' && !isDrawingRef.current) {
      let clickedNode = target;
      while (clickedNode) {
        if (clickedNode.id()?.startsWith('shape-')) {
          const cId = clickedNode.id().substring(6);
          const cShape = shapes.find(s => s.id === cId);
          if (cShape && ['text', 'callout', 'cloud', 'arrow', 'spline'].includes(cShape.type) && cId !== newShapeIdRef.current) {
            setSelectedShapeIds([cId]);
            return;
          }
          break;
        }
        clickedNode = clickedNode.getParent();
      }
    }

    // ── Click-outside-to-deselect ────────────────────────────────────────────
    // If the user clicked on the blank canvas (not on any shape) while shapes
    // are selected, deselect and stop — do NOT start drawing a new shape.
    // This matches the expected behaviour where clicking outside a selection
    // clears it, just like in Figma, Illustrator, etc.
    const clickedBackground =
      e.target === e.target.getStage() ||
      e.target.hasName('background-placeholder');
    if (clickedBackground && selectedShapeIds.length > 0 && !isDrawingRef.current) {
      setSelectedShapeIds([]);
      setSelectedGuideId(null);
      return;
    }

    // Capture a clean snapshot BEFORE mutating shapes (undo restores this state).
    pushToHistory();

    const stage = e.target.getStage();
    if (!stage) return;
    const pointerPosition = stage.getPointerPosition();
    if (!pointerPosition) return;
    const scaleFactor = stage.scaleX() !== 1 ? stage.scaleX() : scale;
    const mouseX = (pointerPosition.x - stage.x()) / scaleFactor;
    const mouseY = (pointerPosition.y - stage.y()) / scaleFactor;
    // Snapping in absolute coordinates
    let absX = mouseX;
    let absY = mouseY;

    // Apply snap to initial click for drawing tools
    if (activeTool !== 'select' && activeTool !== 'pan') {
      const snapResult = getVectorSnap(mouseX, mouseY);
      if (snapResult) {
        absX = snapResult.x;
        absY = snapResult.y;
        setActiveSnap({
          type: snapResult.type,
          x: snapResult.x,
          y: snapResult.y
        });
      } else {
        const liveGuides = getEffectiveGuides();
        const liveSnap = useStore.getState().snapEnabled;
        const liveSens = useStore.getState().snapSensitivity;
        if (liveSnap && liveGuides.length > 0) {
          absX = calculateSnap(absX, liveGuides, 'vertical',   scale, liveSnap, liveSens);
          absY = calculateSnap(absY, liveGuides, 'horizontal', scale, liveSnap, liveSens);
        }
        setActiveSnap(null);
      }
    }

    // Determine target page and adjust coordinate space
    const pdfPageW = pdfNativeSizeRef.current?.w ?? 0;
    const spineGap = 0; // Adjacent pages, no gap
    const activeDoc = useStore.getState().documents[tabId];
    const drawingShape = newShapeIdRef.current ? activeDoc?.shapes.find(s => s.id === newShapeIdRef.current) : null;
    const isContinuingDrawing = isDrawingRef.current && !!drawingShape;

    const onRightPage = isContinuingDrawing
      ? (drawingShape.page === spreadRightPage)
      : (!isMasterTab && spreadHasRight && isSpread && pdfPageW > 0 && absX >= pdfPageW + spineGap);

    const drawingPage = isContinuingDrawing
      ? drawingShape.page
      : (isSpread ? (onRightPage ? spreadRightPage : spreadLeftPage) : pageNum);

    let x = (isSpread && drawingPage === spreadRightPage && pdfPageW > 0)
      ? absX - pdfPageW - spineGap
      : absX;
    let y = absY;

    if (shiftDownRef.current && newShapeIdRef.current && drawingShape) {
      let originX = drawingShape.x;
      let originY = drawingShape.y;
      if (['polyline', 'spline', 'cloud'].includes(drawingShape.type) && drawingShape.points && drawingShape.points.length >= 4) {
        originX = drawingShape.points[drawingShape.points.length - 4];
        originY = drawingShape.points[drawingShape.points.length - 3];
      }
      const c = shiftConstrain(originX, originY, x, y);
      x = c.x;
      y = c.y;
    }

    // ── Selection box start ──────────────────────────────────────────────────
    if (activeTool === 'select') {
      if (e.target === stage || e.target.hasName('background-placeholder')) {
        // Use absX/absY (absolute canvas coords) — NOT x/y which has the right-page
        // offset already subtracted for drawing tools. The selection rect is rendered
        // and compared against shape bounds in absolute canvas space.
        setSelectionBox({ x: absX, y: absY, w: 0, h: 0 });
        setSelectedShapeIds([]);
        setSelectedGuideId(null);
      }
      return;
    }

    // For any drawing tool, clear the selection so we don't show a stale Transformer
    if (selectedShapeIds.length > 0) setSelectedShapeIds([]);

    // ── Polygon: first click sets centre ────────────────────────────────────
    if (activeTool === 'polygon') {
      polygonCenterRef.current = { x, y };
      if (!isDrawingRef.current || !newShapeIdRef.current) {
        isDrawingRef.current = true;
        const id = Math.random().toString(36).substring(7);
        newShapeIdRef.current = id;
        const { polygonSides } = useStore.getState();
        addShape({
          id, type: 'polygon',
          x, y,
          points: buildPolygonPoints(x, y, 0, polygonSides),
          strokeColor, strokeWidth, fillColor: 'transparent',
          page: drawingPage, author: 'User',
          date: new Date().toLocaleDateString(),
          sides: polygonSides,
        } as any);
      }
      return;
    }

    // ── Arc tool: 3-click interaction ──────────────────────────────────────────
    if (activeTool === 'arc') {
      if (!isDrawingRef.current || !newShapeIdRef.current) {
        isDrawingRef.current = true;
        const id = Math.random().toString(36).substring(7);
        newShapeIdRef.current = id;
        addShape({
          id, type: 'arc', x, y,
          points: [x, y, x, y], // Start point and initial End preview
          strokeColor, strokeWidth, dash: activeDash,
          fillColor: 'transparent',
          page: drawingPage, author: 'User', date: new Date().toLocaleDateString(),
        } as any);
        return;
      } else {
        const shapes = useStore.getState().documents[tabId]?.shapes || [];
        const shape = shapes.find(s => s.id === newShapeIdRef.current!);
        if (shape && shape.points) {
          if (shape.points.length === 4) {
            // Second click: finalize End point, add Mid point preview
            updateShape(shape.id, { points: [shape.points[0], shape.points[1], x, y, shape.points[2], shape.points[3]] });
            return;
          }

          if (shape.points.length === 6) {
            // Third click: finalize Control point and finish
            const completedId = newShapeIdRef.current!;
            isDrawingRef.current = false;
            newShapeIdRef.current = null;
            useStore.getState().pushToHistory();
            setSelectedShapeIds([completedId]);
            return;
          }
        }
      }
    }

    // ── Measure Area: polyline click-to-add-vertices that auto-closes ──────────
    if (activeTool === 'measure_area') {
      if (!isDrawingRef.current || !newShapeIdRef.current) {
        isDrawingRef.current = true;
        const id = Math.random().toString(36).substring(7);
        newShapeIdRef.current = id;
        drawOriginRef.current = { x, y };
        addShape({
          id, type: 'measure_area',
          x, y,
          points: [x, y, x + 1, y + 1],
          strokeColor, strokeWidth,
          fillColor: 'rgba(77,166,255,0.12)',
          page: drawingPage, author: 'User',
          date: new Date().toLocaleDateString(),
          measurementSystem: 'metric' as any,
          measurementScale: 1,
        } as any);
      } else {
        // Subsequent clicks append a vertex.
        const shape = (useStore.getState().documents[tabId]?.shapes || []).find(s => s.id === newShapeIdRef.current!);
        if (shape?.points) {
          const startX = shape.points[0];
          const startY = shape.points[1];
          const dist = Math.sqrt(Math.pow(x - startX, 2) + Math.pow(y - startY, 2));
          if (dist < 20 / scale && shape.points.length > 4) {
            // Close shape
            const pts = shape.points.slice(0, -2);
            updateShape(newShapeIdRef.current!, { points: pts, closed: true });
            const completedId = newShapeIdRef.current!;
            isDrawingRef.current = false;
            newShapeIdRef.current = null;
            setSelectedShapeIds([completedId]);
          } else {
            updateShape(newShapeIdRef.current!, {
              points: [...shape.points.slice(0, -2), x, y, x + 1, y + 1],
            });
          }
        }
      }
      return;
    }

    // ── Cloud / polyline: first click creates the shape ──────────────────────
    if ((activeTool === 'cloud' && useStore.getState().cloudMode === 'polygon') || activeTool === 'polyline' || activeTool === 'spline') {
      if (!isDrawingRef.current || !newShapeIdRef.current) {
        isDrawingRef.current = true;
        const id = Math.random().toString(36).substring(7);
        newShapeIdRef.current = id;
        drawOriginRef.current = { x, y };
        const { polygonSides } = useStore.getState();
        addShape({
          id, type: activeTool,
          x, y,
          points: [x, y, x + 1, y + 1],
          strokeColor, strokeWidth,
          fillColor: 'transparent',
          page: drawingPage, author: 'User',
          date: new Date().toLocaleDateString(),
          radius: activeTool === 'cloud' ? 20 : undefined,
          showArrowHead: activeTool === 'spline' ? useStore.getState().showArrowHead : undefined,
          arrowHeadType: activeTool === 'spline' ? useStore.getState().arrowHeadType : undefined,
          arrowHeadSize: activeTool === 'spline' ? useStore.getState().arrowHeadSize : undefined,
          arrowHeadAngle: activeTool === 'spline' ? useStore.getState().arrowHeadAngle : undefined,
          arrowHeadFilled: activeTool === 'spline' ? useStore.getState().arrowHeadFilled : undefined,
          text: (activeTool === 'spline' && useStore.getState().addLabelMode) ? 'Double click to edit...' : undefined,
          ...((activeTool as any) === 'polygon' ? { sides: polygonSides } : {}),
        } as any);
      } else {
        // Subsequent clicks append a vertex.
        const shape = (useStore.getState().documents[tabId]?.shapes || []).find(s => s.id === newShapeIdRef.current!);
        if (shape?.points) {
          const startX = shape.points[0];
          const startY = shape.points[1];
          const dist = Math.sqrt(Math.pow(x - startX, 2) + Math.pow(y - startY, 2));
          if (dist < 20 / scale && shape.points.length > 4) {
            // Closes shape
            updateShape(newShapeIdRef.current!, {
              points: [...shape.points.slice(0, -2)],
              closed: true,
            });
            const completedId = newShapeIdRef.current!;
            isDrawingRef.current = false;
            newShapeIdRef.current = null;
            setSelectedShapeIds([completedId]);
          } else {
            updateShape(newShapeIdRef.current!, {
              points: [...shape.points.slice(0, -2), x, y, x + 1, y + 1],
            });
          }
        }
      }
      return;
    }

    // ── Point-based line/arrow/measure_length: 2-click interaction ─────────────────────────────────
    if (['line', 'arrow', 'measure_length'].includes(activeTool)) {
      if (!isDrawingRef.current || !newShapeIdRef.current) {
        isDrawingRef.current = true;
        const id = Math.random().toString(36).substring(7);
        newShapeIdRef.current = id;
        const newShape: ShapeData = {
          id, type: activeTool as any,
          x, y,
          points: [x, y, x, y],
          strokeColor, strokeWidth, dash: activeDash,
          fillColor: 'transparent',
          showArrowHead: activeTool === 'arrow' ? useStore.getState().showArrowHead : undefined,
          arrowHeadType: activeTool === 'arrow' ? useStore.getState().arrowHeadType : undefined,
          arrowHeadSize: activeTool === 'arrow' ? useStore.getState().arrowHeadSize : undefined,
          arrowHeadAngle: activeTool === 'arrow' ? useStore.getState().arrowHeadAngle : undefined,
          arrowHeadFilled: activeTool === 'arrow' ? useStore.getState().arrowHeadFilled : undefined,
          text: (activeTool === 'arrow' && useStore.getState().addLabelMode) ? 'Double click to edit...' : undefined,
          page: drawingPage, author: 'User', date: new Date().toLocaleDateString(),
        } as any;
        if (activeTool === 'measure_length') {
          newShape.measurementSystem = 'metric';
          newShape.measurementScale = 1;
        }
        addShape(newShape);
      } else {
        const shapeId = newShapeIdRef.current!;
        const liveShape = (useStore.getState().documents[tabId]?.shapes || []).find(s => s.id === shapeId);
        if (liveShape && liveShape.points) {
          updateShape(shapeId, { points: [liveShape.points[0], liveShape.points[1], x, y] });
        }
        isDrawingRef.current = false;
        newShapeIdRef.current = null;
        setSelectedShapeIds([shapeId]);
      }
      return;
    }

    // ── Mark tools: line-based (section, level, grid) ────────────────────────
    if (isLineMark(activeTool)) {
      if (!isDrawingRef.current || !newShapeIdRef.current) {
        // First click: create shape with start = end (will stretch on mousemove)
        isDrawingRef.current = true;
        const id = Math.random().toString(36).substring(7);
        newShapeIdRef.current = id;
        const defaultData: Record<string, Record<string, string>> = {
          mark_section: { top: '1', bottom: 'A100' },
          mark_level:   { name: 'First Floor', elevation: "100'-0" },
          mark_grid:    { label: 'A' },
          mark_insulation: { thickness: '20' },
          mark_metal_deck: { scale: '20' },
        };
        addShape({
          id, type: activeTool as any,
          x, y,
          // RELATIVE points: [0,0,0,0] — gets stretched on mousemove
          points: [0, 0, 0, 0],
          strokeColor, strokeWidth,
          fontSize: 11, fontFamily: 'Inter',
          markerData: defaultData[activeTool] || { scale: '20' },
          page: drawingPage, author: 'User',
          date: new Date().toLocaleDateString(),
        } as any);
      } else {
        // Second click: finalise the endpoint then commit
        const shapeId = newShapeIdRef.current!;
        const liveShape = (useStore.getState().documents[tabId]?.shapes || []).find(s => s.id === shapeId);
        if (liveShape) {
          updateShape(shapeId, { points: [0, 0, x - liveShape.x, y - liveShape.y] });
        }
        isDrawingRef.current = false;
        newShapeIdRef.current = null;
        setSelectedShapeIds([shapeId]);
      }
      return;
    }

    // ── Mark tools: box/stamp-based (elevation, callout) ─────────────────────
    if (isBoxMark(activeTool)) {
      isDrawingRef.current = true;
      const id = Math.random().toString(36).substring(7);
      newShapeIdRef.current = id;
      drawOriginRef.current = { x, y };
      const defaultData: Record<string, Record<string, string>> = {
        mark_elevation: { label: 'A5.10' },
        mark_callout:   { top: 'A1', bottom: 'A401' },
        mark_w_section: { thickness: '5' },
      };
      addShape({
        id, type: activeTool as any,
        x, y,
        // Start at 0×0 so the user drags to size it (no immediate "stamp")
        width: 0, height: 0,
        strokeColor, strokeWidth,
        fontSize: 11, fontFamily: 'Inter',
        markerData: defaultData[activeTool] || {},
        minWidth: 40, minHeight: 40,
        page: drawingPage, author: 'User',
        date: new Date().toLocaleDateString(),
      } as any);
      return;
    }

    // ── Content Box: draw the empty frame placeholder ──────────────────────────
    if (activeTool === 'content_box') {
      isDrawingRef.current = true;
      const id = Math.random().toString(36).substring(7);
      newShapeIdRef.current = id;
      drawOriginRef.current = { x, y };
      addShape({
        id, type: 'content_box',
        x, y,
        width: 0, height: 0,
        strokeColor: '#4da6ff', strokeWidth: 1.5,
        fillColor: 'transparent',
        contentMode: 'frame',
        page: drawingPage, author: 'User',
        date: new Date().toLocaleDateString(),
      } as any);
      return;
    }

    // ── Arrow / line variants: start drawing ─────────────────────────────────
    if (['freehand', 'highlight', 'brush',
         'rect', 'circle', 'text', 'stamp', 'callout', 'image', 'table'].includes(activeTool) ||
        (activeTool === 'cloud' && useStore.getState().cloudMode !== 'polygon')) {
      isDrawingRef.current = true;
      const id = Math.random().toString(36).substring(7);
      newShapeIdRef.current = id;
      drawOriginRef.current = { x, y };
      const { activeStamp, polygonSides, cloudMode, pendingTableDimensions } = useStore.getState();
      const newShape: ShapeData = {
        id, type: activeTool as any,
        x, y,
        strokeColor, strokeWidth: activeTool === 'brush' ? useStore.getState().brushThickness : strokeWidth, fillColor: 'transparent',
        page: drawingPage, author: 'User',
        date: new Date().toLocaleDateString(),
        points: ['freehand', 'highlight', 'brush'].includes(activeTool) || POINT_BASED_TYPES.includes(activeTool as any)
          ? [x, y, x + 1, y + 1] : undefined,
        width:  ['rect', 'text', 'stamp', 'image', 'callout', 'table'].includes(activeTool) ? 0 : undefined,
        height: ['rect', 'text', 'stamp', 'image', 'callout', 'table'].includes(activeTool) ? 0 : undefined,
        radius: activeTool === 'circle' ? 0 : undefined,
        stampText: activeTool === 'stamp' ? activeStamp : undefined,
        showArrowHead: activeTool === 'arrow' ? useStore.getState().showArrowHead : undefined,
        arrowHeadType: activeTool === 'arrow' ? useStore.getState().arrowHeadType : undefined,
        arrowHeadSize: activeTool === 'arrow' ? useStore.getState().arrowHeadSize : undefined,
        arrowHeadAngle: activeTool === 'arrow' ? useStore.getState().arrowHeadAngle : undefined,
        arrowHeadFilled: activeTool === 'arrow' ? useStore.getState().arrowHeadFilled : undefined,
        text: activeTool === 'text' ? 'Double click from Ledger to write text...' : 
              (['arrow', 'spline'].includes(activeTool) && useStore.getState().addLabelMode) ? 'Double click to edit...' : undefined,
        ...((activeTool as any) === 'polygon' ? { sides: polygonSides } : {}),
        ...(activeTool === 'cloud' ? { cloudMode, points: [x,y, x,y], radius: 20 } : {}),
        ...(activeTool === 'table' && pendingTableDimensions ? {
          tableData: {
            rows: pendingTableDimensions.rows,
            cols: pendingTableDimensions.cols,
            rowHeights: Array(pendingTableDimensions.rows).fill(30),
            colWidths: Array(pendingTableDimensions.cols).fill(100),
            cells: {},
            borderThickness: 1,
            colLineThicknesses: Array(pendingTableDimensions.cols + 1).fill(1),
            rowLineThicknesses: Array(pendingTableDimensions.rows + 1).fill(1)
          }
        } : {}),
      };
      
      // Override for Custom Image Stamps
      if (activeTool === 'stamp' && activeStamp.startsWith('data:image')) {
        newShape.type = 'image';
        newShape.imageUrl = activeStamp;
        newShape.width = 200; // Default generous size
        newShape.height = 100;
        newShape.strokeWidth = 0;
        newShape.strokeColor = 'transparent';
        newShape.stampText = undefined;
      }
      
      addShape(newShape);
    }
  };

  const handleMouseMove = (e: any) => {
    // ── Brush Hover Update ────────────────────────────────────────────────
    if (activeTool === 'brush' && !isResizingBrushRef.current && !isDrawingRef.current) {
      const stage = e.target.getStage();
      if (!stage) return;
      const pointerPosition = stage.getPointerPosition();
      if (!pointerPosition) return;
      const scaleFactor = stage.scaleX() !== 1 ? stage.scaleX() : scale;
      const mouseX = (pointerPosition.x - stage.x()) / scaleFactor;
      const mouseY = (pointerPosition.y - stage.y()) / scaleFactor;
      setHoverPos({
        x: mouseX,
        y: mouseY
      });
    }

    // ── Brush Resize Update ────────────────────────────────────────────────
    if (isResizingBrushRef.current) {
      const deltaX = e.evt.clientX - brushResizeStartXRef.current;
      let newThickness = initialBrushThicknessRef.current + (deltaX * 0.5);
      newThickness = Math.max(2, Math.min(150, newThickness));
      useStore.getState().setBrushThickness(newThickness);
      // Purposefully NOT updating previewCursor so the circle stays at the Alt+Click origin
      return;
    }

    if (!isActive || !isDrawingRef.current) {
      if (parallelSnapGuide) setParallelSnapGuide(null);
      if (smartGuides.vertical !== null || smartGuides.horizontal !== null) {
        setSmartGuides({ vertical: null, horizontal: null });
      }
      // Update live selection box even when not drawing (drag-select)
      if (isActive && activeTool === 'select' && selectionBox && e.target?.getStage) {
        const stage = e.target.getStage();
        if (!stage) return;
        const pointerPosition = stage.getPointerPosition();
        if (!pointerPosition) return;
        const scaleFactor = stage.scaleX() !== 1 ? stage.scaleX() : scale;
        const mouseX = (pointerPosition.x - stage.x()) / scaleFactor;
        const mouseY = (pointerPosition.y - stage.y()) / scaleFactor;
        setSelectionBox(prev => prev ? { ...prev, w: mouseX - prev.x, h: mouseY - prev.y } : prev);
      }
      
      // Calculate snap preview when hovering with drawing tools
      const liveTool = useStore.getState().activeTool;
      const isDrawingTool = liveTool !== 'select' && liveTool !== 'pan';
      if (isActive && isDrawingTool && e.target?.getStage) {
        const stage = e.target.getStage();
        if (stage) {
          const pointerPosition = stage.getPointerPosition();
          if (pointerPosition) {
            const scaleFactor = stage.scaleX() !== 1 ? stage.scaleX() : scale;
            const mouseX = (pointerPosition.x - stage.x()) / scaleFactor;
            const mouseY = (pointerPosition.y - stage.y()) / scaleFactor;
            const snapResult = getVectorSnap(mouseX, mouseY);
            if (snapResult) {
              setActiveSnap({
                type: snapResult.type,
                x: snapResult.x,
                y: snapResult.y
              });
            } else {
              setActiveSnap(null);
            }
          }
        }
      } else {
        setActiveSnap(null);
      }
      return;
    }
    const stage = e.target.getStage();
    if (!stage) return;
    const pointerPosition = stage.getPointerPosition();
    if (!pointerPosition) return;
    const scaleFactor = stage.scaleX() !== 1 ? stage.scaleX() : scale;
    const mouseX = (pointerPosition.x - stage.x()) / scaleFactor;
    const mouseY = (pointerPosition.y - stage.y()) / scaleFactor;
    // Snapping in absolute coordinates
    let absX = mouseX;
    let absY = mouseY;

    const pdfPageW = pdfNativeSizeRef.current?.w ?? 0;
    const spineGap = 0; // Adjacent pages, no gap
    const activeDoc = useStore.getState().documents[tabId];
    const drawingShape = activeDoc?.shapes.find(s => s.id === newShapeIdRef.current);

    // Apply snap during shape drawing (vector snap takes priority over guide/parallel snap)
    const snapResult = getVectorSnap(mouseX, mouseY);
    if (snapResult) {
      absX = snapResult.x; // Use absolute snapped X
      absY = snapResult.y; // Use absolute snapped Y
      setActiveSnap({
        type: snapResult.type,
        x: snapResult.x,
        y: snapResult.y
      });
      setParallelSnapGuide(null);
    } else {
      setActiveSnap(null);

      let parallelSnap = null;
      if (drawingShape && POINT_BASED_TYPES.includes(drawingShape.type)) {
        let snapOriginX = drawingShape.x;
        let snapOriginY = drawingShape.y;
        if (['polyline', 'spline', 'cloud'].includes(drawingShape.type) && drawingShape.points && drawingShape.points.length >= 4) {
          snapOriginX = drawingShape.points[drawingShape.points.length - 4];
          snapOriginY = drawingShape.points[drawingShape.points.length - 3];
        }

        // Adjust snapOriginX to match the page of the mouse cursor for getParallelSnapForDrawing
        const cursorOnRightPage = !isMasterTab && spreadHasRight && isSpread && pdfPageW > 0 && mouseX >= pdfPageW + spineGap;
        const cursorPage = isSpread ? (cursorOnRightPage ? spreadRightPage : spreadLeftPage) : pageNum;
        let adjustedSnapOriginX = snapOriginX;
        if (drawingShape.page !== cursorPage) {
          if (drawingShape.page === spreadLeftPage && cursorPage === spreadRightPage) {
            adjustedSnapOriginX = snapOriginX - pdfPageW;
          } else if (drawingShape.page === spreadRightPage && cursorPage === spreadLeftPage) {
            adjustedSnapOriginX = snapOriginX + pdfPageW;
          }
        }

        parallelSnap = getParallelSnapForDrawing(adjustedSnapOriginX, snapOriginY, mouseX, mouseY, drawingShape.id);
      }

      if (parallelSnap) {
        absX = parallelSnap.x;
        absY = parallelSnap.y;
        setParallelSnapGuide(parallelSnap.segment);
      } else {
        setParallelSnapGuide(null);
        const liveGuides = getEffectiveGuides();
        if (snapEnabled && liveGuides.length > 0) {
          absX = calculateSnap(absX, liveGuides, 'vertical',   scale, snapEnabled, snapSensitivity);
          absY = calculateSnap(absY, liveGuides, 'horizontal', scale, snapEnabled, snapSensitivity);
        }
      }
    }

    // Convert absolute to page-relative coordinate based on the drawing shape's page
    let x = absX;
    let y = absY;
    if (isSpread && pdfPageW > 0 && drawingShape && drawingShape.page === spreadRightPage) {
      x = x - pdfPageW - spineGap;
    }

    mousePosRef.current = { x: mouseX, y: mouseY };

    if (shiftDownRef.current && drawingShape) {
      let originX = drawingShape.x;
      let originY = drawingShape.y;
      if (['polyline', 'spline', 'cloud'].includes(drawingShape.type) && drawingShape.points && drawingShape.points.length >= 4) {
        originX = drawingShape.points[drawingShape.points.length - 4];
        originY = drawingShape.points[drawingShape.points.length - 3];
      }
      const c = shiftConstrain(originX, originY, x, y);
      x = c.x;
      y = c.y;
    }

    if (!newShapeIdRef.current) return;
    const shape = (useStore.getState().documents[tabId]?.shapes || []).find(s => s.id === newShapeIdRef.current!);
    if (!shape) return;

    if (['line', 'arrow', 'measure_length'].includes(shape.type)) {
      if (shape.points) {
        updateShape(shape.id, { points: [shape.points[0], shape.points[1], x, y] });
      }
    } else if (shape.type === 'measure_area') {
      // Update the last preview vertex
      if (shape.points && shape.points.length >= 2) {
        const pts = [...shape.points];
        pts[pts.length - 2] = x;
        pts[pts.length - 1] = y;
        updateShape(shape.id, { points: pts });
      }
    } else if (shape.type === 'freehand' || shape.type === 'highlight' || shape.type === 'brush') {
      updateShape(shape.id, { points: [...(shape.points || []), x, y] });
    } else if (shape.type === 'cloud' && shape.cloudMode === 'rect') {
      const originX = drawOriginRef.current?.x ?? shape.x;
      const originY = drawOriginRef.current?.y ?? shape.y;
      const w = Math.abs(x - originX);
      const h = Math.abs(y - originY);
      const minX = Math.min(originX, x);
      const minY = Math.min(originY, y);
      const maxX = Math.max(originX, x);
      const maxY = Math.max(originY, y);
      updateShape(shape.id, {
        points: [minX, minY, minX, maxY, maxX, maxY, maxX, minY],
        width: w, height: h
      });
    } else if (shape.type === 'cloud' && shape.cloudMode === 'circle') {
      const originX = drawOriginRef.current?.x ?? shape.x;
      const originY = drawOriginRef.current?.y ?? shape.y;
      const dx = x - originX, dy = y - originY;
      const radius = Math.sqrt(dx * dx + dy * dy);
      const pts = [];
      const steps = 32;
      for (let i = steps; i > 0; i--) {
        const a = (i / steps) * Math.PI * 2;
        pts.push(originX + Math.cos(a) * radius, originY + Math.sin(a) * radius);
      }
      updateShape(shape.id, { points: pts, radius, width: radius * 2, height: radius * 2 });
    } else if (shape.type === 'arc') {
      if (shape.points) {
        const pts = [...shape.points];
        if (pts.length === 4) {
          pts[2] = x; pts[3] = y; // Preview End
        } else if (pts.length === 6) {
          pts[2] = x; pts[3] = y; // Preview Mid
        }
        updateShape(shape.id, { points: pts });
      }
    } else if ((shape.type === 'cloud' && (!shape.cloudMode || shape.cloudMode === 'polygon')) || shape.type === 'polyline' || shape.type === 'spline') {
      if (shape.points && shape.points.length >= 2) {
        const pts = [...shape.points];
        pts[pts.length - 2] = x;
        pts[pts.length - 1] = y;
        updateShape(shape.id, { points: pts });
      }
    } else if (shape.type === 'rect' || shape.type === 'text' ||
               shape.type === 'stamp' || shape.type === 'image' || shape.type === 'table' ||
               shape.type === 'content_box') {
      const originX = drawOriginRef.current?.x ?? shape.x;
      const originY = drawOriginRef.current?.y ?? shape.y;
      const newX = Math.min(originX, x);
      const newY = Math.min(originY, y);
      const newW = Math.abs(x - originX);
      const newH = Math.abs(y - originY);
      const updates: Partial<ShapeData> = { width: newW, height: newH, x: newX, y: newY };
      // Keep asset transform filling the frame while drawing
      if (shape.type === 'content_box' && shape.assetTransform) {
        updates.assetTransform = { ...shape.assetTransform, width: newW, height: newH };
      }
      updateShape(shape.id, updates);
    } else if (shape.type === 'circle') {
      const originX = drawOriginRef.current?.x ?? shape.x;
      const originY = drawOriginRef.current?.y ?? shape.y;
      const dx = x - originX, dy = y - originY;
      const radius = Math.sqrt(dx * dx + dy * dy);
      updateShape(shape.id, { radius, width: radius * 2, height: radius * 2 });
    } else if (shape.type === 'callout') {
      const originX = drawOriginRef.current?.x ?? shape.x;
      const originY = drawOriginRef.current?.y ?? shape.y;
      const dx = x - originX, dy = y - originY;
      updateShape(shape.id, {
        width:  Math.abs(dx), height: Math.abs(dy),
        x: Math.min(originX, x), y: Math.min(originY, y),
        points: [originX, originY, x, y],
      });
    } else if (shape.type === 'polygon') {
      if (polygonCenterRef.current) {
        const { polygonSides } = useStore.getState();
        const cx = polygonCenterRef.current.x, cy = polygonCenterRef.current.y;
        const dx = x - cx, dy = y - cy;
        const radius = Math.sqrt(dx * dx + dy * dy);
        updateShape(shape.id, {
          x: cx, y: cy,
          points: buildPolygonPoints(cx, cy, radius, polygonSides),
        });
      }
    } else if (isLineMark(shape.type)) {
      // RELATIVE coords: points[0]=0, points[1]=0 always; only end moves
      updateShape(shape.id, { points: [0, 0, x - shape.x, y - shape.y] });
    } else if (isBoxMark(shape.type)) {
      // Resize box as user drags; honour minimum size
      const minW = shape.minWidth || 40;
      const minH = shape.minHeight || 40;
      
      if (shape.type === 'mark_door') {
        const originX = drawOriginRef.current?.x ?? shape.x;
        const originY = drawOriginRef.current?.y ?? shape.y;
        const size = Math.max(Math.abs(x - originX), Math.abs(y - originY), minW);
        updateShape(shape.id, { width: size, height: size });
      } else if (shape.type === 'mark_double_door') {
        const originX = drawOriginRef.current?.x ?? shape.x;
        const originY = drawOriginRef.current?.y ?? shape.y;
        const dx = Math.abs(x - originX);
        const dy = Math.abs(y - originY);
        // Force 2:1 ratio (width is 2x height)
        const w = Math.max(dx, dy * 2, minW);
        updateShape(shape.id, { width: w, height: w / 2 });
      } else {
        updateShape(shape.id, {
          x: Math.min(shape.x, x),
          y: Math.min(shape.y, y),
          width:  Math.max(minW, Math.abs(x - shape.x)),
          height: Math.max(minH, Math.abs(y - shape.y)),
        });
      }
    }
  };

  const handleMouseUp = () => {
    if (!isActive) return;

    if (isResizingBrushRef.current) {
      isResizingBrushRef.current = false;
      return;
    }

    // Finalise drag-selection
    if (selectionBox && activeTool === 'select') {
      const { x, y, w, h } = selectionBox;
      const x1 = Math.min(x, x + w), y1 = Math.min(y, y + h);
      const x2 = Math.max(x, x + w), y2 = Math.max(y, y + h);
      const pdfPageW = pdfNativeSizeRef.current?.w ?? 0;
      const spineGap = 0; // Adjacent pages, no gap

      const contained = (useStore.getState().documents[tabId]?.shapes || [])
        .filter(s => isSpread ? (s.page === spreadLeftPage || (spreadHasRight && s.page === spreadRightPage)) : s.page === pageNum)
        .filter(s => {
          const spreadOffsetX = (spreadHasRight && isSpread && s.page === spreadRightPage && pdfPageW > 0)
            ? pdfPageW + spineGap
            : 0;

          const isLineMarkType = isLineMark(s.type);
          let sMinX = s.x + spreadOffsetX, sMinY = s.y, sMaxX = s.x + spreadOffsetX, sMaxY = s.y;
          if (s.type === 'callout') {
            sMinX = Math.min(s.x, s.x + (s.width || 0)) + spreadOffsetX;
            sMaxX = Math.max(s.x, s.x + (s.width || 0)) + spreadOffsetX;
            sMinY = Math.min(s.y, s.y + (s.height || 0));
            sMaxY = Math.max(s.y, s.y + (s.height || 0));
            if (s.points) {
              for (let i = 0; i < s.points.length; i += 2) {
                const px = spreadOffsetX + s.points[i];
                const py = s.points[i+1];
                sMinX = Math.min(sMinX, px); sMaxX = Math.max(sMaxX, px);
                sMinY = Math.min(sMinY, py); sMaxY = Math.max(sMaxY, py);
              }
            }
          } else if (s.type === 'arrow') {
            sMinX = Infinity; sMinY = Infinity; sMaxX = -Infinity; sMaxY = -Infinity;
            if (s.points && s.points.length >= 2) {
              for (let i = 0; i < s.points.length; i += 2) {
                const px = spreadOffsetX + s.points[i];
                const py = s.points[i+1];
                sMinX = Math.min(sMinX, px); sMaxX = Math.max(sMaxX, px);
                sMinY = Math.min(sMinY, py); sMaxY = Math.max(sMaxY, py);
              }
              if (s.text && s.points.length >= 4) {
                const x = s.points[0];
                const y = s.points[1];
                const isRight = s.points[2] >= s.points[0];
                const tW = s.width || 150;
                const tH = s.height || 40;
                const tx = isRight ? x - tW - 10 : x + 10;
                const ty = y - tH / 2;
                sMinX = Math.min(sMinX, tx + spreadOffsetX);
                sMaxX = Math.max(sMaxX, tx + tW + spreadOffsetX);
                sMinY = Math.min(sMinY, ty);
                sMaxY = Math.max(sMaxY, ty + tH);
              }
            }
          } else if (s.points && s.points.length >= 2 && s.type !== 'polygon') {
            sMinX = Infinity; sMinY = Infinity; sMaxX = -Infinity; sMaxY = -Infinity;
            for (let i = 0; i < s.points.length; i += 2) {
              const px = (isLineMarkType ? (s.x || 0) : 0) + spreadOffsetX + s.points[i];
              const py = (isLineMarkType ? (s.y || 0) : 0) + s.points[i+1];
              sMinX = Math.min(sMinX, px); sMaxX = Math.max(sMaxX, px);
              sMinY = Math.min(sMinY, py); sMaxY = Math.max(sMaxY, py);
            }
          } else if (s.type === 'circle') {
            const r = s.radius || (s.width ? s.width / 2 : 50);
            sMinX = s.x + spreadOffsetX - r; sMaxX = s.x + spreadOffsetX + r;
            sMinY = s.y - r; sMaxY = s.y + r;
          } else if (s.type === 'polygon' && s.points && s.points.length >= 2) {
            sMinX = Infinity; sMinY = Infinity; sMaxX = -Infinity; sMaxY = -Infinity;
            for (let i = 0; i < s.points.length; i += 2) {
              const px = (isLineMarkType ? (s.x || 0) : 0) + spreadOffsetX + s.points[i];
              const py = (isLineMarkType ? (s.y || 0) : 0) + s.points[i+1];
              sMinX = Math.min(sMinX, px); sMaxX = Math.max(sMaxX, px);
              sMinY = Math.min(sMinY, py); sMaxY = Math.max(sMaxY, py);
            }
          } else {
             sMaxX = s.x + spreadOffsetX + Math.abs(s.width || 0);
             sMaxY = s.y + Math.abs(s.height || 0);
             sMinX = s.x + spreadOffsetX; sMinY = s.y;
             if((s.width || 0) < 0) { sMinX = s.x + spreadOffsetX + (s.width || 0); sMaxX = s.x + spreadOffsetX; }
             if((s.height || 0) < 0) { sMinY = s.y + (s.height || 0); sMaxY = s.y; }
          }
          return !(sMaxX < x1 || sMinX > x2 || sMaxY < y1 || sMinY > y2);
        })
        .map(s => s.id);
      setSelectedShapeIds(contained);
      setSelectionBox(null);
      return;
    }

    if (!isDrawingRef.current || !newShapeIdRef.current) return;

    const { activeTool: curTool } = useStore.getState();

    // Cloud (polygon) / polyline / arc / measure_area: don't finalize on mouseup — wait for specific clicks or Escape/Enter
    if ((curTool === 'cloud' && useStore.getState().cloudMode === 'polygon') || curTool === 'polyline' || curTool === 'spline' || curTool === 'arc' || curTool === 'measure_area') return;

    // Line-based marks: don't finalize on mouseup — wait for 2nd click
    if (isLineMark(curTool) || ['line', 'arrow', 'measure_length'].includes(curTool)) return;

    // Polygon: finalize from the current shape state
    if (curTool === 'polygon') {
      polygonCenterRef.current = null;
    }

    const completedId = newShapeIdRef.current;
    isDrawingRef.current  = false;
    newShapeIdRef.current = null;

    if (curTool === 'table' && completedId) {
      const shape = (useStore.getState().documents[tabId]?.shapes || []).find(s => s.id === completedId);
      if (shape && shape.tableData) {
        const w = shape.width || 0;
        const h = shape.height || 0;
        const rows = shape.tableData.rows;
        const cols = shape.tableData.cols;
        // If dragged less than 10x10, use default sizes (e.g. from a double-click or short click)
        const rowH = h > 10 ? h / rows : 30;
        const colW = w > 10 ? w / cols : 100;
        const newTableData = {
          ...shape.tableData,
          rowHeights: Array(rows).fill(rowH),
          colWidths: Array(cols).fill(colW),
        };
        updateShape(shape.id, { tableData: newTableData, width: colW * cols, height: rowH * rows });
      }
    }

    if (completedId && curTool !== 'pan' && curTool !== 'select') {
      setSelectedShapeIds([completedId]);
    }
  };

  const handleShapeDblClick = (e: any, shape: any) => {
    e.cancelBubble = true;
    if (selectedShapeIds.length > 1) return;

    if (shape.id === newShapeIdRef.current) {
      // It's the currently drawing shape. Double click finalizes it!
      const curId = shape.id;
      const liveTool = useStore.getState().activeTool;
      if (['polyline', 'spline', 'cloud', 'measure_area'].includes(liveTool)) {
        if (shape.points && shape.points.length > 4) {
          if (liveTool === 'measure_area') {
            useStore.getState().updateShape(curId, { points: shape.points.slice(0, -2), closed: true });
          } else {
            useStore.getState().updateShape(curId, { points: shape.points.slice(0, -2) });
          }
          setSelectedShapeIds([curId]);
        } else {
          useStore.getState().deleteShape(curId);
        }
        isDrawingRef.current = false;
        newShapeIdRef.current = null;
        useStore.getState().setActiveTool('select');
      }
      return;
    }

    // ── Content Box: double-click toggles frame ⇄ content mode ─────────────────────
    if (shape.type === 'content_box') {
      if (activeTool !== 'select') {
        useStore.getState().setActiveTool('select');
      }
      setSelectedShapeIds([shape.id]);
      const nextMode = shape.contentMode === 'content' ? 'frame' : 'content';
      pushToHistory();
      updateShape(shape.id, { contentMode: nextMode });
      return;
    }

    // Text-capable shapes: always open the inline editor on double-click,
    // regardless of which tool is active. Switch to select tool first so
    // subsequent interactions don't accidentally start new drawings.
    if (['text', 'callout', 'cloud', 'arrow', 'spline'].includes(shape.type)) {
      if (activeTool !== 'select') {
        useStore.getState().setActiveTool('select');
      }
      setSelectedShapeIds([shape.id]);
      const pos = e.currentTarget.getAbsolutePosition();
      let absX = pos.x;
      let absY = pos.y;
      
      if (shape.type === 'cloud' && shape.points && shape.points.length >= 2) { 
        let minX = shape.points[0];
        let minY = shape.points[1];
        for (let i = 0; i < shape.points.length; i += 2) {
          minX = Math.min(minX, shape.points[i]);
          minY = Math.min(minY, shape.points[i + 1]);
        }
        absX = minX * scale + panOffset.x + 10 * scale; 
        absY = minY * scale + panOffset.y + 10 * scale; 
      } else if (['arrow', 'spline'].includes(shape.type) && shape.points && shape.points.length >= 4) {
        const isRight = shape.points[2] >= shape.points[0];
        const tW = shape.width || 150;
        const tH = shape.height || 40;
        const tx = isRight ? shape.points[0] - tW - 10 : shape.points[0] + 10;
        const ty = shape.points[1] - tH / 2;
        absX = tx * scale + panOffset.x;
        absY = ty * scale + panOffset.y;
      }

      const defaultHeight = ['arrow', 'spline'].includes(shape.type) ? 40 : 60;
      const w = (shape.width  || 150) * scale;
      const h = (shape.height || defaultHeight)  * scale;
      setInlineEditText({
        id: shape.id,
        text: shape.text || 'Double click to edit...',
        x: absX,
        y: absY,
        w: Math.max(w, 100),
        h: Math.max(h, 40),
        fontSize: shape.fontSize || 16,
        fontFamily: shape.fontFamily || 'Inter',
        strokeColor: shape.strokeColor || '#000',
        isBold: shape.isBold || false,
        isItalic: shape.isItalic || false,
        isUnderline: shape.isUnderline || false,
        isStrike: shape.isStrike || false
      });
    }
  };

  // ── Workspace middle-click / pan handler (inline, not a useEffect) ──────────
  const handleWorkspaceMouseDown = (e: React.MouseEvent<HTMLElement>) => {
    if (!isActive) return;
    if (e.button === 1 || activeTool === 'pan') {
      e.preventDefault();
      document.body.style.cursor = 'grabbing';
      const handleGlobalMove = (me: MouseEvent) => {
        useStore.getState().setPanOffset(prev => ({
          x: prev.x + me.movementX,
          y: prev.y + me.movementY
        }));
        setIsInteracting(true);
        if (workspaceRef.current) {
          if (interactionTimeoutRef.current) window.clearTimeout(interactionTimeoutRef.current);
          interactionTimeoutRef.current = window.setTimeout(() => setIsInteracting(false), 200);
        }
      };
      const handleGlobalUp = () => {
        document.body.style.cursor = 'default';
        window.removeEventListener('mousemove', handleGlobalMove);
        window.removeEventListener('mouseup', handleGlobalUp);
      };
      window.addEventListener('mousemove', handleGlobalMove);
      window.addEventListener('mouseup', handleGlobalUp);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  if (!isActive) {
    return (
      <main
        className="workspace"
        ref={workspaceRef as any}
        style={{ display: 'none' }}
      />
    );
  }

  return (
    <main
      className="workspace"
      ref={workspaceRef as any}
      onMouseDown={handleWorkspaceMouseDown}
    >
      {savingStatus && (
        <div 
          className="saving-overlay"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onMouseUp={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onKeyDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          <div className="saving-overlay-spinner" />
          <div className="saving-overlay-title">
            {savingStatus.mode === 'export' ? 'Exporting PDF...' : 'Saving Changes...'}
          </div>
          <div className="saving-overlay-progress">
            {savingStatus.progress}%
          </div>
        </div>
      )}
      {!pdfDoc && !isBlankMaster ? (
        <div className="empty-state">
          <p>Please open a PDF to start working.</p>
        </div>
      ) : (
        <div className="workspace-container">
          {viewport && (
            <>
              <div className="sticky-ruler-top"
                style={{ width: '100%', position: 'relative', zIndex: 30, cursor: 's-resize' }}
                onPointerDown={(e) => {
                  if (!isActive) return;
                  e.preventDefault();
                  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                  setDraggingFromRuler({ orientation: 'horizontal' });
                  setGuidePreviewPos({ x: e.clientX, y: e.clientY });
                }}
                onPointerMove={(e) => {
                  if (!draggingFromRuler || draggingFromRuler.orientation !== 'horizontal') return;
                  setGuidePreviewPos({ x: e.clientX, y: e.clientY });
                }}
                onPointerUp={(e) => {
                  if (!draggingFromRuler || draggingFromRuler.orientation !== 'horizontal') return;
                  (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
                  setDraggingFromRuler(null);
                  const wrapperEl = workspaceRef.current?.querySelector('.canvas-wrapper');
                  if (!wrapperEl) return;
                  const rect = wrapperEl.getBoundingClientRect();
                  if (e.clientY > rect.top && e.clientY < rect.bottom) {
                    const pos = (e.clientY - rect.top - panOffset.y) / scale;
                    useStore.getState().addGuide({ id: Date.now().toString(), orientation: 'horizontal', position: pos });
                  }
                }}
              >
                <div style={{ marginLeft: 30, position: 'relative', height: '100%', width: '100%', overflow: 'hidden' }}>
                  {(() => {
                    const pageW = pdfNativeSizeRef.current ? pdfNativeSizeRef.current.w * scale : (viewport?.width ?? 0);
                    const boundsX = isSpread ? pageW * (spreadHasRight ? 2 : 1) : pageW;
                    return (
                      <RulerCanvas size={30} scale={scale} calibration={scaleCalibration} viewportSize={stageSize.width} panOffset={panOffset.x}
                        pdfBounds={boundsX} />
                    );
                  })()}
                </div>
              </div>

              <div style={{ display: 'flex', position: 'relative', flex: 1, overflow: 'hidden', minHeight: 0 }}>
                <div className="sticky-ruler-left"
                  style={{ flexShrink: 0, width: 30, position: 'relative', zIndex: 30, cursor: 'e-resize' }}
                  onPointerDown={(e) => {
                    if (!isActive) return;
                    e.preventDefault();
                    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                    setDraggingFromRuler({ orientation: 'vertical' });
                    setGuidePreviewPos({ x: e.clientX, y: e.clientY });
                  }}
                  onPointerMove={(e) => {
                    if (!draggingFromRuler || draggingFromRuler.orientation !== 'vertical') return;
                    setGuidePreviewPos({ x: e.clientX, y: e.clientY });
                  }}
                  onPointerUp={(e) => {
                    if (!draggingFromRuler || draggingFromRuler.orientation !== 'vertical') return;
                    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
                    setDraggingFromRuler(null);
                    const wrapperEl = workspaceRef.current?.querySelector('.canvas-wrapper');
                    if (!wrapperEl) return;
                    const rect = wrapperEl.getBoundingClientRect();
                    if (e.clientX > rect.left && e.clientX < rect.right) {
                      const pos = (e.clientX - rect.left - panOffset.x) / scale;
                      useStore.getState().addGuide({ id: Date.now().toString(), orientation: 'vertical', position: pos });
                    }
                  }}
                >
                  <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
                    {(() => {
                      const pageH = pdfNativeSizeRef.current ? pdfNativeSizeRef.current.h * scale : (viewport?.height ?? 0);
                      return (
                        <RulerCanvas vertical size={30} scale={scale} calibration={scaleCalibration} viewportSize={window.innerHeight} panOffset={panOffset.y}
                          pdfBounds={pageH} />
                      );
                    })()}
                  </div>
                </div>

                <div className="canvas-wrapper" style={{
                  position: 'relative', zIndex: 1, overflow: 'hidden',
                  width: '100%', height: '100%',
                  backgroundColor: 'transparent',
                }}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
                  onDrop={(e) => {
                    e.preventDefault();
                    tauriLog("wrapper onDrop event triggered");
                    
                    const ingestImageUrl = (url: string) => {
                      tauriLog("wrapper onDrop ingestImageUrl: " + url.substring(0, 50));
                      handleImageDrop(url, e.clientX, e.clientY);
                    };

                    // ── 1. Asset-panel drag (text/plain URL) ───────────────────────────────
                    const textUrl = e.dataTransfer.getData('text/plain');
                    tauriLog("wrapper onDrop textUrl: " + textUrl);
                    if (textUrl) { ingestImageUrl(textUrl); return; }

                    // ── 2. OS file drop ────────────────────────────────────────────────────
                    const file = e.dataTransfer.files?.[0];
                    if (file) {
                      tauriLog("wrapper onDrop file: name=" + file.name + " type=" + file.type);
                      if (file.type.startsWith('image/')) {
                        const reader = new FileReader();
                        reader.onload = () => { if (reader.result) ingestImageUrl(reader.result as string); };
                        reader.readAsDataURL(file);
                      } else if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
                        const reader = new FileReader();
                        reader.onload = async () => {
                          if (reader.result) {
                            try {
                              const arrayBuffer = reader.result as ArrayBuffer;
                              const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
                              const page = await pdf.getPage(1);
                              
                              // Render page to off-screen canvas at high resolution
                              const canvas = document.createElement('canvas');
                              const ctx = canvas.getContext('2d');
                              if (ctx) {
                                const vp = page.getViewport({ scale: 2.0 });
                                canvas.width = vp.width;
                                canvas.height = vp.height;
                                
                                // Draw white background for transparency fallback
                                ctx.fillStyle = '#ffffff';
                                ctx.fillRect(0, 0, canvas.width, canvas.height);
                                
                                await page.render({ canvasContext: ctx, viewport: vp } as any).promise;
                                const dataUrl = canvas.toDataURL('image/png');
                                ingestImageUrl(dataUrl);
                              }
                            } catch (err) {
                              tauriLog("Error rendering dropped PDF: " + err);
                            }
                          }
                        };
                        reader.readAsArrayBuffer(file);
                      }
                    } else {
                      tauriLog("wrapper onDrop no file and no textUrl");
                    }
                  }}
                >
                  <div className="canvas-container" style={{
                    position: 'relative', width: '100%', height: '100%',
                    backgroundColor: 'transparent',
                  }}>

                    {/* LOW-RES BASE CANVAS — always visible, scales directly alongside viewport via panOffset.
                        In spread mode its CSS width is doubled to cover both pages. */}
                    <canvas
                      ref={baseCanvasRef}
                      className="pdf-canvas-base"
                      style={{
                        display: layersVisible.base ? 'block' : 'none',
                        position: 'absolute', top: 0, left: 0,
                        transform: `translate(${panOffset.x}px, ${panOffset.y}px)`,
                        // Spread: canvas paints both pages adjacent
                        width:  pdfNativeSizeRef.current
                          ? pdfNativeSizeRef.current.w * (spreadHasRight ? 2 : 1) * scale
                          : ((doc?.pageWidth || 612) * (spreadHasRight ? 2 : 1) * scale),
                        height: pdfNativeSizeRef.current 
                          ? pdfNativeSizeRef.current.h * scale 
                          : ((doc?.pageHeight || 792) * scale),
                        opacity: isInteracting ? 0.7 : 1.0,
                        transition: 'opacity 0.2s ease-in-out',
                        boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
                        background: 'white',
                      }}
                    />


                    {/* HI-RES OVERLAY — tiled: the render effect sets transform/width/height imperatively.
                         Always mounted so the DOM element persists across zoom/pan; opacity hides the
                         stale tile during active interaction so it doesn't float at the wrong position. */}
                    <canvas
                      ref={highResCanvasRef}
                      className="pdf-canvas-hires"
                      style={{
                        display: layersVisible.base ? 'block' : 'none',
                        position: 'absolute', top: 0, left: 0,
                        // Fade out while interacting so the stale tile doesn't show at the wrong position.
                        // Fade back in after the new tile has been painted by the render effect.
                        opacity: isInteracting ? 0 : 1,
                        transition: isInteracting ? 'none' : 'opacity 0.15s ease-in',
                        // transform, width, height are set imperatively by the tiled render effect.
                        imageRendering: 'crisp-edges',
                      }}
                    />

                     {/* MASTER PAGE BACKGROUND PDF -- renders the master background PDF(s)
                          behind the Konva canvas stack. Pointer-events: none. Tracks panOffset.
                          In spread mode, renders for both left and right pages. */}
                     {(() => {
                       // `doc` = this tab's document (subscribed above)
                       const assignments = doc?.masterPageAssignments || {};
                       const pageW = pdfNativeSizeRef.current?.w || 612;
                       const pageH = pdfNativeSizeRef.current?.h || 792;

                       const elements: React.ReactNode[] = [];

                       // Left page (or current page in single mode)
                       const leftPageKey = isSpread ? spreadLeftPage : pageNum;
                       const leftMasterId = assignments[leftPageKey] ?? null;
                       const leftMaster = leftMasterId ? masterPages.find(m => m.id === leftMasterId) : null;
                       if (leftMaster?.backgroundPdfBytes) {
                         const offsetX = (pageW - leftMaster.pageWidth) / 2;
                         const offsetY = (pageH - leftMaster.pageHeight) / 2;
                         elements.push(
                           <MasterBgCanvas
                             key={`bg-left-${leftMasterId}`}
                             master={leftMaster}
                             scale={scale}
                             panOffset={panOffset}
                             offsetX={offsetX}
                             offsetY={offsetY}
                           side="left"
                            />
                         );
                       }

                       // Right page in spread mode
                       if (isSpread && spreadHasRight) {
                         const rightMasterId = assignments[spreadRightPage] ?? null;
                         const rightMaster = rightMasterId ? masterPages.find(m => m.id === rightMasterId) : null;
                         if (rightMaster?.backgroundPdfBytes) {
                           const offsetX = (pageW - rightMaster.pageWidth) / 2;
                           const offsetY = (pageH - rightMaster.pageHeight) / 2;
                           // Right page starts at pageW + 4 pts (constant gap)
                           elements.push(
                             <MasterBgCanvas
                               key={`bg-right-${rightMasterId}`}
                               master={rightMaster}
                               scale={scale}
                               panOffset={panOffset}
                               offsetX={pageW + offsetX}
                               offsetY={offsetY}
                             side="right"
                              />
                           );
                         }
                       }

                       return elements.length > 0 ? <>{elements}</> : null;
                     })()}

                    {/* KONVA MARKUP STAGE - Infinite Panning */}
                    <div className="konva-container">
                    <Stage
                        ref={stageRef}
                        width={stageSize.width} height={stageSize.height}
                        draggable={activeTool === 'pan'}
                        x={panOffset.x}
                        y={panOffset.y}
                        onDblClick={(e) => {
                          if (e.target === e.target.getStage() || e.target.hasName('background-placeholder')) {
                            const curId = newShapeIdRef.current;
                            if (curId) {
                              const liveTool = useStore.getState().activeTool;
                              if (['polyline', 'spline', 'cloud', 'measure_area'].includes(liveTool)) {
                                const shape = (useStore.getState().documents[tabId]?.shapes || []).find(s => s.id === curId);
                                if (shape && shape.points && shape.points.length > 4) {
                                  if (liveTool === 'measure_area') {
                                    useStore.getState().updateShape(curId, { points: shape.points.slice(0, -2), closed: true });
                                  } else {
                                    useStore.getState().updateShape(curId, { points: shape.points.slice(0, -2) });
                                  }
                                  setSelectedShapeIds([curId]);
                                } else {
                                  useStore.getState().deleteShape(curId);
                                }
                                isDrawingRef.current = false;
                                newShapeIdRef.current = null;
                                useStore.getState().setActiveTool('select');
                              }
                            }
                          }
                        }}
                        onDragStart={(e) => {
                          if (e.target === stageRef.current) {
                            isStageDraggingRef.current = true;
                            setIsInteracting(true);
                          }
                        }}
                        onDragMove={(e) => {
                          // ── Pan jitter fix ───────────────────────────────────────────────────
                          // NEVER write to Zustand here. Writing panOffset every frame triggers
                          // React re-renders that push stale x/y props back onto the Stage,
                          // creating a violent tug-of-war with Konva's native drag engine.
                          //
                          // Instead: let Konva own the Stage position natively during the drag.
                          // Imperatively update the base canvas CSS transform so it tracks the
                          // drag without going through React at all.
                          // NOTE: the hi-res canvas is unmounted during drag (isInteracting=true),
                          // so there is no need to update it here.
                          if (e.target !== stageRef.current) return;
                          const lx = e.target.x();
                          const ly = e.target.y();
                          if (baseCanvasRef.current) {
                            baseCanvasRef.current.style.transform = `translate(${lx}px, ${ly}px)`;
                          }
                          // Keep the interacting flag alive (suppresses hi-res overlay)
                          if (interactionTimeoutRef.current) window.clearTimeout(interactionTimeoutRef.current);
                        }}
                        onDragEnd={(e) => {
                          // Single Zustand write when the drag finishes → one clean re-render.
                          if (e.target === stageRef.current) {
                            isStageDraggingRef.current = false;
                            const finalX = e.target.x();
                            const finalY = e.target.y();
                            useStore.getState().setPanOffset({ x: finalX, y: finalY });
                            // After the state update React will re-render and restore the
                            // declarative transforms; clear isInteracting after a short delay
                            // so the hi-res overlay re-renders once the pan has settled.
                            interactionTimeoutRef.current = window.setTimeout(() => setIsInteracting(false), 200);
                          }
                        }}
                        onMouseDown={handleMouseDown}
                        onMouseMove={(e) => {
                          handleMouseMove(e);
                          // ── Spread activeSide tracking ──
                          if (isSpread && isActive && pdfNativeSizeRef.current) {
                            const stage = stageRef.current;
                            if (stage) {
                              const rawX = (e.evt.clientX - stage.container().getBoundingClientRect().left - panOffset.x) / scale;
                              const spineX = pdfNativeSizeRef.current.w; // Midpoint in canvas units
                              const newSide: 1 | 2 = rawX < spineX ? 1 : 2;
                              const liveDoc = useStore.getState().documents[tabId];
                              if (liveDoc?.activeSide !== newSide) {
                                useStore.getState().setActiveSide(newSide);
                              }
                            }
                          }
                        }}
                        onMouseUp={handleMouseUp}
                        onContextMenu={(e) => { if (activeTool === 'brush') e.evt.preventDefault(); }}
                        opacity={inlineEditText ? 0.3 : 1.0}
                      >
                         {/* -- MASTER PAGE UNDERLAY LAYER --------------------------------------------------
                              First layer in the Stage -> renders BELOW all document markup.
                              listening={false} makes every element pointer-dead (glass shield). */}
                         <MasterUnderlayLayer
                           tabId={tabId}
                           pageNum={pageNum}
                           scale={scale}
                           totalPages={doc?.numPages || 0}
                           documentPageWidth={pdfNativeSizeRef.current?.w || 612}
                           documentPageHeight={pdfNativeSizeRef.current?.h || 792}
                         />
                        <Layer
                           scaleX={scale} scaleY={scale}
                         >
                           {/* Bleed & Trim Guides */}
                           {showBleedGuides && pdfNativeSizeRef.current && (() => {
                             const pageW = pdfNativeSizeRef.current.w;
                             const pageH = pdfNativeSizeRef.current.h;
                             const totalW = pageW * (spreadHasRight ? 2 : 1);
                             const bleedPts = bleedOffset * 72;

                             return (
                               <>
                                 {/* Trim Box Outline for Left Page / Solo Page */}
                                 <Rect
                                   x={0}
                                   y={0}
                                   width={pageW}
                                   height={pageH}
                                   stroke="#22d3ee"
                                   strokeWidth={1 / scale}
                                   listening={false}
                                 />
                                 {/* Trim Box Outline for Right Page in Spread */}
                                 {isSpread && spreadHasRight && (
                                   <Rect
                                     x={pageW}
                                     y={0}
                                     width={pageW}
                                     height={pageH}
                                     stroke="#22d3ee"
                                     strokeWidth={1 / scale}
                                     listening={false}
                                   />
                                 )}

                                 {/* Bleed Box Outline */}
                                 {bleedOffset > 0 && (
                                   <Rect
                                     x={-bleedPts}
                                     y={-bleedPts}
                                     width={totalW + 2 * bleedPts}
                                     height={pageH + 2 * bleedPts}
                                     stroke="#10b981"
                                     strokeWidth={1.5 / scale}
                                     dash={[6 / scale, 6 / scale]}
                                     listening={false}
                                   />
                                 )}
                               </>
                             );
                           })()}

                           {/* Spine divider guide for spreads (removed) */}
                           {/* Filter shapes: in spread mode show both left and right pages; in single mode just current page */}
                           {shapes.filter(s =>
                             isMasterTab
                               ? true
                               : (isSpread
                                   ? (s.page === spreadLeftPage || (spreadHasRight && s.page === spreadRightPage))
                                   : s.page === pageNum)
                           ).map(shape => {
                             // In spread mode, right-page shapes have their x shifted by pageWidth
                             const spreadOffsetX = (!isMasterTab && spreadHasRight && isSpread && shape.page === spreadRightPage && pdfNativeSizeRef.current)
                               ? pdfNativeSizeRef.current.w
                               : 0;
                             // origShape = real store data (used in interaction callbacks)
                             // shape = effective rendering shape (with offset applied for right page)
                             const origShape = shape;
                             const effectiveShape = spreadOffsetX !== 0
                               ? {
                                   ...shape,
                                   x: shape.x + spreadOffsetX,
                                   points: POINT_BASED_TYPES.includes(shape.type) ? shape.points ? shape.points.map((p, i) => i % 2 === 0 ? p + spreadOffsetX : p) : shape.points : shape.points,
                                 }
                               : shape;
                             // Shadow 'shape' with the offset-adjusted version for all render calls below
                             // eslint-disable-next-line no-param-reassign
                             shape = effectiveShape;
                             if (!layersVisible.active && shape.type !== 'image') return null;
                             if (!layersVisible.chest && shape.type === 'image')  return null;

                             const commonProps = {
                               id: `shape-${shape.id}`,
                               perfectDrawEnabled: false,
                               shadowForStrokeEnabled: false,
                               currentScale: scale,
                               draggable: activeTool === 'select' || selectedShapeIds.includes(shape.id),
                               dragBoundFunc: (activeTool === 'select' || selectedShapeIds.includes(shape.id))
                                 ? (pos: any) => {
                                     return pos;
                                   }
                                 : undefined,
                              onClick: (e: any) => { 
                                if (activeTool === 'select') {
                                  if (e.evt.shiftKey) {
                                    if (selectedShapeIds.includes(shape.id)) {
                                      setSelectedShapeIds(selectedShapeIds.filter(id => id !== shape.id));
                                    } else {
                                      setSelectedShapeIds([...selectedShapeIds, shape.id]);
                                    }
                                  } else {
                                    setSelectedShapeIds([shape.id]);
                                  }
                                } 
                              },
                              onDragStart: (e: any) => {
                                 e.cancelBubble = true;
                                 if (e.evt && e.evt.button !== 0) { e.currentTarget.stopDrag(); return; }
                                 pushToHistory();

                                 const state = useStore.getState();
                                 const tabId = state.activeTabId;
                                 let activeSelectedIds = tabId ? state.documents[tabId]?.selectedShapeIds || [] : [];

                                 // Select the shape immediately if it's not already in the selection group
                                 if (!activeSelectedIds.includes(shape.id)) {
                                   if (e.evt && e.evt.shiftKey) {
                                     setSelectedShapeIds([...activeSelectedIds, shape.id]);
                                     activeSelectedIds = [...activeSelectedIds, shape.id];
                                   } else {
                                     setSelectedShapeIds([shape.id]);
                                     activeSelectedIds = [shape.id];
                                   }
                                 }

                                 // Store initial position & rotation on the Konva node itself
                                 const node = e.currentTarget;
                                 const stage = node.getStage();
                                 if (stage) {
                                   activeSelectedIds.forEach((id: string) => {
                                       const n = stage.findOne(`#shape-${id}`);
                                       if (n) {
                                         n.setAttr('dragInitialX', n.x());
                                         n.setAttr('dragInitialY', n.y());
                                         n.setAttr('dragInitialRot', n.rotation() || 0);
                                       }

                                       // Store initial positions of all control handles for this shape
                                       const s = shapes.find(x => x.id === id);
                                       if (s) {
                                         // 1. Vertex handles
                                         if (s.points) {
                                           for (let i = 0; i < s.points.length; i += 2) {
                                             const h = stage.findOne(`#vertex-handle-${id}-${i}`);
                                             if (h) {
                                               h.setAttr('dragInitialX', h.x());
                                               h.setAttr('dragInitialY', h.y());
                                             }
                                           }
                                         }
                                         // 2. Callout handles
                                         if (s.type === 'callout') {
                                           ['box', 'width', 'height', 'corner'].forEach(suffix => {
                                             const h = stage.findOne(`#callout-handle-${id}-${suffix}`);
                                             if (h) {
                                               h.setAttr('dragInitialX', h.x());
                                               h.setAttr('dragInitialY', h.y());
                                             }
                                           });
                                         }
                                         // 3. Arrow/Spline text handles
                                         if (['arrow', 'spline'].includes(s.type)) {
                                           ['width', 'height', 'corner'].forEach(suffix => {
                                             const h = stage.findOne(`#arrow-text-handle-${id}-${suffix}`);
                                             if (h) {
                                               h.setAttr('dragInitialX', h.x());
                                               h.setAttr('dragInitialY', h.y());
                                             }
                                           });
                                         }
                                         // 4. Child callouts of a cloud
                                         if (s.type === 'cloud') {
                                           shapes.forEach(child => {
                                             if (child.type === 'callout' && child.parentId === id) {
                                               const cn = stage.findOne(`#shape-${child.id}`);
                                               if (cn) {
                                                 cn.setAttr('dragInitialX', cn.x());
                                                 cn.setAttr('dragInitialY', cn.y());
                                               }
                                               ['box', 'width', 'height', 'corner'].forEach(suffix => {
                                                 const h = stage.findOne(`#callout-handle-${child.id}-${suffix}`);
                                                 if (h) {
                                                   h.setAttr('dragInitialX', h.x());
                                                   h.setAttr('dragInitialY', h.y());
                                                 }
                                               });
                                             }
                                           });
                                         }
                                       }
                                     });

                                   const pointerPos = stage.getPointerPosition();
                                   if (pointerPos) {
                                     const mouseX = (pointerPos.x - stage.x()) / scale;
                                     const mouseY = (pointerPos.y - stage.y()) / scale;
                                     dragStartMouseOffsetRef.current = {
                                       x: mouseX - node.x(),
                                       y: mouseY - node.y()
                                     };
                                     if (!dragStartMousePosRef.current) {
                                       dragStartMousePosRef.current = { x: mouseX, y: mouseY };
                                     }
                                   }
                                 }
                                 dragInitialRotRef.current = node.rotation() || 0;
                                 setSmartGuides({ vertical: null, horizontal: null });

                                 if (e.evt && e.evt.ctrlKey && e.evt.altKey && activeSelectedIds.includes(shape.id)) {
                                   if (!hasClonedThisDragRef.current) {
                                     hasClonedThisDragRef.current = true;
                                     const clones: ShapeData[] = [];
                                   activeSelectedIds.forEach((id: string) => {
                                     const s = shapes.find(x => x.id === id);
                                     if (!s) return;
                                     
                                     if (s.type === 'callout' && s.parentId && activeSelectedIds.includes(s.parentId)) {
                                       return; // Child callouts are duplicated by their parent
                                     }
                                     
                                     const newId = Math.random().toString(36).substring(7);
                                     clones.push({ ...s, id: newId });
                                     
                                     if (s.type === 'cloud') {
                                       const callouts = shapes.filter(child => child.type === 'callout' && child.parentId === s.id);
                                       callouts.forEach(child => {
                                         clones.push({ ...child, id: Math.random().toString(36).substring(7), parentId: newId });
                                       });
                                     }
                                   });
                                   
                                   clones.forEach(c => state.addShape(c));
                                   }
                                 }
                               },
                               onDragMove: (e: any) => {
                                 e.cancelBubble = true;
                                 if (trRef.current) trRef.current.update();

                                 const node = e.currentTarget;
                                 const stage = node.getStage();
                                 if (stage && dragStartMouseOffsetRef.current) {
                                   const pointerPos = stage.getPointerPosition();
                                   if (pointerPos) {
                                     const mouseX = (pointerPos.x - stage.x()) / scale;
                                     const mouseY = (pointerPos.y - stage.y()) / scale;

                                     const state = useStore.getState();
                                     const tabId = state.activeTabId;
                                     const activeSelectedIds = tabId ? state.documents[tabId]?.selectedShapeIds || [] : [];

                                     if (activeSelectedIds.length > 1) {
                                       if (dragStartMousePosRef.current) {
                                         const dx = mouseX - dragStartMousePosRef.current.x;
                                         const dy = mouseY - dragStartMousePosRef.current.y;

                                         if (!snapCalculatedThisFrameRef.current) {
                                           let parallelSnap = null;
                                           let leaderInitX = 0;
                                           let leaderInitY = 0;
                                           const leaderId = dragLeaderIdRef.current || activeSelectedIds[0];
                                           if (leaderId) {
                                             const leaderShape = shapes.find(s => s.id === leaderId);
                                             const leaderNode = stage.findOne(`#shape-${leaderId}`);
                                             if (leaderShape && leaderNode) {
                                               leaderInitX = leaderNode.getAttr('dragInitialX') ?? leaderShape.x;
                                               leaderInitY = leaderNode.getAttr('dragInitialY') ?? leaderShape.y;
                                               const leaderInitRot = leaderNode.getAttr('dragInitialRot') ?? leaderShape.rotation ?? 0;

                                               const leaderUnsnappedX = leaderInitX + dx;
                                               const leaderUnsnappedY = leaderInitY + dy;

                                               parallelSnap = getParallelSnap(leaderUnsnappedX, leaderUnsnappedY, leaderShape.id, leaderInitRot);
                                             }
                                           }

                                           if (parallelSnap) {
                                             snappedOffsetRef.current = {
                                               dx: parallelSnap.x - leaderInitX,
                                               dy: parallelSnap.y - leaderInitY,
                                               vertical: null,
                                               horizontal: null
                                             };
                                             setParallelSnapGuide(parallelSnap.segment);
                                             setSmartGuides({ vertical: null, horizontal: null });
                                           } else {
                                             setParallelSnapGuide(null);

                                             const manualSnap = getManualGuidesSnap(dx, dy, activeSelectedIds);
                                             if (manualSnap) {
                                               snappedOffsetRef.current = {
                                                 dx: manualSnap.dx,
                                                 dy: manualSnap.dy,
                                                 vertical: manualSnap.vertical,
                                                 horizontal: manualSnap.horizontal
                                               };
                                               setSmartGuides({
                                                 vertical: manualSnap.vertical,
                                                 horizontal: manualSnap.horizontal
                                               });
                                             } else {
                                               const smartSnap = getSmartGuidesSnap(dx, dy, activeSelectedIds, origShape.page);
                                               if (smartSnap) {
                                                 snappedOffsetRef.current = {
                                                   dx: smartSnap.dx,
                                                   dy: smartSnap.dy,
                                                   vertical: smartSnap.vertical,
                                                   horizontal: smartSnap.horizontal
                                                 };
                                                 setSmartGuides({
                                                   vertical: smartSnap.vertical,
                                                   horizontal: smartSnap.horizontal
                                                 });
                                               } else {
                                                 snappedOffsetRef.current = {
                                                   dx,
                                                   dy,
                                                   vertical: null,
                                                   horizontal: null
                                                 };
                                                 setSmartGuides({ vertical: null, horizontal: null });
                                               }
                                             }
                                           }

                                           snapCalculatedThisFrameRef.current = true;
                                           setTimeout(() => {
                                             snapCalculatedThisFrameRef.current = false;
                                           }, 0);
                                         }

                                         activeSelectedIds.forEach((id: string) => {
                                             const n = stage.findOne(`#shape-${id}`);
                                             if (n) {
                                               const ix = n.getAttr('dragInitialX');
                                               const iy = n.getAttr('dragInitialY');
                                               const ir = n.getAttr('dragInitialRot') ?? 0;
                                               if (ix !== undefined && iy !== undefined) {
                                                 const finalDx = snappedOffsetRef.current.dx;
                                                 const finalDy = snappedOffsetRef.current.dy;
                                                 n.x(ix + finalDx);
                                                 n.y(iy + finalDy);
                                                 const s = shapes.find(x => x.id === id);
                                                 if (s && !POINT_BASED_TYPES.includes(s.type)) {
                                                   n.rotation(ir);
                                                 }
                                                 // Update handles and children
                                                 updateHandlesPosition(id, finalDx, finalDy);
                                                 updateChildCallouts(id, finalDx, finalDy);
                                               }
                                             }
                                           });
                                         if (trRef.current) {
                                           trRef.current.update();
                                           trRef.current.getLayer()?.batchDraw();
                                         }
                                       }
                                       return;
                                     }

                                     const unsnappedX = mouseX - dragStartMouseOffsetRef.current.x;
                                     const unsnappedY = mouseY - dragStartMouseOffsetRef.current.y;

                                     const snapResult = getParallelSnap(unsnappedX, unsnappedY, origShape.id, dragInitialRotRef.current);
                                     if (snapResult) {
                                       node.x(snapResult.x);
                                       node.y(snapResult.y);
                                       if (!POINT_BASED_TYPES.includes(shape.type)) {
                                         node.rotation(snapResult.rotation);
                                       }
                                       // Update handles and children
                                       const finalDx = snapResult.x - (node.getAttr('dragInitialX') ?? 0);
                                       const finalDy = snapResult.y - (node.getAttr('dragInitialY') ?? 0);
                                       updateHandlesPosition(origShape.id, finalDx, finalDy);
                                       updateChildCallouts(origShape.id, finalDx, finalDy);

                                       setParallelSnapGuide(snapResult.segment);
                                       setSmartGuides({ vertical: null, horizontal: null });
                                       if (trRef.current) {
                                         trRef.current.update();
                                         trRef.current.getLayer()?.batchDraw();
                                       }
                                     } else {
                                       setParallelSnapGuide(null);
                                       
                                       const initX = node.getAttr('dragInitialX') ?? node.x();
                                       const initY = node.getAttr('dragInitialY') ?? node.y();
                                       const initRot = node.getAttr('dragInitialRot') ?? node.rotation() ?? 0;
                                       
                                       const dx = unsnappedX - initX;
                                       const dy = unsnappedY - initY;
                                       const selectIds = activeSelectedIds.includes(origShape.id) ? activeSelectedIds : [origShape.id];
                                       
                                       if (!snapCalculatedThisFrameRef.current) {
                                         const manualSnap = getManualGuidesSnap(dx, dy, selectIds);
                                         if (manualSnap) {
                                           snappedOffsetRef.current = {
                                             dx: manualSnap.dx,
                                             dy: manualSnap.dy,
                                             vertical: manualSnap.vertical,
                                             horizontal: manualSnap.horizontal
                                           };
                                         } else {
                                           const smartSnap = getSmartGuidesSnap(dx, dy, selectIds, origShape.page);
                                           if (smartSnap) {
                                             snappedOffsetRef.current = {
                                               dx: smartSnap.dx,
                                               dy: smartSnap.dy,
                                               vertical: smartSnap.vertical,
                                               horizontal: smartSnap.horizontal
                                             };
                                           } else {
                                             snappedOffsetRef.current = {
                                               dx,
                                               dy,
                                               vertical: null,
                                               horizontal: null
                                             };
                                           }
                                         }
                                         snapCalculatedThisFrameRef.current = true;
                                         setTimeout(() => {
                                           snapCalculatedThisFrameRef.current = false;
                                         }, 0);
                                         setSmartGuides({
                                           vertical: snappedOffsetRef.current.vertical,
                                           horizontal: snappedOffsetRef.current.horizontal
                                         });
                                       }

                                       const finalDx = snappedOffsetRef.current.dx;
                                       const finalDy = snappedOffsetRef.current.dy;
                                       node.x(initX + finalDx);
                                       node.y(initY + finalDy);
                                       if (!POINT_BASED_TYPES.includes(shape.type)) {
                                         node.rotation(initRot);
                                       }
                                       // Update handles and children
                                       updateHandlesPosition(origShape.id, finalDx, finalDy);
                                       updateChildCallouts(origShape.id, finalDx, finalDy);
                                       if (trRef.current) {
                                         trRef.current.update();
                                         trRef.current.getLayer()?.batchDraw();
                                       }
                                     }
                                   }
                                 }
                               },
                               onDragEnd: (e: any) => {
                                 e.cancelBubble = true;
                                 hasClonedThisDragRef.current = false;

                                 const state = useStore.getState();
                                 const tabId = state.activeTabId;
                                 const activeSelectedIds = tabId ? state.documents[tabId]?.selectedShapeIds || [] : [];

                                 if (activeSelectedIds.length > 1) {
                                   if (!dragStartMousePosRef.current) {
                                     return;
                                   }
                                   dragStartMousePosRef.current = null;

                                   // Update all selected shapes in the store
                                   activeSelectedIds.forEach((id: string) => {
                                     const s = shapes.find(x => x.id === id);
                                     if (!s) return;
                                     const n = stageRef.current?.findOne(`#shape-${id}`);
                                     if (!n) return;

                                     const otherOffsetX = (!isMasterTab && spreadHasRight && isSpread && s.page === spreadRightPage && pdfNativeSizeRef.current)
                                       ? pdfNativeSizeRef.current.w
                                       : 0;

                                     if (POINT_BASED_TYPES.includes(s.type)) {
                                       const dx = n.x(), dy = n.y();
                                       if (s.points) {
                                         const newPoints = s.points.map((p, i) => i % 2 === 0 ? p + dx : p + dy);
                                         n.x(0); n.y(0);
                                         updateShape(id, { points: newPoints, x: s.x + dx, y: s.y + dy });
                                         if (s.type === 'cloud') {
                                           shapes.forEach(child => {
                                             if (child.type === 'callout' && child.parentId === id && child.points) {
                                               // Reset child Group to (0,0) before store update to avoid double-offset.
                                               const childGroupNode = stageRef.current?.findOne(`#shape-${child.id}`);
                                               if (childGroupNode) { childGroupNode.x(0); childGroupNode.y(0); }
                                               updateShape(child.id, {
                                                 x: child.x + dx, y: child.y + dy,
                                                 points: child.points.map((p, i) => i % 2 === 0 ? p + dx : p + dy),
                                               });
                                             }
                                           });
                                         }
                                       }
                                     } else {
                                       updateShape(id, {
                                         x: n.x() - otherOffsetX,
                                         y: n.y(),
                                         rotation: n.rotation()
                                       });
                                     }
                                   });
                                   
                                   setParallelSnapGuide(null);
                                   setSmartGuides({ vertical: null, horizontal: null });
                                   dragStartMouseOffsetRef.current = null;
                                   dragLeaderIdRef.current = null;
                                   snapCalculatedThisFrameRef.current = false;
                                   return;
                                 }

                                 // For right-page shapes in spread mode, strip the visual offset
                                 // before writing back to the store so coords stay page-relative.
                                 const _soX = spreadOffsetX; // captured in closure
                                 if (POINT_BASED_TYPES.includes(shape.type)) {
                                   const dx = e.currentTarget.x(), dy = e.currentTarget.y();
                                   if (origShape.points) {
                                     const newPoints = origShape.points.map((p, i) => i % 2 === 0 ? p + dx : p + dy);
                                     e.currentTarget.x(0); e.currentTarget.y(0);
                                     updateShape(origShape.id, { points: newPoints, x: origShape.x + dx, y: origShape.y + dy });
                                     if (origShape.type === 'cloud') {
                                       const dragStage = e.currentTarget.getStage();
                                       shapes.forEach(child => {
                                         if (child.type === 'callout' && child.parentId === origShape.id && child.points) {
                                           // Reset child Group to (0,0) before store update to avoid double-offset.
                                           // During live drag updateChildCallouts imperatively moved this node to (dx,dy).
                                           const childGroupNode = dragStage?.findOne(`#shape-${child.id}`);
                                           if (childGroupNode) { childGroupNode.x(0); childGroupNode.y(0); }
                                           updateShape(child.id, {
                                             x: child.x + dx, y: child.y + dy,
                                             points: child.points.map((p, i) => i % 2 === 0 ? p + dx : p + dy),
                                           });
                                         }
                                       });
                                     }
                                   }
                                 } else {
                                   updateShape(origShape.id, {
                                     x: e.currentTarget.x() - _soX,
                                     y: e.currentTarget.y(),
                                     rotation: e.currentTarget.rotation()
                                   });
                                 }
                                 setParallelSnapGuide(null);
                                 setSmartGuides({ vertical: null, horizontal: null });
                                 dragStartMouseOffsetRef.current = null;
                                 dragStartMousePosRef.current = null;
                                 dragLeaderIdRef.current = null;
                                 snapCalculatedThisFrameRef.current = false;
                               },
                               onTransformStart: () => pushToHistory(),
                              onTransform: (e: any) => {
                                const node = e.target;
                                if (POINT_BASED_TYPES.includes(shape.type) && shape.type === 'cloud' && shape.points && shape.points.length > 0) {
                                  const transform = node.getTransform();
                                  
                                  // Compute the new virtual points of the cloud
                                  const newPts: number[] = [];
                                  for (let i = 0; i < shape.points.length; i += 2) {
                                    const p = transform.point({ x: shape.points[i], y: shape.points[i + 1] });
                                    newPts.push(p.x, p.y);
                                  }

                                  shapes.forEach(child => {
                                    if (child.type === 'callout' && child.parentId === shape.id && child.points) {
                                      const calloutGroup = node.getStage()?.findOne(`#shape-${child.id}`);
                                      if (calloutGroup && calloutGroup.children) {
                                        const originalStartX = child.points[0];
                                        const originalStartY = child.points[1];
                                        const originalDx = (child.x || 0) - originalStartX;
                                        const originalDy = (child.y || 0) - originalStartY;
                                        
                                        const scaledPos = transform.point({ x: child.x || 0, y: child.y || 0 });
                                        const targetX = scaledPos.x;
                                        const targetY = scaledPos.y + (child.height || 60) / 2;
                                        
                                        let minDst = Infinity;
                                        let bestX = newPts[0], bestY = newPts[1];
                                        let bestSeg = 0;
                                        for (let k = 0; k < newPts.length; k += 2) {
                                          const x1 = newPts[k], y1 = newPts[k + 1];
                                          const nextK = (k + 2) % newPts.length;
                                          const x2 = newPts[nextK], y2 = newPts[nextK + 1];
                                          const A = targetX - x1, B = targetY - y1, C = x2 - x1, D = y2 - y1;
                                          const dot = A * C + B * D, len_sq = C * C + D * D;
                                          let param = len_sq !== 0 ? dot / len_sq : -1;
                                          const xx = param < 0 ? x1 : param > 1 ? x2 : x1 + param * C;
                                          const yy = param < 0 ? y1 : param > 1 ? y2 : y1 + param * D;
                                          const dst = Math.pow(xx - targetX, 2) + Math.pow(yy - targetY, 2);
                                          if (dst < minDst) { minDst = dst; bestX = xx; bestY = yy; bestSeg = k; }
                                        }
                                        
                                        const bX1 = newPts[bestSeg], bY1 = newPts[bestSeg + 1];
                                        const ni = (bestSeg + 2) % newPts.length;
                                        const bX2 = newPts[ni], bY2 = newPts[ni + 1];
                                        const dx = bX2 - bX1, dy = bY2 - bY1, len = Math.sqrt(dx * dx + dy * dy);
                                        if (len > 0) {
                                          const bump = Math.max(shape.radius || 20, 5);
                                          const dist_along = Math.sqrt(Math.pow(bestX - bX1, 2) + Math.pow(bestY - bY1, 2));
                                          const f = Math.min(1, Math.max(0, dist_along / len));
                                          const arcCount = Math.max(1, Math.round(len / (bump * 1.5)));
                                          const j = Math.min(arcCount - 1, Math.floor(f * arcCount));
                                          const lt = (f * arcCount) - j;
                                          
                                          const p0x = bX1 + (j / arcCount) * dx, p0y = bY1 + (j / arcCount) * dy;
                                          const p2x = bX1 + ((j + 1) / arcCount) * dx, p2y = bY1 + ((j + 1) / arcCount) * dy;
                                          const amx = (p0x + p2x) / 2, amy = (p0y + p2y) / 2;
                                          const p1x = amx + (-dy / len) * bump, p1y = amy + (dx / len) * bump;
                                          
                                          const mt = 1 - lt;
                                          bestX = mt * mt * p0x + 2 * mt * lt * p1x + lt * lt * p2x;
                                          bestY = mt * mt * p0y + 2 * mt * lt * p1y + lt * lt * p2y;
                                        }

                                        const newBoxX = bestX + originalDx;
                                        const newBoxY = bestY + originalDy;
                                        const elbowDx = (child.points[2] ?? originalStartX) - originalStartX;
                                        const elbowDy = (child.points[3] ?? originalStartY) - originalStartY;
                                        let elbowX = bestX + elbowDx;
                                        const elbowY = bestY + elbowDy;

                                        const line = calloutGroup.children[0] as any;
                                        const textGroup = calloutGroup.children[1] as any;
                                        
                                        let connectX = newBoxX;
                                        const connectY = newBoxY + (child.height || 60) / 2;
                                        let isRight = true;
                                        
                                        if (bestX < newBoxX) { connectX = newBoxX; isRight = true; }
                                        else if (bestX > newBoxX + (child.width || 150)) { connectX = newBoxX + (child.width || 150); isRight = false; }
                                        else { connectX = bestX; } 

                                        if (isRight) {
                                          if (elbowX > connectX) elbowX = connectX - 20;
                                          if (elbowX < bestX) elbowX = bestX + (connectX - bestX) / 2;
                                        } else if (bestX > newBoxX + (child.width || 150)) {
                                          if (elbowX < connectX) elbowX = connectX + 20;
                                          if (elbowX > bestX) elbowX = bestX - (bestX - connectX) / 2;
                                        } else { elbowX = bestX; }

                                        if (line && typeof line.points === 'function') {
                                          line.points([bestX, bestY, elbowX, elbowY, connectX, connectY]);
                                        }
                                        if (textGroup) { textGroup.x(newBoxX); textGroup.y(newBoxY); }
                                      }
                                    }
                                  });
                                }
                              },
                              onTransformEnd: (e: any) => {
                                const node = e.target;
                                const _soX = spreadOffsetX;
                                if (['rect','image','text','stamp','table'].includes(shape.type)) {
                                  const sx = node.scaleX(), sy = node.scaleY();
                                  node.scaleX(1); node.scaleY(1);
                                  
                                  const updates: Partial<ShapeData> = {
                                    x: node.x() - _soX, y: node.y(),
                                    width:    Math.max(5, (shape.width  || 100) * sx),
                                    height:   Math.max(5, (shape.height || 100) * sy),
                                    rotation: node.rotation(),
                                  };
                                  
                                  if (shape.type === 'table' && shape.tableData) {
                                    updates.tableData = {
                                      ...shape.tableData,
                                      colWidths: shape.tableData.colWidths.map(w => Math.max(10, w * sx)),
                                      rowHeights: shape.tableData.rowHeights.map(h => Math.max(10, h * sy)),
                                    };
                                  }
                                  
                                  updateShape(shape.id, updates);
                                } else if (isBoxMark(shape.type)) {
                                   const sx = node.scaleX(), sy = node.scaleY();
                                   node.scaleX(1); node.scaleY(1);
                                   const defSize = getDefaultMarkSize(shape.type);
                                   updateShape(shape.id, {
                                     x: node.x() - _soX, y: node.y(),
                                     width:  Math.max(shape.minWidth  || 40, (shape.width  || defSize.width) * sx),
                                     height: Math.max(shape.minHeight || 40, (shape.height || defSize.height) * sy),
                                     rotation: node.rotation(),
                                   });
                                } else if (shape.type === 'circle') {
                                  const sx = node.scaleX(), sy = node.scaleY();
                                  node.scaleX(1); node.scaleY(1);
                                  updateShape(shape.id, {
                                    x: node.x() - _soX, y: node.y(),
                                    width:  Math.max(5, (shape.width  || (shape.radius ? shape.radius * 2 : 100)) * sx),
                                    height: Math.max(5, (shape.height || (shape.radius ? shape.radius * 2 : 100)) * sy),
                                    rotation: node.rotation(),
                                  });
                                } else if (POINT_BASED_TYPES.includes(shape.type)) {
                                  const transform = node.getTransform();
                                  if (shape.points) {
                                    const newPoints: number[] = [];
                                    for (let i = 0; i < shape.points.length; i += 2) {
                                      const p = transform.point({ x: shape.points[i], y: shape.points[i + 1] });
                                      newPoints.push(p.x, p.y);
                                    }
                                    node.scaleX(1); node.scaleY(1); node.x(0); node.y(0); node.rotation(0);
                                    updateShape(shape.id, { points: newPoints.map((p, idx) => idx % 2 === 0 ? p - _soX : p), x: 0, y: 0, rotation: 0 });
                                    if (shape.type === 'cloud') {
                                      shapes.forEach(child => {
                                        if (child.type === 'callout' && child.parentId === shape.id && child.points) {
                                          const originalStartX = child.points[0];
                                          const originalStartY = child.points[1];
                                          const originalDx = (child.x || 0) - originalStartX;
                                          const originalDy = (child.y || 0) - originalStartY;
                                          
                                          const scaledPos = transform.point({ x: child.x || 0, y: child.y || 0 });
                                          let minDst = Infinity;
                                          let bestX = newPoints[0], bestY = newPoints[1];
                                          let bestSeg = 0;
                                          const targetX = scaledPos.x;
                                          const targetY = scaledPos.y + (child.height || 60) / 2;

                                          for (let k = 0; k < newPoints.length; k += 2) {
                                            const x1 = newPoints[k], y1 = newPoints[k + 1];
                                            const nextK = (k + 2) % newPoints.length;
                                            const x2 = newPoints[nextK], y2 = newPoints[nextK + 1];
                                            const A = targetX - x1, B = targetY - y1, C = x2 - x1, D = y2 - y1;
                                            const dot = A * C + B * D, len_sq = C * C + D * D;
                                            let param = len_sq !== 0 ? dot / len_sq : -1;
                                            const xx = param < 0 ? x1 : param > 1 ? x2 : x1 + param * C;
                                            const yy = param < 0 ? y1 : param > 1 ? y2 : y1 + param * D;
                                            const dst = Math.pow(xx - targetX, 2) + Math.pow(yy - targetY, 2);
                                            if (dst < minDst) { minDst = dst; bestX = xx; bestY = yy; bestSeg = k; }
                                          }
                                          
                                          const bX1 = newPoints[bestSeg], bY1 = newPoints[bestSeg + 1];
                                          const ni = (bestSeg + 2) % newPoints.length;
                                          const bX2 = newPoints[ni], bY2 = newPoints[ni + 1];
                                          const dx = bX2 - bX1, dy = bY2 - bY1, len = Math.sqrt(dx * dx + dy * dy);
                                          if (len > 0) {
                                            const bump = Math.max(shape.radius || 20, 5);
                                            const dist_along = Math.sqrt(Math.pow(bestX - bX1, 2) + Math.pow(bestY - bY1, 2));
                                            const f = Math.min(1, Math.max(0, dist_along / len));
                                            const arcCount = Math.max(1, Math.round(len / (bump * 1.5)));
                                            const j = Math.min(arcCount - 1, Math.floor(f * arcCount));
                                            const lt = (f * arcCount) - j;
                                            
                                            const p0x = bX1 + (j / arcCount) * dx, p0y = bY1 + (j / arcCount) * dy;
                                            const p2x = bX1 + ((j + 1) / arcCount) * dx, p2y = bY1 + ((j + 1) / arcCount) * dy;
                                            const amx = (p0x + p2x) / 2, amy = (p0y + p2y) / 2;
                                            const p1x = amx + (-dy / len) * bump, p1y = amy + (dx / len) * bump;
                                            
                                            const mt = 1 - lt;
                                            bestX = mt * mt * p0x + 2 * mt * lt * p1x + lt * lt * p2x;
                                            bestY = mt * mt * p0y + 2 * mt * lt * p1y + lt * lt * p2y;
                                          }
                                          
                                          const newBoxX = bestX + originalDx;
                                          const newBoxY = bestY + originalDy;
                                          const elbowDx = (child.points[2] ?? originalStartX) - originalStartX;
                                          const elbowDy = (child.points[3] ?? originalStartY) - originalStartY;
                                          const childPoints = [bestX, bestY, bestX + elbowDx, bestY + elbowDy];

                                          updateShape(child.id, {
                                            points: childPoints.map((p, idx) => idx % 2 === 0 ? p - _soX : p),
                                            x: newBoxX - _soX,
                                            y: newBoxY
                                          });
                                        }
                                      });
                                    }
                                  }
                                }
                              },
                            };

                            // Pattern engine helpers
                            let fillPatternImage: HTMLCanvasElement | undefined;
                            let fillPatternOffsetX = 0, fillPatternOffsetY = 0;
                            const dpr = window.devicePixelRatio || 1;
                            let fillScale = { x: 1, y: 1 };
                            const TILE_DPR = dpr * Math.max(1, Math.ceil(scale));
                            if (shape.fillPatternId) {
                              const patColor = shape.fillColor && shape.fillColor !== 'transparent'
                                ? shape.fillColor : (shape.strokeColor || '#000000');
                              const tileRes = PatternEngine.createPatternTile(
                                shape.fillPatternId, 
                                shape.fillPatternScale || 1.0, patColor, shape.fillPatternStrokeWidth || shape.strokeWidth || 1, TILE_DPR
                              );
                              if (tileRes) {
                                fillPatternImage = tileRes.canvas;
                                fillScale = tileRes.fillScale;
                              }
                              fillPatternOffsetX = shape.x || 0;
                              fillPatternOffsetY = shape.y || 0;
                            }

                            const isShapeDrawing = isDrawingRef.current && newShapeIdRef.current === shape.id;

                            // ── Custom Arrowhead & Label Helpers ───────────────
                            const renderLabel = (shapePts: number[]) => {
                              if (!shape.text || shapePts.length < 4) return null;
                              const x = shapePts[0];
                              const y = shapePts[1];
                              const isRight = shapePts[2] >= shapePts[0];
                              const tW = shape.width || 150;
                              const tH = shape.height || 40;
                              const tx = isRight ? x - tW - 10 : x + 10;
                              const ty = y - tH / 2;
                              
                              const fontStyle = `${shape.isItalic ? 'italic ' : ''}${shape.isBold ? 'bold ' : ''}`.trim();
                              const textDecoration = `${shape.isUnderline ? 'underline ' : ''}${shape.isStrike ? 'line-through' : ''}`.trim();
                              const isSelected = selectedShapeIds.includes(shape.id);
                              
                              return (
                                <Group>
                                  {isSelected && (
                                    <Rect
                                      x={tx} y={ty} width={tW} height={tH}
                                      stroke="#4da6ff" strokeWidth={1 / scale} dash={[5 / scale, 5 / scale]}
                                      listening={false}
                                    />
                                  )}
                                  <Text
                                    x={tx} y={ty} width={tW} height={tH} align={isRight ? 'right' : 'left'}
                                    text={shape.text}
                                    fill={shape.strokeColor}
                                    fontSize={shape.fontSize || 16}
                                    fontFamily={shape.fontFamily || 'Inter'}
                                    fontStyle={fontStyle}
                                    textDecoration={textDecoration}
                                    wrap="word"
                                  />
                                </Group>
                              );
                            };

                            const renderCustomArrowHead = (shapePts: number[]) => {
                              const type = shape.arrowHeadType ?? 'arrow';
                              if (shape.showArrowHead === false || type === 'none' || shapePts.length < 4) return null;
                              
                              const n = shapePts.length;
                              let x2 = shapePts[n - 2], y2 = shapePts[n - 1];
                              let angle = Math.atan2(y2 - shapePts[n - 3], x2 - shapePts[n - 4]);

                              // Use Konva's quadratic curve calculation to get a stable, visually accurate tangent
                              if (shape.type === 'spline' && shapePts.length >= 4) {
                                const line = new Konva.Line({ points: shapePts, tension: 0.5 });
                                const tpts = line.getTensionPoints();
                                if (tpts && tpts.length >= 6) {
                                  const tlen = tpts.length;
                                  // In Konva 10, the final quadratic curve starts at tpts[tlen-4] and uses tpts[tlen-2] as the control point
                                  const P0x = tpts[tlen - 4], P0y = tpts[tlen - 3]; // Start of quadratic curve
                                  const P1x = tpts[tlen - 2], P1y = tpts[tlen - 1]; // Control point
                                  const P2x = x2, P2y = y2; // Absolute tip of the line
                                  
                                  // Step back slightly (t=0.85) to compute a stable secant vector
                                  // This prevents jitter and perfectly mirrors Konva 10 native Arrow smoothing
                                  const t = 0.85;
                                  const t1 = 1 - t;
                                  const prevX = t1 * t1 * P0x + 2 * t1 * t * P1x + t * t * P2x;
                                  const prevY = t1 * t1 * P0y + 2 * t1 * t * P1y + t * t * P2y;
                                  
                                  const dx = P2x - prevX;
                                  const dy = P2y - prevY;
                                  if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
                                    angle = Math.atan2(dy, dx);
                                  }
                                }
                              }

                              const size = shape.arrowHeadSize ?? 15;
                              const filled = shape.arrowHeadFilled ?? true;
                              const headAngle = shape.arrowHeadAngle ?? 30;

                              if (type === 'circle') {
                                return (
                                  <Circle
                                    x={x2} y={y2} radius={size / 2}
                                    fill={filled ? (shape.fillPatternId ? undefined : (shape.strokeColor || '#000')) : 'transparent'}
                                    stroke={shape.strokeColor || '#000'} strokeWidth={shape.strokeWidth}
                                    fillPatternImage={fillPatternImage as any} fillPatternRepeat="repeat"
                                    fillPatternOffsetX={fillPatternOffsetX} fillPatternOffsetY={fillPatternOffsetY}
                                    fillPatternScale={fillScale}
                                  />
                                );
                              }

                              if (type === 'arrow' || type === 'greater_than') {
                                const angleRad = headAngle * Math.PI / 180;
                                const p1x = -size * Math.cos(angleRad);
                                const p1y = size * Math.sin(angleRad);
                                const p2x = -size * Math.cos(angleRad);
                                const p2y = -size * Math.sin(angleRad);

                                if (type === 'greater_than') {
                                  return (
                                    <Line
                                      x={x2} y={y2} rotation={angle * 180 / Math.PI}
                                      points={[p1x, p1y, 0, 0, p2x, p2y]}
                                      stroke={shape.strokeColor || '#000'} strokeWidth={shape.strokeWidth}
                                      lineCap="round" lineJoin="round"
                                    />
                                  );
                                } else {
                                  return (
                                    <Line
                                      x={x2} y={y2} rotation={angle * 180 / Math.PI}
                                      points={[p1x, p1y, 0, 0, p2x, p2y]} closed
                                      fill={filled ? (shape.fillPatternId ? undefined : (shape.strokeColor || '#000')) : 'transparent'}
                                      stroke={shape.strokeColor || '#000'} strokeWidth={shape.strokeWidth}
                                      lineJoin="round"
                                      fillPatternImage={fillPatternImage as any} fillPatternRepeat="repeat"
                                      fillPatternOffsetX={fillPatternOffsetX} fillPatternOffsetY={fillPatternOffsetY}
                                      fillPatternScale={fillScale}
                                    />
                                  );
                                }
                              }
                              return null;
                            };

                            const renderShapeContent = () => {
                              if (shape.type === 'table') {
                              return <TableRenderer key={shape.id} shape={shape} commonProps={commonProps} updateShape={updateShape} pushToHistory={pushToHistory}
                                isSelected={selectedShapeIds.includes(shape.id)}
                                onCellEdit={(cellId, text, cx, cy, cw, ch) => {
                                  setSelectedShapeIds([shape.id]);
                                  // cx, cy are relative to shape's top-left.
                                  // convert to absolute screen pos for textarea
                                  const absX = (shape.x + cx) * scale + panOffset.x;
                                  const absY = (shape.y + cy) * scale + panOffset.y;
                                  const cell = shape.tableData?.cells?.[cellId];
                                  const cellFontFamily = cell?.fontFamily || shape.fontFamily || 'Inter';
                                  const cellFontSize = cell?.fontSize || shape.fontSize || 16;
                                  const cellStrokeColor = cell?.strokeColor || shape.strokeColor || '#000';
                                  const cellIsBold = cell?.isBold !== undefined ? cell.isBold : (shape.isBold || false);
                                  const cellIsItalic = cell?.isItalic !== undefined ? cell.isItalic : (shape.isItalic || false);
                                  const cellIsUnderline = cell?.isUnderline !== undefined ? cell.isUnderline : (shape.isUnderline || false);
                                  const cellIsStrike = cell?.isStrike !== undefined ? cell.isStrike : (shape.isStrike || false);
                                  setInlineEditText({
                                    id: shape.id,
                                    cellId: cellId,
                                    text: text || '',
                                    x: absX, y: absY, w: cw * scale, h: ch * scale,
                                    fontSize: cellFontSize,
                                    fontFamily: cellFontFamily,
                                    strokeColor: cellStrokeColor,
                                    isBold: cellIsBold,
                                    isItalic: cellIsItalic,
                                    isUnderline: cellIsUnderline,
                                    isStrike: cellIsStrike
                                  });
                                }}
                              />;
                            }
                            if (shape.type === 'rect') {
                              return <Rect key={shape.id} {...commonProps}
                                x={shape.x} y={shape.y} width={shape.width} height={shape.height}
                                rotation={shape.rotation} stroke={shape.strokeColor} strokeWidth={shape.strokeWidth}
                                fill={shape.fillPatternId ? undefined : shape.fillColor}
                                fillPatternImage={fillPatternImage as any} fillPatternRepeat="repeat"
                                fillPatternOffsetX={fillPatternOffsetX} fillPatternOffsetY={fillPatternOffsetY}
                                fillPatternScale={fillScale} dash={shape.dash}
                              />;
                            }
                            if (shape.type === 'text') {
                              const fontStyle = `${shape.isItalic ? 'italic ' : ''}${shape.isBold ? 'bold ' : ''}`.trim();
                              const textDecoration = `${shape.isUnderline ? 'underline ' : ''}${shape.isStrike ? 'line-through' : ''}`.trim();
                              return (
                                <Group key={shape.id} {...commonProps} x={shape.x} y={shape.y}
                                  rotation={shape.rotation} onDblClick={e => handleShapeDblClick(e, shape)}>
                                  <Rect width={shape.width} height={shape.height}
                                    stroke={selectedShapeIds.includes(shape.id) || isShapeDrawing ? '#4da6ff' : 'transparent'}
                                    strokeWidth={1} dash={[5, 5]}
                                  />
                                  <Text width={shape.width} height={shape.height}
                                    text={shape.text || 'Double click from Ledger to write text...'}
                                    fill={shape.strokeColor} fontSize={shape.fontSize || 16}
                                    fontFamily={shape.fontFamily || 'Inter'}
                                    fontStyle={fontStyle} textDecoration={textDecoration}
                                    padding={5} listening={false} wrap="word"
                                  />
                                </Group>
                              );
                            }
                            if (shape.type === 'callout') {
                              const startX = shape.points![0], startY = shape.points![1];
                              const boxX = shape.x, boxY = shape.y;
                              const width = shape.width || 150, height = shape.height || 60;
                              const fontStyle = `${shape.isItalic ? 'italic ' : ''}${shape.isBold ? 'bold ' : ''}`.trim();
                              const textDecoration = `${shape.isUnderline ? 'underline ' : ''}${shape.isStrike ? 'line-through' : ''}`.trim();
                              const isSelected = selectedShapeIds.includes(shape.id);
                              
                              let connectX = boxX;
                              let isRight = true;
                              if (startX < boxX) {
                                connectX = boxX; 
                                isRight = true;
                              } else if (startX > boxX + width) {
                                connectX = boxX + width; 
                                isRight = false;
                              } else {
                                connectX = startX;
                              }
                              
                              const connectY = boxY + height / 2;
                              let elbowX = shape.points![2] ?? (isRight ? connectX - 20 : connectX + 20);
                              const elbowY = shape.points![3] ?? connectY;

                              if (isRight) {
                                if (elbowX > connectX) elbowX = connectX - 20;
                                if (elbowX < startX) elbowX = startX + (connectX - startX) / 2;
                              } else if (startX > boxX + width) {
                                if (elbowX < connectX) elbowX = connectX + 20;
                                if (elbowX > startX) elbowX = startX - (startX - connectX) / 2;
                              } else {
                                elbowX = startX;
                              }

                              return (
                                <Group key={shape.id} {...commonProps}>
                                  <Line points={[startX, startY, elbowX, elbowY, connectX, connectY]}
                                    stroke={shape.strokeColor} strokeWidth={shape.strokeWidth}
                                    hitStrokeWidth={Math.max(14 / scale, 14)}
                                  />
                                  <Group x={boxX} y={boxY}
                                    draggable={isSelected || activeTool === 'select'}
                                    onDblClick={e => handleShapeDblClick(e, shape)}
                                    onDragStart={e => {
                                      e.cancelBubble = true;
                                      pushToHistory();
                                      const activeSelectedIds = useStore.getState().documents[tabId]?.selectedShapeIds || [];
                                      if (!activeSelectedIds.includes(shape.id)) {
                                        setSelectedShapeIds([shape.id]);
                                      }
                                    }}
                                    onDragMove={e => {
                                      e.cancelBubble = true;
                                      const dx = e.target.x() - boxX, dy = e.target.y() - boxY;
                                      const newPoints = [...shape.points!];
                                      newPoints[2] = (newPoints[2] ?? elbowX) + dx;
                                      newPoints[3] = (newPoints[3] ?? elbowY) + dy;
                                      updateShape(shape.id, { x: e.target.x(), y: e.target.y(), points: newPoints });
                                      e.target.x(boxX); e.target.y(boxY);
                                    }}
                                    onDragEnd={e => { e.cancelBubble = true; }}
                                  >
                                    <Rect width={width} height={height}
                                      stroke={isSelected ? '#4da6ff' : 'transparent'} strokeWidth={1} dash={[5, 5]}
                                    />
                                    <Text width={width} height={height}
                                      text={shape.text || 'Double click to edit...'} fill={shape.strokeColor}
                                      fontSize={shape.fontSize || 16} fontFamily={shape.fontFamily || 'Inter'}
                                      fontStyle={fontStyle} textDecoration={textDecoration}
                                      padding={5} listening={false} verticalAlign="middle" wrap="word"
                                    />
                                  </Group>
                                </Group>
                              );
                            }
                            if (shape.type === 'cloud') {
                              const isActivelyDrawingPolygon = isDrawingRef.current && newShapeIdRef.current === shape.id && (!shape.cloudMode || shape.cloudMode === 'polygon');
                              const renderPts = isActivelyDrawingPolygon
                                ? shape.points
                                : (shape.points ? [...shape.points, shape.points[0], shape.points[1]] : []);
                              return (
                                <Group key={shape.id} {...commonProps} onDblClick={e => handleShapeDblClick(e, shape)}>
                                  <Path
                                    data={buildCloudSvgPath(renderPts || [], Math.max(shape.radius || 20, 5)) +
                                          (!isActivelyDrawingPolygon ? ' Z' : '')}
                                    stroke={shape.strokeColor} strokeWidth={shape.strokeWidth}
                                    fill={shape.fillPatternId ? undefined : (!isActivelyDrawingPolygon ? (shape.fillColor || 'transparent') : 'transparent')}
                                    fillPatternImage={fillPatternImage as any} fillPatternRepeat="repeat"
                                    fillPatternOffsetX={fillPatternOffsetX} fillPatternOffsetY={fillPatternOffsetY}
                                    fillPatternScale={fillScale}
                                  />
                                  {shape.text && !isActivelyDrawingPolygon && shape.points && (() => {
                                    let minX = shape.points[0];
                                    let minY = shape.points[1];
                                    for (let i = 0; i < shape.points.length; i += 2) {
                                      minX = Math.min(minX, shape.points[i]);
                                      minY = Math.min(minY, shape.points[i + 1]);
                                    }
                                    return (
                                      <Text x={minX + 10} y={minY + 10}
                                        text={shape.text} fill={shape.strokeColor}
                                        fontSize={shape.fontSize || 12} fontFamily="Inter" listening={false}
                                      />
                                    );
                                  })()}
                                </Group>
                              );
                            }
                            if (shape.type === 'highlight') {
                              return (
                                <Line
                                  key={shape.id}
                                  {...commonProps}
                                  points={shape.points}
                                  stroke={shape.strokeColor}
                                  strokeWidth={shape.strokeWidth}
                                  hitStrokeWidth={Math.max(14 / scale, 14)}
                                  opacity={0.5}
                                  tension={0.5}
                                  lineCap="round"
                                  lineJoin="round"
                                  globalCompositeOperation="multiply"
                                />
                              );
                            }
                            if (shape.type === 'brush' || shape.type === 'freehand') {
                              return (
                                <Line
                                  key={shape.id}
                                  {...commonProps}
                                  points={shape.points}
                                  stroke={shape.strokeColor || '#000000'}
                                  strokeWidth={shape.strokeWidth}
                                  hitStrokeWidth={Math.max(14 / scale, 14)}
                                  tension={0.5}
                                  lineCap="round"
                                  lineJoin="round"
                                />
                              );
                            }
                            if (shape.type === 'circle') {
                              const rx = shape.width !== undefined ? shape.width / 2 : (shape.radius || 50);
                              const ry = shape.height !== undefined ? shape.height / 2 : (shape.radius || 50);
                              return (
                                <Path key={shape.id} {...commonProps}
                                  x={shape.x} y={shape.y} rotation={shape.rotation}
                                  data={`M ${-rx},0 A ${rx},${ry} 0 1,0 ${rx},0 A ${rx},${ry} 0 1,0 ${-rx},0`}
                                  stroke={shape.strokeColor} strokeWidth={shape.strokeWidth}
                                  hitStrokeWidth={Math.max(14 / scale, 14)}
                                  fill={shape.fillPatternId ? undefined : shape.fillColor}
                                  fillPatternImage={fillPatternImage as any} fillPatternRepeat="repeat"
                                  fillPatternOffsetX={fillPatternOffsetX} fillPatternOffsetY={fillPatternOffsetY}
                                  fillPatternScale={fillScale} dash={shape.dash}
                                />
                              );
                            }
                            if (shape.type === 'arrow') {
                              return (
                                <Group key={shape.id} {...commonProps} onDblClick={e => handleShapeDblClick(e, shape)}>
                                  <Line
                                    points={shape.points || []} stroke={shape.strokeColor}
                                    strokeWidth={shape.strokeWidth}
                                    hitStrokeWidth={Math.max(14 / scale, 14)}
                                    dash={shape.dash}
                                    lineCap="round" lineJoin="round"
                                  />
                                  {renderCustomArrowHead(shape.points || [])}
                                  {renderLabel(shape.points || [])}
                                </Group>
                              );
                            }
                            if (['line', 'measure_length', 'measure_area'].includes(shape.type)) {
                              const isLength = shape.type === 'measure_length';
                              const isArea = shape.type === 'measure_area';
                              let lenStr = '', midX = 0, midY = 0;
                              if (isLength && shape.points && shape.points.length >= 4) {
                                const dx = shape.points[2] - shape.points[0];
                                const dy = shape.points[3] - shape.points[1];
                                const rawPx = Math.sqrt(dx * dx + dy * dy);
                                if (shape.measurementSystem && shape.measurementScale) {
                                  const paperInches = rawPx / 72.0;
                                  if (shape.measurementSystem === 'imperial') {
                                    lenStr = formatImperial(paperInches * shape.measurementScale);
                                  } else {
                                    lenStr = `${(rawPx * (25.4 / 72.0) * shape.measurementScale).toFixed(2)} mm`;
                                  }
                                } else {
                                  lenStr = `${(rawPx * useStore.getState().documents[tabId]?.scaleCalibration || 1.0).toFixed(2)}`;
                                }
                                midX = shape.points[0] + dx / 2;
                                midY = shape.points[1] + dy / 2 - 20;
                              }

                              // Compute area label for measure_area
                              let areaStr = '';
                              let areaCX = 0, areaCY = 0;
                              if (isArea && shape.points && shape.points.length >= 6) {
                                // Use Shoelace formula for polygon area in pixels
                                const pts = shape.points;
                                let areaPixels = 0;
                                const n = Math.floor(pts.length / 2);
                                let sumX = 0, sumY = 0;
                                for (let i = 0; i < n; i++) {
                                  const j = (i + 1) % n;
                                  areaPixels += pts[i * 2] * pts[j * 2 + 1];
                                  areaPixels -= pts[j * 2] * pts[i * 2 + 1];
                                  sumX += pts[i * 2];
                                  sumY += pts[i * 2 + 1];
                                }
                                areaPixels = Math.abs(areaPixels) / 2;
                                areaCX = sumX / n;
                                areaCY = sumY / n;
                                if (shape.measurementSystem && shape.measurementScale) {
                                  const scale2 = shape.measurementScale;
                                  if (shape.measurementSystem === 'imperial') {
                                    // Convert px² → in² at 72dpi, then scale factor² → real in², then → ft²
                                    const paperInchSq = areaPixels / (72.0 * 72.0);
                                    const realInchSq = paperInchSq * scale2 * scale2;
                                    const realFtSq = realInchSq / 144;
                                    if (realFtSq >= 1) {
                                      areaStr = `${realFtSq.toFixed(2)} ft²`;
                                    } else {
                                      areaStr = `${realInchSq.toFixed(2)} in²`;
                                    }
                                  } else {
                                    // Metric: px² → mm² at 72dpi (1 pt = 25.4/72 mm), then scale²
                                    const mmPerPx = 25.4 / 72.0;
                                    const paperMmSq = areaPixels * mmPerPx * mmPerPx;
                                    const realMmSq = paperMmSq * scale2 * scale2;
                                    if (realMmSq >= 1_000_000) {
                                      areaStr = `${(realMmSq / 1_000_000).toFixed(2)} m²`;
                                    } else if (realMmSq >= 10_000) {
                                      areaStr = `${(realMmSq / 10_000).toFixed(2)} cm²`;
                                    } else {
                                      areaStr = `${realMmSq.toFixed(0)} mm²`;
                                    }
                                  }
                                } else {
                                  areaStr = `${areaPixels.toFixed(0)} px²`;
                                }
                              }

                              return (
                                <Group key={shape.id} {...commonProps}>
                                  <Line
                                    points={shape.points || []} stroke={shape.strokeColor}
                                    strokeWidth={shape.strokeWidth}
                                    hitStrokeWidth={Math.max(14 / scale, 14)}
                                    tension={(shape.type as any) === 'freehand' ? 0.5 : 0}
                                    lineCap="round" lineJoin="round" dash={shape.dash}
                                    closed={isArea}
                                    fill={isArea ? (shape.fillPatternId ? undefined : (shape.fillColor || 'rgba(77,166,255,0.12)')) : 'transparent'}
                                    fillPatternImage={isArea ? (fillPatternImage as any) : undefined}
                                    fillPatternRepeat="repeat"
                                    fillPatternOffsetX={fillPatternOffsetX} fillPatternOffsetY={fillPatternOffsetY}
                                    fillPatternScale={fillScale}
                                  />
                                  {isLength && shape.points && shape.points.length >= 4 && (() => {
                                    const dx = shape.points[2] - shape.points[0];
                                    const dy = shape.points[3] - shape.points[1];
                                    const angle = Math.atan2(dy, dx);
                                    const tickLen = 8;
                                    const tickAngle = angle + Math.PI / 2;
                                    
                                    const t1_x1 = shape.points[0] - (tickLen / 2) * Math.cos(tickAngle);
                                    const t1_y1 = shape.points[1] - (tickLen / 2) * Math.sin(tickAngle);
                                    const t1_x2 = shape.points[0] + (tickLen / 2) * Math.cos(tickAngle);
                                    const t1_y2 = shape.points[1] + (tickLen / 2) * Math.sin(tickAngle);

                                    const t2_x1 = shape.points[2] - (tickLen / 2) * Math.cos(tickAngle);
                                    const t2_y1 = shape.points[3] - (tickLen / 2) * Math.sin(tickAngle);
                                    const t2_x2 = shape.points[2] + (tickLen / 2) * Math.cos(tickAngle);
                                    const t2_y2 = shape.points[3] + (tickLen / 2) * Math.sin(tickAngle);

                                    return (
                                      <>
                                        <Line points={[t1_x1, t1_y1, t1_x2, t1_y2]} stroke={shape.strokeColor} strokeWidth={shape.strokeWidth} lineCap="round" />
                                        <Line points={[t2_x1, t2_y1, t2_x2, t2_y2]} stroke={shape.strokeColor} strokeWidth={shape.strokeWidth} lineCap="round" />
                                      </>
                                    );
                                  })()}
                                  {isLength && lenStr && (
                                    <Text x={midX} y={midY} text={lenStr} fill={shape.strokeColor}
                                      fontSize={16} fontStyle="bold" align="center"
                                      offset={{ x: 20, y: 0 }} listening={false}
                                    />
                                  )}
                                  {isArea && areaStr && shape.points && shape.points.length >= 6 && (
                                    <>
                                      {/* Background pill for readability */}
                                      <Text
                                        x={areaCX}
                                        y={areaCY}
                                        text={areaStr}
                                        fill={shape.strokeColor || '#4da6ff'}
                                        fontSize={14}
                                        fontStyle="bold"
                                        fontFamily="Inter"
                                        align="center"
                                        offset={{ x: 0, y: 7 }}
                                        listening={false}
                                        padding={4}
                                      />
                                    </>
                                  )}
                                </Group>
                              );
                            }
                            if (shape.type === 'image') {
                              return <CustomImage key={shape.id} shape={shape} commonProps={commonProps} />;
                            }
                            if (shape.type === 'content_box') {
                              // Rebuild commonProps for content box:
                              // In 'content' mode the Transformer should NOT be attached
                              // (we have custom orange handles). Override onTransformEnd
                              // so frame resizes keep the asset proportionally fitted.
                              const cbOnTransformEnd = (e: any) => {
                                const node = e.target;
                                const sx = node.scaleX(), sy = node.scaleY();
                                node.scaleX(1); node.scaleY(1);
                                const newW = Math.max(20, (shape.width  || 100) * sx);
                                const newH = Math.max(20, (shape.height || 100) * sy);
                                const at   = shape.assetTransform || { x: 0, y: 0, width: shape.width || 100, height: shape.height || 100 };
                                // Scale the asset proportionally with the frame
                                const wRatio = newW / (shape.width  || 100);
                                const hRatio = newH / (shape.height || 100);
                                updateShape(origShape.id, {
                                  x: node.x() - spreadOffsetX, y: node.y(),
                                  width: newW, height: newH,
                                  rotation: node.rotation(),
                                  assetTransform: {
                                    x: at.x * wRatio, y: at.y * hRatio,
                                    width: at.width * wRatio, height: at.height * hRatio,
                                  },
                                });
                              };

                              // Wrap the drop-image handler in a dedicated HTML overlay so
                              // the native ‘dragover’ / ‘drop’ events fire on the Konva canvas.
                              // We read the Konva node’s absolute screen rect for positioning.

                              return (
                                <ContentBoxRenderer
                                  key={shape.id}
                                  shape={shape}
                                  commonProps={{
                                    ...commonProps,
                                    onTransformEnd: cbOnTransformEnd,
                                    onDblClick: (e: any) => handleShapeDblClick(e, origShape),
                                  }}
                                  updateShape={updateShape}
                                  pushToHistory={pushToHistory}
                                  isSelected={selectedShapeIds.includes(shape.id)}
                                  scale={scale}
                                  spreadOffsetX={spreadOffsetX}
                                />
                              );
                            }
                            if (shape.type === 'polyline') {
                              return (
                                <Line key={shape.id} {...commonProps}
                                  points={shape.points || []} stroke={shape.strokeColor}
                                  strokeWidth={shape.strokeWidth}
                                  hitStrokeWidth={Math.max(14 / scale, 14)}
                                  dash={shape.dash}
                                  lineCap="round" lineJoin="round" tension={0}
                                  closed={shape.closed}
                                  fill={shape.closed ? (shape.fillPatternId ? undefined : (shape.fillColor || 'transparent')) : 'transparent'}
                                  fillPatternImage={shape.closed ? (fillPatternImage as any) : undefined}
                                  fillPatternRepeat="repeat"
                                  fillPatternOffsetX={fillPatternOffsetX} fillPatternOffsetY={fillPatternOffsetY}
                                  fillPatternScale={fillScale}
                                />
                              );
                            }
                            if (shape.type === 'spline') {
                              return (
                                <Group key={shape.id} {...commonProps} onDblClick={e => handleShapeDblClick(e, shape)}>
                                  <Line
                                    points={shape.points || []} stroke={shape.strokeColor}
                                    strokeWidth={shape.strokeWidth}
                                    hitStrokeWidth={Math.max(14 / scale, 14)}
                                    dash={shape.dash}
                                    tension={0.5} lineCap="round" lineJoin="round"
                                    closed={shape.closed}
                                  />
                                  {renderCustomArrowHead(shape.points || [])}
                                  {renderLabel(shape.points || [])}
                                </Group>
                              );
                            }
                            if (shape.type === 'arc') {
                              return (
                                <Shape key={shape.id} {...commonProps}
                                  stroke={shape.strokeColor}
                                  strokeWidth={shape.strokeWidth}
                                  hitStrokeWidth={Math.max(14 / scale, 14)}
                                  dash={shape.dash}
                                  sceneFunc={(ctx, shapeObj) => {
                                    if (shape.points && shape.points.length >= 4) {
                                      const x1 = shape.points[0], y1 = shape.points[1];
                                      ctx.beginPath();
                                      if (shape.points.length === 4) {
                                        ctx.moveTo(x1, y1);
                                        ctx.lineTo(shape.points[2], shape.points[3]);
                                      } else {
                                        const x2 = shape.points[2], y2 = shape.points[3];
                                        const x3 = shape.points[4], y3 = shape.points[5];
                                        const D = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
                                        if (Math.abs(D) < 1e-5) {
                                          ctx.moveTo(x1, y1);
                                          ctx.lineTo(x3, y3);
                                        } else {
                                          const cx = ((x1 * x1 + y1 * y1) * (y2 - y3) + (x2 * x2 + y2 * y2) * (y3 - y1) + (x3 * x3 + y3 * y3) * (y1 - y2)) / D;
                                          const cy = ((x1 * x1 + y1 * y1) * (x3 - x2) + (x2 * x2 + y2 * y2) * (x1 - x3) + (x3 * x3 + y3 * y3) * (x2 - x1)) / D;
                                          const r = Math.sqrt((x1 - cx) ** 2 + (y1 - cy) ** 2);
                                          const startAngle = Math.atan2(y1 - cy, x1 - cx);
                                          const endAngle = Math.atan2(y3 - cy, x3 - cx);
                                          const cross = (x2 - x1) * (y3 - y2) - (y2 - y1) * (x3 - x2);
                                          const counterclockwise = cross < 0;
                                          ctx.arc(cx, cy, r, startAngle, endAngle, counterclockwise);
                                        }
                                      }
                                      ctx.strokeShape(shapeObj);
                                    }
                                  }}
                                  fill="transparent"
                                />
                              );
                            }
                            if (shape.type === 'polygon') {
                              const isActivelyDrawing = isDrawingRef.current && newShapeIdRef.current === shape.id;
                              return (
                                <Line key={shape.id} {...commonProps}
                                  points={shape.points || []} closed
                                  stroke={shape.strokeColor} strokeWidth={shape.strokeWidth}
                                  hitStrokeWidth={Math.max(14 / scale, 14)}
                                  dash={shape.dash}
                                  fill={shape.fillPatternId ? undefined : (!isActivelyDrawing ? (shape.fillColor || 'transparent') : 'transparent')}
                                  fillPatternImage={fillPatternImage as any} fillPatternRepeat="repeat"
                                  fillPatternOffsetX={fillPatternOffsetX} fillPatternOffsetY={fillPatternOffsetY}
                                  fillPatternScale={fillScale} lineCap="round" lineJoin="round"
                                />
                              );
                            }
                            if (shape.type === 'stamp') {
                              return (
                                <Group key={shape.id} {...commonProps} x={shape.x} y={shape.y}>
                                  <Rect width={shape.width} height={shape.height}
                                    stroke={shape.strokeColor} strokeWidth={shape.strokeWidth}
                                    cornerRadius={4} fill="rgba(255,255,255,0.1)"
                                  />
                                  <Text width={shape.width} height={shape.height}
                                    text={shape.stampText} fill={shape.strokeColor}
                                    fontSize={Math.min(shape.width! / 5, 24)}
                                    fontFamily="Inter" fontStyle="bold"
                                    align="center" verticalAlign="middle" listening={false}
                                  />
                                </Group>
                              );
                            }
                            // ── Architectural mark types ──────────────────────
                            if (isMarkType(shape.type)) {
                              return (
                                <MarksShapeRenderer
                                  key={shape.id}
                                  shape={shape}
                                  commonProps={{
                                    ...commonProps,
                                    id: `shape-${shape.id}`,
                                  }}
                                  isSelected={selectedShapeIds.includes(shape.id)}
                                />
                              );
                            }
                              return null;
                            };

                            const content = renderShapeContent();
                            if (!content) return null;

                            const isRightPageShape = spreadHasRight && isSpread && shape.page === spreadRightPage;
                            const pageW = pdfNativeSizeRef.current?.w || 0;
                            const clipConfig = (isSpread && shape.clippedToPage)
                              ? {
                                  clipX: isRightPageShape ? pageW : -10000,
                                  clipY: -10000,
                                  clipWidth: isRightPageShape ? 20000 : 10000 + pageW,
                                  clipHeight: 20000,
                                }
                              : {};

                            return (
                              <Group key={`shape-wrapper-${shape.id}`} {...clipConfig}>
                                {content}
                              </Group>
                            );
                          })}

                          {/* ── SPREAD SPINE ── A visual binding line between the two pages */}
                          {isSpread && pdfNativeSizeRef.current && (() => {
                            const spineX = pdfNativeSizeRef.current!.w;
                            const h = pdfNativeSizeRef.current!.h;
                            return (
                              <>
                                {/* Left shadow edge */}
                                <Line key="spine-shadow-l"
                                  points={[spineX - 3/scale, 0, spineX - 3/scale, h]}
                                  stroke="rgba(0,0,0,0.35)" strokeWidth={6/scale} listening={false}
                                />
                                {/* Right shadow edge */}
                                <Line key="spine-shadow-r"
                                  points={[spineX + 3/scale, 0, spineX + 3/scale, h]}
                                  stroke="rgba(0,0,0,0.35)" strokeWidth={6/scale} listening={false}
                                />
                                {/* Centre spine line */}
                                <Line key="spine-center"
                                  points={[spineX, 0, spineX, h]}
                                  stroke="rgba(77,166,255,0.45)" strokeWidth={3/scale} listening={false}
                                />
                              </>
                            );
                          })()}


                          {/* Guide lines */}
                          {showGuides && guides.map(guide => {
                            const isGuideSelected = selectedGuideId === guide.id;
                            return (
                              <Line
                                key={`guide-${guide.id}`}
                                points={
                                  guide.orientation === 'horizontal'
                                    ? [-99999, 0, 99999, 0]
                                    : [0, -99999, 0, 99999]
                                }
                                x={guide.orientation === 'vertical' ? guide.position : 0}
                                y={guide.orientation === 'horizontal' ? guide.position : 0}
                                stroke={isGuideSelected ? '#ff9500' : 'cyan'}
                                dash={[5, 5]}
                                strokeWidth={(isGuideSelected ? 2.5 : 1) / scale}
                                opacity={isGuideSelected ? 1.0 : 0.7}
                                shadowColor={isGuideSelected ? '#ff9500' : undefined}
                                shadowBlur={isGuideSelected ? 6 : 0}
                                draggable={guideSelectionEnabled && activeTool === 'select'}
                                listening={guideSelectionEnabled}
                                hitStrokeWidth={14 / scale}
                                onClick={(e: any) => {
                                  e.cancelBubble = true;
                                  if (!guideSelectionEnabled) return;
                                  setSelectedGuideId(selectedGuideId === guide.id ? null : guide.id);
                                }}
                                onDragStart={(e: any) => {
                                  e.cancelBubble = true;
                                  setSelectedGuideId(guide.id);
                                }}
                                onDragMove={(e: any) => {
                                  e.cancelBubble = true;
                                  if (guide.orientation === 'horizontal') {
                                    useStore.getState().updateGuide(guide.id, e.target.y());
                                  } else {
                                    useStore.getState().updateGuide(guide.id, e.target.x());
                                  }
                                }}
                                onDragEnd={(e: any) => { e.cancelBubble = true; }}
                              />
                            );
                          })}

                          {/* Master page guide lines */}
                          {showGuides && !isMasterTab && (() => {
                            const assignments = doc?.masterPageAssignments || {};
                            const currentMasterPages = doc?.masterPages || storeMasterPages || [];
                            const documentPageWidth = pdfNativeSizeRef.current?.w || 612;
                            const documentPageHeight = pdfNativeSizeRef.current?.h || 792;
                            const masterGuidesToRender: { id: string; orientation: 'horizontal' | 'vertical'; position: number }[] = [];

                            const collectMasterGuides = (masterId: string | null, isRightSide: boolean) => {
                              const master = masterId ? currentMasterPages.find(m => m.id === masterId) : null;
                              if (!master || !master.guides) return;

                              const offsetX = (documentPageWidth - master.pageWidth) / 2;
                              const offsetY = (documentPageHeight - master.pageHeight) / 2;
                              const docRightPageOffset = documentPageWidth;

                              master.guides.forEach(g => {
                                let isIncluded = false;
                                let finalPos = g.position;

                                if (master.isSpread) {
                                  if (isRightSide) {
                                    if (g.orientation === 'vertical' && g.position >= master.pageWidth) {
                                      isIncluded = true;
                                      finalPos = g.position - master.pageWidth + docRightPageOffset + offsetX;
                                    } else if (g.orientation === 'horizontal') {
                                      isIncluded = true;
                                      finalPos = g.position + offsetY;
                                    }
                                  } else {
                                    if (g.orientation === 'vertical' && g.position < master.pageWidth) {
                                      isIncluded = true;
                                      finalPos = g.position + offsetX;
                                    } else if (g.orientation === 'horizontal') {
                                      isIncluded = true;
                                      finalPos = g.position + offsetY;
                                    }
                                  }
                                } else {
                                  isIncluded = true;
                                  if (g.orientation === 'vertical') {
                                    finalPos = g.position + (isRightSide ? docRightPageOffset + offsetX : offsetX);
                                  } else {
                                    finalPos = g.position + offsetY;
                                  }
                                }

                                if (isIncluded) {
                                  masterGuidesToRender.push({
                                    id: `master-${master.id}-${g.id}`,
                                    orientation: g.orientation,
                                    position: finalPos,
                                  });
                                }
                              });
                            };

                            const leftMasterId = assignments[spreadLeftPage] ?? null;
                            collectMasterGuides(leftMasterId, false);

                            if (isSpread && spreadHasRight) {
                              const rightMasterId = assignments[spreadRightPage] ?? null;
                              collectMasterGuides(rightMasterId, true);
                            }

                            return masterGuidesToRender.map(g => (
                              <Line
                                key={`master-guide-${g.id}`}
                                points={
                                  g.orientation === 'horizontal'
                                    ? [-99999, 0, 99999, 0]
                                    : [0, -99999, 0, 99999]
                                }
                                x={g.orientation === 'vertical' ? g.position : 0}
                                y={g.orientation === 'horizontal' ? g.position : 0}
                                stroke="rgba(0, 180, 180, 0.45)"
                                dash={[3, 3]}
                                strokeWidth={1 / scale}
                                listening={false}
                              />
                            ));
                          })()}

                          {/* Drag-selection rubber-band rect */}
                          {selectionBox && (
                            <Rect
                              x={selectionBox.x} y={selectionBox.y}
                              width={selectionBox.w} height={selectionBox.h}
                              fill="rgba(77, 166, 255, 0.2)" stroke="#4da6ff" strokeWidth={1}
                            />
                          )}

                          {/* Brush resize preview */}
                          {isResizingBrushRef.current && (
                            <Circle
                              x={previewCursor.x}
                              y={previewCursor.y}
                              radius={brushThickness / 2}
                              fill="rgba(0,0,0,0.2)"
                              stroke="black"
                              strokeWidth={1}
                              listening={false}
                            />
                          )}

                          {/* Brush hover preview */}
                          {activeTool === 'brush' && !isResizingBrushRef.current && !isDrawingRef.current && (
                            <Circle
                              x={hoverPos.x}
                              y={hoverPos.y}
                              radius={brushThickness / 2}
                              fill="rgba(0,0,0,0.2)"
                              stroke="black"
                              strokeWidth={1}
                              listening={false}
                            />
                          )}

                          {/* Vertex handles for point-based shape editing */}
                          {(() => {
                            if (isScaleMode || selectedShapeIds.length !== 1) return null;
                            const shape = shapes.find(s => s.id === selectedShapeIds[0]);
                            if (!shape || !shape.points || !POINT_BASED_TYPES.includes(shape.type)) return null;
                            if (shape.type === 'polygon') return null;

                            const pdfPageW = pdfNativeSizeRef.current?.w ?? 0;
                            const spineGap = 0;
                            const spreadOffsetX = (spreadHasRight && isSpread && shape.page === spreadRightPage && pdfPageW > 0)
                              ? pdfPageW + spineGap
                              : 0;

                            const nodes: React.ReactNode[] = shape.points.map((_, i) => {
                              if (i % 2 !== 0) return null;
                              const isLineMarkType = isLineMark(shape.type);
                              const px = (isLineMarkType ? (shape.x || 0) : 0) + spreadOffsetX + shape.points![i];
                              const py = (isLineMarkType ? (shape.y || 0) : 0) + shape.points![i + 1];
                              return (
                                <Circle key={`${shape.id}-node-${i}`}
                                  id={`vertex-handle-${shape.id}-${i}`}
                                  name="vertex-handle"
                                  x={px} y={py} radius={6 / scale}
                                  fill="white" stroke="#4da6ff" strokeWidth={2 / scale}
                                  draggable
                                  dragBoundFunc={getSnappedCanvasPos}
                                  onDragStart={() => {
                                    pushToHistory();
                                    if (shape.type === 'arc') {
                                      updateShape(shape.id, { type: 'spline' as any });
                                    }
                                  }}
                                  onDragMove={e => {
                                    let mx = e.target.x(), my = e.target.y();
                                    if (shape.type === 'callout' && i === 0 && shape.parentId) {
                                      const parent = shapes.find(s => s.id === shape.parentId);
                                      if (parent?.points) {
                                        let minDst = Infinity, bestX = parent.points[0], bestY = parent.points[1];
                                        let bestSeg = 0;
                                        const localMx = mx - spreadOffsetX;
                                        for (let k = 0; k < parent.points.length; k += 2) {
                                          const x1 = parent.points[k], y1 = parent.points[k + 1];
                                          const nextK = (k + 2) % parent.points.length;
                                          const x2 = parent.points[nextK], y2 = parent.points[nextK + 1];
                                          const A = localMx - x1, B = my - y1, C = x2 - x1, D = y2 - y1;
                                          const dot = A * C + B * D, len_sq = C * C + D * D;
                                          let param = len_sq !== 0 ? dot / len_sq : -1;
                                          const xx = param < 0 ? x1 : param > 1 ? x2 : x1 + param * C;
                                          const yy = param < 0 ? y1 : param > 1 ? y2 : y1 + param * D;
                                          const d = Math.pow(xx - localMx, 2) + Math.pow(yy - my, 2);
                                          if (d < minDst) { minDst = d; bestX = xx; bestY = yy; bestSeg = k; }
                                        }
                                        const bX1 = parent.points[bestSeg], bY1 = parent.points[bestSeg + 1];
                                        const ni = (bestSeg + 2) % parent.points.length;
                                        const bX2 = parent.points[ni], bY2 = parent.points[ni + 1];
                                        const dx = bX2 - bX1, dy = bY2 - bY1, len = Math.sqrt(dx * dx + dy * dy);
                                        if (len > 0) {
                                          const bump = Math.max(parent.radius || 20, 5);
                                          const dist_along = Math.sqrt(Math.pow(bestX - bX1, 2) + Math.pow(bestY - bY1, 2));
                                          const f = Math.min(1, Math.max(0, dist_along / len));
                                          const arcCount = Math.max(1, Math.round(len / (bump * 1.5)));
                                          const j = Math.min(arcCount - 1, Math.floor(f * arcCount));
                                          const lt = (f * arcCount) - j;
                                          
                                          const p0x = bX1 + (j / arcCount) * dx, p0y = bY1 + (j / arcCount) * dy;
                                          const p2x = bX1 + ((j + 1) / arcCount) * dx, p2y = bY1 + ((j + 1) / arcCount) * dy;
                                          const amx = (p0x + p2x) / 2, amy = (p0y + p2y) / 2;
                                          const p1x = amx + (-dy / len) * bump, p1y = amy + (dx / len) * bump;
                                          
                                          const mt = 1 - lt;
                                          bestX = mt * mt * p0x + 2 * mt * lt * p1x + lt * lt * p2x;
                                          bestY = mt * mt * p0y + 2 * mt * lt * p1y + lt * lt * p2y;
                                        }
                                        mx = bestX + spreadOffsetX; my = bestY;
                                        e.target.x(mx); e.target.y(my);
                                      }
                                    }
                                    const isLineMarkType = isLineMark(shape.type);
                                    let relX = mx - spreadOffsetX - (isLineMarkType ? (shape.x || 0) : 0);
                                    let relY = my - (isLineMarkType ? (shape.y || 0) : 0);

                                    if (shiftDownRef.current && shape.points && shape.points.length >= 4) {
                                      const anchorIndex = (i === 0) ? 2 : i - 2;
                                      if (anchorIndex >= 0 && anchorIndex < shape.points.length) {
                                        const anchorX = shape.points[anchorIndex];
                                        const anchorY = shape.points[anchorIndex + 1];
                                        const constrained = shiftConstrain(anchorX, anchorY, relX, relY);
                                        relX = constrained.x;
                                        relY = constrained.y;
                                        mx = relX + spreadOffsetX + (isLineMarkType ? (shape.x || 0) : 0);
                                        my = relY + (isLineMarkType ? (shape.y || 0) : 0);
                                        e.target.x(mx);
                                        e.target.y(my);
                                      }
                                    }

                                    const newPts = [...shape.points!];
                                    if (isLineMark(shape.type) && i === 0) {
                                      // Moving the anchor (start point) of a line mark
                                      const oldAbsEndX = (shape.x || 0) + (shape.points![2] || 0);
                                      const oldAbsEndY = (shape.y || 0) + (shape.points![3] || 0);
                                      updateShape(shape.id, {
                                        x: mx - spreadOffsetX,
                                        y: my,
                                        points: [0, 0, oldAbsEndX - (mx - spreadOffsetX), oldAbsEndY - my]
                                      });
                                    } else {
                                      newPts[i] = relX;
                                      newPts[i + 1] = relY;
                                      updateShape(shape.id, { points: newPts });
                                    }
                                    if (shape.type === 'cloud') {
                                      shapes.forEach(child => {
                                        if (child.type === 'callout' && child.parentId === shape.id && child.points) {
                                          const cPts = [...child.points];
                                          let minDst = Infinity, bestX = newPts[0], bestY = newPts[1];
                                          let bestSeg = 0;
                                          const tx = child.x, ty = child.y + (child.height || 60) / 2;
                                          for (let k = 0; k < newPts.length; k += 2) {
                                            const x1 = newPts[k], y1 = newPts[k + 1];
                                            const nextK = (k + 2) % newPts.length;
                                            const x2 = newPts[nextK], y2 = newPts[nextK + 1];
                                            const A = tx - x1, B = ty - y1, C = x2 - x1, D = y2 - y1;
                                            const dot = A * C + B * D, len_sq = C * C + D * D;
                                            let param = len_sq !== 0 ? dot / len_sq : -1;
                                            const xx = param < 0 ? x1 : param > 1 ? x2 : x1 + param * C;
                                            const yy = param < 0 ? y1 : param > 1 ? y2 : y1 + param * D;
                                            const dst = Math.pow(xx - tx, 2) + Math.pow(yy - ty, 2);
                                            if (dst < minDst) { minDst = dst; bestX = xx; bestY = yy; bestSeg = k; }
                                          }
                                          const bX1 = newPts[bestSeg], bY1 = newPts[bestSeg + 1];
                                          const ni = (bestSeg + 2) % newPts.length;
                                          const bX2 = newPts[ni], bY2 = newPts[ni + 1];
                                          const dx = bX2 - bX1, dy = bY2 - bY1, len = Math.sqrt(dx * dx + dy * dy);
                                          if (len > 0) {
                                            const bump = Math.max(shape.radius || 20, 5);
                                            const dist_along = Math.sqrt(Math.pow(bestX - bX1, 2) + Math.pow(bestY - bY1, 2));
                                            const f = Math.min(1, Math.max(0, dist_along / len));
                                            const arcCount = Math.max(1, Math.round(len / (bump * 1.5)));
                                            const j = Math.min(arcCount - 1, Math.floor(f * arcCount));
                                            const lt = (f * arcCount) - j;
                                            
                                            const p0x = bX1 + (j / arcCount) * dx, p0y = bY1 + (j / arcCount) * dy;
                                            const p2x = bX1 + ((j + 1) / arcCount) * dx, p2y = bY1 + ((j + 1) / arcCount) * dy;
                                            const amx = (p0x + p2x) / 2, amy = (p0y + p2y) / 2;
                                            const p1x = amx + (-dy / len) * bump, p1y = amy + (dx / len) * bump;
                                            
                                            const mt = 1 - lt;
                                            bestX = mt * mt * p0x + 2 * mt * lt * p1x + lt * lt * p2x;
                                            bestY = mt * mt * p0y + 2 * mt * lt * p1y + lt * lt * p2y;
                                          }
                                          cPts[0] = bestX; cPts[1] = bestY;
                                          updateShape(child.id, { points: cPts });
                                        }
                                      });
                                    }
                                  }}
                                />
                              );
                            }).filter(Boolean);

                            if (shape.type === 'callout') {
                              nodes.push(
                                <Circle key={`${shape.id}-node-box`}
                                  id={`callout-handle-${shape.id}-box`}
                                  name="callout-handle"
                                  x={shape.x + spreadOffsetX} y={shape.y} radius={6 / scale}
                                  fill="gold" stroke="#ef4444" strokeWidth={2 / scale}
                                  draggable
                                  onDragStart={() => pushToHistory()}
                                  onDragMove={e => updateShape(shape.id, { x: e.target.x() - spreadOffsetX, y: e.target.y() })}
                                />,
                                <Rect key={`${shape.id}-node-width`}
                                  id={`callout-handle-${shape.id}-width`}
                                  name="callout-handle"
                                  x={shape.x + spreadOffsetX + (shape.width || 100)}
                                  y={shape.y + (shape.height || 50) / 2 - 8 / scale}
                                  width={8 / scale} height={16 / scale}
                                  fill="white" stroke="#4da6ff" strokeWidth={2 / scale}
                                  draggable
                                  onDragStart={() => pushToHistory()}
                                  onDragMove={e => updateShape(shape.id, { width: Math.max(30, e.target.x() - spreadOffsetX - shape.x) })}
                                  onDragEnd={e => e.target.y(shape.y + (shape.height || 50) / 2 - 8 / scale)}
                                />,
                                <Rect key={`${shape.id}-node-height`}
                                  id={`callout-handle-${shape.id}-height`}
                                  name="callout-handle"
                                  x={shape.x + spreadOffsetX + (shape.width || 100) / 2 - 8 / scale}
                                  y={shape.y + (shape.height || 50)}
                                  width={16 / scale} height={8 / scale}
                                  fill="white" stroke="#4da6ff" strokeWidth={2 / scale}
                                  draggable
                                  onDragStart={() => pushToHistory()}
                                  onDragMove={e => updateShape(shape.id, { height: Math.max(20, e.target.y() - shape.y) })}
                                  onDragEnd={e => e.target.x(shape.x + spreadOffsetX + (shape.width || 100) / 2 - 8 / scale)}
                                />,
                                <Circle key={`${shape.id}-node-corner`}
                                  id={`callout-handle-${shape.id}-corner`}
                                  name="callout-handle"
                                  x={shape.x + spreadOffsetX + (shape.width || 100)}
                                  y={shape.y + (shape.height || 50)}
                                  radius={5 / scale}
                                  fill="white" stroke="#4da6ff" strokeWidth={2 / scale}
                                  draggable
                                  onDragStart={() => pushToHistory()}
                                  onDragMove={e => {
                                    const w = Math.max(30, e.target.x() - spreadOffsetX - shape.x);
                                    const h = Math.max(20, e.target.y() - shape.y);
                                    updateShape(shape.id, { width: w, height: h });
                                  }}
                                  onDragEnd={e => {
                                    e.target.x(shape.x + spreadOffsetX + (shape.width || 100));
                                    e.target.y(shape.y + (shape.height || 50));
                                  }}
                                />
                              );
                            }
                            if (['arrow', 'spline'].includes(shape.type) && shape.text && shape.points && shape.points.length >= 4) {
                              const x = shape.points[0];
                              const y = shape.points[1];
                              const isRight = shape.points[2] >= shape.points[0];
                              const tW = shape.width || 150;
                              const tH = shape.height || 40;
                              const tx = isRight ? x - tW - 10 : x + 10;
                              const ty = y - tH / 2;

                              const widthHandleX = isRight ? tx : tx + tW;
                              const widthHandleY = ty + tH / 2 - 8 / scale;

                              const heightHandleX = tx + tW / 2 - 8 / scale;
                              const heightHandleY = ty + tH;

                              const cornerHandleX = isRight ? tx : tx + tW;
                              const cornerHandleY = ty + tH;

                              nodes.push(
                                <Rect key={`${shape.id}-node-width`}
                                  id={`arrow-text-handle-${shape.id}-width`}
                                  name="arrow-text-handle"
                                  x={widthHandleX + spreadOffsetX}
                                  y={widthHandleY}
                                  width={8 / scale} height={16 / scale}
                                  fill="white" stroke="#4da6ff" strokeWidth={2 / scale}
                                  draggable
                                  onDragStart={() => pushToHistory()}
                                  onDragMove={e => {
                                    const newX = e.target.x() - spreadOffsetX;
                                    const newW = isRight
                                      ? Math.max(30, x - 10 - newX)
                                      : Math.max(30, newX - (x + 10));
                                    updateShape(shape.id, { width: newW });
                                  }}
                                  onDragEnd={e => {
                                    e.target.y(ty + tH / 2 - 8 / scale);
                                  }}
                                />,
                                <Rect key={`${shape.id}-node-height`}
                                  id={`arrow-text-handle-${shape.id}-height`}
                                  name="arrow-text-handle"
                                  x={heightHandleX + spreadOffsetX}
                                  y={heightHandleY}
                                  width={16 / scale} height={8 / scale}
                                  fill="white" stroke="#4da6ff" strokeWidth={2 / scale}
                                  draggable
                                  onDragStart={() => pushToHistory()}
                                  onDragMove={e => {
                                    const newH = Math.max(20, e.target.y() - ty);
                                    updateShape(shape.id, { height: newH });
                                  }}
                                  onDragEnd={e => {
                                    e.target.x(tx + tW / 2 - 8 / scale + spreadOffsetX);
                                  }}
                                />,
                                <Circle key={`${shape.id}-node-corner`}
                                  id={`arrow-text-handle-${shape.id}-corner`}
                                  name="arrow-text-handle"
                                  x={cornerHandleX + spreadOffsetX}
                                  y={cornerHandleY}
                                  radius={5 / scale}
                                  fill="white" stroke="#4da6ff" strokeWidth={2 / scale}
                                  draggable
                                  onDragStart={() => pushToHistory()}
                                  onDragMove={e => {
                                    const newX = e.target.x() - spreadOffsetX;
                                    const newW = isRight
                                      ? Math.max(30, x - 10 - newX)
                                      : Math.max(30, newX - (x + 10));
                                    const newH = Math.max(20, e.target.y() - ty);
                                    updateShape(shape.id, { width: newW, height: newH });
                                  }}
                                  onDragEnd={e => {
                                    e.target.x((isRight ? tx : tx + tW) + spreadOffsetX);
                                    e.target.y(ty + tH);
                                  }}
                                />
                              );
                            }
                            return nodes;
                          })()}

                          {selectedShapeIds.length > 0 && (
                            <Transformer
                              ref={trRef}
                              resizeEnabled={!selectedShapeIds.some(id => {
                                const s = shapes.find(x => x.id === id);
                                // Disable resize for callout (custom handles) and line marks,
                                // and for content boxes in content mode (orange handles instead).
                                return s && (
                                  s.type === 'callout' ||
                                  isLineMark(s.type ?? '') ||
                                  (s.type === 'content_box' && s.contentMode === 'content')
                                );
                              })}
                              rotateEnabled={!selectedShapeIds.some(id => {
                                const s = shapes.find(x => x.id === id);
                                return s && (
                                  s.type === 'callout' ||
                                  isLineMark(s.type ?? '') ||
                                  (s.type === 'content_box' && s.contentMode === 'content')
                                );
                              })}
                              boundBoxFunc={(oldBox, newBox) => {
                                // Basic sanity floor
                                if (newBox.width < 5 || newBox.height < 5) return oldBox;
                                // For mark shapes enforce text-based minimum
                                if (selectedShapeIds.length === 1) {
                                  const s = shapes.find(x => x.id === selectedShapeIds[0]);
                                  if (s && isMarkType(s.type) && s.fontSize) {
                                    const maxLabel = Object.values(s.markerData || {}).reduce(
                                      (a, b) => (b.length > a.length ? b : a), 'A'
                                    );
                                    const minDim = Math.max(s.fontSize * Math.max(maxLabel.length * 0.65, 2), 40);
                                    if (newBox.width < minDim || newBox.height < minDim) return oldBox;
                                  }
                                }
                                return newBox;
                              }}
                              anchorDragBoundFunc={(_, newPos) => getSnappedCanvasPos(newPos)}
                              rotationSnaps={[0, 45, 90, 135, 180, 225, 270, 315]}
                              rotationSnapTolerance={10}
                            />
                          )}

                          {/* Active CAD Vector Snap Indicator */}
                          {activeSnap && (() => {
                            const size = 8 / scale;
                            const strokeW = 1.5 / scale;
                            const { type, x: sx, y: sy } = activeSnap;

                            if (type === 'endpoint') {
                              return (
                                <Rect
                                  x={sx - size / 2}
                                  y={sy - size / 2}
                                  width={size}
                                  height={size}
                                  stroke="#10b981"
                                  strokeWidth={strokeW}
                                  fill="rgba(16, 185, 129, 0.15)"
                                  listening={false}
                                />
                              );
                            } else if (type === 'midpoint') {
                              return (
                                <RegularPolygon
                                  x={sx}
                                  y={sy}
                                  sides={3}
                                  radius={size * 0.65}
                                  stroke="#10b981"
                                  strokeWidth={strokeW}
                                  fill="rgba(16, 185, 129, 0.15)"
                                  listening={false}
                                />
                              );
                            } else if (type === 'nearest') {
                              return (
                                <Circle
                                  x={sx}
                                  y={sy}
                                  radius={size * 0.35}
                                  stroke="#10b981"
                                  strokeWidth={strokeW}
                                  fill="rgba(16, 185, 129, 0.15)"
                                  listening={false}
                                />
                              );
                            }
                            return null;
                          })()}

                          {/* Parallel Snapping Guide Line */}
                          {parallelSnapGuide && (
                            <Line
                              points={[
                                parallelSnapGuide.start.x, parallelSnapGuide.start.y,
                                parallelSnapGuide.end.x, parallelSnapGuide.end.y
                              ]}
                              stroke="#8b5cf6"
                              strokeWidth={2 / scale}
                              dash={[6 / scale, 4 / scale]}
                              listening={false}
                            />
                          )}

                          {/* Smart Alignment Guides */}
                          {smartGuides.vertical !== null && (() => {
                            const pageW = pdfNativeSizeRef.current?.w ?? 0;
                            const isCentre = centerSnapEnabled && pageW > 0 && (
                              Math.abs(smartGuides.vertical - pageW / 2) < 0.5 ||
                              Math.abs(smartGuides.vertical - (pageW + pageW / 2)) < 0.5 ||
                              // Spread centre (spine)
                              (isSpread && spreadHasRight && Math.abs(smartGuides.vertical - pageW) < 0.5)
                            );
                            return (
                              <Line
                                points={[0, -99999, 0, 99999]}
                                x={smartGuides.vertical}
                                y={0}
                                stroke={isCentre ? '#fb923c' : '#8b5cf6'}
                                strokeWidth={isCentre ? 2 / scale : 1.5 / scale}
                                dash={[5 / scale, 5 / scale]}
                                listening={false}
                              />
                            );
                          })()}
                          {smartGuides.horizontal !== null && (() => {
                            const pageH = pdfNativeSizeRef.current?.h ?? 0;
                            const isCentre = centerSnapEnabled && pageH > 0 &&
                              Math.abs(smartGuides.horizontal - pageH / 2) < 0.5;
                            return (
                              <Line
                                points={[-99999, 0, 99999, 0]}
                                x={0}
                                y={smartGuides.horizontal}
                                stroke={isCentre ? '#fb923c' : '#8b5cf6'}
                                strokeWidth={isCentre ? 2 / scale : 1.5 / scale}
                                dash={[5 / scale, 5 / scale]}
                                listening={false}
                              />
                            );
                          })()}

                          {/* Page Centre Reference Lines (shown when Centre Snap is active) */}
                          {centerSnapEnabled && (() => {
                            const pageW = pdfNativeSizeRef.current?.w ?? 0;
                            const pageH = pdfNativeSizeRef.current?.h ?? 0;
                            if (pageW === 0 || pageH === 0) return null;
                            const lines = [];
                            // Horizontal centre
                            lines.push(
                              <Line key="centre-h"
                                points={[-99999, 0, 99999, 0]}
                                x={0} y={pageH / 2}
                                stroke="#fb923c" strokeWidth={0.6 / scale}
                                dash={[4 / scale, 8 / scale]}
                                opacity={0.35} listening={false}
                              />
                            );
                            // Vertical centre of left (or solo) page
                            lines.push(
                              <Line key="centre-v-left"
                                points={[0, -99999, 0, 99999]}
                                x={pageW / 2} y={0}
                                stroke="#fb923c" strokeWidth={0.6 / scale}
                                dash={[4 / scale, 8 / scale]}
                                opacity={0.35} listening={false}
                              />
                            );
                            // Vertical centre of right spread page
                            if (isSpread && spreadHasRight) {
                              lines.push(
                                <Line key="centre-v-right"
                                  points={[0, -99999, 0, 99999]}
                                  x={pageW + pageW / 2} y={0}
                                  stroke="#fb923c" strokeWidth={0.6 / scale}
                                  dash={[4 / scale, 8 / scale]}
                                  opacity={0.35} listening={false}
                                />
                              );
                              // Spread centre = spine at x=pageW (slightly brighter to distinguish)
                              lines.push(
                                <Line key="centre-v-spread"
                                  points={[0, -99999, 0, 99999]}
                                  x={pageW} y={0}
                                  stroke="#fb923c" strokeWidth={0.9 / scale}
                                  dash={[6 / scale, 6 / scale]}
                                  opacity={0.5} listening={false}
                                />
                              );
                            }
                            return lines;
                          })()}
                        </Layer>
                      </Stage>
                    </div>

                    {/* INLINE TEXT EDITOR OVERLAY */}
                    {inlineEditText && (
                      <textarea
                        id="inline-editor-textarea"
                        value={inlineEditText.text === 'Double click to edit...' ? '' : inlineEditText.text}
                        placeholder="Type text here..."
                        onChange={e => setInlineEditText({ ...inlineEditText, text: e.target.value })}
                        onBlur={() => {
                          const shape = shapes.find(s => s.id === inlineEditText.id);
                          if (!shape) { setInlineEditText(null); return; }
                          const finalTxt = inlineEditText.text === 'Double click to edit...' ? '' : inlineEditText.text;

                          if (shape.type === 'table' && inlineEditText.cellId) {
                            if (shape.tableData?.cells?.[inlineEditText.cellId]?.text !== finalTxt) {
                              pushToHistory();
                              const newCells = { ...(shape.tableData?.cells || {}) };
                              newCells[inlineEditText.cellId] = { ...newCells[inlineEditText.cellId], text: finalTxt };
                              updateShape(shape.id, { tableData: { ...shape.tableData, cells: newCells } as any });
                            }
                          } else if (inlineEditText.text !== (shape.text || '')) {
                            pushToHistory();
                            updateShape(inlineEditText.id, { text: finalTxt });
                          }
                          setInlineEditText(null);
                        }}
                        onKeyDown={e => {
                          if (e.key === 'Escape' || (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey)) {
                            e.preventDefault();
                            const shape = shapes.find(s => s.id === inlineEditText.id);
                            if (shape) {
                              const finalTxt = inlineEditText.text === 'Double click to edit...' ? '' : inlineEditText.text;
                              if (shape.type === 'table' && inlineEditText.cellId) {
                                if (shape.tableData?.cells?.[inlineEditText.cellId]?.text !== finalTxt) {
                                  pushToHistory();
                                  const newCells = { ...(shape.tableData?.cells || {}) };
                                  newCells[inlineEditText.cellId] = { ...newCells[inlineEditText.cellId], text: finalTxt };
                                  updateShape(shape.id, { tableData: { ...shape.tableData, cells: newCells } as any });
                                }
                              } else if (inlineEditText.text !== (shape.text || '')) {
                                pushToHistory();
                                updateShape(inlineEditText.id, { text: finalTxt });
                              }
                            }
                            setInlineEditText(null);
                          } else if (e.key === 'Enter' && e.ctrlKey) {
                            // Insert newline on Ctrl+Enter
                            e.preventDefault();
                            setInlineEditText({ ...inlineEditText, text: inlineEditText.text + '\n' });
                          }
                          e.stopPropagation();
                        }}
                        style={{
                          position:  'absolute',
                          left:      inlineEditText.x + visibleBox.x,
                          top:       inlineEditText.y + visibleBox.y,
                          width:     inlineEditText.w,
                          minHeight: inlineEditText.h + 20,
                          fontSize:  (inlineEditText.fontSize || 16) * scale,
                          fontFamily: inlineEditText.fontFamily || 'Inter',
                          fontWeight: inlineEditText.isBold ? 'bold' : 'normal',
                          fontStyle: inlineEditText.isItalic ? 'italic' : 'normal',
                          textDecoration: `${inlineEditText.isUnderline ? 'underline ' : ''}${inlineEditText.isStrike ? 'line-through' : ''}`.trim() || 'none',
                          lineHeight: 1.2,
                          color: inlineEditText.strokeColor || '#000',
                          background: 'rgba(255, 255, 255, 0.95)',
                          border: '2px dashed #4da6ff',
                          borderRadius: 4,
                          outline: 'none',
                          resize: 'both',
                          zIndex: 9999,
                          padding: 5 * scale,
                          boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
                          overflow: 'hidden',
                        }}
                      />
                    )}

                  </div>{/* canvas-container */}
                </div>{/* canvas-wrapper */}
              </div>{/* flex row */}
            </>
          )}
        </div>/* workspace-container */
      )}

      {/* Guide drag-from-ruler preview overlay � fixed full-screen cyan line following cursor */}
      {isActive && draggingFromRuler && (
        <div
          style={{
            position: 'fixed',
            pointerEvents: 'none',
            zIndex: 99999,
            backgroundColor: 'rgba(0, 255, 255, 0.75)',
            boxShadow: '0 0 8px rgba(0, 255, 255, 0.5)',
            ...(draggingFromRuler.orientation === 'horizontal'
              ? { left: 0, top: guidePreviewPos.y, width: '100vw', height: '1px' }
              : { left: guidePreviewPos.x, top: 0, width: '1px', height: '100vh' }),
          }}
        />
      )}
    </main>
  );
});
