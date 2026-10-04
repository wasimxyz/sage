// Loaded with `node --import` ahead of the eve server, in a packaged app, in
// `eve dev`, and in the eval server. See workflow-guard.ts.

import { installWorkflowGuard } from "./workflow-guard.ts";

installWorkflowGuard();
