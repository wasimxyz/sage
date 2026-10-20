/** What a poll needs from the page. Tests pass a fake. */
export interface PollHost {
  clearTimer: (id: number) => void;
  isHidden: () => boolean;
  onVisibilityChange: (listener: () => void) => () => void;
  setTimer: (callback: () => void, ms: number) => number;
}

export interface VisiblePollOptions {
  /** One check. The poll waits for it to end before it plans the next. */
  check: () => Promise<void>;
  /** The wait from the end of one check to the start of the next. */
  delayMs: number | (() => number);
  host: PollHost;
  /** Run a check at once, even in a hidden window. */
  leading: boolean;
}

export const documentPollHost: PollHost = {
  clearTimer: (id) => window.clearTimeout(id),
  isHidden: () => document.hidden,
  onVisibilityChange: (listener) => {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
  setTimer: (callback, ms) => window.setTimeout(callback, ms),
};

/**
 * Runs `check` again `delayMs` after each one ends, while the window is
 * visible. Only one check runs at a time, so a slow answer never stacks up
 * more checks. A hidden window drops the timer, and a check runs as soon as
 * the window comes back. Returns a function that stops the poll.
 */
export function startVisiblePoll({
  check,
  delayMs,
  host,
  leading,
}: VisiblePollOptions): () => void {
  let timer: number | undefined;
  let checking = false;
  let stopped = false;

  const clear = () => {
    if (timer !== undefined) {
      host.clearTimer(timer);
      timer = undefined;
    }
  };

  const schedule = () => {
    clear();
    if (stopped || host.isHidden()) {
      return;
    }
    const wait = typeof delayMs === "function" ? delayMs() : delayMs;
    timer = host.setTimer(kick, wait);
  };

  const run = async () => {
    timer = undefined;
    if (checking || stopped) {
      return;
    }
    checking = true;
    try {
      await check();
    } finally {
      checking = false;
      schedule();
    }
  };

  // A failed check still plans the next one, in `run`'s finally.
  const kick = () => {
    run().catch(() => undefined);
  };

  // A check still running when the window comes back plans the next one
  // when it ends.
  const stopListening = host.onVisibilityChange(() => {
    clear();
    if (!host.isHidden()) {
      kick();
    }
  });

  if (leading) {
    kick();
  } else {
    schedule();
  }

  return () => {
    stopped = true;
    clear();
    stopListening();
  };
}
