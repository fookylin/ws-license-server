/**
 * WS多开管理器 — 后台服务端 (sql.js 版，匹配 schema.sql)
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
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
    // 异步备份到 GitHub（不影响主流程）
    backupToGitHub();
  } catch (e) {
    console.error('[数据库] 保存失败:', e.message);
  }
}

// ========== GitHub 数据库备份 ==========
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = 'fookylin/ws-license-server';
const BACKUP_BRANCH = 'main';
const BACKUP_PATH = 'data/backup.json';

function githubApi(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const tokenAuth = token || GITHUB_TOKEN;
    const opts = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `token ${tokenAuth}`,
        'User-Agent': 'ws-license-server',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      }
    };
    let data = '';
    const req = https.request(opts, res => {
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function backupToGitHub() {
  if (!GITHUB_TOKEN) return;
  try {
    // 导出数据库关键数据为 JSON
    const licenseKeys = db.all('SELECT * FROM license_keys ORDER BY id');
    const admins = db.all('SELECT id, username, role, nickname, status, last_login_at, created_at FROM admins');
    const backup = {
      updated_at: new Date().toISOString(),
      license_keys: licenseKeys,
      admins
    };
    const content = Buffer.from(JSON.stringify(backup, null, 2)).toString('base64');

    // 尝试获取当前 backup 文件的 SHA（如果存在）
    let sha = null;
    try {
      const existing = await githubApi('GET', `/repos/${GITHUB_REPO}/contents/${BACKUP_PATH}?ref=${BACKUP_BRANCH}`);
      if (existing.status === 200 && existing.body.sha) sha = existing.body.sha;
    } catch (_) {}

    // 写入或更新文件
    const payload = { message: `backup: ${new Date().toISOString()}`, content, branch: BACKUP_BRANCH };
    if (sha) payload.sha = sha;
    const result = await githubApi('PUT', `/repos/${GITHUB_REPO}/contents/${BACKUP_PATH}`, payload);
    if (result.status === 200 || result.status === 201) {
      console.log('[GitHub备份] 成功');
    } else {
      console.error('[GitHub备份] 失败:', result.status, result.body);
    }
  } catch (e) {
    console.error('[GitHub备份] 异常:', e.message);
  }
}

async function restoreFromGitHub(SQL) {
  if (!GITHUB_TOKEN) return false;
  try {
    console.log('[数据库] 尝试从 GitHub 恢复备份...');
    const result = await githubApi('GET', `/repos/${GITHUB_REPO}/contents/${BACKUP_PATH}?ref=${BACKUP_BRANCH}`);
    if (result.status !== 200) {
      console.log('[数据库] GitHub 无备份文件');
      return false;
    }
    const content = Buffer.from(result.body.content, 'base64').toString('utf8');
    const backup = JSON.parse(content);
    
    // 创建内存数据库并导入数据
    db = new SQL.Database();
    
    // 初始化 schema
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    db.exec(schema);
    
    // 恢复 license_keys
    if (backup.license_keys && backup.license_keys.length > 0) {
      const stmt = db.prepare(`INSERT INTO license_keys 
        (id, key_code, type, duration_days, account_limit, status, price, user_id, order_id, device_fingerprint, activated_at, expires_at, remark, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const k of backup.license_keys) {
        stmt.run(k.id, k.key_code, k.type, k.duration_days, k.account_limit, k.status, k.price, k.user_id, k.order_id, k.device_fingerprint, k.activated_at, k.expires_at, k.remark, k.created_by, k.created_at);
      }
      console.log(`[数据库] 恢复 ${backup.license_keys.length} 条密钥`);
    }
    
    // 恢复 admins（保留默认 admin 密码）
    if (backup.admins && backup.admins.length > 0) {
      // 先删除默认 admin，再恢复备份的
      db.run("DELETE FROM admins WHERE username = 'admin'");
      const stmt = db.prepare(`INSERT INTO admins (id, username, password, role, nickname, status, last_login_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      let restoredAdmins = 0;
      for (const a of backup.admins) {
        if (!a.username) continue; // 跳过无效数据
        stmt.run(a.id, a.username, a.password, a.role, a.nickname || '', a.status, a.last_login_at, a.created_at);
        restoredAdmins++;
      }
      // 确保 admin 密码正确
      const hash = bcrypt.hashSync('xiaojunge', 10);
      db.run(`UPDATE admins SET password = '${hash}' WHERE username = 'admin'`);
      console.log(`[数据库] 恢复 ${restoredAdmins} 个管理员`);
    }
    
    saveDatabase();
    console.log('[数据库] 从 GitHub 恢复成功');
    return true;
  } catch (e) {
    console.error('[数据库] 从 GitHub 恢复失败:', e.message);
    return false;
  }
}

async function initDatabase() {
  const SQL = await initSqlJs();
  
  if (fs.existsSync(DB_PATH)) {
    console.log('[数据库] 从磁盘加载');
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else if (await restoreFromGitHub(SQL)) {
    // 已从 GitHub 恢复，db 已设置
    const _prepare = db.prepare.bind(db);
    const _exec = db.exec.bind(db);
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
    return;
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

// 生成授权密钥（4段格式：WS-16hex-16hex-base36(创建时间戳)）
function generateLicenseKey(prefix = 'WS') {
  const part1 = crypto.randomBytes(8).toString('hex').toUpperCase();
  const part2 = crypto.randomBytes(8).toString('hex').toUpperCase();
  const ts = Math.floor(Date.now() / 1000).toString(36).toUpperCase();
  return `${prefix}-${part1}-${part2}-${ts}`;
}

// 生成激活后的更新密钥（第4段替换为过期时间戳 base36）
function generateUpdatedKey(originalKey, expiresAtMs) {
  try {
    const parts = originalKey.split('-');
    if (parts.length >= 4) {
      // 永久密钥：第4段=PERM；限时密钥：第4段=base36(unix秒级过期时间戳)
      const expiresTs = expiresAtMs != null
        ? Math.floor(expiresAtMs / 1000).toString(36).toUpperCase()
        : 'PERM';
      return `${parts[0]}-${parts[1]}-${parts[2]}-${expiresTs}`;
    }
    return originalKey;
  } catch { return originalKey; }
}

// 标准化 key：将 updatedKey（第4段可能是 PERM 或新时间戳）还原为数据库中的原始 key
// 策略：取前3段+通配符 LIKE 查库，兼容第4段变化
function normalizeKeyForDb(key) {
  const parts = key.split('-');
  if (parts.length === 4) {
    const baseKey = `${parts[0]}-${parts[1]}-${parts[2]}`;
    const found = db.get('SELECT key_code FROM license_keys WHERE key_code LIKE ? LIMIT 1', baseKey + '%');
    if (found) return found.key_code;
    return key; // 兜底：可能用户输入的就是原始key
  }
  return key;
}

// ========== 中间件 ==========
app.use(cors());
app.use(express.json());

// 兼容旧书签：/admin 或 /admin/ → /
app.get('/admin', (req, res) => res.redirect('/'));
app.get('/admin/', (req, res) => res.redirect('/'));

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

// ================================================================
//  API — 客户端直接调用（激活/验证，无需用户登录）
// ================================================================

// POST /api/activate — 激活密钥（客户端联网激活）
app.post('/api/activate', (req, res) => {
  try {
    const { key, machine_code } = req.body;
    if (!key) return res.status(400).json({ success: false, error: '密钥不能为空' });
    if (!machine_code) return res.status(400).json({ success: false, error: '机器码不能为空' });

    // 标准化 key：第4段可能是 PERM 或过期时间戳，统一取前3段+原时间戳查库
    const normalizedKey = normalizeKeyForDb(key.trim());
    const keyRecord = db.get('SELECT * FROM license_keys WHERE key_code = ?', normalizedKey);

    if (!keyRecord) {
      return res.json({ success: false, error: 'KEY_NOT_FOUND', message: '密钥不存在' });
    }
    if (keyRecord.status === 2) {
      return res.json({ success: false, error: 'KEY_DISABLED', message: '密钥已被禁用' });
    }

    // 检查是否过期
    if (keyRecord.status === 3 || (keyRecord.expires_at && new Date(keyRecord.expires_at) < new Date())) {
      if (keyRecord.status !== 3) {
        db.run('UPDATE license_keys SET status = 3 WHERE id = ?', keyRecord.id);
        saveDatabase();
      }
      return res.json({ success: false, error: 'KEY_EXPIRED', message: '密钥已过期' });
    }

    // 密钥已激活（status=1）— 验证设备指纹
    if (keyRecord.status === 1) {
      // 如果没有记录指纹（数据库被重置后首条记录），直接通过并更新指纹
      if (!keyRecord.device_fingerprint) {
        db.run('UPDATE license_keys SET device_fingerprint = ? WHERE id = ?', machine_code, keyRecord.id);
        saveDatabase();
        const expiresAtMs = keyRecord.expires_at ? new Date(keyRecord.expires_at).getTime() : null;
        const updatedKey = generateUpdatedKey(normalizedKey, expiresAtMs);
        return res.json({
          success: true, message: '激活成功',
          updatedKey, server_time: Date.now(),
          expires_at: keyRecord.expires_at
        });
      }
      // 指纹完全一致 → 通过
      if (keyRecord.device_fingerprint === machine_code) {
        const expiresAtMs = keyRecord.expires_at ? new Date(keyRecord.expires_at).getTime() : null;
        const updatedKey = generateUpdatedKey(normalizedKey, expiresAtMs);
        return res.json({
          success: true, message: '激活成功（已绑定本设备）',
          updatedKey, server_time: Date.now(),
          expires_at: keyRecord.expires_at
        });
      }
      // 指纹不一致 → 真正在不同设备上激活，拒绝
      return res.json({ success: false, error: 'DEVICE_REPLACED', reason: '该密钥已在其他设备上激活，本机授权已失效' });
    }

    // 执行首次激活（status=0）
    let expiresAt = null;
    if (keyRecord.type === 'time') {
      expiresAt = new Date(Date.now() + (keyRecord.duration_days || 30) * 86400000).toISOString();
    }
    db.run('UPDATE license_keys SET status = 1, activated_at = ?, expires_at = ?, device_fingerprint = ? WHERE id = ?',
      new Date().toISOString(), expiresAt, machine_code, keyRecord.id);
    saveDatabase();

    const updatedKey = generateUpdatedKey(normalizedKey, expiresAt ? new Date(expiresAt).getTime() : null);
    res.json({
      success: true, message: '激活成功', updatedKey, server_time: Date.now(),
      expires_at: expiresAt
    });
  } catch (err) {
    console.error('[激活] 失败:', err);
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: '服务器内部错误' });
  }
});

// POST /api/verify — 验证密钥（客户端联网验证）
app.post('/api/verify', (req, res) => {
  try {
    const { key, machine_code } = req.body;
    if (!key) return res.status(400).json({ valid: false, error: '密钥不能为空' });
    if (!machine_code) return res.status(400).json({ valid: false, error: '机器码不能为空' });

    // 标准化 key
    const normalizedKey = normalizeKeyForDb(key.trim());
    const keyRecord = db.get('SELECT * FROM license_keys WHERE key_code = ?', normalizedKey);

    if (!keyRecord) return res.json({ valid: false, error: 'KEY_NOT_FOUND', reason: '密钥不存在' });
    if (keyRecord.status === 2) return res.json({ valid: false, error: 'KEY_DISABLED', reason: '密钥已被禁用' });
    if (keyRecord.status === 0) return res.json({ valid: false, error: 'NOT_ACTIVATED', reason: '密钥尚未激活' });

    // 检查过期
    if (keyRecord.status === 3 || (keyRecord.expires_at && new Date(keyRecord.expires_at) < new Date())) {
      if (keyRecord.status !== 3) {
        db.run('UPDATE license_keys SET status = 3 WHERE id = ?', keyRecord.id);
        saveDatabase();
      }
      return res.json({ valid: false, error: 'KEY_EXPIRED', reason: '密钥已过期' });
    }

    // 验证设备指纹
    // 如果没有记录指纹（数据库被重置后），允许通过并补录指纹
    if (keyRecord.device_fingerprint) {
      if (keyRecord.device_fingerprint !== machine_code) {
        return res.json({ valid: false, error: 'DEVICE_REPLACED', reason: '该密钥已在其他设备上激活，本机授权已失效' });
      }
    } else {
      // 补录指纹
      db.run('UPDATE license_keys SET device_fingerprint = ? WHERE id = ?', machine_code, keyRecord.id);
      saveDatabase();
    }

    res.json({
      valid: true, server_time: Date.now(),
      expires_at: keyRecord.expires_at
    });
  } catch (err) {
    console.error('[验证] 失败:', err);
    res.status(500).json({ valid: false, error: 'SERVER_ERROR', reason: '服务器内部错误' });
  }
});

// ========== 禁用/启用密钥 ==========

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

// ========== 补充 API 路由 ==========

// 用户管理
app.get('/api/admin/users', authenticateToken, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;
  const search = req.query.search || '';
  const status = req.query.status || '';
  
  let where = '1=1';
  const params = [];
  if (search) { where += ' AND (email LIKE ? OR phone LIKE ? OR nickname LIKE ? OR invite_code LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
  if (status) { where += ' AND status = ?'; params.push(parseInt(status)); }
  
  const users = db.all(`SELECT id, email, phone, nickname, invite_code, inviter_id, status, balance, total_recharged, created_at FROM users WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
  const total = db.get(`SELECT COUNT(*) as count FROM users WHERE ${where}`, ...params).count;
  
  res.json({ success: true, users, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
});

app.post('/api/admin/users', authenticateToken, (req, res) => {
  const { email, phone, nickname, password } = req.body;
  if (!email && !phone) return res.status(400).json({ success: false, message: '邮箱或手机号必填' });
  const invite_code = crypto.randomBytes(4).toString('hex').toUpperCase();
  const hash = password ? bcrypt.hashSync(password, 10) : '';
  const result = db.run('INSERT INTO users (email, phone, nickname, password, invite_code, status) VALUES (?, ?, ?, ?, ?, 1)', email, phone, nickname, hash, invite_code);
  saveDatabase();
  const user = db.get('SELECT id, email, phone, nickname, invite_code, status, created_at FROM users WHERE id = ?', result.lastInsertRowid);
  res.json({ success: true, user });
});

// 订单管理
app.get('/api/admin/orders', authenticateToken, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;
  const status = req.query.status || '';
  
  let where = '1=1';
  const params = [];
  if (status) { where += ' AND status = ?'; params.push(status); }
  
  const orders = db.all(`SELECT * FROM orders WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
  const total = db.get(`SELECT COUNT(*) as count FROM orders WHERE ${where}`, ...params).count;
  
  res.json({ success: true, orders, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
});

app.post('/api/admin/orders/:id/confirm', authenticateToken, (req, res) => {
  const order = db.get('SELECT * FROM orders WHERE id = ?', req.params.id);
  if (!order) return res.status(404).json({ success: false, message: '订单不存在' });
  if (order.status !== 'pending') return res.status(400).json({ success: false, message: '订单状态不允许' });
  
  db.run("UPDATE orders SET status = 'completed', confirmed_at = ? WHERE id = ?", new Date().toISOString(), req.params.id);
  
  // 生成密钥
  const key = generateLicenseKey('WS');
  db.run('INSERT INTO license_keys (key_code, type, duration_days, status, user_id, order_id, created_by) VALUES (?, ?, ?, 1, ?, ?, ?)',
    key, order.key_type, order.duration_days, order.user_id, order.id, req.user.id);
  res.json({ success: true, message: '订单已确认', key });
});

// 分销管理
app.get('/api/admin/commissions', authenticateToken, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;
  
  const commissions = db.all('SELECT * FROM commissions ORDER BY created_at DESC LIMIT ? OFFSET ?', limit, offset);
  const total = db.get('SELECT COUNT(*) as count FROM commissions').count;
  
  res.json({ success: true, commissions, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
});

// 操作日志
app.get('/api/admin/logs', authenticateToken, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const offset = (page - 1) * limit;
  
  const logs = db.all('SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT ? OFFSET ?', limit, offset);
  const total = db.get('SELECT COUNT(*) as count FROM admin_logs').count;
  
  res.json({ success: true, logs, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
});

// 系统设置
app.get('/api/admin/settings', authenticateToken, (req, res) => {
  const settings = db.all('SELECT * FROM settings');
  const obj = {};
  settings.forEach(s => obj[s.key] = s.value);
  res.json({ success: true, settings: obj });
});

app.post('/api/admin/settings', authenticateToken, (req, res) => {
  Object.entries(req.body).forEach(([k, v]) => {
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", k, v);
  });
  saveDatabase();
  res.json({ success: true, message: '设置已保存' });
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
