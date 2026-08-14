# Changelog

## 0.1.1 (2026-08-14)

- 元数据更新：package.json 增加 `repository` / `homepage` / `bugs` 字段（npm 页面显示 GitHub 链接）
- README 增加 npm/GitHub 徽章与链接

## 0.1.0 (2026-08-14)

- 首个发布版本：DSH 自动语义记忆插件
  - 会话开始：后台 `memsearch index` + 注入状态/召回提示（对齐 Codex/Claude Code 插件）
  - 每轮结束：自动把「用户问题 + agent 最终回复」写入当日记忆日志并增量重索引（去重）
  - 纯本地、零 LLM 依赖；可选 `summarizePlugin` 使用 memsearch 管理的 LLM 摘要
  - 已发布到 npm（`dsh-memsearch@0.1.0`）
