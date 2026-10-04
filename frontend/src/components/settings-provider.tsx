import { type ReactNode, useMemo, useState } from "react";

import { SettingsStateProvider } from "@/components/settings-context";
import type { SettingsTab } from "@/lib/route";

const emptyMeta = {};

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [tab, setTab] = useState<SettingsTab>("agent");

  const state = useMemo(() => ({ tab }), [tab]);
  const actions = useMemo(() => ({ setTab }), []);
  const value = useMemo(
    () => ({ actions, meta: emptyMeta, state }),
    [actions, state]
  );

  return (
    <SettingsStateProvider value={value}>{children}</SettingsStateProvider>
  );
}
