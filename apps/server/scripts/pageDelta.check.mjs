/**
 * pageDelta 的断言式自检（不依赖数据库、不依赖网络，纯函数）。
 *
 * 为什么单独跑一遍：方案 B 的验收第 2 条要求「AI 必须识别出页面变了」，
 * 而识别的正确性**全部**压在这个纯函数上。它是整个机制里唯一可以脱离真机
 * 做确定性验证的一环 —— 真机那部分只能证明「流程通了」，证明不了「判据对不对」。
 *
 * 跑法：node apps/server/scripts/pageDelta.check.mjs
 */
import { pageDelta } from '../dist/pageDelta.js';

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`);
  }
}

const snap = (over) => ({
  url: 'https://example.com/a',
  title: '页面 A',
  buttons: ['登录', '搜索'],
  links: ['首页'],
  inputs: ['搜索框'],
  texts: ['欢迎'],
  ...over,
});

console.log('pageDelta 自检');

// 1) 完全没动 —— 这是「用户暂停期间啥也没干」的常见情况，绝不能判成变了
const d1 = pageDelta(snap(), snap());
check('没动 → unchanged', d1.kind, 'unchanged');
check('没动 → 无增删', [d1.added.length, d1.removed.length], [0, 0]);

// 2) 用户手动跳到了另一个网址 —— 最需要警惕的一类
const d2 = pageDelta(snap(), snap({ url: 'https://other.com/b', title: '页面 B' }));
check('换网址 → moved', d2.kind, 'moved');
check('换网址 → urlChanged', d2.urlChanged, true);

// 3) 只看标题变了（SPA 常见：地址不变、标题变）
const d3 = pageDelta(snap(), snap({ title: '页面 B' }));
check('只换标题 → moved', d3.kind, 'moved');
check('只换标题 → urlChanged 为假', d3.urlChanged, false);

// 4) 地址标题都没变，但页面内容变了（登录完成：多了「退出登录」、少了「登录」）
const d4 = pageDelta(
  snap(),
  snap({ buttons: ['退出登录', '搜索'], texts: ['欢迎回来'] }),
);
check('登录完成 → edited', d4.kind, 'edited');
check('登录完成 → 新增「退出登录」', d4.added.includes('退出登录'), true);
check('登录完成 → 消失「登录」', d4.removed.includes('登录'), true);
check('登录完成 → 地址没变', d4.urlChanged, false);

// 5) 没有暂停前的快照 —— 必须如实说不知道，绝不能假装「没变」
const d5 = pageDelta(null, snap());
check('无基准 → unknown', d5.kind, 'unknown');

// 6) 噪声过滤：末尾斜杠 / 协议 / #hash 的差异不该判成换页
const d6 = pageDelta(
  snap({ url: 'http://example.com/a/' }),
  snap({ url: 'https://example.com/a#top' }),
);
check('协议/斜杠/hash 差异 → unchanged', d6.kind, 'unchanged');

// 7) 差集要能同时反映「新增」和「消失」
const d7 = pageDelta(snap(), snap({ buttons: ['退出登录'], links: ['首页', '设置'] }));
check('同时有新增与消失', [d7.added.length > 0, d7.removed.length > 0], [true, true]);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
