# SIP 实验性支持

SIP 为独立、可选通道。当前范围为 Windows x64、UDP/TCP、G.711 单声道音频、服务器注册与单通外呼。管理控制只监听 `127.0.0.1`。未启用 TLS/SRTP、公网 NAT 穿透、自动运营商线路、PBX 管理或 ATA 自动配置。普通手机号不能直接当作 SIP 分机使用。

## 构建与配置

已有 Visual Studio 2022 C++ 工具及 Windows SDK 时，在项目根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-sip.ps1
```

脚本只在项目 `.tools/` 下载和构建，不安装系统组件、不改全局 PATH、不使用 GitHub Actions。缺少工具链时明确报错，普通界面和 Mock 仍可使用。构建采用已有 VS 内置 CMake，不需要 Docker、OpenSSL、FFmpeg 或音频硬件。

输出位于 `.tools/release/sip/`：`baresip.exe`、两份 BSD 许可证及 `build-manifest.json`。发行包可把整个目录放到 `native/sip/`。这些生成的二进制不提交到源码 Git 仓库。

在同一配置向导的 SIP 页填写服务器主机、端口、UDP/TCP、账号、密码、接收分机，必要时指定上述可执行文件。保存配置不授权拨号。仅配置检查不联网；明确选择服务器注册检测后才发送 REGISTER，不会拨打分机。真实 SIP 外呼仍经过产品的授权、限频和停止开关。

本期只接受本项目构建的入口，启动前验证相邻 manifest 和 SHA-256。不能换成任意网上下载的 baresip：上游 MSVC 构建没有 getopt，可能忽略 `-f`，读取或创建用户全局配置。本项目自有小入口强制使用专属工作目录，测试检查用户全局配置前后不变。上游源码未修改，构建通过 CMake 替换应用入口。

## 运行与隐私

每次注册检测或通话启动独立隐藏进程，最多一通，不在适配器里重复拨号。呼叫受理结果不明时返回 unknown、尝试停止且不重拨。服务器拒接、超时、音频错误和停止操作各自返回失败状态。播放完成由原生 END_OF_FILE 事件确认；仅过了预计时间不会算成功。

系统 TTS 给 SIP 输出 8000 Hz、16 位、单声道 PCM WAV。22050 Hz 的普通预听 WAV 不能直接交给这一轻量构建：libre 重采样器要求整数采样率比例，适配器会在拨号前拒绝不兼容文件。

运行配置及公告音频仅临时存于 `.local/sip/`。baresip 需要短暂读取明文账号文件；目录在写入前限制 Windows ACL 为当前用户和 SYSTEM，退出时删除。正常通话不录音，原生诊断不返回前端或写公开日志。异常断电后可能留下本地临时文件；停止程序后可清理 `.local/sip/`，不要公开该目录。普通多用户/恶意本地进程的隔离不属于本期保障；ctrl_tcp 本身没有用户认证。

## 验证方法及边界

```powershell
node --import tsx --test tests/sip.test.ts tests/sip-native.test.ts
```

本机原生验证包括两个软件端点真实 INVITE/接听、双向 RTP 解码非静音 PCM、DTMF `1234`、BYE；另有本地服务器 401 Digest 认证注册/注销、未接通取消。测试文件说明合成音调与中文 Windows TTS 两种音源，音频仅在忽略的本地目录保存并清理。没有二进制时原生用例明确标记跳过，不算 SIP 验证通过。

2026-09-27 本机运行记录：原生软件链路、配置隔离和单元测试全部通过；包含系统中文 TTS 到接收端的非静音 PCM、正常 END_OF_FILE 完成、主动取消以及用户全局配置不变。二进制依赖检查仅列出 Windows 系统 DLL，无额外 VC 运行库。该记录不能替代陌生电脑、实际语音清晰度或外部线路验收。

DTMF 已在软件协议链路验证，本期未开放 SIP 按键直接回复任务决策；`decision_required` 会返回明确不支持，用户应使用界面回复。任何按键都不会变成 shell 命令。

软件验收不代表已验证真实运营商账号、+86 手机外呼、跨网 NAT、TLS、硬件声音质量或传统座机。硬件阶段需要核对真实 SIP 服务器注册、响铃/摘挂机、实际中文可懂度、双向音频、按键、断网恢复及收费条件。

## 传统座机与第三方来源

传统模拟话机接 ATA 的 FXS 口；ATA 再作为 SIP 分机接入服务器或局域网。FXS 只提供给话机的接口，不能凭空获得手机外呼线路。连接已有运营商模拟外线还需要 FXO 网关或相应线路服务。没有硬件时不能把软件测试写成 ATA 实机通过。

- [baresip v4.11.0](https://github.com/baresip/baresip/tree/3d30821f099925d24167f8a99e93ba4d1be98599)，BSD-3-Clause，复用 SIP UA、音频、控制模块。
- [libre v4.11.0](https://github.com/baresip/re/tree/ceefe9ff499aa1bcfb6255aff1737434dd385322)，BSD-3-Clause，复用 SIP/RTP/G.711 等底层。
- [官方 Windows CI](https://github.com/baresip/baresip/blob/v4.11.0/.github/workflows/windows.yml)、[ctrl_tcp 协议](https://github.com/baresip/baresip/blob/v4.11.0/modules/ctrl_tcp/ctrl_tcp.c)、[本地无注册账户](https://github.com/baresip/baresip/wiki/Accounts)。
- [Grandstream HT801 官方资料](https://www.grandstream.com/hubfs/Product_Documentation/datasheet_ht801_english.pdf)，仅作为 ATA/FXS 路线参考，不是已验证硬件或购买建议。
