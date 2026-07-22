import React, { useState } from 'react';
import { Group, Rect, Line, Text } from 'react-konva';
import type { ShapeData } from '../store/types';

interface TableRendererProps {
  shape: ShapeData;
  commonProps: any;
  updateShape: (id: string, updates: Partial<ShapeData>) => void;
  pushToHistory: () => void;
  isSelected?: boolean;
  onCellEdit?: (cellId: string, text: string, cx: number, cy: number, cw: number, ch: number) => void;
}

export function TableRenderer({ shape, commonProps, updateShape, pushToHistory, isSelected, onCellEdit }: TableRendererProps) {
  const table = shape.tableData;
  if (!table) return null;

  const [hoveredLine, setHoveredLine] = useState<{ type: 'row' | 'col'; index: number } | null>(null);
  const [draggingLine, setDraggingLine] = useState<{ type: 'row' | 'col'; index: number; pos: number } | null>(null);

  React.useEffect(() => {
    if (!isSelected && ((table.selectedCellIds && table.selectedCellIds.length > 0) || table.selectedLine)) {
      updateShape(shape.id, { tableData: { ...table, selectedCellIds: [], selectedLine: null } });
    }
  }, [isSelected, table, shape.id, updateShape]);

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

  const gridLines = [];

  // Vertical lines
  for (let i = 0; i <= table.cols; i++) {
    const x = colPositions[i];
    const thickness = table.colLineThicknesses?.[i] ?? table.borderThickness;
    gridLines.push(
      <Line
        key={`vline-${i}`}
        points={[x, 0, x, tableHeight]}
        stroke={shape.strokeColor || '#000'}
        strokeWidth={thickness}
      />
    );

    // Interactive overlay line for line selection
    if (isSelected) {
      gridLines.push(
        <Line
          key={`vline-click-${i}`}
          points={[x, 0, x, tableHeight]}
          stroke="transparent"
          strokeWidth={10}
          onClick={(e) => {
            e.cancelBubble = true;
            pushToHistory();
            updateShape(shape.id, {
              tableData: {
                ...table,
                selectedLine: { type: 'col', index: i },
                selectedCellIds: []
              }
            });
          }}
          onMouseEnter={(e) => {
            const container = e.target.getStage()?.container();
            if (container) container.style.cursor = 'pointer';
          }}
          onMouseLeave={(e) => {
            const container = e.target.getStage()?.container();
            if (container) container.style.cursor = 'default';
          }}
        />
      );
    }
  }

  // Horizontal lines
  for (let i = 0; i <= table.rows; i++) {
    const y = rowPositions[i];
    const thickness = table.rowLineThicknesses?.[i] ?? table.borderThickness;
    gridLines.push(
      <Line
        key={`hline-${i}`}
        points={[0, y, tableWidth, y]}
        stroke={shape.strokeColor || '#000'}
        strokeWidth={thickness}
      />
    );

    // Interactive overlay line for line selection
    if (isSelected) {
      gridLines.push(
        <Line
          key={`hline-click-${i}`}
          points={[0, y, tableWidth, y]}
          stroke="transparent"
          strokeWidth={10}
          onClick={(e) => {
            e.cancelBubble = true;
            pushToHistory();
            updateShape(shape.id, {
              tableData: {
                ...table,
                selectedLine: { type: 'row', index: i },
                selectedCellIds: []
              }
            });
          }}
          onMouseEnter={(e) => {
            const container = e.target.getStage()?.container();
            if (container) container.style.cursor = 'pointer';
          }}
          onMouseLeave={(e) => {
            const container = e.target.getStage()?.container();
            if (container) container.style.cursor = 'default';
          }}
        />
      );
    }
  }

  const handleDragLine = (e: any, type: 'col' | 'row', index: number) => {
    e.cancelBubble = true;
    const delta = type === 'col' ? e.target.x() - colPositions[index] : e.target.y() - rowPositions[index];
    
    // reset position of invisible line
    e.target.x(type === 'col' ? colPositions[index] : 0);
    e.target.y(type === 'row' ? rowPositions[index] : 0);

    if (Math.abs(delta) < 1) return;
    
    const newTable = { ...table };
    if (type === 'col') {
      const newWidths = [...table.colWidths];
      newWidths[index - 1] = Math.max(10, newWidths[index - 1] + delta);
      newTable.colWidths = newWidths;
    } else {
      const newHeights = [...table.rowHeights];
      newHeights[index - 1] = Math.max(10, newHeights[index - 1] + delta);
      newTable.rowHeights = newHeights;
    }
    
    const newTotalW = newTable.colWidths.reduce((a, b) => a + b, 0);
    const newTotalH = newTable.rowHeights.reduce((a, b) => a + b, 0);
    
    updateShape(shape.id, { tableData: newTable, width: newTotalW, height: newTotalH });
  };

  const draggers = [];
  // Column draggers
  for (let i = 1; i < table.cols; i++) {
    const x = colPositions[i];
    draggers.push(
      <Rect
        key={`drag-col-${i}`}
        x={x - 4} y={0}
        width={8} height={tableHeight}
        fill="transparent"
        draggable
        onDragStart={() => { pushToHistory(); setDraggingLine({ type: 'col', index: i, pos: x }); }}
        onDragMove={(e) => {
          e.target.y(0); // constrain vertical
          setDraggingLine({ type: 'col', index: i, pos: e.target.x() });
        }}
        onDragEnd={(e) => {
          setDraggingLine(null);
          handleDragLine(e, 'col', i);
        }}
        onMouseEnter={(e) => {
          const container = e.target.getStage()?.container();
          if (container) container.style.cursor = 'col-resize';
          setHoveredLine({ type: 'col', index: i });
        }}
        onMouseLeave={(e) => {
          const container = e.target.getStage()?.container();
          if (container) container.style.cursor = 'default';
          setHoveredLine(null);
        }}
      />
    );
  }

  // Row draggers
  for (let i = 1; i < table.rows; i++) {
    const y = rowPositions[i];
    draggers.push(
      <Rect
        key={`drag-row-${i}`}
        x={0} y={y - 4}
        width={tableWidth} height={8}
        fill="transparent"
        draggable
        onDragStart={() => { pushToHistory(); setDraggingLine({ type: 'row', index: i, pos: y }); }}
        onDragMove={(e) => {
          e.target.x(0); // constrain horizontal
          setDraggingLine({ type: 'row', index: i, pos: e.target.y() });
        }}
        onDragEnd={(e) => {
          setDraggingLine(null);
          handleDragLine(e, 'row', i);
        }}
        onMouseEnter={(e) => {
          const container = e.target.getStage()?.container();
          if (container) container.style.cursor = 'row-resize';
          setHoveredLine({ type: 'row', index: i });
        }}
        onMouseLeave={(e) => {
          const container = e.target.getStage()?.container();
          if (container) container.style.cursor = 'default';
          setHoveredLine(null);
        }}
      />
    );
  }

  const cells = [];
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

      const displayText = cell?.text || '';
      const isCellSelected = table.selectedCellIds?.includes(cellId);

      cells.push(
        <Group
          key={`cell-${cellId}`}
          x={cx} y={cy}
          onClick={(e) => {
            if (isSelected) {
              e.cancelBubble = true;
              // Clear line selection when a cell is clicked
              const tableUpdates: any = { selectedCellIds: [] };
              if (e.evt.shiftKey || e.evt.ctrlKey) {
                const prev = table.selectedCellIds || [];
                const next = prev.includes(cellId) ? prev.filter(id => id !== cellId) : [...prev, cellId];
                tableUpdates.selectedCellIds = next;
              } else {
                tableUpdates.selectedCellIds = [cellId];
              }
              if (table.selectedLine) {
                tableUpdates.selectedLine = null;
              }
              updateShape(shape.id, { tableData: { ...table, ...tableUpdates } });
              
              if (!e.evt.shiftKey && !e.evt.ctrlKey && onCellEdit) {
                onCellEdit(cellId, displayText, cx, cy, cw, ch);
              }
            } else {
              if (commonProps.onClick) {
                commonProps.onClick(e);
              }
            }
          }}
          onDblClick={(e) => {
            e.cancelBubble = true;
            if (!isSelected) {
              updateShape(shape.id, { tableData: { ...table, selectedCellIds: [cellId], selectedLine: null } });
              if (onCellEdit) {
                onCellEdit(cellId, displayText, cx, cy, cw, ch);
              }
            }
          }}
        >
          <Rect
            width={cw} height={ch}
            fill={cell?.fillColor || shape.fillColor || 'transparent'}
          />
          {isCellSelected && (
            <Rect
              width={cw} height={ch}
              fill="rgba(77, 166, 255, 0.2)"
              stroke="#4da6ff"
              strokeWidth={2}
              listening={false}
            />
          )}
          {displayText && (
            <Text
              x={2} y={2}
              width={cw - 4} height={ch - 4}
              text={displayText}
              fill={cell?.strokeColor || shape.strokeColor || '#000'}
              fontFamily={cell?.fontFamily || shape.fontFamily || 'Inter'}
              fontSize={cell?.fontSize || shape.fontSize || 12}
              fontStyle={`${cell?.isItalic ?? shape.isItalic ? 'italic ' : ''}${cell?.isBold ?? shape.isBold ? 'bold ' : ''}`.trim() || undefined}
              textDecoration={`${cell?.isUnderline ?? shape.isUnderline ? 'underline ' : ''}${cell?.isStrike ?? shape.isStrike ? 'line-through' : ''}`.trim() || undefined}
              align={cell?.hAlign || 'left'}
              verticalAlign={cell?.vAlign || 'middle'}
              wrap={cell?.wrapText ? 'word' : 'none'}
              ellipsis={!cell?.wrapText}
              listening={false} // pass clicks through to group
            />
          )}
          {/* Note: In a full implementation, Image overlay would go here */}
        </Group>
      );
    }
  }

  return (
    <Group key={shape.id} {...commonProps} x={shape.x} y={shape.y} rotation={shape.rotation} scaleX={visualScaleX} scaleY={visualScaleY}>
      {cells}
      {gridLines}
      {/* Draw selected line highlights */}
      {isSelected && table.selectedLine && table.selectedLine.type === 'col' && (
        <Line
          points={[colPositions[table.selectedLine.index], 0, colPositions[table.selectedLine.index], tableHeight]}
          stroke="#4da6ff"
          strokeWidth={3}
        />
      )}
      {isSelected && table.selectedLine && table.selectedLine.type === 'row' && (
        <Line
          points={[0, rowPositions[table.selectedLine.index], tableWidth, rowPositions[table.selectedLine.index]]}
          stroke="#4da6ff"
          strokeWidth={3}
        />
      )}
      {/* Draw drag highlights */}
      {hoveredLine && hoveredLine.type === 'col' && (
        <Line points={[colPositions[hoveredLine.index], 0, colPositions[hoveredLine.index], tableHeight]} stroke="#4da6ff" strokeWidth={3} />
      )}
      {hoveredLine && hoveredLine.type === 'row' && (
        <Line points={[0, rowPositions[hoveredLine.index], tableWidth, rowPositions[hoveredLine.index]]} stroke="#4da6ff" strokeWidth={3} />
      )}
      {/* Draw active drag line */}
      {draggingLine && draggingLine.type === 'col' && (
        <Line points={[draggingLine.pos, 0, draggingLine.pos, tableHeight]} stroke="#ff4d4d" strokeWidth={2} dash={[5, 5]} />
      )}
      {draggingLine && draggingLine.type === 'row' && (
        <Line points={[0, draggingLine.pos, tableWidth, draggingLine.pos]} stroke="#ff4d4d" strokeWidth={2} dash={[5, 5]} />
      )}
      {isSelected && draggers}
    </Group>
  );
}
