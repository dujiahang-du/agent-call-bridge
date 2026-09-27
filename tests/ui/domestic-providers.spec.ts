import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const headers = () => ({ Authorization: `Bearer ${JSON.parse(readFileSync(join(process.env.ACB_UI_TEST_DIR!, 'connection.json'), 'utf8')).token}` });
async function settings(page: Page) {
  const skip = page.getByRole('button', { name: '稍后配置，进入工作台' });
  if (await skip.isVisible()) await skip.click();
  await page.getByRole('button', { name: '通话设置', exact: true }).click();
}
async function save(page: Page) {
  const saved = page.waitForResponse(response => response.url().endsWith('/api/config') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  expect((await saved).ok()).toBeTruthy();
  await expect(page.getByRole('status')).toContainText('设置已保存');
}

test.beforeEach(async ({ page }) => {
  await page.goto(`/#token=${headers().Authorization.slice(7)}`);
  await expect(page.getByText('Bridge 运行中', { exact: true })).toBeVisible();
  await settings(page);
});
test.afterEach(async ({ request }) => {
  const restored = await request.put('/api/config', { headers: headers(), data: {
    mode: 'mock', providers: { pushplus: { token: null, secretKey: null }, ihuyi: { apiId: null, apiKey: null, templateId: '' }, ronglian: { accountSid: null, authToken: null, appId: null, templateText: '' } },
  } });
  expect(restored.ok()).toBeTruthy();
});

test('国内服务顺序、申请边界、安全链接和手机窄屏', async ({ page }) => {
  const service = page.getByRole('combobox', { name: '电话服务', exact: true });
  expect(await service.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)))
    .toEqual(['mock', 'pushplus', 'aliyun', 'ihuyi', 'ronglian', 'twilio', 'sip']);
  await service.selectOption('pushplus');
  const help = page.getByRole('region', { name: '服务申请入口' });
  await expect(help).toContainText('0.30 元');
  await expect(help).toContainText('标题上限 100 字');
  await expect(help).toContainText('默认预处理 / 消息规则');
  await expect(help).toContainText('真实开通与拨号待验证');
  await expect(help.getByRole('link', { name: '开放接口设置说明', exact: true })).toHaveAttribute('href', 'https://www.pushplus.plus/doc/guide/openApi.html');
  await expect(page.getByRole('combobox', { name: '区号', exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: '区号', exact: true })).toHaveValue('+86');
  await expect(page.getByText('这是我在 pushplus 实名绑定并同意接听的本人手机', { exact: true })).toBeVisible();
  await page.getByText('其他平台与线路的当前边界', { exact: true }).click();
  await expect(page.getByText(/腾讯云 VMS 月功能费已停止新购/)).toBeVisible();
  await expect(page.getByText(/网易云信现行语音验证码不能代替自由任务通知/)).toBeVisible();
  const links = await page.locator('.provider-help a, .provider-alternatives a').evaluateAll(nodes => nodes.map(node => ({ href: node.getAttribute('href')!, rel: node.getAttribute('rel'), referrer: node.getAttribute('referrerpolicy'), target: node.getAttribute('target') })));
  for (const link of links) { const url = new URL(link.href); expect(url.protocol).toBe('https:'); expect(url.search).toBe(''); expect(link.rel).toBe('noopener noreferrer'); expect(link.referrer).toBe('no-referrer'); expect(link.target).toBe('_blank'); }
  await service.selectOption('ihuyi');
  await expect(help).toContainText('个人不能开通');
  await expect(help).toContainText('两个变量依次为“AI任务”和“状态”');
  await service.selectOption('ronglian');
  await expect(help).toContainText('个人实名认证不代表语音通知业务可用');
  await expect(page.getByLabel('容联许可通知文本', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await service.selectOption('sip');
  await expect(help).toContainText('Zadarma');
});

const credentialCases = [
  { provider: 'pushplus', fields: [['token', 'pushplus Token'], ['secretKey', 'pushplus Secret Key']] },
  { provider: 'ihuyi', fields: [['apiId', '互亿 API ID'], ['apiKey', '互亿 API Key']] },
  { provider: 'ronglian', fields: [['accountSid', '容联 Account SID'], ['authToken', '容联 Auth Token'], ['appId', '容联 App ID']] },
] as const;
for (const { provider, fields } of credentialCases) test(`${provider} 密钥保存后清空回显，重载留空保留且真实拨号锁定`, async ({ page, request }) => {
  await page.getByRole('combobox', { name: '电话服务', exact: true }).selectOption(provider);
  const values: string[] = [];
  for (const [, label] of fields) { const input = page.getByLabel(label, { exact: true }); await expect(input).toHaveAttribute('type', 'password'); const value = randomUUID().replaceAll('-', ''); values.push(value); await input.fill(value); }
  if (provider === 'ihuyi') await page.getByLabel('互亿审核通过的模板 ID', { exact: true }).fill('local-template-fixture');
  if (provider === 'ronglian') await page.getByLabel('容联许可通知文本', { exact: true }).fill('任务状态：{status}。');
  await save(page);
  const checkMasked = async () => {
    const result = await request.get('/api/config', { headers: headers() }); expect(result.ok()).toBeTruthy(); const config = await result.json();
    for (const [key, label] of fields) { expect(config.providers[provider][key]).toBe(''); expect(config.secretConfigured[`providers.${provider}.${key}`]).toBe(true); await expect(page.getByLabel(label, { exact: true })).toHaveValue(''); }
    for (const value of values) { expect(JSON.stringify(config)).not.toContain(value); expect(await page.locator('body').innerText()).not.toContain(value); expect(page.url()).not.toContain(value); }
    expect((await (await request.get('/api/status', { headers: headers() })).json()).realCallsEnabled).toBe(false);
  };
  await checkMasked();
  await page.reload(); await settings(page);
  await expect(page.getByRole('combobox', { name: '电话服务', exact: true })).toHaveValue(provider);
  await save(page); await checkMasked();
});

test('pushplus 账号核对先保存，只在点击后请求；失败显示错误且不授权', async ({ page, request }) => {
  let accountChecks = 0;
  let shouldFail = false;
  const order: string[] = [];
  page.on('request', req => { if (req.method() === 'PUT' && req.url().endsWith('/api/config')) order.push('save'); });
  await page.route('**/api/pushplus/account-check', async route => {
    accountChecks++; order.push('account-check');
    expect(route.request().postDataJSON()).toEqual({ confirmation: '只核对pushplus绑定账号，不拨号' });
    await route.fulfill({ status: 200, json: { ok: !shouldFail, message: shouldFail ? '模拟账号资料不可核对，未拨号' : '模拟账号核对完成，未拨号' } });
  });
  await page.getByRole('combobox', { name: '电话服务', exact: true }).selectOption('pushplus');
  await page.getByRole('button', { name: '检查配置与本地连接', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(accountChecks).toBe(0);
  await page.getByLabel('pushplus Token', { exact: true }).fill(randomUUID().replaceAll('-', ''));
  await page.getByLabel('pushplus Secret Key', { exact: true }).fill(randomUUID().replaceAll('-', ''));
  await save(page); expect(accountChecks).toBe(0); order.length = 0;
  const before = await (await request.get('/api/notifications', { headers: headers() })).json();
  await page.getByRole('button', { name: '核对 pushplus 绑定账号（不拨号）', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('模拟账号核对完成，未拨号');
  expect(order).toEqual(['save', 'account-check']);
  shouldFail = true;
  await page.getByRole('button', { name: '核对 pushplus 绑定账号（不拨号）', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('模拟账号资料不可核对，未拨号');
  expect(accountChecks).toBe(2);
  expect(await (await request.get('/api/notifications', { headers: headers() })).json()).toEqual(before);
  expect((await (await request.get('/api/status', { headers: headers() })).json()).realCallsEnabled).toBe(false);
});
