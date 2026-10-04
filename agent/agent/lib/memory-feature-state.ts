type FeatureFetcher = (
  pathname: string,
  init?: RequestInit
) => Promise<Response>;

interface CachedFeature {
  expiresAt: number;
  promise: Promise<boolean>;
}

const featureCacheMs = 1000;
const featureCache = new WeakMap<FeatureFetcher, CachedFeature>();

export async function memoryFeatureEnabled(
  fetchFeature: FeatureFetcher,
  nowMs = Date.now()
): Promise<boolean> {
  const cached = featureCache.get(fetchFeature);
  if (cached && nowMs < cached.expiresAt) {
    return await cached.promise;
  }

  const request = (async () => {
    const response = await fetchFeature("/features", {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) {
      throw new Error("Sage feature check failed.");
    }
    const payload: unknown = await response.json();
    if (!isFeaturePayload(payload)) {
      throw new Error("Sage returned an invalid feature response.");
    }
    return payload.memory;
  })();
  const entry = { expiresAt: nowMs + featureCacheMs, promise: request };
  featureCache.set(fetchFeature, entry);

  try {
    return await request;
  } catch {
    if (featureCache.get(fetchFeature) === entry) {
      featureCache.delete(fetchFeature);
    }
    return false;
  }
}

export function memoryEnabledFrom(payload: unknown): boolean {
  return isFeaturePayload(payload) && payload.memory;
}

function isFeaturePayload(payload: unknown): payload is { memory: boolean } {
  return (
    payload !== null &&
    typeof payload === "object" &&
    "memory" in payload &&
    typeof payload.memory === "boolean"
  );
}
