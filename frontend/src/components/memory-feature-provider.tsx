import { createContext, type ReactNode, use, useEffect, useState } from "react";

import {
  getBuildFeatures,
  hasNativeBridge,
  waitForNativeBridge,
} from "@/bridge";

interface MemoryFeatureState {
  memoryEnabled: boolean;
  ready: boolean;
}

const initialState: MemoryFeatureState = {
  memoryEnabled: false,
  ready: false,
};

const retryInitialMs = 250;
const retryMaxMs = 5000;
const MemoryFeatureContext = createContext<MemoryFeatureState>(initialState);
let memoryFeatureRequest: Promise<boolean> | undefined;

function loadMemoryFeature(): Promise<boolean> {
  if (!memoryFeatureRequest) {
    const request = (async () => {
      if (!((await waitForNativeBridge()) && hasNativeBridge())) {
        throw new Error("The native bridge is not available yet.");
      }
      return (await getBuildFeatures()).memory;
    })();
    const cachedRequest = request.catch((error: unknown) => {
      if (memoryFeatureRequest === cachedRequest) {
        memoryFeatureRequest = undefined;
      }
      throw error;
    });
    memoryFeatureRequest = cachedRequest;
  }
  return memoryFeatureRequest;
}

export function MemoryFeatureProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(initialState);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let retryMs = retryInitialMs;

    const load = async () => {
      try {
        const memoryEnabled = await loadMemoryFeature();
        if (active) {
          setState({ memoryEnabled, ready: true });
        }
      } catch {
        if (!active) {
          return;
        }
        timer = window.setTimeout(() => {
          load().catch(() => undefined);
        }, retryMs);
        retryMs = Math.min(retryMs * 2, retryMaxMs);
      }
    };

    load().catch(() => undefined);
    return () => {
      active = false;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  return <MemoryFeatureContext value={state}>{children}</MemoryFeatureContext>;
}

export function useMemoryFeature(): MemoryFeatureState {
  return use(MemoryFeatureContext);
}
