# 电话服务配置与验证

最后核对官方资料：2026-09-27。当前发布范围实现适配代码并完成本地契约验证，**没有进行真实手机外呼，也没有验证任何运营商线路**。

| 模式 | 实现范围 | 真实使用前提 |
|---|---|---|
| Mock | 本机事件、队列、通知记录和选择回复 | 不需要账号，不会拨号；声音来自本机预览 |
| Twilio | 非中国大陆通知；中文 TTS；DTMF 密码及一次性选项；签名状态回调、查询、挂断 | 账号、可用主叫号码、目标地区拨号权限、独立 HTTPS 回调，以及用户明确授权 |
| 阿里云 | 企业中国大陆手机公共模板通知；延迟查询结果 | 合格企业、语音资质、场景话术及公共模板审核、余额、用户明确授权 |
| SIP | 见 [SIP 说明](sip.md)；独立组件由主程序注入 | 软件或硬件端点及账号，真实运营商线路另验 |

填写号码和密钥只会保存配置。默认连接检测只检查本地格式，不证明账号、线路或回调可用。真实拨号必须经本机界面的明确授权；测试通话默认走 Mock。所有服务商 SDK 均禁止自行重试拨号。

## Twilio

在设置向导填写 Account SID、Auth Token、主叫号码、HTTPS 回调地址和 4–12 位数字电话控制密码。只通过本机设置填写，不能贴入 GitHub 或聊天。中文语音固定使用 `Polly.Zhiyu`；本机语速/音色预览不改变云端音色。

Twilio [明确不支持中国大陆 +86 外呼](https://www.twilio.com/en-us/guidelines/cn/voice)，程序在发请求前拒绝该号码。开通账号或取得密钥不能改变此限制。其他地区仍需符合账户和地区条件，拒接、拦截和网络问题也可能导致失败。

独立回调应用只提供 `POST /twilio/status`、`POST /twilio/pin`、`POST /twilio/choice`。管理端口绝不能经隧道公开。外部回调 URL 必须匹配设置的 HTTPS 基址；如基址有 `/bridge` 等路径前缀，反向代理应剥离前缀后转发给独立回调监听器。校验签名时仍使用完整外部地址、查询字符串和所有表单字段，不信任外部 Host 或转发头。

只有签名正确、账户/主被叫/CallSid 与已存通知匹配的回调才进入处理。决策必须未过期；先验证电话密码，再选择当前任务列出的 1–9 个选项。每通电话只有一次密码输入机会，选择授权最多 120 秒且只消费一次。重启后未消费的电话密码授权丢失，需要在本机处理；不会凭号码或一句话执行系统命令。语音自然语言控制尚未实现。

呼叫响铃最多 25 秒，通话上限 120 秒；不启用录音。SDK 返回受理不等于接通，通话完成不等于任务验收。超时/断线/5xx 可能发生在受理后，因此结果记为未知，禁止自动重拨。仅明确拒绝的限流、占线或无人接听结果可由本地统一限流策略决定是否重试。

[官方 SDK](https://github.com/twilio/twilio-node) 为 MIT；[回调认证](https://www.twilio.com/docs/usage/security) 使用 SDK 验签。新控制台不能创建旧版 Test Credentials；旧凭据可以无费用验证部分 API，但[不会产生真实通话或状态回调](https://www.twilio.com/docs/iam/test-credentials)。本项目默认用本地 SDK/HTTP 模拟器验证，不要求申请账号。

费用按目的地和功能确定；[美国价目示例](https://www.twilio.com/en-us/voice/pricing/us)：呼出 $0.014/分钟，本地号码 $1.15/月，标准高级 TTS $0.0008/100 字符；其他地区、税费和附加能力需在平台核实。本项目不自动购买号码、充值或开通付费服务。

## 阿里云公共模板

阿里云[不支持个人、个体工商户及部分自然人独资类型](https://help.aliyun.com/zh/vms/user-guide/enterprise-qualification-management)。云账号实名认证不能代替独立语音资质审核。没有合格资质时请选择 Mock 或独立 SIP 软件测试，不要尝试购买号码来绕过审核。

本版本只发送 `SingleCallByTts` 公共模式通知，不传入专属号码。先向平台申请适合实际使用场景的模板，例如：“您的 ${task} 当前状态为 ${status}，请在本机查看详情。”该示例不保证获批。审核允许变量范围必须与下面固定取值相符：

- `task`：固定 `AI任务`，不会传真实任务标题、路径或任意 Agent 内容。
- `status`：`已完成`、`执行失败`、`等待处理`、`重试耗尽`、`需要您决定`、`本轮结束`。

向导填写最小权限 AccessKey ID/Secret、审核通过的公共模式 `TTS_...` 模板 ID、区域（默认 `cn-hangzhou`）。即使模板有两个变量，平台仍可能要求说明具体范围；[模板不能被当成任意长文本通道](https://help.aliyun.com/zh/vms/support/voice-template-faqs)。每次播报一次、固定服务商语速。本版本不支持阿里云语音回复；需要决定时只播报提醒，用户回本机处理。

[发送接口](https://help.aliyun.com/zh/vms/developer-reference/api-dyvmsapi-2017-05-25-singlecallbytts) 返回 `CallId` 后等待至少五分钟才开始[查询详情](https://help.aliyun.com/zh/vms/developer-reference/api-dyvmsapi-2017-05-25-querycalldetailbycallid)。查询空结果或暂不可用不会触发重拨，超出队列等待期限后人工核对。没有公网回调。官方 `CancelCall` [仅用于 ClickToDial 双呼](https://help.aliyun.com/zh/vms/developer-reference/api-dyvmsapi-2017-05-25-cancelcall)，所以本应用不调用它来冒充公共模板通知挂断；暂停可阻止后续通知，已经发出的一次短播报可能继续。

[公共模式参考价](https://help.aliyun.com/zh/vms/product-overview/voice-services-pricing-in-china) ¥0.11/分钟，不足一分钟按一分钟；价格以平台为准。官方 SDK `@alicloud/dyvmsapi20170525`、`@alicloud/openapi-core`、`@darabonba/typescript` 按各自 Apache-2.0 许可证使用。

## 已实际执行的免费验证

`tests/providers.test.ts` 使用虚构凭据与保留测试号码，禁止连接真实服务：

- Twilio 官方 SDK 生成 Calls 请求、中文 XML 转义、超时上限、回调地址、现有通话查询及挂断。
- +86 在 SDK 前拦截；拨号超时仅调用一次且记为未知。
- 阿里云官方 SDK 访问本机 HTTP 模拟器；独立重算 ACS3 HMAC-SHA256 签名及请求体摘要，核对两个模板字段、号码格式和业务关联 ID。
- 阿里云五分钟延迟查询、终态解析、关闭 SDK 自动重试。
- 全公网 URL 签名、账户/号码/通话绑定、错误密码、过期选择、未认证选择、重复消费和隔离管理路由。

这些测试不证明 PSTN 可达、中文声音实际播放、企业模板审批或现场设备兼容。完成配置和本人真实拨号授权后，需另外检查接听、音质、拒接、超时、停止、真实回调和按键对应任务。
