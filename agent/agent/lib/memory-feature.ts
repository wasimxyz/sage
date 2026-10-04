import { sageFetch } from "./sage";
import { memoryFeatureEnabled as readMemoryFeature } from "./memory-feature-state";

export { memoryEnabledFrom } from "./memory-feature-state";

export function memoryFeatureEnabled(): Promise<boolean> {
  return readMemoryFeature(sageFetch);
}
