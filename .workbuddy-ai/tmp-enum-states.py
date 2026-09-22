"""Enumerate + screenshot every designed state in the prototype.

Discovery first (list every state hook), then capture each state.
"""
import os, json, time, base64, subprocess, urllib.request, socket, shutil

os.environ['NO_PROXY'] = '127.0.0.1,localhost'
os.environ['no_proxy'] = '127.0.0.1,localhost'
import websocket

PROTO = r"J:\xwechat_files\wxid_yulc5z94mh2i22_84cf\msg\file\2026-09\workbench.work.html"
EXE = r"C:\Users\bing\workbuddy-ai\work123\node_modules\electron\dist\electron.exe"
PORT = 9711
OUTDIR = r"C:\Users\bing\workbuddy-ai\work123\docs\acceptance\protostates"
UDD = r"C:\Users\bing\workbuddy-ai\work123\.workbuddy-ai\udd-enum"


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
        return {'__exc': str(res['exceptionDetails'])[:400]}
    return res.get('result', {}).get('value')


def shot(name):
    s = send('Page.captureScreenshot', format='png')
    fp = os.path.join(OUTDIR, name + '.png')
    open(fp, 'wb').write(base64.b64decode(s['result']['data']))
    print('  saved', name, os.path.getsize(fp))


send('Page.enable'); send('Runtime.enable')
send('Emulation.setDeviceMetricsOverride', width=1400, height=900,
     deviceScaleFactor=1, mobile=False)
time.sleep(3.5)

# ================= A. 全量发现 =================
print('\n===== A. 状态发现 =====')
print('frame classes  :', ev("document.querySelector('.frame').className"))
print('body classes   :', ev("document.body.className"))
inv = ev("""(() => {
  const out = {};
  // 所有顶层交互区块是否存在于 DOM
  const probe = ['.frame','.rail','.sidebar','.contact-list','.splitter','.main-area',
    '.top-area','.inputbar','.composer','.attach-popup','.voice-bar','.dual-entry','.dual-view',
    '.kb-view','.plug-outside','.win-controls','.agent-create','.xyz-create-card','.sess-float',
    '.msg','.ai-block','.agent-list','.rail-agents','.search-pill','.hamburger','.menu-btn'];
  probe.forEach(s => { out[s] = document.querySelectorAll(s).length; });
  // 消息块类型
  out['__blkTypes'] = [...document.querySelectorAll('.ai-block')].map(b => b.className);
  out['__contactItems'] = document.querySelectorAll('.contact-item').length;
  out['__agentTiles'] = document.querySelectorAll('.rail-agent-tile').length;
  out['__chips'] = document.querySelectorAll('.agent-chip').length;
  out['__sessions'] = Object.keys(window.__wbLastPayload || {});
  return out;
})()""")
print('DOM 清点:', json.dumps(inv, ensure_ascii=False, indent=1))

print('\n暴露的接口:')
for k in ['__R201', '__wbComposer', '__wbSplitRestore', '__createAgent', '__openAgentCreate',
          '__addContact', '__selectAgent', '__switchAgent', '__railEnterAgents', '__xyzOpenCreateCard',
          '__xyzCreateProject', '__kbClose', '__setWallpaper', '__wpInfo', '__wbLastPayload']:
    print('  %-22s %s' % (k, ev("typeof window.%s" % k)))

print('\n联系人清单:')
print(json.dumps(ev("""[...document.querySelectorAll('.contact-item')].map(it => ({
  name: (it.querySelector('.contact-name')||{}).textContent,
  sub: (it.querySelector('.contact-sub')||{}).textContent,
  cls: it.className, agent: it.getAttribute('data-agent')
}))"""), ensure_ascii=False, indent=1))

print('\n===== 状态抓图开始 =====')


def reset():
    ev("document.querySelectorAll('.contact-item').forEach(o=>o.classList.remove('active','running'));")
    ev("if(window.__R201 && window.__R201.mode()==='agents') { document.getElementById('menuBtn')||document.querySelector('.menu-btn'); }")


# --- S1 默认（无智能体进入 / 三列） ---
ev("document.querySelector('.frame').className = 'frame'")
ev("if(document.body.classList.contains('layers-hidden')) document.body.classList.remove('layers-hidden')")
time.sleep(1.2)
print('S1 默认三列 :', ev("document.querySelector('.frame').className"))
shot('S1-default')

# --- S2 列0「当前项目的智能体」模式 ---
print('S2 切 agents 模式 ->', ev("window.__R201.enter('agents'); 'ok'"))
time.sleep(1.6)
print('   frame class:', ev("document.querySelector('.frame').className"))
print('   tiles      :', ev("document.querySelectorAll('.rail-agent-tile').length"))
shot('S2-rail-agents-mode')
ev("window.__R201.enter('project')"); time.sleep(1.4)

# --- S3 知识库面板 ---
print('S3 知识库   ->', ev("document.getElementById('railKb').click(); 'ok'"))
time.sleep(1.6)
print('   frame class:', ev("document.querySelector('.frame').className"))
shot('S3-knowledge-base')
ev("document.getElementById('railKb').click()"); time.sleep(1.4)

# --- S4 附件弹层 ---
print('S4 附件弹层 ->', ev("document.querySelector('.inputbar-btn.attach').click(); 'ok'"))
time.sleep(1.2)
print('   popup open:', ev("document.getElementById('attachPopup').classList.contains('open')"))
shot('S4-attach-popup')
ev("document.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))"); time.sleep(1.0)

# --- S5 语音条 ---
print('S5 语音条   ->', ev("""(() => { const b=document.querySelector('.inputbar-btn.voice')||document.querySelector('.voice-btn');
  return b ? (b.click(),'clicked') : 'no-voice-btn'; })()"""))
time.sleep(1.5)
print('   voiceBar  :', ev("document.getElementById('voiceBar').className"))
shot('S5-voice-bar')
ev("""(() => { const c=document.querySelector('.voice-cancel'); if(c) c.click(); })()""")
time.sleep(1.2)

# --- S6 智能体创建卡片 ---
print('S6 创建智能体 ->', ev("""(() => {
  if(window.__openAgentCreate){ window.__openAgentCreate(); return 'opened'; }
  const el=document.getElementById('agentCreate'); if(el){ el.classList.add('open'); return 'shown'; }
  return 'no-api'; })()"""))
time.sleep(1.6)
shot('S6-agent-create')
ev("""(() => { const c=document.getElementById('acCancel')||document.getElementById('acClose');
  if(c) c.click(); const el=document.getElementById('agentCreate'); if(el) el.classList.remove('open'); })()""")
time.sleep(1.2)

# --- S7 双栏对照 ---
print('S7 双栏     ->', ev("""(() => {
  const de=document.querySelector('.dual-entry'); if(!de) return 'no-entry';
  de.click(); return 'clicked'; })()"""))
time.sleep(1.8)
print('   frame class:', ev("document.querySelector('.frame').className"))
shot('S7-dual-view')
ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
time.sleep(1.4)

# --- S8 联系人 running 态 ---
print('S8 running  ->', ev("""(() => {
  const it=document.querySelectorAll('.contact-item')[2]||document.querySelectorAll('.contact-item')[0];
  if(!it) return 'none';
  it.classList.add('running');
  const m=it.querySelector('.contact-memory'); if(m) m.classList.add('running');
  return it.className; })()"""))
time.sleep(1.4)
shot('S8-contact-running')
ev("document.querySelectorAll('.contact-item').forEach(o=>{o.classList.remove('running');const m=o.querySelector('.contact-memory');if(m)m.classList.remove('running','done');})")
time.sleep(1.0)

# --- S9 富内容消息块（注入全部类型 + 三种状态） ---
print('S9 消息块   ->', ev("""(() => {
  const chat = document.getElementById('chatArea');
  if(!chat) return 'no-chatArea';
  const BLK = (type, state, title, body) =>
    '<div class="ai-block '+type+' '+state+'" data-btype="'+type+'" data-state="'+state+'">'+
      '<div class="ai-block-head"><span class="ai-block-type">'+type+'</span>'+
      '<span class="ai-block-title">'+title+'</span><span class="ai-block-acts"></span></div>'+
      '<div class="ai-block-body">'+body+'</div></div>';
  const skel = '<div class="blk-skel"><div class="ln w1"></div><div class="ln w2"></div><div class="ln w3"></div><div class="ln w4"></div></div>';
  const err  = '<span class="err-ico">!</span><span class="err-msg">生成失败，请重试</span><button class="err-retry">重试</button>';
  const wrap = document.createElement('div');
  wrap.style.cssText='padding:20px;display:flex;flex-direction:column;gap:14px;';
  wrap.innerHTML =
    BLK('code','done','示例代码','<div class="ai-code-wrap"><pre class="ai-code-pre"><code>const x = 1;</code></pre></div>')+
    BLK('table','done','数据表格','<table class="ai-tbl"><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>')+
    BLK('pdf','done','季度报告','<div class="ai-doc-meta"><div class="ai-doc-name">Q3.pdf</div><div class="ai-doc-sub">12 页</div></div>')+
    BLK('code','loading','生成中…', skel)+
    BLK('code','error','生成失败', err);
  chat.innerHTML=''; chat.appendChild(wrap);
  return 'injected '+wrap.querySelectorAll('.ai-block').length;
})()"""))
time.sleep(1.8)
shot('S9-message-blocks')
print('   块清点:', ev("[...document.querySelectorAll('.ai-block')].map(b=>b.dataset.btype+':'+b.dataset.state)"))

ws.close(); p.terminate()
print('\nDONE ->', OUTDIR)
