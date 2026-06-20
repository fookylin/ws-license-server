/**
 * Render 启动入口
 * 先异步初始化 sql.js 数据库，再加载 server.js
 */

const path = require('path');

// 从环境变量或默认路径获取数据库路径
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'admin.db');

async function main() {
  console.log('=== Render 启动入口 ===');
  console.log('Node:', process.version);
  console.log('数据库路径:', DB_PATH);

  // 1. 初始化 sql.js 数据库
  const { initDatabase } = require('./db-adapter');
  await initDatabase(DB_PATH);

  // 2. 拦截 better-sqlite3 的 require，返回我们的兼容对象
  const Module = require('module');
  const originalResolveFilename = Module._resolveFilename;
  const { DatabaseCompat } = require('./db-adapter');

  Module._resolveFilename = function(request, parent) {
    if (request === 'better-sqlite3') {
      return require.resolve('./db-adapter-shim');
    }
    return originalResolveFilename.apply(this, arguments);
  };

  // 3. 加载真正的 server.js（它内部 require('better-sqlite3') 会被拦截）
  require('./server.js');
}

main().catch(err => {
  console.error('[致命错误] 启动失败:', err);
  process.exit(1);
});
