/**
 * Mock-based test for dsh-memsearch — no DSH needed.
 *
 * Verifies:
 *  1. session start: first agent/pre-step prepends a plugin-sourced status message
 *  2. turn end: session/event turn/end appends a journal entry (user + assistant)
 *  3. dedupe: the same assistant turn is not captured twice
 *
 * Run: node test/plugin.test.mjs
 */
import assert from "node:assert";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const plugin = await import(path.join(here, "..", "lib", "index.js"));

const handlers = { "agent/pre-step": [], "session/event": [] };
const ctx = {
  on(event, handler) {
    handlers[event].push(handler);
  },
};

const tmp = mkdtempSync(path.join(here, ".test-"));
const memoryDir = path.join(tmp, "memory");

try {
  const parsed = plugin.Config["~standard"].validate({ memoryDir, captureMinPromptLength: 5, indexAfterCapture: false });
  if (parsed.issues) throw new Error(`config invalid: ${JSON.stringify(parsed.issues)}`);
  const config = parsed.value;
  plugin.apply(ctx, config);

  // ---- 1) session start injection ----
  const userMsg = {
    role: "user",
    content: [{ type: "text", text: "帮我梳理 RDLens 的检索架构" }],
    source: { kind: "user" },
  };
  const fakeAgent = { session: { id: "sess-1", events: [] } };
  const next = async () => ({ kind: "enter", messages: [userMsg] });
  const preStep = handlers["agent/pre-step"][0];
  const decision = await preStep(
    { agent: fakeAgent, messages: [userMsg], step: 1, signal: { aborted: false } },
    next,
  );
  assert.strictEqual(decision.kind, "enter");
  assert.ok(decision.messages.length >= 2, "status message should be prepended");
  assert.strictEqual(decision.messages[0].source.plugin, "dsh-memsearch");
  assert.ok(decision.messages[0].content[0].text.startsWith("[memsearch"));
  console.log("OK  1) session-start status injected:");
  console.log("     ", decision.messages[0].content[0].text.replace(/\n/g, " ").slice(0, 100), "...");

  // second pre-step (same session) must NOT inject again
  const decision2 = await preStep(
    { agent: fakeAgent, messages: [userMsg], step: 1, signal: { aborted: false } },
    next,
  );
  assert.strictEqual(decision2.messages.length, 1, "no duplicate injection");
  console.log("OK  1b) no duplicate status injection");

  // ---- 2) turn-end capture ----
  const mkEvent = (type, data, seq) => ({ type, data, seq, time: Date.now() });
  const sessEvents = [
    mkEvent("turn/start", { turn: 1 }, 1),
    mkEvent("user/message", userMsg, 2),
    mkEvent("step/start", { turn: 1, step: 1 }, 3),
    mkEvent("assistant/message", {
      role: "assistant",
      content: [{ type: "text", text: "RDLens 的检索层是 FAISS + BM25 混合检索，RRF 融合后接 Reranker。" }],
    }, 4),
    mkEvent("step/end", { turn: 1, step: 1 }, 5),
    mkEvent("turn/end", { turn: 1 }, 6),
  ];
  fakeAgent.session.events = sessEvents;
  const sessHandler = handlers["session/event"][0];
  sessHandler(fakeAgent.session, sessEvents[sessEvents.length - 1]);

  await new Promise((r) => setTimeout(r, 1200));

  const files = readdirSync(memoryDir).filter((f) => f.endsWith(".md"));
  assert.strictEqual(files.length, 1, `one journal file expected, got ${files.join(",")}`);
  const content = readFileSync(path.join(memoryDir, files[0]), "utf8");
  assert.ok(content.includes("[User]"), "journal should contain user question");
  assert.ok(content.includes("RDLens 的检索层"), "journal should contain assistant reply");
  console.log("OK  2) turn-end capture wrote:", path.join(memoryDir, files[0]));
  console.log(content.trim());

  // ---- 3) dedupe ----
  sessHandler(fakeAgent.session, sessEvents[sessEvents.length - 1]);
  await new Promise((r) => setTimeout(r, 600));
  const content2 = readFileSync(path.join(memoryDir, files[0]), "utf8");
  assert.strictEqual(content2, content, "same turn must not be captured twice");
  console.log("OK  3) duplicate turn/end ignored");

  // ---- 4) real DSH assistant message shape (data.message wrapper) ----
  // DSH stores assistant messages as { turn, step, message: {...}, usage },
  // with reasoning / tool-call / text content blocks.
  const wrappedEvents = [
    mkEvent("turn/start", { turn: 2 }, 10),
    mkEvent("user/message", {
      role: "user",
      content: [{ type: "text", text: "DSH 插件如何自动保存记忆" }],
      source: { kind: "user" },
    }, 11),
    mkEvent("step/start", { turn: 2, step: 1 }, 12),
    mkEvent("assistant/message", {
      turn: 2,
      step: 1,
      message: {
        role: "assistant",
        content: [
          { type: "reasoning", text: "思考中..." },
          { type: "tool-call", text: "" },
          { type: "text", text: "插件监听 turn/end 事件，把问答写入当日记忆日志。" },
        ],
        source: { kind: "assistant" },
      },
      usage: {},
    }, 13),
    mkEvent("step/end", { turn: 2, step: 1 }, 14),
    mkEvent("turn/end", { turn: 2 }, 15),
  ];
  fakeAgent.session.events = wrappedEvents;
  sessHandler(fakeAgent.session, wrappedEvents[wrappedEvents.length - 1]);
  await new Promise((r) => setTimeout(r, 1200));
  const content3 = readFileSync(path.join(memoryDir, files[0]), "utf8");
  assert.ok(content3.includes("监听 turn/end 事件"), "wrapped assistant message text should be captured");
  assert.ok(!content3.includes("(no text)"), "no '(no text)' placeholders");
  console.log("OK  4) real DSH assistant/message wrapper shape captured");

  console.log("\nALL TESTS PASSED");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
