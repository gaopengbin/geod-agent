import { useLayoutEffect, useRef, useState } from "react";

// Observe the page itself so a resized navigation panel also changes detail layout.
export function usePageWidth() {
  const ref = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const page = ref.current;
    if (!page) return;
    const update = () => { if (page.clientWidth > 0) setCompact(page.clientWidth <= 1000); };
    update();
    const observer = new ResizeObserver(update); observer.observe(page);
    return () => observer.disconnect();
  }, []);
  return { ref, compact };
}
