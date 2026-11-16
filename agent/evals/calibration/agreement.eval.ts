import { calibrationEvals } from "../lib/calibration.ts";

// The judge against your grades. Each reply you graded in a calibration sample
// goes to the judge the sweep names (`judge.model`), the way a real reply does.
// Each eval records one soft score with both sets of verdicts in its metadata,
// and the runner turns them into exact agreement, agreement within one point,
// and weighted kappa for each rubric item, and hits, misses, and false alarms
// for each check. Run it with `make eval SWEEP=calibration`.
export default await calibrationEvals();
