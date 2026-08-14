# dsh-memsearch — Automatic semantic memory for DeepSeek Harness

[![npm version](https://img.shields.io/npm/v/dsh-memsearch.svg)](https://www.npmjs.com/package/dsh-memsearch)
[![GitHub](https://img.shields.io/badge/GitHub-clouwer%2Fdsh--memsearch-blue?logo=github)](https://github.com/clouwer/dsh-memsearch)

[English](README.md) | [简体中文](README_CN.md)

Make DeepSeek Harness (DSH) **auto-write and recall mmsearch memories by default**, just
like the official Codex / Claude Code memsearch plugins. Fully local — no LLM calls
required by default (offline-ready).

## Behavior (mirrors the official plugins)

| When | What happens |
|---|---|
| Session start (first step) | Runs a background `memsearch index`; injects a plugin-sourced status message: memsearch version, embedding provider, journal dir, past-memory file count + a hint to use the memory-recall skill when history may help |
| Turn end (`turn/end`) | Auto-captures the user question + the agent's final reply, appends a compact entry to `<memoryDir>/<YYYY-MM-DD>.md`, then runs an incremental `memsearch index` in the background (deduped: the same turn is never written twice) |
| Recall | Follows the official design: no automatic context stuffing — the agent searches on demand via the memsearch memory-recall skill |

## Memory journal format

```
### HH:MM
=== Final exchange, authoritative for outcome ===
[User]: <user question>
[DSH]: <agent final reply>
```

> DSH is an always-on web app without a Codex-style session-end hook, so capture happens
> per turn. If a memsearch `[llm]` provider is configured, `summarizePlugin` can replace
> the raw text with an LLM summary.

## Configuration (under `config:` in cordis.patch.yml)

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Master switch |
| `memoryDir` | `""` | Journal dir; empty = `$MEMSEARCH_DIR/memory` or `~/.memsearch/memory` |
| `collection` | `""` | Milvus collection passed to the CLI; empty = configured default |
| `injectSessionStatus` | `true` | Inject session-start status + recall hint |
| `capture` | `true` | Auto-append a journal entry after each turn |
| `captureMinPromptLength` | `10` | Skip turns whose user prompt is shorter than this (greetings etc.) |
| `maxCaptureChars` | `8000` | Cap on the raw exchange text written per turn |
| `summarizePlugin` | `""` | e.g. `"codex"` to summarize via `memsearch summarize` (needs `[llm]` config); empty = raw text |
| `indexAfterCapture` | `true` | Re-index after appending |

## Installation

```bash
# 1. Install the plugin (npm registry or GitHub — pick one)
dsh plugin --profile web add dsh-memsearch
# or install from GitHub source:
# dsh plugin --profile web add "git+https://github.com/clouwer/dsh-memsearch.git"

# 2. Append to ~/.dsh/profiles/web/cordis.patch.yml
# - id: memsearch-automemory
#   name: 'dsh-memsearch'
#   config:
#     enabled: true

# 3. Restart dsh web (config is composed at startup)
```

> Dependencies: the plugin consumes the host DSH's own `@deepseek-ai/cordis` /
> `@deepseek-ai/dsh-agent` via peerDependencies — nothing extra to install.

## Verification

```bash
# Unit tests (mocked session, no DSH needed)
npm test

# After restarting DSH: chat a turn, then check today's journal
tail -20 ~/.memsearch/memory/$(date +%Y-%m-%d).md
memsearch stats          # chunk count should grow with conversations
```

> The memory journal lives in `~/.memsearch/memory/` by default; with `MEMSEARCH_DIR` set
> it is `$MEMSEARCH_DIR/memory/`.
