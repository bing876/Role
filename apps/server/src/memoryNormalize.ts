/**
 * 记忆合并第一批 · 抽离的归一化与敏感闸（零 import）。
 *
 * 为什么零 import：db.ts 的迁移也要用它，不能让它依赖 cipher / pg / env，
 * 否则循环依赖或启动期拿不到密钥就会把迁移卡死。
 */

// 去重键：与旧两套实现逐字一致（大小写不敏感 + 去标点空格）
export function normalizeText(s: string): string {
  return String(s).toLowerCase().replace(/[\s，。、,.;；:：!！?？~～"'“”‘’()（）【】\-—_+·]/g, '');
}

// 敏感闸：合并旧两套的并集
// - 旧 memories.ts：密码/口令/passw/验证码/captcha/otp/动态码/身份证/银行卡/卡号/cvv/cvc/cookie/token/令牌/secret
// - 新 agents.ts：额外含 扫码/支付/付款/转账
// 合并后取并集，避免迁移时漏掉任一旧口径
export const SENSITIVE_MEM_RE =
  /(密码|口令|passw|验证\s*码|校验\s*码|captcha|\botp\b|动[态态].{0,2}(码|令)|身份证|银行\s*卡|信用\s*卡|卡号|\bcvv\b|\bcvc\b|cookie|token|令牌|\bsecret\b|扫\s*码|支付|付款|转账)/i;

export const LONG_DIGITS_RE = /\d{11,}/;

export function isSensitive(text: string): boolean {
  const s = String(text ?? '');
  return SENSITIVE_MEM_RE.test(s) || LONG_DIGITS_RE.test(s);
}
