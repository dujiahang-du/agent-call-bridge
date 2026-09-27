# 交付与恢复状态

2026-09-27 成功提示可见性修复（主分支，未另发安装包）：保存和账号核对原本在页面顶部显示成功信息，滚动后不在视口内；旧版浏览器用例已复现视口比例0失败。现为屏幕边缘可关闭浮层，移动端避开底部导航，不改变账号请求、保存和授权逻辑。类型/构建、12项Edge浏览器回归、独立复审及实际Agent→隔离Mock通过；1440px/360px实图已检查，测试服务退出且真实拨号次数0。根服务尚未重启，其旧静态资源路由不识别新文件，需用户关闭黑窗口重开Start.cmd后再刷新；此前自动重启被审批拒绝，不绕过。本轮不访问真实服务账号。

2026-09-27 pushplus 有效期兼容修复（主分支，未另发安装包）：真实只读接口返回成功，但 expiresIn 为数字字符串，旧解析误判为格式错误。现兼容有界纯数字字符串，缓存上限和所有拨号校验保持不变。修复后真实账号的访问凭据、完整绑定号码、实名和积分核对通过；没有发送通知、扣费或拨号。类型/构建、19项适配测试、10项实际浏览器回归、独立复审及实际Agent→隔离Bridge→Mock通过，测试服务已退出。需要用户关闭现有黑窗口、重新打开Start.cmd加载新后端；不把账号核对成功当作线路拨通。私人诊断仅保留.local。

v0.1.5 后续诊断修正（主分支，未另发安装包）：pushplus 账号核对区分官方 JSON 返回码、HTTP错误与连接超时，不再统一误导为白名单或超时；增加开发设置直达入口及分流/IP说明。类型/构建、相关17项离线契约、10项浏览器回归与独立复审通过，实际Agent→隔离Bridge→Mock完成。保留拨号授权和去重等原逻辑，不回显原始平台消息或凭据。更新后须重启启动器生效；平台账号设置和真实手机拨通仍待本人完成。实际账号诊断状态仅保存在忽略的.local，不发布私人数据。

v0.1.5已发布：https://github.com/dujiahang-du/agent-call-bridge/releases/tag/v0.1.5 ，代码标签4b93223。pushplus、互亿、容联真实HTTP适配与界面完成，后端等100/100、浏览器10/10、真实Codex审查任务→Bridge→Mock通过。独立Review及修复复审通过；首次UI健康检测因继承代理502失败，已仅在测试进程修复并全量通过。最终ZIP独立启动器92/92、新通道39/39、运行诊断7/7通过，GitHub资产SHA与实测包一致、匿名下载200；本机运行实例已升级，保留原Mock/暂停且未授权真实拨号。Codex tree快照路径扫描已修复及独立复审，17项安全测试、全部14次提交历史与候选双扫描通过，无真实泄漏。按检查点提交推送，没有永久定时任务。真实凭据与收费拨号仍未授权；个人+86线路未落实，下一步由本人按docs/USER_GUIDE.md核实并配置，首次真实拨号另行确认。

2026-09-27 国内个人线路补查记录（早于上述适配）：pushplus 的个人实名和 voice 电话渠道文档条件最贴近需求，0.30 元/次、只播标题、官方提示接通不稳。独立资料复核完成；具体来源和互亿/腾讯/华为/容联/网易限制已保存在 docs/personal-86-options.md。没有注册、付费或拨号；后续优先真实验证此候选，Zadarma 保留海外备选。

最新v0.1.4已发布：https://github.com/dujiahang-du/agent-call-bridge/releases/tag/v0.1.4 ，代码标签cbc089c；资产SHA与实测ZIP一致，匿名下载200。用户根目录错误源于仍运行的旧后台实例，已核实身份后正常停止，真实黑窗口与工作台恢复。补同目录安全迁移与旧暂停状态兼容；ZIP92项、无系统Node/npm诊断7项、界面1项回归及独立审查通过，无本次测试进程残留或真实外呼。当前实际Agent修复汇报已进入本机Bridge的Mock队列，因保留原暂停而queued，不能称其已播完。公开线路方向明确为原生+86手机接听；Zadarma仅待审核的个人候选，详见docs/personal-86-options.md，不能称为已落实。发布扫描已覆盖11次历史提交，零凭据发现。

最新版本 v0.1.3 已发布：https://github.com/dujiahang-du/agent-call-bridge/releases/tag/v0.1.3 。代码标签a6c6a1c。双击启动、关窗/Ctrl+C停止本次服务及子进程；重复窗口隔离，正常重开直接Mock，手动暂停保留，真实授权不恢复。类型/构建、62/62后端等、5/5浏览器、59/59最终包窗口检查、7项无系统Node/npm运行诊断通过，独立复审通过。ZIP SHA256：268a08bb19b5200e86bf38abb6ef18cb9674bf86f2815de53165d3c65fb60884，与GitHub资产digest一致、匿名下载200。候选和9次提交历史扫描无泄漏。证据见.local/launcher-evidence-v013.json与.local/portable-static-v013.json；所有本次测试进程已退出。以下为此前版本记录。

最新版本 v0.1.2 已发布：https://github.com/dujiahang-du/agent-call-bridge/releases/tag/v0.1.2 。标签823ccea增加电话服务官方申请入口、条件和SIP账号获取说明，向导与设置页即时同步；保留v0.1.1界面。类型/构建、浏览器5/5、独立Review、便携包41/41通过。包SHA256为3c50110599f0b5b8f903d4ee72b463843c32232c4cb128ad3a2aba9f561376ac，与GitHub一致。未自动注册、充值或真实拨号；证据.local/portable-evidence-v012.json。以下为此前版本记录。

最新界面版本 v0.1.1 已发布：https://github.com/dujiahang-du/agent-call-bridge/releases/tag/v0.1.1 。代码标签4ddcc30，雾白/海军蓝配色、字号层次、移动底部导航与记录卡片；授权按钮加入忙碌保护。类型/构建、浏览器5/5、独立Review、便携包34/34通过。新包SHA256为6fd729ffcfe46e299cb3fe1ee4ee7cb566a0aac263c22eebd2ccc7fefe082510，与GitHub一致。此次未重跑下文v0.1.0后端61项，也未真实拨号；UI和包原始证据留.local，已保存新版公开脱敏截图。以下为首版交付基线。

2026-09-27，本次可自主软件范围已完成。仓库先 Private 开发；安全检查、独立 Review 和软件验收后已转 Public：
https://github.com/dujiahang-du/agent-call-bridge

v0.1.0 预发布已发布，代码标签指向 73dada5；后续主分支仅补充交付记录：
https://github.com/dujiahang-du/agent-call-bridge/releases/tag/v0.1.0

## 实际证据
- 类型检查、生产构建通过；后端等61/61、浏览器5/5、便携包31/31通过，无跳过。
- 真实现有Codex子任务→Bridge→Mock→界面答复→同一等待任务继续生成文件并汇报；本条中文试听约15.27秒。不是固定事件脚本。
- MCP stdio真实连接，隔离Codex app-server握手；没有模型推理。SIP中文音频、注册、RTP/DTMF/BYE和停止完成本机软件验证。
- 独立Review问题均修复复验；完整历史和候选扫描零凭据发现，生产依赖审计零已知漏洞。按检查点安全提交推送，没有安装永久定时备份任务。
- 随包Node22.23.3，在移除测试进程PATH中系统Node/npm后启动、保存、重启、Mock、退出通过。换电脑仍需重新配置凭据与登录；未做第二台实机测试。
- 发行ZIP SHA256：2463444dac06ccf419222d3e376ddd069be54f8ea709fbefe1a212b55179936a，与GitHub资产digest一致。准确本机路径见忽略的.local/release-manifest.json。

## 确实剩余的事项
个人+86线路未落实；无真实手机拨号、云线路、公网回调、ATA实测。按docs/USER_GUIDE.md集中补齐资质/账号/参数，首次真实拨号仍需本人另行明确授权。完整托管界面、SIP任务按键、自由语音交流属于后续版本。

首次SIP调试曾意外生成用户profile默认config/accounts，自动审批拒绝精确清理（blocked by policy），未绕过；已改专属工作目录并通过隔离回归。两份文件的本机路径/哈希见.local/sip-initial-launch-incident.json，清理需用户本人处理。

## 恢复入口
先读task_plan.md、findings.md、本页与docs/VALIDATION.md，再看git status。不要重新调研或重做已验证环节。原始实际任务、浏览器和便携包证据仅留.local，不上传真实thread/session、机密、数据库或录音。没有授权继续执行真实收费测试，也不承诺会话结束后自动开发。
