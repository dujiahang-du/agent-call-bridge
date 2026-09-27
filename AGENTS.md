# Agent Call Bridge

先读 task_plan.md、findings.md、progress.md。只修改本项目。默认 Mock，不拨真实号码或调用付费模型 API。所有本机状态、凭据、测试录音放 .local/ 或其他已忽略目录，不提交。不得将 turn/completed 当 task accepted。接口在 docs/architecture.md；独立子任务只修改分配目录。提交/推送由总控执行。

发布要求：独立 Review、修复复审、真实浏览器操作、实际 Agent Bridge 测试、安全扫描。本仓库已在 v0.1.0 软件范围验收及公开检查后转 Public；后续提交仍须检查完整未推送历史，不重写公开历史。

<!-- agent-call-bridge:start -->
## Agent Call Bridge（仅本项目）
当本项目任务完成、失败、明确受阻或需要用户选择时，使用已安装 Bridge CLI 汇报；默认 Mock。命令在项目根目录执行：

- 连通：`Bridge.cmd ping`。
- 汇报：`Bridge.cmd report --type task_completed --task-id <稳定任务ID> --summary <简短中文>`。可用事件 task_completed/task_failed/task_stalled/retry_exhausted/decision_required/turn_finished。轮次结束不能冒充任务验收完成。
- 选择：`Bridge.cmd report-and-wait --type decision_required --task-id <任务ID> --summary <摘要> --decision-json <问题选项JSON> --timeout 300`。JSON 形如 {"question":"继续验证？","options":[{"id":"continue","label":"继续"},{"id":"stop","label":"停止"}]}；可用 --stdin 避免复杂引号和敏感命令行内容。
- CLI 自动读取本地连接文件和当前 CODEX_THREAD_ID/CODEX_SESSION_ID。等待结果仅能继续同一仍运行的任务，超时/未回答不能当成同意；已结束任务不能自动唤醒。
- 电话回复只作为已列出的低风险选项，不执行任意命令，不代替系统审批，不升级权限，不授权真实拨号。真实电话必须经过配置界面明确授权。
- 完成汇报附带实际验收描述；缺少验收时明确 Agent 报告完成，未独立验证。不得把密钥、完整号码、日志或代码放入语音摘要。
<!-- agent-call-bridge:end -->
