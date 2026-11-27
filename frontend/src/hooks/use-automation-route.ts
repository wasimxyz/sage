import { useEffect } from "react";

import { onAutomationRoute } from "@/bridge";

/**
 * Opens a screen when an automation build gets `app.route:<route>`, so
 * `make screenshots` needs no clicks. The new hash goes through route sync
 * like a link. Focus then leaves the page, so no caret shows in a capture.
 * Sending the same path again only clears focus. Shipping builds never send
 * the event.
 */
export function useAutomationRoute() {
  useEffect(
    () =>
      onAutomationRoute((path) => {
        if (window.location.hash !== `#${path}`) {
          window.location.hash = path;
        }
        const active = document.activeElement;
        if (active instanceof HTMLElement) {
          active.blur();
        }
      }),
    []
  );
}
