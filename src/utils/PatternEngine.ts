export interface PatternInfo {
  id: string;
  name: string;
  type: 'DRAFTING' | 'MODEL';
}

type DrawFn = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

interface PatternDef {
  id: string;
  name: string;
  type: 'DRAFTING' | 'MODEL';
  width: number;
  height: number;
  draw: DrawFn;
}

const drawLine = (ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) => {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
};

const patterns: PatternDef[] = [
  {
    id: 'Aluminum',
    name: 'Aluminum (cut)',
    type: 'DRAFTING',
    width: 20, height: 20,
    draw: (ctx, w, h) => {
      drawLine(ctx, 0, h, w, 0);
      drawLine(ctx, -w, h, 0, 0);
      drawLine(ctx, w, h, w*2, 0);
    }
  },
  {
    id: 'Block 8x16',
    name: '8 x 16 blocks running bond',
    type: 'MODEL',
    width: 32, height: 16,
    draw: (ctx, w, h) => {
      // Horizontal lines
      drawLine(ctx, 0, 0, w, 0);
      drawLine(ctx, 0, h/2, w, h/2);
      // Vertical lines
      drawLine(ctx, 0, 0, 0, h/2);
      drawLine(ctx, w/2, h/2, w/2, h);
    }
  },
  {
    id: 'Block 8x8',
    name: '8 x 8 block running bond',
    type: 'MODEL',
    width: 16, height: 16,
    draw: (ctx, w, h) => {
      drawLine(ctx, 0, 0, w, 0);
      drawLine(ctx, 0, h/2, w, h/2);
      drawLine(ctx, 0, 0, 0, h/2);
      drawLine(ctx, w/2, h/2, w/2, h);
    }
  },
  {
    id: 'Brick',
    name: 'US Standard brick running bond',
    type: 'MODEL',
    width: 16, height: 5.33,
    draw: (ctx, w, h) => {
      drawLine(ctx, 0, 0, w, 0);
      drawLine(ctx, 0, h/2, w, h/2);
      drawLine(ctx, 0, 0, 0, h/2);
      drawLine(ctx, w/2, h/2, w/2, h);
    }
  },
  {
    id: 'Ceiling 24x24',
    name: '24 x 24 Tiles',
    type: 'MODEL',
    width: 24, height: 24,
    draw: (ctx, w, h) => {
      drawLine(ctx, 0, 0, w, 0);
      drawLine(ctx, 0, 0, 0, h);
    }
  },
  {
    id: 'Ceiling 24x48',
    name: '24 x 48 Tiles',
    type: 'MODEL',
    width: 48, height: 24,
    draw: (ctx, w, h) => {
      drawLine(ctx, 0, 0, w, 0);
      drawLine(ctx, 0, 0, 0, h);
    }
  },
  {
    id: 'Concrete',
    name: 'Cut concrete',
    type: 'DRAFTING',
    width: 40, height: 40,
    draw: (ctx, _w, _h) => {
      // Triangles and dots
      const drawTri = (x: number, y: number, r: number) => {
        ctx.beginPath();
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r, y + r/2);
        ctx.lineTo(x - r, y + r/2);
        ctx.closePath();
        ctx.stroke();
      };
      drawTri(10, 10, 3);
      drawTri(25, 30, 4);
      drawTri(35, 15, 2);
      
      ctx.beginPath(); ctx.arc(20, 20, 1, 0, Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.arc(5, 30, 0.5, 0, Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.arc(30, 5, 1.5, 0, Math.PI*2); ctx.fill();
    }
  },
  {
    id: 'Diagonal 3 lines',
    name: 'Diagonal 3 lines',
    type: 'DRAFTING',
    width: 30, height: 30,
    draw: (ctx, w, h) => {
      // Group of 3 diagonal lines, 45 deg, repeating
      const d = 3;
      const drawDiag = (ox: number) => {
        drawLine(ctx, ox, h, ox + w, 0);
        drawLine(ctx, ox - w, h, ox, 0);
        drawLine(ctx, ox + w, h, ox + w*2, 0);
      };
      drawDiag(0);
      drawDiag(d);
      drawDiag(d*2);
    }
  },
  {
    id: 'Earth',
    name: 'Earth',
    type: 'MODEL',
    width: 12, height: 12,
    draw: (ctx, w, h) => {
      // 6x6 squares alternating directions
      drawLine(ctx, 0, 0, w, 0);
      drawLine(ctx, 0, h/2, w, h/2);
      drawLine(ctx, 0, 0, 0, h);
      drawLine(ctx, w/2, 0, w/2, h);
      // Top-left: vertical lines
      drawLine(ctx, 2, 0, 2, 6);
      drawLine(ctx, 4, 0, 4, 6);
      // Bottom-right: vertical lines
      drawLine(ctx, 8, 6, 8, 12);
      drawLine(ctx, 10, 6, 10, 12);
      // Top-right: horizontal lines
      drawLine(ctx, 6, 2, 12, 2);
      drawLine(ctx, 6, 4, 12, 4);
      // Bottom-left: horizontal lines
      drawLine(ctx, 0, 8, 6, 8);
      drawLine(ctx, 0, 10, 6, 10);
    }
  },
  {
    id: 'Steel',
    name: 'Steel Cut',
    type: 'DRAFTING',
    width: 20, height: 20,
    draw: (ctx, w, h) => {
      const d = 4;
      drawLine(ctx, 0, h, w, 0);
      drawLine(ctx, d, h, w+d, 0);
      drawLine(ctx, -w, h, 0, 0);
      drawLine(ctx, -w+d, h, d, 0);
      drawLine(ctx, w, h, w*2, 0);
      drawLine(ctx, w+d, h, w*2+d, 0);
    }
  },
  {
    id: 'Sand',
    name: 'Random dot pattern',
    type: 'DRAFTING',
    width: 20, height: 20,
    draw: (ctx, w, h) => {
      for(let i=0; i<15; i++) {
        const x = Math.random() * w;
        const y = Math.random() * h;
        ctx.beginPath();
        ctx.arc(x, y, 0.5, 0, Math.PI*2);
        ctx.fill();
      }
    }
  },
  {
    id: 'Wood_1',
    name: 'Wood: Pattern 1',
    type: 'DRAFTING',
    width: 20, height: 20,
    draw: (ctx, w, _h) => {
      drawLine(ctx, 0, 0, w, 0);
      drawLine(ctx, 0, 5, w, 5);
      drawLine(ctx, 0, 10, w, 10);
      drawLine(ctx, 0, 15, w, 15);
    }
  },

  // ─── New patterns ─────────────────────────────────────────────────────

  {
    id: 'Cross Hatch',
    name: 'Perpendicular grid',
    type: 'DRAFTING',
    width: 15, height: 15,
    draw: (ctx, w, h) => {
      // Horizontal line at top edge
      drawLine(ctx, 0, 0, w, 0);
      // Vertical line at left edge
      drawLine(ctx, 0, 0, 0, h);
    }
  },
  {
    id: 'Horizontal Lines',
    name: 'Horizontal lines',
    type: 'DRAFTING',
    width: 20, height: 10,
    draw: (ctx, w, _h) => {
      drawLine(ctx, 0, 0, w, 0);
    }
  },
  {
    id: 'Vertical Lines',
    name: 'Vertical lines',
    type: 'DRAFTING',
    width: 10, height: 20,
    draw: (ctx, _w, h) => {
      drawLine(ctx, 0, 0, 0, h);
    }
  },
  {
    id: 'Herringbone',
    name: 'Herringbone zigzag',
    type: 'MODEL',
    width: 20, height: 10,
    draw: (ctx, w, h) => {
      // V-shape: left leg going up, right leg going down
      drawLine(ctx, 0, h, w / 2, 0);
      drawLine(ctx, w / 2, 0, w, h);
    }
  },
  {
    id: 'Insulation',
    name: 'Insulation batts (sine wave)',
    type: 'DRAFTING',
    width: 20, height: 10,
    draw: (ctx, w, h) => {
      // Approximate a sine wave with 16 line segments
      const segments = 16;
      const amplitude = h * 0.4;
      const cy = h / 2;
      ctx.beginPath();
      ctx.moveTo(0, cy);
      for (let i = 1; i <= segments; i++) {
        const x = (i / segments) * w;
        const y = cy + amplitude * Math.sin((i / segments) * Math.PI * 2);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  },
  {
    id: 'Triangles',
    name: 'Triangular grid (equilateral)',
    type: 'DRAFTING',
    width: 10, height: 17.32,
    draw: (ctx, w, h) => {
      const mid = h / 2;
      // Horizontal lines
      drawLine(ctx, 0, 0, w, 0);
      drawLine(ctx, 0, mid, w, mid);
      // 60° diagonals (main + wraps for seamless tiling)
      drawLine(ctx, 0, 0, w, h);
      drawLine(ctx, -w, 0, 0, h);
      drawLine(ctx, w, 0, w * 2, h);
      // 120° diagonals (main + wraps)
      drawLine(ctx, w, 0, 0, h);
      drawLine(ctx, w * 2, 0, w, h);
      drawLine(ctx, 0, 0, -w, h);
    }
  }
];

class Engine {
  public getPatternNames(): PatternInfo[] {
    return patterns.map(p => ({ id: p.id, name: p.name, type: p.type }));
  }

  private previewCache = new Map<string, string>();

  public getPatternPreview(patternId: string): string {
    if (this.previewCache.has(patternId)) return this.previewCache.get(patternId)!;
    const tileRes = this.createPatternTile(patternId, 2.0, '#ffffff', 1, 1);
    if (!tileRes) return '';
    const url = tileRes.canvas.toDataURL();
    this.previewCache.set(patternId, url);
    return url;
  }

  private shapeCache = new Map<string, HTMLCanvasElement>();

  public createPatternTile(patternId: string, scale: number, strokeColor: string, strokeWidth: number = 1, canvasScale: number = 1): { canvas: HTMLCanvasElement, fillScale: { x: number, y: number } } | null {
    const pat = patterns.find(p => p.id === patternId);
    if (!pat) return null;

    // K is an integer multiplier to guarantee perfectly integer canvas dimensions.
    // This avoids canvas size truncation which causes the pattern to drift across shape bounds.
    // We want the canvas size to roughly match (docScale * canvasScale), but strictly limit it to avoid crashes.
    const docScale = Math.max(0.0001, scale);
    const maxK = Math.max(1, Math.floor(2048 / Math.max(pat.width, pat.height)));
    const K = Math.min(maxK, Math.max(1, Math.ceil(docScale * canvasScale)));
    
    const key = `${patternId}-${docScale}-${strokeColor}-${K}-${strokeWidth}`;
    if (this.shapeCache.has(key)) return { canvas: this.shapeCache.get(key)!, fillScale: { x: docScale / K, y: docScale / K } };

    const canvas = document.createElement('canvas');
    // The canvas pixel size is EXACTLY (pattern width * K) which is purely integer
    canvas.width = pat.width * K;
    canvas.height = pat.height * K;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // Scale context so drawing matches pattern dimensions
    ctx.scale(K, K);
    
    ctx.strokeStyle = strokeColor;
    ctx.fillStyle = strokeColor;
    ctx.lineWidth = Math.max(0.01, strokeWidth / docScale); // Scale thickness correctly
    ctx.lineCap = 'square';
    ctx.lineJoin = 'miter';

    pat.draw(ctx, pat.width, pat.height);

    this.shapeCache.set(key, canvas);
    return { canvas, fillScale: { x: docScale / K, y: docScale / K } };
  }
}

export const PatternEngine = new Engine();
