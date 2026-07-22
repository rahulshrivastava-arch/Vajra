import { useStore, type ShapeData } from '../store/useStore';
import { PatternEngine } from './PatternEngine';
import { wrapTextCanvas } from './textLayout';

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function hex(color: string): string {
  if (!color || color === 'transparent') return 'rgba(0,0,0,0)';
  return color;
}

function drawArrowHeadCanvas(
  ctx: CanvasRenderingContext2D,
  pts: number[],
  shape: ShapeData,
  scale: number
) {
  const type = shape.arrowHeadType ?? 'arrow';
  if (shape.showArrowHead === false || type === 'none' || pts.length < 4) return;

  const n = pts.length;
  const x2 = pts[n - 2], y2 = pts[n - 1];
  const x1 = n >= 4 ? pts[n - 4] : pts[0];
  const y1 = n >= 4 ? pts[n - 3] : pts[1];

  let angle = Math.atan2(y2 - y1, x2 - x1);

  if (shape.type === 'spline' && pts.length >= 6) {
    const tension = 0.5;
    const length = pts.length;
    const getCP = (x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, t: number) => {
      const d01 = Math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2);
      const d12 = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
      const sum = d01 + d12;
      const fa  = sum < 1e-10 ? 0 : (t * d01) / sum;
      const fb  = sum < 1e-10 ? 0 : (t * d12) / sum;
      return [
        x1 - fa * (x2 - x0), y1 - fa * (y2 - y0),
        x1 + fb * (x2 - x0), y1 + fb * (y2 - y0),
      ];
    };
    const cp = getCP(pts[length - 6], pts[length - 5], pts[length - 4], pts[length - 3], pts[length - 2], pts[length - 1], tension);
    
    // The final curve segment is a quadratic curve starting from the second-to-last point 
    // and using the right-side control point of that node.
    const P0x = pts[length - 4], P0y = pts[length - 3];
    const P1x = cp[2], P1y = cp[3];
    const P2x = x2, P2y = y2;
    
    // Sample a point slightly before the end (t=0.85) to create a stable secant vector
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

  const size = (shape.arrowHeadSize ?? 15);
  const halfAngle = (shape.arrowHeadAngle ?? 30) * Math.PI / 180;
  const filled = shape.arrowHeadFilled ?? true;

  const r1x = x2 - size * Math.cos(angle - halfAngle);
  const r1y = y2 - size * Math.sin(angle - halfAngle);
  const r2x = x2 - size * Math.cos(angle + halfAngle);
  const r2y = y2 - size * Math.sin(angle + halfAngle);

  ctx.save();
  ctx.strokeStyle = hex(shape.strokeColor || '#000');
  ctx.fillStyle   = hex(shape.strokeColor || '#000');
  ctx.lineWidth   = (shape.strokeWidth || 1) * scale;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';

  ctx.beginPath();
  ctx.moveTo(r1x * scale, r1y * scale);
  ctx.lineTo(x2 * scale, y2 * scale);
  ctx.lineTo(r2x * scale, r2y * scale);

  if (type !== 'greater_than') {
    ctx.closePath();
    if (filled) ctx.fill();
  }
  ctx.stroke();
  ctx.restore();
}

function drawCloudCanvas(
  ctx: CanvasRenderingContext2D,
  shape: ShapeData,
  scale: number
) {
  let cloudPts = shape.points || [];
  if (cloudPts.length < 6 && shape.width && shape.height) {
    cloudPts = [
      shape.x, shape.y,
      shape.x + shape.width, shape.y,
      shape.x + shape.width, shape.y + shape.height,
      shape.x, shape.y + shape.height,
    ];
  }

  // Remove duplicate closing vertex
  let verts = cloudPts;
  const nv = verts.length / 2;
  if (nv > 1 && verts[0] === verts[(nv - 1) * 2] && verts[1] === verts[(nv - 1) * 2 + 1]) {
    verts = verts.slice(0, -2);
  }
  const numVerts = verts.length / 2;
  if (numVerts < 2) return;

  const bumpSize = Math.max(shape.radius || 20, 5);
  const s = scale;

  ctx.save();
  ctx.strokeStyle = hex(shape.strokeColor || '#000');
  ctx.lineWidth   = (shape.strokeWidth || 2) * scale;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  const fillC = shape.fillColor;

  ctx.beginPath();
  let firstPt = true;

  for (let ei = 0; ei < numVerts; ei++) {
    const nextEi = (ei + 1) % numVerts;
    const ex1 = verts[ei * 2],     ey1 = verts[ei * 2 + 1];
    const ex2 = verts[nextEi * 2], ey2 = verts[nextEi * 2 + 1];
    const edgeLen = Math.sqrt((ex2 - ex1) ** 2 + (ey2 - ey1) ** 2);
    if (edgeLen < 1) continue;

    const nx = -(ey2 - ey1) / edgeLen;
    const ny =  (ex2 - ex1) / edgeLen;
    const arcCount = Math.max(1, Math.round(edgeLen / (bumpSize * 1.5)));
    const stepX = (ex2 - ex1) / arcCount;
    const stepY = (ey2 - ey1) / arcCount;

    for (let j = 0; j < arcCount; j++) {
      const pAx = ex1 + stepX * j,       pAy = ey1 + stepY * j;
      const pBx = ex1 + stepX * (j + 1), pBy = ey1 + stepY * (j + 1);
      const cpx = (pAx + pBx) / 2 + nx * bumpSize;
      const cpy = (pAy + pBy) / 2 + ny * bumpSize;
      if (firstPt) { ctx.moveTo(pAx * s, pAy * s); firstPt = false; }
      ctx.quadraticCurveTo(cpx * s, cpy * s, pBx * s, pBy * s);
    }
  }

  ctx.closePath();

  // Fill: pattern tile or solid color
  const patId = (shape as any).fillPatternId;
  if (patId) {
    const pScale = (shape as any).fillPatternScale || 1.0;
    const tileRes = PatternEngine.createPatternTile(
      patId, pScale, hex((shape.fillColor && shape.fillColor !== 'transparent') ? shape.fillColor : (shape.strokeColor || '#000')), (shape as any).fillPatternStrokeWidth || shape.strokeWidth || 1, s
    );
    if (tileRes) {
      const pattern = ctx.createPattern(tileRes.canvas, 'repeat');
      if (pattern) {
        pattern.setTransform(new DOMMatrix().scale(tileRes.fillScale.x * s, tileRes.fillScale.y * s));
        ctx.fillStyle = pattern;
        ctx.fill();
      }
    }
  } else if (fillC && fillC !== 'transparent') {
    ctx.fillStyle = fillC;
    ctx.fill();
  }
  ctx.stroke();
  ctx.restore();
}

// ─── Text Drawing Helper ──────────────────────────────────────────────────────

function drawTextOnCanvas(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number, // unscaled x
  y: number, // unscaled y
  width: number, // unscaled width
  fontSize: number,
  fontFamily: string,
  strokeColor: string,
  align: 'left' | 'right',
  verticalAlign: 'top' | 'middle',
  isItalic: boolean,
  isBold: boolean,
  isUnderline: boolean,
  isStrike: boolean,
  padding: number,
  s: number, // scale
  boxHeight?: number // unscaled box height
) {
  const innerWidth = Math.max(0, width - padding * 2);
  const lineHeight = fontSize * 1.2;

  ctx.save();
  ctx.translate(x * s, y * s);

  const fontStyle = `${isItalic ? 'italic ' : ''}${isBold ? 'bold ' : ''}`.trim();
  const fontStr = `${fontStyle ? fontStyle + ' ' : ''}${fontSize * s}px ${fontFamily}, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  ctx.font = fontStr;
  ctx.fillStyle = hex(strokeColor || '#000');
  ctx.textBaseline = 'top';
  ctx.textAlign = align;

  // wrapTextCanvas needs the unscaled font set on the context for measuring against unscaled innerWidth
  ctx.font = `${fontStyle ? fontStyle + ' ' : ''}${fontSize}px ${fontFamily}, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  const lines = wrapTextCanvas(text || '', innerWidth, fontSize, fontFamily, ctx);
  ctx.font = fontStr; // restore scaled font

  const totalTextHeight = lines.length * lineHeight;
  let startY = padding;
  if (verticalAlign === 'middle' && boxHeight !== undefined) {
    startY = padding + Math.max(0, (boxHeight - padding * 2 - totalTextHeight) / 2);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineX = align === 'right' ? (width - padding) * s : padding * s;
    const lineY = (startY + i * lineHeight) * s;
    ctx.fillText(line, lineX, lineY);

    if (isUnderline || isStrike) {
      const lineW = ctx.measureText(line).width;
      const startX = align === 'right' ? ((width - padding) * s - lineW) : padding * s;
      
      ctx.save();
      ctx.strokeStyle = hex(strokeColor || '#000');
      ctx.lineWidth = Math.max(1, (fontSize / 16) * s);
      ctx.beginPath();
      if (isUnderline) {
        const underlineY = lineY + fontSize * s * 0.95;
        ctx.moveTo(startX, underlineY);
        ctx.lineTo(startX + lineW, underlineY);
      }
      if (isStrike) {
        const strikeY = lineY + fontSize * s * 0.5;
        ctx.moveTo(startX, strikeY);
        ctx.lineTo(startX + lineW, strikeY);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  ctx.restore();
}

// ─── Main renderer ────────────────────────────────────────────────────────────

export async function renderShapesOnCanvas(
  ctx: CanvasRenderingContext2D,
  shapes: ShapeData[],
  scale: number,
  skipVectorText = false
): Promise<void> {
  const s = scale;

  // Pre-load images async
  const imageMap = new Map<string, HTMLImageElement>();
  await Promise.all([
    ...shapes
      .filter(sh => sh.type === 'image' && (sh as any).imageUrl)
      .map(sh => new Promise<void>(resolve => {
        const img = new Image();
        img.onload  = () => { imageMap.set(sh.id, img); resolve(); };
        img.onerror = () => resolve();
        img.src = (sh as any).imageUrl;
      })),
    ...shapes
      .filter(sh => sh.type === 'content_box' && (sh as any).assetUrl)
      .map(sh => new Promise<void>(resolve => {
        const img = new Image();
        img.onload  = () => { imageMap.set(sh.id, img); resolve(); };
        img.onerror = () => resolve();
        img.src = (sh as any).assetUrl;
      }))
  ]);

  for (const shape of shapes) {
    ctx.save();
    try {
      switch (shape.type) {

        // ── Line ─────────────────────────────────────────────────────────────
        case 'line': {
          const pts = shape.points;
          if (!pts || pts.length < 4) break;
          ctx.strokeStyle = hex(shape.strokeColor || '#000');
          ctx.lineWidth   = (shape.strokeWidth || 1) * s;
          ctx.lineCap     = 'round';
          ctx.beginPath();
          ctx.moveTo(pts[0] * s, pts[1] * s);
          ctx.lineTo(pts[2] * s, pts[3] * s);
          ctx.stroke();
          break;
        }

        // ── Arrow ─────────────────────────────────────────────────────────────
        case 'arrow': {
          const pts = shape.points;
          if (!pts || pts.length < 4) break;
          ctx.strokeStyle = hex(shape.strokeColor || '#000');
          ctx.lineWidth   = (shape.strokeWidth || 1) * s;
          ctx.lineCap     = 'round';
          ctx.beginPath();
          ctx.moveTo(pts[0] * s, pts[1] * s);
          ctx.lineTo(pts[2] * s, pts[3] * s);
          ctx.stroke();
          drawArrowHeadCanvas(ctx, pts, shape, s);

          if (!skipVectorText && shape.text) {
            const x = pts[0];
            const y = pts[1];
            const isRight = pts[2] >= pts[0];
            const tW = shape.width || 150;
            const tH = shape.height || 40;
            const tx = isRight ? x - tW - 10 : x + 10;
            const ty = y - tH / 2;

            drawTextOnCanvas(
              ctx,
              shape.text,
              tx,
              ty,
              tW,
              shape.fontSize || 16,
              (shape as any).fontFamily || 'Inter',
              shape.strokeColor || '#000',
              isRight ? 'right' : 'left',
              'top',
              shape.isItalic || false,
              shape.isBold || false,
              shape.isUnderline || false,
              shape.isStrike || false,
              0,
              s
            );
          }
          break;
        }

        // ── Measure Length ───────────────────────────────────────────────────
        case 'measure_length': {
          const pts = shape.points;
          if (!pts || pts.length < 4) break;
          ctx.strokeStyle = hex(shape.strokeColor || '#000');
          ctx.lineWidth   = (shape.strokeWidth || 1) * s;
          ctx.lineCap     = 'round';
          ctx.beginPath();
          ctx.moveTo(pts[0] * s, pts[1] * s);
          ctx.lineTo(pts[2] * s, pts[3] * s);
          ctx.stroke();

          // Draw ticks (diagonal) and perpendicular witness lines
          const dx = pts[2] - pts[0];
          const dy = pts[3] - pts[1];
          const angle = Math.atan2(dy, dx);
          const tickLen = 8;
          const perpLen = 14;
          const tickAngle = angle + Math.PI / 4;
          const perpAngle = angle + Math.PI / 2;
          
          const drawMarkersCanvas = (x: number, y: number) => {
            // Perpendicular witness line
            ctx.beginPath();
            ctx.moveTo((x - (perpLen / 2) * Math.cos(perpAngle)) * s, (y - (perpLen / 2) * Math.sin(perpAngle)) * s);
            ctx.lineTo((x + (perpLen / 2) * Math.cos(perpAngle)) * s, (y + (perpLen / 2) * Math.sin(perpAngle)) * s);
            ctx.stroke();

            // Diagonal tick
            ctx.beginPath();
            ctx.moveTo((x - (tickLen / 2) * Math.cos(tickAngle)) * s, (y - (tickLen / 2) * Math.sin(tickAngle)) * s);
            ctx.lineTo((x + (tickLen / 2) * Math.cos(tickAngle)) * s, (y + (tickLen / 2) * Math.sin(tickAngle)) * s);
            ctx.stroke();
          };
          drawMarkersCanvas(pts[0], pts[1]);
          drawMarkersCanvas(pts[2], pts[3]);

          // Draw text label
          let lenStr = '';
          const rawPx = Math.sqrt(dx * dx + dy * dy);
          if (shape.measurementSystem && shape.measurementScale) {
            const paperInches = rawPx / 72.0;
            if (shape.measurementSystem === 'imperial') {
              lenStr = formatImperial(paperInches * shape.measurementScale);
            } else {
              lenStr = `${(rawPx * (25.4 / 72.0) * shape.measurementScale).toFixed(2)} mm`;
            }
          } else {
            const calibration = useStore.getState().scaleCalibration || 1.0;
            lenStr = `${(rawPx * calibration).toFixed(2)}`;
          }

          if (lenStr) {
            ctx.save();
            const fontSize = 16 * s;
            ctx.font = `bold ${fontSize}px Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
            ctx.fillStyle = hex(shape.strokeColor || '#000');
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            
            // Draw slightly above the midpoint
            const midX = (pts[0] + dx / 2) * s;
            const midY = (pts[1] + dy / 2 - 10) * s; // move up slightly in screen space
            
            ctx.fillText(lenStr, midX, midY);
            ctx.restore();
          }
          break;
        }

        // ── Rect ──────────────────────────────────────────────────────────────
        case 'rect': {
          const w = shape.width || 0, h = shape.height || 0;
          const R = shape.rotation || 0;
          const fillC = (shape as any).fillPatternId ? 'transparent' : (shape.fillColor || 'transparent');
          ctx.save();
          ctx.translate(shape.x * s, shape.y * s);
          if (R !== 0) {
            ctx.rotate(R * Math.PI / 180);
          }
          ctx.lineWidth = (shape.strokeWidth || 1) * s;
          if (fillC && fillC !== 'transparent') {
            ctx.fillStyle = fillC;
            ctx.fillRect(0, 0, w * s, h * s);
          }
          if ((shape as any).fillPatternId) {
            const pScale = (shape as any).fillPatternScale || 1.0;
            const tileRes = PatternEngine.createPatternTile(
              (shape as any).fillPatternId, pScale, hex((shape.fillColor && shape.fillColor !== 'transparent') ? shape.fillColor : (shape.strokeColor || '#000')), (shape as any).fillPatternStrokeWidth || shape.strokeWidth || 1, s
            );
            if (tileRes) {
              const pattern = ctx.createPattern(tileRes.canvas, 'repeat');
              if (pattern) {
                pattern.setTransform(new DOMMatrix().scale(tileRes.fillScale.x * s, tileRes.fillScale.y * s));
                ctx.fillStyle = pattern;
                ctx.fillRect(0, 0, w * s, h * s);
              }
            }
          }
          ctx.strokeStyle = hex(shape.strokeColor || '#000');
          ctx.strokeRect(0, 0, w * s, h * s);
          ctx.restore();
          break;
        }

        case 'table': {
          const table = shape.tableData;
          if (!table) break;

          let cumulativeY = 0;
          const rowPositions = [0];
          for (let i = 0; i < table.rows; i++) {
            cumulativeY += table.rowHeights[i] || 30;
            rowPositions.push(cumulativeY);
          }

          let cumulativeX = 0;
          const colPositions = [0];
          for (let i = 0; i < table.cols; i++) {
            cumulativeX += table.colWidths[i] || 100;
            colPositions.push(cumulativeX);
          }

          const tableWidth = cumulativeX;
          const tableHeight = cumulativeY;

          const visualScaleX = (shape.width !== undefined && Math.abs(shape.width - tableWidth) > 1) ? Math.max(0.01, shape.width) / tableWidth : 1;
          const visualScaleY = (shape.height !== undefined && Math.abs(shape.height - tableHeight) > 1) ? Math.max(0.01, shape.height) / tableHeight : 1;

          ctx.save();
          ctx.translate(shape.x * s, shape.y * s);
          
          const R = shape.rotation || 0;
          if (R !== 0) {
            ctx.rotate(R * Math.PI / 180);
          }
          
          ctx.scale(visualScaleX, visualScaleY);

          // 1. Draw cell fills
          for (let r = 0; r < table.rows; r++) {
            for (let c = 0; c < table.cols; c++) {
              const cellId = `${r}_${c}`;
              const cell = table.cells[cellId];
              if (cell?.isMerged) continue;

              const colSpan = cell?.colSpan || 1;
              const rowSpan = cell?.rowSpan || 1;

              const cx = colPositions[c];
              const cy = rowPositions[r];
              let cw = 0;
              let ch = 0;
              for (let i = 0; i < colSpan; i++) cw += table.colWidths[c + i] || 100;
              for (let i = 0; i < rowSpan; i++) ch += table.rowHeights[r + i] || 30;

              const cellFill = cell?.fillColor || shape.fillColor || 'transparent';
              if (cellFill !== 'transparent') {
                ctx.fillStyle = hex(cellFill);
                ctx.fillRect(cx * s, cy * s, cw * s, ch * s);
              }
            }
          }

          // 2. Draw cell text
          for (let r = 0; r < table.rows; r++) {
            for (let c = 0; c < table.cols; c++) {
              const cellId = `${r}_${c}`;
              const cell = table.cells[cellId];
              if (cell?.isMerged) continue;

              const colSpan = cell?.colSpan || 1;
              const rowSpan = cell?.rowSpan || 1;

              const cx = colPositions[c];
              const cy = rowPositions[r];
              let cw = 0;
              let ch = 0;
              for (let i = 0; i < colSpan; i++) cw += table.colWidths[c + i] || 100;
              for (let i = 0; i < rowSpan; i++) ch += table.rowHeights[r + i] || 30;

              const text = cell?.text || '';
              if (text) {
                const cellFontFamily = cell?.fontFamily || shape.fontFamily || 'Inter';
                const cellFontSize = cell?.fontSize || shape.fontSize || 12;
                const cellStrokeColor = cell?.strokeColor || shape.strokeColor || '#000';
                const cellIsBold = cell?.isBold !== undefined ? cell.isBold : (shape.isBold || false);
                const cellIsItalic = cell?.isItalic !== undefined ? cell.isItalic : (shape.isItalic || false);
                const cellIsUnderline = cell?.isUnderline !== undefined ? cell.isUnderline : (shape.isUnderline || false);
                const cellIsStrike = cell?.isStrike !== undefined ? cell.isStrike : (shape.isStrike || false);

                ctx.save();
                ctx.fillStyle = hex(cellStrokeColor);
                
                const fontStyle = `${cellIsItalic ? 'italic ' : ''}${cellIsBold ? 'bold ' : ''}`.trim();
                ctx.font = `${fontStyle ? fontStyle + ' ' : ''}${cellFontSize * s}px ${cellFontFamily}, system-ui, sans-serif`;
                
                const hAlign = cell?.hAlign || 'left';
                const vAlign = cell?.vAlign || 'middle';
                
                const wrapText = cell?.wrapText;
                const textX = (cx + 2) * s;
                const textY = (cy + 2) * s;
                const maxTextW = (cw - 4) * s;
                const maxTextH = (ch - 4) * s;

                const words = text.split(/\s+/);
                const lines: string[] = [];
                let currentLine = '';

                if (wrapText) {
                  for (let i = 0; i < words.length; i++) {
                    const word = words[i];
                    const testLine = currentLine ? currentLine + ' ' + word : word;
                    const metrics = ctx.measureText(testLine);
                    if (metrics.width > maxTextW && currentLine) {
                      lines.push(currentLine);
                      currentLine = word;
                    } else {
                      currentLine = testLine;
                    }
                  }
                  if (currentLine) {
                    lines.push(currentLine);
                  }
                } else {
                  lines.push(text);
                }

                const lineHeight = cellFontSize * 1.2 * s;
                const totalTextHeight = lines.length * lineHeight;
                let startY = textY;
                if (vAlign === 'middle') {
                  startY = textY + (maxTextH - totalTextHeight) / 2 + lineHeight / 2;
                } else if (vAlign === 'bottom') {
                  startY = textY + maxTextH - totalTextHeight + lineHeight / 2;
                } else { // top
                  startY = textY + lineHeight / 2;
                }

                lines.forEach((lineText, lineIdx) => {
                  let lText = lineText;
                  if (!wrapText) {
                    const metrics = ctx.measureText(lineText);
                    if (metrics.width > maxTextW) {
                      let truncated = lineText;
                      while (truncated.length > 0 && ctx.measureText(truncated + '...').width > maxTextW) {
                        truncated = truncated.slice(0, -1);
                      }
                      lText = truncated + '...';
                    }
                  }

                  let drawX = textX;
                  if (hAlign === 'center') {
                    drawX = textX + maxTextW / 2;
                    ctx.textAlign = 'center';
                  } else if (hAlign === 'right') {
                    drawX = textX + maxTextW;
                    ctx.textAlign = 'right';
                  } else {
                    ctx.textAlign = 'left';
                  }
                  
                  ctx.textBaseline = 'middle';
                  ctx.fillText(lText, drawX, startY + lineIdx * lineHeight);

                  if (cellIsUnderline || cellIsStrike) {
                    const metrics = ctx.measureText(lText);
                    let lineStartX = drawX;
                    if (hAlign === 'center') {
                      lineStartX = drawX - metrics.width / 2;
                    } else if (hAlign === 'right') {
                      lineStartX = drawX - metrics.width;
                    }
                    const lineEndX = lineStartX + metrics.width;

                    ctx.lineWidth = Math.max(1, cellFontSize * 0.08 * s);
                    ctx.strokeStyle = hex(cellStrokeColor);
                    ctx.beginPath();
                    if (cellIsUnderline) {
                      const underY = startY + lineIdx * lineHeight + cellFontSize * 0.45 * s;
                      ctx.moveTo(lineStartX, underY);
                      ctx.lineTo(lineEndX, underY);
                    }
                    if (cellIsStrike) {
                      const strikeY = startY + lineIdx * lineHeight;
                      ctx.moveTo(lineStartX, strikeY);
                      ctx.lineTo(lineEndX, strikeY);
                    }
                    ctx.stroke();
                  }
                });

                ctx.restore();
              }
            }
          }

          // 3. Draw grid lines
          ctx.strokeStyle = hex(shape.strokeColor || '#000');
          // Vertical lines
          for (let i = 0; i <= table.cols; i++) {
            const x = colPositions[i];
            const thickness = table.colLineThicknesses?.[i] ?? table.borderThickness ?? shape.strokeWidth ?? 1;
            ctx.lineWidth = thickness * s;
            ctx.beginPath();
            ctx.moveTo(x * s, 0);
            ctx.lineTo(x * s, tableHeight * s);
            ctx.stroke();
          }

          // Horizontal lines
          for (let i = 0; i <= table.rows; i++) {
            const y = rowPositions[i];
            const thickness = table.rowLineThicknesses?.[i] ?? table.borderThickness ?? shape.strokeWidth ?? 1;
            ctx.lineWidth = thickness * s;
            ctx.beginPath();
            ctx.moveTo(0, y * s);
            ctx.lineTo(tableWidth * s, y * s);
            ctx.stroke();
          }

          ctx.restore();
          break;
        }

        // ── Circle ────────────────────────────────────────────────────────────
        case 'circle': {
          const xRad = shape.width !== undefined ? shape.width / 2 : (shape.radius || 0);
          const yRad = shape.height !== undefined ? shape.height / 2 : (shape.radius || 0);
          const cx   = shape.x;
          const cy   = shape.y;
          ctx.beginPath();
          ctx.ellipse(cx * s, cy * s, xRad * s, yRad * s, (shape.rotation || 0) * Math.PI / 180, 0, Math.PI * 2);
          const fillC = (shape as any).fillPatternId ? 'transparent' : (shape.fillColor || 'transparent');
          if (fillC && fillC !== 'transparent') { ctx.fillStyle = fillC; ctx.fill(); }

          if ((shape as any).fillPatternId) {
            const pScale = (shape as any).fillPatternScale || 1.0;
            const tileRes = PatternEngine.createPatternTile(
              (shape as any).fillPatternId, pScale, hex((shape.fillColor && shape.fillColor !== 'transparent') ? shape.fillColor : (shape.strokeColor || '#000')), (shape as any).fillPatternStrokeWidth || shape.strokeWidth || 1, s
            );
            if (tileRes) {
              const pattern = ctx.createPattern(tileRes.canvas, 'repeat');
              if (pattern) {
                pattern.setTransform(new DOMMatrix().scale(tileRes.fillScale.x * s, tileRes.fillScale.y * s));
                ctx.fillStyle = pattern;
                ctx.fill();
              }
            }
          }

          ctx.strokeStyle = hex(shape.strokeColor || '#000');
          ctx.lineWidth   = (shape.strokeWidth || 1) * s;
          ctx.stroke();
          break;
        }

        // ── Freehand / Brush / Polyline / Polygon / Area ──────────────────────
        case 'freehand':
        case 'brush':
        case 'polyline':
        case 'polygon':
        case 'measure_area': {
          const pts = shape.points;
          if (!pts || pts.length < 4) break;
          ctx.strokeStyle = hex(shape.strokeColor || '#000');
          ctx.lineWidth   = (shape.strokeWidth || 1) * s;
          ctx.lineCap     = 'round';
          ctx.lineJoin    = 'round';
          ctx.beginPath();
          ctx.moveTo(pts[0] * s, pts[1] * s);
          for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i] * s, pts[i + 1] * s);
          const shouldClose = ['polygon', 'measure_area'].includes(shape.type) || shape.closed;
          if (shouldClose) {
            ctx.closePath();
            const fillC = (shape as any).fillPatternId ? 'transparent' : (shape.fillColor || 'transparent');
            if (fillC && fillC !== 'transparent') { ctx.fillStyle = fillC; ctx.fill(); }

            if ((shape as any).fillPatternId) {
              const pScale = (shape as any).fillPatternScale || 1.0;
              const tileRes = PatternEngine.createPatternTile(
                (shape as any).fillPatternId, pScale, hex((shape.fillColor && shape.fillColor !== 'transparent') ? shape.fillColor : (shape.strokeColor || '#000')), (shape as any).fillPatternStrokeWidth || shape.strokeWidth || 1, s
              );
              if (tileRes) {
                const pattern = ctx.createPattern(tileRes.canvas, 'repeat');
                if (pattern) {
                  pattern.setTransform(new DOMMatrix().scale(tileRes.fillScale.x * s, tileRes.fillScale.y * s));
                  ctx.fillStyle = pattern;
                  // The context has no global scale, and the tile is already sized by `s` and `pScale`.
                  // Since we didn't translate, the pattern origin is exactly at global 0,0.
                  ctx.fill();
                }
              }
            }
          }
          ctx.stroke();

          // Draw area label for measure_area
          if (shape.type === 'measure_area' && pts.length >= 6) {
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
            const centroidX = sumX / n;
            const centroidY = sumY / n;

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

            if (areaStr) {
              ctx.save();
              const fontSize = 14 * s;
              ctx.font = `bold ${fontSize}px Inter, system-ui, sans-serif`;
              ctx.fillStyle = hex(shape.strokeColor || '#4da6ff');
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(areaStr, centroidX * s, centroidY * s);
              ctx.restore();
            }
          }
          break;
        }


        // ── Spline — exact port of Konva's _getControlPoints + _expandPoints ──
        case 'spline': {
          const pts = shape.points;
          if (!pts || pts.length < 4) break;
          ctx.strokeStyle = hex(shape.strokeColor || '#000');
          ctx.lineWidth   = (shape.strokeWidth || 1) * s;
          ctx.lineCap     = 'round';
          ctx.lineJoin    = 'round';

          let tension = 0.5;
          const length  = pts.length;

          // Exact port of Konva's _getControlPoints.
          // Uses chord-length-parameterized Catmull-Rom control points:
          //   fa = t*d01/(d01+d12),  fb = t*d12/(d01+d12)
          //   cp1 = knot - fa*(next-prev),  cp2 = knot + fb*(next-prev)
          const getCP = (
            x0: number, y0: number, x1: number, y1: number,
            x2: number, y2: number, t: number,
          ): number[] => {
            const d01 = Math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2);
            const d12 = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
            const sum = d01 + d12;
            const fa  = sum < 1e-10 ? 0 : (t * d01) / sum;
            const fb  = sum < 1e-10 ? 0 : (t * d12) / sum;
            return [
              x1 - fa * (x2 - x0), y1 - fa * (y2 - y0),
              x1 + fb * (x2 - x0), y1 + fb * (y2 - y0),
            ];
          };

          // Exact port of Konva's _expandPoints:
          // Emits [cp1x, cp1y, px, py, cp2x, cp2y] per knot.
          const tp: number[] = [];
          for (let n = 2; n < length - 2; n += 2) {
            const cp = getCP(
              pts[n - 2], pts[n - 1],
              pts[n],     pts[n + 1],
              pts[n + 2], pts[n + 3],
              tension,
            );
            if (isNaN(cp[0])) continue;
            tp.push(cp[0], cp[1], pts[n], pts[n + 1], cp[2], cp[3]);
          }
          const tpLen = tp.length;

          ctx.beginPath();
          ctx.moveTo(pts[0] * s, pts[1] * s);

          if (tension !== 0 && length > 4) {
            let n = 4;
            ctx.quadraticCurveTo(tp[0] * s, tp[1] * s, tp[2] * s, tp[3] * s);

            while (n < tpLen - 2) {
              ctx.bezierCurveTo(
                tp[n++] * s, tp[n++] * s,
                tp[n++] * s, tp[n++] * s,
                tp[n++] * s, tp[n++] * s
              );
            }

            ctx.quadraticCurveTo(
              tp[tpLen - 2] * s, tp[tpLen - 1] * s,
              pts[length - 2] * s, pts[length - 1] * s,
            );
          } else {
            for (let n = 2; n < length; n += 2) {
              ctx.lineTo(pts[n] * s, pts[n + 1] * s);
            }
          }

          if (shape.closed) {
            ctx.closePath();
          }

          ctx.stroke();
          drawArrowHeadCanvas(ctx, pts, shape, s);
          break;
        }

        // ── Highlight ─────────────────────────────────────────────────────────
        case 'highlight': {
          const pts = shape.points;
          if (!pts || pts.length < 4) break;
          ctx.save();
          ctx.globalAlpha               = 0.4;
          ctx.globalCompositeOperation  = 'multiply';
          ctx.strokeStyle               = hex(shape.strokeColor || '#ffff00');
          ctx.lineWidth                 = (shape.strokeWidth || 20) * s;
          ctx.lineCap                   = 'round';
          ctx.lineJoin                  = 'round';
          ctx.beginPath();
          ctx.moveTo(pts[0] * s, pts[1] * s);
          for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i] * s, pts[i + 1] * s);
          ctx.stroke();
          ctx.restore();
          break;
        }

        // ── Architectural Marks ───────────────────────────────────────────────
        case 'mark_section': {
          const pts = shape.points || [0, 0, 200, 0];
          const dx = pts[2], dy = pts[3];
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          const nx = dx / len, ny = dy / len;
          const flip = shape.markerData?.flipArrow === 'true';
          const px = flip ? -ny : ny;
          const py = flip ? nx : -nx;

          const rawFontSize = shape.fontSize || 11;
          const r = Math.max(16, rawFontSize * 1.5);
          const R = r * 1.35;
          const H = r * 1.8;
          const lx = dx - nx * R, ly = dy - ny * R;
          
          ctx.strokeStyle = hex(shape.strokeColor || '#000');
          
          ctx.lineCap = 'square';
          ctx.lineWidth = (shape.strokeWidth || 2) * 4 * s;
          ctx.beginPath();
          ctx.moveTo(shape.x * s, shape.y * s);
          ctx.lineTo((shape.x + px * r * 1.2) * s, (shape.y + py * r * 1.2) * s);
          ctx.stroke();

          ctx.lineCap = 'round';
          ctx.lineWidth = (shape.strokeWidth || 2) * s;
          if (shape.dash && shape.dash.length) ctx.setLineDash(shape.dash.map(d => d * s));
          ctx.beginPath();
          ctx.moveTo(shape.x * s, shape.y * s);
          ctx.lineTo((shape.x + lx) * s, (shape.y + ly) * s);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.beginPath();
          ctx.moveTo((shape.x + dx - nx * R) * s, (shape.y + dy - ny * R) * s);
          ctx.lineTo((shape.x + dx + nx * R) * s, (shape.y + dy + ny * R) * s);
          ctx.lineTo((shape.x + dx + px * H) * s, (shape.y + dy + py * H) * s);
          ctx.closePath();
          ctx.stroke();

          ctx.beginPath();
          ctx.arc((shape.x + dx) * s, (shape.y + dy) * s, r * s, 0, 2 * Math.PI);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.stroke();

          ctx.lineWidth = (shape.strokeWidth || 2) * 0.8 * s;
          ctx.beginPath();
          ctx.moveTo((shape.x + dx - r) * s, (shape.y + dy) * s);
          ctx.lineTo((shape.x + dx + r) * s, (shape.y + dy) * s);
          ctx.stroke();

          const topTxt = shape.markerData?.top ?? '1';
          const botTxt = shape.markerData?.bottom ?? 'A100';
          ctx.fillStyle = hex(shape.strokeColor || '#000');
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          
          ctx.font = `bold ${rawFontSize * s}px Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
          ctx.fillText(topTxt, (shape.x + dx) * s, (shape.y + dy - r/2) * s);
          ctx.font = `${rawFontSize * s}px Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
          ctx.fillText(botTxt, (shape.x + dx) * s, (shape.y + dy + r/2) * s);
          break;
        }

        case 'mark_level': {
          const pts = shape.points || [0, 0, 200, 0];
          const dx = pts[2], dy = pts[3];
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          const nx = dx / len, ny = dy / len;
          
          const rawFontSize = shape.fontSize || 11;
          const r = Math.max(14, rawFontSize * 1.4);
          const lx = dx - nx * r, ly = dy - ny * r;
          
          ctx.strokeStyle = hex(shape.strokeColor || '#000');
          ctx.lineWidth   = (shape.strokeWidth || 2) * s;
          
          ctx.lineCap = 'round';
          if (shape.dash && shape.dash.length) ctx.setLineDash(shape.dash.map(d => d * s));
          ctx.beginPath();
          ctx.moveTo(shape.x * s, shape.y * s);
          ctx.lineTo((shape.x + lx) * s, (shape.y + ly) * s);
          ctx.stroke();
          ctx.setLineDash([]);
          
          ctx.beginPath();
          ctx.arc((shape.x + dx) * s, (shape.y + dy) * s, r * s, 0, 2 * Math.PI);
          ctx.fillStyle = '#ffffff';
          ctx.fill();

          const baseAngle = Math.atan2(ny, nx);
          ctx.fillStyle = hex(shape.strokeColor || '#000');

          ctx.beginPath();
          ctx.moveTo((shape.x + dx) * s, (shape.y + dy) * s);
          ctx.arc((shape.x + dx) * s, (shape.y + dy) * s, r * s, baseAngle + Math.PI, baseAngle + 1.5 * Math.PI);
          ctx.closePath();
          ctx.fill();

          ctx.beginPath();
          ctx.moveTo((shape.x + dx) * s, (shape.y + dy) * s);
          ctx.arc((shape.x + dx) * s, (shape.y + dy) * s, r * s, baseAngle, baseAngle + 0.5 * Math.PI);
          ctx.closePath();
          ctx.fill();

          ctx.beginPath();
          ctx.arc((shape.x + dx) * s, (shape.y + dy) * s, r * s, 0, 2 * Math.PI);
          ctx.moveTo((shape.x + dx - nx * r) * s, (shape.y + dy - ny * r) * s);
          ctx.lineTo((shape.x + dx + nx * r) * s, (shape.y + dy + ny * r) * s);
          const px = -ny, py = nx;
          ctx.moveTo((shape.x + dx - px * r) * s, (shape.y + dy - py * r) * s);
          ctx.lineTo((shape.x + dx + px * r) * s, (shape.y + dy + py * r) * s);
          ctx.stroke();
          
          const nameTxt = shape.markerData?.name ?? 'Level';
          const elevTxt = shape.markerData?.elevation ?? "100'-0";
          const isRightOfTail = dx >= 0;
          const padding = 8;
          ctx.font = `${rawFontSize * s}px Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
          ctx.textAlign = isRightOfTail ? 'right' : 'left';
          const txtX = isRightOfTail ? lx - padding : lx + padding;
          
          ctx.textBaseline = 'bottom';
          ctx.fillText(nameTxt, (shape.x + txtX) * s, (shape.y + ly - 4) * s);
          ctx.textBaseline = 'top';
          ctx.fillText(elevTxt, (shape.x + txtX) * s, (shape.y + ly + 4) * s);
          break;
        }

        case 'mark_grid': {
          const pts = shape.points || [0, 0, 0, 200];
          const dx = pts[2], dy = pts[3];
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          const nx = dx / len, ny = dy / len;
          
          const rawFontSize = shape.fontSize || 14;
          const r = Math.max(14, rawFontSize * 1.25);
          const lx = dx - nx * r, ly = dy - ny * r;
          
          ctx.strokeStyle = hex(shape.strokeColor || '#000');
          ctx.lineWidth   = (shape.strokeWidth || 2) * s;
          
          ctx.lineCap = 'round';
          const dashArr = shape.dash && shape.dash.length ? shape.dash : [10, 6];
          ctx.setLineDash(dashArr.map(d => d * s));
          ctx.beginPath();
          ctx.moveTo(shape.x * s, shape.y * s);
          ctx.lineTo((shape.x + lx) * s, (shape.y + ly) * s);
          ctx.stroke();
          ctx.setLineDash([]);
          
          ctx.beginPath();
          ctx.arc((shape.x + dx) * s, (shape.y + dy) * s, r * s, 0, 2 * Math.PI);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.stroke();
          
          const label = shape.markerData?.label ?? 'A';
          ctx.fillStyle = hex(shape.strokeColor || '#000');
          ctx.font = `bold ${rawFontSize * s}px Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, (shape.x + dx) * s, (shape.y + dy) * s);
          break;
        }

        case 'mark_elevation': {
          const w = Math.max(shape.width || 80, shape.minWidth || 40);
          const h = Math.max(shape.height || 80, shape.minHeight || 40);
          const hw = w / 2, hh = h / 2;
          const rawFontSize = shape.fontSize || 13;
          const radius = Math.min(hw, hh) / Math.SQRT2;
          
          ctx.strokeStyle = hex(shape.strokeColor || '#000');
          ctx.lineWidth   = (shape.strokeWidth || 2) * s;
          
          ctx.save();
          ctx.translate(shape.x * s, shape.y * s);
          ctx.rotate(((shape.rotation || 0) * Math.PI) / 180);
          
          // Solid Diamond
          ctx.beginPath();
          ctx.moveTo(hw * s, 0);
          ctx.lineTo(w * s, hh * s);
          ctx.lineTo(hw * s, h * s);
          ctx.lineTo(0, hh * s);
          ctx.closePath();
          ctx.fillStyle = hex(shape.strokeColor || '#000');
          ctx.fill();
          ctx.stroke();
          
          // Inscribed white circle
          ctx.beginPath();
          ctx.arc(hw * s, hh * s, radius * s, 0, 2 * Math.PI);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.stroke();
          
          const label = shape.markerData?.label ?? 'A5.10';
          ctx.fillStyle = hex(shape.strokeColor || '#000');
          ctx.font = `bold ${rawFontSize * s}px Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, hw * s, hh * s);
          
          const topTxt = shape.markerData?.top ?? '';
          const botTxt = shape.markerData?.bottom ?? '';
          const leftTxt = shape.markerData?.left ?? '';
          const rightTxt = shape.markerData?.right ?? '';
          ctx.font = `${rawFontSize * 0.85 * s}px Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
          
          if (topTxt) {
            ctx.textBaseline = 'bottom';
            ctx.textAlign = 'center';
            ctx.fillText(topTxt, hw * s, -6 * s);
          }
          if (botTxt) {
            ctx.textBaseline = 'top';
            ctx.textAlign = 'center';
            ctx.fillText(botTxt, hw * s, (h + 6) * s);
          }
          if (leftTxt) {
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText(leftTxt, -6 * s, hh * s);
          }
          if (rightTxt) {
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(rightTxt, (w + 6) * s, hh * s);
          }
          
          ctx.restore();
          break;
        }

        case 'mark_callout': {
          const w = Math.max(shape.width || 160, shape.minWidth || 40);
          const h = Math.max(shape.height || 120, shape.minHeight || 40);
          const rawFontSize = shape.fontSize || 11;
          const bubbleR = Math.max(16, rawFontSize * 1.4);
          const bx = w;
          const by = 0;
          
          ctx.strokeStyle = hex(shape.strokeColor || '#000');
          ctx.lineWidth   = (shape.strokeWidth || 2) * s;
          
          ctx.save();
          ctx.translate(shape.x * s, shape.y * s);
          ctx.rotate(((shape.rotation || 0) * Math.PI) / 180);
          
          const cr = Math.min(12, w * 0.08, h * 0.08) * s;
          const w_s = w * s, h_s = h * s;
          
          ctx.setLineDash([10 * s, 6 * s]);
          ctx.beginPath();
          ctx.moveTo(cr, 0);
          ctx.lineTo(w_s - cr, 0);
          ctx.arcTo(w_s, 0, w_s, cr, cr);
          ctx.lineTo(w_s, h_s - cr);
          ctx.arcTo(w_s, h_s, w_s - cr, h_s, cr);
          ctx.lineTo(cr, h_s);
          ctx.arcTo(0, h_s, 0, h_s - cr, cr);
          ctx.lineTo(0, cr);
          ctx.arcTo(0, 0, cr, 0, cr);
          ctx.closePath();
          ctx.stroke();
          ctx.setLineDash([]);
          
          ctx.lineWidth = (shape.strokeWidth || 2) * 0.8 * s;
          ctx.beginPath();
          ctx.moveTo((w - bubbleR * 0.4) * s, (bubbleR * 0.4) * s);
          ctx.lineTo(bx * s, by * s);
          ctx.stroke();
          
          ctx.lineWidth = (shape.strokeWidth || 2) * s;
          ctx.beginPath();
          ctx.arc(bx * s, by * s, bubbleR * s, 0, 2 * Math.PI);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.stroke();
          
          ctx.lineWidth = (shape.strokeWidth || 2) * 0.8 * s;
          ctx.beginPath();
          ctx.moveTo((bx - bubbleR * 0.8) * s, by * s);
          ctx.lineTo((bx + bubbleR * 0.8) * s, by * s);
          ctx.stroke();
          
          const topTxt = shape.markerData?.top ?? 'A1';
          const botTxt = shape.markerData?.bottom ?? 'A401';
          ctx.fillStyle = hex(shape.strokeColor || '#000');
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.font = `bold ${Math.min(rawFontSize, bubbleR * 0.7) * s}px Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
          ctx.fillText(topTxt, bx * s, (by - bubbleR/2) * s);
          ctx.font = `${Math.min(rawFontSize, bubbleR * 0.65) * s}px Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
          ctx.fillText(botTxt, bx * s, (by + bubbleR/2) * s);
          
          ctx.restore();
          break;
        }

        case 'mark_block': {
          const w = shape.width || 40;
          const h = shape.height || 40;
          ctx.strokeStyle = hex(shape.strokeColor || '#000');
          ctx.lineWidth   = (shape.strokeWidth || 2) * s;
          if (shape.dash && shape.dash.length) ctx.setLineDash(shape.dash.map(d => d * s));
          
          ctx.translate(shape.x * s, shape.y * s);
          if (shape.rotation) ctx.rotate((shape.rotation || 0) * Math.PI / 180);
          
          const fillC = shape.fillColor && shape.fillColor !== 'transparent' ? shape.fillColor : 'transparent';
          if (fillC !== 'transparent') {
            ctx.fillStyle = fillC;
            ctx.fillRect(0, 0, w * s, h * s);
          }
          ctx.strokeRect(0, 0, w * s, h * s);
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(w * s, h * s);
          ctx.moveTo(w * s, 0);
          ctx.lineTo(0, h * s);
          ctx.stroke();
          
          if (shape.rotation) ctx.rotate(-(shape.rotation || 0) * Math.PI / 180);
          ctx.translate(-shape.x * s, -shape.y * s);
          ctx.setLineDash([]);
          break;
        }

        case 'mark_w_section': {
          const w = Math.max(1, shape.width || 40);
          const d = Math.max(1, shape.height || 40);
          const tStr = shape.markerData?.thickness;
          const t = Math.max(1, Math.min(w/2, d/2, tStr ? parseFloat(tStr) : 5));
          
          ctx.strokeStyle = hex(shape.strokeColor || '#000');
          ctx.lineWidth   = (shape.strokeWidth || 2) * s;
          if (shape.dash && shape.dash.length) ctx.setLineDash(shape.dash.map(ds => ds * s));
          
          ctx.translate(shape.x * s, shape.y * s);
          if (shape.rotation) ctx.rotate((shape.rotation || 0) * Math.PI / 180);
          
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(w * s, 0);
          ctx.lineTo(w * s, t * s);
          ctx.lineTo(((w + t) / 2) * s, t * s);
          ctx.lineTo(((w + t) / 2) * s, (d - t) * s);
          ctx.lineTo(w * s, (d - t) * s);
          ctx.lineTo(w * s, d * s);
          ctx.lineTo(0, d * s);
          ctx.lineTo(0, (d - t) * s);
          ctx.lineTo(((w - t) / 2) * s, (d - t) * s);
          ctx.lineTo(((w - t) / 2) * s, t * s);
          ctx.lineTo(0, t * s);
          ctx.closePath();
          
          const fillC = shape.fillColor && shape.fillColor !== 'transparent' ? shape.fillColor : 'transparent';
          if (fillC !== 'transparent') {
            ctx.fillStyle = fillC;
            ctx.fill();
          }
          ctx.stroke();

          if (shape.rotation) ctx.rotate(-(shape.rotation || 0) * Math.PI / 180);
          ctx.translate(-shape.x * s, -shape.y * s);
          ctx.setLineDash([]);
          break;
        }

        case 'mark_insulation': {
          const pts = shape.points || [0, 0, 200, 0];
          const dx = pts[2], dy = pts[3];
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          const nx = dx / len, ny = dy / len;
          const px = -ny, py = nx;
          
          const thickStr = shape.markerData?.thickness;
          const W = Math.max(2, thickStr ? parseFloat(thickStr) : 20);
          const L_step = W * 0.4;
          const n = Math.max(1, Math.round(len / L_step));
          const actual_L_step = len / n;
          const A = W / 2;
          
          ctx.strokeStyle = hex(shape.strokeColor || '#000');
          ctx.lineWidth   = (shape.strokeWidth || 2) * s;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          if (shape.dash && shape.dash.length) ctx.setLineDash(shape.dash.map(ds => ds * s));
          
          ctx.beginPath();
          ctx.moveTo(shape.x * s, shape.y * s);
          
          for (let i = 0; i < n; i++) {
            const sign = i % 2 === 0 ? 1 : -1;
            const d0 = i * actual_L_step;
            const d3 = (i + 1) * actual_L_step;
            
            const C_bulge = 1.25;
            const rot = (d_val: number, h_val: number) => ({
              x: shape.x + d_val * nx + h_val * px,
              y: shape.y + d_val * ny + h_val * py
            });
            
            const p1 = rot(d0 - C_bulge * actual_L_step, sign * A * 1.333);
            const p2 = rot(d3 + C_bulge * actual_L_step, sign * A * 1.333);
            const p3 = rot(d3, 0);
            
            ctx.bezierCurveTo(p1.x * s, p1.y * s, p2.x * s, p2.y * s, p3.x * s, p3.y * s);
          }
          
          ctx.stroke();
          ctx.setLineDash([]);
          break;
        }

        // ── Cloud ─────────────────────────────────────────────────────────────
        case 'cloud': {
          drawCloudCanvas(ctx, shape, s);
          if (skipVectorText) break;
          if (shape.text && shape.points && shape.points.length >= 2) {
            const fontSize = (shape.fontSize || 12) * s;
            ctx.font      = `${fontSize}px Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
            ctx.fillStyle = hex(shape.strokeColor || '#000');
            ctx.textBaseline = 'top';
            const tx = shape.points[0] + 10;
            let ty = shape.points[1] + 10;
            
            const lines = shape.text.split('\n');
            const lineHeight = (shape.fontSize || 12) * 1.0;
            for (const line of lines) {
              ctx.fillText(line, tx * s, ty * s);
              ty += lineHeight;
            }
          }
          break;
        }

        // ── Arc ───────────────────────────────────────────────────────────────
        case 'arc': {
          const pts = shape.points;
          if (!pts || pts.length < 6) break;
          const [x1, y1, x2, y2, x3, y3] = pts;
          const D = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
          
          ctx.strokeStyle = hex(shape.strokeColor || '#000');
          ctx.lineWidth   = (shape.strokeWidth || 1) * s;
          ctx.lineCap     = 'round';
          ctx.beginPath();
          if (Math.abs(D) < 1e-5) {
            ctx.moveTo(x1 * s, y1 * s);
            ctx.lineTo(x3 * s, y3 * s);
          } else {
            const cx = ((x1 * x1 + y1 * y1) * (y2 - y3) + (x2 * x2 + y2 * y2) * (y3 - y1) + (x3 * x3 + y3 * y3) * (y1 - y2)) / D;
            const cy = ((x1 * x1 + y1 * y1) * (x3 - x2) + (x2 * x2 + y2 * y2) * (x1 - x3) + (x3 * x3 + y3 * y3) * (x2 - x1)) / D;
            const r = Math.sqrt((x1 - cx) ** 2 + (y1 - cy) ** 2);
            const startAngle = Math.atan2(y1 - cy, x1 - cx);
            const endAngle = Math.atan2(y3 - cy, x3 - cx);
            const cross = (x2 - x1) * (y3 - y2) - (y2 - y1) * (x3 - x2);
            const counterclockwise = cross < 0;
            ctx.arc(cx * s, cy * s, r * s, startAngle, endAngle, counterclockwise);
          }
          ctx.stroke();
          break;
        }

        // ── Text box ─────────────────────────────────────────────────────────
        case 'text': {
          if (skipVectorText) break;
          const txtWidth = shape.width || 200;
          const R = shape.rotation || 0;

          ctx.save();
          ctx.translate(shape.x * s, shape.y * s);
          if (R !== 0) {
            ctx.rotate(R * Math.PI / 180);
          }
          drawTextOnCanvas(
            ctx,
            shape.text || '',
            0,
            0,
            txtWidth,
            shape.fontSize || 16,
            (shape as any).fontFamily || 'Inter',
            shape.strokeColor || '#000',
            'left',
            'top',
            shape.isItalic || false,
            shape.isBold || false,
            shape.isUnderline || false,
            shape.isStrike || false,
            5,
            s
          );
          ctx.restore();
          break;
        }
        case 'callout': {
          if (shape.points && shape.points.length >= 4) {
            const width = shape.width || 150;
            const height = shape.height || 60;

            const isRight = shape.x + width / 2 > shape.points[0];
            let elbowX = shape.points[2] ?? (isRight ? shape.x - 20 : shape.x + width + 20);
            const elbowY = shape.points[3] ?? (shape.y + height / 2);

            let connectX;
            if (isRight) {
              connectX = shape.x;
              if (elbowX > connectX) elbowX = connectX - 20;
            } else {
              connectX = shape.x + width;
              if (elbowX < connectX) elbowX = connectX + 20;
            }
            const connectY = shape.y + height / 2;

            ctx.strokeStyle = hex(shape.strokeColor || '#000');
            ctx.lineWidth   = (shape.strokeWidth || 1) * s;
            ctx.lineCap     = 'round';
            ctx.lineJoin    = 'round';
            ctx.beginPath();
            ctx.moveTo(shape.points[0] * s, shape.points[1] * s);
            ctx.lineTo(elbowX * s, elbowY * s);
            ctx.lineTo(connectX * s, connectY * s);
            ctx.stroke();

            if (!skipVectorText && shape.text) {
              drawTextOnCanvas(
                ctx,
                shape.text,
                shape.x,
                shape.y,
                width,
                shape.fontSize || 16,
                (shape as any).fontFamily || 'Inter',
                shape.strokeColor || '#000',
                'left',
                'middle',
                shape.isItalic || false,
                shape.isBold || false,
                shape.isUnderline || false,
                shape.isStrike || false,
                5,
                s,
                height
              );
            }
          }
          break;
        }

        case 'mark_bolt': {
          const w = (shape.width || 40);
          const h = (shape.height || 60);
          const stroke = hex(shape.strokeColor || '#000');
          const sw = (shape.strokeWidth || 2) * s;
          
          ctx.save();
          ctx.translate(shape.x * s, shape.y * s);
          ctx.rotate(((shape.rotation || 0) * Math.PI) / 180);
          
          const headW = w * s;
          const headH = 12 * s;
          const shaftTopW = w * 0.4 * s;
          const shaftBottomY = h * s;
          
          ctx.strokeStyle = stroke;
          ctx.lineWidth = sw;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          
          // Head
          ctx.beginPath();
          ctx.ellipse(headW / 2, headH, headW / 2, headH, 0, Math.PI, 0, false);
          ctx.closePath();
          ctx.stroke();
          
          // Slot
          ctx.beginPath();
          ctx.moveTo(headW / 2, 0);
          ctx.lineTo(headW / 2, headH * 0.4);
          ctx.lineWidth = sw * 1.5;
          ctx.stroke();
          ctx.lineWidth = sw;
          
          // Shaft
          ctx.beginPath();
          ctx.moveTo((headW - shaftTopW) / 2, headH);
          ctx.lineTo(headW / 2, shaftBottomY);
          ctx.lineTo((headW + shaftTopW) / 2, headH);
          ctx.closePath();
          ctx.stroke();
          
          // Threads
          const threadSpacing = 6 * s;
          const numThreads = Math.max(1, Math.floor((shaftBottomY - headH) / threadSpacing));
          for (let i = 0; i < numThreads; i++) {
            const y = headH + (i + 1) * threadSpacing;
            if (y > shaftBottomY - 4 * s) continue;
            
            const progress = (y - headH) / (shaftBottomY - headH);
            const currentShaftHalfW = (shaftTopW / 2) * (1 - progress);
            
            ctx.beginPath();
            ctx.moveTo(headW / 2 - currentShaftHalfW, y - 2 * s);
            ctx.lineTo(headW / 2 + currentShaftHalfW, y + 2 * s);
            ctx.stroke();
          }
          
          ctx.restore();
          break;
        }

        case 'mark_thermal_spacer': {
          const w = (shape.width || 40) * s;
          const h = (shape.height || 80) * s;
          const stroke = hex(shape.strokeColor || '#000');
          const sw = (shape.strokeWidth || 2) * s;
          const flipH = shape.markerData?.flipH === 'true';
          const flipV = shape.markerData?.flipV === 'true';

          ctx.save();
          ctx.translate(shape.x * s, shape.y * s);
          ctx.rotate(((shape.rotation || 0) * Math.PI) / 180);
          
          if (flipH || flipV) {
            ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
            ctx.translate(flipH ? -w : 0, flipV ? -h : 0);
          }

          ctx.strokeStyle = stroke;
          ctx.lineWidth = sw;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';

          // Step profile: (0,h) -> (0,h/2) -> (w,h/2) -> (w,0)
          ctx.beginPath();
          ctx.moveTo(0, h);
          ctx.lineTo(0, h / 2);
          ctx.lineTo(w, h / 2);
          ctx.lineTo(w, 0);
          ctx.stroke();

          ctx.restore();
          break;
        }

        case 'mark_sealant': {
          const w = (shape.width || 40) * s;
          const h = (shape.height || 80) * s;
          const stroke = hex(shape.strokeColor || '#000');
          const sw = (shape.strokeWidth || 2) * s;
          const flipH = shape.markerData?.flipH === 'true';
          const flipV = shape.markerData?.flipV === 'true';

          ctx.save();
          ctx.translate(shape.x * s, shape.y * s);
          ctx.rotate(((shape.rotation || 0) * Math.PI) / 180);
          
          if (flipH || flipV) {
            ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
            ctx.translate(flipH ? -w : 0, flipV ? -h : 0);
          }

          ctx.strokeStyle = stroke;
          ctx.lineWidth = sw;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';

          const r = w / 2;
          const cx = r;
          const cy = h - r;

          // Circle
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fillStyle = 'white';
          ctx.fill();
          ctx.stroke();

          // U-shape
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(0, cy);
          ctx.arc(cx, cy, r, Math.PI, 0, true);
          ctx.lineTo(w, 0);
          ctx.quadraticCurveTo(cx, h * 0.1, 0, 0);
          ctx.closePath();
          ctx.stroke();

          ctx.restore();
          break;
        }

        case 'mark_metal_deck': {
          const pts = shape.points || [0, 0, 200, 0];
          const dx = pts[2], dy = pts[3];
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          const nx = dx / len, ny = dy / len;
          const px = -ny, py = nx;

          const stroke = hex(shape.strokeColor || '#000');
          const sw = (shape.strokeWidth || 2) * s;
          const H = parseFloat(shape.markerData?.scale || '20') * s;
          const P = H * 2.5;

          const n = Math.max(1, Math.floor(len * s / P));
          const actualP = (len * s) / n;

          ctx.save();
          ctx.translate(shape.x * s, shape.y * s);
          ctx.strokeStyle = stroke;
          ctx.lineWidth = sw;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';

          ctx.beginPath();
          ctx.moveTo(0, 0);

          for (let i = 0; i < n; i++) {
            const d0 = i * actualP;
            const d1 = d0 + 0.15 * actualP;
            const d2 = d0 + 0.25 * actualP;
            const d3 = d0 + 0.75 * actualP;
            const d4 = d0 + 0.85 * actualP;
            const d5 = (i + 1) * actualP;

            ctx.lineTo(d1 * nx, d1 * ny);
            ctx.lineTo(d2 * nx + H * px, d2 * ny + H * py);
            ctx.lineTo(d3 * nx + H * px, d3 * ny + H * py);
            ctx.lineTo(d4 * nx, d4 * ny);
            ctx.lineTo(d5 * nx, d5 * ny);
          }
          ctx.stroke();
          ctx.restore();
          break;
        }
          case 'mark_single_elevation': {
            const w = Math.max(shape.width  || 60, shape.minWidth  || 40);
            const hw = w / 2;
            const r = w / 2.5;
            const cx = hw;
            const cy = r + 5;
            
            ctx.strokeStyle = hex(shape.strokeColor || '#000');
            ctx.lineWidth   = (shape.strokeWidth || 2) * s;
            
            ctx.save();
            ctx.translate(shape.x * s, shape.y * s);
            ctx.rotate(((shape.rotation || 0) * Math.PI) / 180);
            
            // Triangle tail
            const angle = Math.PI / 4;
            const x1 = cx - r * Math.sin(angle);
            const y1 = cy + r * Math.cos(angle);
            const x2 = cx + r * Math.sin(angle);
            const y2 = cy + r * Math.cos(angle);
            const x3 = cx;
            const y3 = cy + r * 1.8;
            
            ctx.beginPath();
            ctx.moveTo(x1 * s, y1 * s);
            ctx.lineTo(x2 * s, y2 * s);
            ctx.lineTo(x3 * s, y3 * s);
            ctx.closePath();
            ctx.fillStyle = hex(shape.strokeColor || '#000');
            ctx.fill();
            
            // Circle
            ctx.beginPath();
            ctx.arc(cx * s, cy * s, r * s, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
            ctx.stroke();
            
            // Text inside circle
            const topTxt = shape.markerData?.top    ?? '-';
            const botTxt = shape.markerData?.bottom ?? '-';
            const rawFontSize = shape.fontSize || 13;
            
            ctx.fillStyle = hex(shape.strokeColor || '#000');
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = `bold ${rawFontSize * s}px Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
            ctx.fillText(topTxt, cx * s, cy * s);
            
            // Text below triangle
            ctx.font = `${rawFontSize * 0.9 * s}px Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
            ctx.textBaseline = 'top';
            ctx.fillText(botTxt, cx * s, (y3 + 5) * s);
            
            ctx.restore();
            break;
          }

          case 'mark_hat_channel': {
            const w = Math.max(shape.width  || 100, 20);
            const h = Math.max(shape.height || 40, 10);
            const f_len = w * 0.2;
            const t_indent = w * 0.3;
            
            ctx.strokeStyle = hex(shape.strokeColor || '#000');
            ctx.lineWidth   = (shape.strokeWidth || 2) * s;
            
            ctx.save();
            ctx.translate(shape.x * s, shape.y * s);
            ctx.rotate(((shape.rotation || 0) * Math.PI) / 180);
            
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            
            ctx.beginPath();
            ctx.moveTo(0, h * s);
            ctx.lineTo(f_len * s, h * s);
            ctx.lineTo(t_indent * s, 0);
            ctx.lineTo((w - t_indent) * s, 0);
            ctx.lineTo((w - f_len) * s, h * s);
            ctx.lineTo(w * s, h * s);
            ctx.stroke();
            
            ctx.restore();
            break;
          }

          case 'mark_masonry_ties': {
            const baseW = 100;
            const w = Math.max(shape.width || 120, 40);
            const s_scale = w / baseW;
            
            ctx.strokeStyle = hex(shape.strokeColor || '#000');
            ctx.lineWidth   = (shape.strokeWidth || 1.5) * s;
            
            ctx.save();
            ctx.translate(shape.x * s, shape.y * s);
            ctx.rotate(((shape.rotation || 0) * Math.PI) / 180);
            
            const scaled = s_scale * s;
            
            // L-bracket
            ctx.lineJoin = 'miter';
            ctx.beginPath();
            ctx.moveTo(35 * scaled, 10 * scaled);
            ctx.lineTo(35 * scaled, 35 * scaled);
            ctx.lineTo(60 * scaled, 35 * scaled);
            ctx.stroke();
            
            // Bolt
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(33 * scaled, 18 * scaled, 2 * scaled, 8 * scaled);
            ctx.strokeRect(33 * scaled, 18 * scaled, 2 * scaled, 8 * scaled);
            
            // Washer
            ctx.fillRect(35 * scaled, 20 * scaled, 4 * scaled, 4 * scaled);
            ctx.strokeRect(35 * scaled, 20 * scaled, 4 * scaled, 4 * scaled);
            
            // Anchor sprays
            ctx.lineWidth = (shape.strokeWidth || 1.5) * 0.7 * s;
            ctx.beginPath();
            ctx.moveTo(10 * scaled, 22 * scaled); ctx.lineTo(30 * scaled, 22 * scaled);
            ctx.moveTo(12 * scaled, 12 * scaled); ctx.lineTo(28 * scaled, 20 * scaled);
            ctx.moveTo(12 * scaled, 32 * scaled); ctx.lineTo(28 * scaled, 24 * scaled);
            ctx.stroke();
            
            // Tie wire
            ctx.lineWidth = (shape.strokeWidth || 1.5) * s;
            ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo(55 * scaled, 32 * scaled);
            ctx.quadraticCurveTo(58 * scaled, 28 * scaled, 62 * scaled, 32 * scaled);
            ctx.lineTo(65 * scaled, 38 * scaled);
            ctx.lineTo(90 * scaled, 38 * scaled);
            ctx.lineTo(92 * scaled, 35 * scaled);
            ctx.lineTo(105 * scaled, 35 * scaled);
            ctx.lineTo(105 * scaled, 41 * scaled);
            ctx.lineTo(92 * scaled, 41 * scaled);
            ctx.lineTo(90 * scaled, 38 * scaled);
            ctx.stroke();
            
            // Tail
            ctx.beginPath();
            ctx.moveTo(55 * scaled, 35 * scaled);
            ctx.lineTo(55 * scaled, 55 * scaled);
            ctx.stroke();
            
            ctx.restore();
            break;
          }

          case 'mark_t_section': {
            const w = Math.max(shape.width  || 80, 10);
            const h = Math.max(shape.height || 60, 10);
            
            ctx.strokeStyle = hex(shape.strokeColor || '#000');
            ctx.lineWidth   = (shape.strokeWidth || 4) * s;
            
            ctx.save();
            ctx.translate(shape.x * s, shape.y * s);
            ctx.rotate(((shape.rotation || 0) * Math.PI) / 180);
            
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(0, h * s);
            ctx.moveTo(0, (h / 2) * s);
            ctx.lineTo(w * s, (h / 2) * s);
            ctx.stroke();
            
            ctx.restore();
            break;
          }

          case 'mark_cfmf_stud': {
            const w = Math.max(shape.width  || 120, 20);
            const h = Math.max(shape.height || 40, 10);
            const lip = w * 0.08;
            
            ctx.strokeStyle = hex(shape.strokeColor || '#000');
            ctx.lineWidth   = (shape.strokeWidth || 2) * s;
            
            ctx.save();
            ctx.translate(shape.x * s, shape.y * s);
            ctx.rotate(((shape.rotation || 0) * Math.PI) / 180);
            
            ctx.lineJoin = 'miter';
            ctx.lineCap  = 'square';
            ctx.beginPath();
            ctx.moveTo(lip * s, 0);
            ctx.lineTo(0, 0);
            ctx.lineTo(0, h * s);
            ctx.lineTo(w * s, h * s);
            ctx.lineTo(w * s, 0);
            ctx.lineTo((w - lip) * s, 0);
            ctx.stroke();
            
            ctx.restore();
            break;
          }

          case 'mark_break_line': {
            const w = shape.width || 100;
            const h = Math.max(shape.height || 20, 20);
            const kSize = parseFloat(shape.markerData?.kinkSize || '10');
            const maskSide = shape.markerData?.maskSide === 'top' ? 'top' : 'bottom';
            const hasMask = shape.markerData?.showMask !== 'false';
            
            const kw = kSize;
            const kh = kSize;
            const lineY = maskSide === 'top' ? h - kh : kh;
            const midX = w / 2;
            
            ctx.strokeStyle = hex(shape.strokeColor || '#000');
            ctx.lineWidth   = (shape.strokeWidth || 1) * s;
            
            ctx.save();
            ctx.translate(shape.x * s, shape.y * s);
            ctx.rotate(((shape.rotation || 0) * Math.PI) / 180);
            
            const lPts = [
              0, lineY,
              midX - kw, lineY,
              midX - kw/2, lineY - kh,
              midX + kw/2, lineY + kh,
              midX + kw, lineY,
              w, lineY
            ];
            
            if (hasMask) {
              ctx.fillStyle = '#ffffff';
              ctx.beginPath();
              ctx.moveTo(lPts[0] * s, lPts[1] * s);
              for (let i = 2; i < lPts.length; i += 2) {
                ctx.lineTo(lPts[i] * s, lPts[i + 1] * s);
              }
              ctx.lineTo(w * s, (maskSide === 'top' ? 0 : h) * s);
              ctx.lineTo(0, (maskSide === 'top' ? 0 : h) * s);
              ctx.closePath();
              ctx.fill();
            }
            
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo(lPts[0] * s, lPts[1] * s);
            for (let i = 2; i < lPts.length; i += 2) {
              ctx.lineTo(lPts[i] * s, lPts[i + 1] * s);
            }
            ctx.stroke();
            
            ctx.restore();
            break;
          }

          case 'mark_door': {
            const size = Math.max(10, shape.width || 40);
            const stroke = hex(shape.strokeColor || '#000');
            const sw = (shape.strokeWidth || 2) * s;
            const flipH = shape.markerData?.flipH === 'true';
            const flipV = shape.markerData?.flipV === 'true';
            
            ctx.save();
            ctx.translate(shape.x * s, shape.y * s);
            ctx.rotate(((shape.rotation || 0) * Math.PI) / 180);
            ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
            
            ctx.strokeStyle = stroke;
            
            // Hinge
            ctx.lineWidth = sw * 2.5;
            ctx.lineCap = 'square';
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(0, -size * s);
            ctx.stroke();
            
            // Swing Arc
            ctx.lineWidth = sw;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.arc(0, 0, size * s, -Math.PI / 2, 0, false);
            ctx.stroke();
            
            // Threshold (dashed line)
            ctx.lineWidth = sw * 0.5;
            ctx.setLineDash([4 * s, 4 * s]);
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(size * s, 0);
            ctx.stroke();
            ctx.setLineDash([]);
            
            ctx.restore();
            break;
          }

          case 'mark_double_door': {
            const w = Math.max(20, shape.width || 80);
            const h = w / 2;
            const stroke = hex(shape.strokeColor || '#000');
            const sw = (shape.strokeWidth || 2) * s;
            const flipH = shape.markerData?.flipH === 'true';
            const flipV = shape.markerData?.flipV === 'true';
            
            ctx.save();
            ctx.translate(shape.x * s, shape.y * s);
            ctx.rotate(((shape.rotation || 0) * Math.PI) / 180);
            ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
            
            ctx.strokeStyle = stroke;
            
            // Left hinge
            ctx.lineWidth = sw * 2.5;
            ctx.lineCap = 'square';
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(0, -h * s);
            ctx.stroke();
            
            // Left Swing Arc
            ctx.lineWidth = sw;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.arc(0, 0, h * s, -Math.PI / 2, 0, false);
            ctx.stroke();
            
            // Right hinge
            ctx.lineWidth = sw * 2.5;
            ctx.lineCap = 'square';
            ctx.beginPath();
            ctx.moveTo(w * s, 0);
            ctx.lineTo(w * s, -h * s);
            ctx.stroke();
            
            // Right Swing Arc
            ctx.lineWidth = sw;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.arc(w * s, 0, h * s, -Math.PI / 2, -Math.PI, true);
            ctx.stroke();
            
            // Threshold
            ctx.lineWidth = sw * 0.5;
            ctx.setLineDash([4 * s, 4 * s]);
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(w * s, 0);
            ctx.stroke();
            ctx.setLineDash([]);
            
            ctx.restore();
            break;
          }

          case 'mark_angle': {
            const w = Math.max(1, shape.width  || 80);
            const h = Math.max(1, shape.height || 80);
            const stroke = hex(shape.strokeColor || '#000');
            const sw = (shape.strokeWidth || 2) * s;
            const angleDeg = parseFloat(shape.markerData?.angle || '90');
            const angleRad = (angleDeg * Math.PI) / 180;
            
            ctx.save();
            ctx.translate(shape.x * s, shape.y * s);
            ctx.rotate(((shape.rotation || 0) * Math.PI) / 180);
            
            ctx.strokeStyle = stroke;
            ctx.lineWidth   = sw;
            ctx.lineCap     = 'round';
            ctx.lineJoin    = 'round';
            
            const x2 = h * Math.cos(-angleRad);
            const y2 = h * Math.sin(-angleRad);
            
            ctx.beginPath();
            ctx.moveTo(w * s, 0);
            ctx.lineTo(0, 0);
            ctx.lineTo(x2 * s, y2 * s);
            ctx.stroke();
            
            ctx.restore();
            break;
          }

        // ── Stamp ─────────────────────────────────────────────────────────────
        case 'stamp': {
          const w = shape.width || 120, h = shape.height || 60;
          const R = shape.rotation || 0;
          ctx.save();
          ctx.translate(shape.x * s, shape.y * s);
          if (R !== 0) {
            ctx.rotate(R * Math.PI / 180);
          }
          ctx.strokeStyle = hex(shape.strokeColor || '#000');
          ctx.lineWidth   = (shape.strokeWidth || 2) * s;
          
          // Draw rounded rectangle
          const r = 4 * s;
          ctx.beginPath();
          ctx.roundRect(0, 0, w * s, h * s, r);
          ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
          ctx.fill();
          ctx.stroke();

          // Centered bold text
          const stampText = shape.stampText || '';
          const fontSize = Math.min(w / 5, 24) * s;
          ctx.font = `bold ${fontSize}px Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
          ctx.fillStyle = hex(shape.strokeColor || '#000');
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(stampText, (w / 2) * s, (h / 2) * s);

          ctx.restore();
          break;
        }

        // ── Image ─────────────────────────────────────────────────────────────
        case 'image': {
          const img = imageMap.get(shape.id);
          if (!img) break;
          const w = shape.width || 100, h = shape.height || 100;
          const R = shape.rotation || 0;
          ctx.save();
          ctx.translate(shape.x * s, shape.y * s);
          if (R !== 0) {
            ctx.rotate(R * Math.PI / 180);
          }
          ctx.drawImage(img, 0, 0, w * s, h * s);
          ctx.restore();
          break;
        }

        // ── Content Box ───────────────────────────────────────────────────────
        case 'content_box': {
          const img = imageMap.get(shape.id);
          const fw = shape.width || 0;
          const fh = shape.height || 0;
          const at = shape.assetTransform || { x: 0, y: 0, width: fw, height: fh };
          const ax = at.x, ay = at.y, aw = at.width, ah = at.height;

          ctx.save();
          // Clip to the frame boundary
          ctx.beginPath();
          ctx.rect(shape.x * s, shape.y * s, fw * s, fh * s);
          ctx.clip();

          if (img) {
            // Draw image inside frame using assetTransform
            ctx.drawImage(
              img,
              (shape.x + ax) * s,
              (shape.y + ay) * s,
              aw * s,
              ah * s
            );
          } else {
            // Draw placeholder X
            ctx.strokeStyle = 'rgba(77,166,255,0.35)';
            ctx.lineWidth = 1 * s;
            ctx.beginPath();
            ctx.moveTo(shape.x * s, shape.y * s);
            ctx.lineTo((shape.x + fw) * s, (shape.y + fh) * s);
            ctx.moveTo((shape.x + fw) * s, shape.y * s);
            ctx.lineTo(shape.x * s, (shape.y + fh) * s);
            ctx.stroke();
          }
          ctx.restore();

          // Draw explicit stroke border if any
          const hasExplicitStroke = shape.strokeColor && shape.strokeColor !== 'transparent';
          if (hasExplicitStroke) {
            ctx.strokeStyle = hex(shape.strokeColor);
            ctx.lineWidth = (shape.strokeWidth || 1) * s;
            ctx.strokeRect(shape.x * s, shape.y * s, fw * s, fh * s);
          }
          break;
        }
      }
    } catch (e) {
      console.warn('[canvasRenderer] shape error:', shape.type, e);
    }
    ctx.restore();
  }
}
