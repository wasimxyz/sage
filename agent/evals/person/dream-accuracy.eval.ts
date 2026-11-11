import { dreamAccuracyEvals } from "../lib/dream-accuracy.ts";
import { personEvals } from "../lib/pass.ts";

// One eval per source Dream worked from: each journal entry, and each chat.
// The judge sees the source next to everything Dream wrote from it. Grades are
// cached beside the Dream snapshot (SAGE_EVAL_DREAM_KEY), so each snapshot is
// graded once, however many Chat setups use it.
export default await personEvals("dream-accuracy", (context) =>
  dreamAccuracyEvals(context)
);
