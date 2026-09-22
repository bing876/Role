
const path = require('path');
const REPO = process.argv[2];
(async () => {
  const mod = require(path.join(REPO, 'apps', 'desktop', 'dist-electron', 'server-supervisor.js'));
  const logs = [];
  const ok = await mod.ensureServer(undefined, (m) => logs.push(m));
  const st = mod.getServerState();
  console.log('RESULT ' + JSON.stringify({ ok, st, logs }));
  process.exit(0);
})();
