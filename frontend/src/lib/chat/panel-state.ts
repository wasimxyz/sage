/** Whether the chat panel is open, and whether it fills the window. */
export interface PanelState {
  expanded: boolean;
  open: boolean;
}

export type PanelAction =
  | { type: "close" }
  | { expanded: boolean; type: "expand" }
  | { type: "open" };

/** Chat opens on a new chat, so the first visit shows the panel. */
export const initialPanel: PanelState = { expanded: false, open: true };

/**
 * Full screen only exists while the panel is open. Every way of closing the
 * panel ends it, so the list is never left hidden behind a closed panel.
 */
export function panelReducer(
  state: PanelState,
  action: PanelAction
): PanelState {
  if (action.type === "open") {
    return state.open ? state : { ...state, open: true };
  }
  if (action.type === "close") {
    return state.open || state.expanded
      ? { expanded: false, open: false }
      : state;
  }
  const expanded = action.expanded && state.open;
  return expanded === state.expanded ? state : { ...state, expanded };
}
