import { AgentSettings } from "@/components/settings-agent";
import { useSettings } from "@/components/settings-context";
import { DataSettings } from "@/components/settings-data";
import { ModelsSettings } from "@/components/settings-models";
import { SecuritySettings } from "@/components/settings-security";
import type { SettingsTab } from "@/lib/route";
import { cn } from "@/lib/utils";

export function SettingsScreen() {
  const {
    state: { tab },
  } = useSettings();
  return (
    <>
      {/* Agent stays mounted so unsaved text survives a tab switch. */}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          tab !== "agent" && "hidden"
        )}
      >
        <AgentSettings />
      </div>
      {tab === "agent" ? null : (
        <div className="flex min-h-0 flex-1 flex-col">
          <SettingsPane tab={tab} />
        </div>
      )}
    </>
  );
}

function SettingsPane({ tab }: { tab: Exclude<SettingsTab, "agent"> }) {
  if (tab === "security") {
    return <SecuritySettings />;
  }
  if (tab === "models") {
    return <ModelsSettings />;
  }
  return <DataSettings />;
}
