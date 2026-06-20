/**
 * WS多开管理器 — 后台服务端
 * Express + better-sqlite3 + JWT 认证
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

// ========== 初始化 ==========
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'ws-multi-admin-jwt-secret-2026';
const DB_PATH = path.join(__dirname, 'data', 'admin.db');

// 确保 data 目录存在
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// ========== 数据库 ==========
const Database = require('better-sqlite3');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 初始化 schema
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// 修正默认 admin 密码（bcrypt 哈希）
const defaultAdmin = db.prepare('SELECT id FROM admins WHERE username = ?').get('admin');
if (defaultAdmin) {
  // 检查密码是否已被正确哈希，如果没有则更新
  const hash = bcrypt.hashSync('xiaojunge', 10);
  db.prepare('UPDATE admins SET password = ? WHERE username = ?').run(hash, 'admin');
}

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
  db.prepare(`INSERT INTO admin_logs (admin_id, action, target_type, target_id, detail, ip)
    VALUES (?, ?, ?, ?, ?, ?)`).run(adminId, action, targetType, targetId, detail, ip || '');
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

    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
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
    db.prepare('UPDATE admins SET last_login_at = datetime(\'now\',\'localtime\') WHERE id = ?').run(admin.id);

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
  const admin = db.prepare('SELECT id, username, role, nickname, status, last_login_at, created_at FROM admins WHERE id = ?').get(req.admin.id);
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
      regTrend, revTrend, keyTypes, payMethods
    });
  } catch (err) {
    console.error('获取统计失败:', err);
    res.status(500).json({ error: '获取统计失败' });
  }
});

// ====================================================================
//  API — 用户管理
// ====================================================================

// 用户列表
app.get('/api/admin/users', authMiddleware, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const status = req.query.status; // 可选过滤

    let where = "WHERE u.status != -1";
    const params = [];

    if (search) {
      where += " AND (u.email LIKE ? OR u.phone LIKE ? OR u.nickname LIKE ? OR u.invite_code LIKE ?)";
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }
    if (status !== undefined && status !== '') {
      where += " AND u.status = ?";
      params.push(parseInt(status));
    }

    const total = db.prepare(`SELECT COUNT(*) as c FROM users u ${where}`).get(...params).c;

    const users = db.prepare(`
      SELECT u.*,
        (SELECT COUNT(*) FROM license_keys WHERE activated_by = u.id) as key_count,
        (SELECT COUNT(*) FROM orders WHERE user_id = u.id AND payment_status = 1) as order_count
      FROM users u ${where}
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.json({ users, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('获取用户列表失败:', err);
    res.status(500).json({ error: '获取用户列表失败' });
  }
});

// 用户详情
app.get('/api/admin/users/:id', authMiddleware, (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    delete user.password;

    // 关联密钥
    const keys = db.prepare('SELECT * FROM license_keys WHERE activated_by = ? ORDER BY created_at DESC').all(user.id);
    // 关联订单
    const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC').all(user.id);
    // 邀请记录
    const invites = db.prepare('SELECT u.id, u.email, u.nickname, u.created_at FROM users u WHERE u.inviter_id = ?').all(user.id);
    // 佣金记录
    const commissions = db.prepare('SELECT * FROM commissions WHERE inviter_id = ? ORDER BY created_at DESC').all(user.id);

    res.json({ user, keys, orders, invites, commissions });
  } catch (err) {
    res.status(500).json({ error: '获取用户详情失败' });
  }
});

// 创建用户（管理员手动添加）
app.post('/api/admin/users', authMiddleware, (req, res) => {
  try {
    const { email, phone, password, nickname, max_accounts, remark } = req.body;
    if (!email && !phone) return res.status(400).json({ error: '邮箱或手机号必填' });
    if (!password) return res.status(400).json({ error: '密码必填' });

    const hash = bcrypt.hashSync(password, 10);
    const inviteCode = generateInviteCode();

    const result = db.prepare(`INSERT INTO users (email, phone, password, nickname, max_accounts, remark, invite_code)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      email || null, phone || null, hash, nickname || '',
      max_accounts || 3, remark || '', inviteCode
    );

    logAdminAction(req.admin.id, 'create_user', 'user', result.lastInsertRowid,
      `创建用户: ${email || phone}`, req.ip);

    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: '邮箱或手机号已被使用' });
    }
    res.status(500).json({ error: '创建用户失败' });
  }
});

// 更新用户
app.put('/api/admin/users/:id', authMiddleware, (req, res) => {
  try {
    const { nickname, status, max_accounts, remark, balance } = req.body;
    const updates = [];
    const params = [];

    if (nickname !== undefined) { updates.push('nickname = ?'); params.push(nickname); }
    if (status !== undefined) { updates.push('status = ?'); params.push(status); }
    if (max_accounts !== undefined) { updates.push('max_accounts = ?'); params.push(max_accounts); }
    if (remark !== undefined) { updates.push('remark = ?'); params.push(remark); }
    if (balance !== undefined) { updates.push('balance = ?'); params.push(balance); }

    if (updates.length === 0) return res.status(400).json({ error: '没有需要更新的字段' });

    updates.push("updated_at = datetime('now','localtime')");
    params.push(req.params.id);

    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    logAdminAction(req.admin.id, 'update_user', 'user', parseInt(req.params.id),
      `更新用户信息`, req.ip);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '更新用户失败' });
  }
});

// ====================================================================
//  API — 密钥管理
// ====================================================================

// 密钥列表
app.get('/api/admin/keys', authMiddleware, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const status = req.query.status; // 可选过滤

    let where = "WHERE 1=1";
    const params = [];

    if (search) {
      where += " AND lk.key_code LIKE ?";
      params.push(`%${search}%`);
    }
    if (status !== undefined && status !== '') {
      where += " AND lk.status = ?";
      params.push(parseInt(status));
    }

    const total = db.prepare(`SELECT COUNT(*) as c FROM license_keys lk ${where}`).get(...params).c;

    const keys = db.prepare(`
      SELECT lk.*,
        COALESCE(u.nickname, u.email, u.phone, '未知') as activated_user_name,
        COALESCE(a.nickname, a.username, '系统') as created_admin_name
      FROM license_keys lk
      LEFT JOIN users u ON lk.activated_by = u.id
      LEFT JOIN admins a ON lk.created_by = a.id
      ${where}
      ORDER BY lk.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.json({ keys, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: '获取密钥列表失败' });
  }
});

// 生成密钥
app.post('/api/admin/keys/generate', authMiddleware, (req, res) => {
  try {
    const { count = 1, type = 'time', duration_days = 30, account_limit = 3, price = 0, remark = '' } = req.body;

    if (count > 100) return res.status(400).json({ error: '单次最多生成100个' });

    const keys = [];
    const insert = db.prepare(`INSERT INTO license_keys (key_code, type, duration_days, account_limit, price, created_by, remark)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);

    const insertMany = db.transaction((items) => {
      for (const item of items) {
        insert.run(item.key_code, item.type, item.duration_days, item.account_limit, item.price, req.admin.id, item.remark);
        keys.push(item.key_code);
      }
    });

    const items = [];
    for (let i = 0; i < count; i++) {
      items.push({ key_code: generateLicenseKey(), type, duration_days, account_limit, price, remark });
    }
    insertMany(items);

    logAdminAction(req.admin.id, 'generate_keys', 'license_key', 0,
      `生成 ${count} 个密钥 (${type}, ${duration_days}天, ¥${price})`, req.ip);

    res.json({ success: true, count, keys });
  } catch (err) {
    console.error('生成密钥失败:', err);
    res.status(500).json({ error: '生成密钥失败' });
  }
});

// 禁用/启用密钥
app.put('/api/admin/keys/:id/status', authMiddleware, (req, res) => {
  try {
    const { status } = req.body;
    db.prepare('UPDATE license_keys SET status = ? WHERE id = ?').run(status, req.params.id);

    logAdminAction(req.admin.id, 'update_key_status', 'license_key', parseInt(req.params.id),
      `设置密钥状态: ${status}`, req.ip);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '更新密钥状态失败' });
  }
});

// ====================================================================
//  API — 订单管理
// ====================================================================

// 订单列表
app.get('/api/admin/orders', authMiddleware, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const status = req.query.status; // 可选过滤 payment_status

    let where = "WHERE 1=1";
    const params = [];

    if (search) {
      where += " AND (o.order_no LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)";
      const s = `%${search}%`;
      params.push(s, s, s);
    }
    if (status !== undefined && status !== '') {
      where += " AND o.payment_status = ?";
      params.push(parseInt(status));
    }

    const total = db.prepare(`SELECT COUNT(*) as c FROM orders o LEFT JOIN users u ON o.user_id = u.id ${where}`).get(...params).c;

    const orders = db.prepare(`
      SELECT o.*,
        COALESCE(u.nickname, u.email, u.phone, '未知') as user_name,
        lk.key_code
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.id
      LEFT JOIN license_keys lk ON o.license_key_id = lk.id
      ${where}
      ORDER BY o.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.json({ orders, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: '获取订单列表失败' });
  }
});

// 确认订单（手动标记已支付）
app.put('/api/admin/orders/:id/pay', authMiddleware, (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    if (order.payment_status === 1) return res.status(400).json({ error: '订单已支付' });

    db.prepare(`UPDATE orders SET payment_status = 1, paid_at = datetime('now','localtime') WHERE id = ?`).run(order.id);

    // 如果是购买密钥的订单，激活对应的密钥
    if (order.license_key_id) {
      const key = db.prepare('SELECT * FROM license_keys WHERE id = ?').get(order.license_key_id);
      if (key && key.status === 0) {
        // 标记为已激活
        const expiresAt = key.type === 'permanent' ? null : new Date(Date.now() + key.duration_days * 86400000).toISOString();
        db.prepare(`UPDATE license_keys SET status = 1, activated_by = ?, activated_at = datetime('now','localtime'),
          expires_at = ?, device_fingerprint = '' WHERE id = ?`).run(order.user_id, expiresAt, key.id);
      }
    }

    logAdminAction(req.admin.id, 'confirm_payment', 'order', order.id,
      `确认订单 ${order.order_no} 已支付 ¥${order.amount}`, req.ip);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '确认订单失败' });
  }
});

// 退款
app.put('/api/admin/orders/:id/refund', authMiddleware, (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    if (order.payment_status !== 1) return res.status(400).json({ error: '只有已支付的订单才能退款' });

    db.prepare(`UPDATE orders SET payment_status = 2 WHERE id = ?`).run(order.id);

    logAdminAction(req.admin.id, 'refund_order', 'order', order.id,
      `退款订单 ${order.order_no} ¥${order.amount}`, req.ip);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '退款失败' });
  }
});

// ====================================================================
//  API — 分销/佣金管理
// ====================================================================

// 佣金列表
app.get('/api/admin/commissions', authMiddleware, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const status = req.query.status;

    let where = "WHERE 1=1";
    const params = [];

    if (status !== undefined && status !== '') {
      where += " AND c.status = ?";
      params.push(parseInt(status));
    }

    const total = db.prepare(`SELECT COUNT(*) as c FROM commissions c ${where}`).get(...params).c;

    const commissions = db.prepare(`
      SELECT c.*,
        COALESCE(inv.nickname, inv.email, inv.phone, '未知') as inviter_name,
        COALESCE(ite.nickname, ite.email, ite.phone, '未知') as invitee_name,
        o.order_no
      FROM commissions c
      LEFT JOIN users inv ON c.inviter_id = inv.id
      LEFT JOIN users ite ON c.invitee_id = ite.id
      LEFT JOIN orders o ON c.order_id = o.id
      ${where}
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.json({ commissions, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: '获取佣金列表失败' });
  }
});

// 结算佣金
app.put('/api/admin/commissions/:id/settle', authMiddleware, (req, res) => {
  try {
    db.prepare(`UPDATE commissions SET status = 1, settled_at = datetime('now','localtime') WHERE id = ?`).run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '结算失败' });
  }
});

// ====================================================================
//  API — 系统配置
// ====================================================================

// 获取所有配置
app.get('/api/admin/settings', authMiddleware, (req, res) => {
  try {
    const settings = db.prepare('SELECT * FROM settings').all();
    const result = {};
    settings.forEach(s => {
      try { result[s.key] = JSON.parse(s.value); }
      catch { result[s.key] = s.value; }
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: '获取配置失败' });
  }
});

// 更新配置
app.put('/api/admin/settings', authMiddleware, (req, res) => {
  try {
    const updates = req.body;
    const stmt = db.prepare("UPDATE settings SET value = ?, updated_at = datetime('now','localtime') WHERE key = ?");
    const transaction = db.transaction(() => {
      for (const [key, value] of Object.entries(updates)) {
        const val = typeof value === 'object' ? JSON.stringify(value) : String(value);
        const result = stmt.run(val, key);
        if (result.changes === 0) {
          db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(key, val);
        }
      }
    });
    transaction();

    logAdminAction(req.admin.id, 'update_settings', 'settings', 0, '更新系统配置', req.ip);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '更新配置失败' });
  }
});

// ====================================================================
//  API — 管理员管理
// ====================================================================

app.get('/api/admin/admins', authMiddleware, (req, res) => {
  if (req.admin.role !== 'super_admin') return res.status(403).json({ error: '权限不足' });
  const admins = db.prepare('SELECT id, username, role, nickname, status, last_login_at, created_at FROM admins').all();
  res.json(admins);
});

app.post('/api/admin/admins', authMiddleware, (req, res) => {
  if (req.admin.role !== 'super_admin') return res.status(403).json({ error: '权限不足' });
  try {
    const { username, password, role, nickname } = req.body;
    if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });

    const hash = bcrypt.hashSync(password, 10);
    db.prepare(`INSERT INTO admins (username, password, role, nickname) VALUES (?, ?, ?, ?)`)
      .run(username, hash, role || 'admin', nickname || '');

    res.json({ success: true });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: '用户名已存在' });
    res.status(500).json({ error: '创建管理员失败' });
  }
});

// ====================================================================
//  API — 登录日志
// ====================================================================

app.get('/api/admin/login-logs', authMiddleware, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const total = db.prepare('SELECT COUNT(*) as c FROM login_logs').get().c;
    const logs = db.prepare(`
      SELECT l.*, COALESCE(u.nickname, u.email, u.phone, '未知') as user_name
      FROM login_logs l
      LEFT JOIN users u ON l.user_id = u.id
      ORDER BY l.created_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);

    res.json({ logs, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: '获取日志失败' });
  }
});

// ====================================================================
//  API — 操作日志
// ====================================================================

app.get('/api/admin/admin-logs', authMiddleware, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const total = db.prepare('SELECT COUNT(*) as c FROM admin_logs').get().c;
    const logs = db.prepare(`
      SELECT l.*, COALESCE(a.nickname, a.username, '系统') as admin_name
      FROM admin_logs l
      LEFT JOIN admins a ON l.admin_id = a.id
      ORDER BY l.created_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);

    res.json({ logs, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: '获取日志失败' });
  }
});

// ====================================================================
//  API — 用户端接口（供 Electron App 调用）
// ====================================================================

// 用户注册
app.post('/api/user/register', (req, res) => {
  try {
    const { email, phone, password, invite_code } = req.body;
    if (!email && !phone) return res.status(400).json({ error: '邮箱或手机号必填' });
    if (!password || password.length < 6) return res.status(400).json({ error: '密码至少6位' });

    const hash = bcrypt.hashSync(password, 10);
    const myInviteCode = generateInviteCode();
    let inviterId = null;

    // 如果有邀请码，查找邀请人
    if (invite_code) {
      const inviter = db.prepare('SELECT id FROM users WHERE invite_code = ?').get(invite_code);
      if (!inviter) return res.status(400).json({ error: '邀请码无效' });
      inviterId = inviter.id;
    }

    const result = db.prepare(`INSERT INTO users (email, phone, password, invite_code, inviter_id)
      VALUES (?, ?, ?, ?, ?)`).run(email || null, phone || null, hash, myInviteCode, inviterId);

    res.json({ success: true, id: result.lastInsertRowid, invite_code: myInviteCode });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: '邮箱或手机号已注册' });
    res.status(500).json({ error: '注册失败' });
  }
});

// 用户登录
app.post('/api/user/login', (req, res) => {
  try {
    const { account, password } = req.body;
    if (!account || !password) return res.status(400).json({ error: '请输入账号和密码' });

    const user = db.prepare('SELECT * FROM users WHERE email = ? OR phone = ?').get(account, account);
    if (!user) return res.status(401).json({ error: '账号或密码错误' });
    if (user.status !== 1) return res.status(403).json({ error: '账号已被禁用' });

    const valid = bcrypt.compareSync(password, user.password);
    if (!valid) return res.status(401).json({ error: '账号或密码错误' });

    // 记录登录日志
    db.prepare(`INSERT INTO login_logs (user_id, ip, device, result) VALUES (?, ?, ?, 1)`)
      .run(user.id, req.ip, req.headers['user-agent'] || '');

    // 更新最后活动时间
    db.prepare("UPDATE users SET last_active_at = datetime('now','localtime') WHERE id = ?").run(user.id);

    const token = jwt.sign({ id: user.id, type: 'user' }, JWT_SECRET, { expiresIn: '30d' });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        nickname: user.nickname,
        max_accounts: user.max_accounts,
        balance: user.balance,
        invite_code: user.invite_code,
        has_inviter: !!user.inviter_id,
      }
    });
  } catch (err) {
    res.status(500).json({ error: '登录失败' });
  }
});

// 用户信息
app.get('/api/user/profile', optionalAuth, (req, res) => {
  if (!req.admin || req.admin.type !== 'user') return res.status(401).json({ error: '未登录' });
  const user = db.prepare('SELECT id, email, phone, nickname, status, max_accounts, balance, total_recharged, invite_code, inviter_id, last_active_at, created_at FROM users WHERE id = ?').get(req.admin.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json(user);
});

// 用户激活密钥
app.post('/api/user/activate', optionalAuth, (req, res) => {
  try {
    if (!req.admin || req.admin.type !== 'user') return res.status(401).json({ error: '未登录' });

    const { key_code, hardware_fingerprint } = req.body;
    if (!key_code) return res.status(400).json({ error: '请输入密钥' });

    const key = db.prepare('SELECT * FROM license_keys WHERE key_code = ?').get(key_code.trim());
    if (!key) return res.status(404).json({ error: '密钥不存在' });

    if (key.status === 1) return res.status(400).json({ error: '密钥已被使用' });
    if (key.status === 2) return res.status(400).json({ error: '密钥已被禁用' });
    if (key.status === 3) return res.status(400).json({ error: '密钥已过期' });

    // 计算过期时间
    let expiresAt = null;
    if (key.type === 'time') {
      // 如果有旧的激活记录，在旧的基础上延长
      const existingKey = db.prepare(`SELECT * FROM license_keys WHERE activated_by = ? AND status = 1 AND type = 'time' ORDER BY expires_at DESC LIMIT 1`)
        .get(req.admin.id);
      if (existingKey && existingKey.expires_at) {
        const baseDate = new Date(existingKey.expires_at) > new Date() ? new Date(existingKey.expires_at) : new Date();
        expiresAt = new Date(baseDate.getTime() + key.duration_days * 86400000).toISOString();
      } else {
        expiresAt = new Date(Date.now() + key.duration_days * 86400000).toISOString();
      }
    }

    // 更新密钥状态
    db.prepare(`UPDATE license_keys SET status = 1, activated_by = ?, activated_at = datetime('now','localtime'),
      expires_at = ?, device_fingerprint = ? WHERE id = ?`)
      .run(req.admin.id, expiresAt, hardware_fingerprint || '', key.id);

    // 更新用户的 max_accounts（取最大值）
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.admin.id);
    const newLimit = Math.max(user.max_accounts, key.account_limit);
    db.prepare('UPDATE users SET max_accounts = ? WHERE id = ?').run(newLimit, user.id);

    res.json({ success: true, expires_at: expiresAt, max_accounts: newLimit });
  } catch (err) {
    console.error('激活失败:', err);
    res.status(500).json({ error: '激活失败' });
  }
});

// 获取充值套餐
app.get('/api/user/plans', (req, res) => {
  try {
    const rates = db.prepare("SELECT value FROM settings WHERE key = 'recharge_rates'").get();
    const accountPrices = db.prepare("SELECT value FROM settings WHERE key = 'account_prices'").get();
    res.json({
      recharge_rates: rates ? JSON.parse(rates.value) : [],
      account_prices: accountPrices ? JSON.parse(accountPrices.value) : [],
    });
  } catch (err) {
    res.status(500).json({ error: '获取套餐失败' });
  }
});

// 创建充值订单
app.post('/api/user/create-order', optionalAuth, (req, res) => {
  try {
    if (!req.admin || req.admin.type !== 'user') return res.status(401).json({ error: '未登录' });

    const { plan_type, plan_value, payment_method } = req.body;
    // plan_type: 'recharge' | 'upgrade_accounts'
    // plan_value: 天数 或 账号数

    let amount = 0;
    let licenseKeyId = null;

    if (plan_type === 'recharge') {
      // 时长充值：生成对应的密钥
      const rates = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'recharge_rates'").get().value);
      const plan = rates.find(r => r.days === parseInt(plan_value));
      if (!plan) return res.status(400).json({ error: '套餐不存在' });
      amount = plan.price;

      // 创建对应的密钥（待支付后激活）
      const keyCode = generateLicenseKey();
      const result = db.prepare(`INSERT INTO license_keys (key_code, type, duration_days, account_limit, price, status)
        VALUES (?, 'time', ?, 3, ?, 0)`).run(keyCode, plan.days, amount);
      licenseKeyId = result.lastInsertRowid;

    } else if (plan_type === 'upgrade_accounts') {
      // 升级账号数
      const prices = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'account_prices'").get().value);
      const plan = prices.find(r => r.accounts === parseInt(plan_value));
      if (!plan) return res.status(400).json({ error: '套餐不存在' });
      amount = plan.price;

      const keyCode = generateLicenseKey();
      const result = db.prepare(`INSERT INTO license_keys (key_code, type, duration_days, account_limit, price, status)
        VALUES (?, 'account', 365, ?, ?, 0)`).run(keyCode, plan.accounts, amount);
      licenseKeyId = result.lastInsertRowid;
    } else {
      return res.status(400).json({ error: '无效的套餐类型' });
    }

    const orderNo = generateOrderNo();
    db.prepare(`INSERT INTO orders (order_no, user_id, license_key_id, type, amount, payment_method, payment_status)
      VALUES (?, ?, ?, ?, ?, ?, 0)`)
      .run(orderNo, req.admin.id, licenseKeyId, 'purchase', amount, payment_method || '');

    res.json({ success: true, order_no: orderNo, amount });
  } catch (err) {
    console.error('创建订单失败:', err);
    res.status(500).json({ error: '创建订单失败' });
  }
});

// 用户订单列表
app.get('/api/user/orders', optionalAuth, (req, res) => {
  if (!req.admin || req.admin.type !== 'user') return res.status(401).json({ error: '未登录' });
  const orders = db.prepare(`
    SELECT o.*, lk.key_code, lk.type as key_type, lk.duration_days, lk.account_limit, lk.expires_at
    FROM orders o
    LEFT JOIN license_keys lk ON o.license_key_id = lk.id
    WHERE o.user_id = ?
    ORDER BY o.created_at DESC
  `).all(req.admin.id);
  res.json(orders);
});

// 用户的活跃密钥
app.get('/api/user/licenses', optionalAuth, (req, res) => {
  if (!req.admin || req.admin.type !== 'user') return res.status(401).json({ error: '未登录' });
  const keys = db.prepare(`
    SELECT * FROM license_keys
    WHERE activated_by = ? AND status = 1
    ORDER BY expires_at DESC
  `).all(req.admin.id);
  res.json(keys);
});

// ====================================================================
//  API — 客户端直接调用（激活/验证，无需用户登录）
// ====================================================================

// POST /api/activate — 激活密钥（客户端联网激活）
app.post('/api/activate', (req, res) => {
  try {
    const { key, hardware_fingerprint } = req.body;
    if (!key) return res.status(400).json({ error: '密钥不能为空' });

    // 标准化 key：第4段可能是 PERM 或新的过期时间戳，统一取前3段+原时间戳查库
    const normalizedKey = normalizeKeyForDb(key.trim());
    const keyRecord = db.prepare('SELECT * FROM license_keys WHERE key_code = ?').get(normalizedKey);

    if (!keyRecord) {
      return res.json({ success: false, error: 'KEY_NOT_FOUND', message: '密钥不存在' });
    }
    if (keyRecord.status === 2) {
      return res.json({ success: false, error: 'KEY_DISABLED', message: '密钥已被禁用' });
    }
    if (keyRecord.status === 3 || (keyRecord.expires_at && new Date(keyRecord.expires_at) < new Date())) {
      if (keyRecord.status !== 3) db.prepare('UPDATE license_keys SET status = 3 WHERE id = ?').run(keyRecord.id);
      return res.json({ success: false, error: 'KEY_EXPIRED', message: '密钥已过期' });
    }

    // 密钥已激活（status=1）
    if (keyRecord.status === 1) {
      if (keyRecord.device_fingerprint && keyRecord.device_fingerprint === hardware_fingerprint) {
        // 加固：已激活但 expires_at 为空且有时长信息，补算过期时间（防止数据库异常导致永久码）
        if (!keyRecord.expires_at && keyRecord.duration_days && keyRecord.duration_days > 0) {
          const expiresAt = new Date(Date.now() + keyRecord.duration_days * 86400000).toISOString();
          db.prepare('UPDATE license_keys SET expires_at = ? WHERE id = ?').run(expiresAt, keyRecord.id);
          keyRecord.expires_at = expiresAt;
          console.log(`[激活] 补算过期时间: key=${key.substring(0, 20)}... expires_at=${expiresAt}`);
        }
        const expiresAtMs = keyRecord.expires_at ? new Date(keyRecord.expires_at).getTime() : null;
        const serverTime = Math.floor(Date.now() / 1000);
        const updatedKey = generateUpdatedLicenseKey(key, expiresAtMs, serverTime);
        return res.json({
          success: true, message: '激活成功（已绑定本设备）',
          updatedKey, server_time: serverTime,
          expires_at: keyRecord.expires_at,
          max_accounts: keyRecord.account_limit, key_type: keyRecord.type
        });
      } else {
        return res.json({ success: false, error: 'DEVICE_REPLACED', reason: '该密钥已在其他设备上激活，本机授权已失效。' });
      }
    }

    // 执行激活（status=0）
    // ✅ 有效期从激活时刻开始算，不是从生成时开始算
    // 只要有 duration_days 就计算过期时间，不依赖 type 字段
    let expiresAt = null;
    if (keyRecord.duration_days && keyRecord.duration_days > 0) {
      expiresAt = new Date(Date.now() + keyRecord.duration_days * 86400000).toISOString();
    }
    db.prepare(`UPDATE license_keys SET status = 1, activated_at = datetime('now','localtime'), expires_at = ?, device_fingerprint = ? WHERE id = ?`)
      .run(expiresAt, hardware_fingerprint || '', keyRecord.id);

    const serverTime = Math.floor(Date.now() / 1000);
    const updatedKey = generateUpdatedLicenseKey(key, expiresAt ? new Date(expiresAt).getTime() : null, serverTime);
    console.log(`[激活] ${key.substring(0, 20)}... 激活成功，设备:${hardware_fingerprint}，到期:${expiresAt}`);
    res.json({
      success: true, message: '激活成功', updatedKey, server_time: serverTime,
      expires_at: expiresAt, max_accounts: keyRecord.account_limit, key_type: keyRecord.type
    });
  } catch (err) {
    console.error('[激活] 激活失败:', err);
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: '服务器内部错误' });
  }
});

// POST /api/verify — 验证密钥（客户端联网验证）
app.post('/api/verify', (req, res) => {
  try {
    const { key, hardware_fingerprint } = req.body;
    if (!key) return res.status(400).json({ error: '密钥不能为空' });

    // 标准化 key：去掉 updatedKey 的第4段后缀，匹配数据库中的原始 key
    const normalizedKey = normalizeKeyForDb(key.trim());
    const keyRecord = db.prepare('SELECT * FROM license_keys WHERE key_code = ?').get(normalizedKey);

    if (!keyRecord) return res.json({ valid: false, error: 'KEY_NOT_FOUND', reason: '密钥不存在' });
    if (keyRecord.status === 3 || (keyRecord.expires_at && new Date(keyRecord.expires_at) < new Date())) {
      if (keyRecord.status !== 3) db.prepare('UPDATE license_keys SET status = 3 WHERE id = ?').run(keyRecord.id);
      return res.json({ valid: false, error: 'KEY_EXPIRED', reason: '密钥已过期' });
    }
    if (keyRecord.status === 2) return res.json({ valid: false, error: 'KEY_DISABLED', reason: '密钥已被禁用' });
    if (keyRecord.status === 0) return res.json({ valid: false, error: 'NOT_ACTIVATED', reason: '密钥尚未激活' });

    if (keyRecord.device_fingerprint && keyRecord.device_fingerprint !== hardware_fingerprint) {
      return res.json({ valid: false, error: 'DEVICE_REPLACED', reason: '该密钥已在其他设备上激活，本机授权已失效。' });
    }

    const serverTime = Math.floor(Date.now() / 1000);
    res.json({ valid: true, server_time: serverTime, expires_at: keyRecord.expires_at, max_accounts: keyRecord.account_limit, key_type: keyRecord.type });
  } catch (err) {
    console.error('[验证] 验证失败:', err);
    res.status(500).json({ valid: false, error: 'SERVER_ERROR', reason: '服务器内部错误' });
  }
});

// 生成含过期时间的更新 key：WS-PART1-PART2-过期时间戳(base36)
// 注意：expiresAtMs 为 null 时才生成 PERM（永久码）
// 限时码的 expires_at 在激活时才设置（从激活时刻开始算有效期）
function generateUpdatedLicenseKey(originalKey, expiresAtMs, serverTime) {
  try {
    const parts = originalKey.split('-');
    if (parts.length >= 4) {
      // expiresAtMs 有值 → 限时码，转 base36 时间戳
      // expiresAtMs 为 null → 永久码，Part3 = PERM
      const expiresTs = expiresAtMs ? Math.floor(expiresAtMs / 1000).toString(36).toUpperCase() : 'PERM';
      return `${parts[0]}-${parts[1]}-${parts[2]}-${expiresTs}`;
    }
    return originalKey;
  } catch { return originalKey; }
}

// 标准化 key：将 updatedKey（第4段为 PERM 或新时间戳）还原为数据库中的原始 key 格式
// 原始格式：WS-PART1-PART2-TIMESTAMP（4段，第4段是创建时时间戳）
// updatedKey：WS-PART1-PART2-PERM 或 WS-PART1-PART2-NEWTS
// 策略：取前3段拼原始 key 查库；若未命中（说明就是原始 key），直接用原 key
function normalizeKeyForDb(key) {
  const parts = key.split('-');
  if (parts.length === 4) {
    // 尝试前3段+通配查库（兼容任意第4段）
    const baseKey = `${parts[0]}-${parts[1]}-${parts[2]}`;
    const found = db.prepare('SELECT key_code FROM license_keys WHERE key_code LIKE ? LIMIT 1').get(baseKey + '%');
    if (found) return found.key_code;
    // 找不到就当原始 key 尝试（可能用户输入的就是原始 key）
    return key;
  }
  return key;
}

// ====================================================================
//  启动服务器
// ====================================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`========================================`);
  console.log(`  WS多开管理器 — 后台服务已启动`);
  console.log(`  `);
  console.log(`  管理后台: http://localhost:${PORT}/admin`);
  console.log(`  充值页面: http://localhost:${PORT}/recharge`);
  console.log(`  API 地址: http://localhost:${PORT}/api`);
  console.log(`  `);
  console.log(`  默认管理员: admin / admin123`);
  console.log(`========================================`);
});
