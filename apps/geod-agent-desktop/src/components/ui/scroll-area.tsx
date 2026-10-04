import * as Primitive from "@radix-ui/react-scroll-area";
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

export const ScrollAreaRoot = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof Primitive.Root>>(
  function ScrollAreaRoot({ className, ...props }, ref) {
    return <Primitive.Root ref={ref} type="hover" scrollHideDelay={650} className={cn("geod-scroll-area", className)} {...props}/>;
  },
);

export const ScrollAreaViewport = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof Primitive.Viewport>>(
  function ScrollAreaViewport({ className, ...props }, ref) {
    return <Primitive.Viewport ref={ref} tabIndex={0} className={cn("geod-scroll-viewport", className)} {...props}/>;
  },
);

export function ScrollAreaScrollbar() {
  return <Primitive.Scrollbar orientation="vertical" className="geod-scrollbar">
    <Primitive.Thumb className="geod-scrollbar-thumb"/>
  </Primitive.Scrollbar>;
}

export function ScrollArea({ children, className, viewportClassName, viewportProps, ...props }: ComponentPropsWithoutRef<typeof Primitive.Root> & {
  viewportClassName?: string;
  viewportProps?: ComponentPropsWithoutRef<typeof Primitive.Viewport>;
}) {
  return <ScrollAreaRoot className={className} {...props}>
    <ScrollAreaViewport className={viewportClassName} {...viewportProps}>{children}</ScrollAreaViewport>
    <ScrollAreaScrollbar/>
  </ScrollAreaRoot>;
}
