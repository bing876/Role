import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import qrcode from './lib/qrcode';
import './styles/index.css';

// qrcode-generator 是 1:1 搬过来的同步 API（无副作用、可立即挂到 window，
// 让 App 里 makeQrDataUrl 能同步生成二维码 dataURL）。
if (typeof window !== 'undefined') {
  (window as unknown as { __qrcodeLazy: unknown }).__qrcodeLazy = qrcode;
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);