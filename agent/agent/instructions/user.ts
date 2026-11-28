import { defineDynamic, defineInstructions } from "eve/instructions";

import { sageFetch } from "../lib/sage";

// eve runs this before every model call. The memo reads Settings > Agent
// once per session, as the session.started event did before eve 1.0.
export default defineDynamic(async (ctx) => {
  const content = await ctx.memo(["user-instructions", ctx.session.id], () =>
    userContent()
  );
  return content === null ? null : defineInstructions({ content });
});

async function userContent(): Promise<string | null> {
  const response = await sageFetch("/agent/instructions").catch(() => null);
  if (response === null || !response.ok) {
    return null;
  }
  const user = userInstructions(await response.json()).trim();
  if (user.length === 0) {
    return null;
  }
  return ["Additional instructions from the journal author:", user].join(
    "\n\n"
  );
}

function userInstructions(payload: unknown): string {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("user" in payload) ||
    typeof payload.user !== "string"
  ) {
    return "";
  }
  return payload.user;
}
