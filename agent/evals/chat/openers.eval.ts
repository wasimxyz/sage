import { openerEvals } from "../lib/openers.ts";
import { personEvals } from "../lib/pass.ts";

// One eval for each opener and repeat of this pass's person. The empty-journal
// person (new-user) also sends the other people's `alsoEmpty` openers on its
// empty journal. The sweep's `tags` pick the openers.
export default await personEvals("openers", (context) => openerEvals(context));
