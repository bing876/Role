"""在同一进程内：起 PG → 等库就绪 → 查账号的项目/智能体归属。

★ 为什么必须同一个进程：本机 agent 工具调用结束会回收派生的子进程，
  PG 活不过一次调用（调用内 5432 在监听，下一个调用就没了）。

★ 表结构要点（踩过）：
  - projects 没有 is_current，只有 is_default；「当前项目」存在 **users.current_project_id**
  - agents 没有 user_id，靠 project_id 关联
  - users 的手机号是 phone_hash / phone_enc（加密），不是明文 phone
  - currentProjectId() 的回落顺序：users.current_project_id → is_default → id 最小 → null
    ⇒ 只有「这个账号一个项目都没有」时才会返回 null

跑法：python scripts/verify/db-scope-probe.py
"""
import os
import socket
import subprocess
import sys
import time

ROOT = r"C:\Users\bing\workbuddy-ai\work123"
PG_BIN = r"C:\Users\bing\workbuddy-ai\pg2\pg\bin"
PG_DATA = r"C:\Users\bing\workbuddy-ai\pg2\data"
NODE = r"C:\Users\bing\.workbuddy-ai\binaries\node\versions\22.22.2-2\node.exe"


def port_up(port=5432, host="127.0.0.1", t=1.5):
    s = socket.socket()
    s.settimeout(t)
    try:
        s.connect((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def node(script):
    r = subprocess.run([NODE, "-e", script], cwd=ROOT, capture_output=True,
                       text=True, encoding="utf-8", errors="replace")
    return (r.stdout or "") + (r.stderr or "")


if not port_up():
    subprocess.Popen([os.path.join(PG_BIN, "postgres.exe"), "-D", PG_DATA],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        if port_up():
            break
        time.sleep(0.8)
print("5432:", port_up())

READY = (
    "const {Client}=require('pg');(async()=>{"
    "const c=new Client({host:'127.0.0.1',port:5432,user:'workbench',database:'postgres'});"
    "await c.connect();await c.query('SELECT 1');await c.end();console.log('READY');})()"
    ".catch(e=>console.log('WAIT'));"
)
for i in range(60):
    if "READY" in node(READY):
        print(f"库可查询（第 {i + 1} 次尝试）")
        break
    time.sleep(1)
else:
    print("★ 库一直不可用")
    sys.exit(1)

QUERY = r"""
const {Client}=require('pg');
(async()=>{
const c=new Client({connectionString:'postgresql://workbench:workbench@127.0.0.1:5432/workbench'});
await c.connect();
const u=await c.query('SELECT id, xyz_id, current_project_id FROM users ORDER BY id');
const p=await c.query('SELECT id, user_id, name, is_default FROM projects ORDER BY user_id, id');
const a=await c.query('SELECT id, project_id, name, kind FROM agents ORDER BY project_id, id');
console.log('=== users ('+u.rowCount+') ===');
u.rows.forEach(r=>console.log('  #'+r.id+' '+r.xyz_id+' current_project_id='+r.current_project_id));
console.log('=== projects ('+p.rowCount+') ===');
p.rows.forEach(r=>console.log('  #'+r.id+' user='+r.user_id+' '+r.name+' is_default='+r.is_default));
console.log('=== agents ('+a.rowCount+') ===');
a.rows.forEach(r=>console.log('  #'+r.id+' project='+r.project_id+' '+r.name+' kind='+r.kind));
console.log('');
console.log('=== 逐账号判定（复刻 currentProjectId 的回落链）===');
u.rows.forEach(uu=>{
  const mine=p.rows.filter(x=>x.user_id===uu.id);
  const byCurrent=mine.find(x=>x.id===uu.current_project_id);
  const byDefault=[...mine].sort((x,y)=>(y.is_default?1:0)-(x.is_default?1:0)||x.id-y.id)[0];
  const resolved=byCurrent||byDefault||null;
  const ag=resolved?a.rows.filter(x=>x.project_id===resolved.id):[];
  console.log('  账号 #'+uu.id+' '+uu.xyz_id+': 项目'+mine.length+' 个');
  console.log('    users.current_project_id='+uu.current_project_id
    +' → 解析结果='+(resolved?resolved.id+' ('+resolved.name+')':'null'));
  console.log('    该项目智能体数='+ag.length);
  if(!resolved) console.log('    ★ 解析为 null → 桌面端绑不到当前智能体 → sendChat 静默 return');
  else if(ag.length===0) console.log('    ★ 有项目但没智能体 → 同样绑不到');
  else console.log('    ✓ 正常（能绑到智能体）');
});
await c.end();})().catch(e=>{console.log('ERR '+e.message);process.exit(1)});
"""
print(node(QUERY))
