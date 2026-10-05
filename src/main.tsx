import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { useStore } from './store/useStore'

import { invoke } from '@tauri-apps/api/core';

// Expose store to window for console access/testing
(window as any).useStore = useStore;

invoke('debug_log', { msg: 'React application mounted inside WebView2!' })
  .catch(err => console.error('Failed to send debug log:', err));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
