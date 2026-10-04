import type { FixtureCatalogEntry } from "./types.ts";

export const fixtureCatalog: FixtureCatalogEntry[] = [
  {
    chatQuestions: ["Are Theo and I still together?"],
    entries: 4,
    id: "breakup-reconciliation",
    kind: "timeline",
  },
  {
    chatQuestions: ["How am I doing with work lately?"],
    entries: 4,
    id: "career-burnout",
    kind: "timeline",
  },
  {
    chatQuestions: [
      "How would you describe my relationship with my dad right now?",
    ],
    entries: 4,
    id: "parent-relationship",
    kind: "timeline",
  },
  {
    chatQuestions: [
      "How would you describe my relationship with Sam right now?",
    ],
    entries: 4,
    id: "sam-example",
    kind: "timeline",
  },
  {
    chatQuestions: [
      "Have I been stressed about money?",
      "Why did I skip my friend's birthday trip?",
      "How's my financial situation these days?",
    ],
    entries: 3,
    id: "financial-stress",
    kind: "standalone",
  },
  {
    chatQuestions: ["Am I engaged?"],
    entries: 1,
    id: "getting-engaged",
    kind: "standalone",
  },
  {
    chatQuestions: [
      "What happened with my mom?",
      "Have I had any moments where grief caught me off guard?",
      "How am I doing with grieving my mom these days?",
    ],
    entries: 3,
    id: "grief-after-loss",
    kind: "standalone",
  },
  {
    chatQuestions: ["How am I feeling about my new job?"],
    entries: 1,
    id: "imposter-syndrome",
    kind: "standalone",
  },
  {
    chatQuestions: ["Do I have a dog?"],
    entries: 1,
    id: "losing-a-pet",
    kind: "standalone",
  },
  {
    chatQuestions: ["How did I feel on my birthday?"],
    entries: 1,
    id: "milestone-birthday",
    kind: "standalone",
  },
  {
    chatQuestions: ["Did anything go wrong on my Portugal trip?"],
    entries: 2,
    id: "portugal-trip",
    kind: "standalone",
  },
  {
    chatQuestions: ["Am I currently running?"],
    entries: 2,
    id: "running",
    kind: "standalone",
  },
];
