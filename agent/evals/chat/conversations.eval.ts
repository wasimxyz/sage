import { conversationEvals } from "../lib/conversations.ts";
import { personEvals } from "../lib/pass.ts";

// One eval for each conversation and repeat of this pass's person. A simulated
// user plays the person for up to the conversation's `maxTurns` messages, and
// each Sage turn goes through sendTurn with the setup's headers. The
// empty-journal person (new-user) also runs the other people's `alsoEmpty`
// conversations on its empty journal. The sweep's `tags` pick the
// conversations.
export default await personEvals("conversations", (context) =>
  conversationEvals(context)
);
