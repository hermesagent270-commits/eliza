/**
 * React context + per-slot wrapper carrying a routed view's lifecycle identity
 * down to `useViewLifecycle` (issue #10202).
 *
 * Split from `view-lifecycle.ts` (the controller singleton) so this file holds
 * only React/JSX and stays Fast-Refresh-friendly. `KeepAliveViewHost` renders
 * one `ViewLifecycleSlot` per retained view; the slot provides the context,
 * applies the hidden/inert presentation when the view is not the active one,
 * and registers the view with the controller on mount.
 */

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { cn } from "../lib/utils";
import { viewLifecycleController } from "./view-lifecycle";
import type { ViewLifecycleListener } from "./view-lifecycle-types";

export interface ViewLifecycleSlotValue {
  viewId: string;
  /** Subscribe to this view's phase transitions (the controller's per-view bus). */
  subscribe: (listener: ViewLifecycleListener) => () => void;
}

export const ViewLifecycleSlotContext =
  createContext<ViewLifecycleSlotValue | null>(null);

/** Read the nearest slot value, or `null` outside a `ViewLifecycleSlot`. */
export function useViewLifecycleSlot(): ViewLifecycleSlotValue | null {
  return useContext(ViewLifecycleSlotContext);
}

export interface ViewLifecycleSlotProps {
  viewId: string;
  /** When true the slot is retained-but-hidden: display:none + inert + aria-hidden. */
  hidden: boolean;
  children: ReactNode;
}

/**
 * One retained view slot. Provides the lifecycle context, registers the view
 * with the controller for its lifetime, and presents itself hidden+inert when
 * it is not the active view so a retained subtree cannot steal focus, be tabbed
 * into, or paint over the active view.
 */
export function ViewLifecycleSlot({
  viewId,
  hidden,
  children,
}: ViewLifecycleSlotProps): React.JSX.Element {
  const [isHiding, setIsHiding] = useState(hidden);

  useEffect(() => {
    viewLifecycleController.register(viewId);
  }, [viewId]);

  useEffect(() => {
    if (hidden) {
      const timer = setTimeout(() => {
        setIsHiding(true);
      }, 180);
      return () => clearTimeout(timer);
    }
    setIsHiding(false);
  }, [hidden]);

  const value = useMemo<ViewLifecycleSlotValue>(
    () => ({
      viewId,
      subscribe: (listener) =>
        viewLifecycleController.subscribeView(viewId, listener),
    }),
    [viewId],
  );

  const effectivelyHidden = hidden && isHiding;

  return (
    <ViewLifecycleSlotContext.Provider value={value}>
      <div
        data-view-lifecycle-slot={viewId}
        data-view-hidden={hidden ? "true" : "false"}
        {...(effectivelyHidden ? { inert: true } : {})}
        aria-hidden={effectivelyHidden ? "true" : undefined}
        style={effectivelyHidden ? { display: "none" } : undefined}
        className={cn(
          "flex flex-col flex-1 min-h-0 min-w-0 w-full transition-transform",
          !hidden && "motion-safe:animate-window-maximize",
          hidden && !effectivelyHidden && "motion-safe:animate-window-minimize pointer-events-none",
        )}
      >
        {children}
      </div>
    </ViewLifecycleSlotContext.Provider>
  );
}

