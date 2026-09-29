# 一次性探针 / 小工具（已从 `scripts/verify/` 搬出）

这里放的是 **2026-09-29 清点「孤儿脚本」时搬过来的 13 个文件**，共 86 KB。

## 判定标准

搬来的条件很严：**全仓零引用** —— 不只 `package.json` 里没有，
任何代码文件里没有，**连文档/注释里都没提到过**。全仓扫了 `.mts .mjs .cjs .ts
.tsx .js .py .json .md .yml .yaml .sh` 十种后缀、631 个文件，逐个比对文件名。

当时 `scripts/verify/` 下另有约 108 个「代码里没人调、但文档里有记载」的
历史探针（`browser-idle-*-probe.py`、`ui15-*.py`、`installed-app-*.py` …）。
那些**没搬** —— 文档提到过，说明有人用过并留了结论，属于有据可查的历史；
而这里这 13 个连提都没人提过。

## 为什么不直接删

因为「判定没人用」这件事**已经出过一次事故**：同一轮里我把
`loop-kill9-worker.mts` / `board-lock-worker.mts` 判成死文件删了，
结果全链当场红 —— 它们的启动者是 `.mjs` 后缀的文件（`loop-kill9-db.mjs`），
而当时的守卫没扫那个后缀，路径还是 `path.join` 拼出来的，按文件名 grep 搜不到。

所以：**搬，不删。** 全部可回滚，一行都没丢。

## 清单

| 文件 | 字节 | 是什么 |
|---|---|---|
| `_cleanup.py` | 8217 | 收尾清理（名字带下划线，按惯例是一次性脚本） |
| `_watchdog-check.py` | 3430 | 看门狗自检 |
| `e2e-race-probe.py` | 6913 | 竞态探针 |
| `e2e-send-probe.py` | 8020 | 发送链路探针 |
| `iframe-click-http.mjs` | 10218 | iframe 内 http 点击探针 |
| `login-probe.mjs` | 3299 | 登录探针 |
| `multi-agent-parallel-tests.py` | 12728 | 多智能体并行测试 |
| `pg-bringup.mjs` | 4258 | PostgreSQL 拉起 |
| `react-input-probe.py` | 8376 | React 输入框探针 |
| `send-gate-probe.py` | 9557 | 发送闸门探针 |
| `setup-local-pg.mjs` | 4567 | 本地 PG 初始化 |
| `show-sms-code.cjs` | 2337 | 显示短信验证码（本地调试用） |
| `wbctl.py` | 4105 | workbench 控制脚本 |

## 想恢复某个脚本

```bash
git mv scripts/archive/one-off-probes/<文件名> scripts/verify/<文件名>
```

搬回去之后**必须给它一个归属**，否则 `verify:no-orphans` 会红 ——
这正是想要的效果：恢复可以，但不能再悄悄堆着没人管。

## 守卫盯着这里

`scripts/verify/no-orphan-scripts.mts` 里钉了这个目录的文件数（13）。
只许降不许涨：往这儿倒文件来绕过「必须有归属」的检查，会直接被抓住。
