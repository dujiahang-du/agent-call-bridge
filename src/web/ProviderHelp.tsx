import type { ProviderId } from '../shared/contracts';

type Guide = { title: string; description: string; limits: string; links: readonly (readonly [string, string])[] };
const guides: Record<Exclude<ProviderId, 'mock'>, Guide> = {
  pushplus: {
    title: '个人自用：先了解 pushplus',
    description: '个人实名后绑定本人 +86 手机。在官网开发设置中启用开放接口、设置 Secret Key，并按平台要求配置出口公网 IP 安全名单。请关闭会转发或改写接收人的默认预处理 / 消息规则，并在实际测试中核对接收人。实名和语音可能收费，账号注册不等于线路开通。',
    limits: '语音每次 0.30 元，仅朗读标题；普通实名账号标题上限 100 字，不朗读正文。本项目不支持此通道的电话回复或远程取消。“已发送”不代表已接听，平台也提醒可能接通失败。',
    links: [
      ['登录 / 注册 pushplus', 'https://www.pushplus.plus/login.html'],
      ['个人实名认证', 'https://pushplus.plus/doc/function/verify.html'],
      ['语音渠道与费用', 'https://www.pushplus.plus/doc/channel/voice.html'],
      ['开放接口设置说明', 'https://www.pushplus.plus/doc/guide/openApi.html'],
    ],
  },
  ihuyi: {
    title: '互亿无线：企业语音通知',
    description: '官方语音通知 FAQ 要求企业实名认证，个人不能开通。请在官网办理账号、业务权限和通知模板审核，并核对当前报价。',
    limits: '使用获批模板，两个变量依次为“AI任务”和“状态”。本期为单向语音通知，不提供电话回复或远程取消；受理结果不等于实际接听。',
    links: [
      ['进入互亿无线官网', 'https://www.ihuyi.com/'],
      ['企业开通与发送条件', 'https://m.ihuyi.com/doc/voice/vm/faq_send.html'],
    ],
  },
  ronglian: {
    title: '容联云：先确认语音业务准入',
    description: '个人实名认证不代表语音通知业务可用。请先向平台确认个人能否开通本用途、所需资质及费用，再获取应用参数。',
    limits: '只填写平台许可的通知文本，以 {status} 插入任务状态。本期不提供此通道的电话回复或远程取消；个人准入和真实接通仍未验证。',
    links: [
      ['进入容联云官网', 'https://www.yuntongxun.com/'],
      ['查看账号类型与条件', 'https://doc.yuntongxun.com/p/5a51f9cc3b8496dd00dcdf10'],
      ['查看语音通知说明', 'https://doc.yuntongxun.com/p/5a5342c73b8496dd00dce139'],
    ],
  },
  twilio: {
    title: '从哪里申请 Twilio？',
    description: '在 Twilio 官网注册或登录，再核对试用资格、可用主叫号码及目标地区权限。',
    limits: '中国大陆号码不能作为目标。其他地区仍需线路和地区权限；号码与通话可能收费，双向按键还需要可访问的 HTTPS 回调。',
    links: [
      ['注册 / 登录 Twilio', 'https://www.twilio.com/try-twilio'],
      ['查看开通与试用条件', 'https://www.twilio.com/docs/usage/trials'],
      ['查看中国大陆限制', 'https://www.twilio.com/en-us/guidelines/cn/voice'],
    ],
  },
  aliyun: {
    title: '从哪里申请阿里云语音？',
    description: '先核对企业申请条件，再进入语音控制台提交资质，申请公共模式的中文语音模板。个人账号不能直接开通。',
    limits: '仅播报已审核模板允许的内容；资质、模板和通话可能收费。本项目不支持此通道的电话回复，已受理通知可能无法中途取消。',
    links: [
      ['打开语音控制台', 'https://dyvms.console.aliyun.com/dyvms.htm'],
      ['查看企业申请条件', 'https://help.aliyun.com/zh/vms/user-guide/enterprise-qualification-management'],
      ['申请语音模板', 'https://help.aliyun.com/zh/vms/user-guide/create-a-text-to-speech-template'],
    ],
  },
  sip: {
    title: 'SIP 账号从哪里获取？',
    description: 'SIP 没有统一的申请网站。请向电话服务商或公司电话管理员申请服务器、账号、密码与分机；本项目不提供线路。Zadarma 可使用这里的 SIP 配置，但须先由平台确认个人开户、+86 放行和自动通知用途。',
    limits: '本地软件通话已验证，运营商线路与硬件仍待实测。当前 UDP/TCP 为实验功能，没有 TLS/SRTP，SIP 按键未接入任务回复。线路可能收费。',
    links: [
      ['查看 SIP / 座机接入指南', 'https://github.com/dujiahang-du/agent-call-bridge/blob/main/docs/sip.md'],
      ['了解 Zadarma 个人外呼', 'https://zadarma.com/en/services/calls/'],
      ['查看中国目的地费用', 'https://zadarma.com/en/tariffs/calls/china/'],
    ],
  },
};

function ExternalLink({ label, href }: { label: string; href: string }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{label}<span aria-hidden="true">↗</span></a>;
}

export function ProviderHelp({ provider }: { provider: ProviderId }) {
  if (provider === 'mock') return null;
  const guide = guides[provider];
  return <section className="provider-help" aria-label="服务申请入口">
    <h3>{guide.title}</h3>
    <span className="provider-verification">{provider === 'sip' ? '本地软件已验证 · 真实线路待验证' : '接口已实现并离线验证 · 真实开通与拨号待验证'}</span>
    <p>{guide.description}</p>
    <div className="provider-links">{guide.links.map(([label, href]) => <ExternalLink key={href} label={label} href={href}/>)}</div>
    <p>{guide.limits}</p>
    <small>当前费用与审核以平台为准。填写凭据不会注册、充值或拨号；首次真实电话仍需你明确授权。链接在新标签页打开。</small>
  </section>;
}

export function OtherProviderNotes() {
  return <details className="provider-alternatives"><summary>其他平台与线路的当前边界</summary><ul>
    <li>腾讯云 VMS 月功能费已停止新购，未列为新用户选项。<ExternalLink label="查看腾讯公告" href="https://cloud.tencent.com/document/product/1128/110430"/></li>
    <li>华为云 VoiceCall 面向企业生产用途，当前未适配为个人自用线路。<ExternalLink label="查看华为用途规则" href="https://support.huaweicloud.com/VoiceCall_faq/VoiceCall_faq_0000_2.html"/></li>
    <li>网易云信现行语音验证码不能代替自由任务通知，当前未接入。<ExternalLink label="查看网易产品说明" href="https://netease.im/sms"/></li>
    <li>Zadarma 使用现有 SIP 配置，无需单独选择通道；个人开户、用途和 +86 放行仍须平台确认。</li>
  </ul></details>;
}
