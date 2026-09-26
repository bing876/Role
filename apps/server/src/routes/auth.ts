/**
 * 第 5 步（重做版）的账号接口面。没有邮箱登录、没有 /chat/stream、没有大模型：
 *
 *   POST /auth/sms/send        {phone} → 6 位验证码，5 分钟有效，60 秒防连发；
 *                              开发模式（SMS_MOCK/非 production）把码**只写进服务器日志**，
 *                              响应体里绝不带码；生产没配通道 → 拒绝并说人话。
 *   POST /auth/login/sms       {phone, code} → 验证码登录；未注册手机号自动建号并分配 XYZ 号
 *                              （默认项目 + Agent「小助」同事务创建）。一手机一用户。
 *   POST /auth/login/xyz       {xyz, password} → XYZ号+密码登录；**没设过密码则明确失败**
 *                              （回 code=password_not_set，不是含糊的“密码错误”）。
 *   POST /auth/password/set    （要 JWT）→ 登录后才能设置/修改密码；密码≥8 位，只存 scrypt 哈希。
 *   GET  /auth/me              （要 JWT）→ {user{xyz_id…}, project, agents}
 *   GET  /auth/wechat/status   → {enabled:false}（本步只预留）
 *   POST /auth/wechat/login    → 501 wechat_not_enabled，**不发 JWT**（本步禁真微信）
 *
 * 明文/验证码一律不落库、不打日志；库里短信码只存 sha256(salt$code)，手机号存 HMAC 哈希 + AES 密文。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type {
  AgentSummary,
  AuthProfile,
  AuthSession,
  AuthUser,
  ProjectSummary,
} from '@ai-workbench/shared';
import type { ServerEnv } from '../env';
import type { JsonCipher } from '../crypto';
import {
  bearerFrom,
  hashPassword,
  hashCode,
  makeCodeSalt,
  maskPhone,
  phoneHash,
  randomSixDigits,
  signToken,
  verifyCode,
  verifyPassword,
  verifyToken,
} from '../crypto';
import { isDbUnreachable, isUniqueViolation, withTx } from '../db';
import { allocateXyz, normalizeXyz } from '../xyz';
import { currentProjectId, loadOwnedProject, toProjectSummary } from '../projectScope';
import { XIAOZHU_PERSONA } from '../coordinatorPersona';

export interface AuthDeps {
  pool: Pool;
  env: ServerEnv;
  cipher: JsonCipher;
}

const PHONE_RE = /^1[3-9]\d{9}$/; // 大陆 11 位手机号
const SEND_COOLDOWN_SECONDS = 60; // 同号码 60 秒内不能连发
const PHONE_HOURLY_CAP = 10; // 同号码 1 小时最多 10 条（简单限流）
const CODE_TTL_SQL = "now() + interval '5 minutes'";
const VERIFY_MAX_ATTEMPTS = 5;
const PASSWORD_MIN = 8;

/**
 * 进程内按 IP 的粗限流：每 IP 每分钟最多 20 次发码请求（防脚本乱扫；有网关时可换掉）。
 *
 * ★ 这里有两个曾经的坑，改之前先读懂（都是真实缺陷，不是理论问题）：
 *
 * ① **清理检查放错了位置**：原来的 `if (ipHits.size > 5000) ipHits.clear()` 写在
 *    "同一 IP 同窗口第 2 次及以后"的分支里。于是**每个 IP 只来一次**的扫描
 *    （最典型的分布式扫描）永远不会触发清理 —— 表可以无限涨。
 *
 * ② **`clear()` 会把正在生效的限流一起放掉**：清空整张表 = 所有 IP 的计数归零。
 *    攻击者只要把表撑到 5000，就能让**自己那个已被限流的计数**一起消失，
 *    下一轮又是干净的 20 次 —— 限流被"自己人"清掉了。这是**绕过**，不只是内存问题。
 *
 * 现在的口径：**永远不整表清空**；超上限时先淘汰"窗口已过期"的条目（本来就没用了），
 * 仍然超就只淘汰**最旧的少量**条目把内存兜住 —— 淘汰按条做，不会把别人的计数归零。
 *
 * 做成工厂 + 可注入时钟/阈值，是为了能**确定性地测**这两条：
 * 拿真实时间跑一分钟、或者真造 5000 个 IP 都不现实（而且测不出"过期淘汰"）。
 */
export interface IpRateLimiter {
  /** true = 这个 IP 在本窗口内已经超限 */
  limited(ip: string): boolean;
  /** 诊断/断言用：当前表大小 */
  size(): number;
  /** 诊断/断言用：某个 IP 在当前窗口的计数（没有则 null） */
  countOf(ip: string): number | null;
}

export function makeIpRateLimiter(
  opts: { maxPerMinute?: number; softCap?: number; windowMs?: number; now?: () => number } = {},
): IpRateLimiter {
  const maxPerMinute = opts.maxPerMinute ?? 20;
  /**
   * 软上限取 50000（≈ 每条 60 字节 → 3MB 量级）。
   *
   * 为什么给这么大：淘汰是**有代价**的 —— 淘汰一条正在生效的限流记录就等于放它一马。
   * 与其把上限压得很低、频繁淘汰，不如让它足够宽，正常情况下根本走不到淘汰那一步。
   */
  const softCap = opts.softCap ?? 50_000;
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const hits = new Map<string, { windowStart: number; count: number }>();

  return {
    limited(ip: string): boolean {
      const nowMinute = Math.floor(now() / windowMs);

      // 先做容量维护（放在最前面：与"这个 IP 是不是第一次来"无关 —— 这正是原来的坑①）
      if (hits.size > softCap) {
        // ① 过期的先清 —— 计数已经作废，删掉不损失任何保护力
        for (const [key, val] of hits) {
          if (val.windowStart !== nowMinute) hits.delete(key);
        }
        /**
         * ② 还超：淘汰「**还没超限的**」条目，从最旧的开始。
         *
         * ★ 这一条是"不能整表 clear()"的完整版 —— 光"不 clear"还不够：
         *   如果按最旧无差别淘汰，一个**已经被限流的 IP**（它往往是第一个来的，
         *   也就是"最旧"的那条）会在表满时被优先踢掉，计数归零 → 下一轮又是干净的 20 次。
         *   所以淘汰必须**避开正在承担保护职责的那些条目**（count > maxPerMinute）。
         */
        if (hits.size > softCap) {
          let toDrop = hits.size - softCap;
          for (const [key, val] of hits) {
            if (toDrop <= 0) break;
            if (val.count <= maxPerMinute) {
              hits.delete(key);
              toDrop -= 1;
            }
          }
        }
        /**
         * ③ 极端兜底：连"没超限的"都淘汰光了还超 —— 只能按最旧淘汰。
         *    走到这里意味着**同一分钟内有 softCap 个以上 IP 各自都超了限**
         *    （默认 50000 × 20 = 100 万+ 请求/分钟），此时进程内限流器本身已到极限，
         *    真实部署应该在网关层拦。这里只保证内存不无限涨。
         */
        if (hits.size > softCap) {
          let toDrop = hits.size - softCap;
          for (const key of hits.keys()) {
            if (toDrop <= 0) break;
            hits.delete(key);
          }
        }
      }

      const hit = hits.get(ip);
      if (!hit || hit.windowStart !== nowMinute) {
        hits.set(ip, { windowStart: nowMinute, count: 1 });
        return false;
      }
      hit.count += 1;
      return hit.count > maxPerMinute;
    },
    size: () => hits.size,
    countOf: (ip: string) => hits.get(ip)?.count ?? null,
  };
}

/** 线上用的那一个实例（路由只认它） */
const ipLimiter = makeIpRateLimiter();
function ipRateLimited(ip: string): boolean {
  return ipLimiter.limited(ip);
}

function dbError(reply: FastifyReply, err: unknown): FastifyReply {
  if (isDbUnreachable(err)) {
    return reply.code(503).send({
      error: '数据库连不上：先跑 docker compose -f apps/server/docker-compose.yml up -d（或 npm run db:up）',
    });
  }
  const msg = (err as Error)?.message ?? String(err);
  console.error('[auth] 未分类错误：', msg); // 只打 message——里面绝不含密码/验证码
  return reply.code(500).send({ error: `服务端错误：${msg}` });
}

function claimsFrom(req: FastifyRequest, env: ServerEnv) {
  const token = bearerFrom(req.headers.authorization);
  return token ? verifyToken(token, env.jwtSecret) : null;
}

async function loadUser(pool: Pool, where: 'id' | 'xyz_id' | 'phone_hash', value: string | number) {
  const r = await pool.query<{
    id: string;
    xyz_id: string;
    phone_hash: string | null;
    phone_enc: string | null;
    password_hash: string | null;
  }>(`SELECT id, xyz_id, phone_hash, phone_enc, password_hash FROM users WHERE ${where} = $1`, [value]);
  return r.rowCount === 1 ? r.rows[0] : null;
}

async function buildSession(pool: Pool, env: ServerEnv, cipher: JsonCipher, userId: string): Promise<AuthSession> {
  // 子阶段 2-A：登录/建号回的是**当前使用中的项目**（没有就回落默认项目）。
  const curId = await currentProjectId(pool, Number(userId));
  const p = curId === null ? null : await loadOwnedProject(pool, Number(userId), curId);
  if (!p) throw new Error('账号数据不完整（没有项目）');
  const a = await pool.query<{ id: string; name: string }>(
    'SELECT id, name FROM agents WHERE project_id = $1 ORDER BY id ASC LIMIT 8',
    [p.id],
  );
  const user = await loadUser(pool, 'id', userId);
  if (!user) throw new Error('账号已不存在');
  const session: AuthSession = {
    token: signToken({ sub: Number(user.id), xyz: user.xyz_id }, env.jwtSecret),
    user: {
      id: Number(user.id),
      xyz_id: user.xyz_id,
      has_password: Boolean(user.password_hash),
      phone_masked: user.phone_enc ? maskPhone(cipher.decryptText(user.phone_enc)) : null,
    },
    project: toProjectSummary(p, curId) satisfies ProjectSummary,
    agents: a.rows.map((r) => ({ id: Number(r.id), name: r.name }) satisfies AgentSummary),
  };
  return session;
}

export function registerAuthRoutes(app: FastifyInstance, { pool, env, cipher }: AuthDeps): void {
  // ---------------------------------------------------------------- 短信
  app.post('/auth/sms/send', async (req: FastifyRequest, reply) => {
    const body = req.body as { phone?: unknown } | null;
    const phone = typeof body?.phone === 'string' ? body.phone.trim() : '';
    if (ipRateLimited(req.ip)) {
      // 放在格式校验之前：拿坏号码刷接口同样吃限流
      return reply.code(429).send({ error: '这个 IP 发码太频繁，歇一分钟再来' });
    }
    if (!PHONE_RE.test(phone)) {
      return reply.code(400).send({ error: '需要大陆 11 位手机号（1[3-9] 开头）' });
    }
    if (!env.smsMock && env.isProduction && !env.smsHttpUrl) {
      // 生产没配短信通道：不装死，给人话
      return reply.code(503).send({
        error: '短信通道没配置：开发调试请设 SMS_MOCK=1（验证码进服务器日志），生产请在 .env 配 SMS_HTTP_URL',
      });
    }
    const hash = phoneHash(phone, env.phonePepper);
    try {
      const last = await pool.query<{ age_seconds: string | null }>(
        'SELECT EXTRACT(EPOCH FROM (now() - created_at)) AS age_seconds FROM sms_codes WHERE phone_hash = $1 ORDER BY created_at DESC LIMIT 1',
        [hash],
      );
      const age = last.rowCount === 1 ? Number(last.rows[0].age_seconds ?? 1e9) : 1e9;
      if (age < SEND_COOLDOWN_SECONDS) {
        return reply.code(429).send({
          error: `发送太频繁，请 ${Math.ceil(SEND_COOLDOWN_SECONDS - age)} 秒后重试`,
        });
      }
      const recent = await pool.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM sms_codes WHERE phone_hash = $1 AND created_at > now() - interval '1 hour'",
        [hash],
      );
      if (Number(recent.rows[0]?.n ?? 0) >= PHONE_HOURLY_CAP) {
        return reply.code(429).send({ error: '该手机号 1 小时内验证码条数已达上限，请稍后再试' });
      }

      const code = randomSixDigits();
      const salt = makeCodeSalt();
      // created_at 这一列在 sms_codes 上是 NOT NULL 且**没有 DEFAULT**
      // （其它表都有 DEFAULT now()，这张表漏了），所以必须由写入方显式给值，
      // 否则会撞 "null value in column \"created_at\" violates not-null constraint"。
      await pool.query(
        `INSERT INTO sms_codes (phone_hash, code_hash, salt, expires_at, created_at) VALUES ($1, $2, $3, ${CODE_TTL_SQL}, now())`,
        [hash, hashCode(code, salt), salt],
      );

      if (env.smsMock) {
        // 开发模式：码只进服务器日志；响应体里没有 code 字段
        console.log(`[sms:mock] → ${maskPhone(phone)} 验证码 ${code}（5 分钟内有效；仅开发模式打印）`);
        // ★ stdout 在**非 TTY**（被重定向到文件、或被别的进程接管）时是**块缓冲**的：
        //   只 console.log 的话，这行要攒够一批（约 8KB）才落盘。
        //   自动化脚本「发完立刻读日志」就会读不到验证码，看起来像「短信没发出去」，
        //   其实请求早已成功 —— 这次排查就栽在这上面，白绕了一大圈。
        //   显式冲一次，把「日志里立刻能读到」变成确定性行为。
        if (typeof (process.stdout as { flush?: () => void }).flush === 'function') {
          (process.stdout as unknown as { flush: () => void }).flush();
        }
      } else {
        // 通用 HTTP 短信网关：POST {phone, code}。失败如实报错，不回退成“假装发了”
        try {
          const r = await fetch(env.smsHttpUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ phone, code }),
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
        } catch (err) {
          return reply.code(502).send({ error: `短信通道发送失败：${(err as Error).message}；验证码已作废，请稍后重试` });
        }
      }
      return { sent: true, expires_in: 300, ...(env.smsMock ? { mock_code: code } : {}) };
    } catch (err) {
      return dbError(reply, err);
    }
  });

  // ------------------------------------------------- 登录 A：手机号+验证码（未注册自动建号）
  app.post('/auth/login/sms', async (req: FastifyRequest, reply) => {
    const body = req.body as { phone?: unknown; code?: unknown } | null;
    const phone = typeof body?.phone === 'string' ? body.phone.trim() : '';
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!PHONE_RE.test(phone)) return reply.code(400).send({ error: '手机号格式不对（大陆 11 位）' });
    if (!/^\d{6}$/.test(code)) return reply.code(400).send({ error: '验证码是 6 位数字' });

    const hash = phoneHash(phone, env.phonePepper);
    try {
      // 1) 校验码：只认最新一条未用、未过期、尝试次数没超的
      const c = await pool.query<{ id: string; code_hash: string; salt: string }>(
        `SELECT id, code_hash, salt FROM sms_codes
          WHERE phone_hash = $1 AND used = false AND attempts < $2 AND expires_at > now()
          ORDER BY created_at DESC LIMIT 1`,
        [hash, VERIFY_MAX_ATTEMPTS],
      );
      if (c.rowCount !== 1 || !verifyCode(code, c.rows[0].salt, c.rows[0].code_hash)) {
        if (c.rowCount === 1) {
          /**
           * 计错次数也要**带上同样的条件**（不是裸 `WHERE id = $1`）：
           * 否则并发下会给一条"已经被消费掉"的行继续加计数，
           * 虽然无害，但会让 attempts 的含义变得不可解释（它本该只统计"还没用掉时的猜错"）。
           */
          await pool.query(
            `UPDATE sms_codes SET attempts = attempts + 1
              WHERE id = $1 AND used = false AND attempts < $2 AND expires_at > now()`,
            [c.rows[0].id, VERIFY_MAX_ATTEMPTS],
          );
        }
        return reply.code(401).send({ error: '验证码不对或已失效（错 5 次作废，可重新获取）' });
      }

      /**
       * ★★ 消费验证码必须是**一条原子 UPDATE**，不能"先 SELECT 判 used 再 UPDATE"。
       *
       * 原来的写法是 `UPDATE sms_codes SET used = true WHERE id = $1` ——
       * 两个并发请求会**双双通过**上面那句 SELECT（都读到 `used = false`），
       * 然后各自把 `used` 置为 true 并各自发一份 token：**一个验证码被消费两次**。
       * 6 位码 + 5 分钟有效期，被重放一次就是多一个会话，这是实打实的越权面。
       *
       * 现在把"是否还能用"和"标记已用"**压进同一条语句的 WHERE 里**，
       * 由数据库的行锁保证只有一个请求能把它从 false 翻成 true：
       *   - `rowCount === 1` → 是我抢到的，继续发 token；
       *   - `rowCount === 0` → 别人已经消费掉（或刚好过期/超次数），**当失败处理**，
       *     绝不能继续往下发 token。
       *
       * 判据必须看 **`rowCount`**，不能看"语句有没有报错" —— 抢输的那次不会报错，只是影响 0 行。
       */
      const consumed = await pool.query(
        `UPDATE sms_codes SET used = true
          WHERE id = $1 AND used = false AND attempts < $2 AND expires_at > now()
          RETURNING id`,
        [c.rows[0].id, VERIFY_MAX_ATTEMPTS],
      );
      if (consumed.rowCount !== 1) {
        return reply.code(401).send({ error: '验证码不对或已失效（错 5 次作废，可重新获取）' });
      }

      // 2) 老用户直接进；新用户建号（分配 XYZ + 默认项目 + 小助），一个事务
      const existing = await loadUser(pool, 'phone_hash', hash);
      if (existing) return await buildSession(pool, env, cipher, existing.id);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          const created = await withTx(pool, async (client) => {
            const xyz = await allocateXyz(async (sql, params) => client.query(sql, params));
            const u = await client.query<{ id: string }>(
              'INSERT INTO users (xyz_id, phone_hash, phone_enc) VALUES ($1, $2, $3) RETURNING id',
              [xyz, hash, cipher.encryptText(phone)],
            );
            const p = await client.query<{ id: string; name: string }>(
              "INSERT INTO projects (user_id, name, is_default) VALUES ($1, '默认项目', true) RETURNING id, name",
              [u.rows[0].id],
            );
            const a = await client.query<{ id: string; name: string }>(
              // 子阶段 2-A：自带「小助」必须有「建智能体」的权限，否则新账号一点「＋ 添加」就 403。
              // 这个开关**必须在这里显式写 true**：列的默认值是 false（那是给「用户自建的普通智能体」的），
              // 而启动时那次不变量回填只在服务重启时跑 —— 光靠它，**服务运行期间新注册的账号**
              // 会拿到一只没有权限的小助（本轮真机验收就是这么抓到的）。
              // G2（2026-09-25）：小助建号即带默认身份（用户给的「小助配置」整份人设 + 不干什么），
              // 左栏/人设接口读回的就是这份；persona_status=ready，不挡聊天。
              "INSERT INTO agents (project_id, name, kind, persona, persona_status, can_create_agents) VALUES ($1, '小助', 'assistant', $2, 'ready', true) RETURNING id, name",
              [p.rows[0].id, JSON.stringify(XIAOZHU_PERSONA)],
            );
            return { userId: u.rows[0].id, createdProject: p.rows[0], createdAgent: a.rows[0] };
          });
          // G1-⑤（2026-09-25）：首进空项目（signup 默认项目,此时只有小助）→ **小助主动提议搭团队**
          // （写进小助主会话流,用户首次打开就能看到）。失败只告警,绝不挡建号/登录。
          try {
            const { seedColleagueProposal } = await import('../orchestrator/agentBuilder');
            await seedColleagueProposal(
              pool,
              cipher,
              Number(created.userId),
              Number(created.createdProject.id),
              String(created.createdProject.name ?? '默认项目'),
              Number(created.createdAgent.id),
            );
          } catch (e) {
            console.warn('[auth] 首进空项目提议搭团队失败（忽略）：', (e as Error).message);
          }
          return await buildSession(pool, env, cipher, created.userId);
        } catch (err) {
          if (isUniqueViolation(err)) {
            // 可能是并发同手机号（phone_hash 撞了）→ 重查一次直接登进去
            const again = await loadUser(pool, 'phone_hash', hash);
            if (again) return await buildSession(pool, env, cipher, again.id);
            continue; // 或 XYZ 撞号 → 重新分配再试
          }
          throw err;
        }
      }
      return reply.code(500).send({ error: '建号失败（XYZ 号碰撞过多），请重试' });
    } catch (err) {
      return dbError(reply, err);
    }
  });

  // ------------------------------------------------- 登录 B：XYZ号+密码（没设密码→明确失败）
  app.post('/auth/login/xyz', async (req: FastifyRequest, reply) => {
    const body = req.body as { xyz?: unknown; password?: unknown } | null;
    const xyz = normalizeXyz(typeof body?.xyz === 'string' ? body.xyz : '');
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!xyz) return reply.code(400).send({ error: 'XYZ 号格式不对：XYZ 后跟 5~7 位数字（也支持只输数字）' });
    if (!password) return reply.code(400).send({ error: '需要密码' });
    try {
      const user = await loadUser(pool, 'xyz_id', xyz);
      if (!user) return reply.code(401).send({ error: 'XYZ 号或密码不对' });
      if (!user.password_hash) {
        // 说明书要求：未设密码要**明确失败**，并说清下一步怎么走
        return reply.code(400).send({
          code: 'password_not_set',
          error: '该账号还没设置过密码：先用手机号验证码登录，再到左栏「设置密码」设一个（≥8 位）',
        });
      }
      if (!verifyPassword(password, user.password_hash)) {
        return reply.code(401).send({ error: 'XYZ 号或密码不对' }); // 与“用户不存在”同文案，不泄露存在性
      }
      return await buildSession(pool, env, cipher, user.id);
    } catch (err) {
      return dbError(reply, err);
    }
  });

  // ------------------------------------------------- 设置/修改密码（必须已登录）
  app.post('/auth/password/set', async (req: FastifyRequest, reply) => {
    const claims = claimsFrom(req, env);
    if (!claims) return reply.code(401).send({ error: '未登录或登录已过期：设置/修改密码需要先登录' });
    const body = req.body as { new_password?: unknown; old_password?: unknown } | null;
    const next = typeof body?.new_password === 'string' ? body.new_password : '';
    const prev = typeof body?.old_password === 'string' ? body.old_password : '';
    if (next.length < PASSWORD_MIN || next.length > 72) {
      return reply.code(400).send({ error: `新密码长度需在 ${PASSWORD_MIN}~72 位之间` });
    }
    try {
      const user = await loadUser(pool, 'id', claims.sub);
      if (!user) return reply.code(401).send({ error: '账号已不存在' });
      if (user.password_hash && !verifyPassword(prev, user.password_hash)) {
        return reply.code(403).send({ error: '原密码不对，未做任何修改' });
      }
      await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [claims.sub, hashPassword(next)]);
      return { ok: true, message: '密码已更新（服务端只存 scrypt 哈希）' };
    } catch (err) {
      return dbError(reply, err);
    }
  });

  // ------------------------------------------------- 我是谁（要 JWT）
  app.get('/auth/me', async (req: FastifyRequest, reply) => {
    const claims = claimsFrom(req, env);
    if (!claims) return reply.code(401).send({ error: '未登录或登录已过期（需要 Authorization: Bearer <token>）' });
    try {
      const user = await loadUser(pool, 'id', claims.sub);
      if (!user) return reply.code(401).send({ error: '账号已不存在' });
      // 子阶段 2-A：回**当前使用中的项目**（没有就回落默认项目）
      const curId = await currentProjectId(pool, Number(user.id));
      const p = curId === null ? null : await loadOwnedProject(pool, Number(user.id), curId);
      const a = p
        ? await pool.query<{ id: string; name: string }>(
            'SELECT id, name FROM agents WHERE project_id = $1 ORDER BY id ASC LIMIT 8',
            [p.id],
          )
        : { rows: [] };
      const profile: AuthProfile = {
        user: {
          id: Number(user.id),
          xyz_id: user.xyz_id,
          has_password: Boolean(user.password_hash),
          phone_masked: user.phone_enc ? maskPhone(cipher.decryptText(user.phone_enc)) : null,
        } satisfies AuthUser,
        project: p ? toProjectSummary(p, curId) : { id: 0, name: '（无项目）' },
        agents: a.rows.map((r) => ({ id: Number(r.id), name: r.name })),
      };
      return profile;
    } catch (err) {
      return dbError(reply, err);
    }
  });

  // ------------------------------------------------- 微信：本步只预留占位，绝不发 JWT
  app.get('/auth/wechat/status', async () => ({ enabled: false }));

  app.post('/auth/wechat/login', async (_req: FastifyRequest, reply) => {
    return reply.code(501).send({
      code: 'wechat_not_enabled',
      error: '微信登录「即将开通」：本步只预留了 wechat_openid / wechat_unionid 字段，未接入真实微信，不发放任何 token',
    });
  });
}
