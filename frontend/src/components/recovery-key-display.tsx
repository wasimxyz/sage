import { CheckIcon, CopyIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

/**
 * Copying a recovery key puts it on the clipboard, where other apps and
 * Universal Clipboard can read it. `clear` replaces it once the person says
 * they saved the key, and again when the screen goes away.
 */
export function useRecoveryKeyClipboard(recoveryKey: string) {
  const [copied, setCopied] = useState(false);
  const copiedKey = useRef<string | null>(null);

  const clear = useCallback(() => {
    setCopied(false);
    if (copiedKey.current === null) {
      return;
    }
    copiedKey.current = null;
    navigator.clipboard.writeText("").catch(() => undefined);
  }, []);

  useEffect(() => clear, [clear]);

  const copy = useCallback(() => {
    navigator.clipboard
      .writeText(recoveryKey)
      .then(() => {
        copiedKey.current = recoveryKey;
        setCopied(true);
      })
      .catch(() => toast.error("Could not copy the recovery key."));
  }, [recoveryKey]);

  return { clear, copied, copy };
}

/**
 * A recovery key in its groups, with a Copy button. Sage generates the key
 * and the page only shows it.
 */
export function RecoveryKeyDisplay({
  copied,
  copyLabel = "Copy",
  onCopy,
  recoveryKey,
}: {
  copied: boolean;
  copyLabel?: string;
  onCopy: () => void;
  recoveryKey: string;
}) {
  const buttonLabel = copied ? "Copied" : copyLabel;
  return (
    <>
      <div className="flex items-center justify-between gap-3 rounded-lg bg-muted px-4 py-3">
        <div className="grid select-all grid-cols-3 gap-x-4 gap-y-1 font-mono text-base tracking-wider">
          {recoveryKey
            .split("-")
            .map((text, position) => ({
              position,
              text,
            }))
            .map((group) => (
              <span key={group.position}>{group.text}</span>
            ))}
        </div>
        <Button
          aria-label="Copy recovery key"
          onClick={onCopy}
          size="sm"
          type="button"
          variant="outline"
        >
          {copied ? (
            <CheckIcon data-icon="inline-start" />
          ) : (
            <CopyIcon data-icon="inline-start" />
          )}
          {buttonLabel}
        </Button>
      </div>
      {copied ? (
        <p className="text-muted-foreground text-sm">
          Sage clears your clipboard when you continue.
        </p>
      ) : null}
    </>
  );
}
