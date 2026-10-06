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

/** The Copy button. It says Copied for as long as the key is on the clipboard. */
function RecoveryKeyCopyButton({
  copied,
  label,
  onCopy,
}: {
  copied: boolean;
  /** What the button says before the key is copied, like "Copy". */
  label: string;
  onCopy: () => void;
}) {
  const text = copied ? "Copied" : label;
  return (
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
      {text}
    </Button>
  );
}

/** Says the clipboard is cleared once the person moves on. Shown after a copy. */
function RecoveryKeyClipboardNote({ copied }: { copied: boolean }) {
  if (!copied) {
    return null;
  }
  return (
    <p className="text-muted-foreground text-sm">
      Sage clears your clipboard when you continue.
    </p>
  );
}

/**
 * The key in its six groups, one per column, three to a row. Used by the
 * Settings dialogs, where the Copy button sits beside it. Sage generates the
 * key and the page only shows it.
 */
export function RecoveryKeyGrid({
  copied,
  onCopy,
  recoveryKey,
}: {
  copied: boolean;
  onCopy: () => void;
  recoveryKey: string;
}) {
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
        <RecoveryKeyCopyButton copied={copied} label="Copy" onCopy={onCopy} />
      </div>
      <RecoveryKeyClipboardNote copied={copied} />
    </>
  );
}

/**
 * The key on one line in a card, with the Copy button centered under it. Used
 * by first-launch setup, where the key is the whole screen.
 */
export function RecoveryKeyCard({
  copied,
  onCopy,
  recoveryKey,
}: {
  copied: boolean;
  onCopy: () => void;
  recoveryKey: string;
}) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border bg-card px-6 py-6 text-center">
      <p className="select-all font-mono text-xl tracking-wider">
        {recoveryKey}
      </p>
      <RecoveryKeyCopyButton copied={copied} label="Copy key" onCopy={onCopy} />
      <RecoveryKeyClipboardNote copied={copied} />
    </div>
  );
}
