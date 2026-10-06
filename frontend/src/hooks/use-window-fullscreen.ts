import { useEffect, useState } from "react";

const FULLSCREEN_ATTRIBUTE = "data-fullscreen";

function isFullscreen() {
  return document.documentElement.hasAttribute(FULLSCREEN_ATTRIBUTE);
}

/**
 * True while the window is in macOS full screen. `AppTitlebar` asks the native
 * side on every resize and mirrors the answer onto `<html data-fullscreen>`, so
 * this reads that attribute. A height check against `screen.height` cannot
 * tell: a notched MacBook leaves the notch strip out of the window, and a
 * window stretched to fill the screen looks the same as full screen.
 */
export function useWindowFullscreen() {
  const [fullscreen, setFullscreen] = useState(isFullscreen);

  useEffect(() => {
    function sync() {
      setFullscreen(isFullscreen());
    }
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributeFilter: [FULLSCREEN_ATTRIBUTE],
      attributes: true,
    });
    return () => observer.disconnect();
  }, []);

  return fullscreen;
}
