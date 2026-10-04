import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useState,
} from "react";
import { toast } from "sonner";

import { getAgentInstructions, saveAgentInstructions } from "@/bridge";
import { SettingsSection } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const maxUserBytes = 8 * 1024;
const encoder = new TextEncoder();
const textareaClassName = "bg-surface dark:bg-surface";

export function AgentSettings() {
  const [builtin, setBuiltin] = useState("");
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAgentInstructions()
      .then((data) => {
        if (cancelled) {
          return;
        }
        setBuiltin(data.builtin);
        setDraft(data.user);
        setSaved(data.user);
        setError(null);
        setReady(true);
      })
      .catch((loadError: unknown) => {
        if (cancelled) {
          return;
        }
        toast.error(loadErrorMessage(loadError));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = ready && draft !== saved;
  const handleDraftChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      setDraft(event.target.value);
      setError(null);
    },
    []
  );

  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (busy || !dirty) {
        return;
      }
      if (encoder.encode(draft).byteLength > maxUserBytes) {
        setError("Keep this under 8 KB.");
        return;
      }
      setBusy(true);
      setError(null);
      saveAgentInstructions(draft)
        .then(() => {
          setSaved(draft);
          toast.success("Instructions saved.");
        })
        .catch((saveError: unknown) => {
          setError(saveErrorMessage(saveError));
        })
        .finally(() => setBusy(false));
    },
    [busy, dirty, draft]
  );

  return (
    <SettingsSection
      description="Extra instructions for Chat. New chats use the saved text."
      title="Agent"
    >
      <form onSubmit={handleSubmit}>
        <FieldGroup className="mt-4">
          <Field>
            <FieldLabel htmlFor="settings-agent-builtin">
              Built-in instructions
            </FieldLabel>
            <Textarea
              className={cn("min-h-40", textareaClassName)}
              id="settings-agent-builtin"
              readOnly
              value={builtin}
            />
          </Field>
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="settings-agent-user">
              Your instructions
            </FieldLabel>
            <FieldDescription>
              Added after the built-in instructions.
            </FieldDescription>
            <Textarea
              aria-invalid={error ? true : undefined}
              className={cn("min-h-32", textareaClassName)}
              disabled={!ready}
              id="settings-agent-user"
              onChange={handleDraftChange}
              value={draft}
            />
            <FieldError>{error}</FieldError>
          </Field>
        </FieldGroup>
        <div className="mt-4 flex justify-end">
          <Button disabled={busy || !dirty} type="submit">
            {busy ? <Spinner data-icon="inline-start" /> : null}
            Save
          </Button>
        </div>
      </form>
    </SettingsSection>
  );
}

function loadErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Locked")) {
    return "Unlock the app first.";
  }
  if (message.includes("Securing")) {
    return "Wait until Sage finishes securing your journal.";
  }
  return message.length > 0 ? message : "Could not load instructions.";
}

function saveErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Locked")) {
    return "Unlock the app first.";
  }
  if (message.includes("Securing")) {
    return "Wait until Sage finishes securing your journal.";
  }
  if (message.includes("TooLarge")) {
    return "Keep this under 8 KB.";
  }
  return message.length > 0 ? message : "Could not save instructions.";
}
