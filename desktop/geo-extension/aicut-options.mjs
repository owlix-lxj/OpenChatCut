const form = document.querySelector('#pair-form');
const field = document.querySelector('#pair-url');
const status = document.querySelector('#status');
let busy = false;
async function run(message) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || '插件未响应');
    field.value = '';
    status.textContent = message.type === 'AICUT_PAIR' ? '配对已保存，正在连接应用…' : '已解除配对；平台账号未退出。';
  } catch (error) { status.textContent = error.message; }
  finally { busy = false; document.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
}
form.addEventListener('submit', event => { event.preventDefault(); void run({ type: 'AICUT_PAIR', url: field.value.trim() }); });
document.querySelector('#unpair').addEventListener('click', () => void run({ type: 'AICUT_UNPAIR' }));
async function refresh() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'AICUT_STATUS' });
    if (!busy && result?.ok) status.textContent = result.connected ? '已连接 AI-cut' : '未连接：请先打开 AI-cut，再检查配对地址。';
  } catch { if (!busy) status.textContent = '插件未响应，请重新加载插件。'; }
}
void refresh();
setInterval(() => void refresh(), 2000);
