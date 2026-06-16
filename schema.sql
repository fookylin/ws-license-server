-- ============================================
-- WS多开管理器 — 后台数据库 Schema
-- ============================================

-- 用户表（管理后台的运营人员）
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,        -- bcrypt 哈希
  role TEXT NOT NULL DEFAULT 'admin',  -- super_admin | admin | finance
  nickname TEXT DEFAULT '',
  avatar TEXT DEFAULT '',
  status INTEGER DEFAULT 1,      -- 1=正常 0=禁用
  last_login_at DATETIME,
  created_at DATETIME DEFAULT (datetime('now','localtime')),
  updated_at DATETIME DEFAULT (datetime('now','localtime'))
);

-- 软件用户表（购买/使用软件的终端用户）
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  phone TEXT UNIQUE,
  password TEXT NOT NULL,        -- bcrypt 哈希
  nickname TEXT DEFAULT '',
  status INTEGER DEFAULT 1,      -- 1=正常 0=禁用 -1=已删除
  remark TEXT DEFAULT '',        -- 管理员备注
  hardware_fingerprint TEXT DEFAULT '',
  max_accounts INTEGER DEFAULT 3,    -- 最大可添加账号数
  inviter_id INTEGER DEFAULT NULL,   -- 邀请人用户ID
  invite_code TEXT UNIQUE DEFAULT '', -- 用户自己的邀请码
  balance REAL DEFAULT 0,            -- 余额（元）
  total_recharged REAL DEFAULT 0,    -- 累计充值
  registered_ip TEXT DEFAULT '',
  registered_device TEXT DEFAULT '',
  last_active_at DATETIME,
  created_at DATETIME DEFAULT (datetime('now','localtime')),
  updated_at DATETIME DEFAULT (datetime('now','localtime'))
);

-- 授权密钥表
CREATE TABLE IF NOT EXISTS license_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_code TEXT UNIQUE NOT NULL,       -- 密钥字符串 WS-XXX-XXX
  type TEXT NOT NULL DEFAULT 'time',   -- time=时长型, account=账号数型, permanent=永久
  duration_days INTEGER DEFAULT 30,   -- 有效天数（type=time时使用）
  account_limit INTEGER DEFAULT 3,    -- 可添加账号数
  status INTEGER DEFAULT 0,           -- 0=未使用 1=已激活 2=已禁用 3=已过期
  price REAL DEFAULT 0,               -- 售价（元）
  created_by INTEGER REFERENCES admins(id),  -- 哪个管理员创建的
  activated_by INTEGER REFERENCES users(id), -- 哪个用户激活的
  activated_at DATETIME,
  expires_at DATETIME,                -- 到期时间
  device_fingerprint TEXT DEFAULT '', -- 激活时的设备指纹
  remark TEXT DEFAULT '',
  created_at DATETIME DEFAULT (datetime('now','localtime'))
);

-- 订单/充值记录表
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT UNIQUE NOT NULL,      -- 订单号
  user_id INTEGER REFERENCES users(id),
  license_key_id INTEGER REFERENCES license_keys(id),
  type TEXT NOT NULL,                 -- recharge=充值, purchase=购买密钥, upgrade=升级
  amount REAL NOT NULL,               -- 金额（元）
  payment_method TEXT DEFAULT '',     -- alipay, wechat, card, manual
  payment_status INTEGER DEFAULT 0,   -- 0=未支付 1=已支付 2=已退款 3=已取消
  paid_at DATETIME,
  remark TEXT DEFAULT '',
  created_at DATETIME DEFAULT (datetime('now','localtime'))
);

-- 分销/代理记录表
CREATE TABLE IF NOT EXISTS commissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inviter_id INTEGER REFERENCES users(id),     -- 邀请人
  invitee_id INTEGER REFERENCES users(id),     -- 被邀请人
  order_id INTEGER REFERENCES orders(id),      -- 关联订单
  commission_rate REAL DEFAULT 0.1,            -- 佣金比例（10%）
  commission_amount REAL DEFAULT 0,            -- 佣金金额
  status INTEGER DEFAULT 0,                    -- 0=待结算 1=已结算 2=已发放
  settled_at DATETIME,
  created_at DATETIME DEFAULT (datetime('now','localtime'))
);

-- 登录日志表
CREATE TABLE IF NOT EXISTS login_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  ip TEXT DEFAULT '',
  device TEXT DEFAULT '',
  result INTEGER DEFAULT 1,          -- 1=成功 0=失败
  fail_reason TEXT DEFAULT '',
  created_at DATETIME DEFAULT (datetime('now','localtime'))
);

-- 操作日志表（管理员操作）
CREATE TABLE IF NOT EXISTS admin_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER REFERENCES admins(id),
  action TEXT NOT NULL,              -- create_key, disable_user, refund_order 等
  target_type TEXT DEFAULT '',       -- user, license_key, order
  target_id INTEGER DEFAULT 0,
  detail TEXT DEFAULT '',
  ip TEXT DEFAULT '',
  created_at DATETIME DEFAULT (datetime('now','localtime'))
);

-- 系统配置表
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT (datetime('now','localtime'))
);

-- ========== 默认数据 ==========
-- 默认超级管理员（密码: admin123）
INSERT OR IGNORE INTO admins (username, password, role, nickname) VALUES
  ('admin', '$2a$10$XQxBj0gYK5VGhHzKP7eHXOkQ8vVFxKBqX9QKJi5qJ5b5b5b5b5b5O', 'super_admin', '超级管理员');

-- 默认系统配置
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('site_name', 'WS多开管理器'),
  ('site_url', 'https://ws-license-server.onrender.com'),
  ('default_account_limit', '3'),
  ('default_duration_days', '30'),
  ('commission_rate', '0.1'),
  ('recharge_rates', '[{"days":30,"price":29.9,"label":"月度"},{"days":90,"price":79.9,"label":"季度"},{"days":365,"price":299.9,"label":"年度"}]'),
  ('account_prices', '[{"accounts":3,"price":0,"label":"基础版"},{"accounts":10,"price":99.9,"label":"专业版"},{"accounts":50,"price":299.9,"label":"企业版"}]'),
  ('payment_alipay', 'true'),
  ('payment_wechat', 'true'),
  ('notice', '欢迎使用WS多开管理器'),
  ('version', '1.0.0');
