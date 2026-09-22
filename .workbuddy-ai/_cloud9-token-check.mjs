/**
 * 云端 9 个提交（3c68c22）换装后的「包内是不是本轮代码」独立校验。
 * ★ 直接读**安装版 app.asar 里的字节**，不看构建产物 —— 构建产物是会动的靶子。
 */
import asar from '@electron/asar';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ASAR = 'C:\\Users\\bing\\AppData\\Local\\Programs\\@ai-workbenchdesktop\\resources\\app.asar';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud9-'));
asar.extractAll(ASAR, tmp);

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const listJs = (d) =>
  fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.js')).map((f) => read(path.join(d, f))).join('\n') : '';

const electron = listJs(path.join(tmp, 'dist-electron'));
const renderer = listJs(path.join(tmp, 'dist', 'assets'));

let pass = 0;
let fail = 0;
const A = (name, cond, extra = '') => {
  if (cond) pass++;
  else fail++;
  console.log(cond ? '✓' : '✗', name, extra);
};

console.log('主进程字节:', electron.length, '| 渲染层字节:', renderer.length);
console.log('');

A('包内渲染层含 webBridge（云端新增 380 行）', renderer.includes('webBridge'));
A('包内主进程含 backgroundThrottling（云端 Problem5）', electron.includes('backgroundThrottling'));
A('包内主进程含 loop_gone（P0 止血没被换丢）', electron.includes('loop_gone'));
A('包内主进程含 risk 守卫（第28步没被换丢）', electron.includes('risk'));
A('包内主进程含 helpState（求助卡没被换丢）', electron.includes('helpState') || electron.includes('ask_'));
A('包内渲染层含浏览器面板', renderer.includes('Browser') || renderer.includes('browser'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log('');
console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
