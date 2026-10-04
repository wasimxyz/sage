import { useEffect, useState } from "react";

export function useWindowFullscreen() {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    function sync() {
      // Native SDK does not expose a fullscreen event. This height check is a
      // stand-in: a window the user stretches to fill the screen is treated as
      // fullscreen, so the sidebar trigger may sit under the traffic lights.
      setFullscreen(window.outerHeight >= window.screen.height - 2);
    }
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  return fullscreen;
}
