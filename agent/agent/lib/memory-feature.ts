import { memoryFeatureEnabled as readMemoryFeature } from "./memory-feature-state";
import { sageFetch } from "./sage";

export function memoryFeatureEnabled(): Promise<boolean> {
  return readMemoryFeature(sageFetch);
}
