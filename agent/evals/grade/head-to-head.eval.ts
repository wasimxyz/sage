import { headToHeadEvals } from "../lib/head-to-head.ts";

// The judge compares the top setups of a finished sweep, two at a time. It sees
// two replies (or two whole conversations) to the same message, in both orders,
// and a setup wins an item only when it wins both. Run it with
// `make eval SWEEP=head-to-head ARGS='--compare <sweep id>'`. Any other pass
// gets a skipped placeholder from this file.
export default await headToHeadEvals();
