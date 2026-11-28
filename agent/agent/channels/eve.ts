import { extractBearerToken, withAuthChallenges } from "eve/channels/auth";
import { defaultEveAuth, type EveAuthFn, eveChannel } from "eve/channels/eve";
import { bearerMatches } from "../lib/bearer";
import { expectedChatToken, packagedChat, sageChatReady } from "../lib/sage";

const savedChatId = /^[1-9]\d{0,15}$/u;

function sageHeaders(request: Request): Record<string, string> {
  const model = request.headers.get("x-sage-model");
  const thinkHeader = request.headers.get("x-sage-think");
  const contextLength = request.headers.get("x-sage-context-length");
  // The saved chat this turn belongs to, so search_chats can leave it out.
  const chatId = request.headers.get("x-sage-chat-id");
  return {
    ...(model !== null && model.length > 0 ? { model } : {}),
    ...(contextLength !== null && contextLength.length > 0
      ? { contextLength }
      : {}),
    ...(chatId !== null && savedChatId.test(chatId) ? { chatId } : {}),
    think: thinkHeader === "0" || thinkHeader === "false" ? "0" : "1",
  };
}

function sageDesktop(): EveAuthFn {
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
        // `eve eval` and the `eve dev` terminal read /eve/v1/info, which eve
        // serves only to operators. Outside a packaged app, the caller with
        // Sage's token is the eval runner or the terminal. Packaged Chat never
        // reads it, so a packaged agent keeps it closed.
        allowAgentInfo: !packagedChat(),
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
    allowHeaders: "*",
    methods: ["GET", "POST"],
    origin: "zero://app",
  },
  // eve stores a session title in the Workflow run's attributes, which the
  // world key does not encrypt and ending the session does not delete. It
  // would default to the start of the first message, so every session gets
  // the same title instead. The Chat screen reads its own encrypted title.
  onMessage: (ctx) => ({ auth: defaultEveAuth(ctx), title: "Sage chat" }),
});
