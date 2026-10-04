import {
  type AuthFn,
  extractBearerToken,
  withAuthChallenges,
} from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import { bearerMatches } from "../lib/bearer";
import { expectedChatToken, sageChatReady } from "../lib/sage";

function sageHeaders(request: Request): Record<string, string> {
  const model = request.headers.get("x-sage-model");
  const thinkHeader = request.headers.get("x-sage-think");
  const contextLength = request.headers.get("x-sage-context-length");
  return {
    ...(model !== null && model.length > 0 ? { model } : {}),
    ...(contextLength !== null && contextLength.length > 0
      ? { contextLength }
      : {}),
    think: thinkHeader === "0" || thinkHeader === "false" ? "0" : "1",
  };
}

function sageDesktop(): AuthFn<Request> {
  return withAuthChallenges(
    async (request) => {
      const expected = await expectedChatToken();
      const presented = extractBearerToken(
        request.headers.get("authorization")
      );
      if (
        expected === null ||
        presented === null ||
        !bearerMatches(expected, presented) ||
        !(await sageChatReady())
      ) {
        return null;
      }
      return {
        attributes: sageHeaders(request),
        authenticator: "sage-desktop",
        principalId: "local",
        principalType: "user",
      };
    },
    [{ scheme: "Bearer" }]
  );
}

export default eveChannel({
  auth: sageDesktop(),
  cors: {
    // Echo Access-Control-Request-Headers. WKWebView may add Cache-Control
    // on the stream fetch; a fixed list that omits it fails with "Load failed".
    allowedHeaders: "*",
    methods: ["GET", "POST"],
    origin: "zero://app",
  },
});
