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
const sql = require('sql.js'); // ✅ 使用 sql.js 替代 better-sqlite3

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
  const admins = db.exec('SELECT id FROM admins WHERE username = "admin"');
  if (admins.length > 0 && admins[0].values.length > 0) {
    const hash = bcrypt.hashSync('xiaojunge', 10);
    db.run('UPDATE admins SET password = ? WHERE username = ?', [hash, 'admin']);
    saveDatabase();
  }
  
  console.log('[数据库] 初始化完成');
  saveDatabase();
}

// 保存数据库到磁盘
function saveDatabase() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
  console.log('[数据库] 已保存到磁盘');
}

// 初始化
initDatabase();

// sql.js 兼容层（模拟 better-sqlite3 API）
db.prepare = function(sqlText) {
  return {
    run: (...params) => {
      // 替换参数占位符 ? 为实际值
      let finalSql = sqlText;
      if (params && params.length > 0) {
        params.forEach((param, index) => {
          finalSql = finalSql.replace('?', typeof param === 'string' ? `'${param}'` : param);
        });
      }
      db.run(finalSql);
      return { lastInsertRowid: db.exec('SELECT last_insert_rowid()')[0]['last_insert_rowid()'], changes: 1 };
    },
    get: (...params) => {
      let finalSql = sqlText;
      if (params && params.length > 0) {
        params.forEach((param) => {
          finalSql = finalSql.replace('?', typeof param === 'string' ? `'${param}'` : param);
        });
      }
      const result = db.exec(finalSql);
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
      let finalSql = sqlText;
      if (params && params.length > 0) {
        params.forEach((param) => {
          finalSql = finalSql.replace('?', typeof param === 'string' ? `'${param}'` : param);
        });
      }
      const result = db.exec(finalSql);
      if (result.length > 0) {
        return result[0].values.map(row => {
          const obj = {};
          result[0].columns.forEach((col, index) => {
            obj[col] = row[index];
          });
          return obj;
        });
      }
      return [];
    }
  };
};

db.pragma = function(pragma) {
  db.exec('PRAGMA ' + pragma);
};

// ========== 中间件 ==========
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 静态文件（管理面板 UI）
app.use('/admin', express.static(path.join(__dirname, 'public')));
app.use('/recharge', express.static(path.join(__dirname, 'public-recharge')));

// ========== JWT 认证中间件 ==========
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录' });
  }
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: '登录已过期' });
  }
}

function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.split(' ')[1];
      req.admin = jwt.verify(token, JWT_SECRET);
    } catch (_) {}
  }
  next();
}

// ========== 工具函数 ==========

// 健康检查端点（无需认证）
app.get('/api/health', (req, res) => {
  try {
    // 检查数据库连接
    const result = db.exec('SELECT 1');
    const dbStatus = result && result.length > 0 ? 'ok' : 'error';
    
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      database: DB_PATH,
      database_status: dbStatus,
      env: {
        PORT: process.env.PORT || '(default) 3000',
        DB_PATH: process.env.DB_PATH || '(default) local data dir',
        NODE_ENV: process.env.NODE_ENV || 'development'
      }
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      error: err.message,
      database: DB_PATH
    });
  }
});

// 生成授权密钥
function generateLicenseKey() {
  const prefix = 'WS';
  const part1 = crypto.randomBytes(8).toString('hex').toUpperCase();
  const part2 = crypto.randomBytes(8).toString('hex').toUpperCase();
  const ts = Math.floor(Date.now() / 1000).toString(36).toUpperCase();
  return `${prefix}-${part1}-${part2}-${ts}`;
}

// 生成邀请码
function generateInviteCode(length = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// 生成订单号
function generateOrderNo() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `WS${ts}${rand}`;
}

// 记录管理员操作日志
function logAdminAction(adminId, action, targetType, targetId, detail, ip) {
  db.run(`INSERT INTO admin_logs (admin_id, action, target_type, target_id, detail, ip)
    VALUES (?, ?, ?, ?, ?, ?)`, [adminId, action, targetType, targetId, detail, ip || '']);
  saveDatabase();
}

// ====================================================================
//  API — 管理员认证
// ====================================================================

// 管理员登录
app.post('/api/admin/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: '请输入用户名和密码' });
    }

    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get([username]);
    if (!admin) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    if (admin.status === 0) {
      return res.status(403).json({ error: '账户已被禁用' });
    }

    const valid = bcrypt.compareSync(password, admin.password);
    if (!valid) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    // 更新最后登录时间
    db.run(`UPDATE admins SET last_login_at = datetime('now','localtime') WHERE id = ?`, [admin.id]);
    saveDatabase();

    const token = jwt.sign(
      { id: admin.id, username: admin.username, role: admin.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    logAdminAction(admin.id, 'login', 'admin', admin.id, '管理员登录', req.ip);

    res.json({
      token,
      admin: {
        id: admin.id,
        username: admin.username,
        role: admin.role,
        nickname: admin.nickname,
      }
    });
  } catch (err) {
    console.error('登录失败:', err);
    res.status(500).json({ error: '登录失败' });
  }
});

// 获取当前管理员信息
app.get('/api/admin/me', authMiddleware, (req, res) => {
  const admin = db.prepare('SELECT id, username, role, nickname, status, last_login_at, created_at FROM admins WHERE id = ?').get([req.admin.id]);
  if (!admin) return res.status(404).json({ error: '用户不存在' });
  res.json(admin);
});

// ====================================================================
//  API — 仪表盘统计
// ====================================================================

app.get('/api/admin/stats', authMiddleware, (req, res) => {
  try {
    const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users WHERE status != -1').get().c;
    const activeUsers = db.prepare('SELECT COUNT(*) as c FROM users WHERE status = 1').get().c;
    const todayRegs = db.prepare("SELECT COUNT(*) as c FROM users WHERE date(created_at) = date('now','localtime')").get().c;
    const totalKeys = db.prepare('SELECT COUNT(*) as c FROM license_keys').get().c;
    const activeKeys = db.prepare("SELECT COUNT(*) as c FROM license_keys WHERE status = 1 AND (expires_at IS NULL OR expires_at > datetime('now','localtime'))").get().c;
    const totalRevenue = db.prepare("SELECT COALESCE(SUM(amount),0) as c FROM orders WHERE payment_status = 1").get().c;
    const monthRevenue = db.prepare("SELECT COALESCE(SUM(amount),0) as c FROM orders WHERE payment_status = 1 AND strftime('%Y-%m',paid_at) = strftime('%Y-%m','now','localtime')").get().c;
    const todayRevenue = db.prepare("SELECT COALESCE(SUM(amount),0) as c FROM orders WHERE payment_status = 1 AND date(paid_at) = date('now','localtime')").get().c;

    // 最近7天注册趋势
    const regTrend = db.prepare(`
      SELECT date(created_at) as d, COUNT(*) as c
      FROM users
      WHERE created_at >= datetime('now','-7 days','localtime')
      GROUP BY date(created_at)
      ORDER BY d
    `).all();

    // 最近7天收入趋势
    const revTrend = db.prepare(`
      SELECT date(paid_at) as d, COALESCE(SUM(amount),0) as c
      FROM orders
      WHERE payment_status = 1 AND paid_at >= datetime('now','-7 days','localtime')
      GROUP BY date(paid_at)
      ORDER BY d
    `).all();

    // 密钥类型分布
    const keyTypes = db.prepare('SELECT type, COUNT(*) as c FROM license_keys GROUP BY type').all();

    // 支付方式统计
    const payMethods = db.prepare("SELECT COALESCE(payment_method,'未知') as method, COUNT(*) as c FROM orders WHERE payment_status = 1 GROUP BY payment_method").all();

    // 待处理订单
    const pendingOrders = db.prepare('SELECT COUNT(*) as c FROM orders WHERE payment_status = 0').get().c;

    res.json({
      totalUsers, activeUsers, todayRegs,
      totalKeys, activeKeys,
      totalRevenue, monthRevenue, todayRevenue,
      pendingOrders,
      regTrend: regTrend.map(r => ({ d: r.d, c: r.c })),
      revTrend: revTrend.map(r => ({ d: r.d, c: r.c })),
      keyTypes: keyTypes.map(t => ({ type: t.type, c: t.c })),
      payMethods: payMethods.map(p => ({ method: p.method, c: p.c }))
    });
  } catch (err) {
    console.error('获取统计失败:', err);
    res.status(500).json({ error: '获取统计失败: ' + err.message });
  }
});

// ====================================================================
//  API — 激活码管理（修复：移除 db.transaction）
// ====================================================================

// 生成激活码
app.post('/api/admin/keys/generate', authMiddleware, (req, res) => {
  try {
    const { count = 1, type = 'time', duration_days = 30, note = '' } = req.body;
    
    if (count < 1 || count > 100) {
      return res.status(400).json({ error: '数量必须在 1-100 之间' });
    }

    const keys = [];
    const now = new Date().toISOString();
    
    for (let i = 0; i < count; i++) {
      const key = generateLicenseKey();
      const expiresAt = type === 'permanent' ? null : 
        new Date(Date.now() + duration_days * 24 * 60 * 60 * 1000).toISOString();
      
      // ✅ 修复：逐条插入，不使用 db.transaction
      db.run(`INSERT INTO license_keys (key, type, duration_days, expires_at, status, note, created_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)`, 
        [key, type, duration_days, expiresAt, note, now]);
      
      keys.push({
        key,
        type,
        duration_days,
        expires_at: expiresAt,
        note
      });
    }
    
    saveDatabase(); // ✅ 保存数据库
    
    logAdminAction(req.admin.id, 'generate_keys', 'license_keys', null, `生成 ${count} 个激活码`, req.ip);
    
    res.json({ success: true, keys });
  } catch (err) {
    console.error('生成激活码失败:', err);
    res.status(500).json({ error: '生成激活码失败: ' + err.message });
  }
});

// 获取激活码列表
app.get('/api/admin/keys', authMiddleware, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 20;
    const offset = (page - 1) * pageSize;
    
    const keys = db.prepare(`
      SELECT k.*, u.username as used_by_username
      FROM license_keys k
      LEFT JOIN users u ON k.used_by = u.id
      ORDER BY k.created_at DESC
      LIMIT ? OFFSET ?
    `).all([pageSize, offset]);
    
    const total = db.prepare('SELECT COUNT(*) as c FROM license_keys').get().c;
    
    res.json({
      keys,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize)
      }
    });
  } catch (err) {
    console.error('获取激活码列表失败:', err);
    res.status(500).json({ error: '获取激活码列表失败: ' + err.message });
  }
});

// 禁用/启用激活码
app.post('/api/admin/keys/:id/toggle', authMiddleware, (req, res) => {
  try {
    const keyId = parseInt(req.params.id);
    const key = db.prepare('SELECT * FROM license_keys WHERE id = ?').get([keyId]);
    
    if (!key) {
      return res.status(404).json({ error: '激活码不存在' });
    }
    
    const newStatus = key.status === 1 ? 0 : 1;
    db.run('UPDATE license_keys SET status = ? WHERE id = ?', [newStatus, keyId]);
    saveDatabase();
    
    logAdminAction(req.admin.id, 'toggle_key', 'license_keys', keyId, `激活码 ${newStatus === 1 ? '启用' : '禁用'}`, req.ip);
    
    res.json({ success: true, status: newStatus });
  } catch (err) {
    console.error('切换激活码状态失败:', err);
    res.status(500).json({ error: '操作失败: ' + err.message });
  }
});

// 删除激活码
app.delete('/api/admin/keys/:id', authMiddleware, (req, res) => {
  try {
    const keyId = parseInt(req.params.id);
    const key = db.prepare('SELECT * FROM license_keys WHERE id = ?').get([keyId]);
    
    if (!key) {
      return res.status(404).json({ error: '激活码不存在' });
    }
    
    db.run('DELETE FROM license_keys WHERE id = ?', [keyId]);
    saveDatabase();
    
    logAdminAction(req.admin.id, 'delete_key', 'license_keys', keyId, `删除激活码`, req.ip);
    
    res.json({ success: true });
  } catch (err) {
    console.error('删除激活码失败:', err);
    res.status(500).json({ error: '删除失败: ' + err.message });
  }
});

// ====================================================================
//  API — 激活码验证（客户端调用）
// ====================================================================

// 激活码激活
app.post('/api/activate', (req, res) => {
  try {
    const { key, device_id, app_version } = req.body;
    
    if (!key || !device_id) {
      return res.status(400).json({ success: false, error: '缺少必要参数' });
    }
    
    const keyRecord = db.prepare('SELECT * FROM license_keys WHERE key = ?').get([key]);
    
    if (!keyRecord) {
      return res.status(404).json({ success: false, error: '激活码不存在' });
    }
    
    if (keyRecord.status !== 1) {
      return res.status(403).json({ success: false, error: '激活码已禁用' });
    }
    
    // 检查是否过期
    if (keyRecord.expires_at && new Date(keyRecord.expires_at) < new Date()) {
      return res.status(403).json({ success: false, error: '激活码已过期' });
    }
    
    // 检查设备数限制（最多 1 个设备）
    const bindings = db.prepare('SELECT COUNT(*) as c FROM key_bindings WHERE key_id = ?').get([keyRecord.id]).c;
    if (bindings >= 1 && !db.prepare('SELECT * FROM key_bindings WHERE key_id = ? AND device_id = ?', [keyRecord.id, device_id]).get()) {
      return res.status(403).json({ success: false, error: '激活码已达到设备数限制' });
    }
    
    // 记录绑定
    if (!db.prepare('SELECT * FROM key_bindings WHERE key_id = ? AND device_id = ?').get([keyRecord.id, device_id])) {
      db.run(`INSERT INTO key_bindings (key_id, device_id, app_version, first_activate_at)
        VALUES (?, ?, ?, datetime('now','localtime'))`, [keyRecord.id, device_id, app_version]);
      saveDatabase();
    }
    
    // 返回激活信息
    res.json({
      success: true,
      data: {
        key: keyRecord.key,
        type: keyRecord.type,
        expires_at: keyRecord.expires_at,
        activated_at: new Date().toISOString()
      }
    });
  } catch (err) {
    console.error('激活失败:', err);
    res.status(500).json({ success: false, error: '激活失败: ' + err.message });
  }
});

// 激活码验证
app.post('/api/verify', (req, res) => {
  try {
    const { key, device_id } = req.body;
    
    if (!key || !device_id) {
      return res.status(400).json({ success: false, error: '缺少必要参数' });
    }
    
    const keyRecord = db.prepare('SELECT * FROM license_keys WHERE key = ?').get([key]);
    
    if (!keyRecord) {
      return res.status(404).json({ success: false, error: '激活码不存在' });
    }
    
    if (keyRecord.status !== 1) {
      return res.status(403).json({ success: false, error: '激活码已禁用' });
    }
    
    // 检查是否过期
    if (keyRecord.expires_at && new Date(keyRecord.expires_at) < new Date()) {
      return res.status(403).json({ success: false, error: '激活码已过期' });
    }
    
    // 检查设备绑定
    const binding = db.prepare('SELECT * FROM key_bindings WHERE key_id = ? AND device_id = ?').get([keyRecord.id, device_id]);
    if (!binding) {
      return res.status(403).json({ success: false, error: '设备未激活' });
    }
    
    // 更新最后验证时间
    db.run('UPDATE key_bindings SET last_verify_at = datetime(\'now\',\'localtime\') WHERE id = ?', [binding.id]);
    saveDatabase();
    
    res.json({
      success: true,
      data: {
        key: keyRecord.key,
        type: keyRecord.type,
        expires_at: keyRecord.expires_at,
        activated_at: binding.first_activate_at
      }
    });
  } catch (err) {
    console.error('验证失败:', err);
    res.status(500).json({ success: false, error: '验证失败: ' + err.message });
  }
});

// ====================================================================
// 启动服务器
// ====================================================================

app.listen(PORT, () => {
  console.log(`[服务器] WS多开管理器后台服务已启动`);
  console.log(`[服务器] 监听端口: ${PORT}`);
  console.log(`[服务器] 管理面板: http://localhost:${PORT}/admin`);
  console.log(`[服务器] 数据库: ${DB_PATH}`);
});
