
const path = require('path');
const REPO = process.argv[2];
const base = process.argv[3];
(async () => {
  let mod;
  try {
    mod = require(path.join(REPO, 'apps', 'desktop', 'dist-electron', 'server-supervisor.js'));
  } catch (e) {
    console.log(JSON.stringify({ error: 'require failed: ' + e.message }));
    process.exit(1);
  }
  const r = await mod.probe(base);
  console.log(JSON.stringify({ probed: r }));
  process.exit(0);
})();
