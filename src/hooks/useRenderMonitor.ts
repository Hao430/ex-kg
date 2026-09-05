import { useEffect, useRef, useState } from 'react';

export function useRenderMonitor(componentName: string) {
  const renderCount = useRef(0);
  const lastRenderTime = useRef(Date.now());
  const [warning, setWarning] = useState<string | null>(null);
  const warnedRef = useRef(false);

  useEffect(() => {
    const now = Date.now();
    renderCount.current += 1;

    // Evaluate every 1000ms
    if (now - lastRenderTime.current > 1000) {
      // If we render more than 60 times a second, it's a loop or very heavy render
      if (renderCount.current > 60 && !warnedRef.current) {
        console.warn(`[Performance Warning] ${componentName} is rendering too frequently: ${renderCount.current} renders/sec`);
        setWarning(`检测到局部渲染频率过高，为避免卡顿已进行节流保护。`);
        warnedRef.current = true;
        // Auto dismiss after 4s
        setTimeout(() => {
          setWarning(null);
          warnedRef.current = false;
        }, 4000);
      }
      renderCount.current = 0;
      lastRenderTime.current = now;
    }
  });

  return warning;
}
