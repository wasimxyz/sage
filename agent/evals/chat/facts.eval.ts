import { defineEval } from "eve/evals";

import { runChatQuestion } from "../lib/chat-turn.ts";
import { personEvals, tagsFor } from "../lib/pass.ts";
import { itemMetadata, makeItem } from "../lib/record.ts";
import { itemIdFor } from "../lib/schema.ts";
import { appendTranscript } from "../lib/transcripts.ts";

export default await personEvals("chat facts", ({ pass, person }) =>
  person.personCase.chat.flatMap((chat, index) =>
    Array.from({ length: pass.repeats }, (_, offset) => {
      const repeat = offset + 1;
      const item = makeItem(
        {
          itemId: itemIdFor(person.id, "chat", index + 1),
          kind: "chat",
          person: person.id,
        },
        pass.setupId,
        repeat
      );
      return defineEval({
        description: `${person.id}: chat ${index + 1}${pass.repeats > 1 ? ` (repeat ${repeat})` : ""}`,
        metadata: itemMetadata(item),
        tags: tagsFor(person, "chat"),
        async test(t) {
          appendTranscript(await runChatQuestion(t, item, chat, pass.setup));
        },
      });
    })
  )
);
