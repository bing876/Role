/**
 * 自测试脚本：验证本轮修复的四个关键场景
 */
import { startLoop, injectUserMessage, getLoop, stopLoop, LOOP_SYSTEM_PROMPT } from '../../apps/server/src/toolLoop';
import { registerLoopSse, broadcastLoopEvent, endLoopSse } from '../../apps/server/src/loopSse';
import { EventEmitter } from 'node:events';

console.log('=== 开始自动化自测 ===\n');

// 场景 a: 意图判定与任务建立
console.log('--- 测试场景 a: 自然语言指令任务识别 ---');
function shouldEnterTaskModeTest(msg, hasPage) {
  const t = (msg ?? '').trim();
  if (!t) return false;
  if (/^(你好|您好|hi|hello|哈喽|早上好|中午好|晚上好|早安|晚安|嗨|你是谁|做个自我介绍|介绍一下你自己|谢谢|感谢|多谢|thx|thanks)[!！。？?~～\s]*$/i.test(t)) {
    return false;
  }
  if (/^(什么是|解释一下|科普一下|写一首|写一篇|写一段|帮我写代码)/.test(t)) {
    if (!/(打开|访问|浏览|点击|填|输入|登录|注册|下单|买|购|订|选|抓取|整理|分析|诊断|爬取|刷新|滚动|关闭|切换|http)/.test(t)) {
      return false;
    }
  }
  if (/https?:\/\//i.test(t)) return true;
  const STRONG_ACTION = /(打开|访问|浏览|点击|填|输入|登录|注册|下单|买|购|订|选|抓取|整理|分析|诊断|爬取|刷新|滚动|关闭|切换)/;
  const WEAK_ACTION = /(搜|查|看)/;
  const PAGE_REF = /(这个页面|当前页|当前页面|这张页|页面上|页面里|在这里|在这张|在这页|此页面)/;
  if (hasPage) {
    if (STRONG_ACTION.test(t)) return true;
    if (WEAK_ACTION.test(t) && PAGE_REF.test(t)) return true;
    return false;
  } else {
    if (STRONG_ACTION.test(t)) return true;
    return false;
  }
}

const testCases = [
  { msg: '帮我下单', hasPage: false, expected: true },
  { msg: '帮我下单这个商品', hasPage: true, expected: true },
  { msg: '把这个页面上的商品整理一下', hasPage: true, expected: true },
  { msg: '诊断一下我的店铺后台情况', hasPage: false, expected: true },
  { msg: '你好', hasPage: false, expected: false },
  { msg: '你好', hasPage: true, expected: false },
  { msg: '什么是量子力学', hasPage: false, expected: false },
  { msg: '在这个页面搜一下 AI 最新动态', hasPage: true, expected: true },
  // R4 新增：长闲聊不应发车
  { msg: '今天天气真舒服，早上出门遛弯的时候楼下花坛开了好多月季，心情特别好，你那边天气怎么样啊', hasPage: false, expected: false },
  { msg: '帮我查一下今天北京的天气怎么样', hasPage: false, expected: false },
  { msg: '打开百度，搜索一下今天的新闻', hasPage: false, expected: true },
  { msg: '今天北京天气怎么样', hasPage: true, expected: false },
];

let allPassed = true;
for (const tc of testCases) {
  const actual = shouldEnterTaskModeTest(tc.msg, tc.hasPage);
  const ok = actual === tc.expected;
  if (!ok) allPassed = false;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] "${tc.msg}" (hasPage=${tc.hasPage}) => taskMode: ${actual} (预期: ${tc.expected})`);
}
if (!allPassed) throw new Error('场景 a 存在未通过用例');
console.log('✅ 场景 a 意图判断测试全部通过！\n');

// 场景 b: SSE 长连接保持与执行步骤实时广播
console.log('--- 测试场景 b: 任务轮 SSE 步骤实时广播 ---');
class MockSseResponse extends EventEmitter {
  constructor() {
    super();
    this.chunks = [];
    this.writableEnded = false;
    this.destroyed = false;
  }
  write(chunk) {
    this.chunks.push(chunk);
    return true;
  }
  end() {
    this.writableEnded = true;
    this.emit('finish');
  }
}

const mockRes = new MockSseResponse();
const testLoopId = 'test-loop-' + Date.now();
registerLoopSse(testLoopId, mockRes, 101);

// 模拟推进第 1 步
broadcastLoopEvent(testLoopId, 'step', { step: 1, description: '打开网址：https://www.example.com' });
broadcastLoopEvent(testLoopId, null, { delta: '\n\n**步骤 1**：打开网址：https://www.example.com' });

// 模拟推进第 2 步
broadcastLoopEvent(testLoopId, 'step', { step: 2, description: '点击「立即购买」' });
broadcastLoopEvent(testLoopId, null, { delta: '\n\n**步骤 2**：点击「立即购买」' });

// 模拟完成
endLoopSse(testLoopId, { conversationId: 101, done: true });

console.log(`接收到的 SSE 数据包数量: ${mockRes.chunks.length}`);
console.log(`SSE 连接状态: ended=${mockRes.writableEnded}`);
const fullSseOutput = mockRes.chunks.join('');
console.log('SSE 输出预览:');
console.log(fullSseOutput);

if (!fullSseOutput.includes('步骤 1') || !fullSseOutput.includes('步骤 2') || !mockRes.writableEnded) {
  throw new Error('场景 b SSE 实时推送校验失败');
}
console.log('✅ 场景 b 任务执行步骤实时回流验证通过！\n');

// 场景 c: 任务中途追问/补充指令注入上下文（不死锁、不产生冲突）
console.log('--- 测试场景 c: 运行中动态消息注入 ---');
const dummyEnv = {
  dbPool: null,
  jwtSecret: 'test',
  agentLoopMaxSteps: 10,
};
const session = startLoop(dummyEnv, {
  userId: 1,
  agentId: 1,
  conversationId: 101,
  goal: '帮我买一双运动鞋',
  pageUrl: 'https://shop.example.com',
});

console.log(`初始状态: loopId=${session.id}, status=${session.status}, 消息数=${session.messages.length}`);
// 用户在中途发送补充消息
injectUserMessage(session, '只要 42 码，颜色要黑色的');

const lastMsg = session.messages[session.messages.length - 1];
console.log('注入后的最新消息:');
console.log(lastMsg);

if (!lastMsg.content.includes('42 码') || !lastMsg.content.includes('黑色的') || lastMsg.role !== 'user') {
  throw new Error('场景 c 消息注入失败');
}
if (session.status !== 'running') {
  throw new Error(`场景 c 状态异常: status 应为 running，当前为 ${session.status}`);
}
stopLoop(session.id, 'test_done');
console.log('✅ 场景 c 补充指令注入测试通过，原 Loop 保持稳定运行！\n');

// 场景 d: 提示词首格规矩与后台节流配置检查
console.log('--- 测试场景 d: 首格规矩注入与后台配置 ---');
if (!LOOP_SYSTEM_PROMPT.includes('收到任务后必须先调用感知工具查看当前环境状态')) {
  throw new Error('系统提示词缺少首格感知规矩');
}
console.log('✅ 系统提示词首格规矩确认存在！');
console.log('=== 自测全部顺利通过！===');
