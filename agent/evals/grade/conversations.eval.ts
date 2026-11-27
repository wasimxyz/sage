import { conversationGradeEvals } from "../lib/conversation-grade.ts";

// One eval for each conversation in the transcripts. Each Sage reply is graded
// like a reply, with the turns before it in front. The whole conversation gets
// one more judge call, which scores follows-lead, collaboration, and
// keeps-track, and marks the worry loops, the nos, and the simulated user's
// slips after a crisis. The counted checks drops-after-no and
// stops-feeding-loop come from those marks.
export default await conversationGradeEvals();
