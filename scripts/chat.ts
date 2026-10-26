import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { chatStream } from "../src/chat/chat.js";
import { pool } from "../src/db/pool.js";

const { values } = parseArgs({ options: { id: { type: "string" } } });

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
let conversationId = values.id;
console.log('Ask about the iMac Product Environmental Report (October 2024). "/new" starts a new conversation, "/exit" quits.\n');

rl.prompt();
for await (const line of rl) {
  const message = line.trim();
  if (!message) {
    rl.prompt();
    continue;
  }
  if (!process.stdin.isTTY) console.log(message);
  if (message === "/exit") break;
  if (message === "/new") {
    conversationId = undefined;
    console.log("(new conversation)\n");
    rl.prompt();
    continue;
  }

  try {
    for await (const event of chatStream(message, conversationId)) {
      if (event.type === "conversation") {
        conversationId = event.conversationId;
        if (event.rewritten) console.log(`  (searching for: ${event.standaloneQuestion})`);
        process.stdout.write("bot> ");
      } else if (event.type === "delta") {
        process.stdout.write(event.text);
      } else if (event.type === "done") {
        const flagged = event.unverifiedNumbers.length ? `, numbers not in sources: ${event.unverifiedNumbers.join(", ")}` : "";
        console.log(`\n  [${event.model ?? "no LLM call"}, ${event.ms}ms${flagged}]\n`);
      }
    }
  } catch (err) {
    console.log(`\n  error: ${(err as Error).message}\n`);
  }
  rl.prompt();
}

rl.close();
await pool.end();
