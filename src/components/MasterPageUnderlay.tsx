// ─────────────────────────────────────────────────────────────────────────────
// MasterPageUnderlay.tsx
//
// Renders the Master Page background beneath all active document markup.
//
// Architecture:
//   • Sits BELOW the editable Konva Layer in the Konva Stage.
//   • All nodes have listening={false} — completely pointer-dead (glass shield).
//   • The PDF background (if any) is painted on a plain <canvas> element that
//     is absolutely positioned behind the Konva Stage's canvas elements.
//   • Smart text variables are resolved at render time via evaluateSmartText().
//
// Usage (inside DocumentViewer.tsx):
//   <Stage ...>
//     <MasterUnderlayLayer tabId={tabId} pageNum={pageNum} scale={scale}
//                          panOffset={panOffset} stageRef={stageRef} />
//     <Layer scaleX={scale} scaleY={scale}>   ← existing editable layer
//       ...shapes...
//     </Layer>
//   </Stage>
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import Konva from 'konva';
import {
  Layer, Rect, Line, Text, Group, Path, Circle, Shape,
} from 'react-konva';
import { useStore } from '../store/useStore';
import type { ShapeData, MasterPage } from '../store/useStore';
import { evaluateSmartText, containsSmartText } from '../utils/smartText';
import { PatternEngine } from '../utils/PatternEngine';
import { TableRenderer } from './TableRenderer';
import { MarksShapeRenderer, isMarkType, isLineMark } from './MarksRenderer';
import { getSpreads } from '../utils/spreadLayout';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  `//unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

// ─── Master Background Canvas ─────────────────────────────────────────────────
// Renders the master's background PDF page (if any) onto a <canvas> element
// that is absolutely positioned to align with the Konva stage.

interface MasterBgCanvasProps {
  master: MasterPage;
  scale: number;
  panOffset: { x: number; y: number };
  offsetX?: number;
  offsetY?: number;
  side?: 'left' | 'right';
}

export function MasterBgCanvas({ master, scale, panOffset, offsetX = 0, offsetY = 0, side }: MasterBgCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [, setNonce] = useState(0); // trigger re-render when pdf loads

  useEffect(() => {
    if (!master.backgroundPdfBytes || !canvasRef.current) return;

    let cancelled = false;
    const canvas = canvasRef.current;

    pdfjsLib.getDocument({ data: new Uint8Array(master.backgroundPdfBytes.slice(0)) }).promise
      .then(async (pdf) => {
        if (cancelled) return;
        const pageIdx = Math.max(1, Math.min(master.backgroundPageNum, pdf.numPages));
        const page = await pdf.getPage(pageIdx);
        if (cancelled) return;

        const viewport = page.getViewport({ scale });
        const dpr = window.devicePixelRatio || 1;

        const isRight = side === 'right';
        const isSpreadMaster = master.isSpread;
        const renderWidth = isSpreadMaster ? viewport.width / 2 : viewport.width;

        canvas.width = renderWidth * dpr;
        canvas.height = viewport.height * dpr;
        canvas.style.width = `${renderWidth}px`;
        canvas.style.height = `${viewport.height}px`;

        const ctx = canvas.getContext('2d')!;
        ctx.scale(dpr, dpr);
        if (isSpreadMaster && isRight) {
          ctx.translate(-viewport.width / 2, 0);
        }
        await page.render({ canvasContext: ctx, viewport } as any).promise;
        if (!cancelled) setNonce(n => n + 1);
      })
      .catch(() => { /* silently ignore if bytes are invalid */ });

    return () => { cancelled = true; };
  }, [master.backgroundPdfBytes, master.backgroundPageNum, scale, side]);

  if (!master.backgroundPdfBytes) return null;

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        top: panOffset.y + offsetY * scale,
        left: panOffset.x + offsetX * scale,
        pointerEvents: 'none',
        opacity: 0.9,
        imageRendering: 'crisp-edges',
        zIndex: 0, // behind the Konva canvas stack
      }}
    />
  );
}

// ─── Smart Text Resolver ───────────────────────────────────────────────────────
// Resolves {{...}} variables in a shape's text field for a given page context.

function resolveText(
  text: string | undefined,
  pageNum: number,
  totalPages: number,
  docTitle: string,
): string {
  if (!text) return '';
  if (!containsSmartText(text)) return text;
  return evaluateSmartText(text, {
    pageNum,
    totalPages,
    date: new Date().toLocaleDateString(),
    docTitle,
  });
}

// ─── Single Shape Renderer (read-only) ───────────────────────────────────────
// A simplified shape renderer for master page shapes.
// All nodes set listening={false} — the glass shield.

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

function renderUnderlayArrowHead(shape: ShapeData) {
  const type = shape.arrowHeadType ?? 'arrow';
  if (shape.showArrowHead === false || type === 'none' || !shape.points || shape.points.length < 4) return null;

  const n = shape.points.length;
  let x2 = shape.points[n - 2], y2 = shape.points[n - 1];
  let angle = Math.atan2(y2 - shape.points[n - 3], x2 - shape.points[n - 4]);

  // Spline tension points tangent logic
  if (shape.type === 'spline' && shape.points.length >= 4) {
    const line = new Konva.Line({ points: shape.points, tension: 0.5 });
    const tpts = line.getTensionPoints();
    if (tpts && tpts.length >= 6) {
      const tlen = tpts.length;
      const P0x = tpts[tlen - 4], P0y = tpts[tlen - 3];
      const P1x = tpts[tlen - 2], P1y = tpts[tlen - 1];
      const P2x = x2, P2y = y2;
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

  const noEvents = {
    listening: false,
    perfectDrawEnabled: false,
    shadowForStrokeEnabled: false,
  } as const;

  if (type === 'circle') {
    return (
      <Circle
        {...noEvents}
        x={x2} y={y2} radius={size / 2}
        fill={filled ? (shape.strokeColor || '#000') : 'transparent'}
        stroke={shape.strokeColor || '#000'} strokeWidth={shape.strokeWidth}
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
          {...noEvents}
          x={x2} y={y2} rotation={angle * 180 / Math.PI}
          points={[p1x, p1y, 0, 0, p2x, p2y]}
          stroke={shape.strokeColor || '#000'} strokeWidth={shape.strokeWidth}
          lineCap="round" lineJoin="round"
        />
      );
    } else {
      return (
        <Line
          {...noEvents}
          x={x2} y={y2} rotation={angle * 180 / Math.PI}
          points={[p1x, p1y, 0, 0, p2x, p2y]} closed
          fill={filled ? (shape.strokeColor || '#000') : 'transparent'}
          stroke={shape.strokeColor || '#000'} strokeWidth={shape.strokeWidth}
          lineJoin="round"
        />
      );
    }
  }
  return null;
}

function renderUnderlayLabel(shape: ShapeData) {
  if (!shape.text || !shape.points || shape.points.length < 4) return null;
  const x = shape.points[0];
  const y = shape.points[1];
  const isRight = shape.points[2] >= shape.points[0];
  const tW = shape.width || 150;
  const tH = shape.height || 40;
  const tx = isRight ? x - tW - 10 : x + 10;
  const ty = y - tH / 2;

  const fontStyle = `${shape.isItalic ? 'italic ' : ''}${shape.isBold ? 'bold ' : ''}`.trim();
  const textDecoration = `${shape.isUnderline ? 'underline ' : ''}${shape.isStrike ? 'line-through' : ''}`.trim();

  const noEvents = {
    listening: false,
    perfectDrawEnabled: false,
    shadowForStrokeEnabled: false,
  } as const;

  return (
    <Text
      {...noEvents}
      x={tx} y={ty} width={tW} height={tH} align={isRight ? 'right' : 'left'}
      text={shape.text}
      fill={shape.strokeColor}
      fontSize={shape.fontSize || 16}
      fontFamily={shape.fontFamily || 'Inter'}
      fontStyle={fontStyle}
      textDecoration={textDecoration}
      wrap="word"
    />
  );
}

interface LockedShapeProps {
  shape: ShapeData;
  pageNum: number;
  totalPages: number;
  docTitle: string;
  tabId: string;
  scale: number;
}

function LockedShape({ shape, pageNum, totalPages, docTitle, tabId, scale }: LockedShapeProps) {
  const noEvents = {
    listening: false,
    perfectDrawEnabled: false,
    shadowForStrokeEnabled: false,
    currentScale: scale,
  } as const;

  const resolvedText = resolveText(shape.text, pageNum, totalPages, docTitle);

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

  if (isMarkType(shape.type)) {
    return (
      <MarksShapeRenderer
        shape={shape}
        commonProps={{
          ...noEvents,
          id: `shape-${shape.id}`,
        }}
        isSelected={false}
      />
    );
  }

  switch (shape.type) {
    case 'rect':
      return (
        <Rect
          {...noEvents}
          x={shape.x} y={shape.y}
          width={shape.width} height={shape.height}
          stroke={shape.strokeColor} strokeWidth={shape.strokeWidth}
          fill={shape.fillPatternId ? undefined : (shape.fillColor || 'transparent')}
          fillPatternImage={fillPatternImage as any} fillPatternRepeat="repeat"
          fillPatternOffsetX={fillPatternOffsetX} fillPatternOffsetY={fillPatternOffsetY}
          fillPatternScale={fillScale}
          dash={shape.dash}
          rotation={shape.rotation}
        />
      );

    case 'circle': {
      const rx = shape.width !== undefined ? shape.width / 2 : (shape.radius || 50);
      const ry = shape.height !== undefined ? shape.height / 2 : (shape.radius || 50);
      return (
        <Path
          {...noEvents}
          x={shape.x} y={shape.y}
          data={`M ${-rx},0 A ${rx},${ry} 0 1,0 ${rx},0 A ${rx},${ry} 0 1,0 ${-rx},0`}
          stroke={shape.strokeColor} strokeWidth={shape.strokeWidth}
          fill={shape.fillPatternId ? undefined : (shape.fillColor || 'transparent')}
          fillPatternImage={fillPatternImage as any} fillPatternRepeat="repeat"
          fillPatternOffsetX={fillPatternOffsetX} fillPatternOffsetY={fillPatternOffsetY}
          fillPatternScale={fillScale}
          rotation={shape.rotation}
        />
      );
    }

    case 'spline':
      return (
        <Group {...noEvents}>
          <Line
            {...noEvents}
            points={shape.points || []}
            stroke={shape.strokeColor} strokeWidth={shape.strokeWidth}
            dash={shape.dash}
            closed={shape.closed}
            lineCap="round" lineJoin="round"
            tension={0.5}
          />
          {renderUnderlayArrowHead(shape)}
          {renderUnderlayLabel(shape)}
        </Group>
      );

    case 'polygon':
      return (
        <Line
          {...noEvents}
          points={shape.points || []}
          stroke={shape.strokeColor} strokeWidth={shape.strokeWidth}
          dash={shape.dash}
          closed
          fill={shape.fillPatternId ? undefined : (shape.fillColor || 'transparent')}
          fillPatternImage={fillPatternImage as any} fillPatternRepeat="repeat"
          fillPatternOffsetX={fillPatternOffsetX} fillPatternOffsetY={fillPatternOffsetY}
          fillPatternScale={fillScale}
          lineCap="round" lineJoin="round"
        />
      );

    case 'cloud': {
      const renderPts = shape.points ? [...shape.points, shape.points[0], shape.points[1]] : [];
      return (
        <Group {...noEvents}>
          <Path
            {...noEvents}
            data={buildCloudSvgPath(renderPts || [], Math.max(shape.radius || 20, 5)) + ' Z'}
            stroke={shape.strokeColor} strokeWidth={shape.strokeWidth}
            fill={shape.fillPatternId ? undefined : (shape.fillColor || 'transparent')}
            fillPatternImage={fillPatternImage as any} fillPatternRepeat="repeat"
            fillPatternOffsetX={fillPatternOffsetX} fillPatternOffsetY={fillPatternOffsetY}
            fillPatternScale={fillScale}
          />
          {shape.text && shape.points && (
            <Text
              {...noEvents}
              x={shape.points[0] + 10} y={shape.points[1] + 10}
              text={shape.text} fill={shape.strokeColor}
              fontSize={shape.fontSize || 12} fontFamily="Inter"
            />
          )}
        </Group>
      );
    }

    case 'callout': {
      if (!shape.points) return null;
      const startX = shape.points[0], startY = shape.points[1];
      const boxX = shape.x, boxY = shape.y;
      const width = shape.width || 150, height = shape.height || 60;
      const fontStyle = `${shape.isItalic ? 'italic ' : ''}${shape.isBold ? 'bold ' : ''}`.trim();
      const textDecoration = `${shape.isUnderline ? 'underline ' : ''}${shape.isStrike ? 'line-through' : ''}`.trim();
      
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
      let elbowX = shape.points[2] ?? (isRight ? connectX - 20 : connectX + 20);
      const elbowY = shape.points[3] ?? connectY;

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
        <Group {...noEvents}>
          <Line
            {...noEvents}
            points={[startX, startY, elbowX, elbowY, connectX, connectY]}
            stroke={shape.strokeColor} strokeWidth={shape.strokeWidth}
          />
          <Group {...noEvents} x={boxX} y={boxY}>
            <Text
              {...noEvents}
              width={width} height={height}
              text={shape.text || ''} fill={shape.strokeColor}
              fontSize={shape.fontSize || 16} fontFamily={shape.fontFamily || 'Inter'}
              fontStyle={fontStyle} textDecoration={textDecoration}
              padding={5} wrap="word"
            />
          </Group>
        </Group>
      );
    }

    case 'table':
      return (
        <TableRenderer
          shape={shape}
          commonProps={noEvents}
          updateShape={() => {}}
          pushToHistory={() => {}}
          isSelected={false}
        />
      );

    case 'measure_length': {
      const pts = shape.points;
      if (!pts || pts.length < 4) return null;
      const dx = pts[2] - pts[0];
      const dy = pts[3] - pts[1];
      const rawPx = Math.sqrt(dx * dx + dy * dy);
      let lenStr = '';
      if (shape.measurementSystem && shape.measurementScale) {
        const paperInches = rawPx / 72.0;
        if (shape.measurementSystem === 'imperial') {
          lenStr = formatImperial(paperInches * shape.measurementScale);
        } else {
          lenStr = `${(rawPx * (25.4 / 72.0) * shape.measurementScale).toFixed(2)} mm`;
        }
      } else {
        const calibration = useStore.getState().documents[tabId]?.scaleCalibration || 1.0;
        lenStr = `${(rawPx * calibration).toFixed(2)}`;
      }
      const midX = pts[0] + dx / 2;
      const midY = pts[1] + dy / 2 - 20;

      const angle = Math.atan2(dy, dx);
      const tickLen = 8;
      const tickAngle = angle + Math.PI / 2;
      
      const t1_x1 = pts[0] - (tickLen / 2) * Math.cos(tickAngle);
      const t1_y1 = pts[1] - (tickLen / 2) * Math.sin(tickAngle);
      const t1_x2 = pts[0] + (tickLen / 2) * Math.cos(tickAngle);
      const t1_y2 = pts[1] + (tickLen / 2) * Math.sin(tickAngle);

      const t2_x1 = pts[2] - (tickLen / 2) * Math.cos(tickAngle);
      const t2_y1 = pts[3] - (tickLen / 2) * Math.sin(tickAngle);
      const t2_x2 = pts[2] + (tickLen / 2) * Math.cos(tickAngle);
      const t2_y2 = pts[3] + (tickLen / 2) * Math.sin(tickAngle);

      return (
        <Group {...noEvents}>
          <Line {...noEvents} points={pts} stroke={shape.strokeColor} strokeWidth={shape.strokeWidth} dash={shape.dash} lineCap="round" lineJoin="round" />
          <Line {...noEvents} points={[t1_x1, t1_y1, t1_x2, t1_y2]} stroke={shape.strokeColor} strokeWidth={shape.strokeWidth} lineCap="round" />
          <Line {...noEvents} points={[t2_x1, t2_y1, t2_x2, t2_y2]} stroke={shape.strokeColor} strokeWidth={shape.strokeWidth} lineCap="round" />
          {lenStr && (
            <Text {...noEvents} x={midX} y={midY} text={lenStr} fill={shape.strokeColor} fontSize={16} fontStyle="bold" align="center" offset={{ x: 20, y: 0 }} />
          )}
        </Group>
      );
    }

    case 'measure_area': {
      const pts = shape.points;
      if (!pts || pts.length < 6) return null;
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
      const areaCX = sumX / n;
      const areaCY = sumY / n;

      let areaStr = '';
      if (shape.measurementSystem && shape.measurementScale) {
        const scale2 = shape.measurementScale;
        if (shape.measurementSystem === 'imperial') {
          const paperInchSq = areaPixels / (72.0 * 72.0);
          const realInchSq = paperInchSq * scale2 * scale2;
          const realFtSq = realInchSq / 144;
          areaStr = realFtSq >= 1 ? `${realFtSq.toFixed(2)} ft²` : `${realInchSq.toFixed(2)} in²`;
        } else {
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

      return (
        <Group {...noEvents}>
          <Line {...noEvents}
            points={pts} stroke={shape.strokeColor}
            strokeWidth={shape.strokeWidth}
            dash={shape.dash}
            closed
            fill={shape.fillPatternId ? undefined : (shape.fillColor || 'rgba(77,166,255,0.12)')}
            fillPatternImage={fillPatternImage as any} fillPatternRepeat="repeat"
            fillPatternOffsetX={fillPatternOffsetX} fillPatternOffsetY={fillPatternOffsetY}
            fillPatternScale={fillScale}
            lineCap="round" lineJoin="round"
          />
          {areaStr && (
            <Text {...noEvents}
              x={areaCX} y={areaCY}
              text={areaStr}
              fill={shape.strokeColor || '#4da6ff'}
              fontSize={14} fontStyle="bold" fontFamily="Inter"
              align="center" offset={{ x: 0, y: 7 }}
            />
          )}
        </Group>
      );
    }

    case 'line':
    case 'freehand':
      return (
        <Line
          {...noEvents}
          points={shape.points || []}
          stroke={shape.strokeColor} strokeWidth={shape.strokeWidth}
          dash={shape.dash}
          lineCap="round" lineJoin="round"
          tension={shape.type === 'freehand' ? 0.5 : 0}
        />
      );

    case 'polyline':
      return (
        <Line
          {...noEvents}
          points={shape.points || []}
          stroke={shape.strokeColor} strokeWidth={shape.strokeWidth}
          dash={shape.dash}
          lineCap="round" lineJoin="round"
          tension={0}
          closed={'closed' in shape ? (shape as any).closed : false}
          fill={'closed' in shape && (shape as any).closed ? (shape.fillPatternId ? undefined : (shape.fillColor || 'transparent')) : 'transparent'}
          fillPatternImage={'closed' in shape && (shape as any).closed ? (fillPatternImage as any) : undefined}
          fillPatternRepeat="repeat"
          fillPatternOffsetX={fillPatternOffsetX} fillPatternOffsetY={fillPatternOffsetY}
          fillPatternScale={fillScale}
        />
      );

    case 'text': {
      const fontStyle = `${shape.isItalic ? 'italic ' : ''}${shape.isBold ? 'bold ' : ''}`.trim();
      const textDecoration = `${shape.isUnderline ? 'underline ' : ''}${shape.isStrike ? 'line-through' : ''}`.trim();
      return (
        <Group {...noEvents} x={shape.x} y={shape.y} rotation={shape.rotation}>
          <Text
            {...noEvents}
            width={shape.width} height={shape.height}
            text={resolvedText || 'Double click to edit...'}
            fill={shape.strokeColor}
            fontSize={shape.fontSize || 16}
            fontFamily={shape.fontFamily || 'Inter'}
            fontStyle={fontStyle}
            textDecoration={textDecoration}
            padding={5}
            wrap="word"
          />
        </Group>
      );
    }

    case 'arrow':
      return (
        <Group {...noEvents}>
          <Line
            {...noEvents}
            points={shape.points || []}
            stroke={shape.strokeColor}
            strokeWidth={shape.strokeWidth}
            dash={shape.dash}
            lineCap="round" lineJoin="round"
          />
          {renderUnderlayArrowHead(shape)}
          {renderUnderlayLabel(shape)}
        </Group>
      );

    case 'highlight':
      return (
        <Line
          {...noEvents}
          points={shape.points || []}
          stroke={shape.strokeColor}
          strokeWidth={shape.strokeWidth}
          opacity={0.5}
          tension={0.5}
          lineCap="round"
          lineJoin="round"
          globalCompositeOperation="multiply"
        />
      );

    case 'brush':
      return (
        <Line
          {...noEvents}
          points={shape.points || []}
          stroke={shape.strokeColor || '#000000'}
          strokeWidth={shape.strokeWidth}
          tension={0.5}
          lineCap="round"
          lineJoin="round"
        />
      );

    case 'arc':
      return (
        <Shape
          {...noEvents}
          stroke={shape.strokeColor}
          strokeWidth={shape.strokeWidth}
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

    case 'image': {
      return <LockedImageShape shape={shape} noEvents={noEvents} />;
    }

    case 'content_box': {
      return <LockedContentBoxShape shape={shape} noEvents={noEvents} />;
    }

    case 'stamp':
      return (
        <Group {...noEvents} x={shape.x} y={shape.y}>
          <Rect
            {...noEvents}
            width={shape.width} height={shape.height}
            stroke={shape.strokeColor} strokeWidth={shape.strokeWidth}
            cornerRadius={4} fill="rgba(255,255,255,0.1)"
          />
          <Text
            {...noEvents}
            width={shape.width} height={shape.height}
            text={shape.stampText}
            fill={shape.strokeColor}
            fontSize={Math.min((shape.width || 100) / 5, 24)}
            fontFamily="Inter" fontStyle="bold"
            align="center" verticalAlign="middle"
          />
        </Group>
      );

    default:
      // For all other shape types (architectural marks, etc.) render a simple rect outline
      // as a placeholder so masters still look meaningful even with complex marks.
      if (shape.points && shape.points.length >= 2) {
        return (
          <Line
            {...noEvents}
            x={shape.x} y={shape.y}
            points={shape.points}
            stroke={shape.strokeColor} strokeWidth={shape.strokeWidth}
            dash={shape.dash}
            closed={'closed' in shape ? (shape as any).closed : false}
            lineCap="round" lineJoin="round"
          />
        );
      }
      if (shape.width && shape.height) {
        return (
          <Rect
            {...noEvents}
            x={shape.x} y={shape.y}
            width={shape.width} height={shape.height}
            stroke={shape.strokeColor} strokeWidth={shape.strokeWidth}
            fill="transparent"
          />
        );
      }
      return null;
  }
}

// ─── Locked Image Shape ───────────────────────────────────────────────────────

function LockedImageShape({ shape, noEvents }: { shape: ShapeData; noEvents: any }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!shape.imageUrl) return;
    const i = new window.Image();
    i.onload = () => setImg(i);
    i.src = shape.imageUrl;
  }, [shape.imageUrl]);

  if (!img) return null;
  const scaleX = shape.width ? shape.width / img.naturalWidth : 1;
  const scaleY = shape.height ? shape.height / img.naturalHeight : 1;
  return (
    <Rect
      {...noEvents}
      x={shape.x} y={shape.y}
      width={shape.width} height={shape.height}
      fillPatternImage={img}
      fillPatternScaleX={scaleX} fillPatternScaleY={scaleY}
      fillPatternOffset={{ x: 0, y: 0 }}
      fillPatternRepeat="no-repeat"
    />
  );
}

// ─── Locked Content Box Shape ─────────────────────────────────────────────────

function LockedContentBoxShape({ shape, noEvents }: { shape: ShapeData; noEvents: any }) {
  const [assetImg, setAssetImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!shape.assetUrl) return;
    const i = new window.Image();
    i.onload = () => setAssetImg(i);
    i.src = shape.assetUrl;
  }, [shape.assetUrl]);

  const fw = shape.width || 0;
  const fh = shape.height || 0;
  const at = shape.assetTransform || { x: 0, y: 0, width: fw, height: fh };
  const ax = at.x, ay = at.y, aw = at.width, ah = at.height;

  const hasExplicitStroke = shape.strokeColor && shape.strokeColor !== 'transparent';
  const strokeColorVal = hasExplicitStroke ? shape.strokeColor! : 'transparent';
  const strokeWidthVal = hasExplicitStroke ? (shape.strokeWidth ?? 1) : 0;

  return (
    <Group {...noEvents} x={shape.x} y={shape.y} rotation={shape.rotation || 0}>
      <Group clipX={0} clipY={0} clipWidth={fw} clipHeight={fh} {...noEvents}>
        {assetImg ? (
          <Rect
            {...noEvents}
            x={ax} y={ay} width={aw} height={ah}
            fillPatternImage={assetImg}
            fillPatternScaleX={aw / assetImg.naturalWidth}
            fillPatternScaleY={ah / assetImg.naturalHeight}
            fillPatternOffset={{ x: 0, y: 0 }}
            fillPatternRepeat="no-repeat"
          />
        ) : (
          <>
            <Line points={[0, 0, fw, fh]} stroke="rgba(77,166,255,0.35)" strokeWidth={1} {...noEvents} />
            <Line points={[fw, 0, 0, fh]} stroke="rgba(77,166,255,0.35)" strokeWidth={1} {...noEvents} />
          </>
        )}
      </Group>
      {hasExplicitStroke && (
        <Rect
          {...noEvents}
          x={0} y={0} width={fw} height={fh}
          fill="transparent"
          stroke={strokeColorVal}
          strokeWidth={strokeWidthVal}
        />
      )}
    </Group>
  );
}

// ─── MasterUnderlayLayer ─────────────────────────────────────────────────────
// The main export: a Konva Layer rendered BELOW the editable markup layer.
// Everything in this layer is pointer-dead (listening={false}).

interface MasterUnderlayLayerProps {
  tabId: string;
  pageNum: number;
  scale: number;
  totalPages: number;
  documentPageWidth?: number;
  documentPageHeight?: number;
}

export function MasterUnderlayLayer({
  tabId, pageNum, scale, totalPages, documentPageWidth = 612, documentPageHeight = 792,
}: MasterUnderlayLayerProps) {
  const { documents, masterPages: globalMasterPages, tabMetas } = useStore();
  const doc = documents[tabId];
  const masterPages = doc?.masterPages || globalMasterPages || [];
  const assignments = doc?.masterPageAssignments || {};
  const docTitle = tabMetas[tabId]?.label || 'Untitled';

  const isSpread = doc?.isSpread || false;
  const hasCoverPage = doc?.hasFrontCover || false;
  const activeSpreadIndex = doc?.activeSpreadIndex || 0;
  const numPages = doc?.numPages || 0;

  const hasBackCover = doc?.hasBackCover || false;
  const activeSpreads = getSpreads(numPages, hasCoverPage, hasBackCover);
  const currentSpread = activeSpreads[activeSpreadIndex] || null;
  const spreadLeftPage = isSpread && currentSpread ? currentSpread.pages[0] : pageNum;
  const spreadRightPage = isSpread && currentSpread && currentSpread.pages.length > 1 ? currentSpread.pages[1] : -1;
  const spreadHasRight = isSpread && spreadRightPage > 0 && spreadRightPage <= numPages;

  const shapesToRender: { shape: ShapeData; targetPageNum: number }[] = [];

  // Left Page of spread (or current page in single mode)
  const leftMasterId = assignments[spreadLeftPage] ?? null;
  const leftMaster = leftMasterId ? masterPages.find(m => m.id === leftMasterId) : null;
  if (leftMaster) {
    const offsetX = (documentPageWidth - leftMaster.pageWidth) / 2;
    const offsetY = (documentPageHeight - leftMaster.pageHeight) / 2;

    leftMaster.shapes.forEach(shape => {
      if (leftMaster.isSpread) {
        if (shape.x < leftMaster.pageWidth) {
          const shifted = {
            ...shape,
            x: shape.x + offsetX,
            y: shape.y + offsetY,
            points: shape.points ? (
              isLineMark(shape.type)
                ? shape.points
                : shape.points.map((pt, idx) => idx % 2 === 0 ? pt + offsetX : pt + offsetY)
            ) : undefined
          };
          shapesToRender.push({ shape: shifted, targetPageNum: spreadLeftPage });
        }
      } else {
        const shifted = {
          ...shape,
          x: shape.x + offsetX,
          y: shape.y + offsetY,
          points: shape.points ? (
            isLineMark(shape.type)
              ? shape.points
              : shape.points.map((pt, idx) => idx % 2 === 0 ? pt + offsetX : pt + offsetY)
          ) : undefined
        };
        shapesToRender.push({ shape: shifted, targetPageNum: spreadLeftPage });
      }
    });
  }

  // Right Page of spread (if active)
  if (isSpread && spreadHasRight) {
    const rightMasterId = assignments[spreadRightPage] ?? null;
    const rightMaster = rightMasterId ? masterPages.find(m => m.id === rightMasterId) : null;
    if (rightMaster) {
      const offsetX = (documentPageWidth - rightMaster.pageWidth) / 2;
      const offsetY = (documentPageHeight - rightMaster.pageHeight) / 2;
      const docRightPageOffset = documentPageWidth; // Adjacent pages, no gap

      rightMaster.shapes.forEach(shape => {
        if (rightMaster.isSpread) {
          if (shape.x >= rightMaster.pageWidth) {
            // Shift left by master.pageWidth, then shift right by docRightPageOffset, then center align
            const netShift = docRightPageOffset - rightMaster.pageWidth + offsetX;
            const shifted = {
              ...shape,
              x: shape.x + netShift,
              y: shape.y + offsetY,
              points: shape.points ? (
                isLineMark(shape.type)
                  ? shape.points
                  : shape.points.map((pt, idx) => idx % 2 === 0 ? pt + netShift : pt + offsetY)
              ) : undefined
            };
            shapesToRender.push({ shape: shifted, targetPageNum: spreadRightPage });
          }
        } else {
          // Single master template assigned to right side: shift right + center align
          const netShift = docRightPageOffset + offsetX;
          const shifted = {
            ...shape,
            x: shape.x + netShift,
            y: shape.y + offsetY,
            points: shape.points ? (
              isLineMark(shape.type)
                ? shape.points
                : shape.points.map((pt, idx) => idx % 2 === 0 ? pt + netShift : pt + offsetY)
            ) : undefined
          };
          shapesToRender.push({ shape: shifted, targetPageNum: spreadRightPage });
        }
      });
    }
  }

  if (shapesToRender.length === 0) return null;

  return (
    <Layer
      scaleX={scale}
      scaleY={scale}
      listening={false}  // ← entire layer is pointer-dead: the glass shield
    >
      {shapesToRender.map(({ shape, targetPageNum }) => (
        <LockedShape
          key={shape.id}
          shape={shape}
          pageNum={targetPageNum}
          totalPages={totalPages}
          docTitle={docTitle}
          tabId={tabId}
          scale={scale}
        />
      ))}
    </Layer>
  );
}
