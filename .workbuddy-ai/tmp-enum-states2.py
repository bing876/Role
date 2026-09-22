"""Comprehensive prototype state inventory + screenshots (v2, corrected).

Key corrections over v1:
 - chatArea was REMOVED from the prototype (only a dead reference at line 4208).
   Real message surfaces: .dual-pane .sf-msgs (dual view) and .sess-float .sf-msgs.
 - .dual-entry requires agentCount() >= 2, i.e. >=2 .agent-chip elements.
 - The prototype ships only ONE contact (我的助手); extra agents must be added.
"""
import os, json, time, base64, subprocess, urllib.request, socket, shutil

os.environ['NO_PROXY'] = '127.0.0.1,localhost'
os.environ['no_proxy'] = '127.0.0.1,localhost'
import websocket

PROTO = r"J:\xwechat_files\wxid_yulc5z94mh2i22_84cf\msg\file\2026-09\workbench.work.html"
EXE = r"C:\Users\bing\workbuddy-ai\work123\node_modules\electron\dist\electron.exe"
PORT = 9731
OUTDIR = r"C:\Users\bing\workbuddy-ai\work123\docs\acceptance\protostates"
UDD = r"C:\Users\bing\workbuddy-ai\work123\.workbuddy-ai\udd-enum3"


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


send('Page.enable'); send('Runtime.enable')
send('Emulation.setDeviceMetricsOverride', width=1400, height=900,
     deviceScaleFactor=1, mobile=False)
time.sleep(3.5)

print('\n===== 发现：智能体数量与双栏门槛 =====')
print('agent-chip 数:', ev("document.querySelectorAll('.agent-chip').length"))
print('contact-item 数:', ev("document.querySelectorAll('.contact-item').length"))

# ---------- 造出第二个智能体，解锁多智能体场景 ----------
print('\n===== 造第二个智能体 =====')
print('__addContact:', ev("typeof window.__addContact"))
print('创建结果:', ev("""(() => {
  try {
    if(typeof window.__addContact === 'function'){
      window.__createAgent({name:'卡布'});
      return 'called __addContact, chips now=' + document.querySelectorAll('.agent-chip').length;
    }
    const ab = document.querySelector('.add-btn');
    if(ab){ ab.click(); return 'clicked .add-btn'; }
    return 'no-path';
  } catch(e){ return 'ERR '+e.message; }
})()"""))
time.sleep(2.5)
print('chips:', ev("document.querySelectorAll('.agent-chip').length"),
      'contacts:', ev("document.querySelectorAll('.contact-item').length"))

# 再补一个，确保 >=2 chips
ev("""(() => { try { if(document.querySelectorAll('.agent-chip').length < 2
    && typeof window.__addContact === 'function') window.__createAgent({name:'电商小助手'}); } catch(e){} })()""")
time.sleep(2.5)
chips = ev("document.querySelectorAll('.agent-chip').length")
contacts = ev("document.querySelectorAll('.contact-item').length")
print('最终 chips=%s contacts=%s' % (chips, contacts))
if chips >= 2:
    print('  chips 名称:', ev("[...document.querySelectorAll('.agent-chip')].map(c=>c.textContent.trim())"))
if contacts >= 1:
    print('  contacts:', ev("[...document.querySelectorAll('.contact-item')].map(c=>(c.querySelector('.contact-name')||{}).textContent)"))

print('\n===== 抓图 =====')

# --- S1 默认（单联系人基本态） ---
ev("document.querySelector('.frame').className='frame'")
time.sleep(1.3)
print('S1 默认三列 (frame=frame)')
shot('S1-default')

# --- S2 列0 智能体头像模式 ---
print('S2 列0 智能体模式')
ev("window.__R201.enter('agents')")
time.sleep(1.8)
print('   frame:', ev("document.querySelector('.frame').className"),
      '| tiles:', ev("document.querySelectorAll('.rail-agent-tile').length"))
shot('S2-rail-agents-mode')
ev("window.__R201.enter('project')"); time.sleep(1.5)

# --- S3 知识库 ---
print('S3 知识库面板')
ev("document.getElementById('railKb').click()")
time.sleep(1.6)
print('   frame:', ev("document.querySelector('.frame').className"))
shot('S3-knowledge-base')
ev("document.getElementById('railKb').click()"); time.sleep(1.5)

# --- S4 知识库：文档编辑态 ---
print('S4 知识库文档编辑态')
ev("""(() => {
  const card=document.querySelector('.kb-card'); if(card) card.click();
  const d=document.querySelector('.kb-doc'); if(d) d.hidden=false;
  const l=document.querySelector('.kb-list'); if(l) l.hidden=true;
  const t=document.querySelector('.kb-doc-title'); if(t) t.value='快速上手指南';
  const b=document.querySelector('.kb-doc-body'); if(b) b.value='工作台基础概念、首屏布局与常用操作。\\n\\n三列结构：列0 图标栏 / 列1 会话列表 / 列2 主区。';
})()""")
time.sleep(1.5)
print('   doc visible:', ev("(() => { const d=document.querySelector('.kb-doc'); return d && !d.hidden; })()"))
shot('S4-kb-doc-edit')

# 复位知识库
ev("""(() => {
  document.getElementById('railKb').click();
  const d=document.querySelector('.kb-doc'); if(d) d.hidden=true;
  const l=document.querySelector('.kb-list'); if(l) l.hidden=false;
})()""")
time.sleep(1.5)

# --- S5 附件弹层 ---
print('S5 附件弹层（5 个工具）')
ev("document.querySelector('.inputbar-btn.attach').click()")
time.sleep(1.2)
print('   open:', ev("document.getElementById('attachPopup').classList.contains('open')"),
      '| items:', ev("document.querySelectorAll('#attachPopup .item').length"))
shot('S5-attach-popup')
ev("document.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))"); time.sleep(1.2)

# --- S6 语音输入条 ---
print('S6 语音输入条')
ev("""(() => { const b=document.querySelector('.inputbar-btn.voice'); if(b) b.click(); })()""")
time.sleep(1.6)
print('   voiceBar:', ev("document.getElementById('voiceBar').className"))
shot('S6-voice-bar')
ev("(() => { const c=document.querySelector('.voice-cancel'); if(c) c.click(); })()")
time.sleep(1.4)

# --- S7 智能体创建卡片 ---
print('S7 智能体创建卡片')
print('   open结果:', ev("(() => { try { window.__openAgentCreate(); return 'ok'; } catch(e){ return 'ERR '+e.message; } })()"))
time.sleep(1.8)
print('   agentCreate class:', ev("(() => { const e=document.getElementById('agentCreate'); return e? e.className : null; })()"))
shot('S7-agent-create')
ev("""(() => {
  const c=document.getElementById('acCancel'); if(c) c.click();
  const e=document.getElementById('agentCreate'); if(e) e.classList.remove('open');
})()""")
time.sleep(1.4)

# --- S8 双栏对照（需 >=2 chips） ---
print('S8 双栏对照 (dual)')
if chips >= 2:
    print('   dual-entry click:', ev("(() => { const d=document.querySelector('.dual-entry'); if(!d) return 'none'; d.click(); return 'clicked'; })()"))
    time.sleep(2.0)
    print('   frame:', ev("document.querySelector('.frame').className"))
    print('   panes:', ev("document.querySelectorAll('.dual-pane').length"),
          '| msgs:', ev("document.querySelectorAll('.dual-view .sf-msg').length"))
    shot('S8-dual-view')
    ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
    time.sleep(1.6)
else:
    print('   SKIP（chips < 2）')

# --- S9 会话浮窗（多消息） ---
print('S9 会话浮窗 sess-float')
print('   开浮窗:', ev("""(() => {
  const chip=document.querySelector('.agent-chip'); if(!chip) return 'no-chip';
  chip.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
  return 'dblclick done, floats=' + document.querySelectorAll('.sess-float').length;
})()"""))
time.sleep(1.8)
print('   floats:', ev("document.querySelectorAll('.sess-float').length"),
      '| msgs:', ev("document.querySelectorAll('.sess-float .sf-msg').length"))
shot('S9-session-float')

# --- S10 满屏浮窗（一次开两个） ---
print('S10 多个会话浮窗同时存在')
ev("""(() => {
  const chips=[...document.querySelectorAll('.agent-chip')];
  chips.slice(0,3).forEach(c=>c.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})));
})()""")
time.sleep(2.0)
print('   floats:', ev("document.querySelectorAll('.sess-float').length"))
shot('S10-multi-float')
ev("document.querySelectorAll('.sess-float').forEach(e=>e.remove())"); time.sleep(1.2)

# --- S11 联系人 running / done 记忆态 ---
print('S11 联系人任务态（running / done 红点）')
ev("""(() => {
  const items=[...document.querySelectorAll('.contact-item')];
  items.forEach((it,i)=>{
    it.classList.add('running');
    const m=it.querySelector('.contact-memory');
    if(m) m.classList.add(i%2===0?'running':'done');
  });
  return items.length;
})()""")
time.sleep(1.5)
print('   running:', ev("document.querySelectorAll('.contact-item.running').length"))
shot('S11-contact-task-state')
ev("""document.querySelectorAll('.contact-item').forEach(o=>{o.classList.remove('running');
  const m=o.querySelector('.contact-memory'); if(m) m.classList.remove('running','done');})""")
time.sleep(1.2)

# --- S12 分隔条拖拽（resizing 态） ---
print('S12 分隔条最大化列1')
ev("""(() => {
  const sp=document.querySelector('.splitter');
  if(!sp) return 'no-splitter';
  sp.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:339,clientY:400,button:0}));
  document.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:520,clientY:400}));
  return 'dragged';
})()""")
time.sleep(1.2)
print('   sidebar width:', ev("(() => { const s=document.querySelector('.sidebar'); return s? s.getBoundingClientRect().width : null; })()"))
shot('S12-splitter-wide')
ev("""(() => {
  document.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,clientX:520,clientY:400}));
})()""")
time.sleep(1.0)

# --- S13 输入栏有内容 / 附件 tray ---
print('S13 输入栏已填内容')
ev("""(() => {
  const f=document.querySelector('.inputbar-field');
  if(f){ f.value='帮我分析一下这次的数据'; f.dispatchEvent(new Event('input',{bubbles:true}));
         f.dispatchEvent(new Event('focus',{bubbles:true})); }
  const t=document.getElementById('composerTray');
  if(t){ t.classList.add('has-items');
    t.innerHTML='<span class="tray-chip">产品知识库</span><span class="tray-chip">销售数据.csv</span>'; }
  const bar=document.querySelector('.inputbar'); if(bar) bar.dataset.state='filled';
})()""")
time.sleep(1.5)
shot('S13-input-filled')

# --- S14 消息内容块（注入到浮窗里，因为浮窗是唯一的消息容器） ---
print('S14 富内容消息块')
ev("""(() => {
  const chip=document.querySelector('.agent-chip');
  if(chip) chip.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
})()""")
time.sleep(1.8)
print('   注入:', ev("""(() => {
  const box=document.querySelector('.sess-float .sf-msgs');
  if(!box) return 'no sf-msgs';
  const BLK=(t,st,title,body)=>'<div class="ai-block '+t+' '+st+'" data-btype="'+t+'" data-state="'+st+'">'+
    '<div class="ai-block-head"><span class="ai-block-type">'+t+'</span>'+
    '<span class="ai-block-title">'+title+'</span><span class="ai-block-acts"></span></div>'+
    '<div class="ai-block-body">'+body+'</div></div>';
  const skel='<div class="blk-skel"><div class="ln w1"></div><div class="ln w2"></div><div class="ln w3"></div><div class="ln w4"></div></div>';
  const err='<span class="err-ico">!</span><span class="err-msg">生成失败，请重试</span><button class="err-retry">重试</button>';
  box.innerHTML =
    '<div class="sf-msg me">帮我做一份季度分析</div>' +
    '<div class="sf-msg ai">好的，已生成三个内容块：</div>' +
    BLK('code','done','示例代码','<div class="ai-code-wrap"><pre class="ai-code-pre"><code>SELECT region, SUM(amt) FROM sales GROUP BY region;</code></pre></div>') +
    BLK('table','done','区域汇总','<table class="ai-tbl"><tr><th>区域</th><th>金额</th></tr><tr><td>华东</td><td>128万</td></tr><tr><td>华南</td><td>96万</td></tr></table>') +
    BLK('pdf','done','季度报告','<div class="ai-doc-meta"><div class="ai-doc-name">Q3-report.pdf</div><div class="ai-doc-sub">12 页</div></div>') +
    BLK('code','loading','生成中…', skel) +
    BLK('code','error','生成失败', err);
  return 'blocks='+box.querySelectorAll('.ai-block').length;
})()"""))
time.sleep(1.6)
print('   块清单:', ev("[...document.querySelectorAll('.sess-float .ai-block')].map(b=>b.dataset.btype+':'+b.dataset.state)"))
shot('S14-message-blocks')

ws.close(); p.terminate()
print('\nDONE ->', OUTDIR)
