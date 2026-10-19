import {
  createContext,
  type ReactNode,
  type RefObject,
  use,
  useEffect,
  useRef,
} from "react";

/**
 * Whether the screen around this part of the page is the one on show. Chat
 * stays mounted, out of sight, while another screen shows, so a reply keeps
 * streaming and the transcript keeps its place. Its parts read this to stay
 * quiet while hidden. Every other screen unmounts when you leave it, so
 * outside Chat this is always true.
 */
const ScreenActiveContext = createContext<boolean>(true);

export function ScreenActiveProvider({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return <ScreenActiveContext value={active}>{children}</ScreenActiveContext>;
}

export function useScreenActive(): boolean {
  return use(ScreenActiveContext);
}

/**
 * Runs `onHide` when the screen goes out of sight, such as to close a menu
 * that would otherwise stay open over the next screen.
 */
export function useOnScreenHide(onHide: () => void) {
  const active = useScreenActive();
  const onHideRef = useRef(onHide);
  const wasActiveRef = useRef(active);

  useEffect(() => {
    onHideRef.current = onHide;
  });

  useEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = active;
    if (wasActive && !active) {
      onHideRef.current();
    }
  }, [active]);
}

/** What a Base UI menu or dialog hands its `actionsRef`. */
interface PopupActions {
  close: () => void;
  unmount: () => void;
}

/**
 * An `actionsRef` for a Base UI menu or dialog. The popup sits outside the
 * screen, so hiding the screen would leave it open over the next one. This
 * closes it, as leaving a screen that unmounts does.
 */
export function useCloseOnScreenHide(): RefObject<PopupActions | null> {
  const actionsRef = useRef<PopupActions | null>(null);
  useOnScreenHide(() => {
    actionsRef.current?.close();
  });
  return actionsRef;
}
