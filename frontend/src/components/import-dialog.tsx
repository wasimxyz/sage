import { FileUpIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { openMarkdownFileDialog, readImportFile } from "@/bridge";
import { useJournal } from "@/components/journal-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatEntryDate } from "@/lib/format-date";
import { formatImportError } from "@/lib/import-errors";
import { type ParsedImport, parseMarkdownEntry } from "@/lib/parse-markdown";
import { cn } from "@/lib/utils";

type ImportStep = "embedding" | "importing" | "pick" | "preview";

interface EmbedProgress {
  done: number;
  total: number;
}

type PreviewRow =
  | { fileName: string; kind: "error"; message: string; path: string }
  | { fileName: string; kind: "ok"; parsed: ParsedImport; path: string };

const pathSeparatorPattern = /[/\\]/;

export function ImportDialog({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const {
    actions: { importEntries },
  } = useJournal();
  const [step, setStep] = useState<ImportStep>("pick");
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [embedProgress, setEmbedProgress] = useState<EmbedProgress | null>(
    null
  );
  const [picking, setPicking] = useState(false);

  const reset = useCallback(() => {
    setEmbedProgress(null);
    setPicking(false);
    setRows([]);
    setStep("pick");
  }, []);

  const busy = step === "embedding" || step === "importing";

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if ((busy || picking) && !next) {
        return;
      }
      onOpenChange(next);
      if (!next) {
        reset();
      }
    },
    [busy, onOpenChange, picking, reset]
  );

  const chooseFiles = useCallback(async () => {
    setPicking(true);
    try {
      const paths = await openMarkdownFileDialog();
      if (paths.length === 0) {
        return;
      }
      const nextRows = await Promise.all(
        paths.map(async (path): Promise<PreviewRow> => {
          const fileName = fileNameFromPath(path);
          try {
            const file = await readImportFile(path);
            return {
              fileName: file.name,
              kind: "ok",
              parsed: parseMarkdownEntry({
                content: file.body,
                created: file.created,
                fileName: file.name,
              }),
              path,
            };
          } catch {
            return {
              fileName,
              kind: "error",
              message: "Couldn't read file",
              path,
            };
          }
        })
      );
      setRows(nextRows);
      setStep("preview");
    } finally {
      setPicking(false);
    }
  }, []);

  const confirmImport = useCallback(async () => {
    const entries = rows.flatMap((row) =>
      row.kind === "ok" ? [row.parsed] : []
    );
    if (entries.length === 0) {
      return;
    }
    setStep("importing");
    try {
      let showedEmbed = false;
      const imported = await importEntries(entries, (done, total) => {
        showedEmbed = true;
        setEmbedProgress({ done, total });
        setStep("embedding");
      });
      toast.success(
        imported === 1 ? "Imported 1 entry." : `Imported ${imported} entries.`
      );
      if (showedEmbed) {
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, 400);
        });
      }
      onOpenChange(false);
      reset();
    } catch (error) {
      setEmbedProgress(null);
      setStep("preview");
      toast.error(formatImportError(error));
    }
  }, [importEntries, onOpenChange, reset, rows]);

  const validCount = rows.filter((row) => row.kind === "ok").length;
  const showPreview = step !== "pick";

  return (
    <Dialog
      disablePointerDismissal={busy || picking}
      onOpenChange={handleOpenChange}
      open={open}
    >
      <DialogContent
        className={
          showPreview ? "sm:max-w-[min(48rem,calc(100vw-2rem))]" : undefined
        }
      >
        <DialogHeader>
          <DialogTitle>Import markdown files</DialogTitle>
          <DialogDescription>
            Choose one or more markdown files. Sage reads the title, date, and
            body from each file. Check the preview before you import.
          </DialogDescription>
        </DialogHeader>
        {showPreview ? <PreviewTable rows={rows} /> : null}
        {busy ? (
          <div
            aria-atomic="true"
            aria-live="polite"
            className="flex min-w-0 items-center gap-2 text-muted-foreground text-sm"
          >
            <Spinner />
            <span>
              {embedProgress
                ? embedProgressLabel(embedProgress)
                : "Importing entries."}
            </span>
          </div>
        ) : null}
        <DialogActions>
          {step === "pick" ? (
            <>
              <DialogClose render={<Button variant="outline" />}>
                Cancel
              </DialogClose>
              <Button onClick={chooseFiles}>
                <FileUpIcon data-icon="inline-start" />
                Choose files
              </Button>
            </>
          ) : (
            <>
              <DialogClose
                disabled={busy}
                render={<Button variant="outline" />}
              >
                Cancel
              </DialogClose>
              <Button
                disabled={busy || validCount === 0}
                onClick={confirmImport}
              >
                {validCount === 1
                  ? "Import 1 entry"
                  : `Import ${validCount} entries`}
              </Button>
            </>
          )}
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

function embedProgressLabel(progress: EmbedProgress): string {
  if (progress.total === 1) {
    return `${progress.done} of 1 entry embedded.`;
  }
  return `${progress.done} of ${progress.total} entries embedded.`;
}

function PreviewTable({ rows }: { rows: PreviewRow[] }) {
  return (
    <div className="max-h-80 min-w-0 overflow-auto">
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[20%]">File</TableHead>
            <TableHead className="w-[32%]">Title</TableHead>
            <TableHead className="w-[22%]">Date</TableHead>
            <TableHead className="w-[26%]">Notes</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const title = row.kind === "ok" ? row.parsed.title : "—";
            const date =
              row.kind === "ok" ? formatEntryDate(row.parsed.date) : "—";
            const notes = rowNotes(row);
            return (
              <TableRow key={row.path}>
                <TableCell className="truncate" title={row.fileName}>
                  {row.fileName}
                </TableCell>
                <TableCell className="truncate font-medium" title={title}>
                  {title}
                </TableCell>
                <TableCell className="truncate" title={date}>
                  {row.kind === "ok" ? (
                    <time dateTime={row.parsed.date}>{date}</time>
                  ) : (
                    date
                  )}
                </TableCell>
                <TableCell
                  className={cn(
                    "whitespace-normal text-sm",
                    row.kind === "error"
                      ? "text-destructive"
                      : "text-muted-foreground"
                  )}
                  title={notes}
                >
                  {notes}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function rowNotes(row: PreviewRow): string {
  if (row.kind === "error") {
    return row.message;
  }
  return row.parsed.warnings.join(" ");
}

function fileNameFromPath(path: string): string {
  const parts = path.split(pathSeparatorPattern);
  return parts.at(-1) ?? path;
}
