// ─────────────────────────────────────────────────────────────────────────────
// MarksRenderer.tsx  (v2 — coordinate system fixed)
//
// Coordinate convention (IMPORTANT):
//   Line marks  → shape.x/shape.y = start (tail), shape.points = [0,0,dx,dy] RELATIVE
//   Box  marks  → shape.x/shape.y = top-left, shape.width/height = size
//
// All Groups are positioned at shape.x/shape.y; internal drawing uses relative
// coords so no double-offset occurs when dragging.
// ─────────────────────────────────────────────────────────────────────────────

import { Group, Line, Circle, Text, Shape, Rect, Path } from 'react-konva';
import type { ShapeData } from '../store/types';

// ─── Shared event-prop builder ────────────────────────────────────────────────
// Deliberately does NOT include x/y — each marker sets those explicitly.
function mkGrpProps(shape: ShapeData, cp: any) {
  return {
    id: `shape-${shape.id}`,
    draggable:       cp.draggable,
    rotation:        shape.rotation ?? 0,
    onClick:         cp.onClick,
    onTap:           cp.onTap,
    onDblClick:      cp.onDblClick,
    onDragStart:     cp.onDragStart,
    onDragMove:      cp.onDragMove,
    onDragEnd:       cp.onDragEnd,
    onTransformStart:cp.onTransformStart,
    onTransform:     cp.onTransform,
    onTransformEnd:  cp.onTransformEnd,
    dragBoundFunc:   cp.dragBoundFunc,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION MARKER
//
// Visual (matches reference image):
//   • Long horizontal line from tail (0,0) toward the bubble
//   • Circle bubble at the HEAD end (pts[2], pts[3]) — always at line END
//   • Horizontal divider through circle centre
//   • View # in top half, sheet # in bottom half
//   • Two filled-triangle "wings" at the point where the line meets the circle,
//     pointing perpendicular (they indicate the viewing direction)
// ─────────────────────────────────────────────────────────────────────────────

export function SectionMarker({ shape, commonProps: cp, isSelected }: {
  shape: ShapeData; commonProps: any; isSelected: boolean;
}) {
  const pts = shape.points || [0, 0, 200, 0];
  const dx = pts[2], dy = pts[3];               // relative end (= head)
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = dx / len, ny = dy / len;            // unit vector, tail→head
  const flip = shape.markerData?.flipArrow === 'true';
  const px = flip ? -ny : ny;
  const py = flip ? nx : -nx;                       // perpendicular (points UP when drawn left-to-right)

  const stroke   = shape.strokeColor || '#000';
  const sw       = shape.strokeWidth || 2;
  const fontSize = shape.fontSize    || 11;
  const r        = Math.max(16, fontSize * 1.5); // bubble radius

  // Triangle dimensions
  const R = r * 1.35; // base half-width
  const H = r * 1.8;  // apex distance

  // Line stops at the triangle's base corner
  const lx = dx - nx * R, ly = dy - ny * R;

  const topTxt = shape.markerData?.top    ?? '1';
  const botTxt = shape.markerData?.bottom ?? 'A100';

  return (
    <Group {...mkGrpProps(shape, cp)} x={shape.x} y={shape.y}>
      {/* Tail Block */}
      <Line points={[0, 0, px * r * 1.2, py * r * 1.2]}
        stroke={stroke} strokeWidth={sw * 4} lineCap="square" listening={false} />

      {/* Cut line */}
      <Line points={[0, 0, lx, ly]}
        stroke={stroke} strokeWidth={sw} dash={shape.dash || undefined} lineCap="round" listening={false} />

      {/* Perpendicular Arrow (Open Triangle) */}
      <Shape sceneFunc={(ctx) => {
        ctx.beginPath();
        ctx.moveTo(dx - nx * R, dy - ny * R);                 
        ctx.lineTo(dx + nx * R, dy + ny * R);                 
        ctx.lineTo(dx + px * H, dy + py * H); // apex
        ctx.closePath();
        ctx.strokeStyle = stroke;
        ctx.lineWidth = sw;
        ctx.stroke();
      }} listening={false} />

      {/* Bubble circle (white fill hides the triangle base inside the circle) */}
      <Circle x={dx} y={dy} radius={r}
        stroke={stroke} strokeWidth={sw} fill="white" listening={false} />

      {/* Horizontal divider */}
      <Line points={[dx - r, dy, dx + r, dy]}
        stroke={stroke} strokeWidth={sw * 0.8} listening={false} />

      {/* View # — top half */}
      <Text x={dx - r} y={dy - r + 2} width={r * 2} height={r - 2}
        text={topTxt} fontSize={fontSize} fontFamily={shape.fontFamily || 'Inter'} fontStyle="bold"
        fill={stroke} align="center" verticalAlign="middle" listening={false} />

      {/* Sheet # — bottom half */}
      <Text x={dx - r} y={dy + 2} width={r * 2} height={r - 2}
        text={botTxt} fontSize={fontSize} fontFamily={shape.fontFamily || 'Inter'}
        fill={stroke} align="center" verticalAlign="middle" listening={false} />

      {/* Wide transparent hit strip so clicking anywhere on the line works */}
      <Line points={[0, 0, dx, dy]}
        stroke="transparent" strokeWidth={Math.max(16 / (cp.currentScale || 1.0), sw * 4)} listening={true}
        onClick={cp.onClick} onTap={cp.onTap} />

      {isSelected && (
        <Line points={[0, 0, dx, dy]}
          stroke="#4da6ff" strokeWidth={1} dash={[5, 4]} opacity={0.7} listening={false} />
      )}
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LEVEL MARKER
//
// Visual (matches reference image):
//   • Horizontal line from tail (0,0) to bubble
//   • Circle at HEAD with LEFT half filled solid, right half white
//   • Floor name text ABOVE bubble
//   • Elevation text BELOW bubble
// ─────────────────────────────────────────────────────────────────────────────

export function LevelMarker({ shape, commonProps: cp, isSelected }: {
  shape: ShapeData; commonProps: any; isSelected: boolean;
}) {
  const pts = shape.points || [0, 0, 200, 0];
  const dx = pts[2], dy = pts[3];
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = dx / len, ny = dy / len;

  const stroke   = shape.strokeColor || '#000';
  const sw       = shape.strokeWidth || 2;
  const fontSize = shape.fontSize    || 11;
  const r        = Math.max(14, fontSize * 1.4);

  // Line up to circle edge
  const lx = dx - nx * r, ly = dy - ny * r;

  const nameTxt = shape.markerData?.name      ?? 'Level';
  const elevTxt = shape.markerData?.elevation ?? "100'-0";

  // Text positioning
  const isRightOfTail = dx >= 0;
  const textW = 400;
  const padding = 8;
  const txtX = isRightOfTail ? lx - textW - padding : lx + padding;
  const align = isRightOfTail ? 'right' : 'left';

  const nameY = ly - fontSize - 4;
  const elevY = ly + 4;

  const baseAngle = Math.atan2(ny, nx);

  return (
    <Group {...mkGrpProps(shape, cp)} x={shape.x} y={shape.y}>
      {/* Datum line */}
      <Line points={[0, 0, lx, ly]}
        stroke={stroke} strokeWidth={sw} dash={shape.dash || undefined} lineCap="round" listening={false} />

      {/* Target Circle with alternating filled quadrants */}
      <Shape sceneFunc={(ctx) => {
        // Base white circle
        ctx.beginPath();
        ctx.arc(dx, dy, r, 0, Math.PI * 2);
        ctx.fillStyle = 'white';
        ctx.fill();

        // Top-left quadrant (relative to line)
        ctx.beginPath();
        ctx.moveTo(dx, dy);
        ctx.arc(dx, dy, r, baseAngle + Math.PI, baseAngle + 1.5 * Math.PI);
        ctx.closePath();
        ctx.fillStyle = stroke;
        ctx.fill();

        // Bottom-right quadrant (relative to line)
        ctx.beginPath();
        ctx.moveTo(dx, dy);
        ctx.arc(dx, dy, r, baseAngle, baseAngle + 0.5 * Math.PI);
        ctx.closePath();
        ctx.fillStyle = stroke;
        ctx.fill();

        // Outline and crosshairs
        ctx.beginPath();
        ctx.arc(dx, dy, r, 0, Math.PI * 2);
        
        ctx.moveTo(dx - nx * r, dy - ny * r);
        ctx.lineTo(dx + nx * r, dy + ny * r);
        
        const px = -ny, py = nx;
        ctx.moveTo(dx - px * r, dy - py * r);
        ctx.lineTo(dx + px * r, dy + py * r);

        ctx.strokeStyle = stroke;
        ctx.lineWidth = sw;
        ctx.stroke();
      }} listening={false} />

      {/* Floor name — above the line */}
      <Text x={txtX} y={nameY} width={textW}
        text={nameTxt} fontSize={fontSize} fontFamily={shape.fontFamily || 'Inter'}
        fill={stroke} align={align} listening={false} />

      {/* Elevation — below the line */}
      <Text x={txtX} y={elevY} width={textW}
        text={elevTxt} fontSize={fontSize} fontFamily={shape.fontFamily || 'Inter'}
        fill={stroke} align={align} listening={false} />

      {/* Hit area */}
      <Line points={[0, 0, dx, dy]}
        stroke="transparent" strokeWidth={Math.max(16 / (cp.currentScale || 1.0), sw * 4)} listening={true}
        onClick={cp.onClick} onTap={cp.onTap} />

      {isSelected && (
        <Line points={[0, 0, dx, dy]}
          stroke="#4da6ff" strokeWidth={1} dash={[5, 4]} opacity={0.7} listening={false} />
      )}
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GRID MARKER
//
// Visual: Dashed line from tail to circle bubble at HEAD.  Letter/number inside.
// ─────────────────────────────────────────────────────────────────────────────

export function GridMarker({ shape, commonProps: cp, isSelected }: {
  shape: ShapeData; commonProps: any; isSelected: boolean;
}) {
  const pts = shape.points || [0, 0, 0, 200];
  const dx = pts[2], dy = pts[3];
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = dx / len, ny = dy / len;

  const stroke   = shape.strokeColor || '#000';
  const sw       = shape.strokeWidth || 2;
  const fontSize = shape.fontSize    || 14;
  const r        = Math.max(14, fontSize * 1.25);
  const label    = shape.markerData?.label ?? 'A';

  const lx = dx - nx * r, ly = dy - ny * r;

  return (
    <Group {...mkGrpProps(shape, cp)} x={shape.x} y={shape.y}>
      {/* Dashed line */}
      <Line points={[0, 0, lx, ly]}
        stroke={stroke} strokeWidth={sw} dash={shape.dash || [10, 6]}
        lineCap="round" listening={false} />

      {/* Circle bubble */}
      <Circle x={dx} y={dy} radius={r}
        stroke={stroke} strokeWidth={sw} fill="white" listening={false} />

      {/* Label */}
      <Text x={dx - r} y={dy - r} width={r * 2} height={r * 2}
        text={label} fontSize={fontSize} fontFamily={shape.fontFamily || 'Inter'} fontStyle="bold"
        fill={stroke} align="center" verticalAlign="middle" listening={false} />

      {/* Hit area */}
      <Line points={[0, 0, dx, dy]}
        stroke="transparent" strokeWidth={Math.max(16 / (cp.currentScale || 1.0), sw * 4)} listening={true}
        onClick={cp.onClick} onTap={cp.onTap} />

      {isSelected && (
        <Line points={[0, 0, dx, dy]}
          stroke="#4da6ff" strokeWidth={1} dash={[5, 4]} opacity={0.7} listening={false} />
      )}
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ELEVATION MARKER
//
// Visual: Diamond (rotated square) with 4 filled arrow tips at N/S/E/W.
//         Central text label. Uses shape.x/y/width/height (box-based).
// ─────────────────────────────────────────────────────────────────────────────

export function ElevationMarker({ shape, commonProps: cp, isSelected }: {
  shape: ShapeData; commonProps: any; isSelected: boolean;
}) {
  const w  = Math.max(shape.width  || 80, shape.minWidth  || 40);
  const h  = Math.max(shape.height || 80, shape.minHeight || 40);
  const hw = w / 2, hh = h / 2;

  const stroke   = shape.strokeColor || '#000';
  const sw       = shape.strokeWidth || 2;
  const fontSize = shape.fontSize    || 13;
  const label    = shape.markerData?.label ?? 'A5.10';
  
  const topTxt   = shape.markerData?.top ?? '';
  const botTxt   = shape.markerData?.bottom ?? '';
  const leftTxt  = shape.markerData?.left ?? '';
  const rightTxt = shape.markerData?.right ?? '';

  // Diamond corners
  const top    = { x: hw, y: 0 };
  const right  = { x: w,  y: hh };
  const bottom = { x: hw, y: h  };
  const left   = { x: 0,  y: hh };

  // Inscribed circle radius
  const radius = Math.min(hw, hh) / Math.SQRT2;

  return (
    <Group {...mkGrpProps(shape, cp)} x={shape.x} y={shape.y}>
      {/* Solid Diamond */}
      <Shape sceneFunc={(ctx, shapeProps) => {
        ctx.beginPath();
        ctx.moveTo(top.x, top.y);
        ctx.lineTo(right.x, right.y);
        ctx.lineTo(bottom.x, bottom.y);
        ctx.lineTo(left.x, left.y);
        ctx.closePath();
        ctx.fillStrokeShape(shapeProps);
      }} fill={stroke} stroke={stroke} strokeWidth={sw} listening={true} onClick={cp.onClick} onTap={cp.onTap} />

      {/* Inscribed white circle */}
      <Circle x={hw} y={hh} radius={radius}
        fill="white" stroke={stroke} strokeWidth={sw} listening={false} />

      {/* Centre label */}
      <Text x={0} y={0} width={w} height={h}
        text={label} fontSize={fontSize} fontFamily={shape.fontFamily || 'Inter'} fontStyle="bold"
        fill={stroke} align="center" verticalAlign="middle" listening={false} />

      {/* 4 Corner Labels */}
      {topTxt && (
        <Text x={0} y={-fontSize - 6} width={w} height={fontSize}
          text={topTxt} fontSize={fontSize * 0.85} fontFamily={shape.fontFamily || 'Inter'}
          fill={stroke} align="center" verticalAlign="bottom" listening={false} />
      )}
      {botTxt && (
        <Text x={0} y={h + 6} width={w} height={fontSize}
          text={botTxt} fontSize={fontSize * 0.85} fontFamily={shape.fontFamily || 'Inter'}
          fill={stroke} align="center" verticalAlign="top" listening={false} />
      )}
      {leftTxt && (
        <Text x={-w} y={hh - fontSize * 0.425} width={w - 6} height={fontSize}
          text={leftTxt} fontSize={fontSize * 0.85} fontFamily={shape.fontFamily || 'Inter'}
          fill={stroke} align="right" verticalAlign="middle" listening={false} />
      )}
      {rightTxt && (
        <Text x={w + 6} y={hh - fontSize * 0.425} width={w} height={fontSize}
          text={rightTxt} fontSize={fontSize * 0.85} fontFamily={shape.fontFamily || 'Inter'}
          fill={stroke} align="left" verticalAlign="middle" listening={false} />
      )}

      {isSelected && (
        <Rect x={-10} y={-10} width={w + 20} height={h + 20}
          fill="transparent" stroke="#4da6ff" strokeWidth={1} dash={[4, 4]} listening={false} />
      )}
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE ELEVATION MARKER
//
// Visual: Circle with a filled triangular tail at the bottom.
//         Top label inside circle, bottom label below triangle.
// ─────────────────────────────────────────────────────────────────────────────

export function SingleElevationMarker({ shape, commonProps: cp, isSelected }: {
  shape: ShapeData; commonProps: any; isSelected: boolean;
}) {
  const w  = Math.max(shape.width  || 60, shape.minWidth  || 40);
  const h  = Math.max(shape.height || 80, shape.minHeight || 40);
  const hw = w / 2;

  const stroke   = shape.strokeColor || '#000';
  const sw       = shape.strokeWidth || 2;
  const fontSize = shape.fontSize    || 13;
  
  const topTxt   = shape.markerData?.top    ?? '-';
  const botTxt   = shape.markerData?.bottom ?? '-';

  // Circle at top
  const r = w / 2.5;
  const cx = hw;
  const cy = r + 5; // padding from top
  
  // Triangle tail
  const angle = Math.PI / 4; // 45 degrees
  const x1 = cx - r * Math.sin(angle);
  const y1 = cy + r * Math.cos(angle);
  const x2 = cx + r * Math.sin(angle);
  const y2 = cy + r * Math.cos(angle);
  const x3 = cx;
  const y3 = cy + r * 1.8; // apex

  return (
    <Group {...mkGrpProps(shape, cp)} x={shape.x} y={shape.y}>
       {/* Triangle Tail */}
       <Shape sceneFunc={(ctx) => {
         ctx.beginPath();
         ctx.moveTo(x1, y1);
         ctx.lineTo(x2, y2);
         ctx.lineTo(x3, y3);
         ctx.closePath();
         ctx.fillStyle = stroke;
         ctx.fill();
       }} listening={false} />

       {/* Bubble circle */}
       <Circle x={cx} y={cy} radius={r}
         stroke={stroke} strokeWidth={sw} fill="white" listening={true} onClick={cp.onClick} onTap={cp.onTap} />

       {/* Top text (inside circle) */}
       <Text x={cx - r} y={cy - r} width={r * 2} height={r * 2}
         text={topTxt} fontSize={fontSize} fontFamily={shape.fontFamily || 'Inter'} fontStyle="bold"
         fill={stroke} align="center" verticalAlign="middle" listening={false} />
       
       {/* Bottom text (below triangle) */}
       <Text x={0} y={y3 + 5} width={w} height={fontSize * 1.2}
         text={botTxt} fontSize={fontSize * 0.9} fontFamily={shape.fontFamily || 'Inter'}
         fill={stroke} align="center" verticalAlign="top" listening={false} />

       {isSelected && (
         <Rect x={-5} y={-5} width={w + 10} height={h + 10}
           fill="transparent" stroke="#4da6ff" strokeWidth={1} dash={[4, 4]} listening={false} />
       )}
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HAT CHANNEL MARKER
//
// Visual: A trapezoidal "hat" profile with flanges.
// ─────────────────────────────────────────────────────────────────────────────

export function HatChannelMarker({ shape, commonProps: cp, isSelected }: {
  shape: ShapeData; commonProps: any; isSelected: boolean;
}) {
  const w = Math.max(shape.width  || 100, 20);
  const h = Math.max(shape.height || 40, 10);
  
  const stroke = shape.strokeColor || '#000';
  const sw = shape.strokeWidth || 2;

  // Hat channel proportions:
  // Flanges: 20% each side
  // Web slope: ends at 30% / 70% of total width
  const f_len = w * 0.2;
  const t_indent = w * 0.3;
  
  const pts = [
    0, h,             // Start left flange
    f_len, h,         // End left flange / Start left web
    t_indent, 0,      // End left web / Start top
    w - t_indent, 0,  // End top / Start right web
    w - f_len, h,     // End right web / Start right flange
    w, h              // End right flange
  ];

  const scale = cp?.currentScale || 1.0;
  const hitWidth = Math.max(14 / scale, 14);

  return (
    <Group {...mkGrpProps(shape, cp)} x={shape.x} y={shape.y}>
       <Line
         points={pts}
         stroke={stroke}
         strokeWidth={sw}
         hitStrokeWidth={hitWidth}
         lineJoin="round"
         lineCap="round"
         listening={true}
         onClick={cp.onClick}
         onTap={cp.onTap}
       />
       {isSelected && (
         <Rect x={-5} y={-5} width={w + 10} height={h + 10}
           fill="transparent" stroke="#4da6ff" strokeWidth={1} dash={[4, 4]} listening={false} />
       )}
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MASONRY TIES MARKER
//
// Visual: Complex assembly with L-bracket, bolt, and wire tie.
// ─────────────────────────────────────────────────────────────────────────────

export function MasonryTiesMarker({ shape, commonProps: cp, isSelected }: {
  shape: ShapeData; commonProps: any; isSelected: boolean;
}) {
  const baseW = 100;
  const baseH = 50;
  const aspect = baseH / baseW;
  
  // Force fixed aspect ratio: width drives height
  const w = Math.max(shape.width || 120, 40);
  const h = w * aspect;
  
  const s = w / baseW; // Scale factor
  
  const stroke = shape.strokeColor || '#000';
  const sw = shape.strokeWidth || 1.5;

  return (
    <Group {...mkGrpProps(shape, cp)} x={shape.x} y={shape.y}>
       {/* L-Bracket (L-shape) */}
       <Line points={[35*s, 10*s, 35*s, 35*s, 60*s, 35*s]} stroke={stroke} strokeWidth={sw} lineJoin="miter" />
       
       {/* Bolt and Washer */}
       <Rect x={33*s} y={18*s} width={2*s} height={8*s} stroke={stroke} strokeWidth={sw} fill="white" />
       <Rect x={35*s} y={20*s} width={4*s} height={4*s} stroke={stroke} strokeWidth={sw} fill="white" />
       
       {/* Left side "spray" anchor lines */}
       <Line points={[10*s, 22*s, 30*s, 22*s]} stroke={stroke} strokeWidth={sw*0.7} />
       <Line points={[12*s, 12*s, 28*s, 20*s]} stroke={stroke} strokeWidth={sw*0.7} />
       <Line points={[12*s, 32*s, 28*s, 24*s]} stroke={stroke} strokeWidth={sw*0.7} />

       {/* Tie Wire with hook and flat end */}
       <Path
         data={`M ${55*s} ${32*s} 
                Q ${58*s} ${28*s}, ${62*s} ${32*s}
                L ${65*s} ${38*s}
                L ${90*s} ${38*s}
                L ${92*s} ${35*s}
                L ${105*s} ${35*s}
                L ${105*s} ${41*s}
                L ${92*s} ${41*s}
                L ${90*s} ${38*s}`}
         stroke={stroke}
         strokeWidth={sw}
         lineJoin="round"
       />
       
       {/* Vertical wire tail */}
       <Line points={[55*s, 35*s, 55*s, 55*s]} stroke={stroke} strokeWidth={sw} />

       {isSelected && (
         <Rect x={-5} y={-5} width={w + 10*s} height={h + 15*s}
           fill="transparent" stroke="#4da6ff" strokeWidth={1} dash={[4, 4]} listening={false} />
       )}
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// T SECTION MARKER
//
// Visual: A T-shape (vertical bar + horizontal bar from its centre).
// ─────────────────────────────────────────────────────────────────────────────

export function TSectionMarker({ shape, commonProps: cp, isSelected }: {
  shape: ShapeData; commonProps: any; isSelected: boolean;
}) {
  const w = Math.max(shape.width  || 80, 10);
  const h = Math.max(shape.height || 60, 10);
  
  const stroke = shape.strokeColor || '#000';
  const sw = shape.strokeWidth || 4; // Default thicker for sections

  return (
    <Group {...mkGrpProps(shape, cp)} x={shape.x} y={shape.y}>
       {/* Vertical Flange */}
       <Line
         points={[0, 0, 0, h]}
         stroke={stroke}
         strokeWidth={sw}
         lineCap="round"
       />
       {/* Horizontal Web */}
       <Line
         points={[0, h/2, w, h/2]}
         stroke={stroke}
         strokeWidth={sw}
         lineCap="round"
       />
       {/* Transparent click area */}
       <Rect x={-sw/2} y={-sw/2} width={w + sw} height={h + sw} fill="transparent"
         listening={true} onClick={cp.onClick} onTap={cp.onTap} />

       {isSelected && (
         <Rect x={-5} y={-5} width={w + 10} height={h + 10}
           fill="transparent" stroke="#4da6ff" strokeWidth={1} dash={[4, 4]} listening={false} />
       )}
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CFMF STUD MARKER
//
// Visual: A wide "C" shape with small inward lips (lips are at the top).
// ─────────────────────────────────────────────────────────────────────────────

export function CFMFStudMarker({ shape, commonProps: cp, isSelected }: {
  shape: ShapeData; commonProps: any; isSelected: boolean;
}) {
  const w = Math.max(shape.width  || 120, 20);
  const h = Math.max(shape.height || 40, 10);
  
  const stroke = shape.strokeColor || '#000';
  const sw = shape.strokeWidth || 2;

  // Lips: 8% of width
  const lip = w * 0.08;
  
  const pts = [
    lip, 0,           // End left lip
    0, 0,             // Start left lip / top of left web
    0, h,             // Bottom of left web / left of flange
    w, h,             // Right of flange / bottom of right web
    w, 0,             // Top of right web / start right lip
    w - lip, 0        // End right lip
  ];

  const scale = cp?.currentScale || 1.0;
  const hitWidth = Math.max(14 / scale, 14);

  return (
    <Group {...mkGrpProps(shape, cp)} x={shape.x} y={shape.y}>
       <Line
         points={pts}
         stroke={stroke}
         strokeWidth={sw}
         hitStrokeWidth={hitWidth}
         lineJoin="miter"
         lineCap="square"
         listening={true}
         onClick={cp.onClick}
         onTap={cp.onTap}
       />
       {isSelected && (
         <Rect x={-5} y={-5} width={w + 10} height={h + 10}
           fill="transparent" stroke="#4da6ff" strokeWidth={1} dash={[4, 4]} listening={false} />
       )}
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BREAK LINE MARKER
//
// Visual: A straight line with a zigzag "kink" in the middle.
// Features: Masking on one side (filled white polygon).
// ─────────────────────────────────────────────────────────────────────────────

export function BreakLineMarker({ shape, commonProps: cp, isSelected }: {
  shape: ShapeData; commonProps: any; isSelected: boolean;
}) {
  const w = shape.width || 100;
  const h = Math.max(shape.height || 20, 20); // Height defines the full extent of the mask
  
  const stroke = shape.strokeColor || '#000';
  const sw = shape.strokeWidth || 1;
  
  // Custom properties from markerData
  const kSize = parseFloat(shape.markerData?.kinkSize || '10');
  const maskSide = shape.markerData?.maskSide === 'top' ? 'top' : 'bottom';
  const hasMask = shape.markerData?.showMask !== 'false';

  const kw = kSize;
  const kh = kSize;
  
  // Line sits at the top (kh) or bottom (h - kh) of the box depending on maskSide
  // so that the kink stays perfectly inside the bounding box.
  const lineY = maskSide === 'top' ? h - kh : kh;
  const midX = w / 2;
  
  const linePoints = [
    0, lineY,
    midX - kw, lineY,
    midX - kw/2, lineY - kh,
    midX + kw/2, lineY + kh,
    midX + kw, lineY,
    w, lineY
  ];

  // Masking polygon closes the loop by traveling along the top or bottom edge
  const maskPoints = [
    ...linePoints,
    w, maskSide === 'top' ? 0 : h,
    0, maskSide === 'top' ? 0 : h
  ];

  return (
    <Group {...mkGrpProps(shape, cp)} x={shape.x} y={shape.y}>
       {hasMask && (
         <Line
           points={maskPoints}
           fill="white"
           closed={true}
           listening={false}
         />
       )}
       <Line
         points={linePoints}
         stroke={stroke}
         strokeWidth={sw}
         lineCap="round"
         lineJoin="round"
         listening={false}
       />
       {/* Hit strip filling the entire box */}
       <Rect
         x={0}
         y={0}
         width={w}
         height={h}
         fill="transparent"
         listening={true}
         onClick={cp.onClick}
         onTap={cp.onTap}
       />
       {isSelected && (
         <Rect x={-5} y={-5} width={w + 10} height={h + 10}
           fill="transparent" stroke="#4da6ff" strokeWidth={1} dash={[4, 4]} listening={false} />
       )}
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CALLOUT MARKER
//
// Visual (matches reference image):
//   • Dashed rounded rectangle  (drag to size)
//   • Small circle bubble at top-right corner with divider + two labels
// ─────────────────────────────────────────────────────────────────────────────

export function CalloutMarker({ shape, commonProps: cp, isSelected }: {
  shape: ShapeData; commonProps: any; isSelected: boolean;
}) {
  const w  = Math.max(shape.width  || 160, shape.minWidth  || 40);
  const h  = Math.max(shape.height || 120, shape.minHeight || 40);

  const stroke   = shape.strokeColor || '#000';
  const sw       = shape.strokeWidth || 2;
  const fontSize = shape.fontSize    || 11;

  const topTxt = shape.markerData?.top    ?? 'A1';
  const botTxt = shape.markerData?.bottom ?? 'A401';

  // Bubble sits at top-right corner of the rect
  const bubbleR = Math.max(16, fontSize * 1.4);
  const bx = w;          // bubble centre x (at right edge)
  const by = 0;          // bubble centre y (at top edge)

  return (
    <Group {...mkGrpProps(shape, cp)} x={shape.x} y={shape.y}>
      {/* Dashed rounded rect */}
      <Shape sceneFunc={(ctx, shapeProps) => {
        const cr = Math.min(12, w * 0.08, h * 0.08);
        ctx.beginPath();
        ctx.moveTo(cr, 0);
        ctx.lineTo(w - cr, 0);
        ctx.arcTo(w, 0, w, cr, cr);
        ctx.lineTo(w, h - cr);
        ctx.arcTo(w, h, w - cr, h, cr);
        ctx.lineTo(cr, h);
        ctx.arcTo(0, h, 0, h - cr, cr);
        ctx.lineTo(0, cr);
        ctx.arcTo(0, 0, cr, 0, cr);
        ctx.closePath();
        ctx.fillStrokeShape(shapeProps);
      }} dash={[10, 6]} stroke={stroke} strokeWidth={sw} fill="transparent" listening={true} onClick={cp.onClick} onTap={cp.onTap} />

      {/* Small diagonal leader from corner to bubble */}
      <Line points={[w - bubbleR * 0.4, bubbleR * 0.4, bx, by]}
        stroke={stroke} strokeWidth={sw * 0.8} listening={false} />

      {/* Bubble */}
      <Circle x={bx} y={by} radius={bubbleR}
        stroke={stroke} strokeWidth={sw} fill="white" listening={false} />

      {/* Bubble divider */}
      <Line points={[bx - bubbleR * 0.8, by, bx + bubbleR * 0.8, by]}
        stroke={stroke} strokeWidth={sw * 0.8} listening={false} />

      {/* Top label (view #) */}
      <Text x={bx - bubbleR} y={by - bubbleR + 2} width={bubbleR * 2} height={bubbleR - 2}
        text={topTxt} fontSize={Math.min(fontSize, bubbleR * 0.7)}
        fontFamily={shape.fontFamily || 'Inter'} fontStyle="bold"
        fill={stroke} align="center" verticalAlign="middle" listening={false} />

      {/* Bottom label (sheet #) */}
      <Text x={bx - bubbleR} y={by + 2} width={bubbleR * 2} height={bubbleR - 2}
        text={botTxt} fontSize={Math.min(fontSize, bubbleR * 0.65)}
        fontFamily={shape.fontFamily || 'Inter'}
        fill={stroke} align="center" verticalAlign="middle" listening={false} />

      {isSelected && (
        <Rect x={-4} y={-bubbleR - 4} width={w + bubbleR + 8} height={h + bubbleR + 8}
          fill="transparent" stroke="#4da6ff" strokeWidth={1} dash={[4, 4]} listening={false} />
      )}
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SEALANT MARKER
//
// Visual: A circle with a U-shaped sealant cap on top.
// ─────────────────────────────────────────────────────────────────────────────

export function SealantMarker({ shape, commonProps: cp, isSelected }: {
  shape: ShapeData; commonProps: any; isSelected: boolean;
}) {
  const w = Math.max(shape.width  || 40, 10);
  const h = Math.max(shape.height || 60, 10);
  
  const stroke = shape.strokeColor || '#000';
  const sw = shape.strokeWidth || 2;
  const thickness = parseFloat(shape.markerData?.thickness || '2');

  const r = w / 2;
  const cx = r;
  const cy = h - r; // Center of backer rod circle
  
  const scale = cp?.currentScale || 1.0;
  const hitWidth = Math.max(14 / scale, 14);

  return (
    <Group {...mkGrpProps(shape, cp)} x={shape.x} y={shape.y} rotation={shape.rotation || 0}>
       {/* Backer Rod (Circle) */}
       <Circle x={cx} y={cy} radius={r} stroke={stroke} strokeWidth={sw} fill="white" listening={false} />
       
       {/* Sealant (U-shape) */}
       <Shape
         sceneFunc={(ctx, shapeProps) => {
           ctx.beginPath();
           // Start at top left
           ctx.moveTo(0, 0);
           // Left side down to circle intersection
           ctx.lineTo(0, cy);
           // Curve along the top of the circle
           ctx.arc(cx, cy, r, Math.PI, 0, true);
           // Right side up to top right
           ctx.lineTo(w, 0);
           // Concave top edge
           ctx.quadraticCurveTo(cx, thickness * 5, 0, 0);
           ctx.closePath();
           ctx.fillStrokeShape(shapeProps);
         }}
         stroke={stroke}
         strokeWidth={sw}
         hitStrokeWidth={hitWidth}
         fill="transparent"
         listening={true}
         onClick={cp.onClick}
         onTap={cp.onTap}
       />
       
       {isSelected && (
         <Rect x={-5} y={-5} width={w + 10} height={h + 10}
           fill="transparent" stroke="#4da6ff" strokeWidth={1} dash={[4, 4]} listening={false} />
       )}
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// THERMAL SPACER MARKER
//
// Visual: Same profile as sealant (U-shape + circle).
// Properties: width, height, flipH, flipV.
// ─────────────────────────────────────────────────────────────────────────────

export function ThermalSpacerMarker({ shape, commonProps: cp, isSelected }: {
  shape: ShapeData; commonProps: any; isSelected: boolean;
}) {
  const w = Math.max(shape.width  || 40, 10);
  const h = Math.max(shape.height || 80, 10);
  
  const stroke = shape.strokeColor || '#000';
  const sw = shape.strokeWidth || 2;
  const flipH = shape.markerData?.flipH === 'true';
  const flipV = shape.markerData?.flipV === 'true';

  return (
    <Group 
      {...mkGrpProps(shape, cp)} 
      x={shape.x} y={shape.y} 
      rotation={shape.rotation || 0}
      scaleX={flipH ? -1 : 1}
      scaleY={flipV ? -1 : 1}
      offsetX={flipH ? w : 0}
      offsetY={flipV ? h : 0}
    >
       <Rect x={0} y={0} width={w} height={h} fill="transparent" listening={true} onClick={cp.onClick} onTap={cp.onTap} />
       
       {/* Z-shaped Step Profile */}
       <Line
         points={[0, h, 0, h/2, w, h/2, w, 0]}
         stroke={stroke}
         strokeWidth={sw}
         lineCap="round"
         lineJoin="round"
         listening={false}
       />
       
       {isSelected && (
         <Rect x={-2} y={-2} width={w + 4} height={h + 4}
           fill="transparent" stroke="#4da6ff" strokeWidth={1} dash={[4, 4]} listening={false} />
       )}
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ANGLE MARKER
//
// Visual: Two lines meeting at a vertex (L-shape).
// Properties: width (Leg 1), height (Leg 2), markerData.angle (degrees).
// ─────────────────────────────────────────────────────────────────────────────

export function AngleMarker({ shape, commonProps: cp, isSelected }: {
  shape: ShapeData; commonProps: any; isSelected: boolean;
}) {
  const w = Math.max(1, shape.width  || 80); // Leg 1 Length
  const h = Math.max(1, shape.height || 80); // Leg 2 Length
  
  const stroke = shape.strokeColor || '#000';
  const sw = shape.strokeWidth || 2;
  const angleDeg = parseFloat(shape.markerData?.angle || '90');
  const angleRad = (angleDeg * Math.PI) / 180;

  // Vertex is at (0,0). Leg 1 is along X. Leg 2 is at -angleRad.
  const x2 = h * Math.cos(-angleRad);
  const y2 = h * Math.sin(-angleRad);
  const points = [w, 0, 0, 0, x2, y2];

  const minX = Math.min(0, w, x2);
  const maxX = Math.max(0, w, x2);
  const minY = Math.min(0, y2);
  const maxY = Math.max(0, y2);
  const bw = maxX - minX;
  const bh = maxY - minY;

  const scale = cp?.currentScale || 1.0;
  const hitWidth = Math.max(14 / scale, 14);

  return (
    <Group {...mkGrpProps(shape, cp)} x={shape.x} y={shape.y} rotation={shape.rotation || 0}>
       <Line
         points={points}
         stroke={stroke}
         strokeWidth={sw}
         hitStrokeWidth={hitWidth}
         lineCap="round"
         lineJoin="round"
         listening={true}
         onClick={cp.onClick}
         onTap={cp.onTap}
       />
       {isSelected && (
         <Rect x={minX - 5} y={minY - 5} width={bw + 10} height={bh + 10}
           fill="transparent" stroke="#4da6ff" strokeWidth={1} dash={[4, 4]} listening={false} />
       )}
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BLOCK MARKER
//
// Visual: A rectangle of (width, height) with an 'X' drawn from corners.
// Properties: width, height, rotation.
// ─────────────────────────────────────────────────────────────────────────────

export function BlockMarker({ shape, commonProps: cp, isSelected }: {
  shape: ShapeData; commonProps: any; isSelected: boolean;
}) {
  const w = shape.width || 40;
  const h = shape.height || 40;
  const stroke = shape.strokeColor || '#000';
  const sw = shape.strokeWidth || 2;
  const fill = shape.fillColor && shape.fillColor !== 'transparent' ? shape.fillColor : 'transparent';

  return (
    <Group {...mkGrpProps(shape, cp)} x={shape.x} y={shape.y} rotation={shape.rotation || 0}>
      <Rect x={0} y={0} width={w} height={h} fill={fill} stroke={stroke} strokeWidth={sw} dash={shape.dash || undefined} listening={true} onClick={cp.onClick} onTap={cp.onTap} />
      <Line points={[0, 0, w, h]} stroke={stroke} strokeWidth={sw} dash={shape.dash || undefined} listening={false} />
      <Line points={[w, 0, 0, h]} stroke={stroke} strokeWidth={sw} dash={shape.dash || undefined} listening={false} />
      
      {isSelected && (
        <Rect x={0} y={0} width={w} height={h}
          fill="transparent" stroke="#4da6ff" strokeWidth={1} dash={[4, 4]} listening={false} />
      )}
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// W SECTION MARKER
//
// Visual: I-beam profile.
// Properties: width, height (depth), thickness.
// ─────────────────────────────────────────────────────────────────────────────

export function WSectionMarker({ shape, commonProps: cp, isSelected }: {
  shape: ShapeData; commonProps: any; isSelected: boolean;
}) {
  const w = Math.max(1, shape.width || 40);
  const d = Math.max(1, shape.height || 40);
  const tStr = shape.markerData?.thickness;
  const t = Math.max(1, Math.min(w/2, d/2, tStr ? parseFloat(tStr) : 5));

  const stroke = shape.strokeColor || '#000';
  const sw = shape.strokeWidth || 2;
  const fill = shape.fillColor && shape.fillColor !== 'transparent' ? shape.fillColor : 'transparent';

  return (
    <Group {...mkGrpProps(shape, cp)} x={shape.x} y={shape.y} rotation={shape.rotation || 0}>
      {/* Hit area to ensure the entire bounding box is clickable/draggable */}
      <Rect x={0} y={0} width={w} height={d} fill="rgba(0,0,0,0)" listening={true} onClick={cp.onClick} onTap={cp.onTap} />
      
      <Shape sceneFunc={(ctx, shapeProps) => {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(w, 0);
        ctx.lineTo(w, t);
        ctx.lineTo((w + t) / 2, t);
        ctx.lineTo((w + t) / 2, d - t);
        ctx.lineTo(w, d - t);
        ctx.lineTo(w, d);
        ctx.lineTo(0, d);
        ctx.lineTo(0, d - t);
        ctx.lineTo((w - t) / 2, d - t);
        ctx.lineTo((w - t) / 2, t);
        ctx.lineTo(0, t);
        ctx.closePath();
        ctx.fillStrokeShape(shapeProps);
      }} fill={fill} stroke={stroke} strokeWidth={sw} dash={shape.dash || undefined} listening={true} onClick={cp.onClick} onTap={cp.onTap} />
      
      {isSelected && (
        <Rect x={-2} y={-2} width={w + 4} height={d + 4}
          fill="transparent" stroke="#4da6ff" strokeWidth={1} dash={[4, 4]} listening={false} />
      )}
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// INSULATION MARKER
//
// Visual: Architectural insulation batting line.
// Properties: thickness (overall width).
// ─────────────────────────────────────────────────────────────────────────────

export function InsulationMarker({ shape, commonProps: cp, isSelected }: {
  shape: ShapeData; commonProps: any; isSelected: boolean;
}) {
  const pts = shape.points || [0, 0, 200, 0];
  const dx = pts[2], dy = pts[3];
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = dx / len, ny = dy / len;
  const px = -ny, py = nx;

  const stroke = shape.strokeColor || '#000';
  const sw = shape.strokeWidth || 2;
  const thickStr = shape.markerData?.thickness;
  const W = Math.max(2, thickStr ? parseFloat(thickStr) : 20); // Overall batting width

  // Geometry parameters for the loop (half-period)
  // To create overlapping outward loops (standard batting), a_ctrl must be large.
  const L_step = W * 0.4; 
  const n = Math.max(1, Math.round(len / L_step));
  const actual_L_step = len / n;

  const A = W / 2; // Amplitude from center line

  return (
    <Group {...mkGrpProps(shape, cp)} x={shape.x} y={shape.y}>
      <Shape sceneFunc={(ctx, shapeProps) => {
        ctx.beginPath();
        ctx.moveTo(0, 0);

        for (let i = 0; i < n; i++) {
          const sign = i % 2 === 0 ? 1 : -1;
          const d0 = i * actual_L_step;
          const d3 = (i + 1) * actual_L_step;

          // Single mathematically pure bezier for a pinched bulbous teardrop (cursive 'e' loop)
          // C_bulge controls how far the loop sweeps out sideways to intersect its neighbors.
          const C_bulge = 1.25;
          const rot = (d: number, h: number) => ({
            x: d * nx + h * px,
            y: d * ny + h * py
          });

          const p1 = rot(d0 - C_bulge * actual_L_step, sign * A * 1.333);
          const p2 = rot(d3 + C_bulge * actual_L_step, sign * A * 1.333);
          const p3 = rot(d3, 0);

          ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
        }

        ctx.fillStrokeShape(shapeProps);
      }} stroke={stroke} strokeWidth={sw} lineJoin="round" lineCap="round" dash={shape.dash || undefined} listening={true} onClick={cp.onClick} onTap={cp.onTap} />

      {/* Transparent hit strip to make selection easier */}
      <Line points={[0, 0, dx, dy]}
        stroke="transparent" strokeWidth={Math.max(16 / (cp.currentScale || 1.0), sw * 4)} listening={true}
        onClick={cp.onClick} onTap={cp.onTap} />

      {isSelected && (
        <Line points={[0, 0, dx, dy]}
          stroke="#4da6ff" strokeWidth={1} dash={[5, 4]} opacity={0.7} listening={false} />
      )}
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// METAL DECK MARKER
//
// Visual: Repeating trapezoidal profile along a line.
// Properties: scale (controls height and pitch).
// ─────────────────────────────────────────────────────────────────────────────

export function MetalDeckMarker({ shape, commonProps: cp, isSelected }: {
  shape: ShapeData; commonProps: any; isSelected: boolean;
}) {
  const pts = shape.points || [0, 0, 200, 0];
  const dx = pts[2], dy = pts[3];
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = dx / len, ny = dy / len;
  const px = -ny, py = nx; // perpendicular

  const stroke = shape.strokeColor || '#000';
  const sw = shape.strokeWidth || 2;
  const H = parseFloat(shape.markerData?.scale || '20'); // Height
  const P = H * 2.5; // Pitch

  const n = Math.max(1, Math.floor(len / P));
  const actualP = len / n;

  return (
    <Group {...mkGrpProps(shape, cp)} x={shape.x} y={shape.y}>
      <Shape sceneFunc={(ctx, shapeProps) => {
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
        ctx.fillStrokeShape(shapeProps);
      }} stroke={stroke} strokeWidth={sw} lineJoin="round" lineCap="round" listening={true} onClick={cp.onClick} onTap={cp.onTap} />

      {/* Hit strip */}
      <Line points={[0, 0, dx, dy]}
        stroke="rgba(0,0,0,0)" strokeWidth={Math.max(16 / (cp.currentScale || 1.0), H)} listening={true}
        onClick={cp.onClick} onTap={cp.onTap} />

      {isSelected && (
        <Line points={[0, 0, dx, dy]}
          stroke="#4da6ff" strokeWidth={1} dash={[5, 4]} opacity={0.7} listening={false} />
      )}
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DOOR MARKER
//
// Visual: Architectural single door symbol (hinge, panel, swing arc).
// Properties: width (canonical door size), flipH, flipV.
// ─────────────────────────────────────────────────────────────────────────────

export function DoorMarker({ shape, commonProps: cp, isSelected }: {
  shape: ShapeData; commonProps: any; isSelected: boolean;
}) {
  const size = Math.max(10, shape.width || 40);
  
  const stroke = shape.strokeColor || '#000';
  const sw = shape.strokeWidth || 2;
  const flipH = shape.markerData?.flipH === 'true';
  const flipV = shape.markerData?.flipV === 'true';

  return (
    <Group {...mkGrpProps(shape, cp)} x={shape.x} y={shape.y} rotation={shape.rotation || 0} scaleX={flipH ? -1 : 1} scaleY={flipV ? -1 : 1}>
      <Rect x={0} y={-size} width={size} height={size} fill="transparent" listening={true} onClick={cp.onClick} onTap={cp.onTap} />
      <Line points={[0, 0, 0, -size]} stroke={stroke} strokeWidth={sw * 2.5} lineCap="square" listening={false} />
      <Shape
        sceneFunc={(ctx) => {
          ctx.beginPath();
          ctx.moveTo(0, -size);
          ctx.arc(0, 0, size, -Math.PI / 2, 0, false);
          ctx.strokeStyle = stroke;
          ctx.lineWidth = sw;
          ctx.stroke();
        }}
        listening={false}
      />
      <Line points={[0, 0, size, 0]} stroke={stroke} strokeWidth={sw * 0.5} dash={[4, 4]} listening={false} />
      {isSelected && (
        <Rect x={-5} y={-size-5} width={size + 10} height={size + 10}
          fill="transparent" stroke="#4da6ff" strokeWidth={1} dash={[4, 4]} listening={false} />
      )}
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DOUBLE DOOR MARKER
//
// Visual: Architectural double door symbol (two hinges at outer edges, meeting in center).
// Properties: width (total opening size), flipH, flipV.
// ─────────────────────────────────────────────────────────────────────────────

export function DoubleDoorMarker({ shape, commonProps: cp, isSelected }: {
  shape: ShapeData; commonProps: any; isSelected: boolean;
}) {
  const w = Math.max(20, shape.width || 80);
  const h = w / 2; // Each panel is half width
  
  const stroke = shape.strokeColor || '#000';
  const sw = shape.strokeWidth || 2;
  const flipH = shape.markerData?.flipH === 'true';
  const flipV = shape.markerData?.flipV === 'true';

  return (
    <Group {...mkGrpProps(shape, cp)} x={shape.x} y={shape.y} rotation={shape.rotation || 0} scaleX={flipH ? -1 : 1} scaleY={flipV ? -1 : 1}>
      <Rect x={0} y={-h} width={w} height={h} fill="transparent" listening={true} onClick={cp.onClick} onTap={cp.onTap} />
      
      {/* Left Door Panel */}
      <Line points={[0, 0, 0, -h]} stroke={stroke} strokeWidth={sw * 2.5} lineCap="square" listening={false} />
      {/* Left Swing Arc */}
      <Shape
        sceneFunc={(ctx) => {
          ctx.beginPath();
          ctx.moveTo(0, -h);
          ctx.arc(0, 0, h, -Math.PI / 2, 0, false);
          ctx.strokeStyle = stroke;
          ctx.lineWidth = sw;
          ctx.stroke();
        }}
        listening={false}
      />

      {/* Right Door Panel */}
      <Line points={[w, 0, w, -h]} stroke={stroke} strokeWidth={sw * 2.5} lineCap="square" listening={false} />
      {/* Right Swing Arc */}
      <Shape
        sceneFunc={(ctx) => {
          ctx.beginPath();
          ctx.moveTo(w, -h);
          ctx.arc(w, 0, h, -Math.PI / 2, -Math.PI, true);
          ctx.strokeStyle = stroke;
          ctx.lineWidth = sw;
          ctx.stroke();
        }}
        listening={false}
      />

      {/* Threshold indicator (dashed line) */}
      <Line points={[0, 0, w, 0]} stroke={stroke} strokeWidth={sw * 0.5} dash={[4, 4]} listening={false} />

      {isSelected && (
        <Rect x={-5} y={-h-5} width={w + 10} height={h + 10}
          fill="transparent" stroke="#4da6ff" strokeWidth={1} dash={[4, 4]} listening={false} />
      )}
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BOLT MARKER
//
// Visual: A bolt/screw head with a tapered shaft and threads.
// Properties: width (head width), height (total depth). Head stays fixed size.
// ─────────────────────────────────────────────────────────────────────────────

export function BoltMarker({ shape, commonProps: cp, isSelected }: {
  shape: ShapeData; commonProps: any; isSelected: boolean;
}) {
  const w = Math.max(10, shape.width || 40);
  const h = Math.max(10, shape.height || 60);
  const stroke = shape.strokeColor || '#000';
  const sw = shape.strokeWidth || 2;

  const headW = w;
  const headH = 12; // Fixed head height
  const shaftTopW = w * 0.4;
  const shaftBottomY = h;
  
  return (
    <Group {...mkGrpProps(shape, cp)} x={shape.x} y={shape.y}>
      {/* Head */}
      <Path
        data={`M 0 ${headH} A ${headW / 2} ${headH} 0 0 1 ${headW} ${headH} Z`}
        stroke={stroke}
        strokeWidth={sw}
        fill="transparent"
      />
      {/* Slot in head */}
      <Line
        points={[headW / 2, 0, headW / 2, headH * 0.4]}
        stroke={stroke}
        strokeWidth={sw * 1.5}
      />
      
      {/* Shaft (tapered) */}
      <Line
        points={[
          (headW - shaftTopW) / 2, headH,
          headW / 2, shaftBottomY,
          (headW + shaftTopW) / 2, headH
        ]}
        stroke={stroke}
        strokeWidth={sw}
        closed={true}
        fill="transparent"
      />
      
      {/* Threads (diagonal lines) */}
      <Group>
        {Array.from({ length: Math.max(1, Math.floor((shaftBottomY - headH) / 6)) }).map((_, i) => {
          const y = headH + (i + 1) * 6;
          if (y > shaftBottomY - 4) return null;
          
          // Calculate shaft width at this y to keep threads inside the tapered shaft
          const progress = (y - headH) / (shaftBottomY - headH);
          const currentShaftHalfW = (shaftTopW / 2) * (1 - progress);
          
          return (
            <Line
              key={i}
              points={[
                headW / 2 - currentShaftHalfW, y - 2,
                headW / 2 + currentShaftHalfW, y + 2
              ]}
              stroke={stroke}
              strokeWidth={sw * 0.8}
            />
          );
        })}
      </Group>

      {isSelected && (
        <Rect x={-2} y={-2} width={w + 4} height={h + 4}
          fill="transparent" stroke="#4da6ff" strokeWidth={1} dash={[4, 4]} listening={false} />
      )}
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Type helpers
// ─────────────────────────────────────────────────────────────────────────────

export const MARK_TYPES = [
  'mark_section', 'mark_level', 'mark_grid', 'mark_elevation', 'mark_single_elevation', 'mark_hat_channel', 'mark_masonry_ties', 'mark_t_section', 'mark_cfmf_stud', 'mark_break_line', 'mark_callout', 'mark_block', 'mark_w_section', 'mark_insulation', 'mark_door', 'mark_double_door', 'mark_sealant', 'mark_angle', 'mark_bolt', 'mark_thermal_spacer', 'mark_metal_deck'
] as const;

export type MarkType = typeof MARK_TYPES[number];

export function isMarkType(t: string): t is MarkType {
  return (MARK_TYPES as readonly string[]).includes(t);
}

/** Uses 2-click line interaction — stores relative points [0,0,dx,dy]. */
export function isLineMark(t: string): boolean {
  return t === 'mark_section' || t === 'mark_level' || t === 'mark_grid' || t === 'mark_insulation' || t === 'mark_metal_deck';
}

/** Uses click-drag rect interaction — stores x/y/width/height. */
export function isBoxMark(t: string): boolean {
  return t === 'mark_elevation' || t === 'mark_single_elevation' || t === 'mark_hat_channel' || t === 'mark_masonry_ties' || t === 'mark_t_section' || t === 'mark_cfmf_stud' || t === 'mark_break_line' || t === 'mark_callout' || t === 'mark_block' || t === 'mark_w_section' || t === 'mark_door' || t === 'mark_double_door' || t === 'mark_sealant' || t === 'mark_angle' || t === 'mark_bolt' || t === 'mark_thermal_spacer';
}

export function getDefaultMarkSize(t: string): { width: number, height: number } {
  switch (t) {
    case 'mark_elevation': return { width: 80, height: 80 };
    case 'mark_single_elevation': return { width: 60, height: 80 };
    case 'mark_hat_channel': return { width: 100, height: 40 };
    case 'mark_masonry_ties': return { width: 120, height: 60 };
    case 'mark_t_section': return { width: 80, height: 60 };
    case 'mark_cfmf_stud': return { width: 120, height: 40 };
    case 'mark_break_line': return { width: 100, height: 20 };
    case 'mark_callout': return { width: 160, height: 120 };
    case 'mark_block': return { width: 40, height: 40 };
    case 'mark_w_section': return { width: 40, height: 40 };
    case 'mark_door': return { width: 40, height: 40 };
    case 'mark_double_door': return { width: 80, height: 40 };
    case 'mark_sealant': return { width: 40, height: 80 };
    case 'mark_angle': return { width: 80, height: 80 };
    case 'mark_bolt': return { width: 40, height: 80 };
    case 'mark_thermal_spacer': return { width: 40, height: 80 };
    case 'mark_metal_deck': return { width: 200, height: 20 };
    default: return { width: 80, height: 80 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MarksShapeRenderer — single dispatch used by DocumentViewer
// ─────────────────────────────────────────────────────────────────────────────

interface MarksShapeRendererProps {
  shape: ShapeData;
  commonProps: any;
  isSelected: boolean;
}

export function MarksShapeRenderer({ shape, commonProps, isSelected }: MarksShapeRendererProps) {
  switch (shape.type) {
    case 'mark_section':   return <SectionMarker   shape={shape} commonProps={commonProps} isSelected={isSelected} />;
    case 'mark_level':     return <LevelMarker     shape={shape} commonProps={commonProps} isSelected={isSelected} />;
    case 'mark_grid':      return <GridMarker      shape={shape} commonProps={commonProps} isSelected={isSelected} />;
    case 'mark_elevation': return <ElevationMarker shape={shape} commonProps={commonProps} isSelected={isSelected} />;
    case 'mark_single_elevation': return <SingleElevationMarker shape={shape} commonProps={commonProps} isSelected={isSelected} />;
    case 'mark_hat_channel': return <HatChannelMarker shape={shape} commonProps={commonProps} isSelected={isSelected} />;
    case 'mark_masonry_ties': return <MasonryTiesMarker shape={shape} commonProps={commonProps} isSelected={isSelected} />;
    case 'mark_t_section': return <TSectionMarker shape={shape} commonProps={commonProps} isSelected={isSelected} />;
    case 'mark_cfmf_stud': return <CFMFStudMarker shape={shape} commonProps={commonProps} isSelected={isSelected} />;
    case 'mark_break_line': return <BreakLineMarker shape={shape} commonProps={commonProps} isSelected={isSelected} />;
    case 'mark_callout':   return <CalloutMarker   shape={shape} commonProps={commonProps} isSelected={isSelected} />;
    case 'mark_block':     return <BlockMarker     shape={shape} commonProps={commonProps} isSelected={isSelected} />;
    case 'mark_w_section': return <WSectionMarker  shape={shape} commonProps={commonProps} isSelected={isSelected} />;
    case 'mark_insulation':return <InsulationMarker shape={shape} commonProps={commonProps} isSelected={isSelected} />;
    case 'mark_door':      return <DoorMarker       shape={shape} commonProps={commonProps} isSelected={isSelected} />;
    case 'mark_double_door':return <DoubleDoorMarker shape={shape} commonProps={commonProps} isSelected={isSelected} />;
    case 'mark_sealant':   return <SealantMarker     shape={shape} commonProps={commonProps} isSelected={isSelected} />;
    case 'mark_angle':     return <AngleMarker       shape={shape} commonProps={commonProps} isSelected={isSelected} />;
    case 'mark_bolt':      return <BoltMarker        shape={shape} commonProps={commonProps} isSelected={isSelected} />;
    case 'mark_thermal_spacer': return <ThermalSpacerMarker shape={shape} commonProps={commonProps} isSelected={isSelected} />;
    case 'mark_metal_deck': return <MetalDeckMarker     shape={shape} commonProps={commonProps} isSelected={isSelected} />;
    default:               return null;
  }
}
