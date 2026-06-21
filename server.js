/**
 * WS多开管理器 — 后台服务端 (sql.js 版，匹配 schema.sql)
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const initSqlJs = require('sql.js');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'ws-multi-admin-jwt-secret-2026';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'admin.db');

// 确保数据库目录存在
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let db;

function saveDatabase() {
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (e) {
    console.error('[数据库] 保存失败:', e.message);
  }
}

async function initDatabase() {
  const SQL = await initSqlJs();
  
  if (fs.existsSync(DB_PATH)) {
    console.log('[数据库] 从磁盘加载');
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    console.log('[数据库] 创建新数据库');
    db = new SQL.Database();
  }
  
  // 保存原生方法
  const _prepare = db.prepare.bind(db);
  const _exec = db.exec.bind(db);
  
  // 兼容层：模拟 better-sqlite3 的 prepare().run()/get()/all()
  db.prepare = function(sqlText) {
    return {
      run: (...params) => {
        let stmt;
        try {
          stmt = _prepare(sqlText);
          if (params.length > 0) stmt.bind(params);
          stmt.step();
          stmt.free();
        } catch (e) { if (stmt) stmt.free(); throw e; }
        const r = _exec('SELECT last_insert_rowid() as lid, changes() as chg');
        const lid = (r[0] && r[0].values[0]) ? r[0].values[0][0] : 0;
        const chg = (r[0] && r[0].values[0]) ? r[0].values[0][1] : 0;
        return { lastInsertRowid: lid, changes: chg };
      },
      get: (...params) => {
        let stmt, row;
        try {
          stmt = _prepare(sqlText);
          if (params.length > 0) stmt.bind(params);
          if (stmt.step()) row = stmt.getAsObject();
          stmt.free();
        } catch (e) { if (stmt) stmt.free(); throw e; }
        return row;
      },
      all: (...params) => {
        let stmt;
        const rows = [];
        try {
          stmt = _prepare(sqlText);
          if (params.length > 0) stmt.bind(params);
          while (stmt.step()) rows.push(stmt.getAsObject());
          stmt.free();
        } catch (e) { if (stmt) stmt.free(); throw e; }
        return rows;
      }
    };
  };
  db.get = (sql, ...p) => db.prepare(sql).get(...p);
  db.all = (sql, ...p) => db.prepare(sql).all(...p);
  db.run = (sql, ...p) => db.prepare(sql).run(...p);
  
  // 初始化 schema
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  
  // 修正 admin 密码
  try {
    const hash = bcrypt.hashSync('xiaojunge', 10);
    db.run(`UPDATE admins SET password = '${hash}' WHERE username = 'admin'`);
  } catch (e) {
    console.error('[数据库] 设置密码失败:', e.message);
  }
  
  saveDatabase();
  console.log('[数据库] 初始化完成');
}

// ========== 工具函数 ==========
function normalizeKeyForDb(key) {
  return key.toUpperCase().replace(/-/g, '');
}

function generateLicenseKey(prefix = 'WS') {
  const p1 = crypto.randomBytes(2).toString('hex').toUpperCase();
  const p2 = crypto.randomBytes(2).toString('hex').toUpperCase();
  const p3 = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${prefix}-${p1}-${p2}-${p3}`;
}

// ========== 中间件 ==========
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// ========== 路由 ==========

app.get('/api/health', (req, res) => {
  try {
    db.get('SELECT COUNT(*) as count FROM license_keys');
    res.json({ status: 'ok', timestamp: new Date().toISOString(), database: 'connected' });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, message: '用户名和密码不能为空' });
  
  const admin = db.get('SELECT * FROM admins WHERE username = ?', username);
  if (!admin) return res.status(401).json({ success: false, message: '用户名或密码错误' });
  if (!bcrypt.compareSync(password, admin.password)) return res.status(401).json({ success: false, message: '用户名或密码错误' });
  
  const token = jwt.sign({ id: admin.id, username: admin.username }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ success: true, token });
});

// 获取密钥列表
app.get('/api/admin/keys', authenticateToken, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;
  
  const keys = db.all('SELECT * FROM license_keys ORDER BY created_at DESC LIMIT ? OFFSET ?', limit, offset);
  const total = db.get('SELECT COUNT(*) as count FROM license_keys').count;
  
  res.json({ success: true, keys, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
});

// 生成密钥
app.post('/api/admin/keys/generate', authenticateToken, (req, res) => {
  try {
    const { count = 1, type = 'time', duration_days = 30, note = '' } = req.body;
    if (count < 1 || count > 100) return res.status(400).json({ success: false, message: '数量必须在 1-100 之间' });
    
    const results = [];
    for (let i = 0; i < count; i++) {
      const key = generateLicenseKey('WS');
      const now = new Date().toISOString();
      
      // 匹配 schema: license_keys 表，字段 key_code, type, duration_days, remark, status, created_by
      const stmt = db.prepare(`
        INSERT INTO license_keys (key_code, type, duration_days, remark, status, price, created_by)
        VALUES (?, ?, ?, ?, 0, 0, ?)
      `);
      const result = stmt.run(key, type, duration_days, note, req.user.id);
      const newKey = db.get('SELECT * FROM license_keys WHERE id = ?', result.lastInsertRowid);
      results.push(newKey);
    }
    saveDatabase();
    res.json({ success: true, keys: results });
  } catch (err) {
    console.error('[生成密钥] 错误:', err);
    res.status(500).json({ success: false, error: '生成密钥失败: ' + err.message });
  }
});

// 激活密钥
app.post('/api/activate', (req, res) => {
  const { key, machine_code, version = '2.0' } = req.body;
  if (!key || !machine_code) return res.status(400).json({ success: false, error: '密钥和机器码不能为空' });
  
  const normalizedKey = normalizeKeyForDb(key);
  // 用 key_code 查找，支持模糊匹配
  const keyRecord = db.get('SELECT * FROM license_keys WHERE key_code = ?', key);
  
  if (!keyRecord) return res.json({ success: false, error: '密钥不存在' });
  if (keyRecord.status === 2) return res.json({ success: false, error: '密钥已被禁用' });
  if (keyRecord.status === 3) return res.json({ success: false, error: '密钥已过期' });
  
  // 检查过期
  if (keyRecord.type !== 'permanent' && keyRecord.expires_at) {
    if (Date.now() > new Date(keyRecord.expires_at).getTime()) {
      db.run('UPDATE license_keys SET status = 3 WHERE id = ?', keyRecord.id);
      saveDatabase();
      return res.json({ success: false, error: '密钥已过期' });
    }
  }
  
  // 首次激活：设置 expires_at 和设备指纹
  if (keyRecord.status === 0) {
    let expiresAt = null;
    if (keyRecord.type === 'time' && keyRecord.duration_days > 0) {
      expiresAt = new Date(Date.now() + keyRecord.duration_days * 24 * 60 * 60 * 1000).toISOString();
    }
    db.run('UPDATE license_keys SET status = 1, activated_at = ?, expires_at = ?, device_fingerprint = ? WHERE id = ?',
      new Date().toISOString(), expiresAt, machine_code, keyRecord.id);
  }
  
  saveDatabase();
  const updated = db.get('SELECT * FROM license_keys WHERE id = ?', keyRecord.id);
  
  res.json({
    success: true,
    key: updated.key_code,
    type: updated.type,
    expires_at: updated.expires_at ? new Date(updated.expires_at).getTime() : null,
    message: '激活成功'
  });
});

// 验证密钥
app.post('/api/verify', (req, res) => {
  const { key, machine_code, version = '2.0' } = req.body;
  if (!key || !machine_code) return res.status(400).json({ success: false, error: '密钥和机器码不能为空' });
  
  const keyRecord = db.get('SELECT * FROM license_keys WHERE key_code = ?', key);
  if (!keyRecord) return res.json({ success: false, error: '密钥不存在' });
  if (keyRecord.status === 2) return res.json({ success: false, error: '密钥已被禁用' });
  if (keyRecord.status === 3) return res.json({ success: false, error: '密钥已过期' });
  
  // 验证设备指纹
  if (keyRecord.device_fingerprint && keyRecord.device_fingerprint !== machine_code) {
    return res.json({ success: false, error: '机器码不匹配' });
  }
  
  // 检查过期
  if (keyRecord.type !== 'permanent' && keyRecord.expires_at) {
    if (Date.now() > new Date(keyRecord.expires_at).getTime()) {
      db.run('UPDATE license_keys SET status = 3 WHERE id = ?', keyRecord.id);
      saveDatabase();
      return res.json({ success: false, error: '密钥已过期' });
    }
  }
  
  res.json({
    success: true,
    key: keyRecord.key_code,
    type: keyRecord.type,
    expires_at: keyRecord.expires_at ? new Date(keyRecord.expires_at).getTime() : null,
    message: '验证成功'
  });
});

// 禁用/启用密钥
app.post('/api/admin/keys/:id/toggle', authenticateToken, (req, res) => {
  const keyRecord = db.get('SELECT * FROM license_keys WHERE id = ?', req.params.id);
  if (!keyRecord) return res.status(404).json({ success: false, message: '密钥不存在' });
  const newStatus = keyRecord.status === 2 ? 1 : 2;
  db.run('UPDATE license_keys SET status = ? WHERE id = ?', newStatus, req.params.id);
  saveDatabase();
  res.json({ success: true, status: newStatus });
});

// 删除密钥
app.delete('/api/admin/keys/:id', authenticateToken, (req, res) => {
  const result = db.prepare('DELETE FROM license_keys WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ success: false, message: '密钥不存在' });
  saveDatabase();
  res.json({ success: true });
});

// 统计
app.get('/api/admin/stats', authenticateToken, (req, res) => {
  const totalKeys = db.get('SELECT COUNT(*) as count FROM license_keys').count;
  const activeKeys = db.get("SELECT COUNT(*) as count FROM license_keys WHERE status = 1").count;
  res.json({ success: true, stats: { totalKeys, activeKeys, totalActivations: 0 } });
});

// 修改密码
app.post('/api/admin/change-password', authenticateToken, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) return res.status(400).json({ success: false, message: '不能为空' });
  const admin = db.get('SELECT * FROM admins WHERE id = ?', req.user.id);
  if (!bcrypt.compareSync(oldPassword, admin.password)) return res.status(400).json({ success: false, message: '旧密码错误' });
  db.run('UPDATE admins SET password = ? WHERE id = ?', bcrypt.hashSync(newPassword, 10), req.user.id);
  saveDatabase();
  res.json({ success: true, message: '密码修改成功' });
});

// 全局错误处理
app.use((err, req, res, next) => {
  console.error('[Express 错误]', err);
  res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
});

// 启动
initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`[服务器] WS多开管理器后台已启动 端口:${PORT}`);
  });
}).catch(err => {
  console.error('[服务器] 初始化失败:', err);
  process.exit(1);
});
