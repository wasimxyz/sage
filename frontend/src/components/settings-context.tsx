import { createContext, type ReactNode, use } from "react";

import type { SettingsTab } from "@/lib/route";

export interface SettingsState {
  tab: SettingsTab;
}

export interface SettingsActions {
  setTab: (tab: SettingsTab) => void;
}

export interface SettingsContextValue {
  actions: SettingsActions;
  meta: Record<string, never>;
  state: SettingsState;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettings(): SettingsContextValue {
  const value = use(SettingsContext);
  if (!value) {
    throw new Error("SettingsProvider is missing.");
  }
  return value;
}

export function SettingsStateProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: SettingsContextValue;
}) {
  return <SettingsContext value={value}>{children}</SettingsContext>;
}
