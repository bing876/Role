"""Final prototype state inventory — clean isolation between states (v3).

Fixes over v2:
 - always fully reset the frame class list before each state
 - kb-open must be closed before capturing dual view
 - message blocks render into .dual-pane .sf-msgs (the only live message surface)
 - adds the R199 project-switching states (project list in 列0, new project card)
"""
import os, json, time, base64, subprocess, urllib.request, socket, shutil

os.environ['NO_PROXY'] = '127.0.0.1,localhost'
os.environ['no_proxy'] = '127.0.0.1,localhost'
import websocket

PROTO = r"J:\xwechat_files\wxid_yulc5z94mh2i22_84cf\msg\file\2026-09\workbench.work.html"
EXE = r"C:\Users\bing\workbuddy-ai\work123\node_modules\electron\dist\electron.exe"
PORT = 9741
OUTDIR = r"C:\Users\bing\workbuddy-ai\work123\docs\acceptance\protostates"
UDD = r"C:\Users\bing\workbuddy-ai\work123\.workbuddy-ai\udd-enum4"


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


def shot(name):
    s = send('Page.captureScreenshot', format='png')
    fp = os.path.join(OUTDIR, name + '.png')
    open(fp, 'wb').write(base64.b64decode(s['result']['data']))
    print('   -> %s.png (%d B)' % (name, os.path.getsize(fp)))


def reset_full():
    """Completely reset to the shipped default state."""
    ev("""(() => {
      const f=document.querySelector('.frame');
      f.className='frame';
      f.style.cssText='';
      document.getElementById('attachPopup').classList.remove('open');
      document.getElementById('voiceBar').classList.remove('open');
      document.querySelector('.inputbar').classList.remove('voice-active');
      const ac=document.getElementById('agentCreate'); if(ac){ac.classList.remove('open');ac.setAttribute('aria-hidden','true');}
      document.querySelectorAll('.sess-float').forEach(e=>e.remove());
      const dv=document.querySelector('.dual-view'); if(dv) dv.innerHTML='';
      const kb=document.querySelector('.kb-view');
      const d=document.querySelector('.kb-doc'); if(d) d.hidden=true;
      const l=document.querySelector('.kb-list'); if(l) l.hidden=false;
      const sp=document.querySelector('.splitter');
      document.querySelectorAll('.contact-item').forEach(o=>{
        o.classList.remove('running');
        const m=o.querySelector('.contact-memory'); if(m) m.classList.remove('running','done');
      });
      return 'reset';
    })()""")
    time.sleep(1.2)


send('Page.enable'); send('Runtime.enable')
send('Emulation.setDeviceMetricsOverride', width=1400, height=900,
     deviceScaleFactor=1, mobile=False)
time.sleep(3.5)

# ============ 装备：造出 3 个智能体，解锁多智能体场景 ============
print('\n===== 装备多智能体 =====')
for nm in ['卡布', '电商小助手']:
    ev("window.__createAgent({name:%s})" % json.dumps(nm))
    time.sleep(1.6)
chips = ev("document.querySelectorAll('.agent-chip').length")
contacts = ev("document.querySelectorAll('.contact-item').length")
print('chips=%s contacts=%s' % (chips, contacts))
print('  chips:', ev("[...document.querySelectorAll('.agent-chip')].map(c=>c.textContent.trim())"))
print('  contacts:', ev("[...document.querySelectorAll('.contact-item')].map(c=>(c.querySelector('.contact-name')||{}).textContent)"))

print('\n===== 抓图 =====')

# ---- S1 默认三列（带 3 个联系人） ----
reset_full()
print('S1 默认三列 / 3 个智能体')
shot('S1-default-3agents')

# ---- S2 列0 智能体头像模式 ----
reset_full()
print('S2 列0 → 智能体头像模式')
ev("window.__R201.enter('agents')")
time.sleep(1.8)
print('   frame:', ev("document.querySelector('.frame').className"),
      '| tiles:', ev("document.querySelectorAll('.rail-agent-tile').length"))
shot('S2-rail-agents-mode')
ev("window.__R201.enter('project')"); time.sleep(1.5)

# ---- S3 列0 项目列表模式（R199） ----
reset_full()
print('S3 列0 → 项目模式（R199）')
ev("""(() => {
  const mb=document.querySelector('.menu-btn');
  if(mb && !document.querySelector('.frame').classList.contains('agent')) mb.click();
})()""")
time.sleep(2.0)
print('   frame:', ev("document.querySelector('.frame').className"))
shot('S3-rail-project-mode')
print('   项目块数:', ev("document.querySelectorAll('.agent-chip').length"))
ev("document.querySelector('.menu-btn').click()"); time.sleep(1.6)

# ---- S4 知识库列表 ----
reset_full()
print('S4 知识库（列表）')
ev("document.getElementById('railKb').click()")
time.sleep(1.8)
print('   frame:', ev("document.querySelector('.frame').className"),
      '| 卡片:', ev("document.querySelectorAll('.kb-card').length"))
shot('S4-knowledge-list')

# ---- S5 知识库（文档编辑） ----
print('S5 知识库（文档编辑态）')
ev("""(() => {
  const d=document.querySelector('.kb-doc'); if(d) d.hidden=false;
  const l=document.querySelector('.kb-list'); if(l) l.hidden=true;
  const t=document.querySelector('.kb-doc-title'); if(t) t.value='快速上手指南';
  const b=document.querySelector('.kb-doc-body'); if(b) b.value='工作台基础概念、首屏布局与常用操作。';
})()""")
time.sleep(1.5)
shot('S5-knowledge-doc-edit')
ev("document.getElementById('railKb').click()"); time.sleep(1.6)

# ---- S6 附件弹层 ----
reset_full()
print('S6 附件弹层')
ev("document.querySelector('.inputbar-btn.attach').click()")
time.sleep(1.4)
print('   open:', ev("document.getElementById('attachPopup').classList.contains('open')"),
      '| items:', ev("document.querySelectorAll('#attachPopup .item').length"))
shot('S6-attach-popup')
ev("document.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))"); time.sleep(1.3)

# ---- S7 语音条 ----
reset_full()
print('S7 语音输入条')
ev("(() => { const b=document.querySelector('.inputbar-btn.voice'); if(b) b.click(); })()")
time.sleep(1.8)
print('   voiceBar:', ev("document.getElementById('voiceBar').className"))
shot('S7-voice-bar')
ev("(() => { const c=document.querySelector('.voice-cancel'); if(c) c.click(); })()")
time.sleep(1.4)

# ---- S8 智能体创建卡片 ----
reset_full()
print('S8 智能体创建卡片')
ev("window.__openAgentCreate()")
time.sleep(2.0)
print('   agentCreate:', ev("(() => { const e=document.getElementById('agentCreate'); return e? e.className : null; })()"))
shot('S8-agent-create')
ev("(() => { const c=document.getElementById('acCancel'); if(c) c.click(); const e=document.getElementById('agentCreate'); if(e) e.classList.remove('open'); })()")
time.sleep(1.4)

# ---- S9 双栏对照（两个智能体会话并排，各 5 条消息） ----
reset_full()
print('S9 双栏对照 dual-view')
print('   click:', ev("(() => { const d=document.querySelector('.dual-entry'); if(!d) return 'none'; d.click(); return 'ok'; })()"))
time.sleep(2.2)
print('   frame:', ev("document.querySelector('.frame').className"))
print('   panes:', ev("document.querySelectorAll('.dual-pane').length"),
      '| msgs:', ev("document.querySelectorAll('.dual-view .sf-msg').length"))
shot('S9-dual-view')

# ---- S10 双栏 + 富内容消息块（唯一活着的消息区） ----
print('S10 富内容消息块（注入到左栏）')
print('   inject:', ev("""(() => {
  const box=document.querySelector('.dual-pane .sf-msgs');
  if(!box) return 'no-box';
  const BLK=(t,st,title,body)=>'<div class="ai-block '+t+' '+st+'" data-btype="'+t+'" data-state="'+st+'">'+
    '<div class="ai-block-head"><span class="ai-block-type">'+t+'</span>'+
    '<span class="ai-block-title">'+title+'</span><span class="ai-block-acts"></span></div>'+
    '<div class="ai-block-body">'+body+'</div></div>';
  const skel='<div class="blk-skel"><div class="ln w1"></div><div class="ln w2"></div><div class="ln w3"></div><div class="ln w4"></div></div>';
  const err='<span class="err-ico">!</span><span class="err-msg">生成失败，请重试</span><button class="err-retry">重试</button>';
  box.innerHTML =
    '<div class="sf-msg me">帮我做一份季度分析</div>'+
    '<div class="sf-msg ai">好的，生成了三种内容块：</div>'+
    BLK('table','done','区域汇总','<table class="ai-tbl"><tr><th>区域</th><th>金额</th></tr><tr><td>华东</td><td>128万</td></tr></table>')+
    BLK('pdf','done','季度报告','<div class="ai-doc-meta"><div class="ai-doc-name">Q3-report.pdf</div><div class="ai-doc-sub">12 页</div></div>')+
    BLK('code','loading','生成中…', skel)+
    BLK('code','error','生成失败', err);
  return 'blocks='+box.querySelectorAll('.ai-block').length;
})()"""))
time.sleep(1.8)
print('   块:', ev("[...document.querySelectorAll('.dual-view .ai-block')].map(b=>b.dataset.btype+':'+b.dataset.state)"))
shot('S10-dual-with-blocks')
ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
time.sleep(1.6)

# ---- S11 联系人任务态 ----
reset_full()
print('S11 联系人任务态（running / done 红点）')
ev("""(() => {
  const items=[...document.querySelectorAll('.contact-item')];
  items.forEach((it,i)=>{
    it.classList.add('running');
    const m=it.querySelector('.contact-memory');
    if(m) m.classList.add(i===1?'done':'running');
  });
})()""")
time.sleep(1.6)
print('   running:', ev("document.querySelectorAll('.contact-item.running').length"))
shot('S11-contact-task-state')

# ---- S12 输入栏已填内容 + 上下文 tray ----
print('S12 输入栏已填内容')
ev("""(() => {
  const f=document.querySelector('.inputbar-field');
  if(f){ f.value='帮我分析一下这次的数据'; f.dispatchEvent(new Event('input',{bubbles:true}));
         f.dispatchEvent(new Event('focus',{bubbles:true})); }
  const t=document.getElementById('composerTray');
  if(t){ t.classList.add('has-items'); t.innerHTML='<span>产品知识库</span>'; }
})()""")
time.sleep(1.5)
shot('S12-input-filled')

# ---- S13 列1 变宽（splitter 拖拽后） ----
reset_full()
print('S13 列1 拖宽')
ev("""(() => {
  const sp=document.querySelector('.splitter');
  sp.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:339,clientY:400,button:0,pointerId:1}));
  document.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:520,clientY:400,pointerId:1}));
})()""")
time.sleep(1.5)
print('   sidebar width:', ev("(() => { const s=document.querySelector('.sidebar'); return s? Math.round(s.getBoundingClientRect().width) : null; })()"))
shot('S13-splitter-wide')
ev("document.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,clientX:520,clientY:400,pointerId:1}))")
time.sleep(1.2)

ws.close(); p.terminate()
print('\nDONE ->', OUTDIR)
