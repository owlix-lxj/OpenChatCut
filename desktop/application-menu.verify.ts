import assert from 'node:assert/strict';
import { chineseApplicationMenu } from './application-menu.ts';

const menu = chineseApplicationMenu('AI-cut Dev');
assert.deepEqual(menu.map((item) => item.label), [
  'AI-cut Dev', '文件', '编辑', '视图', '窗口', '帮助',
]);

const appMenu = menu[0]?.submenu;
assert.ok(Array.isArray(appMenu));
assert.equal(appMenu.at(0)?.label, '关于 AI-cut Dev');
assert.equal(appMenu.at(-1)?.label, '退出 AI-cut Dev');

console.log('application-menu.verify: native menu labels are Chinese');
