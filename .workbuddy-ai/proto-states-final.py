"""prototype state inventory — FINAL single-pass capture + manifest (v2).

★ v1 的坑：reset_full() 只重置了 .frame 的 className，但 S02/S03 会给 .sidebar
  留下 inline width:0（collapsed），导致从 S05 起所有截图里侧栏都是空的、
  5 张图字节数完全一样。v2 改成**每个状态前整页 reload**，保证干净。

分组：A 列0 轨道 / B 列1 侧栏 / C 列2 主区 / D 弹窗与全屏层
"""
import os, json, time, base64, subprocess, urllib.request, socket, shutil

os.environ['NO_PROXY'] = '127.0.0.1,localhost'
os.environ['no_proxy'] = '127.0.0.1,localhost'
import websocket

PROTO = r"J:\xwechat_files\wxid_yulc5z94mh2i22_84cf\msg\file\2026-09\workbench.work.html"
EXE = r"C:\Users\bing\workbuddy-ai\work123\node_modules\electron\dist\electron.exe"
PORT = 9756
OUTDIR = r"C:\Users\bing\workbuddy-ai\work123\docs\acceptance\protostates"
UDD = r"C:\Users\bing\workbuddy-ai\work123\.workbuddy-ai\udd-final2"

STATES = []


def op():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def wait_port(port, timeout=45):
    t0 = time.time()
    while time.time() - t0 < timeout:
        s = socket.socket(); s.settimeout(0.4)
        try:
            s.connect(('127.0.0.1', port)); s.close(); return True
        except Exception:
            pass
        finally:
            try: s.close()
            except Exception: pass
        time.sleep(0.4)
    return False


shutil.rmtree(UDD, ignore_errors=True)
os.makedirs(OUTDIR, exist_ok=True)
p = subprocess.Popen([EXE, '--no-sandbox', '--force-device-scale-factor=1',
                      '--remote-debugging-port=%d' % PORT, '--user-data-dir=%s' % UDD,
                      PROTO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
print('pid', p.pid)
if not wait_port(PORT):
    print('PORT_NOT_OPEN'); raise SystemExit(2)

tgt = None
for _ in range(40):
    try:
        pages = [i for i in json.loads(op().open('http://127.0.0.1:%d/json/list' % PORT,
                                                timeout=3).read()) if i.get('type') == 'page']
        if pages:
            tgt = pages[0]; break
    except Exception:
        pass
    time.sleep(0.5)

ws = websocket.create_connection(tgt['webSocketDebuggerUrl'], suppress_origin=True,
                                http_proxy_host=None, timeout=60)
mid = [0]


def send(method, **params):
    mid[0] += 1
    m = mid[0]
    ws.send(json.dumps({'id': m, 'method': method, 'params': params}))
    while True:
        r = json.loads(ws.recv())
        if r.get('id') == m:
            return r


def ev(expr):
    r = send('Runtime.evaluate', expression=expr, returnByValue=True, awaitPromise=True)
    res = r.get('result', {})
    if 'exceptionDetails' in res:
        return {'__exc': str(res['exceptionDetails'])[:300]}
    return res.get('result', {}).get('value')


# ★ 原型 demo 把 1400×900 设计稿整体 scale(0.96) 居中放在 .stage 里，
#   直接截出来工作台只有 1344×864 且四周带壁纸 —— 跟铺满窗口的桌面端没法比。
#   每个状态都先还原成 1:1 再截图。
FIX_1TO1 = """
(() => {
  const st = document.querySelector('.stage');
  if (st) { st.style.transform = 'none'; st.style.zoom = '1'; }
  const f = document.querySelector('.frame');
  if (!f) return 'NO_FRAME';
  f.style.position = 'fixed';
  f.style.left = '0px';
  f.style.top = '0px';
  f.style.margin = '0';
  f.style.transformOrigin = '0 0';
  f.style.transform = 'none';
  const r = f.getBoundingClientRect();
  return Math.round(r.width) + 'x' + Math.round(r.height);
})()
"""


def reload(equip=True):
    """Hard reload → 真正干净的状态 → 还原 1:1。"""
    send('Page.reload', ignoreCache=False)
    time.sleep(2.6)
    if equip:
        n = ev("document.querySelectorAll('.contact-item').length") or 0
        if n < 3:
            for nm in ['卡布', '电商小助手'][:3 - int(n)]:
                ev("window.__createAgent({name:%s})" % json.dumps(nm))
                time.sleep(1.3)
    ev(FIX_1TO1)
    time.sleep(0.5)


def shot(sid):
    s = send('Page.captureScreenshot', format='png')
    fp = os.path.join(OUTDIR, sid + '.png')
    open(fp, 'wb').write(base64.b64decode(s['result']['data']))
    return os.path.getsize(fp)


def record(sid, group, title, trigger, note, proof, size):
    print('  %-4s %-24s %7d B  %s' % (sid, title, size, proof))
    STATES.append(dict(id=sid, group=group, title=title, trigger=trigger,
                       file='protostates/%s.png' % sid, bytes=size,
                       proof=proof, note=note))


def cap(sid, group, title, trigger, setup=None, expect=None, note='',
        equip=True, post=None, post_wait=1.6):
    reload(equip)
    if setup:
        ev(setup)
        time.sleep(1.7)
    if post:
        ev(post)
        time.sleep(post_wait)
    proof = ev(expect) if expect else ''
    size = shot(sid)
    record(sid, group, title, trigger, note, proof, size)


send('Page.enable'); send('Runtime.enable')
send('Emulation.setDeviceMetricsOverride', width=1400, height=900,
     deviceScaleFactor=1, mobile=False)
time.sleep(3.5)
reload(True)
print('装备后 contacts =', ev("document.querySelectorAll('.contact-item').length"))

PROOF_FRAME = "document.querySelector('.frame').className"

print('\n== A 组：列0 轨道 rail ==')
cap('S01', 'A 列0 轨道', '默认（项目模式头像）', '打开原型即是',
    None, PROOF_FRAME, '出厂默认；列0 顶部为紫渐变方块头像')
cap('S02', 'A 列0 轨道', '智能体头像模式', '点击列0 顶部头像 .menu-btn',
    "(() => { const mb=document.querySelector('.menu-btn'); mb&&mb.click(); })()",
    PROOF_FRAME, 'frame 加上 .agent')
cap('S03', 'A 列0 轨道', '列0 智能体瓦片列表', 'R201：头像切换到 agents 模式',
    "window.__R201.enter('agents')",
    PROOF_FRAME + " + ' tiles=' + document.querySelectorAll('.rail-agent-tile').length",
    'frame 加 .rail-agents-mode')
cap('S04', 'A 列0 轨道', '知识库 · 文档列表', '点击列0 知识库图标 #railKb',
    "document.getElementById('railKb').click()",
    PROOF_FRAME + " + ' cards=' + document.querySelectorAll('.kb-card').length",
    'frame 加 .kb-open')
cap('S05', 'A 列0 轨道', '知识库 · 文档编辑', '知识库里点开一篇文档',
    "document.getElementById('railKb').click()",
    "(() => { const d=document.querySelector('.kb-doc'); return 'kb-doc.hidden='+(d?d.hidden:'?'); })()",
    'kb-list 隐藏 / kb-doc 显示',
    post="""(() => {
      const d=document.querySelector('.kb-doc'); if(d) d.hidden=false;
      const l=document.querySelector('.kb-list'); if(l) l.hidden=true;
      const t=document.querySelector('.kb-doc-title'); if(t) t.value='快速上手指南';
      const b=document.querySelector('.kb-doc-body'); if(b) b.value='工作台基础概念、首屏布局与常用操作。';
    })()""", post_wait=1.6)

print('\n== B 组：列1 侧栏 sidebar ==')
cap('S06', 'B 列1 侧栏', '搜索中（带清除按钮）', '在侧栏搜索框输入关键词',
    """(() => {
         const sf=document.querySelector('.search-field');
         if(sf){ sf.value='卡布'; sf.dispatchEvent(new Event('input',{bubbles:true}));
                 sf.dispatchEvent(new Event('focus',{bubbles:true})); }
       })()""",
    "(() => { const c=document.querySelector('.search-clear'); return c? ('clear='+getComputedStyle(c).display) : 'no-clear'; })()",
    'search-clear 由 none 变 block')
cap('S07', 'B 列1 侧栏', '联系人任务态（进行中/完成）', '智能体后台跑任务时自动进入',
    """(() => {
         [...document.querySelectorAll('.contact-item')].forEach((it,i)=>{
           it.classList.add('running');
           const m=it.querySelector('.contact-memory');
           if(m) m.classList.add(i===1?'done':'running');
         });
       })()""",
    "document.querySelectorAll('.contact-item.running').length + ' running'",
    'running=进行中 / done=完成')
cap('S08', 'B 列1 侧栏', '联系人选中态', '点击某个联系人',
    """(() => {
         const it=document.querySelectorAll('.contact-item')[1];
         if(it){ it.classList.add('selected'); it.classList.add('active'); }
       })()""",
    "document.querySelectorAll('.contact-item.selected').length + ' selected'",
    '单选高亮')
cap('S09', 'B 列1 侧栏', '会话浮窗（拖出独立聊天）', '双击侧栏里的智能体（.agent-chip）',
    """(() => {
         const chips=[...document.querySelectorAll('.agent-chip')];
         if(!chips.length) return 'no-chip';
         chips[0].dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
         return 'chips='+chips.length;
       })()""",
    "document.querySelectorAll('.sess-float').length + ' float'",
    '★ openFloat() 绑在 .agent-chip 上（.contact-item 上长按 550ms 只加 .dual-ready）')
cap('S10', 'B 列1 侧栏', '侧栏拖宽（拖 splitter）', '拖动列1/列2 之间分隔条',
    """(() => {
         const sp=document.querySelector('.splitter');
         sp.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:339,clientY:400,button:0,pointerId:1,isPrimary:true}));
         document.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:540,clientY:400,pointerId:1,isPrimary:true}));
       })()""",
    "(() => { const s=document.querySelector('.sidebar'); return s? Math.round(s.getBoundingClientRect().width)+'px' : '?'; })()",
    '双击分隔条可复位到 270px')

print('\n== C 组：列2 主区 main ==')
cap('S11', 'C 列2 主区', '空态（无消息）', '刚打开 / 新建会话',
    None, "(() => { const m=document.querySelector('.sf-msgs,.main-msgs,.msgs'); return m? m.children.length+' children' : '容器待确认'; })()")
cap('S12', 'C 列2 主区', '输入栏已填 + 上下文 tray', '在输入栏打字',
    """(() => {
         const f=document.querySelector('.inputbar-field');
         if(f){ f.value='帮我分析一下这次的数据'; f.dispatchEvent(new Event('input',{bubbles:true}));
                f.dispatchEvent(new Event('focus',{bubbles:true})); }
         const t=document.getElementById('composerTray');
         if(t){ t.classList.add('has-items'); t.innerHTML='<span>产品知识库</span>'; }
       })()""",
    "(() => { const f=document.querySelector('.inputbar-field'); return f? JSON.stringify(f.value) : '?'; })()")
cap('S13', 'C 列2 主区', '附件 / 工具弹层', '点击输入栏最左侧 ＋ 按钮',
    "document.querySelector('.inputbar-btn.attach').click()",
    "document.getElementById('attachPopup').className + ' items=' + document.querySelectorAll('#attachPopup .item').length")
cap('S14', 'C 列2 主区', '语音输入条', '点击输入栏麦克风按钮',
    "(() => { const b=document.querySelector('.inputbar-btn.voice'); if(b) b.click(); })()",
    "document.getElementById('voiceBar').className")
cap('S15', 'C 列2 主区', '富内容消息块（表格/文档/代码）', 'AI 回复里含结构化内容块',
    "(() => { const d=document.querySelector('.dual-entry'); if(d) d.click(); })()",
    "(() => { const b=[...document.querySelectorAll('.ai-block')]; return b.length? b.map(x=>x.dataset.btype+':'+x.dataset.state).join(' ') : 'no-block'; })()",
    '为了拿到活着的消息容器，这里先进入双栏再注入消息块',
    post="""(() => {
      const box=document.querySelector('.dual-pane .sf-msgs') || document.querySelector('.sf-msgs');
      if(!box) return 'no-box';
      const BLK=(t,st,title,body)=>'<div class="ai-block '+t+' '+st+'" data-btype="'+t+'" data-state="'+st+'">'+
        '<div class="ai-block-head"><span class="ai-block-type">'+t+'</span>'+
        '<span class="ai-block-title">'+title+'</span><span class="ai-block-acts"></span></div>'+
        '<div class="ai-block-body">'+body+'</div></div>';
      const skel='<div class="blk-skel"><div class="ln w1"></div><div class="ln w2"></div><div class="ln w3"></div><div class="ln w4"></div></div>';
      const err='<span class="err-ico">!</span><span class="err-msg">生成失败，请重试</span><button class="err-retry">重试</button>';
      box.innerHTML =
        '<div class="sf-msg me">帮我做一份季度分析</div>'+
        '<div class="sf-msg ai">好的，生成了这些内容块：</div>'+
        BLK('table','done','区域汇总','<table class="ai-tbl"><tr><th>区域</th><th>金额</th></tr><tr><td>华东</td><td>128万</td></tr></table>')+
        BLK('doc','done','季度报告','<div class="ai-doc-meta"><div class="ai-doc-name">Q3-report.pdf</div><div class="ai-doc-sub">12 页</div></div>')+
        BLK('code','loading','生成中…', skel)+
        BLK('code','error','生成失败', err);
      return 'blocks='+box.querySelectorAll('.ai-block').length;
    })()""", post_wait=1.8)

print('\n== D 组：弹窗 / 全屏层 ==')
cap('S16', 'D 弹窗层', '智能体创建卡片（原型已隐藏）', '侧栏 ＋ → 新建智能体',
    "window.__openAgentCreate()",
    "(() => { const e=document.getElementById('agentCreate'); return e? (e.className+' display='+getComputedStyle(e).display) : 'no-el'; })()",
    '★ 原型里 .agent-create 带 display:none !important，正常交互点不出来')
cap('S17', 'D 弹窗层', '新建项目卡片', '列0 项目模式 → 新建项目',
    "(() => { const m=document.getElementById('xyzCreateMask'); if(m) m.classList.add('on'); })()",
    "(() => { const m=document.getElementById('xyzCreateMask'); return m? m.className : 'none'; })()")
cap('S18', 'D 弹窗层', '双栏对照（两个会话并排）', '有 ≥2 个智能体后点双栏入口',
    "(() => { const d=document.querySelector('.dual-entry'); if(d) d.click(); })()",
    PROOF_FRAME + " + ' panes=' + document.querySelectorAll('.dual-pane').length",
    'frame 加 .dual')

ws.close(); p.terminate()

mf = os.path.join(OUTDIR, 'states.json')
open(mf, 'w', encoding='utf-8').write(json.dumps(STATES, ensure_ascii=False, indent=2))
print('\nmanifest ->', mf, '| states =', len(STATES))
