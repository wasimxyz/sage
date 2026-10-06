import { useOnboarding } from "@/components/onboarding-provider";
import { SetupDone } from "@/components/setup/setup-done";
import { SetupImport } from "@/components/setup/setup-import";
import { SetupLocalAi } from "@/components/setup/setup-local-ai";
import {
  ReminderProtect,
  SetupProtect,
} from "@/components/setup/setup-protect";
import { SetupWelcome } from "@/components/setup/setup-welcome";

/**
 * Whatever setup screen the mode asks for, filling the whole window. Each
 * screen is its own component, so moving to the next one starts it fresh.
 */
export function SetupFlow() {
  const {
    state: { mode },
  } = useOnboarding();
  if (mode.kind === "protect") {
    return <ReminderProtect />;
  }
  if (mode.kind !== "setup") {
    return null;
  }
  switch (mode.step) {
    case "welcome":
      return <SetupWelcome />;
    case "local_ai":
      return <SetupLocalAi />;
    case "protect":
      return <SetupProtect />;
    case "import":
      return <SetupImport />;
    default:
      return <SetupDone />;
  }
}
