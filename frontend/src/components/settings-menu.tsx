import {
  BotIcon,
  CpuIcon,
  DatabaseIcon,
  LockIcon,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode, useCallback } from "react";

import { useJournal } from "@/components/journal-context";
import { useSettings } from "@/components/settings-context";
import { SidebarBackButton } from "@/components/sidebar-back-button";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import type { SettingsTab } from "@/lib/route";

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

export function SettingsMenu() {
  const {
    actions: { closeSettings },
  } = useJournal();
  const {
    actions: { setTab },
    state: { tab },
  } = useSettings();
  return (
    <>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarBackButton onClick={closeSettings} />
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      <SidebarGroup className="pt-0">
        <SidebarGroupLabel>Settings</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {items.map(({ icon: Icon, id, label }) => (
              <SettingsMenuItem
                active={tab === id}
                id={id}
                key={id}
                label={label}
                onSelect={setTab}
              >
                <Icon />
              </SettingsMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  );
}

function SettingsMenuItem({
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
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        onClick={handleClick}
        tooltip={label}
      >
        {children}
        <span>{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
