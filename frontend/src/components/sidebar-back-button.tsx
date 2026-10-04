import { ChevronLeftIcon } from "lucide-react";

import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";

/**
 * The first item of a sidebar menu that replaces the main navigation, such as
 * Chat or Settings. Screens pair their title row with it, so both sit on the
 * same line below the title bar.
 */
export function SidebarBackButton({ onClick }: { onClick: () => void }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        className="relative justify-center"
        onClick={onClick}
        tooltip="Back"
      >
        <ChevronLeftIcon className="absolute left-2" />
        <span>Back</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
