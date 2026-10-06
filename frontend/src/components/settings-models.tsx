import {
  type ReactNode,
  Suspense,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import {
  cancelOllamaPull,
  deleteOllamaModel,
  getOllamaPull,
  getOllamaStatus,
  getSystemHardware,
  listOllamaModels,
  type OllamaPullProgress,
  pullOllamaModel,
  type SystemHardware,
} from "@/bridge";
import { useChat } from "@/components/chat-provider";
import { OllamaStartNotice } from "@/components/ollama-notice";
import { SettingsSection } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogActions,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableRow,
} from "@/components/ui/table";
import {
  compareScoresDescending,
  findCanirunModelId,
  findInstalledName,
  isSageModel,
  type RecommendedModel,
  recommendModels,
} from "@/lib/models";

const canirunUrl = "https://www.canirun.ai";
const canirunLinkClassName =
  "underline underline-offset-2 hover:text-foreground";
const pollMs = 1000;
const nameCellClassName = "whitespace-normal py-3 pl-4 font-medium";
const actionCellClassName = "w-px py-3 pr-4 text-right";
const metricCellClassName =
  "w-px py-3 text-right text-muted-foreground tabular-nums";
const sectionHeadingClassName =
  "mt-6 font-medium text-muted-foreground text-sm";
const skeletonRows = [0, 1, 2, 3, 4, 5, 6, 7];

interface ModelRow {
  downloading: boolean;
  href: string | null;
  installedName: string | null;
  name: string;
  ollamaTag: string;
  progress: OllamaPullProgress | null;
  score: string;
  scoreValue: number | null;
  size: string;
  tokensPerSecond: string;
}

interface ModelsOpenState {
  hardware: SystemHardware | null;
  installed: string[];
  installedStats: RecommendedModel[];
  ollamaRunning: boolean;
  pull: OllamaPullProgress | null;
  recommendations: RecommendedModel[];
}

function ModelsSettingsFallback() {
  return (
    <div aria-busy="true" role="status">
      <h3 className={sectionHeadingClassName}>Installed</h3>
      <ModelsSkeletonTable />
      <h3 className={sectionHeadingClassName}>Recommended</h3>
      <Skeleton className="mt-0.5 h-3 w-80" />
      <ModelsSkeletonTable />
    </div>
  );
}

function ModelsSkeletonTable() {
  return (
    <ModelsCard>
      <Table>
        <TableBody>
          {skeletonRows.map((row) => (
            <TableRow className="hover:bg-transparent" key={row}>
              <TableCell className="py-3 pl-4">
                <Skeleton className="h-4 w-44" />
              </TableCell>
              <TableCell className={metricCellClassName}>
                <Skeleton className="ml-auto h-4 w-12" />
              </TableCell>
              <TableCell className={metricCellClassName}>
                <Skeleton className="ml-auto h-4 w-20" />
              </TableCell>
              <TableCell className={metricCellClassName}>
                <Skeleton className="ml-auto h-4 w-16" />
              </TableCell>
              <TableCell className={actionCellClassName}>
                <Skeleton className="ml-auto h-8 w-20" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ModelsCard>
  );
}

/** One rounded card per model list. The rows carry their own padding. */
function ModelsCard({ children }: { children: ReactNode }) {
  return <Card className="mt-3 gap-0 py-0">{children}</Card>;
}

const modelsSettingsFallback = <ModelsSettingsFallback />;

export function ModelsSettings() {
  const [dataPromise] = useState(loadModelsOpenState);
  return (
    <SettingsSection
      description="Download and manage local models through Ollama."
      title="Models"
    >
      <Suspense fallback={modelsSettingsFallback}>
        <ModelsSettingsBody dataPromise={dataPromise} />
      </Suspense>
    </SettingsSection>
  );
}

function ModelsSettingsBody({
  dataPromise,
}: {
  dataPromise: Promise<ModelsOpenState>;
}) {
  const initial = use(dataPromise);
  const { hardware, installedStats, recommendations } = initial;
  const {
    actions: { startOllama },
    state: { models, ollamaStart },
  } = useChat();
  // Chat polls Ollama's status, so a start from here or from Chat lands live.
  const ollamaRunning =
    models.kind === "loading" ? initial.ollamaRunning : models.kind !== "down";
  const [installed, setInstalled] = useState(initial.installed);
  const [pull, setPull] = useState(initial.pull);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const toastedKey = useRef<string | null>(null);

  const refreshInstalled = useCallback(async () => {
    const names = await listOllamaModels();
    setInstalled(names);
  }, []);

  // The list loaded while Ollama was down is empty, so reload it once Ollama
  // comes up.
  const wasRunning = useRef(ollamaRunning);
  useEffect(() => {
    if (ollamaRunning && !wasRunning.current) {
      refreshInstalled().catch(() => undefined);
    }
    wasRunning.current = ollamaRunning;
  }, [ollamaRunning, refreshInstalled]);

  useEffect(() => {
    if (!pull?.active) {
      return;
    }
    let cancelled = false;
    const tick = async () => {
      const next = await getOllamaPull();
      if (cancelled) {
        return;
      }
      setPull(next);
      await announcePullOutcome(next, toastedKey, refreshInstalled);
    };
    tick().catch(() => undefined);
    const timer = window.setInterval(() => {
      tick().catch(() => undefined);
    }, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pull?.active, refreshInstalled]);

  const catalogRows = useMemo(
    () => [...installedStats, ...recommendations],
    [installedStats, recommendations]
  );

  const installedRows = useMemo(
    () =>
      installed
        .map((name) => toInstalledRow(name, catalogRows))
        .sort((a, b) => compareScoresDescending(a.scoreValue, b.scoreValue)),
    [catalogRows, installed]
  );

  const recommendedRows = useMemo(
    () =>
      recommendations
        .filter((row) => findInstalledName(row.ollamaTag, installed) === null)
        .map((row) => toRecommendedRow(row, pull)),
    [installed, pull, recommendations]
  );

  const handleDownload = useCallback(async (tag: string) => {
    toastedKey.current = null;
    try {
      await pullOllamaModel(tag);
      setPull(await getOllamaPull());
    } catch (error: unknown) {
      toast.error(ollamaActionError(error, "Could not start the download."));
    }
  }, []);

  const handleCancel = useCallback(async () => {
    try {
      await cancelOllamaPull();
    } catch (error: unknown) {
      toast.error(ollamaActionError(error, "Could not cancel the download."));
    }
  }, []);

  const handleDeleteClick = useCallback((name: string) => {
    setPendingDelete(name);
  }, []);

  const handleDeleteOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen) {
      setPendingDelete(null);
    }
  }, []);

  const handleConfirmDelete = useCallback(() => {
    if (!pendingDelete) {
      return;
    }
    const name = pendingDelete;
    setPendingDelete(null);
    deleteOllamaModel(name)
      .then(async () => {
        toast.success(`Removed ${name}.`);
        await refreshInstalled();
      })
      .catch((error: unknown) => {
        toast.error(ollamaActionError(error, "Could not delete the model."));
      });
  }, [pendingDelete, refreshInstalled]);

  const subtitle = hardware
    ? `These models run best on your ${hardware.chipName} with ${hardware.ramGb} GB RAM.`
    : "Download recommended models for this Mac.";

  return (
    <>
      {ollamaRunning ? null : (
        <div className="mt-4">
          <OllamaStartNotice
            description="Start it to download or delete models."
            onStart={startOllama}
            start={ollamaStart}
          />
        </div>
      )}
      {installedRows.length > 0 ? (
        <>
          <h3 className={sectionHeadingClassName}>Installed</h3>
          <ModelsTable caption="Installed models">
            {installedRows.map((row) => (
              <ModelTableRow key={row.installedName ?? row.ollamaTag} row={row}>
                <InstalledAction
                  disabled={!ollamaRunning}
                  name={row.installedName ?? row.ollamaTag}
                  onDelete={handleDeleteClick}
                />
              </ModelTableRow>
            ))}
          </ModelsTable>
        </>
      ) : null}
      <h3 className={sectionHeadingClassName}>Recommended</h3>
      <p className="mt-0.5 text-muted-foreground text-xs">{subtitle}</p>
      {recommendedRows.length === 0 &&
      recommendations.length === 0 &&
      hardware !== null ? (
        <p className="mt-2 py-4 text-muted-foreground text-sm">
          No recommended text models scored high enough for this Mac.
        </p>
      ) : null}
      {recommendedRows.length > 0 ? (
        <ModelsTable caption="Recommended models">
          {recommendedRows.map((row) => (
            <ModelTableRow key={row.ollamaTag} row={row}>
              <RecommendedRowAction
                ollamaRunning={ollamaRunning}
                onCancel={handleCancel}
                onDownload={handleDownload}
                pullActive={Boolean(pull?.active)}
                row={row}
              />
            </ModelTableRow>
          ))}
        </ModelsTable>
      ) : null}
      <DeleteModelDialog
        name={pendingDelete}
        onConfirm={handleConfirmDelete}
        onOpenChange={handleDeleteOpenChange}
      />
    </>
  );
}

function ModelsTable({
  caption,
  children,
}: {
  caption: string;
  children: ReactNode;
}) {
  return (
    <ModelsCard>
      <Table>
        <TableCaption className="sr-only">{caption}</TableCaption>
        <TableBody>{children}</TableBody>
      </Table>
    </ModelsCard>
  );
}

function ModelTableRow({
  children,
  row,
}: {
  children: ReactNode;
  row: ModelRow;
}) {
  return (
    <TableRow aria-busy={row.downloading} className="hover:bg-transparent">
      <TableCell className={nameCellClassName}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {row.href ? (
            <CanirunLink href={row.href}>{row.name}</CanirunLink>
          ) : (
            row.name
          )}
          {row.downloading ? <DownloadStatus progress={row.progress} /> : null}
        </div>
      </TableCell>
      <TableCell className={metricCellClassName}>{row.size}</TableCell>
      <TableCell className={metricCellClassName}>
        {row.tokensPerSecond}
      </TableCell>
      <TableCell className={metricCellClassName}>{row.score}</TableCell>
      <TableCell className={actionCellClassName}>{children}</TableCell>
    </TableRow>
  );
}

function RecommendedRowAction({
  ollamaRunning,
  onCancel,
  onDownload,
  pullActive,
  row,
}: {
  ollamaRunning: boolean;
  onCancel: () => void;
  onDownload: (tag: string) => void;
  pullActive: boolean;
  row: ModelRow;
}) {
  if (row.downloading) {
    return <DownloadingAction onCancel={onCancel} />;
  }
  return (
    <DownloadAction
      disabled={!ollamaRunning || pullActive}
      onDownload={onDownload}
      tag={row.ollamaTag}
    />
  );
}

function CanirunLink({
  children,
  href,
}: {
  children: ReactNode;
  href: string;
}) {
  return (
    <a
      className={canirunLinkClassName}
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {children}
    </a>
  );
}

function canirunModelUrl(modelId: string): string {
  return `${canirunUrl}/model/${modelId}/`;
}

function DownloadAction({
  disabled,
  onDownload,
  tag,
}: {
  disabled: boolean;
  onDownload: (tag: string) => void;
  tag: string;
}) {
  const handleClick = useCallback(() => onDownload(tag), [onDownload, tag]);
  return (
    <Button
      disabled={disabled}
      onClick={handleClick}
      size="sm"
      variant="outline"
    >
      Download
    </Button>
  );
}

function DownloadStatus({ progress }: { progress: OllamaPullProgress | null }) {
  return (
    <span
      aria-live="polite"
      className="inline-flex items-center gap-1.5 whitespace-nowrap font-normal text-muted-foreground text-sm tabular-nums"
    >
      <Spinner aria-hidden />
      {downloadStatusLabel(progress)}
    </span>
  );
}

function DownloadingAction({ onCancel }: { onCancel: () => void }) {
  return (
    <Button onClick={onCancel} size="sm" variant="outline">
      Cancel
    </Button>
  );
}

function InstalledAction({
  disabled,
  name,
  onDelete,
}: {
  disabled: boolean;
  name: string;
  onDelete: (name: string) => void;
}) {
  const handleClick = useCallback(() => onDelete(name), [name, onDelete]);
  return (
    <Button
      disabled={disabled}
      onClick={handleClick}
      size="sm"
      variant="destructive"
    >
      Delete
    </Button>
  );
}

function DeleteModelDialog({
  name,
  onConfirm,
  onOpenChange,
}: {
  name: string | null;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const sageHint =
    name && isSageModel(name)
      ? " Sage uses this model for summaries or embeddings."
      : "";
  return (
    <Dialog onOpenChange={onOpenChange} open={name !== null}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {name}?</DialogTitle>
          <DialogDescription>
            This removes the model from Ollama on this Mac.{sageHint} Chat
            conversations that used it stay in Sage.
          </DialogDescription>
        </DialogHeader>
        <DialogActions>
          <DialogClose render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <Button onClick={onConfirm} variant="destructive">
            Delete
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

function toRecommendedRow(
  row: RecommendedModel,
  pull: OllamaPullProgress | null
): ModelRow {
  const downloading = Boolean(
    pull?.active && modelPullMatches(pull.model, row.ollamaTag)
  );
  return {
    downloading,
    href: canirunModelUrl(row.modelId),
    installedName: null,
    name: row.name,
    ollamaTag: row.ollamaTag,
    progress: downloading ? pull : null,
    ...modelStats(row),
  };
}

function toInstalledRow(
  installedName: string,
  catalogRows: readonly RecommendedModel[]
): ModelRow {
  const modelId = findCanirunModelId(installedName);
  const row = modelId
    ? catalogRows.find((item) => item.modelId === modelId)
    : undefined;
  if (row) {
    return {
      downloading: false,
      href: canirunModelUrl(row.modelId),
      installedName,
      name: row.name,
      ollamaTag: row.ollamaTag,
      progress: null,
      ...modelStats(row),
    };
  }
  return {
    downloading: false,
    href: modelId ? canirunModelUrl(modelId) : null,
    installedName,
    name: installedName,
    ollamaTag: installedName,
    progress: null,
    score: "—",
    scoreValue: null,
    size: "—",
    tokensPerSecond: "—",
  };
}

function modelStats(row: RecommendedModel): {
  score: string;
  scoreValue: number | null;
  size: string;
  tokensPerSecond: string;
} {
  const tokens = row.tokensPerSecond;
  return {
    score: row.score === null ? "—" : `${Math.round(row.score)} / 100`,
    scoreValue: row.score,
    size: `${formatGb(row.vramGb)} GB`,
    tokensPerSecond:
      tokens === null || tokens <= 0 ? "—" : `~${Math.round(tokens)} tok/s`,
  };
}

function modelPullMatches(pullModel: string, tag: string): boolean {
  return findInstalledName(tag, [pullModel]) !== null;
}

function formatGb(value: number): string {
  if (value <= 0) {
    return "—";
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function ollamaActionError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("DownloadInProgress")) {
    return "A model is already downloading.";
  }
  if (message.includes("Ollama is not running")) {
    return "Ollama is not running.";
  }
  return message.length > 0 ? message : fallback;
}

async function loadModelsOpenState(): Promise<ModelsOpenState> {
  try {
    const [status, hardware, names, pull] = await Promise.all([
      getOllamaStatus(),
      getSystemHardware(),
      listOllamaModels().catch((): string[] => []),
      getOllamaPull().catch(() => null),
    ]);
    const { installed, recommendations } = recommendModels(hardware, names);
    return {
      hardware,
      installed: names,
      installedStats: installed,
      ollamaRunning: status.running,
      pull,
      recommendations,
    };
  } catch {
    return {
      hardware: null,
      installed: [],
      installedStats: [],
      ollamaRunning: false,
      pull: null,
      recommendations: [],
    };
  }
}

function pullOutcomeKey(pull: OllamaPullProgress): string {
  if (pull.done) {
    return `${pull.model}:done`;
  }
  if (pull.cancelled) {
    return `${pull.model}:cancelled`;
  }
  return `${pull.model}:failed`;
}

async function announcePullOutcome(
  next: OllamaPullProgress | null,
  toastedKey: { current: string | null },
  refreshInstalled: () => Promise<void>
): Promise<void> {
  if (!next || next.active) {
    return;
  }
  const key = pullOutcomeKey(next);
  if (toastedKey.current === key) {
    return;
  }
  toastedKey.current = key;
  if (next.done) {
    toast.success(`Downloaded ${next.model}.`);
    await refreshInstalled();
    return;
  }
  if (next.cancelled) {
    toast("Download cancelled.");
    return;
  }
  toast.error("Could not download the model.");
}

function downloadStatusLabel(progress: OllamaPullProgress | null): string {
  if (!(progress && progress.total > 0)) {
    return "Downloading";
  }
  const pct = Math.min(
    100,
    Math.round((progress.completed / progress.total) * 100)
  );
  return `Downloading (${pct}%)`;
}
