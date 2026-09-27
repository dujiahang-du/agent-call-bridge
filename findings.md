# 调研与决策（2026-09-27）

## 路线
TypeScript / Fastify 5 / React 19 / Vite 8 / Node SQLite。Windows 系统中文 TTS；baresip 独立进程。不引入整个 Agent 平台。

## 事实与来源
- Codex CLI 0.144.5（本机 help/版本核实），桌面 26.917.71314。版本对应协议：https://github.com/openai/codex/blob/rust-v0.144.5/codex-rs/app-server/README.md 。turn/completed 仅轮次结束；error.willRetry 不能提前判失败。
- 桌面已有终端可调用 Bridge；CODEX_THREAD_ID 是真实任务 ID，可能还有 CODEX_SESSION_ID，无可靠 CODEX_TURN_ID。report-and-wait 可让等待中的同一任务收到答复；不能唤醒已结束任务。
- 项目 MCP 需要受信任配置；运行中桌面不保证热加载：https://developers.openai.com/codex/mcp 。Hook 内容需信任，Stop 不等于完成：https://learn.chatgpt.com/docs/hooks 。不得读取 transcript_path 当稳定 API。
- Twilio 不支持中国大陆外呼：https://www.twilio.com/en-us/guidelines/cn/voice 。官方 SDK MIT：https://github.com/twilio/twilio-node 。签名：https://www.twilio.com/docs/usage/security 。新控制台不可新建 legacy Test Credentials：https://www.twilio.com/docs/iam/test-credentials 。本地 HTTP 契约模拟为默认测试。
- 阿里云拒绝个人及部分自然人企业资质：https://help.aliyun.com/zh/vms/user-guide/enterprise-qualification-management 。公共模式 ¥0.11/分钟：https://help.aliyun.com/zh/vms/product-overview/voice-services-pricing-in-china 。SingleCallByTts：https://help.aliyun.com/zh/vms/developer-reference/api-dyvmsapi-2017-05-25-singlecallbytts 。查询：https://help.aliyun.com/zh/vms/developer-reference/api-dyvmsapi-2017-05-25-querycalldetailbycallid 。模板最多两个变量，必须按审核范围使用，不承诺任意长文本。
- 腾讯云企业 VMS 月功能费停止新购：https://cloud.tencent.com/document/product/1128/110430 ，本期不适配。
- 参考 OpenClaw voice-call（MIT）：https://github.com/openclaw/openclaw/blob/main/docs/plugins/voice-call.md 。不复制 ZeframLou/call-me（README 与完整许可文本不一致）或 sidinsearch/AgentCall（NOTICE 承认未授权上游代码）；不选附额外限制的 SIPSorcery。
- baresip BSD-3-Clause，v4.11.0，Windows 源码可构建，无官方完整 Windows 便携 release：https://github.com/baresip/baresip 。本机 MSVC 19.44/CMake 3.31.6/Windows SDK 已实际核实，不需系统安装。软件测试应含 SIP、RTP有效音频、DTMF、BYE，不能仅 OPTIONS。
- Node 22.23.3 官方 Windows x64 便携包及校验：https://nodejs.org/download/release/latest-v22.x/SHASUMS256.txt 。node:sqlite 在22仍实验性，存储层隔离并测试。
- Windows DPAPI CurrentUser 内存往返已验证，不写文件；换电脑需重新填写凭据并登录，不复制认证。默认导出仅非敏感设置。

## 费用及阻塞
没有已核实的个人 +86 云外呼路线。Twilio 非 +86 需号码/地区权限/计费条件与HTTPS回调；阿里云需合格企业+模板审核。真实拨号与新付费模型调用需单独授权。SIP运营商/ATA/NAT等待实测。
