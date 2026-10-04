import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  type CanirunCatalog,
  parseCatalog,
  type RecommendHardware,
  recommendModels,
} from "./models.ts";

const catalog: CanirunCatalog = parseCatalog(
  JSON.parse(
    readFileSync(new URL("./canirun-catalog.json", import.meta.url), "utf8")
  )
);

const profilePattern = /^[\w ]+\|\d+$/;

function hardware(chipName: string, ramGb: number): RecommendHardware {
  return { chipName, cpuCores: 10, ramGb };
}

test("the snapshot carries an Ollama tag and a Q4 size for every model", () => {
  assert.equal(catalog.quantization, "Q4_K_M");
  assert.ok(catalog.models.length > 0);
  for (const model of catalog.models) {
    assert.ok(model.ollamaId.length > 0, model.id);
    assert.ok(model.useCase.length > 0, model.id);
    assert.ok(model.paramsBillions > 0, model.id);
    assert.ok(model.q4DiskGb > 0, model.id);
    assert.ok(model.q4VramGb > 0, model.id);
  }
});

test("the snapshot grades every model for every Mac profile", () => {
  assert.ok(catalog.profiles.length > 0);
  for (const profile of catalog.profiles) {
    assert.match(profile, profilePattern, profile);
    const ramGb = Number(profile.split("|")[1]);
    assert.ok(ramGb > 0, profile);
  }
  const expected = [...catalog.profiles];
  for (const model of catalog.models) {
    assert.deepEqual(Object.keys(model.grades), expected, model.id);
    for (const [profile, grade] of Object.entries(model.grades)) {
      assert.equal(
        typeof grade.compatible,
        "boolean",
        `${model.id} ${profile}`
      );
      assert.equal(typeof grade.score, "number", `${model.id} ${profile}`);
      if (grade.compatible) {
        assert.ok(grade.score > 0, `${model.id} ${profile}`);
        assert.ok(grade.tokensPerSecond > 0, `${model.id} ${profile}`);
      }
      assert.ok(grade.vramGb > 0, `${model.id} ${profile}`);
    }
  }
});

test("the snapshot covers the shipping Apple Silicon memory sizes in order", () => {
  const byChip: [string, number[]][] = [];
  for (const profile of catalog.profiles) {
    const [chip, ramText] = profile.split("|");
    const ramGb = Number(ramText);
    const last = byChip.at(-1);
    if (last && last[0] === chip) {
      last[1].push(ramGb);
    } else {
      byChip.push([chip ?? "", [ramGb]]);
    }
  }
  assert.deepEqual(byChip, [
    ["Apple M1", [8, 16]],
    ["Apple M1 Pro", [16, 32]],
    ["Apple M1 Max", [32, 64]],
    ["Apple M1 Ultra", [64, 128]],
    ["Apple M2", [8, 16, 24]],
    ["Apple M2 Pro", [16, 32]],
    ["Apple M2 Max", [32, 64, 96]],
    ["Apple M2 Ultra", [64, 128, 192]],
    ["Apple M3", [8, 16, 24]],
    ["Apple M3 Pro", [18, 36]],
    ["Apple M3 Max", [36, 48, 64, 96, 128]],
    ["Apple M3 Ultra", [96, 256, 512]],
    ["Apple M4", [16, 24, 32]],
    ["Apple M4 Pro", [24, 48, 64]],
    ["Apple M4 Max", [36, 48, 64, 128]],
    ["Apple M4 Ultra", [96, 256, 512]],
    ["Apple M5", [16, 24, 32]],
    ["Apple M5 Pro", [24, 48, 64]],
    ["Apple M5 Max", [36, 48, 64, 128]],
    ["Apple M5 Ultra", [96, 256, 512]],
    ["Apple M6", [16, 24, 32]],
  ]);
});

test("the snapshot recommends models for a current Mac", () => {
  const { recommendations } = recommendModels(
    hardware("Apple M4 Pro", 24),
    [],
    catalog
  );

  assert.ok(recommendations.length > 0);
  for (const row of recommendations) {
    assert.equal(row.hasGrade, true, row.modelId);
    assert.equal(row.compatible, true, row.modelId);
    assert.ok((row.score ?? 0) >= 50, row.modelId);
    assert.ok(row.paramsBillions >= 6, row.modelId);
    assert.ok(row.ollamaTag.length > 0, row.modelId);
  }
});
