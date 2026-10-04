import assert from "node:assert/strict";
import test from "node:test";

import {
  type CanirunCatalog,
  type CatalogGrade,
  type CatalogModel,
  compareScoresDescending,
  findCanirunModelId,
  type RecommendHardware,
  recommendModels,
  resolveGradeProfile,
} from "./models.ts";

function grade(
  score: number,
  overrides: Partial<CatalogGrade> = {}
): CatalogGrade {
  return {
    compatible: true,
    diskSizeGb: 4,
    score,
    tokensPerSecond: 40,
    vramGb: 5,
    ...overrides,
  };
}

function model(
  overrides: Partial<CatalogModel> & { id: string }
): CatalogModel {
  return {
    grades: {},
    id: overrides.id,
    name: overrides.id,
    ollamaId: overrides.id,
    paramsBillions: 8,
    q4DiskGb: 4,
    q4VramGb: 5,
    recommendedRamGb: 8,
    useCase: ["chat"],
    ...overrides,
  };
}

const catalog: CanirunCatalog = {
  models: [
    model({
      grades: {
        "Apple M4 Pro|24": grade(96, { tokensPerSecond: 61 }),
        "Apple M4|16": grade(62),
        "Apple M4|32": grade(90, { tokensPerSecond: 55 }),
        "Apple M5|32": grade(70),
      },
      id: "small-8b",
      name: "Small 8B",
      ollamaId: "small:8b",
    }),
  ],
  profiles: ["Apple M4|16", "Apple M4|32", "Apple M4 Pro|24", "Apple M5|32"],
  quantization: "Q4_K_M",
};

function hardware(chipName: string, ramGb: number): RecommendHardware {
  return { chipName, cpuCores: 10, ramGb };
}

test("recommendModels grades an exact chip and RAM match", () => {
  const { recommendations } = recommendModels(
    hardware("Apple M4 Pro", 24),
    [],
    catalog
  );

  assert.equal(recommendations.length, 1);
  assert.equal(recommendations[0]?.hasGrade, true);
  assert.equal(recommendations[0]?.score, 96);
  assert.equal(recommendations[0]?.tokensPerSecond, 61);
});

test("recommendModels falls back to the nearest stored RAM for the chip", () => {
  const { recommendations } = recommendModels(
    hardware("Apple M4", 64),
    [],
    catalog
  );

  assert.equal(recommendations[0]?.score, 90);
});

test("recommendModels falls back to the base chip of the generation", () => {
  const exact = recommendModels(hardware("Apple M5 Pro", 32), [], catalog);
  const nearest = recommendModels(hardware("Apple M5 Max", 24), [], catalog);

  assert.equal(exact.recommendations[0]?.score, 70);
  assert.equal(nearest.recommendations[0]?.score, 70);
});

test("recommendModels shows the Q4 size and dashes when there is no grade", () => {
  const { installed, recommendations } = recommendModels(
    hardware("Apple M9 Ultra", 64),
    ["small:8b"],
    catalog
  );

  assert.deepEqual(recommendations, []);
  assert.equal(installed.length, 1);
  assert.equal(installed[0]?.hasGrade, false);
  assert.equal(installed[0]?.score, null);
  assert.equal(installed[0]?.tokensPerSecond, null);
  assert.equal(installed[0]?.vramGb, 5);
  assert.equal(installed[0]?.diskSizeGb, 4);
});

test("recommendModels keeps installed models ungraded without hardware", () => {
  const { installed } = recommendModels(null, ["small:8b"], catalog);

  assert.equal(installed.length, 1);
  assert.equal(installed[0]?.hasGrade, false);
  assert.equal(installed[0]?.score, null);
});

test("recommendModels grades an installed model that is in the snapshot", () => {
  const { installed } = recommendModels(
    hardware("Apple M4 Pro", 24),
    ["small:8b"],
    catalog
  );

  assert.equal(installed.length, 1);
  assert.equal(installed[0]?.modelId, "small-8b");
  assert.equal(installed[0]?.score, 96);
});

test("recommendModels keeps small, non-text, and low-scoring models out", () => {
  const crowded: CanirunCatalog = {
    models: [
      model({ id: "tiny-1b", ollamaId: "tiny:1b", paramsBillions: 1 }),
      model({ id: "image-8b", ollamaId: "image:8b", useCase: ["image"] }),
      model({ id: "weak-8b", ollamaId: "weak:8b" }),
      model({
        id: "strong-70b",
        ollamaId: "strong:70b",
        paramsBillions: 70,
      }),
    ],
    profiles: ["Apple M4|16"],
    quantization: "Q4_K_M",
  };
  for (const entry of crowded.models) {
    entry.grades["Apple M4|16"] =
      entry.id === "weak-8b" ? grade(40) : grade(80);
  }

  const { recommendations } = recommendModels(
    hardware("Apple M4", 16),
    [],
    crowded
  );

  assert.deepEqual(
    recommendations.map((row) => row.modelId),
    ["strong-70b"]
  );
});

test("recommendModels sorts by score, then by parameter count", () => {
  const crowded: CanirunCatalog = {
    models: [
      model({ id: "a-8b", ollamaId: "a:8b" }),
      model({ id: "b-30b", ollamaId: "b:30b", paramsBillions: 30 }),
      model({ id: "c-70b", ollamaId: "c:70b", paramsBillions: 70 }),
    ],
    profiles: ["Apple M4|16"],
    quantization: "Q4_K_M",
  };
  for (const entry of crowded.models) {
    entry.grades["Apple M4|16"] = entry.id === "a-8b" ? grade(90) : grade(80);
  }

  const { recommendations } = recommendModels(
    hardware("Apple M4", 16),
    [],
    crowded
  );

  assert.deepEqual(
    recommendations.map((row) => row.modelId),
    ["a-8b", "c-70b", "b-30b"]
  );
});

test("compareScoresDescending puts the highest score first and ungraded last", () => {
  const scores = [null, 72, 91, null, 84];

  assert.deepEqual(scores.toSorted(compareScoresDescending), [
    91,
    84,
    72,
    null,
    null,
  ]);
});

test("resolveGradeProfile prefers the exact profile over the nearest one", () => {
  const profiles = ["Apple M4|16", "Apple M4|32"];

  assert.equal(resolveGradeProfile(profiles, "Apple M4", 32), "Apple M4|32");
  assert.equal(resolveGradeProfile(profiles, "Apple M4", 30), "Apple M4|32");
  assert.equal(resolveGradeProfile(profiles, "Apple M4", 24), "Apple M4|16");
  assert.equal(resolveGradeProfile(profiles, "Intel Core i9", 32), null);
});

test("findCanirunModelId maps a tag to the snapshot model id", () => {
  assert.equal(findCanirunModelId("small:8b", catalog), "small-8b");
  assert.equal(findCanirunModelId("small:8b-q4_K_M", catalog), "small-8b");
  assert.equal(findCanirunModelId("unknown:8b", catalog), null);
});
