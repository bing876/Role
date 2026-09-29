/**
 * 对抗性审查（2026-09-29）· **本机服务鉴权边界**的三个闸。
 *
 * 修的三个真实缺陷（不是理论问题）：
 *
 *   ① **CORS 回显任意来源**（`index.ts` 原 `cors({ origin: true })`）
 *      服务只听 127.0.0.1 只挡住"从外面连进来"，挡不住**用户自己浏览器里的任意网页**
 *      主动来打 127.0.0.1:8787 —— 那条路 CORS 是全放的，等于告诉浏览器"任何网页都能读我的响应"。
 *
 *   ② **无 Host 头校验**（全仓零命中）
 *      DNS rebinding：攻击者让 evil.example 解析到 127.0.0.1，浏览器就带着
 *      `Host: evil.example` 打本机服务，同源策略看不出来。CORS 拦的是"读响应"，
 *      而 `/auth/login/xyz` 的在线爆破**只要状态码就够**，不需要读响应体。
 *
 *   ③ **`/auth/login/xyz` 无失败计数、无锁定**（`routes/auth.ts`）
 *      分布式慢速试密码永远碰不到"每 IP 每分钟 20 次"的线，累积起来就是无限次尝试。
 *      且"号不存在"本身是免费探测口 —— 现在号不存在也计数。
 *
 * 本脚本逐条验"不能出的事"，每条附**反证口径**（拆掉闸必须红）。
 *
 * ★ 纪律（照 orc-routes.mts）：服务端模块一律 `require` 载入。
 *   `.mts`(ESM) 与 `apps/server`(CJS) 在 tsx 下各有一份模块图，`import` 拿到的
 *   实例与生产代码内部 require 到的不是同一个 ⇒ 测了个寂寞。
 *
 * 用法：npx tsx scripts/verify/security-guards.mts
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const { buildApp, isAllowedOrigin } = req('../../apps/server/src/index') as typeof import('../../apps/server/src/index');
const { loadEnv } = req('../../apps/server/src/env') as typeof import('../../apps/server/src/env');
const { makeCipher, hashPassword } = req('../../apps/server/src/crypto') as typeof import('../../apps/server/src/crypto');
const { makePool, migrate } = req('../../apps/server/src/db') as typeof import('../../apps/server/src/db');
const {
  makeLoginFailLimiter,
} = req('../../apps/server/src/routes/auth') as typeof import('../../apps/server/src/routes/auth');

let pass = 0;
function ok(name: string): void {
  pass += 1;
  console.log(`  PASS ${name}`);
}

async function main(): Promise<void> {
  // ---- 起一个真 app（PGlite，不占端口，用 inject）----
  // 照 model-settings.mts 的做法：先给环境变量兜底，再 loadEnv()
  process.env.DATABASE_URL ??= 'pglite://memory';
  process.env.JWT_SECRET ??= 'verify-security-jwt-secret';
  process.env.DATA_KEY ??= 'verify-security-data-key-64-chars';
  process.env.PHONE_PEPPER ??= 'verify-security-pepper-64-chars';
  process.env.SMS_MOCK = '1';
  const env = loadEnv();
  const pool = makePool('pglite://memory');
  await migrate(pool);
  const cipher = makeCipher(env.dataKey);
  const app = await buildApp(env, pool, cipher);
  await app.ready();

  // =====================================================================
  // ① CORS 白名单
  //    断言口径：**看 access-control-allow-origin 头在不在**。
  //    服务端对非法来源是静默拒绝（不回 403/500），浏览器那一层才真正拦读取 ——
  //    所以"安全属性"的正确表达是"没有下发允许头"，不是"状态码非 200"。
  // =====================================================================
  {
    // 1) 外来来源：不下发允许头
    const r = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(
      r.headers['access-control-allow-origin'],
      undefined,
      '外来来源不应收到 access-control-allow-origin 头',
    );
    ok('CORS：外来来源 https://evil.example 收不到允许头（浏览器会拦读取）');

    // 2) 生产安装包（file:// → Origin: null）必须放行 —— 这是最可能被误伤的一条
    const r2 = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'null' } });
    assert.equal(
      r2.headers['access-control-allow-origin'],
      'null',
      `安装包形态(Origin: null)应收到允许头，实际 ${r2.headers['access-control-allow-origin']}`,
    );
    ok('CORS：生产安装包 Origin: null 放行 —— 防"自己拦死登录页"');

    // 3) dev Vite 放行
    const r3 = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:5173' },
    });
    assert.equal(
      r3.headers['access-control-allow-origin'],
      'http://localhost:5173',
      'dev Vite 应收到允许头',
    );
    ok('CORS：dev Vite localhost:5173 放行');

    // 4) 非浏览器客户端（无 Origin 头）不走 CORS，不应因缺头而失败
    const r4 = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(r4.statusCode, 200, `无 Origin 头应正常返回，实际 ${r4.statusCode}`);
    ok('CORS：无 Origin 头（桌面主进程/curl）不受影响（200）');

    // 5) ★ dev 端口不再写死 5173（2026-09-29 第二轮）
    //    写死端口时，任何人改了 vite.config.ts 的 server.port，dev 会突然「连不上后端」，
    //    而现象和「服务没起」一模一样、极难排查。现在放行任意本机 http 端口。
    for (const p of ['5173', '5174', '9999', '']) {
      const rp = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: `http://localhost${p ? ':' + p : ''}` },
      });
      assert.equal(
        rp.headers['access-control-allow-origin'],
        `http://localhost${p ? ':' + p : ''}`,
        `localhost 端口 ${p || '(无端口)'} 应放行`,
      );
    }
    ok('CORS：dev 放行任意本机端口（5173/5174/9999/无端口）—— 改 Vite 端口不再静默断连');
  }

  // =====================================================================
  // ①' ★ isAllowedOrigin 单测：放行「任意本机端口」**不能**变成「任意域名」
  //    这是把 Set 换成正则后唯一真正的新风险面，必须逐个钉死。
  // =====================================================================
  {
    const allow = [
      'null', // 生产安装包 file://
      undefined, // 无 Origin 头（非浏览器客户端）
      'http://localhost',
      'http://localhost:5173',
      'http://localhost:99999',
      'http://127.0.0.1',
      'http://127.0.0.1:8787',
      'http://LOCALHOST:5173', // 大小写不敏感
    ];
    for (const o of allow) {
      assert.equal(isAllowedOrigin(o), true, `应放行 ${o}`);
    }
    ok('isAllowedOrigin：安装包 null / 无 Origin / 任意本机 http 端口 全放行');

    const deny = [
      'https://evil.example',
      'http://evil.example',
      // ★ 下面四条是「正则写松了就会漏」的典型伪装，逐个钉死
      'http://localhost.evil.com', // 子域后缀伪装
      'http://evil.com#localhost', // 片段伪装
      'http://evil.com?x=localhost', // 查询伪装
      'http://localhost@evil.com', // userinfo 伪装（@ 前是用户名不是主机名）
      'http://localhost:5173.evil.com', // 端口位塞域名
      'https://localhost:5173', // 本机但 https —— 我们只可能用 http
      'ws://localhost:5173',
      'file://',
      'http://[::1]:5173', // IPv6 回环：浏览器不会给 dev 用这个 origin，先按拒处理
    ];
    for (const o of deny) {
      assert.equal(isAllowedOrigin(o), false, `必须拒绝 ${o}`);
    }
    ok('isAllowedOrigin：子域/片段/查询/userinfo 伪装、https 本机、ws、file:// 全部拒绝');
  }

  // =====================================================================
  // ② Host 头校验（DNS rebinding）
  // =====================================================================
  {
    // 1) 非回环 Host 必须 421
    const r = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { host: 'evil.example' },
    });
    assert.equal(r.statusCode, 421, `非回环 Host 应 421，实际 ${r.statusCode}`);
    ok('Host：evil.example 被拒（421）—— DNS rebinding 防护');

    // 2) 回环 Host 放行（端口不限制：dev 与安装包端口可能不同）
    for (const h of ['127.0.0.1:8787', 'localhost:8787', '127.0.0.1:9999', '[::1]:8787']) {
      const rr = await app.inject({ method: 'GET', url: '/health', headers: { host: h } });
      assert.equal(rr.statusCode, 200, `回环 Host ${h} 应放行，实际 ${rr.statusCode}`);
    }
    ok('Host：127.0.0.1 / localhost / [::1]（任意端口）放行（200）');

    // 3) 无 Host 头放行（HTTP/1.0 或裸 socket，不是浏览器，无 rebinding 面）
    const r3 = await app.inject({ method: 'GET', url: '/health', headers: { host: '' } });
    assert.equal(r3.statusCode, 200, `无 Host 头应放行，实际 ${r3.statusCode}`);
    ok('Host：无 Host 头放行（200）');
  }

  // =====================================================================
  // ③ 登录失败计数 + 冷却（纯函数层，确定性测）
  // =====================================================================
  {
    let t = 1_000_000;
    const now = () => t;
    const lim = makeLoginFailLimiter({ maxFails: 10, cooldownMs: 15 * 60_000, now });

    // 1) 前 9 次失败不进冷却
    for (let i = 1; i <= 9; i += 1) {
      const n = lim.fail('XYZ12345');
      assert.equal(n, i, `第 ${i} 次失败累计应为 ${i}，实际 ${n}`);
      assert.equal(lim.cooling('XYZ12345'), false, `第 ${i} 次失败后不应进冷却`);
    }
    ok('登录失败计数：前 9 次失败累计正确且不进冷却');

    // 2) 第 10 次进冷却
    assert.equal(lim.fail('XYZ12345'), 10);
    assert.equal(lim.cooling('XYZ12345'), true, '第 10 次失败后必须进冷却');
    ok('登录失败计数：第 10 次失败进冷却');

    // 3) 冷却中继续失败**不延长**冷却（否则一次攻击可以无限续期，变成 DoS）
    t += 60_000;
    assert.equal(lim.cooling('XYZ12345'), true, '冷却期内应仍在冷却');
    const during = lim.fail('XYZ12345');
    assert.equal(during, 11, `冷却期内再失败累计应到 11，实际 ${during}`);
    assert.equal(lim.cooling('XYZ12345'), true, '冷却期内再失败后必须仍在冷却（不续期）');
    // 推进到"若续期则会解锁"的时间点：距最后一次失败只过了 14 分钟（< 冷却 15 分钟）。
    // 若不续期，此时 `until` 仍是第 10 次失败时设的那个，已过期 ⇒ 应已解锁。
    t += 14 * 60_000;
    assert.equal(lim.cooling('XYZ12345'), false, '冷却必须从第 10 次失败起算，不因期间失败而续期');
    ok('登录失败计数：冷却期内持续失败不会无限续期');

    // 4) 冷却过期后自动恢复
    t += 15 * 60_000 + 1;
    assert.equal(lim.cooling('XYZ12345'), false, '冷却过期后必须恢复');
    assert.equal(lim.fail('XYZ12345'), 1, '恢复后计数从 1 重新开始');
    ok('登录失败计数：冷却过期自动恢复，计数重新开始');

    // 5) 成功即清零
    for (let i = 0; i < 5; i += 1) lim.fail('XYZ99999');
    lim.reset('XYZ99999');
    assert.equal(lim.countOf('XYZ99999'), null, '成功后必须清零');
    ok('登录失败计数：登录成功即清零');

    // 6) ★ 不同账号互不影响（否则一个人被锁=全员被锁）
    for (let i = 0; i < 10; i += 1) lim.fail('XYZ11111');
    assert.equal(lim.cooling('XYZ11111'), true);
    assert.equal(lim.cooling('XYZ22222'), false, '锁一个号不能连带锁别的号');
    ok('登录失败计数：锁定按账号隔离，不连带');
  }

  // =====================================================================
  // ③' ★ **集成层**断言（2026-09-29 补，堵测试盲区）
  //
  // 上面 ③ 是纯函数层：就算有人把 login/xyz 里的 `cooling()` 判断整行删掉，
  // ③ 的断言照样全绿 —— 计数成了摆设。所以必须**真打 11 次 HTTP**，
  // 让第 11 次的 429 来证明"闸真的接在路由上"。
  // =====================================================================
  {
    // 直接往库里塞一个带密码的用户（绕开短信/引导流程，只测登录闸）
    const hash = hashPassword('correct-horse-battery');
    const xyz = 'XYZ70001';
    await pool.query('INSERT INTO users (xyz_id, password_hash) VALUES ($1, $2)', [xyz, hash]);

    const login = () =>
      app.inject({
        method: 'POST',
        url: '/auth/login/xyz',
        headers: { host: '127.0.0.1:8787' },
        payload: { xyz, password: 'wrong-password' },
      });

    // 1) 前 10 次：401（号或密码不对）—— 不是 429，闸没提前开火
    for (let i = 1; i <= 10; i += 1) {
      const r = await login();
      assert.equal(r.statusCode, 401, `第 ${i} 次错密应 401，实际 ${r.statusCode}`);
    }
    ok('登录集成：前 10 次错密都是 401（闸没提前开火）');

    // 2) 第 11 次：429 + too_many_attempts（闸真的接在路由上）
    const r11 = await login();
    assert.equal(r11.statusCode, 429, `第 11 次应 429，实际 ${r11.statusCode}`);
    const body = JSON.parse(r11.body) as { code?: string };
    assert.equal(body.code, 'too_many_attempts', `应带 code=too_many_attempts，实际 ${body.code}`);
    ok('登录集成：第 11 次错密被 429 + too_many_attempts 拦下');

    // 3) ★ 反证锚点：此时若把路由里的 `if (loginFailLimiter.cooling(xyz))` 删掉，
    //    第 11 次会变回 401 ⇒ 本条断言红。这就是上面 ③ 补不出来的那半边证据。
    console.log('  （反证锚点：删掉路由里的 cooling() 判断 → 上面第 11 次断言红）');

    // 4) 冷却文案不泄露账号存在性（不能说"这个号存在"）
    assert.ok(
      !/不存在|没有这个|未注册/.test(r11.body),
      `冷却文案泄露了账号存在性：${r11.body}`,
    );
    ok('登录集成：冷却文案不泄露账号存在性');

    // 5) 不存在的号也计数（否则"号不存在"本身就是免费探测口）
    const ghost = 'XYZ70002';
    for (let i = 1; i <= 10; i += 1) {
      const r = await app.inject({
        method: 'POST',
        url: '/auth/login/xyz',
        headers: { host: '127.0.0.1:8787' },
        payload: { xyz: ghost, password: 'whatever' },
      });
      assert.equal(r.statusCode, 401, `不存在的号第 ${i} 次应 401，实际 ${r.statusCode}`);
    }
    const rg = await app.inject({
      method: 'POST',
      url: '/auth/login/xyz',
      headers: { host: '127.0.0.1:8787' },
      payload: { xyz: ghost, password: 'whatever' },
    });
    assert.equal(rg.statusCode, 429, `不存在的号第 11 次也应 429，实际 ${rg.statusCode}`);
    ok('登录集成：号不存在也计数（堵住免费探测口）');

    await pool.query('DELETE FROM users WHERE xyz_id = $1', [xyz]);
  }

  // =====================================================================
  // ③'' env 阈值真的接到了限流器上（否则「可配置」是假的）
  //
  // 第二版把 maxFails/cooldownMs 从写死改成读 env。要证明这不是摆设：
  // 把 LOGIN_MAX_FAILS 设成 3，第 4 次就必须 429 —— 不是第 11 次。
  // =====================================================================
  {
    const prev = process.env.LOGIN_MAX_FAILS;
    process.env.LOGIN_MAX_FAILS = '3';
    try {
      const env2 = loadEnv();
      assert.equal(env2.loginMaxFails, 3, `env 应解析出 loginMaxFails=3，实际 ${env2.loginMaxFails}`);
      ok('env：LOGIN_MAX_FAILS=3 被解析进 env.loginMaxFails');

      // 边界：配成 0 / 负数 / 天文数字都不能生效成那个值（会回退默认 10）
      for (const bad of ['0', '-5', 'abc', '99999']) {
        process.env.LOGIN_MAX_FAILS = bad;
        const v = loadEnv().loginMaxFails;
        assert.ok(v >= 1 && v <= 100, `LOGIN_MAX_FAILS=${bad} 应被夹在 1~100，实际 ${v}`);
      }
      ok('env：LOGIN_MAX_FAILS 配 0/负数/非数字/超大都被夹住，不会变成「不锁」');

      // 真打：第 4 次必须 429（证明阈值真的传到了路由里的限流器）
      const pool2 = makePool('pglite://memory');
      await migrate(pool2);
      process.env.LOGIN_MAX_FAILS = '3';
      const env4 = loadEnv();
      const app2 = await buildApp(env4, pool2, makeCipher(env4.dataKey));
      await app2.ready();
      const xyz2 = 'XYZ70003';
      await pool2.query('INSERT INTO users (xyz_id, password_hash) VALUES ($1, $2)', [
        xyz2,
        hashPassword('correct-horse-battery'),
      ]);
      const hit = () =>
        app2.inject({
          method: 'POST',
          url: '/auth/login/xyz',
          headers: { host: '127.0.0.1:8787' },
          payload: { xyz: xyz2, password: 'wrong' },
        });
      for (let i = 1; i <= 3; i += 1) {
        const r = await hit();
        assert.equal(r.statusCode, 401, `第 ${i} 次应 401，实际 ${r.statusCode}`);
      }
      const r4 = await hit();
      assert.equal(r4.statusCode, 429, `LOGIN_MAX_FAILS=3 时第 4 次应 429，实际 ${r4.statusCode}`);
      ok('登录集成：LOGIN_MAX_FAILS=3 真的生效（第 4 次就 429，不是第 11 次）');
      await app2.close();
      await pool2.end();
    } finally {
      if (prev === undefined) delete process.env.LOGIN_MAX_FAILS;
      else process.env.LOGIN_MAX_FAILS = prev;
    }
  }

  // =====================================================================
  // ④ ★ 反证（falsification）：把闸拆掉，上面这些必须变红
  // =====================================================================
  {
    // 这条是"脚本自己在证明自己有效"的锚点：
    //   有人把 index.ts 的 CORS 改回 `origin: true` → ①-1 红
    //   有人删掉 onRequest 里的 LOOPBACK_HOSTS 判断 → ②-1 红
    //   有人把 login/xyz 的 cooling() 判断删掉 → ③ 的计数成了摆设（集成层无闸）
    //   有人把 `cb(null, false)` 改成 `cb(new Error(...), false)` → ①-4 红（500）
    console.log('  （反证口径见本文件头注释：拆任一闸 → 对应断言红）');
  }

  await app.close();
  await pool.end();

  console.log(`\n=== 结论：${pass} PASS / 0 FAIL ===`);
  console.log('  ① CORS 白名单（外来拒 / 安装包 null 放行 / dev 放行 / 无 Origin 放行）');
  console.log('  ② Host 回环校验（非回环 421 / 回环任意端口放行 / 无 Host 放行）');
  console.log('  ③ 登录失败计数与冷却（累计 / 进冷却 / 不无限续期 / 过期恢复 / 成功清零 / 按号隔离）');
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
