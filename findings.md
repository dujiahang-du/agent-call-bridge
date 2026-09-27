# 调研与决策（2026-09-27）

pushplus真实只读验证补充：getAccessKey成功响应中的expiresIn实测为字符串，与公开文档示例数字类型不同；已兼容严格十进制字符串并保持最多两小时/提前一分钟刷新。真实myInfo能返回完整本人号码，账号、号码、实名及积分检查已通过；只读检查不证明外呼线路可用，没有调用真实/send。特定账号信息、地址与原始证据不发布。

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
- Windows DPAPI CurrentUser 已验证；换电脑需重新填写凭据并登录，不复制认证。本期没有凭据导出或跨电脑迁移功能。

## 费用及阻塞
2026-09-27 申请入口补核：Twilio https://www.twilio.com/try-twilio 当前转至官方认证页，试用条件见 https://www.twilio.com/docs/usage/trials 。阿里云企业资质官方文档链接至 https://dyvms.console.aliyun.com/dyvms.htm （控制台需登录，未核验账号实际开通）；模板申请见 https://help.aliyun.com/zh/vms/user-guide/create-a-text-to-speech-template 。界面只展示固定外链，不附带本机号码、凭据或token，不自动注册或充值。

没有已完成个人账号开通及真实 +86 拨号验证的云线路。pushplus 现行文档提供个人实名和电话标题通知，v0.1.5 已实现离线适配，仍是待真实验收候选。Twilio 非 +86 需号码/地区权限/计费条件与HTTPS回调；阿里云需合格企业+模板审核。真实拨号与新付费模型调用需单独授权。SIP运营商/ATA/NAT等待实测。
# v0.1.3 控制台生命周期补充

启动器持有独立 Windows Job（`KILL_ON_JOB_CLOSE`），服务先等待私有 stdin 启动信号，分配入 Job 后才导入后端；浏览器不属于该 Job。关闭黑窗口先通过 stdin 请求停服，3秒后清理本次进程树。这样不依赖 PowerShell `finally` 在窗口被强制关闭时执行，也不按进程名称批量结束程序。

官方依据：[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[控制台关闭回调及其期限](https://learn.microsoft.com/en-us/windows/console/handlerroutine)。Windows 自带 PowerShell/.NET 本地编译辅助代码，无额外安装；发行包检测覆盖这一依赖。操作系统快速关机可能不给清理时间，云端已受理通话不保证可取消。

## 个人 +86 路线补核

v0.1.5 实现依据补充：pushplus [开放接口文档](https://www.pushplus.plus/doc/guide/openApi.html)明确 `getAccessKey` 使用用户token+secretKey，开放接口默认关闭并要求安全IP；访问凭据约2小时，重复刷新会影响旧凭据。`myInfo` 提供 token/phoneNumber/verifyStatus/points；本项目发送前精确核对本人号码，示例为掩码，真实若同样掩码则拒拨。`sendMessageResult` 的2只表示平台已发送，不证明电话接听。采用固定HTTPS+内存缓存+本地HTTP契约测试，未向真实服务发请求。

2026-09-27：目标明确为原生 +86 手机号码接听，不采用 App 来电替代。国内补查发现 pushplus 公开个人实名流程及 voice 电话渠道，0.30 元/次、只读标题，普通实名标题上限100字；官方提醒接通失败概率较大。v0.1.5 已接入并离线验证，尚未认证/真实拨通，也无已核实双向控制。互亿 FAQ 明确企业限定；容联个人账号不证明语音通知开通；两家也已实现离线适配。腾讯 VMS 停止新购月功能费。独立复核支持上述边界。

Zadarma 官方个人账户及中国手机 US$0.70/分钟资费可证，但大陆个人开户、自动通知用途和实际目的地放行仍待平台确认；作为海外备选，不是已落实线路。VoIP.ms 当前条款排除 China。可选自有固话+FXO路线需运营商同意及硬件实测。集中官方证据、申请入口与剩余问题见 [个人线路候选](docs/personal-86-options.md)，不再重复全平台调研。
