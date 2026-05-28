const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { generateKey, findKey, activateKey, verifyActivation, revokeKey, getAllKeys, getStats, initDB, fixActivationCounts } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// API 路由

// 生成授权密钥
app.post('/api/generate', async (req, res) => {
  const { account_name, months, max_activations } = req.body;

  if (!account_name || !months) {
    return res.status(400).json({ success: false, error: '缺少参数' });
  }

  try {
    const result = await generateKey(account_name, parseInt(months), parseInt(max_activations) || 1);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 激活授权
app.post('/api/activate', async (req, res) => {
  const { key, hardware_fingerprint } = req.body;

  if (!key || !hardware_fingerprint) {
    return res.status(400).json({ success: false, error: '缺少参数' });
  }

  try {
    const result = await activateKey(key, hardware_fingerprint);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 验证授权（支持简单验证和硬件绑定验证）
app.post('/api/verify', async (req, res) => {
  const { key, hardware_fingerprint } = req.body;

  if (!key) {
    return res.status(400).json({ valid: false, error: '缺少参数' });
  }

  try {
    // 如果提供了 hardware_fingerprint，使用完整验证（含激活记录检查）
    if (hardware_fingerprint) {
      const result = await verifyActivation(key, hardware_fingerprint);
      return res.json(result);
    }

    // 简单验证模式：只验证密钥是否存在、是否过期、是否被撤销
    const keyRecord = await findKey(key);
    const serverTime = Math.floor(Date.now() / 1000);
    
    if (!keyRecord) {
      return res.json({ valid: false, error: '密钥不存在', server_time: serverTime });
    }
    
    if (keyRecord.is_revoked) {
      return res.json({ valid: false, error: '密钥已被撤销', server_time: serverTime });
    }
    
    // v2: expiry_date=0 表示尚未激活
    if (keyRecord.expiry_date === 0) {
      return res.json({ valid: false, error: '密钥尚未激活', server_time: serverTime });
    }
    
    if (serverTime > keyRecord.expiry_date) {
      return res.json({ 
        valid: false, 
        error: '密钥已过期',
        expiryDate: new Date(keyRecord.expiry_date * 1000).toISOString(),
        server_time: serverTime
      });
    }
    
    // 密钥有效
    return res.json({ 
      valid: true,
      expiryDate: new Date(keyRecord.expiry_date * 1000).toISOString(),
      accountName: keyRecord.account_name,
      server_time: serverTime
    });
  } catch (error) {
    res.status(500).json({ valid: false, error: error.message });
  }
});

// 撤销授权
app.post('/api/revoke', async (req, res) => {
  const { key } = req.body;

  if (!key) {
    return res.status(400).json({ success: false, error: '缺少参数' });
  }

  try {
    const result = await revokeKey(key);
    
    if (result) {
      res.json({ success: true, message: '密钥已撤销' });
    } else {
      res.status(404).json({ success: false, error: '密钥不存在' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取所有密钥
app.get('/api/keys', async (req, res) => {
  try {
    const keys = await getAllKeys();
    res.json({ success: true, data: keys });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取统计信息
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 修复激活计数
app.post('/api/fix-counts', async (req, res) => {
  try {
    await fixActivationCounts();
    res.json({ success: true, message: '激活计数已修复' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 导入已有密钥
app.post('/api/import-key', async (req, res) => {
  const { key, account_name, months, expiry_date, max_activations } = req.body;
  if (!key || !account_name || !expiry_date) {
    return res.status(400).json({ success: false, error: '缺少参数' });
  }
  try {
    const existing = await findKey(key);
    if (existing) {
      return res.json({ success: true, message: '密钥已存在', data: existing });
    }
    const id = 'imp_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
    const pg = require('pg');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await pool.query(
      `INSERT INTO keys (id, key, account_name, months, expiry_date, created_at, is_revoked, max_activations, current_activations)
       VALUES ($1, $2, $3, $4, $5, $6, 0, $7, 0)`,
      [id, key, account_name, parseInt(months) || 6, parseInt(expiry_date), Math.floor(Date.now() / 1000), parseInt(max_activations) || 1]
    );
    await pool.end();
    res.json({ success: true, message: '密钥已导入', data: { id, key, account_name, expiry_date } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// v2 数据库迁移：为已有 keys 表添加 activated_at 列，并处理已激活记录
app.post('/api/migrate-v2', async (req, res) => {
  try {
    const pg = require('pg');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    
    // 添加 activated_at 列（如果不存在）
    await pool.query(`ALTER TABLE keys ADD COLUMN IF NOT EXISTS activated_at BIGINT DEFAULT 0;`);
    
    // 对于已经有激活记录（current_activations > 0）但 activated_at=0 的密钥，
    // 用最早的激活记录的 activated_at 作为 key 的 activated_at
    await pool.query(`
      UPDATE keys k
      SET activated_at = sub.first_activation
      FROM (
        SELECT key_id, MIN(activated_at) as first_activation
        FROM activations
        GROUP BY key_id
      ) sub
      WHERE k.id = sub.key_id AND k.activated_at = 0;
    `);
    
    await pool.end();
    res.json({ success: true, message: 'v2 迁移完成：已添加 activated_at 列并回填数据' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 启动服务器
async function startServer() {
  try {
    // 初始化数据库
    console.log('⏳ 正在初始化数据库...');
    await initDB();
    console.log('✅ 数据库初始化完成');
    
    // 启动 HTTP 服务器
    app.listen(PORT, () => {
      console.log(`
╔════════════════════════════════════╗
║   WS多开管理器 - 授权服务器            ║
╠════════════════════════════════════╣
║  服务器地址: <ADDRESS_REMOVED>
║  管理界面: <ADDRESS_REMOVED>
╚════════════════════════════════════╝
      `);
    });
  } catch (error) {
    console.error('❌ 服务器启动失败:', error);
    process.exit(1);
  }
}

// 启动服务器
startServer();
