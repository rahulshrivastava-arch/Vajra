import { PDFDocument, rgb, cmyk, StandardFonts, degrees, pushGraphicsState, popGraphicsState, setLineCap, setLineJoin, LineCapStyle, LineJoinStyle, concatTransformationMatrix } from 'pdf-lib';
import { useStore, type ShapeData, type MasterPage } from '../store/useStore';
import { getSpreads } from './spreadLayout';
import { renderShapesOnCanvas } from './canvasRenderer';
import { evaluateSmartText } from './smartText';
import { wrapTextCanvas, measureTextCanvas, ensureFontsLoaded } from './textLayout';
import * as pdfjsLib from 'pdfjs-dist';

declare const Buffer: any;

export function uint8ArrayToBase64(arr: Uint8Array): string {
  let binary = '';
  const len = arr.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return window.btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export function serializeMasterPages(masterPages: MasterPage[]): any[] {
  return masterPages.map(m => {
    const copy = { ...m };
    if (m.backgroundPdfBytes) {
      (copy as any).backgroundPdfBytesBase64 = uint8ArrayToBase64(m.backgroundPdfBytes);
      copy.backgroundPdfBytes = null;
    }
    return copy;
  });
}

export function deserializeMasterPages(serialized: any[]): MasterPage[] {
  return serialized.map(m => {
    const backgroundPdfBytes = m.backgroundPdfBytesBase64
      ? base64ToUint8Array(m.backgroundPdfBytesBase64)
      : null;
    const copy = { ...m, backgroundPdfBytes };
    delete (copy as any).backgroundPdfBytesBase64;
    return copy;
  });
}

import { isLineMark } from '../components/MarksRenderer';

export function duplicateSpreadCrossingShapes(
  shapes: ShapeData[],
  isSpread: boolean,
  hasCoverPage: boolean,
  numPages: number,
  originalPages: any[]
): ShapeData[] {
  if (!isSpread) return shapes;

  const state = useStore.getState();
  const targetTabId = state.activeTabId;
  const doc = targetTabId ? state.documents[targetTabId] : null;
  const hasBackCover = doc?.hasBackCover || false;
  const activeSpreads = getSpreads(numPages, hasCoverPage, hasBackCover);

  const result = [...shapes];
  const getPageWidth = (pNum: number) => {
    if (pNum >= 1 && pNum <= originalPages.length) {
      return originalPages[pNum - 1].getSize().width;
    }
    return 612;
  };

  shapes.forEach(shape => {
    const pageNum = shape.page;
    if (pageNum < 1 || pageNum > numPages) return;

    const spread = activeSpreads.find(s => s.pages.includes(pageNum));
    if (!spread || spread.pages.length < 2) return;

    const leftPageNum = spread.pages[0];
    const rightPageNum = spread.pages[1];
    const isLeft = pageNum === leftPageNum;

    if (isLeft) {
      const pW = getPageWidth(pageNum);
      let crosses = false;

      if (['rect', 'circle', 'image', 'stamp', 'text', 'content_box', 'table'].includes(shape.type) || shape.width !== undefined) {
        const rightEdge = shape.x + (shape.width || 0);
        if (rightEdge > pW) crosses = true;
      } else if (shape.points) {
        if (isLineMark(shape.type)) {
          crosses = shape.points.some((val, idx) => idx % 2 === 0 && (shape.x + val) > pW);
        } else {
          crosses = shape.points.some((val, idx) => idx % 2 === 0 && val > pW);
        }
      }

      if (crosses) {
        const copy = JSON.parse(JSON.stringify(shape));
        copy.id = `${shape.id}-dup-right`;
        copy.page = rightPageNum;
        copy.x = shape.x - pW;
        if (copy.points && !isLineMark(shape.type)) {
          copy.points = copy.points.map((pt: number, idx: number) => idx % 2 === 0 ? pt - pW : pt);
        }
        result.push(copy);
      }
    } else {
      const leftPageWidth = getPageWidth(leftPageNum);
      let crosses = false;

      if (['rect', 'circle', 'image', 'stamp', 'text', 'content_box', 'table'].includes(shape.type) || shape.width !== undefined) {
        if (shape.x < 0) crosses = true;
      } else if (shape.points) {
        if (isLineMark(shape.type)) {
          crosses = shape.points.some((val, idx) => idx % 2 === 0 && (shape.x + val) < 0);
        } else {
          crosses = shape.points.some((val, idx) => idx % 2 === 0 && val < 0);
        }
      }

      if (crosses) {
        const copy = JSON.parse(JSON.stringify(shape));
        copy.id = `${shape.id}-dup-left`;
        copy.page = leftPageNum;
        copy.x = shape.x + leftPageWidth;
        if (copy.points && !isLineMark(shape.type)) {
          copy.points = copy.points.map((pt: number, idx: number) => idx % 2 === 0 ? pt + leftPageWidth : pt);
        }
        result.push(copy);
      }
    }
  });

  return result;
}

export function ensurePageContents(pdfDoc: PDFDocument) {
  const pages = pdfDoc.getPages();
  for (const page of pages) {
    if (!page.node.Contents()) {
      page.drawText('');
    }
  }
}

export async function createSpreadPdfBackground(originalPdfDoc: PDFDocument, isSpread: boolean, hasCoverPage: boolean): Promise<PDFDocument> {
  ensurePageContents(originalPdfDoc);
  const newPdfDoc = await PDFDocument.create();
  const pages = originalPdfDoc.getPages();
  const numPages = pages.length;

  if (!isSpread) {
    const indices = Array.from({ length: numPages }, (_, i) => i);
    const copiedPages = await newPdfDoc.copyPages(originalPdfDoc, indices);
    copiedPages.forEach(p => newPdfDoc.addPage(p));
    return newPdfDoc;
  }

  const state = useStore.getState();
  const targetTabId = state.activeTabId;
  const doc = targetTabId ? state.documents[targetTabId] : null;
  const hasBackCover = doc?.hasBackCover || false;
  const activeSpreads = getSpreads(numPages, hasCoverPage, hasBackCover);

  const spreads: { left: number; right: number }[] = activeSpreads.map(s => ({
    left: s.pages[0] - 1,
    right: s.pages.length > 1 ? s.pages[1] - 1 : -1
  }));

  for (const spread of spreads) {
    if (spread.right === -1) {
      const [copiedPage] = await newPdfDoc.copyPages(originalPdfDoc, [spread.left]);
      newPdfDoc.addPage(copiedPage);
    } else {
      const leftPageOriginal = pages[spread.left];
      const leftSize = leftPageOriginal.getSize();
      const rightPageOriginal = pages[spread.right];
      const rightSize = rightPageOriginal.getSize();

      const newWidth = leftSize.width + rightSize.width;
      const newHeight = Math.max(leftSize.height, rightSize.height);

      const newPage = newPdfDoc.addPage([newWidth, newHeight]);

      const [embeddedLeft] = await newPdfDoc.embedPdf(originalPdfDoc, [spread.left]);
      const [embeddedRight] = await newPdfDoc.embedPdf(originalPdfDoc, [spread.right]);

      const leftY = newHeight - leftSize.height;
      const rightY = newHeight - rightSize.height;

      newPage.drawPage(embeddedLeft, {
        x: 0,
        y: leftY,
        width: leftSize.width,
        height: leftSize.height,
      });

      newPage.drawPage(embeddedRight, {
        x: leftSize.width,
        y: rightY,
        width: rightSize.width,
        height: rightSize.height,
      });
    }
  }

  return newPdfDoc;
}


export async function flattenPdf(
  originalPdfBytes: Uint8Array,
  shapes: ShapeData[],
  editable: boolean = true,
  isSpreadSave: boolean = false,
  tabId?: string,
  onProgress?: (progress: number) => void
): Promise<Uint8Array> {
  const yieldToUI = () => new Promise(resolve => setTimeout(resolve, 0));
  if (onProgress) onProgress(2);
  const originalPdfDoc = await PDFDocument.load(originalPdfBytes);
  const originalPages = originalPdfDoc.getPages();
  const numPages = originalPages.length;

  const state = useStore.getState();
  const targetTabId = tabId || state.activeTabId;
  const doc = targetTabId ? state.documents[targetTabId] : null;
  const meta = targetTabId ? state.tabMetas[targetTabId] : null;
  const docTitle = meta?.label || 'Untitled';
  const isSpread = doc?.isSpread || false;
  const hasCoverPage = doc?.hasFrontCover || false;
  const bleedOffset = (doc?.bleedOffset ?? 0) * 72; // Convert bleed in inches to points
  const colorSpaceMode = doc?.colorSpaceMode ?? 'srgb';

  // Pre-resolve smart text variables for document shapes
  const resolvedDocShapes = shapes.map(s => {
    if (s.text) {
      return {
        ...s,
        text: evaluateSmartText(s.text, {
          pageNum: s.page,
          totalPages: numPages,
          date: new Date().toLocaleDateString(),
          docTitle
        })
      };
    }
    return s;
  });

  // 1. Bake Master PDF backgrounds into the original single pages
  if (doc) {
    const assignments = doc.masterPageAssignments || {};
    const docMasterPages = doc.masterPages || state.masterPages || [];
    for (let p = 1; p <= numPages; p++) {
      const masterId = assignments[p];
      const master = masterId ? docMasterPages.find((m: any) => m.id === masterId) : null;
      if (master && master.backgroundPdfBytes) {
        try {
          const masterDoc = await PDFDocument.load(master.backgroundPdfBytes);
          ensurePageContents(masterDoc);
          const bgPageNum = Math.max(1, Math.min(master.backgroundPageNum, masterDoc.getPageCount()));
          const [embeddedBgPage] = await originalPdfDoc.embedPdf(masterDoc, [bgPageNum - 1]);
          const page = originalPages[p - 1];
          const { width: pW, height: pH } = page.getSize();
          const offsetX = (pW - master.pageWidth) / 2;
          const offsetY = (pH - master.pageHeight) / 2;
          page.drawPage(embeddedBgPage, {
            x: offsetX,
            y: offsetY,
            width: master.pageWidth,
            height: master.pageHeight,
          });
        } catch (e) {
          console.error("Failed to bake master background PDF:", e);
        }
      }
      if (onProgress) onProgress(Math.round(5 + (p / numPages) * 15));
      await yieldToUI();
    }
  }

  // 2. Perform page merging if Spread Save
  let activePdfDoc = originalPdfDoc;
  if (isSpread && isSpreadSave) {
    activePdfDoc = await createSpreadPdfBackground(originalPdfDoc, true, hasCoverPage);
  }

  const pages = activePdfDoc.getPages();
  const font = await activePdfDoc.embedFont(StandardFonts.Helvetica);

  // 3. Preprocess shapes depending on Spread Save vs Single Page Save
  let docShapesToDraw = [...resolvedDocShapes];
  if (isSpread) {
    if (isSpreadSave) {
      // Map shapes to spread pages
      const hasBackCover = doc?.hasBackCover || false;
      const activeSpreads = getSpreads(numPages, hasCoverPage, hasBackCover);
      const getPageWidth = (pNum: number) => {
        if (pNum >= 1 && pNum <= originalPages.length) {
          return originalPages[pNum - 1].getSize().width;
        }
        return 612;
      };
      docShapesToDraw = docShapesToDraw.map(s => {
        const pNum = s.page;
        let newPageNum = pNum;
        let newX = s.x;
        let newPoints = s.points;

        const spread = activeSpreads.find(sp => sp.pages.includes(pNum));
        if (spread) {
          newPageNum = spread.index + 1;
          const isLeft = spread.pages.length < 2 || spread.pages[0] === pNum;
          if (!isLeft) {
            const leftPageNum = spread.pages[0];
            const leftPageWidth = getPageWidth(leftPageNum);
            newX = s.x + leftPageWidth;
            if (s.points && !isLineMark(s.type)) {
              newPoints = s.points.map((pt, idx) => idx % 2 === 0 ? pt + leftPageWidth : pt);
            }
          }
        }
        return { ...s, page: newPageNum, x: newX, points: newPoints };
      });
    } else {
      // Single page save: duplicate crossing shapes
      docShapesToDraw = duplicateSpreadCrossingShapes(docShapesToDraw, isSpread, hasCoverPage, numPages, originalPages);
    }
  }

  // 4. Inject metadata for round-trip editability
  if (editable) {
    try {
      const payload = JSON.stringify({
        version: 2,
        shapes: isSpreadSave ? shapes : docShapesToDraw, // Save the original shapes if spread save, otherwise the duplicated ones
        spreadConfig: {
          isSpread: isSpread && isSpreadSave,
          hasFrontCover: hasCoverPage && isSpreadSave,
          hasBackCover: (doc?.hasBackCover || false) && isSpreadSave,
        },
        masterPages: doc?.masterPages ? serializeMasterPages(doc.masterPages) : [],
        masterPageAssignments: doc?.masterPageAssignments || {},
        bleedConfig: {
          bleedOffset: doc?.bleedOffset ?? 0,
          showBleedGuides: doc?.showBleedGuides ?? true,
          colorSpaceMode: doc?.colorSpaceMode ?? 'srgb',
        },
        guides: doc?.guides || [],
      });
      activePdfDoc.setSubject(`LAYERS_MARKUP_DATA:${payload}`);
      activePdfDoc.setCreator('Layers App');
      
      // Embed the pristine original background to prevent double-ghosting on reload
      const pristineBytes = originalPdfBytes;

      await activePdfDoc.attach(pristineBytes, 'LayersPristine.pdf', {
        mimeType: 'application/pdf',
        description: 'Pristine Background',
        creationDate: new Date(),
        modificationDate: new Date()
      });
    } catch(e) {
      console.error("Failed to inject metadata & attachments:", e);
    }
  }

  const nativeRatio = 1.0;

  // Pre-load Inter so wrapTextCanvas() uses accurate glyph widths.
  // This must happen before any drawWrappedText() call in the rendering loop.
  const allFontSizes = [...new Set(
    shapes.map(s => s.fontSize || (['text', 'callout', 'arrow'].includes(s.type) ? 16 : 12)).filter(Boolean)
  )];
  await ensureFontsLoaded(allFontSizes.length ? allFontSizes : [12, 16], 'Inter');
  if (onProgress) onProgress(22);
  await yieldToUI();

  // 5. Merge master shapes into mergedShapes (relative to original page numbering)
  let mergedShapes: ShapeData[] = [];
  if (doc) {
    const assignments = doc.masterPageAssignments || {};
    const docMasterPages = doc.masterPages || state.masterPages || [];
    const hasBackCover = doc.hasBackCover || false;
    const activeSpreads = getSpreads(numPages, hasCoverPage, hasBackCover);
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const masterId = assignments[pageNum];
      const master = masterId ? docMasterPages.find(m => m.id === masterId) : null;
      if (master) {
        const page = originalPages[pageNum - 1];
        const { width: pW, height: pH } = page.getSize();
        const offsetX = (pW - master.pageWidth) / 2;
        const offsetY = (pH - master.pageHeight) / 2;

        let isLeft = true;
        if (isSpread) {
          const spread = activeSpreads.find(s => s.pages.includes(pageNum));
          if (spread && spread.pages.length > 1) {
            isLeft = (spread.pages[0] === pageNum);
          }
        }

        master.shapes.forEach(shape => {
          let shouldRender = false;
          let netShift = offsetX;

          if (master.isSpread) {
            if (isLeft) {
              if (shape.x < master.pageWidth) {
                shouldRender = true;
                netShift = offsetX;
              }
            } else {
              if (shape.x >= master.pageWidth) {
                shouldRender = true;
                netShift = offsetX - master.pageWidth;
              }
            }
          } else {
            shouldRender = true;
            netShift = offsetX;
          }

          if (shouldRender) {
            const resolvedText = shape.text ? evaluateSmartText(shape.text, {
              pageNum: pageNum,
              totalPages: numPages,
              date: new Date().toLocaleDateString(),
              docTitle
            }) : '';

            mergedShapes.push({
              ...shape,
              text: resolvedText,
              page: pageNum,
              x: shape.x + netShift,
              y: shape.y + offsetY,
              points: shape.points ? (
                isLineMark(shape.type)
                  ? shape.points
                  : shape.points.map((pt: number, idx: number) => idx % 2 === 0 ? pt + netShift : pt + offsetY)
              ) : undefined
            });
          }
        });
      }
    }
  }

  // If Spread Save, map the master shapes to the merged pages as well!
  if (isSpread && isSpreadSave) {
    const hasBackCover = doc?.hasBackCover || false;
    const activeSpreads = getSpreads(numPages, hasCoverPage, hasBackCover);
    const getPageWidth = (pNum: number) => {
      if (pNum >= 1 && pNum <= originalPages.length) {
        return originalPages[pNum - 1].getSize().width;
      }
      return 612;
    };
    mergedShapes = mergedShapes.map(s => {
      const pNum = s.page;
      let newPageNum = pNum;
      let newX = s.x;
      let newPoints = s.points;

      const spread = activeSpreads.find(sp => sp.pages.includes(pNum));
      if (spread) {
        newPageNum = spread.index + 1;
        const isLeft = spread.pages.length < 2 || spread.pages[0] === pNum;
        if (!isLeft) {
          const leftPageNum = spread.pages[0];
          const leftPageWidth = getPageWidth(leftPageNum);
          newX = s.x + leftPageWidth;
          if (s.points && !isLineMark(s.type)) {
            newPoints = s.points.map((pt, idx) => idx % 2 === 0 ? pt + leftPageWidth : pt);
          }
        }
      }
      return { ...s, page: newPageNum, x: newX, points: newPoints };
    });
  } else if (isSpread && !isSpreadSave) {
    // Duplicate crossing master shapes for single-page export
    mergedShapes = duplicateSpreadCrossingShapes(mergedShapes, isSpread, hasCoverPage, numPages, originalPages);
  }

  const shapesToDraw = [...mergedShapes, ...docShapesToDraw];

  for (let pageNum = 1; pageNum <= pages.length; pageNum++) {
    const page = pages[pageNum - 1];
    (page as any).getContentStream(false);
    const { width: pW, height: pH } = page.getSize();
    const pageShapes = shapesToDraw.filter(s => s.page === pageNum);


    
    // Convert all shapes to native coordinates first
    const scaledShapes = pageShapes.map(rawShape => {
        const shape = { ...rawShape };
        shape.x *= nativeRatio;
        shape.y *= nativeRatio;
        if (typeof shape.width === 'number') shape.width *= nativeRatio;
        if (typeof shape.height === 'number') shape.height *= nativeRatio;
        if (typeof shape.radius === 'number') shape.radius *= nativeRatio;
        
        // Provide type-specific defaults for strokeWidth if undefined/null
        if (typeof shape.strokeWidth === 'number') {
          shape.strokeWidth *= nativeRatio;
        } else {
          const defaultSw = shape.type === 'highlight' ? 20 : (shape.type === 'cloud' ? 2 : 1);
          shape.strokeWidth = defaultSw * nativeRatio;
        }
        
        if (typeof shape.fontSize === 'number') shape.fontSize *= nativeRatio;
        if (shape.points) shape.points = shape.points.map(p => p * nativeRatio);
        return shape;
    });

    const netPadLeft = bleedOffset;
    const netPadRight = bleedOffset;
    const netPadBottom = bleedOffset;
    const netPadTop = bleedOffset;

    const newWidth = pW + netPadLeft + netPadRight;
    const newHeight = pH + netPadBottom + netPadTop;

    if (bleedOffset > 0) {
      page.setSize(newWidth, newHeight);
      page.setCropBox(0, 0, newWidth, newHeight);
      page.translateContent(netPadLeft, netPadBottom);
      page.resetPosition();
    }

    // Draw Crop Marks if bleed is enabled
    if (bleedOffset > 0) {
      const cropColor = colorSpaceMode === 'cmyk' ? cmyk(0, 0, 0, 1) : rgb(0, 0, 0);
      drawCropMarks(page, netPadLeft, netPadLeft + pW, netPadBottom, netPadBottom + pH, cropColor);
    }

    for (const shape of scaledShapes) {
      console.log("[pdfExporter] drawing shape:", shape.id, shape.type, "page:", pageNum);
      try {
        const stroke = colorToRgbAndAlpha(shape.strokeColor, colorSpaceMode) || { rgbColor: colorSpaceMode === 'cmyk' ? cmyk(0, 0, 0, 1) : rgb(0, 0, 0), alpha: 1 };
        const fill = colorToRgbAndAlpha(shape.fillColor, colorSpaceMode);
        
        // Map Konva coords (kx, ky) to PDF origin coords
        const pdfX = (kx: number) => netPadLeft + kx;
        const pdfY = (ky: number) => newHeight - netPadTop - ky;

        switch (shape.type) {
          case 'rect': {
            const hasPattern = !!(shape as any).fillPatternId;
            const R = shape.rotation || 0;
            const w = shape.width || 0;
            const h = shape.height || 0;

            if (R !== 0) {
              const theta = -R * Math.PI / 180;
              const cos = Math.cos(theta);
              const sin = Math.sin(theta);
              const pivotX = pdfX(shape.x);
              const pivotY = pdfY(shape.y);

              page.pushOperators(
                pushGraphicsState(),
                concatTransformationMatrix(cos, sin, -sin, cos, pivotX, pivotY)
              );
              page.drawRectangle({
                x: 0,
                y: -h,
                width: w,
                height: h,
                borderColor: stroke.rgbColor,
                borderWidth: shape.strokeWidth,
                borderOpacity: stroke.alpha,
                color: hasPattern ? undefined : fill?.rgbColor,
                opacity: hasPattern ? undefined : fill?.alpha,
              });
              page.pushOperators(popGraphicsState());
            } else {
              page.drawRectangle({
                x: pdfX(shape.x),
                y: pdfY(shape.y) - h,
                width: w,
                height: h,
                borderColor: stroke.rgbColor,
                borderWidth: shape.strokeWidth,
                borderOpacity: stroke.alpha,
                color: hasPattern ? undefined : fill?.rgbColor,
                opacity: hasPattern ? undefined : fill?.alpha,
              });
            }

            if (hasPattern) {
              drawHatchPattern(page, shape, pdfX, pdfY, stroke, nativeRatio, colorSpaceMode);
            }
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

            const R = shape.rotation || 0;
            const theta = -R * Math.PI / 180;
            const cos = Math.cos(theta);
            const sin = Math.sin(theta);
            const pivotX = pdfX(shape.x);
            const pivotY = pdfY(shape.y);

            page.pushOperators(
              pushGraphicsState(),
              concatTransformationMatrix(visualScaleX * cos, visualScaleX * sin, -visualScaleY * sin, visualScaleY * cos, pivotX, pivotY)
            );

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
                  const fillCol = colorToRgbAndAlpha(cellFill, colorSpaceMode);
                  if (fillCol) {
                    page.drawRectangle({
                      x: cx,
                      y: -cy - ch,
                      width: cw,
                      height: ch,
                      color: fillCol.rgbColor,
                      opacity: fillCol.alpha,
                    });
                  }
                }
              }
            }

            // 2. Draw cell texts
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
                  const cellFontSize = cell?.fontSize || shape.fontSize || 12;
                  const cellStrokeColor = cell?.strokeColor || shape.strokeColor || '#000';
                  const textCol = colorToRgbAndAlpha(cellStrokeColor, colorSpaceMode) || { rgbColor: rgb(0,0,0), alpha: 1 };
                  
                  const cellIsBold = cell?.isBold !== undefined ? cell.isBold : (shape.isBold || false);
                  const cellIsItalic = cell?.isItalic !== undefined ? cell.isItalic : (shape.isItalic || false);
                  let cellFont = font;
                  if (cellIsBold && cellIsItalic) {
                    try {
                      cellFont = await activePdfDoc.embedFont(StandardFonts.HelveticaBoldOblique);
                    } catch (e) {
                      console.error("Failed to embed HelveticaBoldOblique", e);
                    }
                  } else if (cellIsBold) {
                    try {
                      cellFont = await activePdfDoc.embedFont(StandardFonts.HelveticaBold);
                    } catch (e) {
                      console.error("Failed to embed HelveticaBold", e);
                    }
                  } else if (cellIsItalic) {
                    try {
                      cellFont = await activePdfDoc.embedFont(StandardFonts.HelveticaOblique);
                    } catch (e) {
                      console.error("Failed to embed HelveticaOblique", e);
                    }
                  }

                  drawWrappedText(page, text, {
                    x: cx,
                    y: cy,
                    width: cw,
                    height: ch,
                    fontSize: cellFontSize,
                    font: cellFont,
                    color: textCol.rgbColor,
                    opacity: textCol.alpha,
                    align: cell?.hAlign || 'left',
                    verticalAlign: cell?.vAlign === 'middle' ? 'middle' : 'top',
                    padding: 2,
                    fontFamily: cell?.fontFamily || shape.fontFamily || 'Inter',
                    pdfX: (lx) => lx,
                    pdfY: (ly) => -ly,
                  });
                }
              }
            }

            // 3. Draw grid lines
            page.pushOperators(
              setLineCap(LineCapStyle.Round),
              setLineJoin(LineJoinStyle.Round)
            );

            const gridColor = stroke.rgbColor;
            const gridOpacity = stroke.alpha;

            // Vertical lines
            for (let i = 0; i <= table.cols; i++) {
              const x = colPositions[i];
              const thickness = table.colLineThicknesses?.[i] ?? table.borderThickness ?? shape.strokeWidth ?? 1;
              page.drawLine({
                start: { x, y: 0 },
                end: { x, y: -tableHeight },
                color: gridColor,
                thickness: thickness,
                opacity: gridOpacity,
              });
            }

            // Horizontal lines
            for (let i = 0; i <= table.rows; i++) {
              const y = rowPositions[i];
              const thickness = table.rowLineThicknesses?.[i] ?? table.borderThickness ?? shape.strokeWidth ?? 1;
              page.drawLine({
                start: { x: 0, y: -y },
                end: { x: tableWidth, y: -y },
                color: gridColor,
                thickness: thickness,
                opacity: gridOpacity,
              });
            }

            page.pushOperators(popGraphicsState());
            break;
          }

          case 'circle': {
            const xRad = shape.width !== undefined ? shape.width / 2 : (shape.radius || 0);
            const yRad = shape.height !== undefined ? shape.height / 2 : (shape.radius || 0);
            const hasPattern = !!(shape as any).fillPatternId;
            page.drawEllipse({
              x: pdfX(shape.x),
              y: pdfY(shape.y),
              xScale: xRad,
              yScale: yRad,
              borderColor: stroke.rgbColor,
              borderWidth: shape.strokeWidth,
              borderOpacity: stroke.alpha,
              color: hasPattern ? undefined : fill?.rgbColor,
              opacity: hasPattern ? undefined : fill?.alpha,
              rotate: shape.rotation ? degrees(-shape.rotation) : undefined,
            });
            if (hasPattern) {
              drawHatchPattern(page, shape, pdfX, pdfY, stroke, nativeRatio, colorSpaceMode);
            }
            break;
          }

          case 'line':
            if (shape.points && shape.points.length >= 4) {
              const startX = pdfX(shape.points[0]), startY = pdfY(shape.points[1]);
              const endX = pdfX(shape.points[2]), endY = pdfY(shape.points[3]);
              page.drawLine({
                start: { x: startX, y: startY },
                end: { x: endX, y: endY },
                color: stroke.rgbColor,
                thickness: shape.strokeWidth,
                opacity: stroke.alpha,
                lineCap: LineCapStyle.Round,
              });
            }
            break;

          case 'measure_length':
            if (shape.points && shape.points.length >= 4) {
              const startX = pdfX(shape.points[0]), startY = pdfY(shape.points[1]);
              const endX = pdfX(shape.points[2]), endY = pdfY(shape.points[3]);
              
              // 1. Main Line
              page.drawLine({
                start: { x: startX, y: startY },
                end: { x: endX, y: endY },
                color: stroke.rgbColor,
                thickness: shape.strokeWidth,
                opacity: stroke.alpha,
                lineCap: LineCapStyle.Round,
              });

              // 2. Slash Ticks and Perpendicular Caps
              const dx = shape.points[2] - shape.points[0];
              const dy = shape.points[3] - shape.points[1];
              const angle = Math.atan2(dy, dx);
              const strokeW = shape.strokeWidth || 1;
              const tickLen = 8 * strokeW;
              const perpLen = 14 * strokeW;
              const tickAngle = angle + Math.PI / 4;
              const perpAngle = angle + Math.PI / 2;
              
              const drawMarkersPdf = (sx: number, sy: number) => {
                // Perpendicular end cap
                const px1 = sx - (perpLen / 2) * Math.cos(perpAngle);
                const py1 = sy - (perpLen / 2) * Math.sin(perpAngle);
                const px2 = sx + (perpLen / 2) * Math.cos(perpAngle);
                const py2 = sy + (perpLen / 2) * Math.sin(perpAngle);
                page.drawLine({
                  start: { x: pdfX(px1), y: pdfY(py1) },
                  end: { x: pdfX(px2), y: pdfY(py2) },
                  color: stroke.rgbColor,
                  thickness: strokeW,
                  opacity: stroke.alpha,
                  lineCap: LineCapStyle.Round,
                });

                // Diagonal tick
                const tx1 = sx - (tickLen / 2) * Math.cos(tickAngle);
                const ty1 = sy - (tickLen / 2) * Math.sin(tickAngle);
                const tx2 = sx + (tickLen / 2) * Math.cos(tickAngle);
                const ty2 = sy + (tickLen / 2) * Math.sin(tickAngle);
                page.drawLine({
                  start: { x: pdfX(tx1), y: pdfY(ty1) },
                  end: { x: pdfX(tx2), y: pdfY(ty2) },
                  color: stroke.rgbColor,
                  thickness: strokeW,
                  opacity: stroke.alpha,
                  lineCap: LineCapStyle.Round,
                });
              };
              drawMarkersPdf(shape.points[0], shape.points[1]);
              drawMarkersPdf(shape.points[2], shape.points[3]);

              // 3. Label Text
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
                lenStr = `${((rawPx / nativeRatio) * calibration).toFixed(2)}`;
              }

              if (lenStr) {
                const fontSize = 12;
                const textWidth = font.widthOfTextAtSize(lenStr, fontSize);
                const midX = shape.points[0] + dx / 2;
                const midY = shape.points[1] + dy / 2 - 10; // 10px above the line in screen coordinates

                page.drawText(lenStr, {
                  x: pdfX(midX) - textWidth / 2,
                  y: pdfY(midY),
                  size: fontSize,
                  font: font,
                  color: stroke.rgbColor,
                  opacity: stroke.alpha,
                });
              }
            }
            break;

          case 'arrow':
            if (shape.points && shape.points.length >= 4) {
              const startX = pdfX(shape.points[0]), startY = pdfY(shape.points[1]);
              const endX = pdfX(shape.points[2]), endY = pdfY(shape.points[3]);
              
              page.drawLine({
                start: { x: startX, y: startY },
                end: { x: endX, y: endY },
                color: stroke.rgbColor,
                thickness: shape.strokeWidth,
                opacity: stroke.alpha,
                lineCap: LineCapStyle.Round,
              });

              // Draw Arrowhead
              drawArrowHeadPdf(page, shape.points, shape, stroke, netPadLeft, newHeight - netPadTop);

              // Draw Arrow Label
              if (shape.text) {
                const isRight = shape.points[2] >= shape.points[0];
                const tW = shape.width || 150;
                const tH = shape.height || 40;
                const tx = isRight ? shape.points[0] - tW - 10 : shape.points[0] + 10;
                const ty = shape.points[1] - tH / 2;

                drawWrappedText(page, shape.text, {
                  x: tx,
                  y: ty,
                  width: tW,
                  height: tH,
                  fontSize: shape.fontSize || 16,
                  font: font,
                  color: stroke.rgbColor,
                  opacity: stroke.alpha,
                  align: isRight ? 'right' : 'left',
                  verticalAlign: 'middle',
                  padding: 0,
                  fontFamily: (shape as any).fontFamily || 'Inter',
                  pdfX,
                  pdfY,
                });
              }
            }
            break;

          case 'text':
            if (shape.text) {
              const tW = shape.width || 200;
              const tH = shape.height || 100;
              drawWrappedText(page, shape.text, {
                x: shape.x,
                y: shape.y,
                width: tW,
                height: tH,
                fontSize: shape.fontSize || 16,
                font: font,
                color: stroke.rgbColor,
                opacity: stroke.alpha,
                align: 'left',
                verticalAlign: 'top',
                padding: 5,
                fontFamily: (shape as any).fontFamily || 'Inter',
                pdfX,
                pdfY,
                rotation: shape.rotation,
              });
            }
            break;

          case 'stamp': {
            const w = shape.width || 0;
            const h = shape.height || 0;
            const strokeW = shape.strokeWidth || 1;
            const R = shape.rotation || 0;
            
            const r = 4 * nativeRatio;
            const path = `M ${r} 0 ` +
                         `L ${w - r} 0 ` +
                         `A ${r} ${r} 0 0 1 ${w} ${r} ` +
                         `L ${w} ${h - r} ` +
                         `A ${r} ${r} 0 0 1 ${w - r} ${h} ` +
                         `L ${r} ${h} ` +
                         `A ${r} ${r} 0 0 1 0 ${h - r} ` +
                         `L 0 ${r} ` +
                         `A ${r} ${r} 0 0 1 ${r} 0`;
            
            const pivotX = pdfX(shape.x);
            const pivotY = pdfY(shape.y);
            const theta = -R * Math.PI / 180;
            const cos = Math.cos(theta);
            const sin = Math.sin(theta);

            page.pushOperators(
              pushGraphicsState(),
              setLineCap(LineCapStyle.Round),
              setLineJoin(LineJoinStyle.Round),
              concatTransformationMatrix(cos, sin, -sin, cos, pivotX, pivotY)
            );
            
            page.drawSvgPath(path, {
              x: 0,
              y: 0,
              borderColor: stroke.rgbColor,
              borderWidth: strokeW,
              borderOpacity: stroke.alpha,
              color: rgb(1, 1, 1),
              opacity: 0.1,
              borderLineCap: LineCapStyle.Round,
            });

            const stampText = shape.stampText || '';
            const stampFontSize = Math.min(w / 5, 24 * nativeRatio);
            const textWidth = font.widthOfTextAtSize(stampText, stampFontSize);
            
            const tx = (w - textWidth) / 2;
            const ty = -(h / 2 + stampFontSize / 2 - stampFontSize * 0.15);

            page.drawText(stampText, {
              x: tx,
              y: ty,
              size: stampFontSize,
              font: font,
              color: stroke.rgbColor,
              opacity: stroke.alpha,
            });

            page.pushOperators(popGraphicsState());
            break;
          }
          case 'cloud':
          case 'polygon_cloud' as any: {
            const cloudHasPattern = !!(shape as any).fillPatternId;
            const svgPath = buildCloudSvgPathForPdf(shape, (x) => x, (y) => y);
            if (svgPath) {
              page.pushOperators(
                pushGraphicsState(),
                setLineCap(LineCapStyle.Round),
                setLineJoin(LineJoinStyle.Round)
              );
              page.drawSvgPath(svgPath, {
                x: netPadLeft,
                y: newHeight - netPadTop,
                borderColor: stroke.rgbColor,
                borderWidth: shape.strokeWidth,
                borderOpacity: stroke.alpha,
                color: cloudHasPattern ? undefined : fill?.rgbColor,
                opacity: cloudHasPattern ? undefined : fill?.alpha,
                borderLineCap: LineCapStyle.Round,
              });
              page.pushOperators(popGraphicsState());
            }
            if (cloudHasPattern) {
              drawHatchPattern(page, shape, pdfX, pdfY, stroke, nativeRatio, colorSpaceMode);
            }
            if (shape.text) {
               const fontSize = shape.fontSize || 12;
               const lineHeight = fontSize * 1.0;
               // Use bounding-box top-left (minX, minY) to match the canvas renderer,
               // which positions text at Math.min(...points) + 10, not at points[0].
               let minX = shape.x;
               let minY = shape.y;
               if (shape.points && shape.points.length >= 2) {
                 minX = shape.points[0];
                 minY = shape.points[1];
                 for (let pi = 0; pi < shape.points.length; pi += 2) {
                   if (shape.points[pi] < minX) minX = shape.points[pi];
                   if (shape.points[pi + 1] < minY) minY = shape.points[pi + 1];
                 }
               }
               const lines = shape.text.split('\n');
               for (let i = 0; i < lines.length; i++) {
                 const tx = minX + 10;
                 const ty = minY + 10 + i * lineHeight + fontSize;
                 page.drawText(lines[i], {
                   x: pdfX(tx),
                   y: pdfY(ty),
                   size: fontSize,
                   font: font,
                   color: stroke.rgbColor,
                   opacity: stroke.alpha,
                 });
               }
            }
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
 
               const path = `M ${shape.points[0]} ${shape.points[1]} L ${elbowX} ${elbowY} L ${connectX} ${connectY}`;
               page.pushOperators(
                 pushGraphicsState(),
                 setLineCap(LineCapStyle.Round),
                 setLineJoin(LineJoinStyle.Round)
               );
               page.drawSvgPath(path, {
                 x: netPadLeft,
                 y: newHeight - netPadTop,
                 borderColor: stroke.rgbColor,
                 borderWidth: shape.strokeWidth,
                 borderOpacity: stroke.alpha,
                 borderLineCap: LineCapStyle.Round,
               });
               page.pushOperators(popGraphicsState());
            }
            if (shape.text) {
               const tW = shape.width || 150;
               const tH = shape.height || 60;
               drawWrappedText(page, shape.text, {
                  x: shape.x,
                  y: shape.y,
                  width: tW,
                  height: tH,
                  fontSize: shape.fontSize || 16,
                  font: font,
                  color: stroke.rgbColor,
                  opacity: stroke.alpha,
                  align: 'left',
                  verticalAlign: 'middle',
                  fontFamily: (shape as any).fontFamily || 'Inter',
                  pdfX,
                  pdfY,
               });
            }
            break;
          }

          case 'freehand' as any:
          case 'brush':
          case 'highlight':
          case 'polyline':
          case 'polygon':
          case 'measure_area': {
            if (shape.points && shape.points.length >= 4) {
               let path = `M ${shape.points[0]} ${shape.points[1]}`;
               for (let i = 2; i < shape.points.length; i += 2) {
                  path += ` L ${shape.points[i]} ${shape.points[i+1]}`;
               }
               
               const shouldClose = ['polygon', 'polygon_cloud', 'measure_area'].includes(shape.type) || !!shape.closed;
               
               if (shouldClose) {
                  path += ' Z';
               }
               
               const hasPattern = shouldClose && !!(shape as any).fillPatternId;

               page.pushOperators(
                 pushGraphicsState(),
                 setLineCap(LineCapStyle.Round),
                 setLineJoin(LineJoinStyle.Round)
               );
               page.drawSvgPath(path, {
                 x: netPadLeft,
                 y: newHeight - netPadTop,
                 borderColor: stroke.rgbColor,
                 borderWidth: shape.strokeWidth,
                 borderOpacity: shape.type === 'highlight' ? Math.min(stroke.alpha, 0.4) : stroke.alpha,
                 color: (!shouldClose || hasPattern) ? undefined : fill?.rgbColor,
                 opacity: (!shouldClose || hasPattern) ? undefined : fill?.alpha,
                 borderLineCap: LineCapStyle.Round,
               });
               page.pushOperators(popGraphicsState());

               if (hasPattern) {
                 drawHatchPattern(page, shape, pdfX, pdfY, stroke, nativeRatio, colorSpaceMode);
               }

               // Draw area label for measure_area shapes
               if (shape.type === 'measure_area' && shape.points.length >= 6) {
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
                 const centroidX = sumX / n;
                 const centroidY = sumY / n;
                 console.log("[pdfExporter] centroid:", centroidX, centroidY);
                 let areaStr = '';
                 if ((shape as any).measurementSystem && (shape as any).measurementScale) {
                   const scale2 = (shape as any).measurementScale;
                   if ((shape as any).measurementSystem === 'imperial') {
                     const paperInchSq = areaPixels / (72.0 * 72.0);
                     const realInchSq = paperInchSq * scale2 * scale2;
                     const realFtSq = realInchSq / 144;
                     areaStr = realFtSq >= 1 ? `${realFtSq.toFixed(2)} ft2` : `${realInchSq.toFixed(2)} in2`;
                   } else {
                     const mmPerPx = 25.4 / 72.0;
                     const paperMmSq = areaPixels * mmPerPx * mmPerPx;
                     const realMmSq = paperMmSq * scale2 * scale2;
                     if (realMmSq >= 1_000_000) {
                       areaStr = `${(realMmSq / 1_000_000).toFixed(2)} m2`;
                     } else if (realMmSq >= 10_000) {
                       areaStr = `${(realMmSq / 10_000).toFixed(2)} cm2`;
                     } else {
                       areaStr = `${realMmSq.toFixed(0)} mm2`;
                     }
                   }
                 } else {
                   areaStr = `${areaPixels.toFixed(0)} px2`;
                 }

                 if (areaStr) {
                   console.log("[pdfExporter] drawing area text:", areaStr, "at:", pdfX(centroidX), pdfY(centroidY));
                   const fontSize = 12;
                   const textWidth = font.widthOfTextAtSize(areaStr, fontSize);
                   page.drawText(areaStr, {
                     x: pdfX(centroidX) - textWidth / 2,
                     y: pdfY(centroidY),
                     size: fontSize,
                     font: font,
                     color: stroke.rgbColor,
                     opacity: stroke.alpha,
                   });
                 }
               }
            }
            break;
          }


          case 'spline': {
            if (shape.points && shape.points.length >= 4) {
              const tension = 0.5; // Matches tension in canvasRenderer
              let path = buildSplineSvgPath(shape.points, tension);
              if (shape.closed) {
                path += ' Z';
              }
              page.pushOperators(
                pushGraphicsState(),
                setLineCap(LineCapStyle.Round),
                setLineJoin(LineJoinStyle.Round)
              );
              page.drawSvgPath(path, {
                x: netPadLeft,
                y: newHeight - netPadTop,
                borderColor: stroke.rgbColor,
                borderWidth: shape.strokeWidth,
                borderOpacity: stroke.alpha,
                color: fill?.rgbColor,
                opacity: fill?.alpha,
                borderLineCap: LineCapStyle.Round,
              });
              page.pushOperators(popGraphicsState());

              // Draw Arrowhead if needed
              drawArrowHeadPdf(page, shape.points, shape, stroke, netPadLeft, newHeight - netPadTop);
            }
            break;
          }

          case 'arc': {
            if (shape.points && shape.points.length >= 6) {
              const [x1, y1, x2, y2, x3, y3] = shape.points;
              const D = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
              let path = '';
              
              if (Math.abs(D) < 1e-5) {
                path = `M ${x1} ${y1} L ${x3} ${y3}`;
              } else {
                const cx = ((x1 * x1 + y1 * y1) * (y2 - y3) + (x2 * x2 + y2 * y2) * (y3 - y1) + (x3 * x3 + y3 * y3) * (y1 - y2)) / D;
                const cy = ((x1 * x1 + y1 * y1) * (x3 - x2) + (x2 * x2 + y2 * y2) * (x1 - x3) + (x3 * x3 + y3 * y3) * (x2 - x1)) / D;
                const r = Math.sqrt((x1 - cx) ** 2 + (y1 - cy) ** 2);
                const startAngle = Math.atan2(y1 - cy, x1 - cx);
                const endAngle = Math.atan2(y3 - cy, x3 - cx);
                const cross = (x2 - x1) * (y3 - y2) - (y2 - y1) * (x3 - x2);
                const counterclockwise = cross < 0;
                
                let diff = endAngle - startAngle;
                if (counterclockwise) {
                  if (diff > 0) diff -= 2 * Math.PI;
                } else {
                  if (diff < 0) diff += 2 * Math.PI;
                }
                const sweepAngle = Math.abs(diff);
                const numSegments = Math.ceil(sweepAngle / (Math.PI / 2));
                const deltaAngle = diff / numSegments;
                const k = (4 / 3) * Math.tan(deltaAngle / 4);
                
                path = `M ${x1} ${y1}`;
                for (let i = 0; i < numSegments; i++) {
                  const a = startAngle + i * deltaAngle;
                  const b = startAngle + (i + 1) * deltaAngle;
                  
                  const pax = i === 0 ? x1 : cx + r * Math.cos(a);
                  const pay = i === 0 ? y1 : cy + r * Math.sin(a);
                  const pbx = i === numSegments - 1 ? x3 : cx + r * Math.cos(b);
                  const pby = i === numSegments - 1 ? y3 : cy + r * Math.sin(b);
                  
                  const cp1x = pax - k * r * Math.sin(a);
                  const cp1y = pay + k * r * Math.cos(a);
                  const cp2x = pbx + k * r * Math.sin(b);
                  const cp2y = pby - k * r * Math.cos(b);
                  
                  path += ` C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${pbx} ${pby}`;
                }
              }
              
              page.pushOperators(
                pushGraphicsState(),
                setLineCap(LineCapStyle.Round),
                setLineJoin(LineJoinStyle.Round)
              );
              page.drawSvgPath(path, {
                x: netPadLeft,
                y: newHeight - netPadTop,
                borderColor: stroke.rgbColor,
                borderWidth: shape.strokeWidth,
                borderOpacity: stroke.alpha,
                borderLineCap: LineCapStyle.Round,
              });
              page.pushOperators(popGraphicsState());
            }
            break;
          }

          case 'image': {
            if (shape.imageUrl) {
              try {
                const isDataUrl = shape.imageUrl.startsWith('data:image/');
                const imgBytes = isDataUrl 
                  ? Buffer.from(shape.imageUrl.split(',')[1], 'base64')
                  : await fetch(shape.imageUrl).then(res => res.arrayBuffer());
                const isPng = shape.imageUrl.includes('png') || shape.imageUrl.startsWith('data:image/png');
                const pdfImg = isPng ? await activePdfDoc.embedPng(imgBytes) : await activePdfDoc.embedJpg(imgBytes);
                
                const R = shape.rotation || 0;
                const w = shape.width || 0;
                const h = shape.height || 0;

                if (R !== 0) {
                  const theta = -R * Math.PI / 180;
                  const cos = Math.cos(theta);
                  const sin = Math.sin(theta);
                  const pivotX = pdfX(shape.x);
                  const pivotY = pdfY(shape.y);

                  page.pushOperators(
                    pushGraphicsState(),
                    concatTransformationMatrix(cos, sin, -sin, cos, pivotX, pivotY)
                  );
                  page.drawImage(pdfImg, {
                    x: 0,
                    y: -h,
                    width: w,
                    height: h,
                    opacity: stroke.alpha,
                  });
                  page.pushOperators(popGraphicsState());
                } else {
                  page.drawImage(pdfImg, {
                    x: pdfX(shape.x),
                    y: pdfY(shape.y) - h,
                    width: w,
                    height: h,
                    opacity: stroke.alpha,
                  });
                }
              } catch (e) { console.error("Img embed fail", e); }
            }
            break;
          }
        }
      } catch (err) {
        console.error('Error flattening shape:', shape.id, err);
      }
    }

    const markShapes = scaledShapes.filter(s => s.type.startsWith('mark_') || s.type === 'content_box');
    if (markShapes.length > 0) {
      try {
        const scale = 4;
        const canvas = document.createElement('canvas');
        canvas.width = newWidth * scale;
        canvas.height = newHeight * scale;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.save();
          ctx.translate(netPadLeft * scale, netPadTop * scale);
          await renderShapesOnCanvas(ctx, markShapes, scale);
          ctx.restore();

          const imgDataUrl = canvas.toDataURL('image/png');
          const base64Data = imgDataUrl.split(',')[1];
          const imgBytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
          const pdfImg = await activePdfDoc.embedPng(imgBytes);

          page.drawImage(pdfImg, {
            x: 0,
            y: 0,
            width: newWidth,
            height: newHeight,
          });
        }
      } catch (e) {
        console.error("Failed to render mark overlay:", e);
      }
      if (onProgress) onProgress(Math.round(25 + (pageNum / pages.length) * 50));
      await yieldToUI();
    }
  }

  if (onProgress) onProgress(85);
  await yieldToUI();
  const savedBytes = await activePdfDoc.save();
  if (onProgress) onProgress(100);
  return savedBytes;
}



function colorToRgbAndAlpha(
  color: string | undefined,
  colorSpaceMode: 'srgb' | 'cmyk' = 'srgb'
): { rgbColor: any; alpha: number } | undefined {
  if (!color || color === 'transparent') return undefined;

  try {
    let r = 0, g = 0, b = 0, a = 1;

    if (color.startsWith('rgb')) {
      const matches = color.match(/\d+(\.\d+)?/g);
      if (matches && matches.length >= 3) {
        r = parseFloat(matches[0]) / 255;
        g = parseFloat(matches[1]) / 255;
        b = parseFloat(matches[2]) / 255;
        if (matches.length >= 4) a = parseFloat(matches[3]);
      }
    } else if (color.startsWith('#')) {
      const hex = color.slice(1);
      if (hex.length === 3) {
        r = parseInt(hex[0] + hex[0], 16) / 255;
        g = parseInt(hex[1] + hex[1], 16) / 255;
        b = parseInt(hex[2] + hex[2], 16) / 255;
      } else if (hex.length === 4) {
        r = parseInt(hex[0] + hex[0], 16) / 255;
        g = parseInt(hex[1] + hex[1], 16) / 255;
        b = parseInt(hex[2] + hex[2], 16) / 255;
        a = parseInt(hex[3] + hex[3], 16) / 255;
      } else if (hex.length >= 6) {
        r = parseInt(hex.slice(0, 2), 16) / 255;
        g = parseInt(hex.slice(2, 4), 16) / 255;
        b = parseInt(hex.slice(4, 6), 16) / 255;
        if (hex.length === 8) {
          a = parseInt(hex.slice(6, 8), 16) / 255;
        }
      }
    }

    if (colorSpaceMode === 'cmyk') {
      const k = 1 - Math.max(r, g, b);
      const c = k === 1 ? 0 : (1 - r - k) / (1 - k);
      const m = k === 1 ? 0 : (1 - g - k) / (1 - k);
      const y = k === 1 ? 0 : (1 - b - k) / (1 - k);
      return { rgbColor: cmyk(c, m, y, k), alpha: a };
    } else {
      return { rgbColor: rgb(r, g, b), alpha: a };
    }
  } catch (err) {
    console.error('Color parse error for:', color, err);
  }

  return { rgbColor: colorSpaceMode === 'cmyk' ? cmyk(0, 0, 0, 1) : rgb(0, 0, 0), alpha: 1 }; // Fallback
}

function drawCropMarks(page: any, x1: number, x2: number, y1: number, y2: number, color: any) {
  const thickness = 0.5;
  const gap = 2;
  const len = 6;

  // Top-Left
  page.drawLine({ start: { x: x1 - gap, y: y2 }, end: { x: x1 - gap - len, y: y2 }, color, thickness });
  page.drawLine({ start: { x: x1, y: y2 + gap }, end: { x: x1, y: y2 + gap + len }, color, thickness });

  // Top-Right
  page.drawLine({ start: { x: x2 + gap, y: y2 }, end: { x: x2 + gap + len, y: y2 }, color, thickness });
  page.drawLine({ start: { x: x2, y: y2 + gap }, end: { x: x2, y: y2 + gap + len }, color, thickness });

  // Bottom-Left
  page.drawLine({ start: { x: x1 - gap, y: y1 }, end: { x: x1 - gap - len, y: y1 }, color, thickness });
  page.drawLine({ start: { x: x1, y: y1 - gap }, end: { x: x1, y: y1 - gap - len }, color, thickness });

  // Bottom-Right
  page.drawLine({ start: { x: x2 + gap, y: y1 }, end: { x: x2 + gap + len, y: y1 }, color, thickness });
  page.drawLine({ start: { x: x2, y: y1 - gap }, end: { x: x2, y: y1 - gap - len }, color, thickness });
}

function buildCloudSvgPathForPdf(shape: ShapeData, pdfX: (x: number) => number, pdfY: (y: number) => number): string {
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
  let verts = [...cloudPts];
  const nv = verts.length / 2;
  if (nv > 1 && verts[0] === verts[(nv - 1) * 2] && verts[1] === verts[(nv - 1) * 2 + 1]) {
    verts = verts.slice(0, -2);
  }
  const numVerts = verts.length / 2;
  if (numVerts < 2) return '';

  const bumpSize = Math.max(shape.radius || 20, 5);

  let path = '';
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
      if (firstPt) {
        path += `M ${pdfX(pAx)} ${pdfY(pAy)}`;
        firstPt = false;
      }
      path += ` Q ${pdfX(cpx)} ${pdfY(cpy)} ${pdfX(pBx)} ${pdfY(pBy)}`;
    }
  }

  if (path) {
    path += ' Z';
  }
  return path;
}

export async function flattenPdfRasterized(
  originalPdfBytes: Uint8Array,
  shapes: ShapeData[],
  dpi = 150,
  editable = false,
  _scaleCalibration = 1.0,
  isSpreadSave = false,
  tabId?: string,
  onProgress?: (progress: number) => void
): Promise<Uint8Array> {
  const yieldToUI = () => new Promise(resolve => setTimeout(resolve, 0));
  if (onProgress) onProgress(2);

  // Pre-load Inter so wrapTextCanvas() uses accurate glyph widths.
  const allFontSizes = [...new Set(
    shapes.map(s => s.fontSize || (['text', 'callout', 'arrow'].includes(s.type) ? 16 : 12)).filter(Boolean)
  )];
  await ensureFontsLoaded(allFontSizes.length ? allFontSizes : [12, 16], 'Inter');
  if (onProgress) onProgress(5);
  await yieldToUI();

  const pdfDoc = await PDFDocument.load(originalPdfBytes);

  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      `//unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
  }
  const pdfjsDoc = await pdfjsLib.getDocument({ data: new Uint8Array(originalPdfBytes.slice(0)) }).promise;
  const numPages = pdfjsDoc.numPages;

  const state = useStore.getState();
  const targetTabId = tabId || state.activeTabId;
  const doc = targetTabId ? state.documents[targetTabId] : null;
  const meta = targetTabId ? state.tabMetas[targetTabId] : null;
  const docTitle = meta?.label || 'Untitled';
  const isSpread = doc?.isSpread || false;
  const hasCoverPage = doc?.hasFrontCover || false;
  const assignments = doc?.masterPageAssignments || {};
  const docMasterPages = doc?.masterPages || state.masterPages || [];

  const rasterPdfDoc = await PDFDocument.create();

  // Pre-resolve smart text variables for document shapes
  const resolvedShapes = shapes.map(s => {
    if (s.text) {
      return {
        ...s,
        text: evaluateSmartText(s.text, {
          pageNum: s.page,
          totalPages: numPages,
          date: new Date().toLocaleDateString(),
          docTitle
        })
      };
    }
    return s;
  });

  // 1. Group pages into spreads.
  //    `left` / `right` are always ORIGINAL 1-based page numbers (used for pdfjsDoc.getPage and master lookups).
  //    `spreadIndex` is the 1-based index of this output page (used to filter shapes after remapping).
  const hasBackCover = doc?.hasBackCover || false;
  const activeSpreads = getSpreads(numPages, hasCoverPage, hasBackCover);
  const spreads: { left: number; right: number; spreadIndex: number }[] = [];
  if (isSpread && isSpreadSave) {
    activeSpreads.forEach(s => {
      spreads.push({
        left: s.pages[0],
        right: s.pages.length > 1 ? s.pages[1] : -1,
        spreadIndex: s.index + 1
      });
    });
  } else {
    for (let i = 1; i <= numPages; i++) {
      spreads.push({ left: i, right: -1, spreadIndex: i });
    }
  }

  // 2. Map document shapes to the correct page coordinate space.
  //    For a spread-save, remap original page numbers → spread indices (same transform as master shapes).
  //    For a single-page save, duplicate any shapes that cross the spine.
  let finalShapes = [...resolvedShapes];
  if (isSpread && isSpreadSave) {
    const getPageWidth = (pNum: number) => {
      const pages = pdfDoc.getPages();
      if (pNum >= 1 && pNum <= pages.length) return pages[pNum - 1].getSize().width;
      return 612;
    };
    finalShapes = resolvedShapes.map(s => {
      const pNum = s.page;
      let newPageNum = pNum;
      let newX = s.x;
      let newPoints = s.points;

      const spread = activeSpreads.find(sp => sp.pages.includes(pNum));
      if (spread) {
        newPageNum = spread.index + 1;
        const isLeft = spread.pages.length < 2 || spread.pages[0] === pNum;
        if (!isLeft) {
          const leftPageNum = spread.pages[0];
          const leftPageWidth = getPageWidth(leftPageNum);
          newX = s.x + leftPageWidth;
          if (s.points && !isLineMark(s.type)) {
            newPoints = s.points.map((pt, idx) => idx % 2 === 0 ? pt + leftPageWidth : pt);
          }
        }
      }
      return { ...s, page: newPageNum, x: newX, points: newPoints };
    });
  } else if (isSpread && !isSpreadSave) {
    const originalPages = pdfDoc.getPages();
    finalShapes = duplicateSpreadCrossingShapes(resolvedShapes, isSpread, hasCoverPage, numPages, originalPages);
  }

  // 3. Preprocess master shapes
  let masterShapes: ShapeData[] = [];
  if (doc) {
    for (let p = 1; p <= numPages; p++) {
      const masterId = assignments[p];
      const master = masterId ? docMasterPages.find((m: any) => m.id === masterId) : null;
      if (master) {
        let isLeft = true;
        if (isSpread) {
          const spread = activeSpreads.find(s => s.pages.includes(p));
          if (spread && spread.pages.length > 1) {
            isLeft = (spread.pages[0] === p);
          }
        }
        const originalPage = pdfDoc.getPages()[p - 1];
        const { width: pW, height: pH } = originalPage.getSize();
        const offsetX = (pW - master.pageWidth) / 2;
        const offsetY = (pH - master.pageHeight) / 2;

        master.shapes.forEach((shape: any) => {
          let shouldRender = false;
          let netShift = offsetX;

          if (master.isSpread) {
            if (isLeft) {
              if (shape.x < master.pageWidth) {
                shouldRender = true;
                netShift = offsetX;
              }
            } else {
              if (shape.x >= master.pageWidth) {
                shouldRender = true;
                netShift = offsetX - master.pageWidth;
              }
            }
          } else {
            shouldRender = true;
            netShift = offsetX;
          }

          if (shouldRender) {
            const resolvedText = shape.text ? evaluateSmartText(shape.text, {
              pageNum: p,
              totalPages: numPages,
              date: new Date().toLocaleDateString(),
              docTitle
            }) : '';

            masterShapes.push({
              ...shape,
              text: resolvedText,
              page: p,
              x: shape.x + netShift,
              y: shape.y + offsetY,
              points: shape.points ? (
                isLineMark(shape.type)
                  ? shape.points
                  : shape.points.map((pt: number, idx: number) => idx % 2 === 0 ? pt + netShift : pt + offsetY)
              ) : undefined
            });
          }
        });
      }
    }
  }

  // If Spread Save, map the master shapes to the merged pages as well!
  if (isSpread && isSpreadSave) {
    const getPageWidth = (pNum: number) => {
      if (pNum >= 1 && pNum <= pdfDoc.getPages().length) {
        return pdfDoc.getPages()[pNum - 1].getSize().width;
      }
      return 612;
    };
    masterShapes = masterShapes.map(s => {
      const pNum = s.page;
      let newPageNum = pNum;
      let newX = s.x;
      let newPoints = s.points;

      const spread = activeSpreads.find(sp => sp.pages.includes(pNum));
      if (spread) {
        newPageNum = spread.index + 1;
        const isLeft = spread.pages.length < 2 || spread.pages[0] === pNum;
        if (!isLeft) {
          const leftPageNum = spread.pages[0];
          const leftPageWidth = getPageWidth(leftPageNum);
          newX = s.x + leftPageWidth;
          if (s.points && !isLineMark(s.type)) {
            newPoints = s.points.map((pt, idx) => idx % 2 === 0 ? pt + leftPageWidth : pt);
          }
        }
      }
      return { ...s, page: newPageNum, x: newX, points: newPoints };
    });
  } else if (isSpread && !isSpreadSave) {
    const originalPages = pdfDoc.getPages();
    masterShapes = duplicateSpreadCrossingShapes(masterShapes, isSpread, hasCoverPage, numPages, originalPages);
  }

  // Combine master shapes and document shapes
  const allShapes = [...masterShapes, ...finalShapes];

  // 4. Render spreads/pages
  let idx = 0;
  for (const spread of spreads) {
    const jsLeftPage = await pdfjsDoc.getPage(spread.left);
    const leftViewport = jsLeftPage.getViewport({ scale: 1.0 });
    const pW_left = leftViewport.width;
    const pH_left = leftViewport.height;

    let pW_right = 0;
    let pH_right = 0;
    let jsRightPage: any = null;

    if (spread.right !== -1) {
      jsRightPage = await pdfjsDoc.getPage(spread.right);
      const rightViewport = jsRightPage.getViewport({ scale: 1.0 });
      pW_right = rightViewport.width;
      pH_right = rightViewport.height;
    }

    const outputWidth = pW_left + pW_right;
    const outputHeight = Math.max(pH_left, pH_right);

    const scale = dpi / 72; // pixels per PDF point
    const canvas = document.createElement('canvas');
    canvas.width = outputWidth * scale;
    canvas.height = outputHeight * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;

    // Fill white
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Render left page
    const renderScale = scale;
    const leftVp = jsLeftPage.getViewport({ scale: renderScale });
    const leftYOffset = outputHeight - pH_left;
    ctx.save();
    ctx.translate(0, leftYOffset * scale);
    await jsLeftPage.render({ canvasContext: ctx, viewport: leftVp, canvas: canvas } as any).promise;
    ctx.restore();

    // Render left master background PDF if assigned
    const leftMasterId = assignments[spread.left] ?? null;
    const leftMaster = leftMasterId ? docMasterPages.find((m: any) => m.id === leftMasterId) : null;
    if (leftMaster && leftMaster.backgroundPdfBytes) {
      try {
        const bgPdf = await pdfjsLib.getDocument({ data: new Uint8Array(leftMaster.backgroundPdfBytes.slice(0)) }).promise;
        const bgPageIdx = Math.max(1, Math.min(leftMaster.backgroundPageNum, bgPdf.numPages));
        const bgPage = await bgPdf.getPage(bgPageIdx);
        const masterScale = leftMaster.pageWidth / bgPage.getViewport({ scale: 1.0 }).width;
        const bgVp = bgPage.getViewport({ scale: renderScale * masterScale });
        const offsetX = (pW_left - leftMaster.pageWidth) / 2;
        const offsetY = (pH_left - leftMaster.pageHeight) / 2;

        ctx.save();
        ctx.translate(offsetX * scale, (leftYOffset + offsetY) * scale);
        await bgPage.render({ canvasContext: ctx, viewport: bgVp, canvas: canvas } as any).promise;
        ctx.restore();
      } catch (err) {
        console.error("Failed to render left master background:", err);
      }
    }

    // Render right page (if present)
    if (jsRightPage) {
      const rightVp = jsRightPage.getViewport({ scale: renderScale });
      const rightYOffset = outputHeight - pH_right;
      ctx.save();
      ctx.translate(pW_left * scale, rightYOffset * scale);
      await jsRightPage.render({ canvasContext: ctx, viewport: rightVp, canvas: canvas } as any).promise;
      ctx.restore();

      // Render right master background PDF if assigned
      const rightMasterId = assignments[spread.right] ?? null;
      const rightMaster = rightMasterId ? docMasterPages.find((m: any) => m.id === rightMasterId) : null;
      if (rightMaster && rightMaster.backgroundPdfBytes) {
        try {
          const bgPdf = await pdfjsLib.getDocument({ data: new Uint8Array(rightMaster.backgroundPdfBytes.slice(0)) }).promise;
          const bgPageIdx = Math.max(1, Math.min(rightMaster.backgroundPageNum, bgPdf.numPages));
          const bgPage = await bgPdf.getPage(bgPageIdx);
          const masterScale = rightMaster.pageWidth / bgPage.getViewport({ scale: 1.0 }).width;
          const bgVp = bgPage.getViewport({ scale: renderScale * masterScale });
          const offsetX = (pW_right - rightMaster.pageWidth) / 2;
          const offsetY = (pH_right - rightMaster.pageHeight) / 2;

          ctx.save();
          ctx.translate((pW_left + offsetX) * scale, (rightYOffset + offsetY) * scale);
          await bgPage.render({ canvasContext: ctx, viewport: bgVp, canvas: canvas } as any).promise;
          ctx.restore();
        } catch (err) {
          console.error("Failed to render right master background:", err);
        }
      }
    }

    // Prepare shapes to render on canvas.
    // Both masterShapes and finalShapes have been normalised to the same spreadIndex space,
    // so we filter by spreadIndex (not by the original left/right page numbers).
    const shapesToRender: ShapeData[] = [];

    // For a spread-save the left half of the output canvas maps to spreadIndex.
    // For a single-page save there is only one "page" per canvas and spreadIndex === left page.
    if (isSpread && isSpreadSave) {
      // All shapes for this spread output page share the same spreadIndex.
      // Their x-coordinates have already been remapped (right-page shapes shifted by leftPageWidth).
      // Use x position to determine whether a shape belongs to the left or right page,
      // and apply the correct y-offset for each side.
      const rightYOffsetSpread = outputHeight - pH_right;
      const spreadShapes = allShapes.filter(s => s.page === spread.spreadIndex);
      spreadShapes.forEach(s => {
        // A shape whose x >= pW_left has been shifted onto the right page.
        const isRightSide = spread.right !== -1 && s.x >= pW_left;
        const yOff = isRightSide ? rightYOffsetSpread : leftYOffset;
        shapesToRender.push({
          ...s,
          y: s.y + yOff,
          points: s.points ? (
            isLineMark(s.type)
              ? s.points
              : s.points.map((pt, idx) => idx % 2 === 1 ? pt + yOff : pt)
          ) : undefined
        });
      });
    } else {
      // Single-page save: left = original page number, spreadIndex === left.
      const leftShapes = allShapes.filter(s => s.page === spread.left);
      leftShapes.forEach(s => {
        shapesToRender.push({
          ...s,
          y: s.y + leftYOffset,
          points: s.points ? (
            isLineMark(s.type)
              ? s.points
              : s.points.map((pt, idx) => idx % 2 === 1 ? pt + leftYOffset : pt)
          ) : undefined
        });
      });
    }

    // Render marks on canvas
    await renderShapesOnCanvas(ctx, shapesToRender, scale, false);

    // Save as PNG
    const imgDataUrl = canvas.toDataURL('image/png');
    const base64Data = imgDataUrl.split(',')[1];
    const imgBytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
    const pdfImg = await rasterPdfDoc.embedPng(imgBytes);

    const newPage = rasterPdfDoc.addPage([outputWidth, outputHeight]);
    newPage.drawImage(pdfImg, {
      x: 0,
      y: 0,
      width: outputWidth,
      height: outputHeight,
    });
    idx++;
    if (onProgress) onProgress(Math.round(5 + (idx / spreads.length) * 85));
    await yieldToUI();
  }

  // 5. Inject metadata to rasterPdfDoc (if editable)
  if (editable) {
    try {
      const payload = JSON.stringify({
        version: 2,
        shapes: finalShapes,
        spreadConfig: {
          isSpread: isSpread && isSpreadSave,
          hasFrontCover: hasCoverPage && isSpreadSave,
          hasBackCover: hasBackCover && isSpreadSave,
        },
        masterPages: doc?.masterPages ? serializeMasterPages(doc.masterPages) : [],
        masterPageAssignments: doc?.masterPageAssignments || {},
        guides: doc?.guides || [],
      });
      rasterPdfDoc.setSubject(`LAYERS_MARKUP_DATA:${payload}`);
      rasterPdfDoc.setCreator('Layers App');
      
      const pristineBytes = originalPdfBytes;

      await rasterPdfDoc.attach(pristineBytes, 'LayersPristine.pdf', {
        mimeType: 'application/pdf',
        description: 'Pristine Background',
        creationDate: new Date(),
        modificationDate: new Date()
      });
    } catch { /* ignore */ }
  }

  if (onProgress) onProgress(95);
  await yieldToUI();
  const savedBytes = await rasterPdfDoc.save();
  if (onProgress) onProgress(100);
  return savedBytes;
}


function buildSplineSvgPath(pts: number[], tension = 0.5): string {
  if (!pts || pts.length < 4) return '';
  const length = pts.length;
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
  let path = `M ${pts[0]} ${pts[1]}`;

  if (tension !== 0 && length > 4 && tpLen > 0) {
    let n = 4;
    // First segment: Quadratic Bezier from pts[0],pts[1] via tp[0],tp[1] to tp[2],tp[3]
    const p0x = pts[0], p0y = pts[1];
    const p1x = tp[0], p1y = tp[1];
    const p2x = tp[2], p2y = tp[3];
    
    const cp1x = p0x + (2 / 3) * (p1x - p0x);
    const cp1y = p0y + (2 / 3) * (p1y - p0y);
    const cp2x = p2x + (2 / 3) * (p1x - p2x);
    const cp2y = p2y + (2 / 3) * (p1y - p2y);
    
    path += ` C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${p2x} ${p2y}`;

    while (n < tpLen - 2) {
      path += ` C ${tp[n++]} ${tp[n++]} ${tp[n++]} ${tp[n++]} ${tp[n++]} ${tp[n++]}`;
    }

    // Last segment: Quadratic Bezier from tp[tpLen-4],tp[tpLen-3] via tp[tpLen-2],tp[tpLen-1] to pts[length-2],pts[length-1]
    const qStartX = tp[tpLen - 4];
    const qStartY = tp[tpLen - 3];
    const qCtrlX = tp[tpLen - 2];
    const qCtrlY = tp[tpLen - 1];
    const qEndX = pts[length - 2];
    const qEndY = pts[length - 1];
    
    const lastCp1x = qStartX + (2 / 3) * (qCtrlX - qStartX);
    const lastCp1y = qStartY + (2 / 3) * (qCtrlY - qStartY);
    const lastCp2x = qEndX + (2 / 3) * (qCtrlX - qEndX);
    const lastCp2y = qEndY + (2 / 3) * (qCtrlY - qEndY);
    
    path += ` C ${lastCp1x} ${lastCp1y} ${lastCp2x} ${lastCp2y} ${qEndX} ${qEndY}`;
  } else {
    for (let n = 2; n < length; n += 2) {
      path += ` L ${pts[n]} ${pts[n + 1]}`;
    }
  }
  return path;
}

function drawArrowHeadPdf(
  page: any,
  pts: number[],
  shape: ShapeData,
  stroke: any,
  padLeft: number,
  padTopPdf: number
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
    
    const P0x = pts[length - 4], P0y = pts[length - 3];
    const P1x = cp[2], P1y = cp[3];
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

  const size = (shape.arrowHeadSize ?? 15);
  const halfAngle = (shape.arrowHeadAngle ?? 30) * Math.PI / 180;
  const filled = shape.arrowHeadFilled ?? true;

  const r1x = x2 - size * Math.cos(angle - halfAngle);
  const r1y = y2 - size * Math.sin(angle - halfAngle);
  const r2x = x2 - size * Math.cos(angle + halfAngle);
  const r2y = y2 - size * Math.sin(angle + halfAngle);

  let path = `M ${r1x} ${r1y} L ${x2} ${y2} L ${r2x} ${r2y}`;
  if (type !== 'greater_than') {
    path += ' Z';
  }

  page.pushOperators(
    pushGraphicsState(),
    setLineCap(LineCapStyle.Round),
    setLineJoin(LineJoinStyle.Round)
  );

  page.drawSvgPath(path, {
    x: padLeft,
    y: padTopPdf,
    borderColor: stroke.rgbColor,
    borderWidth: shape.strokeWidth,
    borderOpacity: stroke.alpha,
    color: (type !== 'greater_than' && filled) ? stroke.rgbColor : undefined,
    opacity: (type !== 'greater_than' && filled) ? stroke.alpha : undefined,
    borderLineCap: LineCapStyle.Round,
  });

  page.pushOperators(popGraphicsState());
}


function formatImperial(real_inches: number) {
  const feet = Math.floor(real_inches / 12);
  const inches = real_inches % 12;
  const sixteenths = Math.round(inches * 16);
  if (sixteenths === 192) return `${feet + 1}'-0"`;
  const wholeInches = Math.floor(sixteenths / 16);
  const rem = sixteenths % 16;
  if (rem === 0) {
    if (feet === 0) return `${wholeInches}"`;
    return wholeInches === 0 ? `${feet}'-0"` : `${feet}'-\ ${wholeInches}"`;
  }
  let num = rem, den = 16;
  while (num % 2 === 0 && den % 2 === 0) { num /= 2; den /= 2; }
  if (feet === 0)
    return wholeInches === 0 ? `${num}/${den}"` : `${wholeInches} ${num}/${den}"`;
  return wholeInches === 0 ? `${feet}'-${num}/${den}"` : `${feet}'-${wholeInches} ${num}/${den}"`;
}

// ── wrapText is superseded by wrapTextCanvas from textLayout.ts ──────────────
// Both canvasRenderer.ts and pdfExporter.ts now call wrapTextCanvas() which
// uses browser canvas + Inter font metrics, guaranteeing identical line breaks.

function drawWrappedText(
  page: any,
  text: string,
  options: {
    x: number;
    y: number;
    width: number;
    height?: number;
    fontSize: number;
    font: any;
    color: any;
    opacity: number;
    align?: 'left' | 'right' | 'center';
    verticalAlign?: 'top' | 'middle';
    padding?: number;
    fontFamily?: string;          // CSS font-family for measurement (default: 'Inter')
    pdfX: (kx: number) => number;
    pdfY: (ky: number) => number;
    rotation?: number;
  }
) {
  const padding    = options.padding ?? 5;
  const fontFamily = options.fontFamily ?? 'Inter';
  const innerWidth = Math.max(0, options.width - padding * 2);

  // Use canvas-based Inter metrics — same as canvasRenderer — for identical line breaks.
  const lines      = wrapTextCanvas(text, innerWidth, options.fontSize, fontFamily);
  const lineHeight = options.fontSize * 1.2;
  const totalTextHeight = lines.length * lineHeight;

  let startY = options.y + padding;
  if (options.verticalAlign === 'middle' && options.height) {
    startY = options.y + (options.height - totalTextHeight) / 2;
  }

  const R = options.rotation || 0;

  if (R !== 0) {
    const theta = -R * Math.PI / 180;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const pivotX = options.pdfX(options.x);
    const pivotY = options.pdfY(options.y);

    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(cos, sin, -sin, cos, pivotX, pivotY)
    );

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let lx = padding;
      if (options.align === 'right') {
        const lineWidth = measureTextCanvas(line, options.fontSize, fontFamily);
        lx = options.width - padding - lineWidth;
      } else if (options.align === 'center') {
        const lineWidth = measureTextCanvas(line, options.fontSize, fontFamily);
        lx = (options.width - lineWidth) / 2;
      }

      const ly = startY - options.y + i * lineHeight + options.fontSize;

      page.drawText(line, {
        x: lx,
        y: -ly,
        size: options.fontSize,
        font: options.font,
        color: options.color,
        opacity: options.opacity,
      });
    }

    page.pushOperators(popGraphicsState());
  } else {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // For right/centre alignment measure with the same canvas context.
      let lx = options.x + padding;
      if (options.align === 'right') {
        const lineWidth = measureTextCanvas(line, options.fontSize, fontFamily);
        lx = options.x + options.width - padding - lineWidth;
      } else if (options.align === 'center') {
        const lineWidth = measureTextCanvas(line, options.fontSize, fontFamily);
        lx = options.x + (options.width - lineWidth) / 2;
      }

      // Baseline position: top of line + fontSize (approximates ascender baseline).
      const ly = startY + i * lineHeight + options.fontSize;

      page.drawText(line, {
        x: options.pdfX(lx),
        y: options.pdfY(ly),
        size: options.fontSize,
        font: options.font,
        color: options.color,
        opacity: options.opacity,
      });
    }
  }
}

function clipLineToRect(x1: number, y1: number, x2: number, y2: number, xMin: number, yMin: number, xMax: number, yMax: number): number[] | null {
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - xMin, xMax - x1, y1 - yMin, yMax - y1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy];
}

function clipLineToEllipse(x1: number, y1: number, x2: number, y2: number, cx: number, cy: number, rx: number, ry: number, rotationDeg = 0): number[] | null {
  const rad = -rotationDeg * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  
  const transform = (x: number, y: number) => {
    const dx = x - cx, dy = y - cy;
    const ux = (dx * cos - dy * sin) / rx;
    const uy = (dx * sin + dy * cos) / ry;
    return { x: ux, y: uy };
  };

  const untransform = (ux: number, uy: number) => {
    const rx_ux = ux * rx;
    const ry_uy = uy * ry;
    const x = cx + (rx_ux * cos + ry_uy * sin);
    const y = cy + (-rx_ux * sin + ry_uy * cos);
    return [x, y];
  };

  const p1 = transform(x1, y1);
  const p2 = transform(x2, y2);

  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const a = dx * dx + dy * dy;
  const b = 2 * (p1.x * dx + p1.y * dy);
  const c = p1.x * p1.x + p1.y * p1.y - 1;

  if (a === 0) {
    if (c <= 0) return [x1, y1, x2, y2];
    return null;
  }

  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;

  const t1 = (-b - Math.sqrt(disc)) / (2 * a);
  const t2 = (-b + Math.sqrt(disc)) / (2 * a);

  const tStart = Math.max(0, Math.min(t1, t2));
  const tEnd = Math.min(1, Math.max(t1, t2));

  if (tStart > tEnd) return null;

  const cp1 = untransform(p1.x + tStart * dx, p1.y + tStart * dy);
  const cp2 = untransform(p1.x + tEnd * dx, p1.y + tEnd * dy);

  return [cp1[0], cp1[1], cp2[0], cp2[1]];
}

function intersectSegments(
  ax1: number, ay1: number, ax2: number, ay2: number,
  bx1: number, by1: number, bx2: number, by2: number
): { x: number, y: number } | null {
  const det = (ax2 - ax1) * (by2 - by1) - (ay2 - ay1) * (bx2 - bx1);
  if (Math.abs(det) < 1e-6) return null;

  const t = ((bx1 - ax1) * (by2 - by1) - (by1 - ay1) * (bx2 - bx1)) / det;
  const u = ((bx1 - ax1) * (ay2 - ay1) - (by1 - ay1) * (ax2 - ax1)) / det;

  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return {
      x: ax1 + t * (ax2 - ax1),
      y: ay1 + t * (ay2 - ay1),
    };
  }
  return null;
}

function isPointInPolygon(x: number, y: number, polygon: number[]): boolean {
  let inside = false;
  const n = polygon.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i * 2], yi = polygon[i * 2 + 1];
    const xj = polygon[j * 2], yj = polygon[j * 2 + 1];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi || 1) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function clipSegmentToPolygon(px1: number, py1: number, px2: number, py2: number, polygon: number[]): number[][] {
  const points: { x: number, y: number, t: number }[] = [];
  const n = polygon.length / 2;
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    const ex1 = polygon[i * 2], ey1 = polygon[i * 2 + 1];
    const ex2 = polygon[next * 2], ey2 = polygon[next * 2 + 1];
    
    const pt = intersectSegments(px1, py1, px2, py2, ex1, ey1, ex2, ey2);
    if (pt) {
      const dx = px2 - px1;
      const dy = py2 - py1;
      const t = dx !== 0 ? (pt.x - px1) / dx : (pt.y - py1) / dy;
      points.push({ x: pt.x, y: pt.y, t });
    }
  }

  if (isPointInPolygon(px1, py1, polygon)) {
    points.push({ x: px1, y: py1, t: 0 });
  }
  if (isPointInPolygon(px2, py2, polygon)) {
    points.push({ x: px2, y: py2, t: 1 });
  }

  points.sort((a, b) => a.t - b.t);

  const uniquePoints: { x: number, y: number }[] = [];
  for (const pt of points) {
    if (uniquePoints.length === 0) {
      uniquePoints.push(pt);
    } else {
      const prev = uniquePoints[uniquePoints.length - 1];
      const dist = Math.sqrt((pt.x - prev.x) ** 2 + (pt.y - prev.y) ** 2);
      if (dist > 1e-3) {
        uniquePoints.push(pt);
      }
    }
  }

  const segments: number[][] = [];
  for (let i = 0; i < uniquePoints.length - 1; i += 2) {
    segments.push([
      uniquePoints[i].x, uniquePoints[i].y,
      uniquePoints[i+1].x, uniquePoints[i+1].y
    ]);
  }
  return segments;
}

// ── Hatch pattern tile definitions (mirrors PatternEngine.ts exactly) ────

interface HatchLineDef { x1: number; y1: number; x2: number; y2: number }
interface HatchCircleDef { cx: number; cy: number; r: number; filled: boolean }

interface PatternTileDef {
  width: number;
  height: number;
  lines: HatchLineDef[];
  circles: HatchCircleDef[];
}

// Seeded PRNG for deterministic Sand dot positions across exports
function seededRandom(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return (s >>> 0) / 4294967296;
  };
}

// Pre-compute Sand dots with a fixed seed so every export is identical
const _sandDots: HatchCircleDef[] = (() => {
  const rng = seededRandom(42);
  const dots: HatchCircleDef[] = [];
  for (let i = 0; i < 15; i++) {
    dots.push({ cx: rng() * 20, cy: rng() * 20, r: 0.5, filled: true });
  }
  return dots;
})();

const patternTileDefs: Record<string, PatternTileDef> = {
  'Aluminum': {
    width: 20, height: 20,
    lines: [
      { x1: 0, y1: 20, x2: 20, y2: 0 },
    ],
    circles: []
  },
  'Block 8x16': {
    width: 32, height: 16,
    lines: [
      { x1: 0, y1: 0, x2: 32, y2: 0 },
      { x1: 0, y1: 8, x2: 32, y2: 8 },
      { x1: 0, y1: 0, x2: 0, y2: 8 },
      { x1: 16, y1: 8, x2: 16, y2: 16 },
    ],
    circles: []
  },
  'Block 8x8': {
    width: 16, height: 16,
    lines: [
      { x1: 0, y1: 0, x2: 16, y2: 0 },
      { x1: 0, y1: 8, x2: 16, y2: 8 },
      { x1: 0, y1: 0, x2: 0, y2: 8 },
      { x1: 8, y1: 8, x2: 8, y2: 16 },
    ],
    circles: []
  },
  'Brick': {
    width: 16, height: 5.33,
    lines: [
      { x1: 0, y1: 0, x2: 16, y2: 0 },
      { x1: 0, y1: 2.665, x2: 16, y2: 2.665 },
      { x1: 0, y1: 0, x2: 0, y2: 2.665 },
      { x1: 8, y1: 2.665, x2: 8, y2: 5.33 },
    ],
    circles: []
  },
  'Ceiling 24x24': {
    width: 24, height: 24,
    lines: [
      { x1: 0, y1: 0, x2: 24, y2: 0 },
      { x1: 0, y1: 0, x2: 0, y2: 24 },
    ],
    circles: []
  },
  'Ceiling 24x48': {
    width: 48, height: 24,
    lines: [
      { x1: 0, y1: 0, x2: 48, y2: 0 },
      { x1: 0, y1: 0, x2: 0, y2: 24 },
    ],
    circles: []
  },
  'Concrete': {
    width: 40, height: 40,
    lines: [
      // Triangle 1 at (10, 10) r=3
      { x1: 10, y1: 7, x2: 13, y2: 11.5 },
      { x1: 13, y1: 11.5, x2: 7, y2: 11.5 },
      { x1: 7, y1: 11.5, x2: 10, y2: 7 },
      // Triangle 2 at (25, 30) r=4
      { x1: 25, y1: 26, x2: 29, y2: 32 },
      { x1: 29, y1: 32, x2: 21, y2: 32 },
      { x1: 21, y1: 32, x2: 25, y2: 26 },
      // Triangle 3 at (35, 15) r=2
      { x1: 35, y1: 13, x2: 37, y2: 16 },
      { x1: 37, y1: 16, x2: 33, y2: 16 },
      { x1: 33, y1: 16, x2: 35, y2: 13 },
    ],
    circles: [
      { cx: 20, cy: 20, r: 1, filled: true },
      { cx: 5, cy: 30, r: 0.5, filled: true },
      { cx: 30, cy: 5, r: 1.5, filled: true },
    ]
  },
  'Diagonal 3 lines': {
    width: 30, height: 30,
    lines: [
      { x1: 0, y1: 30, x2: 30, y2: 0 },
      { x1: 3, y1: 30, x2: 33, y2: 0 },
      { x1: 6, y1: 30, x2: 36, y2: 0 },
    ],
    circles: []
  },
  'Earth': {
    width: 12, height: 12,
    lines: [
      // Main grid
      { x1: 0, y1: 0, x2: 12, y2: 0 },
      { x1: 0, y1: 6, x2: 12, y2: 6 },
      { x1: 0, y1: 0, x2: 0, y2: 12 },
      { x1: 6, y1: 0, x2: 6, y2: 12 },
      // Top-left quadrant: vertical lines
      { x1: 2, y1: 0, x2: 2, y2: 6 },
      { x1: 4, y1: 0, x2: 4, y2: 6 },
      // Bottom-right quadrant: vertical lines
      { x1: 8, y1: 6, x2: 8, y2: 12 },
      { x1: 10, y1: 6, x2: 10, y2: 12 },
      // Top-right quadrant: horizontal lines
      { x1: 6, y1: 2, x2: 12, y2: 2 },
      { x1: 6, y1: 4, x2: 12, y2: 4 },
      // Bottom-left quadrant: horizontal lines
      { x1: 0, y1: 8, x2: 6, y2: 8 },
      { x1: 0, y1: 10, x2: 6, y2: 10 },
    ],
    circles: []
  },
  'Steel': {
    width: 20, height: 20,
    lines: [
      { x1: 0, y1: 20, x2: 20, y2: 0 },
      { x1: 4, y1: 20, x2: 24, y2: 0 },
    ],
    circles: []
  },
  'Sand': {
    width: 20, height: 20,
    lines: [],
    circles: _sandDots
  },
  'Wood_1': {
    width: 20, height: 20,
    lines: [
      { x1: 0, y1: 0, x2: 20, y2: 0 },
      { x1: 0, y1: 5, x2: 20, y2: 5 },
      { x1: 0, y1: 10, x2: 20, y2: 10 },
      { x1: 0, y1: 15, x2: 20, y2: 15 },
    ],
    circles: []
  },

  // ─── New priority patterns ──────────────────────────────────────────

  'Cross Hatch': {
    width: 15, height: 15,
    lines: [
      { x1: 0, y1: 0, x2: 15, y2: 0 },   // horizontal
      { x1: 0, y1: 0, x2: 0, y2: 15 },    // vertical
    ],
    circles: []
  },
  'Horizontal Lines': {
    width: 20, height: 10,
    lines: [
      { x1: 0, y1: 0, x2: 20, y2: 0 },
    ],
    circles: []
  },
  'Vertical Lines': {
    width: 10, height: 20,
    lines: [
      { x1: 0, y1: 0, x2: 0, y2: 20 },
    ],
    circles: []
  },
  'Herringbone': {
    width: 20, height: 10,
    lines: [
      { x1: 0, y1: 10, x2: 10, y2: 0 },   // left leg of V
      { x1: 10, y1: 0, x2: 20, y2: 10 },   // right leg of V
    ],
    circles: []
  },
  'Insulation': {
    width: 20, height: 10,
    lines: [
      // 16-segment sine wave approximation: y = 5 + 4·sin(2πx/20)
      { x1: 0.00, y1: 5.00, x2: 1.25, y2: 6.53 },
      { x1: 1.25, y1: 6.53, x2: 2.50, y2: 7.83 },
      { x1: 2.50, y1: 7.83, x2: 3.75, y2: 8.70 },
      { x1: 3.75, y1: 8.70, x2: 5.00, y2: 9.00 },
      { x1: 5.00, y1: 9.00, x2: 6.25, y2: 8.70 },
      { x1: 6.25, y1: 8.70, x2: 7.50, y2: 7.83 },
      { x1: 7.50, y1: 7.83, x2: 8.75, y2: 6.53 },
      { x1: 8.75, y1: 6.53, x2: 10.00, y2: 5.00 },
      { x1: 10.00, y1: 5.00, x2: 11.25, y2: 3.47 },
      { x1: 11.25, y1: 3.47, x2: 12.50, y2: 2.17 },
      { x1: 12.50, y1: 2.17, x2: 13.75, y2: 1.30 },
      { x1: 13.75, y1: 1.30, x2: 15.00, y2: 1.00 },
      { x1: 15.00, y1: 1.00, x2: 16.25, y2: 1.30 },
      { x1: 16.25, y1: 1.30, x2: 17.50, y2: 2.17 },
      { x1: 17.50, y1: 2.17, x2: 18.75, y2: 3.47 },
      { x1: 18.75, y1: 3.47, x2: 20.00, y2: 5.00 },
    ],
    circles: []
  },
  'Triangles': {
    width: 10, height: 17.32,
    lines: [
      // Horizontal lines
      { x1: 0, y1: 0, x2: 10, y2: 0 },
      { x1: 0, y1: 8.66, x2: 10, y2: 8.66 },
      // 60° diagonal
      { x1: 0, y1: 0, x2: 10, y2: 17.32 },
      // 120° diagonal
      { x1: 10, y1: 0, x2: 0, y2: 17.32 },
    ],
    circles: []
  }
};

interface HatchPrimitiveOutput {
  lines: HatchLineDef[];
  circles: HatchCircleDef[];
}

function generateHatchPrimitives(
  xMin: number, yMin: number, xMax: number, yMax: number,
  patternId: string,
  pScale: number
): HatchPrimitiveOutput {
  const def = patternTileDefs[patternId];
  if (!def) {
    // Unknown pattern – fall back to simple 45° diagonal lines with 20px tile
    const fallbackTileW = 20 * pScale;
    if (fallbackTileW < 1) return { lines: [], circles: [] };
    const lines: HatchLineDef[] = [];
    const colStart = Math.floor(xMin / fallbackTileW) - 1;
    const colEnd = Math.ceil(xMax / fallbackTileW) + 1;
    const rowStart = Math.floor(yMin / fallbackTileW) - 1;
    const rowEnd = Math.ceil(yMax / fallbackTileW) + 1;
    for (let row = rowStart; row <= rowEnd && lines.length < 5000; row++) {
      for (let col = colStart; col <= colEnd && lines.length < 5000; col++) {
        const ox = col * fallbackTileW;
        const oy = row * fallbackTileW;
        lines.push({
          x1: ox,
          y1: oy + fallbackTileW,
          x2: ox + fallbackTileW,
          y2: oy,
        });
      }
    }
    return { lines, circles: [] };
  }

  const tileW = def.width * pScale;
  const tileH = def.height * pScale;

  // Prevent extremely small tiles that would create too many primitives
  if (tileW < 0.5 || tileH < 0.5) return { lines: [], circles: [] };

  const MAX_PRIMITIVES = 5000;
  const lines: HatchLineDef[] = [];
  const circles: HatchCircleDef[] = [];

  // Calculate tile grid covering bounding box (with 1-tile padding for overflow lines)
  const colStart = Math.floor(xMin / tileW) - 1;
  const colEnd = Math.ceil(xMax / tileW) + 1;
  const rowStart = Math.floor(yMin / tileH) - 1;
  const rowEnd = Math.ceil(yMax / tileH) + 1;

  for (let row = rowStart; row <= rowEnd && (lines.length + circles.length) < MAX_PRIMITIVES; row++) {
    for (let col = colStart; col <= colEnd && (lines.length + circles.length) < MAX_PRIMITIVES; col++) {
      const ox = col * tileW;
      const oy = row * tileH;

      for (const l of def.lines) {
        lines.push({
          x1: ox + l.x1 * pScale,
          y1: oy + l.y1 * pScale,
          x2: ox + l.x2 * pScale,
          y2: oy + l.y2 * pScale,
        });
      }

      for (const c of def.circles) {
        circles.push({
          cx: ox + c.cx * pScale,
          cy: oy + c.cy * pScale,
          r: c.r * pScale,
          filled: c.filled,
        });
      }
    }
  }

  return { lines, circles };
}

function drawHatchPattern(
  page: any,
  shape: ShapeData,
  pdfX: (x: number) => number,
  pdfY: (y: number) => number,
  _stroke: any,
  nativeRatio: number,
  colorSpaceMode?: 'srgb' | 'cmyk'
) {
  const patternId = (shape as any).fillPatternId;
  if (!patternId) return;

  const hatchColorStr = (shape.fillColor && shape.fillColor !== 'transparent') ? shape.fillColor : (shape.strokeColor || '#000000');
  const stroke = colorToRgbAndAlpha(hatchColorStr, colorSpaceMode) || _stroke || { rgbColor: rgb(0, 0, 0), alpha: 1 };

  const pScale = ((shape as any).fillPatternScale || 1.0) * nativeRatio;
  const thickness = (shape as any).fillPatternStrokeWidth || shape.strokeWidth || 1;
  const R = shape.rotation || 0;

  if (R !== 0) {
    const theta = -R * Math.PI / 180;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const pivotX = pdfX(shape.x);
    const pivotY = pdfY(shape.y);

    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(cos, sin, -sin, cos, pivotX, pivotY)
    );

    const localPdfX = (lx: number) => lx;
    const localPdfY = (ly: number) => ly;

    let xMin = 0, yMin = 0, xMax = 0, yMax = 0;
    if (shape.type === 'rect') {
      const w = shape.width || 0;
      const h = shape.height || 0;
      xMin = 0; xMax = w;
      yMin = -h; yMax = 0;
    } else if (shape.type === 'circle') {
      const rx = shape.width !== undefined ? shape.width / 2 : (shape.radius || 0);
      const ry = shape.height !== undefined ? shape.height / 2 : (shape.radius || 0);
      xMin = -rx; xMax = rx;
      yMin = -ry; yMax = ry;
    } else if (shape.points) {
      const localPoints: number[] = [];
      for (let i = 0; i < shape.points.length; i += 2) {
        const dx = shape.points[i] - shape.x;
        const dy = shape.points[i + 1] - shape.y;
        localPoints.push(dx, -dy);
      }
      xMin = Math.min(...localPoints.filter((_, i) => i % 2 === 0));
      xMax = Math.max(...localPoints.filter((_, i) => i % 2 === 0));
      yMin = Math.min(...localPoints.filter((_, i) => i % 2 === 1));
      yMax = Math.max(...localPoints.filter((_, i) => i % 2 === 1));
    }

    const { lines, circles } = generateHatchPrimitives(xMin, yMin, xMax, yMax, patternId, pScale);

    // Draw lines
    for (const line of lines) {
      if (shape.type === 'rect') {
        const clipped = clipLineToRect(line.x1, line.y1, line.x2, line.y2, xMin, yMin, xMax, yMax);
        if (clipped) {
          page.drawLine({
            start: { x: localPdfX(clipped[0]), y: localPdfY(clipped[1]) },
            end: { x: localPdfX(clipped[2]), y: localPdfY(clipped[3]) },
            color: stroke.rgbColor,
            thickness,
            opacity: stroke.alpha,
          });
        }
      } else if (shape.type === 'circle') {
        const rx = shape.width !== undefined ? shape.width / 2 : (shape.radius || 0);
        const ry = shape.height !== undefined ? shape.height / 2 : (shape.radius || 0);
        const clipped = clipLineToEllipse(line.x1, line.y1, line.x2, line.y2, 0, 0, rx, ry, 0);
        if (clipped) {
          page.drawLine({
            start: { x: localPdfX(clipped[0]), y: localPdfY(clipped[1]) },
            end: { x: localPdfX(clipped[2]), y: localPdfY(clipped[3]) },
            color: stroke.rgbColor,
            thickness,
            opacity: stroke.alpha,
          });
        }
      } else if (shape.points) {
        const localPoints: number[] = [];
        for (let i = 0; i < shape.points.length; i += 2) {
          const dx = shape.points[i] - shape.x;
          const dy = shape.points[i + 1] - shape.y;
          localPoints.push(dx, -dy);
        }
        const segments = clipSegmentToPolygon(line.x1, line.y1, line.x2, line.y2, localPoints);
        for (const seg of segments) {
          page.drawLine({
            start: { x: localPdfX(seg[0]), y: localPdfY(seg[1]) },
            end: { x: localPdfX(seg[2]), y: localPdfY(seg[3]) },
            color: stroke.rgbColor,
            thickness,
            opacity: stroke.alpha,
          });
        }
      }
    }

    // Draw circles
    for (const circ of circles) {
      let inside = false;
      if (shape.type === 'rect') {
        inside = circ.cx >= xMin && circ.cx <= xMax && circ.cy >= yMin && circ.cy <= yMax;
      } else if (shape.type === 'circle') {
        const rx = shape.width !== undefined ? shape.width / 2 : (shape.radius || 0);
        const ry = shape.height !== undefined ? shape.height / 2 : (shape.radius || 0);
        const dx = circ.cx / (rx || 1);
        const dy = circ.cy / (ry || 1);
        inside = (dx * dx + dy * dy) <= 1;
      } else if (shape.points) {
        const localPoints: number[] = [];
        for (let i = 0; i < shape.points.length; i += 2) {
          const dx = shape.points[i] - shape.x;
          const dy = shape.points[i + 1] - shape.y;
          localPoints.push(dx, -dy);
        }
        inside = isPointInPolygon(circ.cx, circ.cy, localPoints);
      }

      if (inside) {
        const r = Math.max(0.3, circ.r);
        if (circ.filled) {
          page.drawCircle({
            x: localPdfX(circ.cx),
            y: localPdfY(circ.cy),
            size: r,
            color: stroke.rgbColor,
            opacity: stroke.alpha,
          });
        } else {
          page.drawCircle({
            x: localPdfX(circ.cx),
            y: localPdfY(circ.cy),
            size: r,
            borderColor: stroke.rgbColor,
            borderWidth: thickness,
            borderOpacity: stroke.alpha,
          });
        }
      }
    }

    page.pushOperators(popGraphicsState());
  } else {
    let xMin = shape.x, xMax = shape.x + (shape.width || 0);
    let yMin = shape.y, yMax = shape.y + (shape.height || 0);
    if (shape.type === 'circle') {
      const rx = shape.width !== undefined ? shape.width / 2 : (shape.radius || 0);
      const ry = shape.height !== undefined ? shape.height / 2 : (shape.radius || 0);
      xMin = shape.x - rx; xMax = shape.x + rx;
      yMin = shape.y - ry; yMax = shape.y + ry;
    } else if (shape.points) {
      xMin = Math.min(...shape.points.filter((_, i) => i % 2 === 0));
      xMax = Math.max(...shape.points.filter((_, i) => i % 2 === 0));
      yMin = Math.min(...shape.points.filter((_, i) => i % 2 === 1));
      yMax = Math.max(...shape.points.filter((_, i) => i % 2 === 1));
    }

    const { lines, circles } = generateHatchPrimitives(xMin, yMin, xMax, yMax, patternId, pScale);

    // Draw lines
    for (const line of lines) {
      if (shape.type === 'rect') {
        const clipped = clipLineToRect(line.x1, line.y1, line.x2, line.y2, xMin, yMin, xMax, yMax);
        if (clipped) {
          page.drawLine({
            start: { x: pdfX(clipped[0]), y: pdfY(clipped[1]) },
            end: { x: pdfX(clipped[2]), y: pdfY(clipped[3]) },
            color: stroke.rgbColor,
            thickness,
            opacity: stroke.alpha,
          });
        }
      } else if (shape.type === 'circle') {
        const rx = shape.width !== undefined ? shape.width / 2 : (shape.radius || 0);
        const ry = shape.height !== undefined ? shape.height / 2 : (shape.radius || 0);
        const clipped = clipLineToEllipse(line.x1, line.y1, line.x2, line.y2, shape.x, shape.y, rx, ry, 0);
        if (clipped) {
          page.drawLine({
            start: { x: pdfX(clipped[0]), y: pdfY(clipped[1]) },
            end: { x: pdfX(clipped[2]), y: pdfY(clipped[3]) },
            color: stroke.rgbColor,
            thickness,
            opacity: stroke.alpha,
          });
        }
      } else if (shape.points) {
        const segments = clipSegmentToPolygon(line.x1, line.y1, line.x2, line.y2, shape.points);
        for (const seg of segments) {
          page.drawLine({
            start: { x: pdfX(seg[0]), y: pdfY(seg[1]) },
            end: { x: pdfX(seg[2]), y: pdfY(seg[3]) },
            color: stroke.rgbColor,
            thickness,
            opacity: stroke.alpha,
          });
        }
      }
    }

    // Draw circles / dots
    for (const circ of circles) {
      let inside = false;
      if (shape.type === 'rect') {
        inside = circ.cx >= xMin && circ.cx <= xMax && circ.cy >= yMin && circ.cy <= yMax;
      } else if (shape.type === 'circle') {
        const rx = shape.width !== undefined ? shape.width / 2 : (shape.radius || 0);
        const ry = shape.height !== undefined ? shape.height / 2 : (shape.radius || 0);
        const dx = (circ.cx - shape.x) / (rx || 1);
        const dy = (circ.cy - shape.y) / (ry || 1);
        inside = (dx * dx + dy * dy) <= 1;
      } else if (shape.points) {
        inside = isPointInPolygon(circ.cx, circ.cy, shape.points);
      }

      if (inside) {
        const r = Math.max(0.3, circ.r);
        if (circ.filled) {
          page.drawCircle({
            x: pdfX(circ.cx),
            y: pdfY(circ.cy),
            size: r,
            color: stroke.rgbColor,
            opacity: stroke.alpha,
          });
        } else {
          page.drawCircle({
            x: pdfX(circ.cx),
            y: pdfY(circ.cy),
            size: r,
            borderColor: stroke.rgbColor,
            borderWidth: thickness,
            borderOpacity: stroke.alpha,
          });
        }
      }
    }
  }
}

