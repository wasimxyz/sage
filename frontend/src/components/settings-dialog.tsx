import {
  BotIcon,
  CpuIcon,
  DatabaseIcon,
  LockIcon,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode, useCallback } from "react";

import { AgentSettings } from "@/components/settings-agent";
import { useSettings } from "@/components/settings-context";
import { DataSettings } from "@/components/settings-data";
import { ModelsSettings } from "@/components/settings-models";
import { SecuritySettings } from "@/components/settings-security";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { SettingsTab } from "@/lib/route";
import { cn } from "@/lib/utils";

const items = [
  { icon: BotIcon, id: "agent", label: "Agent" },
  { icon: CpuIcon, id: "models", label: "Models" },
  { icon: LockIcon, id: "security", label: "Security" },
  { icon: DatabaseIcon, id: "data", label: "Data" },
] as const satisfies readonly {
  icon: LucideIcon;
  id: SettingsTab;
  label: string;
}[];

/**
 * Settings opens as a dialog over the screen you were on, with its sections
 * down the left and the open one on the right. Esc, the close button, or a
 * click outside closes it.
 */
export function SettingsDialog() {
  const {
    actions: { setOpen },
    state: { open },
  } = useSettings();
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent className="flex h-[min(40rem,calc(100vh-4rem))] w-full max-w-4xl flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        {/* As tall as the close button's row, so the two line up. */}
        <div className="flex h-11 shrink-0 items-center border-b pr-12 pl-4">
          <DialogTitle>Settings</DialogTitle>
        </div>
        <div className="flex min-h-0 flex-1">
          <SettingsNav />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <SettingsPanes />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SettingsNav() {
  const {
    actions: { setTab },
    state: { tab },
  } = useSettings();
  return (
    <nav
      aria-label="Settings sections"
      className="flex w-48 shrink-0 flex-col gap-px border-r p-2"
    >
      {items.map(({ icon: Icon, id, label }) => (
        <SettingsNavItem
          active={tab === id}
          id={id}
          key={id}
          label={label}
          onSelect={setTab}
        >
          <Icon />
        </SettingsNavItem>
      ))}
    </nav>
  );
}

function SettingsNavItem({
  active,
  children,
  id,
  label,
  onSelect,
}: {
  active: boolean;
  children: ReactNode;
  id: SettingsTab;
  label: string;
  onSelect: (tab: SettingsTab) => void;
}) {
  const handleClick = useCallback(() => onSelect(id), [id, onSelect]);
  return (
    <Button
      aria-current={active ? "page" : undefined}
      className={cn(
        "hover:bg-foreground/6 dark:hover:bg-foreground/6 h-8 w-full justify-start gap-2 px-2 font-normal",
        active &&
          "bg-foreground/8 hover:bg-foreground/8 dark:hover:bg-foreground/8"
      )}
      onClick={handleClick}
      variant="ghost"
    >
      {children}
      {label}
    </Button>
  );
}

function SettingsPanes() {
  const {
    state: { tab },
  } = useSettings();
  return (
    <>
      {/* Agent stays mounted so unsaved text survives a section switch. */}
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
