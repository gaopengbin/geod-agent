"use client";

import {
  type MutableRefObject,
  useCallback,
  useLayoutEffect,
  useState,
} from "react";

export type PortalLayout = {
  viewport: { width: number; height: number };
  trigger: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  content: {
    width: number;
    height: number;
  };
};

function sameLayout(a: PortalLayout | null, b: PortalLayout) {
  return (
    a?.viewport.width === b.viewport.width &&
    a.viewport.height === b.viewport.height &&
    a?.trigger.left === b.trigger.left &&
    a.trigger.top === b.trigger.top &&
    a.trigger.width === b.trigger.width &&
    a.trigger.height === b.trigger.height &&
    a.content.width === b.content.width &&
    a.content.height === b.content.height
  );
}

/** Keep the measured panel in the viewport, flipping when the other side fits. */
export function placePopover(layout: PortalLayout, side: "top" | "bottom", align: "start" | "end", gap = 8, edge = 12) {
  const { trigger, content, viewport } = layout;
  const width = Math.min(content.width, viewport.width - edge * 2);
  const height = Math.min(content.height, viewport.height - edge * 2);
  const above = trigger.top - gap - edge;
  const below = viewport.height - trigger.top - trigger.height - gap - edge;
  const resolvedSide = side === "top" && above < height && below > above ? "bottom"
    : side === "bottom" && below < height && above > below ? "top" : side;
  const preferredLeft = align === "end" ? trigger.left + trigger.width - width : trigger.left;
  const preferredTop = resolvedSide === "bottom" ? trigger.top + trigger.height + gap : trigger.top - height - gap;
  return {
    left: Math.max(edge, Math.min(preferredLeft, viewport.width - width - edge)),
    top: Math.max(edge, Math.min(preferredTop, viewport.height - height - edge)),
    side: resolvedSide,
  };
}

/** Measures a trigger and portalled panel in viewport coordinates. */
export function usePopoverPortalPosition<
  TriggerElement extends HTMLElement,
  ContentElement extends HTMLElement,
>(
  triggerRef: MutableRefObject<TriggerElement | null>,
  contentRef: MutableRefObject<ContentElement | null>,
  active: boolean,
) {
  const [layout, setLayout] = useState<PortalLayout | null>(null);

  const update = useCallback(() => {
    const trigger = triggerRef.current;
    const content = contentRef.current;
    if (!trigger || !content) return;

    const rect = trigger.getBoundingClientRect();
    const next: PortalLayout = {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      trigger: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
      content: {
        width: content.offsetWidth,
        height: content.offsetHeight,
      },
    };
    setLayout((current) => (sameLayout(current, next) ? current : next));
  }, [contentRef, triggerRef]);

  useLayoutEffect(() => {
    update();
    if (!active) return;

    const trigger = triggerRef.current;
    const content = contentRef.current;
    const observer = new ResizeObserver(update);
    if (trigger) observer.observe(trigger);
    if (content) observer.observe(content);

    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [active, contentRef, triggerRef, update]);

  return layout;
}
