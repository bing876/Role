# QA-27 审计报告 —— `payload.steps` 全仓明文路径清查

**日期**:2026-09-25(北京时间)
**用户拍板**:"桌面 `type` 动作的 label() 已改成不带原文,但全仓 grep `payload.steps` 确认没有别的明文路径,有就补脱敏。"

## 审计结论:除已知闸外,**没有**其他明文写入路径

`tasks` 表 payload 列全仓写点 = **5 处**(人工 grep + 脚本钉死,`scripts/verify/payload-steps-audit.mjs`):

| # | 位置 | 写什么 | 是否安全 |
|---|---|---|---|
| A1 | `routes/agent.ts` /agent/task/start(INSERT) | `{ steps: [] }` 空数组 | ✓ 无用户文本;goal 只进 `goal_enc` 密文列,title 恒 NULL |
| A2 | `routes/agent.ts` /agent/task/step(UPDATE) | 追加一条 summary | ✓ summary 赋值即过 `scrubStepSummary`(=scrubTaskText 值形态脱敏);动态反例由 `task-encryption-pglite.mts` ⑤-B 六条(卡号/身份证/密码/验证码/CVV/21 位流水号)钉在 verify 链上 |
| A3 | `routes/agent.ts` /agent/task/finish(UPDATE) | spread 既有 payload + doc | ✓ 不新增用户文本字面量;`payload.doc.*` 明文属**已知缺口**(收尾 6 文档,R2"脱敏不加密"既有设计),不在 steps 口径 |
| B1/B2 | `db.ts` 回填(情形 1/2,UPDATE) | 旧行复制 + `delete rest.goal` | ✓ 只搬运既有行、删除明文 goal 键;**旧行里已有的**明文 steps 属"旧明文列暂不 drop、全表回填推迟"的既有拍板 |

另外两条被排除的"疑似路径":

- `routes/agent.ts:203` 的 `body.stepsSummary` → 只发给 LLM(`decideOnce`),**不落库**(transcript 外发属内存缺口 #7 已记范围);
- 桌面端 → 全仓 grep `/agent/task/step`:**没有任何桌面调用方**,服务端脱敏就是唯一闸(agent.ts:148 注释原话),桌面 `type` label 改不带原文后,这条历史路径两端都干净。

## 补了什么

- `scripts/verify/payload-steps-audit.mjs`(新):把上面这张表变成机器可查 —— 写点枚举(5 处,多了就红)、A1 恒空、A2 必须有 scrub 调用、A3 必须 spread、B1/B2 必须 `delete rest.goal`、全仓交叉扫描只允许 {agent.ts, db.ts}。7 检查全过。
- 挂进 `verify:redact` 链(脱敏相关)。

## 反证(`scripts/verify/payload-steps-revert-proof.py`)

变异:摘掉 A2 的 `scrubStepSummary`(summary 直接 `.slice(0,300)` 进库)。

- **静态** audit [A2] 当场红("summary 赋值走了 scrubStepSummary" ✗);
- **动态** pglite ⑤-B 当场红,精确命中:`六条含敏感值的摘要,落进 payload.steps 后一个敏感值都不剩` ✗ —— `steps 里残留敏感值「hunter2secret」`;
- 源码 md5 逐字节还原,还原后 audit + pglite 全绿。

## 已知边界(不在本条口径,文档留痕)

1. `payload.doc.*`(summary/title/hint/markdown 之外的 hint/outline)仍明文 —— 收尾 6 已记录的 R2 设计缺口;
2. 旧行历史明文 steps 的整表回填 —— 用户拍板推迟;
3. transcript/stepsSummary 发往上游模型 —— 内存缺口 #7(沙箱内无法验收)。
