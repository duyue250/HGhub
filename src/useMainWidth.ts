import { useLayoutEffect, useRef, useState } from "react";

/** 主内容区宽度观察：移动端 AppBody 与桌面 ShellInner 共用，避免两份逐字相同的 ResizeObserver。 */
export function useMainWidth(initial = true) {
  const ref = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth > 640));
    ro.observe(el);
    setWide(el.clientWidth > 640);
    return () => ro.disconnect();
  }, []);
  return { ref, wide };
}
