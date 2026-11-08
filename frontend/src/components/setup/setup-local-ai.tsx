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
import { ollamaScreen } from "@/lib/onboarding";

// How often the Start screen checks whether local AI came up on its own. The
// text says "every few seconds".
const recheckMs = 4000;
const skipNote =
  "Chat and Dream won't work until you finish this in Settings › Models.";
const missingSkipNote = "Chat and Dream won't work until you reinstall Sage.";

type LocalAiScreen =
  | { kind: "checking"; starting: boolean }
  | { kind: "downloads"; models: SetupModelNames }
  | { kind: "missing" }
  | { kind: "start"; models: SetupModelNames; reason: string | null };

const startFailedReason = "Sage couldn't start local AI.";

/**
 * Step 1: get local AI running and the two models downloading. Sage starts local
 * AI itself, so the person only sees a start when that did not work. The screen
 * follows what local AI is doing right now, so a refresh or a return from a
 * later step finds the right one.
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
        reason: "Sage couldn't check for local AI.",
      });
      return;
    }
    const models = { embed: setup.embedModel, summary: setup.summaryModel };
    const next = ollamaScreen(setup);
    if (next === "downloads") {
      show({ kind: "downloads", models });
      return;
    }
    if (next === "missing") {
      show({ kind: "missing" });
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

  // A failed start moves on by itself once local AI answers. The person does
  // not have to press Try again.
  const watching = screen.kind === "start";
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
        if (!cancelled && setup.running) {
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
  }, [resolve, watching]);

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
    case "missing":
      return <MissingScreen onBack={onBack} onSkip={onNext} />;
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
        Sage runs AI models on this Mac. Your writing is never sent anywhere.
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
      className="bg-card flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm"
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
        {starting ? "Starting local AI…" : "Checking for local AI…"}
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

  // Queue what local AI lacks, embedding model first, once. The screen always
  // shows, even when both models are ready, and the person clicks through. A
  // model that failed or was cancelled earlier waits for the person to try
  // again.
  const queued = useRef(false as boolean);
  useEffect(() => {
    if (queued.current || names === null || readiness === null) {
      return;
    }
    queued.current = true;
    const missing = [
      readiness.embed ? null : names.embed,
      readiness.summary ? null : names.summary,
    ].filter((name): name is string => name !== null && !(name in problems));
    if (missing.length > 0) {
      enqueue(missing);
    }
  }, [enqueue, names, problems, readiness]);

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
        <span aria-hidden className="bg-primary size-2 rounded-full" />
        Local AI is running
      </StatusCard>
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Sage needs these two models</h2>
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
            {starting ? "Starting…" : "Try again"}
          </Button>
        }
      >
        <span aria-hidden className="bg-muted-foreground size-2 rounded-full" />
        Local AI isn&apos;t running
      </StatusCard>
      <SetupText>
        Sage starts local AI for you when it opens. Try again to start it now.
      </SetupText>
      {reason ? (
        <p className="text-destructive text-sm" role="alert">
          {reason}
        </p>
      ) : null}
      <SetupText>
        Once local AI is running, Sage downloads two models:{" "}
        <span className="font-mono">{models.summary}</span> and{" "}
        <span className="font-mono">{models.embed}</span>.
      </SetupText>
      <SkipFooter note={skipNote} onBack={onBack} onSkip={onSkip} />
    </>
  );
}

function MissingScreen({
  onBack,
  onSkip,
}: {
  onBack: () => void;
  onSkip: () => void;
}) {
  return (
    <>
      <LocalAiIntro />
      <StatusCard>
        <span aria-hidden className="bg-destructive size-2 rounded-full" />
        Local AI isn&apos;t available
      </StatusCard>
      <SetupText>
        Sage&apos;s local AI files are missing. Reinstall Sage.
      </SetupText>
      <SkipFooter note={missingSkipNote} onBack={onBack} onSkip={onSkip} />
    </>
  );
}

function SkipFooter({
  note,
  onBack,
  onSkip,
}: {
  note: string;
  onBack: () => void;
  onSkip: () => void;
}) {
  return (
    <SetupFooter>
      <Button onClick={onBack} variant="ghost">
        Back
      </Button>
      <SetupFooterEnd>
        <SetupNote>{note}</SetupNote>
        <Button onClick={onSkip} variant="outline">
          Skip this step
        </Button>
      </SetupFooterEnd>
    </SetupFooter>
  );
}
