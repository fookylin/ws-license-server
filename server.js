/**
 * WS多开管理器 — 后台服务端 (修复版：使用 sql.js)
 * Express + sql.js + JWT 认证
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const sql = require('sql.js');

// ========== 初始化 ==========
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'ws-multi-admin-jwt-secret-2026';

// ✅ 支持 Render 持久化磁盘
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'admin.db');

// 确保数据库目录存在
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
  console.log(`[数据库] 创建数据库目录: ${dbDir}`);
}

console.log(`[数据库] 使用路径: ${DB_PATH}`);

// ========== 数据库 (使用 sql.js) ==========
let db;

// 初始化数据库
function initDatabase() {
  if (fs.existsSync(DB_PATH)) {
    console.log('[数据库] 从磁盘加载现有数据库');
    const buffer = fs.readFileSync(DB_PATH);
    db = new sql.Database(buffer);
  } else {
    console.log('[数据库] 创建新数据库');
    db = new sql.Database();
  }
  
  // 初始化 schema
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  
  // 修正默认 admin 密码
  const admins = db.exec("SELECT id FROM admins WHERE username = 'admin'");
  if (admins.length > 0 && admins[0].values.length > 0) {
    const hash = bcrypt.hashSync('xiaojunge', 10);
    // 直接 exec UPDATE
    db.run(`UPDATE admins SET password = '${hash}' WHERE username = 'admin'`);
    saveDatabase();
  }
  
  console.log('[数据库] 初始化完成');
  saveDatabase();
}

// 保存数据库到磁盘
function saveDatabase() {
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
    console.log('[数据库] 已保存到磁盘');
  } catch (e) {
    console.error('[数据库] 保存失败:', e.message);
  }
}

// 初始化
initDatabase();

// ========== sql.js 兼容层（正确实现 better-sqlite3 API）==========
// 先保存原生 sql.js 方法，避免覆盖后内部递归调用
const nativeRun = db.run.bind(db);
const nativeExec = db.exec.bind(db);

function prepareStatement(sqlText) {
  function bindParams(sql, params) {
    let paramIndex = 0;
    return sql.replace(/\?/g, () => {
      if (paramIndex >= params.length) return '?';
      const param = params[paramIndex++];
      if (param === null || param === undefined) return 'NULL';
      if (typeof param === 'number') return param.toString();
      if (typeof param === 'boolean') return param ? '1' : '0';
      return "'" + String(param).replace(/'/g, "''") + "'";
    });
  }

  return {
    run: (...params) => {
      const finalSql = bindParams(sqlText, params);
      console.log(`[SQL RUN] ${finalSql}`);
      nativeExec(finalSql); // ✅ 用 exec 执行 INSERT/UPDATE/DELETE，避免 run 的兼容性问题

      const result = nativeExec('SELECT last_insert_rowid() as lid, changes() as chg');
      const lastInsertRowid = (result[0] && result[0].values[0]) ? result[0].values[0][0] : 0;
      const changes = (result[0] && result[0].values[0]) ? result[0].values[0][1] : 0;

      return { lastInsertRowid, changes };
    },

    get: (...params) => {
      const finalSql = bindParams(sqlText, params);
      console.log(`[SQL GET] ${finalSql}`);
      const result = nativeExec(finalSql);

      if (result.length > 0 && result[0].values.length > 0) {
        const row = {};
        result[0].columns.forEach((col, index) => {
          row[col] = result[0].values[0][index];
        });
        return row;
      }
      return undefined;
    },

    all: (...params) => {
      const finalSql = bindParams(sqlText, params);
      console.log(`[SQL ALL] ${finalSql}`);
      const result = nativeExec(finalSql);

      if (result.length > 0) {
        return result[0].values.map(rowValues => {
          const row = {};
          result[0].columns.forEach((col, index) => {
            row[col] = rowValues[index];
          });
          return row;
        });
      }
      return [];
    }
  };
}

// 给 db 对象挂上 prepare 方法（兼容 better-sqlite3）
db.prepare = prepareStatement;

// 给 db 挂上 get / all / run 快捷方法（部分代码可能直接用 db.get()）
db.get = function(sqlText, ...params) {
  return prepareStatement(sqlText).get(...params);
};

db.all = function(sqlText, ...params) {
  return prepareStatement(sqlText).all(...params);
};

db.run = function(sqlText, ...params) {
  return prepareStatement(sqlText).run(...params);
};

// ========== 工具函数 ==========
function normalizeKeyForDb(key) {
  return key.toUpperCase().replace(/-/g, '');
}

function generateLicenseKey(prefix = 'WS') {
  const part1 = crypto.randomBytes(2).toString('hex').toUpperCase();
  const part2 = crypto.randomBytes(2).toString('hex').toUpperCase();
  const part3 = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${prefix}-${part1}-${part2}-${part3}`;
}

function generateUpdatedLicenseKey(baseKey, expiresAtMs = null) {
  const cleanBase = baseKey.toUpperCase().replace(/-/g, '');
  const prefix = cleanBase.substring(0, 2);
  const part1 = cleanBase.substring(2, 6);
  const part2 = cleanBase.substring(6, 10);
  
  if (expiresAtMs === null || expiresAtMs === 'PERM') {
    return `${prefix}-${part1}-${part2}-PERM`;
  }
  
  const date = new Date(expiresAtMs);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${prefix}-${part1}-${part2}-${month}${day}`;
}

// ========== 中间件 ==========
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== 认证中间件 ==========
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

// --- 健康检查 ---
app.get('/api/health', (req, res) => {
  try {
    const result = db.get('SELECT COUNT(*) as count FROM keys');
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      database: 'connected',
      database_status: 'ok',
      env: process.env.NODE_ENV || 'production'
    });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// --- 登录 ---
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ success: false, message: '用户名和密码不能为空' });
  }
  
  const admin = db.get('SELECT * FROM admins WHERE username = ?', username);
  
  if (!admin) {
    return res.status(401).json({ success: false, message: '用户名或密码错误' });
  }
  
  const validPassword = bcrypt.compareSync(password, admin.password);
  if (!validPassword) {
    return res.status(401).json({ success: false, message: '用户名或密码错误' });
  }
  
  const token = jwt.sign(
    { id: admin.id, username: admin.username },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
  
  res.json({ success: true, token });
});

// --- 获取密钥列表（分页） ---
app.get('/api/admin/keys', authenticateToken, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;
  
  const keys = db.all(
    'SELECT * FROM keys ORDER BY created_at DESC LIMIT ? OFFSET ?',
    limit, offset
  );
  
  const totalResult = db.get('SELECT COUNT(*) as count FROM keys');
  const total = totalResult.count;
  const totalPages = Math.ceil(total / limit);
  
  res.json({
    success: true,
    keys,
    pagination: {
      page,
      limit,
      total,
      totalPages
    }
  });
});

// --- 生成密钥 ---
app.post('/api/admin/keys/generate', authenticateToken, (req, res) => {
  const { count = 1, type = 'time', duration_days = 30, note = '' } = req.body;
  
  if (count < 1 || count > 100) {
    return res.status(400).json({ success: false, message: '数量必须在 1-100 之间' });
  }
  
  const results = [];
  
  for (let i = 0; i < count; i++) {
    const key = generateLicenseKey('WS');
    const normalizedKey = normalizeKeyForDb(key);
    const now = new Date().toISOString();
    
    // 计算过期时间（从生成时刻算起）
    let expiresAt = null;
    if (type === 'time' && duration_days > 0) {
      expiresAt = new Date(Date.now() + duration_days * 24 * 60 * 60 * 1000).toISOString();
    }
    
    const stmt = db.prepare(`
      INSERT INTO keys (key, normalized_key, type, duration_days, note, created_at, expires_at, updated_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `);
    
    const result = stmt.run(key, normalizedKey, type, duration_days, note, now, expiresAt, null);
    
    if (result.changes === 0) {
      throw new Error('生成密钥失败');
    }
    
    const newKey = db.get('SELECT * FROM keys WHERE id = ?', result.lastInsertRowid);
    results.push(newKey);
  }
  
  saveDatabase();
  
  res.json({ success: true, keys: results });
});

// --- 激活密钥 ---
app.post('/api/activate', (req, res) => {
  const { key, machine_code, version = '2.0' } = req.body;
  
  if (!key || !machine_code) {
    return res.status(400).json({ success: false, error: '密钥和机器码不能为空' });
  }
  
  const normalizedKey = normalizeKeyForDb(key);
  const keyRecord = db.get(
    'SELECT * FROM keys WHERE normalized_key = ? OR key LIKE ?',
    normalizedKey, `%${normalizedKey.substring(0, 8)}%`
  );
  
  if (!keyRecord) {
    return res.json({ success: false, error: '密钥不存在' });
  }
  
  if (keyRecord.is_disabled) {
    return res.json({ success: false, error: '密钥已被禁用' });
  }
  
  if (keyRecord.used_count >= keyRecord.max_devices) {
    return res.json({ success: false, error: '激活次数已达上限' });
  }
  
  // 检查是否过期（永久密钥 type=PERM 或 expires_at 为空）
  if (keyRecord.type !== 'PERM' && keyRecord.expires_at) {
    const expiryDate = new Date(keyRecord.expires_at);
    if (Date.now() > expiryDate.getTime()) {
      return res.json({ success: false, error: '密钥已过期' });
    }
  }
  
  // 记录激活
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO activations (key_id, machine_code, activated_at, version)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(keyRecord.id, machine_code, now, version);
  
  // 更新使用次数
  db.run(
    'UPDATE keys SET used_count = used_count + 1 WHERE id = ?',
    keyRecord.id
  );
  
  // 如果是首次激活且有 duration_days，设置 expires_at
  if (!keyRecord.expires_at && keyRecord.duration_days > 0) {
    const expiresAt = new Date(Date.now() + keyRecord.duration_days * 24 * 60 * 60 * 1000).toISOString();
    db.run('UPDATE keys SET expires_at = ? WHERE id = ?', expiresAt, keyRecord.id);
  }
  
  saveDatabase();
  
  // 返回激活信息
  const updatedKeyRecord = db.get('SELECT * FROM keys WHERE id = ?', keyRecord.id);
  const expiresAt = updatedKeyRecord.expires_at ? new Date(updatedKeyRecord.expires_at).getTime() : null;
  
  res.json({
    success: true,
    key: updatedKeyRecord.key,
    type: updatedKeyRecord.type,
    expires_at: expiresAt,
    message: '激活成功'
  });
});

// --- 验证密钥 ---
app.post('/api/verify', (req, res) => {
  const { key, machine_code, version = '2.0' } = req.body;
  
  if (!key || !machine_code) {
    return res.status(400).json({ success: false, error: '密钥和机器码不能为空' });
  }
  
  const normalizedKey = normalizeKeyForDb(key);
  const keyRecord = db.get(
    'SELECT * FROM keys WHERE normalized_key = ? OR key LIKE ?',
    normalizedKey, `%${normalizedKey.substring(0, 8)}%`
  );
  
  if (!keyRecord) {
    return res.json({ success: false, error: '密钥不存在' });
  }
  
  if (keyRecord.is_disabled) {
    return res.json({ success: false, error: '密钥已被禁用' });
  }
  
  // 检查是否过期
  if (keyRecord.type !== 'PERM' && keyRecord.expires_at) {
    const expiryDate = new Date(keyRecord.expires_at);
    if (Date.now() > expiryDate.getTime()) {
      return res.json({ success: false, error: '密钥已过期' });
    }
  }
  
  // 检查机器码是否匹配
  const activation = db.get(
    'SELECT * FROM activations WHERE key_id = ? AND machine_code = ?',
    keyRecord.id, machine_code
  );
  
  if (!activation) {
    return res.json({ success: false, error: '机器码不匹配，请联系管理员' });
  }
  
  // 更新最后验证时间
  const now = new Date().toISOString();
  db.run(
    'UPDATE activations SET last_verified_at = ? WHERE id = ?',
    now, activation.id
  );
  saveDatabase();
  
  res.json({
    success: true,
    key: keyRecord.key,
    type: keyRecord.type,
    expires_at: keyRecord.expires_at ? new Date(keyRecord.expires_at).getTime() : null,
    message: '验证成功'
  });
});

// --- 禁用/启用密钥 ---
app.post('/api/admin/keys/:id/toggle', authenticateToken, (req, res) => {
  const { id } = req.params;
  const keyRecord = db.get('SELECT * FROM keys WHERE id = ?', id);
  
  if (!keyRecord) {
    return res.status(404).json({ success: false, message: '密钥不存在' });
  }
  
  const newStatus = keyRecord.is_disabled ? 0 : 1;
  db.run('UPDATE keys SET is_disabled = ? WHERE id = ?', newStatus, id);
  saveDatabase();
  
  res.json({ success: true, disabled: !!newStatus });
});

// --- 删除密钥 ---
app.delete('/api/admin/keys/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  
  const stmt = db.prepare('DELETE FROM keys WHERE id = ?');
  const result = stmt.run(id);
  
  if (result.changes === 0) {
    return res.status(404).json({ success: false, message: '密钥不存在' });
  }
  
  saveDatabase();
  res.json({ success: true });
});

// --- 获取统计数据 ---
app.get('/api/admin/stats', authenticateToken, (req, res) => {
  const totalKeys = db.get('SELECT COUNT(*) as count FROM keys').count;
  const activeKeys = db.get("SELECT COUNT(*) as count FROM keys WHERE is_disabled = 0").count;
  const totalActivations = db.get('SELECT COUNT(*) as count FROM activations').count;
  
  res.json({
    success: true,
    stats: {
      totalKeys,
      activeKeys,
      totalActivations
    }
  });
});

// --- 修改密码 ---
app.post('/api/admin/change-password', authenticateToken, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ success: false, message: '旧密码和新密码不能为空' });
  }
  
  const admin = db.get('SELECT * FROM admins WHERE id = ?', req.user.id);
  
  const validPassword = bcrypt.compareSync(oldPassword, admin.password);
  if (!validPassword) {
    return res.status(400).json({ success: false, message: '旧密码错误' });
  }
  
  const hash = bcrypt.hashSync(newPassword, 10);
  db.run('UPDATE admins SET password = ? WHERE id = ?', hash, req.user.id);
  saveDatabase();
  
  res.json({ success: true, message: '密码修改成功' });
});

// ========== 启动服务器 ==========
app.listen(PORT, () => {
  console.log(`[服务器] WS多开管理器后台已启动`);
  console.log(`[服务器] 监听端口: ${PORT}`);
  console.log(`[服务器] 管理后台: http://localhost:${PORT}/admin`);
  console.log(`[数据库] 路径: ${DB_PATH}`);
});

// 全局错误处理（返回 JSON 便于调试）
app.use((err, req, res, next) => {
  console.error('[Express 错误]', err);
  res.status(500).json({
    success: false,
    error: err.message || 'Internal Server Error',
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack
  });
});
