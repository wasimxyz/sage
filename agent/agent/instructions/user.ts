import { defineDynamic, defineInstructions } from "eve/instructions";

import { sageFetch } from "../lib/sage";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const response = await sageFetch("/agent/instructions").catch(() => null);
      if (response === null || !response.ok) {
        return null;
      }
      const user = userInstructions(await response.json()).trim();
      if (user.length === 0) {
        return null;
      }
      return defineInstructions({
        content: [
          "Additional instructions from the journal author:",
          user,
        ].join("\n\n"),
      });
    },
  },
});

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
