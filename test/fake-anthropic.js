// Faux client Anthropic pour les tests : rejoue des réponses scriptées
// avec la même interface que `client.beta.messages.stream(...)`.
import { EventEmitter } from "node:events";

export function createFakeAnthropic(script) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        stream(params) {
          calls.push(params);
          const step = script[Math.min(calls.length - 1, script.length - 1)];
          const content = typeof step === "function" ? step(params) : step;
          return fakeStream(content);
        },
      },
    },
  };
}

function fakeStream(content) {
  const emitter = new EventEmitter();
  let aborted = false;
  const done = (async () => {
    await new Promise((r) => setTimeout(r, 5));
    for (const block of content) {
      if (block.type !== "text") continue;
      for (const word of block.text.split(/(?<= )/)) {
        if (aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        emitter.emit("text", word);
        await new Promise((r) => setTimeout(r, 1));
      }
    }
    const stop_reason = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
    return { content, stop_reason };
  })();
  return {
    on(event, cb) {
      emitter.on(event, cb);
      return this;
    },
    finalMessage: () => done,
    abort() {
      aborted = true;
    },
  };
}
