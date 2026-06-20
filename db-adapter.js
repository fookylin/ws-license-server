/**
 * better-sqlite3 兼容层（使用 sql.js 纯 JS 实现）
 * 
 * 使用方法：在启动脚本中先 require 此文件注册拦截，
 * 然后 server.js 中的 require('better-sqlite3') 会自动返回兼容对象。
 */

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

let SQL = null;
let dbInstance = null;
let currentDbPath = null;

// 初始化数据库（异步）
async function initDatabase(dbPath) {
  SQL = await initSqlJs();
  currentDbPath = dbPath;

  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    dbInstance = new SQL.Database(fileBuffer);
    console.log(`[数据库] 从文件加载: ${dbPath} (${(fileBuffer.length/1024).toFixed(1)}KB)`);
  } else {
    dbInstance = new SQL.Database();
    console.log(`[数据库] 创建新数据库: ${dbPath}`);
  }

  try { dbInstance.run('PRAGMA journal_mode=WAL'); } catch(e) {}
  try { dbInstance.run('PRAGMA foreign_keys=ON'); } catch(e) {}

  return dbInstance;
}

// 保存数据库到磁盘
function saveDatabase() {
  if (!dbInstance || !currentDbPath) return;
  const data = dbInstance.export();
  fs.writeFileSync(currentDbPath, Buffer.from(data));
}

// 兼容 better-sqlite3 的 Database 类
class DatabaseCompat {
  constructor(dbPath) {
    // 如果已经初始化过，直接使用已有实例
    if (!dbInstance) {
      throw new Error('数据库未初始化！请先调用 initDatabase()');
    }
    this._path = dbPath || currentDbPath;
  }

  pragma(stmt) {
    try { dbInstance.run('PRAGMA ' + stmt); } catch(e) {}
  }

  exec(sql) {
    dbInstance.run(sql);
  }

  prepare(sql) {
    return new StatementCompat(sql);
  }

  // 手动保存
  save() {
    saveDatabase();
  }
}

class StatementCompat {
  constructor(sql) {
    this._stmt = dbInstance.prepare(sql);
  }

  run(...params) {
    if (params.length > 0) this._stmt.bind(params);
    this._stmt.step();
    this._stmt.free();
    saveDatabase(); // 每次 write 操作后自动保存
    return { changes: dbInstance.getRowsModified(), lastInsertRowid: -1 };
  }

  get(...params) {
    if (params.length > 0) this._stmt.bind(params);
    const hasRow = this._stmt.step();
    const row = this._stmt.getAsObject();
    this._stmt.free();
    return hasRow ? row : undefined;
  }

  all(...params) {
    if (params.length > 0) this._stmt.bind(params);
    const results = [];
    while (this._stmt.step()) {
      results.push(this._stmt.getAsObject());
    }
    this._stmt.free();
    return results;
  }
}

module.exports = { initDatabase, DatabaseCompat, saveDatabase };
