// 原生安装包只在对应平台构建/验收；Linux 目录包不冒充 Win/mac 成品。
const expected = process.argv[2];
if (!['win32', 'darwin'].includes(expected) || process.platform !== expected) {
  console.error(`[release] 当前 ${process.platform}，${expected === 'win32' ? '.exe 必须在 Windows' : '.dmg 必须在 macOS'} 构建并做真机安装验收。`);
  process.exit(2);
}
