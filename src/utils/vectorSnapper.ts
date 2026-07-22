const OPS = {
  save: 10,
  restore: 11,
  transform: 12,
  moveTo: 13,
  lineTo: 14,
  curveTo: 15,
  curveTo2: 16,
  curveTo3: 17,
  closePath: 18,
  rectangle: 19,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  constructPath: 91
};

export interface VectorPoint {
  x: number;
  y: number;
}

export interface VectorSegment {
  start: VectorPoint;
  end: VectorPoint;
  mid: VectorPoint;
}

/**
 * A fast, dependency-free grid-based spatial partition for line segments.
 * Reduces nearest-neighbor lookups from O(N) to O(1) in expected time.
 */
export class GridSpatialIndex {
  cellSize: number;
  cells: Map<string, number[]>;
  segments: VectorSegment[];

  constructor(segments: VectorSegment[], cellSize = 100) {
    this.cellSize = cellSize;
    this.cells = new Map();
    this.segments = segments;

    for (let idx = 0; idx < segments.length; idx++) {
      const seg = segments[idx];
      const minX = Math.min(seg.start.x, seg.end.x);
      const maxX = Math.max(seg.start.x, seg.end.x);
      const minY = Math.min(seg.start.y, seg.end.y);
      const maxY = Math.max(seg.start.y, seg.end.y);

      const colStart = Math.floor(minX / cellSize);
      const colEnd = Math.floor(maxX / cellSize);
      const rowStart = Math.floor(minY / cellSize);
      const rowEnd = Math.floor(maxY / cellSize);

      // Add to all cells intersecting the segment's bounding box
      for (let c = colStart; c <= colEnd; c++) {
        for (let r = rowStart; r <= rowEnd; r++) {
          const key = `${c},${r}`;
          let cell = this.cells.get(key);
          if (!cell) {
            cell = [];
            this.cells.set(key, cell);
          }
          cell.push(idx);
        }
      }
    }
  }

  /**
   * Returns all segments that lie within the query bounding box
   */
  query(x: number, y: number, radius: number): VectorSegment[] {
    const minX = x - radius;
    const maxX = x + radius;
    const minY = y - radius;
    const maxY = y + radius;

    const colStart = Math.floor(minX / this.cellSize);
    const colEnd = Math.floor(maxX / this.cellSize);
    const rowStart = Math.floor(minY / this.cellSize);
    const rowEnd = Math.floor(maxY / this.cellSize);

    const seenIndices = new Set<number>();
    const result: VectorSegment[] = [];

    for (let c = colStart; c <= colEnd; c++) {
      for (let r = rowStart; r <= rowEnd; r++) {
        const key = `${c},${r}`;
        const cell = this.cells.get(key);
        if (cell) {
          for (const idx of cell) {
            if (!seenIndices.has(idx)) {
              seenIndices.add(idx);
              result.push(this.segments[idx]);
            }
          }
        }
      }
    }
    return result;
  }
}

/**
 * 2D Affine Matrix multiplication: CTM' = CTM * T
 */
export function multiplyMatrices(m1: number[], m2: number[]): number[] {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,          // a
    b1 * a2 + d1 * b2,          // b
    a1 * c2 + c1 * d2,          // c
    b1 * c2 + d1 * d2,          // d
    a1 * e2 + c1 * f2 + e1,     // e
    b1 * e2 + d1 * f2 + f1      // f
  ];
}

/**
 * Projects point P perpendicularly onto line segment AB and returns the nearest point.
 */
export function getNearestPointOnSegment(p: VectorPoint, a: VectorPoint, b: VectorPoint) {
  const apX = p.x - a.x;
  const apY = p.y - a.y;
  const abX = b.x - a.x;
  const abY = b.y - a.y;
  const ab2 = abX * abX + abY * abY;
  
  if (ab2 === 0) {
    const dx = p.x - a.x;
    const dy = p.y - a.y;
    return { x: a.x, y: a.y, t: 0, dist: Math.sqrt(dx * dx + dy * dy) };
  }
  
  let t = (apX * abX + apY * abY) / ab2;
  t = Math.max(0, Math.min(1, t));
  const nearestX = a.x + t * abX;
  const nearestY = a.y + t * abY;
  const dx = p.x - nearestX;
  const dy = p.y - nearestY;
  
  return {
    x: nearestX,
    y: nearestY,
    t,
    dist: Math.sqrt(dx * dx + dy * dy),
  };
}

/**
 * Parses the PDF.js page operator list and extracts vector line segments.
 */
export function extractVectorsFromOps(opList: { fnArray: number[]; argsArray: any[] }): VectorSegment[] {
  const fnArray = opList.fnArray;
  const argsArray = opList.argsArray;

  const segments: VectorSegment[] = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const ctmStack: number[][] = [];

  let currentPoint: VectorPoint | null = null;
  let subpathStart: VectorPoint | null = null;

  const transformPoint = (x: number, y: number, m: number[]): VectorPoint => {
    return {
      x: m[0] * x + m[2] * y + m[4],
      y: m[1] * x + m[3] * y + m[5]
    };
  };

  const addLineSegment = (p1: VectorPoint, p2: VectorPoint) => {
    // Skip zero-length or degenerate segments
    if (p1.x === p2.x && p1.y === p2.y) return;
    if (isNaN(p1.x) || isNaN(p1.y) || isNaN(p2.x) || isNaN(p2.y)) return;
    
    segments.push({
      start: p1,
      end: p2,
      mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
    });
  };

  // Approximate a cubic Bézier curve using 4 linear segments
  const addBezierCurve = (p0: VectorPoint, p1: VectorPoint, p2: VectorPoint, p3: VectorPoint) => {
    const steps = 4;
    let prev = p0;
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const mt = 1 - t;
      
      const x = mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x;
      const y = mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y;
      
      const next = { x, y };
      addLineSegment(prev, next);
      prev = next;
    }
  };

  // Approximate a quadratic Bézier curve using 4 linear segments
  const addQuadraticCurve = (p0: VectorPoint, p1: VectorPoint, p2: VectorPoint) => {
    const steps = 4;
    let prev = p0;
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const mt = 1 - t;
      
      const x = mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x;
      const y = mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y;
      
      const next = { x, y };
      addLineSegment(prev, next);
      prev = next;
    }
  };

  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i];
    const args = argsArray[i];

    if (op === OPS.save) {
      ctmStack.push([...ctm]);
    } else if (op === OPS.restore) {
      if (ctmStack.length > 0) {
        ctm = ctmStack.pop()!;
      }
    } else if (op === OPS.transform) {
      ctm = multiplyMatrices(ctm, args);
    } else if (op === OPS.paintFormXObjectBegin) {
      ctmStack.push([...ctm]);
      const matrix = args[0];
      if (Array.isArray(matrix) && matrix.length === 6) {
        ctm = multiplyMatrices(ctm, matrix);
      }
    } else if (op === OPS.paintFormXObjectEnd) {
      if (ctmStack.length > 0) {
        ctm = ctmStack.pop()!;
      }
    } else if (op === OPS.moveTo) {
      currentPoint = transformPoint(args[0], args[1], ctm);
      subpathStart = currentPoint;
    } else if (op === OPS.lineTo) {
      if (currentPoint) {
        const nextPoint = transformPoint(args[0], args[1], ctm);
        addLineSegment(currentPoint, nextPoint);
        currentPoint = nextPoint;
      } else {
        currentPoint = transformPoint(args[0], args[1], ctm);
        subpathStart = currentPoint;
      }
    } else if (op === OPS.rectangle) {
      const x = args[0];
      const y = args[1];
      const w = args[2];
      const h = args[3];
      const p0 = transformPoint(x, y, ctm);
      const p1 = transformPoint(x + w, y, ctm);
      const p2 = transformPoint(x + w, y + h, ctm);
      const p3 = transformPoint(x, y + h, ctm);
      
      addLineSegment(p0, p1);
      addLineSegment(p1, p2);
      addLineSegment(p2, p3);
      addLineSegment(p3, p0);
      
      currentPoint = p0;
      subpathStart = p0;
    } else if (op === OPS.closePath) {
      if (currentPoint && subpathStart) {
        addLineSegment(currentPoint, subpathStart);
        currentPoint = subpathStart;
      }
    } else if (op === OPS.curveTo) {
      if (currentPoint) {
        const p1 = transformPoint(args[0], args[1], ctm);
        const p2 = transformPoint(args[2], args[3], ctm);
        const p3 = transformPoint(args[4], args[5], ctm);
        addBezierCurve(currentPoint, p1, p2, p3);
        currentPoint = p3;
      }
    } else if (op === OPS.curveTo2) {
      if (currentPoint) {
        const p1 = currentPoint;
        const p2 = transformPoint(args[0], args[1], ctm);
        const p3 = transformPoint(args[2], args[3], ctm);
        addBezierCurve(currentPoint, p1, p2, p3);
        currentPoint = p3;
      }
    } else if (op === OPS.curveTo3) {
      if (currentPoint) {
        const p1 = transformPoint(args[0], args[1], ctm);
        const p3 = transformPoint(args[2], args[3], ctm);
        const p2 = p3;
        addBezierCurve(currentPoint, p1, p2, p3);
        currentPoint = p3;
      }
    } else if (op === OPS.constructPath) {
      const buffers = args[1];
      if (Array.isArray(buffers)) {
        for (const buffer of buffers) {
          if (!buffer || !(buffer instanceof Float32Array || Array.isArray(buffer))) continue;
          let k = 0;
          while (k < buffer.length) {
            const drawOp = buffer[k++];
            if (drawOp === 0) { // moveTo
              if (k + 2 > buffer.length) break;
              const x = buffer[k++];
              const y = buffer[k++];
              currentPoint = transformPoint(x, y, ctm);
              subpathStart = currentPoint;
            } else if (drawOp === 1) { // lineTo
              if (k + 2 > buffer.length) break;
              const x = buffer[k++];
              const y = buffer[k++];
              if (currentPoint) {
                const nextPoint = transformPoint(x, y, ctm);
                addLineSegment(currentPoint, nextPoint);
                currentPoint = nextPoint;
              } else {
                currentPoint = transformPoint(x, y, ctm);
                subpathStart = currentPoint;
              }
            } else if (drawOp === 2) { // curveTo (cubic Bezier)
              if (k + 6 > buffer.length) break;
              const cp1x = buffer[k++];
              const cp1y = buffer[k++];
              const cp2x = buffer[k++];
              const cp2y = buffer[k++];
              const x = buffer[k++];
              const y = buffer[k++];
              if (currentPoint) {
                const p1 = transformPoint(cp1x, cp1y, ctm);
                const p2 = transformPoint(cp2x, cp2y, ctm);
                const p3 = transformPoint(x, y, ctm);
                addBezierCurve(currentPoint, p1, p2, p3);
                currentPoint = p3;
              }
            } else if (drawOp === 3) { // quadraticCurveTo
              if (k + 4 > buffer.length) break;
              const cpx = buffer[k++];
              const cpy = buffer[k++];
              const x = buffer[k++];
              const y = buffer[k++];
              if (currentPoint) {
                const p1 = transformPoint(cpx, cpy, ctm);
                const p2 = transformPoint(x, y, ctm);
                addQuadraticCurve(currentPoint, p1, p2);
                currentPoint = p2;
              }
            } else if (drawOp === 4) { // closePath
              if (currentPoint && subpathStart) {
                addLineSegment(currentPoint, subpathStart);
                currentPoint = subpathStart;
              }
            }
          }
        }
      }
    }
  }

  return segments;
}
