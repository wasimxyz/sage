import { replyEvals } from "../lib/reply-grade.ts";

// One eval for each Chat reply in the transcripts: the openers and the fact
// questions. Each reply gets one judge call, which records the hard checks, the
// counted checks, and the rubric that apply to it.
export default await replyEvals();
