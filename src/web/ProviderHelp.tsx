import type { ProviderId } from '../shared/contracts';

const guides = {
  twilio: {
    title: '从哪里申请 Twilio？',
    description: '在 Twilio 官网注册或登录，再核对试用资格、可用主叫号码及目标地区权限。',
    links: [
      ['注册 / 登录 Twilio', 'https://www.twilio.com/try-twilio'],
      ['查看开通与试用条件', 'https://www.twilio.com/docs/usage/trials'],
      ['查看中国大陆限制', 'https://www.twilio.com/en-us/guidelines/cn/voice'],
    ],
  },
  aliyun: {
    title: '从哪里申请阿里云语音？',
    description: '先核对企业申请条件，再进入语音控制台提交资质，申请公共模式的中文语音模板。',
    links: [
      ['打开语音控制台', 'https://dyvms.console.aliyun.com/dyvms.htm'],
      ['查看企业申请条件', 'https://help.aliyun.com/zh/vms/user-guide/enterprise-qualification-management'],
      ['申请语音模板', 'https://help.aliyun.com/zh/vms/user-guide/create-a-text-to-speech-template'],
    ],
  },
  sip: {
    title: 'SIP 账号从哪里获取？',
    description: 'SIP 没有统一的申请网站。请向你使用的电话服务商或公司电话管理员申请服务器地址、账号、密码与分机；本项目不提供线路或账号。',
    links: [
      ['查看 SIP / 座机接入指南', 'https://github.com/dujiahang-du/agent-call-bridge/blob/main/docs/sip.md'],
    ],
  },
} as const;

export function ProviderHelp({ provider }: { provider: ProviderId }) {
  if (provider === 'mock') return null;
  const guide = guides[provider];
  return <section className="provider-help" aria-label="服务申请入口">
    <h3>{guide.title}</h3>
    <p>{guide.description}</p>
    <div className="provider-links">{guide.links.map(([label, href]) => <a key={href} href={href} target="_blank" rel="noopener noreferrer">{label}<span aria-hidden="true">↗</span></a>)}</div>
    <small>{provider === 'sip' ? '服务商条件与费用需另行核实；分机接通不代表手机外呼线路已开通。' : '注册账号不等于获得外呼线路。审核、号码和通话可能涉及费用，请先由本人核实。'} 链接在新标签页打开。</small>
  </section>;
}
