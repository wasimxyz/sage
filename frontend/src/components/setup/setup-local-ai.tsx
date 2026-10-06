import { useCallback, useEffect, useRef, useState } from "react";

import {
  getOllamaSetupStatus,
  getSystemHardware,
  type SystemHardware,
  startOllamaServer,
} from "@/bridge";
import { useModelDownloads } from "@/components/model-downloads-provider";
import { useOnboarding } from "@/components/onboarding-provider";
import { ModelDownloadRow } from "@/components/setup/model-rows";
import {
  SetupBody,
  SetupFooter,
  SetupFooterEnd,
  SetupFrame,
  SetupHeader,
  SetupIntro,
  SetupList,
  SetupNote,
  SetupText,
  SetupTitle,
} from "@/components/setup/setup-frame";
import {
  defaultModelNames,
  type SetupModelNames,
  useSetupModels,
} from "@/components/setup/use-setup-models";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { handlerErrorMessage } from "@/lib/handler-errors";
import { localAiDone, ollamaScreen } from "@/lib/onboarding";

const ollamaDownloadUrl = "https://ollama.com/download";
// How often the Install and Start screens look for Ollama. The text says "every
// few seconds".
const recheckMs = 4000;
const skipNote =
  "Chat and Dream won't work until you finish this in Settings › Models.";

type LocalAiScreen =
  | { kind: "checking"; starting: boolean }
  | { kind: "downloads"; models: SetupModelNames }
  | { kind: "install"; models: SetupModelNames }
  | { kind: "start"; models: SetupModelNames; reason: string | null };

const startFailedReason = "Sage couldn't start Ollama.";

/**
 * Step 1: get Ollama running and the two models downloading. The screen follows
 * what Ollama is doing right now, so a refresh or a return from a later step
 * finds the right one.
 */
export function SetupLocalAi() {
  const {
    actions: { goTo, skipSetup },
  } = useOnboarding();
  const [screen, setScreen] = useState<LocalAiScreen>({
    kind: "checking",
    starting: false,
  });
  // Only the newest check may move the screen. React runs the first effect
  // twice in development, and a slow start can outlive a newer check.
  const latestCheck = useRef(0);

  const resolve = useCallback(async () => {
    latestCheck.current += 1;
    const check = latestCheck.current;
    const show = (shown: LocalAiScreen) => {
      if (check === latestCheck.current) {
        setScreen(shown);
      }
    };
    let setup: Awaited<ReturnType<typeof getOllamaSetupStatus>>;
    try {
      setup = await getOllamaSetupStatus();
    } catch {
      show({
        kind: "start",
        models: defaultModelNames,
        reason: "Sage couldn't check for Ollama.",
      });
      return;
    }
    const models = { embed: setup.embedModel, summary: setup.summaryModel };
    const next = ollamaScreen(setup);
    if (next === "downloads") {
      show({ kind: "downloads", models });
      return;
    }
    if (next === "install") {
      show({ kind: "install", models });
      return;
    }
    show({ kind: "checking", starting: true });
    try {
      await startOllamaServer();
      show({ kind: "downloads", models });
    } catch (error: unknown) {
      show({
        kind: "start",
        models,
        reason: handlerErrorMessage(error) || startFailedReason,
      });
    }
  }, []);

  useEffect(() => {
    resolve().catch(() => undefined);
  }, [resolve]);

  // Opening or installing Ollama by hand moves the screen along by itself.
  const watching = screen.kind === "install" || screen.kind === "start";
  const watchingInstall = screen.kind === "install";
  useEffect(() => {
    if (!watching) {
      return;
    }
    let cancelled = false;
    let busy = false;
    const tick = async () => {
      if (busy) {
        return;
      }
      busy = true;
      try {
        const setup = await getOllamaSetupStatus();
        // An installed Ollama that is not running gets one start, from the
        // same check. A start screen only waits for the person.
        if (
          !cancelled &&
          (setup.running || (watchingInstall && setup.installed))
        ) {
          await resolve();
        }
      } catch {
        // Look again at the next tick.
      } finally {
        busy = false;
      }
    };
    const timer = window.setInterval(() => {
      tick().catch(() => undefined);
    }, recheckMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [resolve, watching, watchingInstall]);

  const handleBack = useCallback(() => goTo("welcome"), [goTo]);
  const handleNext = useCallback(() => goTo("protect"), [goTo]);

  return (
    <SetupFrame>
      <SetupHeader onSkip={skipSetup} step={1} />
      <SetupBody>
        <LocalAiScreenView
          onBack={handleBack}
          onNext={handleNext}
          onStart={resolve}
          screen={screen}
        />
      </SetupBody>
    </SetupFrame>
  );
}

function LocalAiScreenView({
  onBack,
  onNext,
  onStart,
  screen,
}: {
  onBack: () => void;
  onNext: () => void;
  onStart: () => Promise<void>;
  screen: LocalAiScreen;
}) {
  switch (screen.kind) {
    case "downloads":
      return <DownloadsScreen onBack={onBack} onNext={onNext} />;
    case "install":
      return <InstallScreen onBack={onBack} onSkip={onNext} />;
    case "start":
      return (
        <StartScreen
          models={screen.models}
          onBack={onBack}
          onSkip={onNext}
          onStart={onStart}
          reason={screen.reason}
        />
      );
    default:
      return <CheckingScreen starting={screen.starting} />;
  }
}

function LocalAiIntro() {
  return (
    <SetupIntro>
      <SetupTitle>Set up local AI</SetupTitle>
      <SetupText>
        Sage runs AI models on this Mac with Ollama. Your writing is never sent
        anywhere.
      </SetupText>
    </SetupIntro>
  );
}

function StatusCard({
  children,
  end,
}: {
  children: React.ReactNode;
  end?: React.ReactNode;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-lg border bg-card px-3 py-2.5 text-sm"
      role="status"
    >
      <span className="flex items-center gap-2 font-medium">{children}</span>
      {end}
    </div>
  );
}

function CheckingScreen({ starting }: { starting: boolean }) {
  return (
    <>
      <LocalAiIntro />
      <StatusCard>
        <Spinner aria-hidden />
        {starting ? "Starting Ollama…" : "Checking for Ollama…"}
      </StatusCard>
    </>
  );
}

function DownloadsScreen({
  onBack,
  onNext,
}: {
  onBack: () => void;
  onNext: () => void;
}) {
  const {
    actions: { cancel, enqueue },
    state: { problems },
  } = useModelDownloads();
  const { names, readiness, rows } = useSetupModels();
  const [hardware, setHardware] = useState<SystemHardware | null>(null);

  useEffect(() => {
    getSystemHardware()
      .then(setHardware)
      .catch(() => undefined);
  }, []);

  // The first read decides. With Ollama running and both models pulled there
  // is nothing to set up, so the step is skipped. Otherwise queue what Ollama
  // lacks, embedding model first. Later reads only update the rows, so
  // watching the last download finish never throws the person forward. A
  // model that failed or was cancelled earlier waits for the person to try
  // again.
  const queued = useRef(false as boolean);
  useEffect(() => {
    if (queued.current || names === null || readiness === null) {
      return;
    }
    queued.current = true;
    if (localAiDone(readiness)) {
      onNext();
      return;
    }
    const missing = [
      readiness.embed ? null : names.embed,
      readiness.summary ? null : names.summary,
    ].filter((name): name is string => name !== null && !(name in problems));
    if (missing.length > 0) {
      enqueue(missing);
    }
  }, [enqueue, names, onNext, problems, readiness]);

  const handleCancel = useCallback(() => {
    cancel().catch(() => undefined);
  }, [cancel]);
  const handleRetry = useCallback((name: string) => enqueue([name]), [enqueue]);

  return (
    <>
      <LocalAiIntro />
      <StatusCard
        end={
          hardware ? (
            <span className="text-muted-foreground text-xs">
              {hardware.chipName} · {hardware.ramGb} GB memory
            </span>
          ) : null
        }
      >
        <span aria-hidden className="size-2 rounded-full bg-primary" />
        Ollama is running
      </StatusCard>
      <div className="flex flex-col gap-2">
        <h2 className="font-medium text-sm">Sage needs these two models</h2>
        <SetupList>
          {rows.map((row) => (
            <ModelDownloadRow
              key={row.name}
              name={row.name}
              onCancel={handleCancel}
              onRetry={handleRetry}
              purpose={row.purpose}
              state={row.state}
            />
          ))}
        </SetupList>
        <p className="text-muted-foreground text-xs">
          You can pick other chat models later in Settings › Models.
        </p>
      </div>
      <SetupFooter>
        <Button onClick={onBack} variant="ghost">
          Back
        </Button>
        <SetupFooterEnd>
          <SetupNote>Downloads keep going while you finish.</SetupNote>
          <Button onClick={onNext}>Continue</Button>
        </SetupFooterEnd>
      </SetupFooter>
    </>
  );
}

function StartScreen({
  models,
  onBack,
  onSkip,
  onStart,
  reason,
}: {
  models: SetupModelNames;
  onBack: () => void;
  onSkip: () => void;
  onStart: () => Promise<void>;
  reason: string | null;
}) {
  const [starting, setStarting] = useState(false);
  const handleStart = useCallback(async () => {
    setStarting(true);
    try {
      await onStart();
    } finally {
      setStarting(false);
    }
  }, [onStart]);

  return (
    <>
      <LocalAiIntro />
      <StatusCard
        end={
          <Button
            disabled={starting}
            onClick={handleStart}
            size="sm"
            variant="outline"
          >
            {starting ? <Spinner data-icon="inline-start" /> : null}
            {starting ? "Starting…" : "Start Ollama"}
          </Button>
        }
      >
        <span aria-hidden className="size-2 rounded-full bg-muted-foreground" />
        Ollama isn&apos;t running
      </StatusCard>
      <SetupText>
        Ollama is installed, but Sage couldn&apos;t start it on its own. Try
        again here, or open the Ollama app yourself.
      </SetupText>
      {reason ? (
        <p className="text-destructive text-sm" role="alert">
          {reason}
        </p>
      ) : null}
      <SetupText>
        Once Ollama is running, Sage downloads two models:{" "}
        <span className="font-mono">{models.summary}</span> and{" "}
        <span className="font-mono">{models.embed}</span>.
      </SetupText>
      <SkipFooter onBack={onBack} onSkip={onSkip} />
    </>
  );
}

function InstallScreen({
  onBack,
  onSkip,
}: {
  onBack: () => void;
  onSkip: () => void;
}) {
  return (
    <>
      <SetupIntro>
        <SetupTitle>Install Ollama</SetupTitle>
        <SetupText>
          Sage uses the free Ollama app to run AI on this Mac. It isn&apos;t
          installed yet.
        </SetupText>
      </SetupIntro>
      <SetupList>
        <ol className="contents">
          <li className="flex items-center justify-between gap-3 p-3 text-sm">
            <span className="flex items-center gap-3">
              <StepNumber>1</StepNumber>
              Download Ollama from ollama.com.
            </span>
            <Button
              nativeButton={false}
              render={
                <a href={ollamaDownloadUrl} rel="noreferrer" target="_blank" />
              }
            >
              Download Ollama
            </Button>
          </li>
          <li className="flex items-center gap-3 p-3 text-sm">
            <StepNumber>2</StepNumber>
            Move Ollama to your Applications folder.
          </li>
          <li className="flex items-center gap-3 p-3 text-sm">
            <StepNumber>3</StepNumber>
            Open Ollama once.
          </li>
        </ol>
      </SetupList>
      <StatusCard>
        <Spinner aria-hidden />
        <span className="font-normal">
          Waiting for Ollama. Sage checks every few seconds and moves on by
          itself.
        </span>
      </StatusCard>
      <SkipFooter onBack={onBack} onSkip={onSkip} />
    </>
  );
}

function StepNumber({ children }: { children: string }) {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs">
      {children}
    </span>
  );
}

function SkipFooter({
  onBack,
  onSkip,
}: {
  onBack: () => void;
  onSkip: () => void;
}) {
  return (
    <SetupFooter>
      <Button onClick={onBack} variant="ghost">
        Back
      </Button>
      <SetupFooterEnd>
        <SetupNote>{skipNote}</SetupNote>
        <Button onClick={onSkip} variant="outline">
          Skip this step
        </Button>
      </SetupFooterEnd>
    </SetupFooter>
  );
}
