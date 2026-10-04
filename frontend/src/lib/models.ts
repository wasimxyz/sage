import catalogJson from "./canirun-catalog.json" with { type: "json" };

const canirunCatalog: CanirunCatalog = parseCatalog(catalogJson);

export interface RecommendHardware {
  chipName: string;
  cpuCores: number;
  ramGb: number;
}

export const sageEmbedPrefix = "nomic-embed-text";
export const sageSummaryPrefix = "qwen3.5:9b";
export const minScore = 50;
export const minParamsBillions = 6;

const recommendLimit = 25;
const textUseCases = new Set(["chat", "code", "reasoning"]);
const tieredChip = /^(Apple M\d+)(?: (Pro|Max|Ultra))?$/;

export interface CatalogGrade {
  compatible: boolean;
  diskSizeGb: number;
  score: number;
  tokensPerSecond: number;
  vramGb: number;
}

export interface CatalogModel {
  grades: Record<string, CatalogGrade>;
  id: string;
  name: string;
  ollamaId: string;
  paramsBillions: number;
  q4DiskGb: number;
  q4VramGb: number;
  recommendedRamGb: number;
  useCase: string[];
}

export interface CanirunCatalog {
  models: CatalogModel[];
  profiles: string[];
  quantization: string;
}

export interface RecommendedModel {
  compatible: boolean;
  diskSizeGb: number;
  hasGrade: boolean;
  modelId: string;
  name: string;
  ollamaTag: string;
  paramsBillions: number;
  score: number | null;
  tokensPerSecond: number | null;
  vramGb: number;
}

const sizeHintPattern = /:([\d.]+)b(?:-|$)/i;

const unversionedDefaults: Record<string, string> = {
  gemma3: "gemma3:4b",
  "llama3.1": "llama3.1:8b",
  "llama3.2": "llama3.2:3b",
  qwen3: "qwen3:8b",
};

export function isSageModel(name: string): boolean {
  return (
    name.startsWith(sageEmbedPrefix) ||
    modelNameMatches(name, sageSummaryPrefix)
  );
}

export function modelNameMatches(installed: string, tag: string): boolean {
  return matchRank(canonicalTag(installed), stripLatest(tag)) >= 2;
}

export function findInstalledName(
  tag: string,
  installed: readonly string[]
): string | null {
  for (const name of installed) {
    if (modelNameMatches(name, tag)) {
      return name;
    }
  }
  return null;
}

export function findCanirunModelId(
  name: string,
  catalog: CanirunCatalog = canirunCatalog
): string | null {
  return resolveCatalogModelId(name, catalog);
}

/** Whole GB, so it matches the profile keys in the snapshot. */
export function profileKey(chipName: string, ramGb: number): string {
  return `${chipName.trim()}|${Math.round(ramGb)}`;
}

/**
 * This Mac's profile in the snapshot: the exact chip and RAM, then the nearest
 * RAM for the same chip, then the base chip of that generation.
 */
export function resolveGradeProfile(
  profiles: readonly string[],
  chipName: string,
  ramGb: number
): string | null {
  const chip = chipName.trim();
  if (chip.length === 0) {
    return null;
  }
  const ram = Math.round(ramGb);
  const exact = profileKey(chip, ram);
  if (profiles.includes(exact)) {
    return exact;
  }
  const sameChip = nearestProfile(profiles, chip, ram);
  if (sameChip) {
    return sameChip;
  }
  const base = baseChipName(chip);
  if (base === null) {
    return null;
  }
  const baseExact = profileKey(base, ram);
  if (profiles.includes(baseExact)) {
    return baseExact;
  }
  return nearestProfile(profiles, base, ram);
}

export function recommendModels(
  hardware: RecommendHardware | null,
  installedNames: readonly string[],
  catalog: CanirunCatalog = canirunCatalog
): { installed: RecommendedModel[]; recommendations: RecommendedModel[] } {
  const profile =
    hardware === null
      ? null
      : resolveGradeProfile(
          catalog.profiles,
          hardware.chipName,
          hardware.ramGb
        );
  const rows = new Map<string, RecommendedModel>();
  for (const model of catalog.models) {
    rows.set(model.id, toRecommendedModel(model, profile));
  }
  const candidates: RecommendedModel[] = [];
  for (const model of catalog.models) {
    if (!isRecommendCandidate(model)) {
      continue;
    }
    const row = rows.get(model.id);
    if (
      row?.hasGrade &&
      row.compatible &&
      row.score !== null &&
      row.score >= minScore
    ) {
      candidates.push(row);
    }
  }
  candidates.sort(compareRecommendations);
  const installed: RecommendedModel[] = [];
  const seen = new Set<string>();
  for (const name of installedNames) {
    const modelId = resolveCatalogModelId(name, catalog);
    const row = modelId === null ? undefined : rows.get(modelId);
    if (row && !seen.has(row.modelId)) {
      seen.add(row.modelId);
      installed.push(row);
    }
  }
  return {
    installed,
    recommendations: candidates.slice(0, recommendLimit),
  };
}

/** Orders scores highest first. A model with no grade goes last. */
export function compareScoresDescending(
  a: number | null,
  b: number | null
): number {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return b - a;
}

function toRecommendedModel(
  model: CatalogModel,
  profile: string | null
): RecommendedModel {
  const grade = profile === null ? undefined : model.grades[profile];
  if (!grade) {
    return {
      compatible: false,
      diskSizeGb: model.q4DiskGb,
      hasGrade: false,
      modelId: model.id,
      name: model.name,
      ollamaTag: model.ollamaId,
      paramsBillions: model.paramsBillions,
      score: null,
      tokensPerSecond: null,
      vramGb: model.q4VramGb,
    };
  }
  return {
    compatible: grade.compatible,
    diskSizeGb: grade.diskSizeGb,
    hasGrade: true,
    modelId: model.id,
    name: model.name,
    ollamaTag: model.ollamaId,
    paramsBillions: model.paramsBillions,
    score: grade.score,
    tokensPerSecond: grade.compatible ? grade.tokensPerSecond : 0,
    vramGb: grade.vramGb,
  };
}

function isRecommendCandidate(model: CatalogModel): boolean {
  return (
    model.ollamaId.length > 0 &&
    model.paramsBillions >= minParamsBillions &&
    isTextUseCase(model.useCase)
  );
}

function compareRecommendations(
  a: RecommendedModel,
  b: RecommendedModel
): number {
  const score = (b.score ?? 0) - (a.score ?? 0);
  if (score !== 0) {
    return score;
  }
  if (b.paramsBillions !== a.paramsBillions) {
    return b.paramsBillions - a.paramsBillions;
  }
  return a.name.localeCompare(b.name);
}

function nearestProfile(
  profiles: readonly string[],
  chipName: string,
  ramGb: number
): string | null {
  const prefix = `${chipName}|`;
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestRam = Number.POSITIVE_INFINITY;
  for (const profile of profiles) {
    if (!profile.startsWith(prefix)) {
      continue;
    }
    const ram = Number(profile.slice(prefix.length));
    if (!Number.isFinite(ram)) {
      continue;
    }
    const distance = Math.abs(ram - ramGb);
    // A tie keeps the smaller RAM, so the grade never overstates the Mac.
    if (
      distance < bestDistance ||
      (distance === bestDistance && ram < bestRam)
    ) {
      best = profile;
      bestDistance = distance;
      bestRam = ram;
    }
  }
  return best;
}

function baseChipName(chipName: string): string | null {
  const match = tieredChip.exec(chipName);
  if (!match?.[2]) {
    return null;
  }
  return match[1] ?? null;
}

function resolveCatalogModelId(
  name: string,
  catalog: CanirunCatalog
): string | null {
  const installed = canonicalTag(name);
  const hint = sizeHint(installed);
  const matches: { id: string; rank: number; tag: string }[] = [];
  for (const model of catalog.models) {
    const rank = matchRank(installed, stripLatest(model.ollamaId));
    if (rank > 0) {
      matches.push({ id: model.id, rank, tag: model.ollamaId });
    }
  }
  if (matches.length === 0) {
    return null;
  }
  const maxRank = Math.max(...matches.map((item) => item.rank));
  let ranked = matches.filter((item) => item.rank === maxRank);
  if (maxRank === 1 && ranked.length > 1 && hint === null) {
    return null;
  }
  if (hint !== null && ranked.length > 1) {
    ranked = [...ranked].sort((a, b) => {
      const aDiff = Math.abs(
        (sizeHint(a.tag) ?? Number.POSITIVE_INFINITY) - hint
      );
      const bDiff = Math.abs(
        (sizeHint(b.tag) ?? Number.POSITIVE_INFINITY) - hint
      );
      return aDiff - bDiff;
    });
  }
  const [best] = ranked;
  return best ? best.id : null;
}

function isTextUseCase(value: readonly string[]): boolean {
  return value.some((entry) => textUseCases.has(entry));
}

function stripLatest(name: string): string {
  return name.endsWith(":latest") ? name.slice(0, -":latest".length) : name;
}

function canonicalTag(name: string): string {
  const base = stripLatest(name);
  if (base.includes(":")) {
    return base;
  }
  return unversionedDefaults[base] ?? base;
}

function matchRank(installed: string, tag: string): number {
  if (installed === tag) {
    return 3;
  }
  if (installed.startsWith(`${tag}:`) || installed.startsWith(`${tag}-`)) {
    return 2;
  }
  if (tag.startsWith(`${installed}:`) || tag.startsWith(`${installed}-`)) {
    return 1;
  }
  return 0;
}

function sizeHint(tag: string): number | null {
  const match = sizeHintPattern.exec(tag);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseGrade(value: unknown): CatalogGrade | null {
  const item = asRecord(value);
  if (!item) {
    return null;
  }
  return {
    compatible: item.compatible === true,
    diskSizeGb: asFiniteNumber(item.diskSizeGb, 0),
    score: asFiniteNumber(item.score, 0),
    tokensPerSecond: asFiniteNumber(item.tokensPerSecond, 0),
    vramGb: asFiniteNumber(item.vramGb, 0),
  };
}

function parseModel(value: unknown): CatalogModel | null {
  const item = asRecord(value);
  if (
    !(
      item &&
      typeof item.id === "string" &&
      typeof item.name === "string" &&
      typeof item.ollamaId === "string"
    )
  ) {
    return null;
  }
  const grades: Record<string, CatalogGrade> = {};
  const rawGrades = asRecord(item.grades);
  if (rawGrades) {
    for (const [profile, grade] of Object.entries(rawGrades)) {
      const parsed = parseGrade(grade);
      if (parsed) {
        grades[profile] = parsed;
      }
    }
  }
  const useCase = Array.isArray(item.useCase)
    ? item.useCase.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    grades,
    id: item.id,
    name: item.name,
    ollamaId: item.ollamaId,
    paramsBillions: asFiniteNumber(item.paramsBillions, 0),
    q4DiskGb: asFiniteNumber(item.q4DiskGb, 0),
    q4VramGb: asFiniteNumber(item.q4VramGb, 0),
    recommendedRamGb: asFiniteNumber(item.recommendedRamGb, 0),
    useCase,
  };
}

export function parseCatalog(value: unknown): CanirunCatalog {
  const record = asRecord(value);
  const rawModels = Array.isArray(record?.models) ? record.models : [];
  const models: CatalogModel[] = [];
  for (const entry of rawModels) {
    const model = parseModel(entry);
    if (model) {
      models.push(model);
    }
  }
  const rawProfiles = Array.isArray(record?.profiles) ? record.profiles : [];
  const profiles = rawProfiles.filter(
    (entry): entry is string => typeof entry === "string"
  );
  return {
    models,
    profiles,
    quantization:
      typeof record?.quantization === "string" ? record.quantization : "",
  };
}
