# dsh-memsearch — DSH 自动语义记忆插件

[![npm version](https://img.shields.io/npm/v/dsh-memsearch.svg)](https://www.npmjs.com/package/dsh-memsearch)
[![GitHub](https://img.shields.io/badge/GitHub-clouwer%2Fdsh--memsearch-blue?logo=github)](https://github.com/clouwer/dsh-memsearch)

让 DeepSeek Harness（DSH）像 Codex / Claude Code 的 memsearch 插件一样，**默认自动
写入和提取** mmsearch 记忆。纯本地，默认不调用任何 LLM（离线可用）。

- npm: <https://www.npmjs.com/package/dsh-memsearch>
- GitHub: <https://github.com/clouwer/dsh-memsearch>

## 行为（对齐官方插件）

| 时机 | 行为 |
|---|---|
| 会话开始（首个 step） | 后台跑一次 `memsearch index`；向会话注入一条插件来源的状态消息：memsearch 版本、embedding provider、记忆日志目录、历史记忆文件数 + 提示（需要用历史时用 memory-recall skill 检索） |
| 每轮结束（`turn/end`） | 自动捕获本轮用户问题 + agent 最终回复，以紧凑格式追加到 `<memoryDir>/<YYYY-MM-DD>.md`，随后后台增量 `memsearch index`（去重：同一轮不会写两次） |
| 检索 | 沿用官方设计：不自动塞上下文，由 agent 按需通过 memory-recall skill（或 MCP 桥的 `mcp__memsearch__search`）主动检索 |

## 记忆日志格式

```
### HH:MM
=== Final exchange, authoritative for outcome ===
[User]: <本轮用户问题>
[DSH]: <agent 最终回复>
```

> DSH 是常驻 web 应用、没有 Codex 那种会话结束 hook，所以用"每轮结束"作为捕获时机。
> 若配置了 memsearch 的 `[llm]` provider，可让 `summarizePlugin` 用 LLM 摘要替代原始文本。

## 配置项（cordis.patch.yml 中 `config:` 下）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `memoryDir` | `""` | 日志目录；空 = `$MEMSEARCH_DIR/memory` 或 `~/.memsearch/memory` |
| `collection` | `""` | 传给 CLI 的 Milvus collection；空 = 配置默认 |
| `injectSessionStatus` | `true` | 会话开始注入状态+提示 |
| `capture` | `true` | 每轮结束自动写入 |
| `captureMinPromptLength` | `10` | 用户提示短于该长度不捕获（问候语等） |
| `maxCaptureChars` | `8000` | 单轮原始文本上限 |
| `summarizePlugin` | `""` | 如 `"codex"` 则用 `memsearch summarize` 摘要（需要 `[llm]` 配置）；空 = 原始文本 |
| `indexAfterCapture` | `true` | 写入后重索引 |

## 安装

```bash
# 1. 安装插件（npm registry 或 GitHub 二选一）
dsh plugin --profile web add dsh-memsearch
# 或从 GitHub 源码安装：
# dsh plugin --profile web add "git+https://github.com/clouwer/dsh-memsearch.git"

# 2. 在 ~/.dsh/profiles/web/cordis.patch.yml 追加
# - id: memsearch-automemory
#   name: 'dsh-memsearch'
#   config:
#     enabled: true

# 3. 重启 dsh web（配置启动时合成）
```

> 依赖说明：插件通过 peerDependencies 使用宿主 DSH 自带的 `@deepseek-ai/cordis` /
> `@deepseek-ai/dsh-agent`，无需单独安装。

## 验证

```bash
# 单元测试（mock 会话，不依赖 DSH）
cd scripts/dsh-memsearch && node test/plugin.test.mjs

# 重启 DSH 后：随便聊一轮，然后看当日日志
tail -20 ~/.memsearch/memory/$(date +%Y-%m-%d).md
memsearch stats          # chunk 数应随对话增长
```

## 与 MCP 桥接的关系

- 本插件：**自动**写入（每轮捕获）+ 会话开始提示（提取引导）。
- `scripts/memsearch-mcp`（MCP 桥）：把 search/index/expand/remember 等变成 DSH
  原生工具 `mcp__memsearch__*`，供 agent 主动检索/手动管理。
- 两者互补；如果只想用其中一种，可在 cordis.patch.yml 里单独禁用。
