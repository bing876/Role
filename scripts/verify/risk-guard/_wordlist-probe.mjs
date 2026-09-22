/**
 * 阶段1 探针：验证「高风险动作」词表的覆盖与误伤。
 * 口径（用户 2026-09-21 定）：付款 / 下单 / 密码 / 验证码 / 登录墙 = 高风险，必须申报；
 * 其余（下一步、注册、提交资料、选类目）= AI 全权自主，**不许误伤**。
 *
 * 判据：直接 require 编译产物里的 fieldClass.js（tsc 输出，与主进程跑的是同一份逻辑）。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const P = path.resolve('apps/desktop/dist-electron/fieldClass.js');
const m = await import(pathToFileURL(P).href);
const { isPaymentConfirmAction, classifyField } = m;

let pass = 0;
let fail = 0;

/** should=true 期望被判为高风险（AI 不许点）；false 期望放行（AI 自己点） */
function check(label, should, got) {
  const ok = should === got;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(22)} 期望=${should ? '拦截' : '放行'} 实际=${got ? '拦截' : '放行'}`);
}

console.log('=== A. 按钮文案（isPaymentConfirmAction）===');
console.log('-- 应拦截：付款 / 下单 --');
[['立即支付', 1], ['确认支付', 1], ['提交订单', 1], ['确认订单', 1], ['去支付', 1],
 ['付款', 1], ['Pay Now', 1], ['Place Order', 1], ['Checkout', 1]].forEach(([t]) => check(t, true, isPaymentConfirmAction(t)));

console.log('-- 应放行：注册/入驻流程里的普通按钮（用户口径：不是付款就能代点）--');
[['下一步', 0], ['提交入驻申请', 0], ['立即注册', 0], ['同意协议', 0],
 ['保存', 0], ['继续', 0], ['选择类目', 0], ['上传营业执照', 0]].forEach(([t]) => check(t, false, isPaymentConfirmAction(t)));

console.log('\n=== B. 输入框（classifyField）—— 敏感的一律 sensitive ===');
function kindOf(d) {
  return classifyField(d).kind;
}
console.log('-- 应拦截（sensitive）--');
check('type=password', true, kindOf({ type: 'password', name: 'pwd' }) === 'sensitive');
check('短信验证码', true, kindOf({ type: 'text', ph: '请输入短信验证码' }) === 'sensitive');
check('otp 输入', true, kindOf({ type: 'text', name: 'otp' }) === 'sensitive');
check('银行卡号', true, kindOf({ type: 'text', ph: '银行卡号' }) === 'sensitive');
check('身份证号', true, kindOf({ type: 'text', ph: '身份证号' }) === 'sensitive');

console.log('-- 应放行（normal）：注册店铺要填的普通资料 --');
check('店铺名称', false, kindOf({ type: 'text', ph: '请输入店铺名称' }) === 'sensitive');
check('营业执照编号', false, kindOf({ type: 'text', ph: '统一社会信用代码' }) === 'sensitive');
check('联系人手机号', false, kindOf({ type: 'tel', ph: '联系人手机号' }) === 'sensitive');
check('经营地址', false, kindOf({ type: 'text', ph: '经营地址' }) === 'sensitive');

console.log(`\n合计 ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
