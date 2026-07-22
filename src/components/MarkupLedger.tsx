import { useState } from 'react';
import { useStore } from '../store/useStore';

export function MarkupLedger() {
  const [isMinimized, setIsMinimized] = useState(true);
  const [sortConfig, setSortConfig] = useState<{ key: string, direction: 'asc' | 'desc' } | null>(null);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [commentBuffer, setCommentBuffer] = useState<string>('');
  const [showAllMarkups, setShowAllMarkups] = useState(false);
  
  const { activeTabId, documents, setSelectedShapeIds, deleteShape, updateShape } = useStore();
  const doc = activeTabId ? documents[activeTabId] : null;
  const shapes = doc?.shapes || [];
  const selectedShapeIds = doc?.selectedShapeIds || [];

  const isSpread = doc?.isSpread || false;
  const activeSpreadIndex = doc?.activeSpreadIndex || 0;
  const hasFrontCover = doc?.hasFrontCover || false;
  
  const leftPage = hasFrontCover
    ? (activeSpreadIndex === 0 ? 1 : activeSpreadIndex * 2)
    : activeSpreadIndex * 2 + 1;
  const rightPage = leftPage + 1;

  const visiblePages = isSpread 
    ? (hasFrontCover && activeSpreadIndex === 0 ? [1] : [leftPage, rightPage])
    : [doc?.pageNum || 1];

  const displayShapes = showAllMarkups 
    ? shapes 
    : shapes.filter(shape => visiblePages.includes(shape.page));

  const sortedShapes = [...displayShapes].sort((a, b) => {
    if (!sortConfig) return 0;
    const { key, direction } = sortConfig;
    const aVal = (a as any)[key];
    const bVal = (b as any)[key];
    if (aVal < bVal) return direction === 'asc' ? -1 : 1;
    if (aVal > bVal) return direction === 'asc' ? 1 : -1;
    return 0;
  });

  const handleSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const handleRowClick = (id: string) => {
    setSelectedShapeIds([id]);
    // Here we could elegantly animate viewport scrolling toward the shape.y coordinate
  };

  return (
    <div className={`markup-ledger ${isMinimized ? 'minimized' : 'expanded'}`}>
      <div className="ledger-header">
        <div className="ledger-header-left" onClick={() => setIsMinimized(!isMinimized)}>
          <span className="collapse-icon" style={{ transform: isMinimized ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▼</span>
          <h3>Markup Ledger</h3>
          <span className="markup-count">
            ({displayShapes.length} {displayShapes.length === 1 ? 'Markup' : 'Markups'})
          </span>
        </div>
        
        <div className="ledger-controls">
          <label>
            <input 
              type="checkbox" 
              checked={showAllMarkups} 
              onChange={(e) => setShowAllMarkups(e.target.checked)} 
            />
            Show all in document
          </label>
        </div>
      </div>
      
      {!isMinimized && (
        <div className="ledger-table-container">
          <table className="ledger-table">
            <thead>
              <tr>
                <th onClick={() => handleSort('type')}>Subject {sortConfig?.key === 'type' ? (sortConfig.direction === 'asc' ? '↑' : '↓') : ''}</th>
                <th onClick={() => handleSort('page')}>Page {sortConfig?.key === 'page' ? (sortConfig.direction === 'asc' ? '↑' : '↓') : ''}</th>
                <th onClick={() => handleSort('author')}>Author {sortConfig?.key === 'author' ? (sortConfig.direction === 'asc' ? '↑' : '↓') : ''}</th>
                <th onClick={() => handleSort('date')}>Date {sortConfig?.key === 'date' ? (sortConfig.direction === 'asc' ? '↑' : '↓') : ''}</th>
                <th>Color</th>
                <th>Comments</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {displayShapes.length === 0 ? (
                <tr><td colSpan={7} style={{textAlign:'center', padding:'30px', color: '#888'}}>No markups found on {showAllMarkups ? 'this document' : (isSpread ? 'this spread' : 'this page')}.</td></tr>
              ) : (
                sortedShapes.map(shape => (
                  <tr 
                    key={shape.id} 
                    className={selectedShapeIds.includes(shape.id) ? 'selected-row' : ''}
                    onClick={() => handleRowClick(shape.id)}
                  >
                    <td style={{textTransform:'capitalize'}}>{shape.type}</td>
                    <td>{shape.page}</td>
                    <td>{shape.author}</td>
                    <td>{shape.date}</td>
                    <td>
                      <div style={{display:'flex', alignItems:'center', gap:'8px'}}>
                        <span className="color-swatch" style={{backgroundColor: shape.strokeColor}} />
                        {shape.strokeColor}
                      </div>
                    </td>
                    <td 
                      onDoubleClick={(e) => { e.stopPropagation(); setEditingCommentId(shape.id); setCommentBuffer(shape.comments || ''); }}
                      title="Double click to map notes directly to this vector"
                    >
                      {editingCommentId === shape.id ? (
                        <input 
                          autoFocus
                          value={commentBuffer}
                          onChange={e => setCommentBuffer(e.target.value)}
                          onBlur={() => { updateShape(shape.id, { comments: commentBuffer }); setEditingCommentId(null); }}
                          onKeyDown={e => { if (e.key === 'Enter') { updateShape(shape.id, { comments: commentBuffer }); setEditingCommentId(null); } }}
                          style={{ width: '100%', background: '#111', color: '#fff', border: '1px solid #444', padding: '4px', borderRadius: '4px' }}
                        />
                      ) : (
                        shape.comments || <i style={{color:'#666'}}>Double click to add...</i>
                      )}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                       <button 
                         onClick={(e) => { e.stopPropagation(); deleteShape(shape.id); }} 
                         className="ledger-delete-btn"
                         title="Delete Markup"
                       >
                         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                           <polyline points="3 6 5 6 21 6"></polyline>
                           <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                         </svg>
                       </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
