/**
 * Render 启动入口
 * 先异步初始化 sql.js 数据库，再加载 server.js
 * 支持从 GitHub 自动恢复数据库备份（免费实例无 Disk）
 */

const path = require('path');
const fs = require('fs');
const { fetchBackup, pushBackup } = require('./github-db-backup');

// 从环境变量或默认路径获取数据库路径
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'admin.db');

// 备份上传间隔（毫秒）：5分钟
const BACKUP_INTERVAL_MS = 5 * 60 * 1000;

async function main() {
  console.log('=== Render 启动入口 ===');
  console.log('Node:', process.version);
  console.log('数据库路径:', DB_PATH);

  // 0. 检测本地是否有数据库，没有则从 GitHub 拉取备份
  if (!fs.existsSync(DB_PATH) || fs.statSync(DB_PATH).size === 0) {
    console.log('[启动] 📥 本地无数据库或为空，尝试从 GitHub 拉取备份...');
    const restored = await fetchBackup(DB_PATH);
    if (!restored) {
      console.log('[启动] ℹ️ 无可用备份，将创建新数据库（首次部署正常）');
    }
  }

  // 1. 初始化 sql.js 数据库
  const { initDatabase, saveDatabase } = require('./db-adapter');
  await initDatabase(DB_PATH);

  // 2. 定时备份到 GitHub（每5分钟）
  if (process.env.GITHUB_TOKEN) {
    console.log('[启动] ✅ GitHub 备份已启用，每 5 分钟自动同步');
    setInterval(async () => {
      try {
        saveDatabase(); // 先保存 sql.js 内存数据到磁盘
        await pushBackup(DB_PATH);
      } catch (e) {
        console.error('[GitHub备份] ⚠️ 定时备份失败:', e.message);
      }
    }, BACKUP_INTERVAL_MS);

    // 进程退出前也备份一次
    process.on('SIGTERM', async () => {
      console.log('[启动] 收到 SIGTERM，执行最终备份...');
      try { saveDatabase(); await pushBackup(DB_PATH); } catch(e) {}
      process.exit(0);
    });
  }

  // 3. 拦截 better-sqlite3 的 require，返回我们的兼容对象
  const Module = require('module');
  const originalResolveFilename = Module._resolveFilename;
  const { DatabaseCompat } = require('./db-adapter');

  Module._resolveFilename = function(request, parent) {
    if (request === 'better-sqlite3') {
      return require.resolve('./db-adapter-shim');
    }
    return originalResolveFilename.apply(this, arguments);
  };

  // 4. 加载真正的 server.js（它内部 require('better-sqlite3') 会被拦截）
  require('./server.js');
}

main().catch(err => {
  console.error('[致命错误] 启动失败:', err);
  process.exit(1);
});
