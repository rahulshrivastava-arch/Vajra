import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

export function CaptureOverlay() {
  const [bgImage, setBgImage] = useState<string | null>(null);
  const [bgImgEl, setBgImgEl] = useState<HTMLImageElement | null>(null);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Retrieve the pre-captured screen for this monitor from the Rust cache
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const monitorName = params.get('monitorName');

    if (!monitorName) {
      setError('Missing monitorName parameter');
      return;
    }

    invoke<string>('get_monitor_capture', { monitorName })
      .then(b64 => {
        setBgImage(b64);
        // Pre-load the image element so we can canvas-crop it at selection time
        const img = new Image();
        img.onload = () => setBgImgEl(img);
        img.src = b64;
      })
      .catch(err => {
        console.error('Failed to retrieve monitor capture:', err);
        setError(String(err));
        setTimeout(() => getCurrentWindow().close(), 2000);
      });
  }, []);

  const handleDown = (e: React.MouseEvent) => {
    if (!bgImage) return;
    setIsDragging(true);
    setRect({ x: e.clientX, y: e.clientY, w: 0, h: 0 });
  };

  const handleMove = (e: React.MouseEvent) => {
    if (!isDragging || !rect) return;
    setRect({ ...rect, w: e.clientX - rect.x, h: e.clientY - rect.y });
  };

  const handleUp = async () => {
    if (!isDragging || !rect || !bgImgEl) return;
    setIsDragging(false);

    const selW = Math.abs(rect.w);
    const selH = Math.abs(rect.h);

    if (selW > 5 && selH > 5) {
      // Logical-pixel selection origin
      const logX = rect.w < 0 ? rect.x + rect.w : rect.x;
      const logY = rect.h < 0 ? rect.y + rect.h : rect.y;

      // The xcap screenshot is at PHYSICAL pixels; the overlay is sized in LOGICAL pixels.
      // Scale factor: physical image width ÷ logical viewport width
      const scaleX = bgImgEl.naturalWidth  / window.innerWidth;
      const scaleY = bgImgEl.naturalHeight / window.innerHeight;

      const physX = Math.round(logX * scaleX);
      const physY = Math.round(logY * scaleY);
      const physW = Math.round(selW * scaleX);
      const physH = Math.round(selH * scaleY);

      // Crop the exact region onto a canvas and export as JPEG
      const canvas = document.createElement('canvas');
      canvas.width  = physW;
      canvas.height = physH;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bgImgEl, physX, physY, physW, physH, 0, 0, physW, physH);
      const croppedDataUrl = canvas.toDataURL('image/jpeg', 0.92);

      await emit('snippet-completed', {
        image: croppedDataUrl,
        // w/h in logical pixels for canvas placement
        w: selW,
        h: selH,
      });
    } else {
      await emit('snippet-cancelled');
    }

    await getCurrentWindow().close();
  };

  if (error) {
    return (
      <div style={{ width: '100vw', height: '100vh', background: 'rgba(255,0,0,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '20px' }}>
        Capture Error: {error}
      </div>
    );
  }

  if (!bgImage) {
    return <div style={{ width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.1)', cursor: 'wait' }} />;
  }

  return (
    <div
      style={{
        width: '100vw', height: '100vh',
        backgroundImage: `url(${bgImage})`, backgroundSize: '100% 100%',
        cursor: 'crosshair', position: 'relative', overflow: 'hidden',
        userSelect: 'none',
      }}
      onMouseDown={handleDown}
      onMouseMove={handleMove}
      onMouseUp={handleUp}
    >
      {/* Dim overlay everywhere EXCEPT the selection box */}
      {rect ? (
        <>
          {/* top */}
          <div style={{ position: 'absolute', left: 0, top: 0, right: 0, height: rect.h < 0 ? rect.y + rect.h : rect.y, background: 'rgba(0,0,0,0.45)', pointerEvents: 'none' }} />
          {/* bottom */}
          <div style={{ position: 'absolute', left: 0, bottom: 0, right: 0, top: (rect.h < 0 ? rect.y + rect.h : rect.y) + Math.abs(rect.h), background: 'rgba(0,0,0,0.45)', pointerEvents: 'none' }} />
          {/* left */}
          <div style={{ position: 'absolute', left: 0, top: rect.h < 0 ? rect.y + rect.h : rect.y, width: rect.w < 0 ? rect.x + rect.w : rect.x, height: Math.abs(rect.h), background: 'rgba(0,0,0,0.45)', pointerEvents: 'none' }} />
          {/* right */}
          <div style={{ position: 'absolute', right: 0, top: rect.h < 0 ? rect.y + rect.h : rect.y, left: (rect.w < 0 ? rect.x + rect.w : rect.x) + Math.abs(rect.w), height: Math.abs(rect.h), background: 'rgba(0,0,0,0.45)', pointerEvents: 'none' }} />
        </>
      ) : (
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', pointerEvents: 'none' }} />
      )}

      {/* Instruction hint */}
      <div style={{
        position: 'absolute', top: '12px', left: '50%', transform: 'translateX(-50%)',
        background: 'rgba(0,0,0,0.85)', color: '#e0e0e0', padding: '6px 16px', borderRadius: '6px',
        fontSize: '12px', border: '1px solid #333', pointerEvents: 'none',
        boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
      }}>
        Click and drag to select a region · Release to capture
      </div>

      {/* Selection rectangle */}
      {rect && (
        <div style={{
          position: 'absolute',
          border: '1.5px solid #4da6ff',
          background: 'rgba(77,166,255,0.06)',
          left: rect.w < 0 ? rect.x + rect.w : rect.x,
          top:  rect.h < 0 ? rect.y + rect.h : rect.y,
          width: Math.abs(rect.w),
          height: Math.abs(rect.h),
          pointerEvents: 'none',
          boxShadow: '0 0 0 1px rgba(77,166,255,0.5)',
        }}>
          {/* Size badge */}
          <span style={{
            position: 'absolute', bottom: '-24px', right: 0,
            background: '#4da6ff', color: '#fff', padding: '2px 8px',
            fontSize: '11px', borderRadius: '4px', whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums',
          }}>
            {Math.round(Math.abs(rect.w))} × {Math.round(Math.abs(rect.h))} px
          </span>

          {/* Corner handles */}
          {[
            { top: -4, left: -4 }, { top: -4, right: -4 },
            { bottom: -4, left: -4 }, { bottom: -4, right: -4 },
          ].map((pos, i) => (
            <div key={i} style={{
              position: 'absolute', width: 8, height: 8, background: '#4da6ff',
              borderRadius: 1, ...pos,
            }} />
          ))}
        </div>
      )}
    </div>
  );
}
