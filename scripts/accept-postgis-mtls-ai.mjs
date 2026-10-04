/** Real certificate file form and real hosted model through the actual Codex UI. */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
const [playwrightModule, evidencePath, credentialFile] = process.argv.slice(2);
const { chromium } = await import(playwrightModule);
const draft = JSON.parse(await fs.readFile(credentialFile, 'utf8'));
const fixture = path.dirname(credentialFile);
const report = { pass: false, cases: [] };
await fs.mkdir(evidencePath, { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:9233');
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes(':1420'));
const rpc = async (command, args = {}) => {
  const value = await page.evaluate(async ({ command, args }) => { try { return { result: await window.__TAURI_INTERNALS__.invoke(command, args) }; } catch (error) { return { error }; } }, { command, args });
  if (value.error) throw value.error; return value.result;
};
const chats = () => page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('geod-agent-conversations-0.1:account:')).flatMap(([, value]) => JSON.parse(value)));
let connectionId;
try {
  await page.goto('http://127.0.0.1:1420/test/data-input-harness.html?theme=dark&id=mtls-ai-form');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '数据库', exact: true }).click();
  await dialog.getByRole('button', { name: '添加 PostgreSQL / PostGIS', exact: true }).click();
  const name = `AI 双向证书连接 ${crypto.randomBytes(6).toString('hex')}`;
  for (const [label, value] of [['连接名称', name], ['主机', 'localhost'], ['端口', '55440'], ['数据库', draft.database], ['用户名', draft.user]]) await dialog.getByLabel(label, { exact: true }).fill(value);
  await dialog.getByRole('button', { name: '验证证书及主机', exact: true }).click();
  await dialog.locator('.data-input-ca textarea').fill(draft.sslRootCert);
  await dialog.getByRole('button', { name: '客户端证书 · 双向 TLS', exact: true }).click();
  const files = dialog.locator('.data-input-client-tls input[type=file]');
  await files.nth(0).setInputFiles(path.join(fixture, 'client.pem'));
  await files.nth(1).setInputFiles(path.join(fixture, 'client.key'));
  await dialog.getByRole('button', { name: 'client.key', exact: true }).waitFor();
  await page.mouse.move(20, 20);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(350); // Wait for the existing color transition, not an execution result.
    const contrast = await dialog.evaluate(element => {
      const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number);
      const lum = color => rgb(color).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((n, v, i) => n + v * [.2126, .7152, .0722][i], 0);
      return [...element.querySelectorAll('button:not(:disabled)')].filter(b => b.textContent.trim()).map(button => {
        let ancestor = button, background;
        while (ancestor) { background = getComputedStyle(ancestor).backgroundColor; if (background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') break; ancestor = ancestor.parentElement; }
        const a = lum(getComputedStyle(button).color), b = lum(background || 'rgb(255,255,255)');
        return { label: button.textContent.trim(), contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
      });
    });
    if (contrast.some(v => v.contrast < 4.5)) throw new Error(`${theme} enabled button contrast: ${JSON.stringify(contrast.filter(v => v.contrast < 4.5))}`);
    await page.screenshot({ path: path.join(evidencePath, `actual-certificate-form-${theme}.png`), fullPage: true });
    report.cases.push({ name: `Actual ${theme} certificate form after theme colors settle`, pass: true, minimumButtonContrast: Math.min(...contrast.map(v => v.contrast)), contrast });
  }
  await dialog.getByRole('button', { name: '测试并保存', exact: true }).click();
  await dialog.getByRole('button', { name: '测试并保存', exact: true }).waitFor({ state: 'hidden', timeout: 60000 });
  const connection = (await rpc('data_connections_list')).find(v => v.name === name);
  if (!connection?.clientCertificate) throw new Error('Real form did not save the native identity');
  connectionId = connection.id;
  await page.goto('http://127.0.0.1:1420');
  await page.getByRole('textbox', { name: '发送给 GeoD Agent' }).waitFor();
  const before = new Set((await chats()).map(v => v.conversationId));
  await page.locator('.sidebar-new-chat').click();
  let conversationId;
  for (let i = 0; i < 100; i++) { conversationId = (await chats()).find(v => !before.has(v.conversationId))?.conversationId; if (conversationId) break; await new Promise(r => setTimeout(r, 100)); }
  if (!conversationId) throw new Error('Actual conversation missing');
  const workspace = await rpc('workspace_get', { conversationId });
  await rpc('workspace_set', { conversationId, directory: workspace.directory, permission: 'fullAccess' });
  await page.reload(); await page.getByRole('textbox', { name: '发送给 GeoD Agent' }).waitFor();
  await page.getByRole('textbox', { name: '发送给 GeoD Agent' }).fill(`请通过数据输入扩展工具找到刚保存的“${name}”连接，用它读取 public.regions.geom：筛选 name 等于 certificate-east，最多 1 个要素。先读取真实字段与样例，告诉我 name 和 score 的实际值，再把同一个筛选结果附加为当前会话范围。证书已经在本机配置完成，复用这个连接即可。不要用命令行读取密码或私钥，也不要创建下载任务。`);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByRole('button', { name: '停止回复', exact: true }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: '停止回复', exact: true }).waitFor({ state: 'hidden', timeout: 150000 });
  const chat = (await chats()).find(v => v.conversationId === conversationId);
  const trace = JSON.stringify(chat);
  if (trace.includes(draft.sslClientKey) || trace.includes('-----BEGIN PRIVATE KEY-----')) throw new Error('Private key entered the model conversation');
  const tools = JSON.stringify(chat.display.filter(v => v.role === 'tool'));
  if (!tools.includes('data_layer_inspect') || !tools.includes('data_input_read') || !tools.includes('pgedge-postgres-mcp') || !tools.includes('certificate-east') || !tools.includes('41')) throw new Error('Actual native MCP field/read trace missing');
  const boundaries = await rpc('boundaries_list', { conversationId });
  if (!boundaries.some(v => v.polygonCount === 1 && Math.abs(v.bounds[0] - 116.1) < .000001)) throw new Error('Actual selected range was not saved');
  await fs.writeFile(path.join(evidencePath, 'actual-ai-conversation.json'), JSON.stringify(chat, null, 2));
  await page.screenshot({ path: path.join(evidencePath, 'actual-ai-certificate-read.png'), fullPage: true });
  report.cases.push({ name: 'Actual Codex and hosted model discover saved mTLS connection, read attributes and save selected range', pass: true, conversationId, connectionId, boundaries, answer: chat.messages.at(-1).content });
  report.pass = true;
} catch (error) { report.failure = error?.message ?? error; console.error(JSON.stringify(report.failure)); process.exitCode = 1; }
finally {
  if (connectionId) await rpc('data_connection_remove', { connectionId }).catch(() => {});
  if (page.url().includes('/test/')) await page.goto('http://127.0.0.1:1420').catch(() => {});
  await fs.writeFile(path.join(evidencePath, 'ai-acceptance.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
