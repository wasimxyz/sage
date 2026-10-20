import { ArrowLeftIcon, ChevronsRightIcon, Maximize2Icon } from "lucide-react";
import {
  createContext,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type PanelImperativeHandle,
  usePanelRef,
} from "react-resizable-panels";

import { onTitlebarPointerDown } from "@/components/app-titlebar";
import { Hint } from "@/components/hint";
import {
  PanelIconButton,
  panelIconHoverClass,
} from "@/components/panel-icon-button";
import { useScreenActive } from "@/components/screen-active";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Toggle } from "@/components/ui/toggle";
import { useIsMobile } from "@/hooks/use-mobile";
import { usePanelSpring } from "@/hooks/use-panel-spring";
import { useRememberedScroll } from "@/hooks/use-remembered-scroll";
import { hasOpenSurface } from "@/lib/open-surface";
import { pageColumnClass } from "@/lib/page-column";
import { shortcuts } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

/**
 * A list beside a panel that springs open, with a divider you can drag and a
 * full screen mode. Journal and Chat both use it. Each screen passes its own
 * state through `SplitView.Provider`, so the layout never knows whose it is.
 */
export interface SplitViewContextValue {
  actions: {
    setExpanded: (expanded: boolean) => void;
    setOpen: (open: boolean) => void;
  };
  meta: { id: string };
  state: { expanded: boolean; open: boolean };
}

const SplitViewContext = createContext<SplitViewContextValue | null>(null);

export function useSplitView(): SplitViewContextValue {
  const value = use(SplitViewContext);
  if (!value) {
    throw new Error("SplitView.Provider is missing.");
  }
  return value;
}

// The list sits a little further in than the other pages. The header and the
// rows share it, so the title stays lined up with the row text.
const listInsetClass = "px-8";

// Full screen puts the header buttons under the titlebar toggle. The padding
// follows the sidebar's slide, full when it is closed and none when it is
// open. It sits on the header alone, so the content stays centered in the
// window.
const collapsedLeadingClass =
  "pl-[calc(1.5rem+(var(--titlebar-leading)+2.75rem)*(1-var(--sidebar-progress,1)))]";

const defaultDetailPercent = 60;
// The panel never remembers a size outside this range. Dragging the divider
// to an edge would otherwise reopen the next item with the list hidden.
const minRememberedPercent = 20;
const maxRememberedPercent = 80;
// The keys that move the divider. Tab passing over it must not stop a move.
const dividerKeys = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "End",
  "Enter",
  "Home",
]);

type LayoutStep = "closed" | "focus" | "open";

function layoutStep(open: boolean, expanded: boolean): LayoutStep {
  if (!open) {
    return "closed";
  }
  return expanded ? "focus" : "open";
}

/** How much of the group each side takes at a step, as the panels' first size. */
const startSizes: Record<LayoutStep, { detail: string; list: string }> = {
  closed: { detail: "0%", list: "100%" },
  focus: { detail: "100%", list: "0%" },
  open: {
    detail: `${defaultDetailPercent}%`,
    list: `${100 - defaultDetailPercent}%`,
  },
};

/** What `Root` shares with the list and the panel. Not for screens to read. */
interface LayoutValue {
  detailMinSize: string;
  detailMounted: boolean;
  handleDividerKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  listMinSize: string;
  listPanelRef: RefObject<PanelImperativeHandle | null>;
  rememberDetailSize: (size: {
    asPercentage: number;
    inPixels: number;
  }) => void;
  resetSplit: () => void;
  startedAt: LayoutStep;
  stop: () => void;
}

const LayoutContext = createContext<LayoutValue | null>(null);

function useLayout(): LayoutValue {
  const value = use(LayoutContext);
  if (!value) {
    throw new Error("SplitView.Root is missing.");
  }
  return value;
}

function SplitViewProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: SplitViewContextValue;
}) {
  return <SplitViewContext value={value}>{children}</SplitViewContext>;
}

function SplitViewRoot({
  children,
  keepDetailMounted = false,
}: {
  children: ReactNode;
  /**
   * Keep the panel's content mounted, out of sight, once it has opened. For a
   * panel that holds work in progress, such as a reply that is still coming
   * in, which closing would cut off.
   */
  keepDetailMounted?: boolean;
}) {
  const {
    actions: { setOpen },
    state: { expanded, open },
  } = useSplitView();
  const isMobile = useIsMobile();
  const active = useScreenActive();
  const listPanelRef = usePanelRef();
  // The group stays mounted whether or not the panel is open, so the list
  // keeps its place. Opening, closing, and full screen all move one number:
  // how much of the group the list takes. The list is the one to drive
  // because the panel library will not shrink the last panel while every panel
  // before it is collapsed, which is where full screen leaves the list.
  const step: LayoutStep = layoutStep(open, expanded);
  const [startedAt] = useState<LayoutStep>(step);
  const [settledStep, setSettledStep] = useState<LayoutStep>(step);
  const detailPercentRef = useRef(defaultDetailPercent);
  const expandedRef = useRef(expanded);
  const openRef = useRef(open);
  // False from when the screen hides until it has painted again.
  const shownRef = useRef(active);
  // The panel stays on screen while it shrinks away.
  const [detailMounted, setDetailMounted] = useState(open);
  if (open && !detailMounted) {
    setDetailMounted(true);
  }

  useEffect(() => {
    expandedRef.current = expanded;
    openRef.current = open;
  }, [expanded, open]);

  useEffect(() => {
    if (!active) {
      shownRef.current = false;
      return;
    }
    const frame = requestAnimationFrame(() => {
      shownRef.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  const handleSettled = useCallback(
    (reached: string) => {
      setSettledStep(reached as LayoutStep);
      if (reached === "closed" && !keepDetailMounted) {
        setDetailMounted(false);
      }
    },
    [keepDetailMounted]
  );

  const { moving, movingRef, stop } = usePanelSpring(
    listPanelRef,
    step,
    () => {
      if (step === "closed") {
        return 100;
      }
      // Read when the move starts, so the panel opens to where the owner
      // last left it.
      return step === "focus" ? 0 : 100 - detailPercentRef.current;
    },
    handleSettled,
    // A move that starts while the screen is hidden, or before it has painted
    // again, jumps. Coming back to Chat from a search hit or Back then looks
    // as it did when Chat mounted afresh, with the panel already in place.
    // A click can land the screen change and the panel change in separate
    // renders, so one render is not enough.
    () => !shownRef.current
  );

  // Remember where the owner dragged the divider, but not the sizes that a
  // move or full screen passes through.
  const rememberDetailSize = useCallback(
    (size: { asPercentage: number; inPixels: number }) => {
      if (
        size.asPercentage >= minRememberedPercent &&
        size.asPercentage <= maxRememberedPercent &&
        !expandedRef.current &&
        !movingRef.current &&
        openRef.current
      ) {
        detailPercentRef.current = size.asPercentage;
      }
    },
    [movingRef]
  );

  // Double-clicking the divider puts the split back to its usual size. The
  // library's own reset goes to the first panel's default, which is the whole
  // group when the screen opened with nothing selected.
  const resetSplit = useCallback(() => {
    if (step === "open" && !moving) {
      listPanelRef.current?.resize(`${100 - defaultDetailPercent}%`);
    }
  }, [listPanelRef, moving, step]);

  const handleDividerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (dividerKeys.has(event.key)) {
        stop();
      }
    },
    [stop]
  );

  useEffect(() => {
    // A hidden screen leaves the key to the one on show.
    if (!active) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      // Behind a dialog or a menu, the key belongs to that surface.
      if (
        event.code !== "KeyB" ||
        !(event.metaKey || event.ctrlKey) ||
        !event.altKey ||
        event.shiftKey ||
        hasOpenSurface()
      ) {
        return;
      }
      event.preventDefault();
      setOpen(!open);
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active, open, setOpen]);

  // Panels with a minimum snap to it, or to collapsed, on any size below it.
  // A move passes through those sizes, so the minimum is off while it runs.
  // The panel is not collapsible, so an open one cannot be dragged away and
  // the divider keeps working from the keyboard. It has a minimum only once
  // it has settled open, and none while closed.
  const listMinSize = moving ? "0%" : "20%";
  const detailMinSize =
    !moving && step === "open" && settledStep === "open" ? "20%" : "0%";

  const layout: LayoutValue = {
    detailMinSize,
    detailMounted,
    handleDividerKeyDown,
    listMinSize,
    listPanelRef,
    rememberDetailSize,
    resetSplit,
    startedAt,
    stop,
  };

  return (
    <LayoutContext value={layout}>
      <ResizablePanelGroup
        className="min-h-0 flex-1"
        orientation={isMobile ? "vertical" : "horizontal"}
      >
        {children}
      </ResizablePanelGroup>
    </LayoutContext>
  );
}

function SplitViewList({ children }: { children: ReactNode }) {
  const {
    meta: { id },
    state: { expanded },
  } = useSplitView();
  const { listMinSize, listPanelRef, startedAt } = useLayout();
  return (
    <ResizablePanel
      collapsedSize="0%"
      collapsible
      defaultSize={startSizes[startedAt].list}
      id={`${id}-list`}
      minSize={listMinSize}
      panelRef={listPanelRef}
    >
      <div
        aria-hidden={expanded}
        className="flex h-full min-h-0 flex-col"
        inert={expanded}
      >
        {children}
      </div>
    </ResizablePanel>
  );
}

function SplitViewDetail({ children }: { children: ReactNode }) {
  const {
    meta: { id },
    state: { expanded, open },
  } = useSplitView();
  const {
    detailMinSize,
    detailMounted,
    handleDividerKeyDown,
    rememberDetailSize,
    resetSplit,
    startedAt,
    stop,
  } = useLayout();
  return (
    <>
      <ResizableHandle
        className={cn((expanded || !open) && "hidden")}
        disableDoubleClick
        onDoubleClick={resetSplit}
        onKeyDown={handleDividerKeyDown}
        onPointerDown={stop}
      />
      <ResizablePanel
        className="overflow-hidden"
        defaultSize={startSizes[startedAt].detail}
        id={`${id}-detail`}
        minSize={detailMinSize}
        onResize={rememberDetailSize}
      >
        {open || detailMounted ? (
          <div
            aria-hidden={open ? undefined : true}
            className="flex h-full min-h-0 flex-col"
            inert={!open}
          >
            {children}
          </div>
        ) : null}
      </ResizablePanel>
    </>
  );
}

/** The title row of the list. The buttons go on its right. */
function SplitViewListHeader({
  children,
  title,
}: {
  children?: ReactNode;
  title: string;
}) {
  return (
    <div
      className="shrink-0 pt-(--titlebar-height) pb-1"
      data-slot="window-drag"
      onPointerDown={onTitlebarPointerDown}
    >
      <div
        className={cn(
          pageColumnClass,
          listInsetClass,
          "flex h-8 items-center justify-between gap-2"
        )}
      >
        <h1 className="ml-3 min-w-0 truncate font-medium text-base">{title}</h1>
        <div className="flex shrink-0 items-center gap-2">{children}</div>
      </div>
    </div>
  );
}

/** The scrolling rows of the list. `scrollKey` keeps its place across visits. */
function SplitViewListBody({
  children,
  scrollKey,
}: {
  children: ReactNode;
  scrollKey: string;
}) {
  const ref = useRememberedScroll<HTMLDivElement>(scrollKey);
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div
        className={cn(pageColumnClass, listInsetClass, "pt-2 pb-4")}
        ref={ref}
      >
        {children}
      </div>
    </ScrollArea>
  );
}

/** The title row of the panel, which also drags the window. */
function SplitViewDetailHeader({ children }: { children: ReactNode }) {
  const {
    state: { expanded },
  } = useSplitView();
  return (
    <div
      className={cn(
        "flex h-(--titlebar-height) shrink-0 items-center gap-2 px-6",
        expanded && collapsedLeadingClass
      )}
      data-slot="window-drag"
      onPointerDown={onTitlebarPointerDown}
    >
      {children}
    </div>
  );
}

/** Close and Full screen, or Back while the panel is full screen. */
function SplitViewPanelControls({
  backLabel,
  closeLabel,
}: {
  backLabel: string;
  closeLabel: string;
}) {
  const {
    state: { expanded },
  } = useSplitView();
  return (
    <div className="flex items-center">
      {expanded ? (
        <BackButton label={backLabel} />
      ) : (
        <>
          <ClosePanelButton label={closeLabel} />
          <ExpandToggle />
        </>
      )}
    </div>
  );
}

function ClosePanelButton({ label }: { label: string }) {
  const {
    actions: { setOpen },
  } = useSplitView();
  const close = useCallback(() => {
    setOpen(false);
  }, [setOpen]);
  return (
    <Hint label={label} shortcut={shortcuts.closePanel}>
      <PanelIconButton
        aria-keyshortcuts="Meta+Alt+B"
        aria-label={label}
        onClick={close}
      >
        <ChevronsRightIcon className="size-4.5" />
      </PanelIconButton>
    </Hint>
  );
}

// Back leaves full screen and keeps the panel open. The list slides back in
// beside it, to the split the owner last chose.
function BackButton({ label }: { label: string }) {
  const {
    actions: { setExpanded },
  } = useSplitView();
  const showList = useCallback(() => {
    setExpanded(false);
  }, [setExpanded]);
  return (
    <Hint label={label}>
      <PanelIconButton aria-label={label} onClick={showList}>
        <ArrowLeftIcon />
      </PanelIconButton>
    </Hint>
  );
}

function ExpandToggle() {
  const {
    actions: { setExpanded },
  } = useSplitView();
  return (
    <Hint label="Full screen">
      <Toggle
        aria-label="Full screen"
        className={cn("px-0", panelIconHoverClass)}
        onPressedChange={setExpanded}
        size="sm"
      >
        <Maximize2Icon />
      </Toggle>
    </Hint>
  );
}

export const SplitView = {
  Detail: SplitViewDetail,
  DetailHeader: SplitViewDetailHeader,
  List: SplitViewList,
  ListBody: SplitViewListBody,
  ListHeader: SplitViewListHeader,
  PanelControls: SplitViewPanelControls,
  Provider: SplitViewProvider,
  Root: SplitViewRoot,
};
