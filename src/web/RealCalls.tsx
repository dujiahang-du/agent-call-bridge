import { useState } from 'react';
type Props = { mode: string; busy: boolean; enabled: boolean; notifications: any[]; request: (path: string, body?: unknown) => Promise<any>; run: (action: () => Promise<any>, message?: string) => Promise<any> };
export function RealCalls({ mode, busy, enabled, notifications, request, run }: Props) {
  const [confirmation, setConfirmation] = useState('');
  const [individual, setIndividual] = useState<string | null>(null);
  const phrase = individual ? '拨打本次真实电话' : '我确认线路可用并同意受限自动外呼及可能费用';
  return <section className="panel real-controls"><div className="section-head"><h2>真实电话授权</h2><span className={`tag ${enabled ? 'warm' : 'neutral'}`}>{enabled ? '本次运行已启用' : '真实拨号已锁定'}</span></div>
    <p>先保存并核对配置。手机号和 Key 不代表线路已开通；真实测试及自动通知可能产生费用。只有本人明确确认后才会拨号。</p>
    {mode === 'mock' ? <div className="soft-note"><p>当前是 Mock。所有测试均为模拟，不会拨打真实电话。</p></div> : <>
      <button className="button secondary" disabled={busy} onClick={() => run(() => request('/real-test', {}), '真实测试已准备，尚未拨号；请审核目标后单独授权')}>准备真实测试（先审核）</button>
      <div className="warning">{['pushplus', 'aliyun', 'ihuyi', 'ronglian'].includes(mode) ? '当前通道为单向语音通知，本项目不提供远程取消；“紧急停止”阻止后续电话，已受理的通话可能继续。' : '真实线路仍需账号、用途和目的地权限；本地验证不代表已开通。'}{mode === 'pushplus' && ' pushplus 只朗读标题，“已发送”不代表已接听。'}</div>
      {enabled && <button className="button secondary" disabled={busy} onClick={() => run(() => request('/real-calls/disable', {}), '真实自动通知已停用，排队授权已撤销')}>停用真实自动通知</button>}
      {(!enabled || individual) && <div className="authorization-form">
        <div className="section-head"><h3>{individual ? '确认这一次通话' : '受限自动通知'}</h3><button className="text-button" disabled={busy} onClick={() => { setIndividual(null); setConfirmation(''); }}>授权受限自动通知</button></div>
        <p className="muted">{individual ? '你正在授权下面选中的一次真实通话。' : '自动授权只在本次运行有效；保存配置、暂停、退出或重启后失效。冷却与通数上限始终生效。'}</p>
        {individual && <div className="soft-note"><p>{notifications.find(n => n.id === individual)?.request?.text} · 目标 {notifications.find(n => n.id === individual)?.request?.to}</p></div>}
        <label className="field"><span>输入“{phrase}”</span><input autoComplete="off" disabled={busy} value={confirmation} onChange={e => setConfirmation(e.target.value)}/></label>
        <button className="button" disabled={busy || confirmation !== phrase} onClick={() => run(async () => { await request(individual ? `/notifications/${individual}/authorize` : '/real-calls/enable', { confirmation }); setConfirmation(''); setIndividual(null); }, individual ? '本次真实电话已授权，正在按限频规则处理' : '本次运行的真实自动通知已启用')}>{individual ? '确认并拨打这一次' : '确认启用受限自动通知'}</button>
      </div>}
      {notifications.filter(n => n.status === 'awaiting_authorization').length > 0 && <div className="event-list">{notifications.filter(n => n.status === 'awaiting_authorization').slice(0, 10).map(n => <div key={n.id}><div><strong>{n.request?.text ?? n.taskId}</strong><small>目标 {n.request?.to} · 等待独立授权</small></div><button className="button secondary" disabled={busy} onClick={() => { setIndividual(n.id); setConfirmation(''); }}>审核这次通话</button></div>)}</div>}
    </>}
  </section>;
}
