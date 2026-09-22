import { useEffect, useState } from 'react';
import qrcode from '../lib/qrcode';

// 把 qrcode 生成器挂到 window 上以供 App 同步调用（避免异步 ref 抖动）
declare global { interface Window { __qrcodeLazy: any; } }

export function useQrcodeReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (typeof window !== 'undefined' && !window.__qrcodeLazy) {
      window.__qrcodeLazy = qrcode;
      setReady(true);
    } else {
      setReady(true);
    }
  }, []);
  return ready;
}