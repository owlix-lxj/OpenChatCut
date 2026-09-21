import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const exportHistory = await readFile(new URL('./ExportHistory.tsx', import.meta.url), 'utf8');
const topBar = await readFile(new URL('./TopBar.tsx', import.meta.url), 'utf8');
const dashboard = await readFile(new URL('./dashboard/DashboardViews.tsx', import.meta.url), 'utf8');

assert.match(
  exportHistory,
  /<TopBarIconButton[\s\S]*?icon="download"[\s\S]*?label=\{t\('导出历史'\)\}/,
  '导出历史按钮应复用顶部栏图标按钮',
);
assert.doesNotMatch(
  exportHistory,
  /<button title=\{t\('导出历史'\)\}/,
  '导出历史按钮不应使用样式不可控的原生 title',
);
assert.match(topBar, /icon="sliders" label=\{t\('设置'\)\}/, '编辑器顶部栏必须显示设置入口');
assert.match(dashboard, /setDialog\('settings', true\)/, '工程列表顶部栏必须显示设置入口');

console.log('top bar immediate tooltips verified');
