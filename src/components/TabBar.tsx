// ─────────────────────────────────────────────────────────────────────────────
// TabBar.tsx — Phase 2: Tab Bar Layout Skeleton
//
// Pure presentational component. Reads `tabMetas`, `activeTabId` from the
// Zustand store and renders one pill per open document. All store write-ops
// (setActiveTab, closeTab, openTab) are wired but produce no canvas effects
// in Phase 2 — that lifecycle management lives in Phase 3's DocumentViewer.
//
// Design intentionally matches the existing app chrome:
//   - Same background as the OS-style menu bar (#111213)
//   - Active tab: 2px blue bottom border + slightly lighter background
//   - Close button fades in on row hover (Bluebeam-style)
//   - Dirty indicator (•) in blue when TabMeta.isDirty is true
// ─────────────────────────────────────────────────────────────────────────────

import { useStore } from '../store/useStore';

interface TabBarProps {
  /** Called when the ‘+’ new-tab button is clicked.
   *  Parent is responsible for opening the dialog or creating the new tab. */
  onNewTab?: () => void;
}

export function TabBar({ onNewTab }: TabBarProps) {
  // Use individual selectors so each only re-renders when its slice changes.
  // Actions (setActiveTab, closeTab, openTab) are stable function references
  // in Zustand — they never trigger re-renders when selected.
  const tabMetas   = useStore((s) => s.tabMetas);
  const activeTabId = useStore((s) => s.activeTabId);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const closeTab     = useStore((s) => s.closeTab);
  const savingStatusMap = useStore((s) => s.savingStatus);

  // Preserve insertion order of tabs (Object.keys respects it for string keys).
  const tabIds = Object.keys(tabMetas);

  const handleNewTab = () => {
    // Delegate to parent — App.tsx shows the NewDocumentDialog,
    // which calls handleNewBlankDocument, which calls openTab.
    onNewTab?.();
  };

  const handleClose = (e: React.MouseEvent, tabId: string) => {
    // Stop propagation so the click doesn't also fire setActiveTab on the pill.
    e.stopPropagation();
    closeTab(tabId);
  };

  return (
    <div className="tab-bar">
      <style>{`
        @keyframes tab-spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
      {/* Scrollable strip of tab pills */}
      <div className="tab-strip">
        {tabIds.map((tabId) => {
          const meta     = tabMetas[tabId];
          const isActive = tabId === activeTabId;
          const savingStatus = savingStatusMap[tabId];
          return (
            <div
              key={tabId}
              className={`tab-pill${isActive ? ' active' : ''}`}
              onClick={() => setActiveTab(tabId)}
              title={meta.label}
              role="tab"
              aria-selected={isActive}
            >
              {savingStatus && (
                <span 
                  className="tab-pill-saving-spinner" 
                  title={`Saving... ${savingStatus.progress}%`} 
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    border: '1.5px solid rgba(77, 166, 255, 0.2)',
                    borderTopColor: '#4da6ff',
                    animation: 'tab-spin 1s linear infinite',
                    display: 'inline-block',
                    flexShrink: 0,
                    marginRight: 4,
                  }} 
                />
              )}
              <span className="tab-pill-label">{meta.label}</span>

              {/* Unsaved-changes indicator */}
              {meta.isDirty && !savingStatus && (
                <span className="tab-pill-dirty" aria-label="Unsaved changes">
                  *
                </span>
              )}

              {/* Close button — visible on hover via CSS */}
              <button
                className="tab-pill-close"
                onClick={(e) => handleClose(e, tabId)}
                title={`Close ${meta.label}`}
                aria-label={`Close ${meta.label}`}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      {/* New-tab button */}
      <button
        className="tab-new-btn"
        onClick={handleNewTab}
        title="Open new blank tab"
        aria-label="Open new blank tab"
      >
        +
      </button>
    </div>
  );
}
