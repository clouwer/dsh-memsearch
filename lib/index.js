/**
 * dsh-memsearch — automatic semantic memory for DeepSeek Harness.
 *
 * Mirrors the official memsearch Codex / Claude Code plugin behavior inside DSH:
 *
 *  1. Session start (first step of a session)
 *     - runs a background `memsearch index` over the memory journal dir
 *     - injects a plugin-sourced status message: memsearch version, embedding
 *       provider, journal dir, past-memory count, and a hint to use the
 *       memory-recall skill (recall is done on demand by the agent, exactly
 *       like the official plugins)
 *
 *  2. Turn end (`turn/end` session event)
 *     - captures the last user question + final assistant reply
 *     - appends a compact entry to `<memoryDir>/<YYYY-MM-DD>.md` (fallback
 *       format, no LLM needed; optionally summarized via `memsearch summarize`
 *       when an LLM provider is configured)
 *     - triggers an incremental `memsearch index` in the background
 *
 * No LLM calls are required by default — everything is local. The plugin only
 * shells out to the already-installed `memsearch` CLI.
 *
 * Register in the dsh profile's cordis.patch.yml:
 *
 *     - id: memsearch-automemory
 *       name: 'dsh-memsearch'
 *       config:
 *         enabled: true
 */

import z from "@deepseek-ai/schemastery";
import "@deepseek-ai/cordis";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const name = "dsh-memsearch";
const inject = ["agents"];

const Config = z.object({
  enabled: z.boolean().default(true),
  /** Journal dir; empty = $MEMSEARCH_DIR/memory or ~/.memsearch/memory. */
  memoryDir: z.string().default(""),
  /** Milvus collection passed to the CLI; empty = configured default. */
  collection: z.string().default(""),
  /** Inject the session-start memsearch status + recall hint. */
  injectSessionStatus: z.boolean().default(true),
  /** Auto-append a journal entry after each turn. */
  capture: z.boolean().default(true),
  /** Ignore turns whose user prompt is shorter than this. */
  captureMinPromptLength: z.number().default(10),
  /** Cap on the raw exchange text written per turn. */
  maxCaptureChars: z.number().default(8000),
  /** Optional: "codex" | "claude-code" | ... to summarize via `memsearch summarize` (needs [llm] config); "" = raw fallback. */
  summarizePlugin: z.string().default(""),
  /** Re-run `memsearch index` after appending a journal entry. */
  indexAfterCapture: z.boolean().default(true),
});

const MS_TIMEOUT = 300000; // long: first onnx model download ~558MB
const MS_STATUS_TIMEOUT = 15000;
const MAX_BUFFER = 8 * 1024 * 1024;

function home() {
  return os.homedir();
}

function expandPath(p) {
  return p.replace(/^~(?=$|\/)/, home());
}

function resolveMemoryDir(configured) {
  if (configured) return expandPath(configured);
  const base = process.env.MEMSEARCH_DIR;
  if (base) return path.join(expandPath(base), "memory");
  return path.join(home(), ".memsearch", "memory");
}

function memsearchEnv() {
  const env = { ...process.env };
  const existing = (env.PATH || "").split(":").filter(Boolean);
  const dirs = ["$HOME/.local/bin", "$HOME/.cargo/bin", "$HOME/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    .map((d) => expandPath(d))
    .filter((d) => existsSync(d) && !existing.includes(d));
  env.PATH = [...dirs, ...existing].join(":");
  return env;
}

/** Run the memsearch CLI; never rejects. */
function runMemsearch(args, { timeout = MS_TIMEOUT, input } = {}) {
  return new Promise((resolve) => {
    execFile("memsearch", args, { env: memsearchEnv(), timeout, maxBuffer: MAX_BUFFER, ...(input !== undefined ? { input } : {}) }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

function localDateParts(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  };
}

function journalPath(memoryDir, now = new Date()) {
  return path.join(memoryDir, `${localDateParts(now).date}.md`);
}

function memoryFiles(memoryDir) {
  try {
    return readdirSync(memoryDir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

function collectionArgs(config) {
  return config.collection ? ["--collection", config.collection] : [];
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...(truncated)`;
}

function textOf(message) {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** Unwrap an event's message payload: user events put content on `data`,
 * assistant events wrap the message in `data.message`. */
function messageOf(data) {
  if (data && typeof data === "object" && data.message && typeof data.message === "object") {
    return data.message;
  }
  return data;
}

/** Last user message not injected by a plugin, and last assistant message with text. */
function extractExchange(session) {
  let userText = "";
  let assistantText = "";
  let assistantSeq;
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i];
    if (!event || typeof event !== "object") continue;
    if (event.type === "user/message" && !userText) {
      const source = event.data && event.data.source;
      if (source && source.kind === "plugin") continue; // our own injections
      userText = textOf(messageOf(event.data));
    } else if (event.type === "assistant/message" && assistantSeq === undefined) {
      const text = textOf(messageOf(event.data));
      if (text) {
        assistantText = text;
        assistantSeq = event.seq;
      }
    }
    if (userText && assistantSeq !== undefined) break;
  }
  return { userText, assistantText, assistantSeq };
}

async function buildStatusText(config, memoryDir) {
  const version = await runMemsearch(["--version"], { timeout: MS_STATUS_TIMEOUT });
  const provider = await runMemsearch(["config", "get", "embedding.provider"], { timeout: MS_STATUS_TIMEOUT });
  const versionText = (version.stdout || version.stderr || "?").replace(/^memsearch,\s*/i, "").replace(/,\s*$/, "").trim();
  const providerText = provider.stdout.trim() || "(default)";
  const files = memoryFiles(memoryDir);
  let text = `[memsearch ${versionText}] embedding: ${providerText} | journal: ${memoryDir} | ${files.length} past memory file(s)`;
  if (files.length > 0) {
    text += ` (${files[0]} to ${files[files.length - 1]}). Use the memory-recall skill to search when the user's question could benefit from historical context.`;
  } else {
    text += ". No past memories yet; this session's exchanges will be saved automatically.";
  }
  return text;
}

function createStatusMessage(text) {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: name, form: "snapshot", sections: [{ name, text }] },
  };
}

async function captureTurn(config, memoryDir, session, state) {
  const { userText, assistantText, assistantSeq } = extractExchange(session);
  if (!userText || userText.length < config.captureMinPromptLength) return;
  if (assistantSeq === undefined) return;
  if (state.lastCaptured.get(session.id) === assistantSeq) return; // already captured
  state.lastCaptured.set(session.id, assistantSeq);

  let summary = `=== Final exchange, authoritative for outcome ===
[User]: ${truncate(userText, config.maxCaptureChars)}
[DSH]: ${truncate(assistantText || "(no text)", config.maxCaptureChars)}`;

  if (config.summarizePlugin) {
    const res = await runMemsearch(["summarize", "--plugin", config.summarizePlugin, "--agent-name", "DSH"], { input: summary });
    if (!res.err && res.stdout.trim()) summary = res.stdout.trim();
  }

  try {
    mkdirSync(memoryDir, { recursive: true });
    const file = journalPath(memoryDir);
    appendFileSync(file, `\n### ${localDateParts().time}\n${summary}\n`, "utf8");
  } catch (err) {
    console.error(`[dsh-memsearch] journal append failed: ${err.message}`);
    return;
  }

  if (config.indexAfterCapture) {
    runMemsearch(["index", memoryDir, ...collectionArgs(config)]).then((res) => {
      if (res.err) console.error(`[dsh-memsearch] index failed: ${(res.stderr || res.err.message).slice(0, 300)}`);
    });
  }
}

function apply(ctx, config) {
  if (!config.enabled) return;
  const memoryDir = resolveMemoryDir(config.memoryDir);
  const state = {
    statusInjected: new WeakSet(),
    sessionIndexed: new WeakSet(),
    lastCaptured: new Map(),
  };

  ctx.on("agent/pre-step", async ({ agent, messages, step, signal }, next) => {
    const decision = await next();
    if (decision.kind === "reject" || signal.aborted || step !== 1) return decision;
    const session = agent && agent.session;
    if (!session) return decision;

    if (!state.sessionIndexed.has(session) && memoryFiles(memoryDir).length > 0) {
      state.sessionIndexed.add(session);
      runMemsearch(["index", memoryDir, ...collectionArgs(config)]).then((res) => {
        if (res.err) console.error(`[dsh-memsearch] session index failed: ${(res.stderr || res.err.message).slice(0, 300)}`);
      });
    }

    if (config.injectSessionStatus && !state.statusInjected.has(session)) {
      state.statusInjected.add(session);
      const statusText = await buildStatusText(config, memoryDir);
      return { kind: "enter", messages: [createStatusMessage(statusText), ...decision.messages] };
    }
    return decision;
  }, { prepend: true });

  if (config.capture) {
    ctx.on("session/event", (session, event) => {
      if (!event || event.type !== "turn/end") return;
      if (session && session.events) captureTurn(config, memoryDir, session, state);
    });
  }
}

export { Config, apply, inject, name };
