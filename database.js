const { Pool } = require('pg');
const crypto = require('crypto');

// 从环境变量获取数据库连接字符串
// Render.com 部署时设置 DATABASE_URL 环境变量
const connectionString = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_TolZi4GCEs5e@ep-late-hill-apmru6l1-pooler.c-7.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

const pool = new Pool({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false
  },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// 初始化数据库表
async function initDB() {
  const client = await pool.connect();
  
  try {
    // 创建 keys 表（v2: 新增 activated_at 字段，过期时间从激活时刻开始计算）
      // expiry_date=0 表示未激活（尚未开始计时），首次激活时才计算真正的过期时间
      await client.query(`
      CREATE TABLE IF NOT EXISTS keys (
        id VARCHAR(255) PRIMARY KEY,
        key VARCHAR(255) UNIQUE NOT NULL,
        account_name VARCHAR(255),
        months INTEGER,
        expiry_date BIGINT DEFAULT 0,
        created_at BIGINT,
        activated_at BIGINT DEFAULT 0,
        is_revoked INTEGER DEFAULT 0,
        max_activations INTEGER DEFAULT 1,
        current_activations INTEGER DEFAULT 0
      );
    `);
    
    // 创建 activations 表
    await client.query(`
      CREATE TABLE IF NOT EXISTS activations (
        id VARCHAR(255) PRIMARY KEY,
        key_id VARCHAR(255) REFERENCES keys(id) ON DELETE CASCADE,
        hardware_fingerprint VARCHAR(255),
        activated_at BIGINT,
        last_verified BIGINT,
        is_active INTEGER DEFAULT 1
      );
    `);
    
    // 创建索引
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_keys_key ON keys(key);
      CREATE INDEX IF NOT EXISTS idx_activations_key_id ON activations(key_id);
      CREATE INDEX IF NOT EXISTS idx_activations_hardware ON activations(hardware_fingerprint);
    `);
    
    console.log('✅ 数据库表初始化成功');
  } catch (error) {
    console.error('❌ 数据库表初始化失败:', error);
    throw error;
  } finally {
    client.release();
  }
}

// 生成唯一ID
function generateId() {
  return Date.now().toString(36) + crypto.randomBytes(8).toString('hex');
}

// 生成授权密钥
// v2: 生成时 expiry_date=0（未激活状态），等首次激活时才计算真正的过期时间
async function generateKey(accountName, months, maxActivations = 1) {
  const randomHex = crypto.randomBytes(16).toString('hex').toUpperCase();
  // key 串中用占位时间戳 9999999999（2286年），表示"未激活"
  // 真正的过期时间存在数据库 expiry_date 字段，激活后才赋值
  const placeholderExpiry = 9999999999;
  const key = `WS-${randomHex}-${placeholderExpiry}`;
  
  const keyRecord = {
    id: generateId(),
    key: key,
    account_name: accountName,
    months: months,
    expiry_date: 0,  // 0 表示未激活，尚未开始计时
    created_at: Math.floor(Date.now() / 1000),
    activated_at: 0,  // 激活后才赋值
    is_revoked: 0,
    max_activations: maxActivations,
    current_activations: 0
  };
  
  const query = `
    INSERT INTO keys (id, key, account_name, months, expiry_date, created_at, activated_at, is_revoked, max_activations, current_activations)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *;
  `;
  
  const values = [
    keyRecord.id,
    keyRecord.key,
    keyRecord.account_name,
    keyRecord.months,
    keyRecord.expiry_date,
    keyRecord.created_at,
    keyRecord.activated_at,
    keyRecord.is_revoked,
    keyRecord.max_activations,
    keyRecord.current_activations
  ];
  
  try {
    const result = await pool.query(query, values);
    console.log('✅ 密钥生成成功:', key);
    return result.rows[0];
  } catch (error) {
    console.error('❌ 生成密钥失败:', error);
    throw error;
  }
}

// 查找密钥
async function findKey(key) {
  const query = 'SELECT * FROM keys WHERE key = $1;';
  
  try {
    const result = await pool.query(query, [key]);
    return result.rows[0] || null;
  } catch (error) {
    console.error('❌ 查找密钥失败:', error);
    return null;
  }
}

// 根据 ID 查找密钥
async function findKeyById(id) {
  const query = 'SELECT * FROM keys WHERE id = $1;';
  
  try {
    const result = await pool.query(query, [id]);
    return result.rows[0] || null;
  } catch (error) {
    console.error('❌ 查找密钥失败:', error);
    return null;
  }
}

// 激活密钥（支持单机登录限制 - 挤掉旧设备）
// v2: 首次激活时计算真正的 expiry_date = now + months * 30天，并更新 key 串
async function activateKey(key, hardwareFingerprint) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // 查找密钥（加行锁）
    const keyQuery = 'SELECT * FROM keys WHERE key = $1 FOR UPDATE;';
    const keyResult = await client.query(keyQuery, [key]);
    
    if (keyResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: '密钥不存在' };
    }
    
    const keyRecord = keyResult.rows[0];
    
    // 检查是否已撤销
    if (keyRecord.is_revoked) {
      await client.query('ROLLBACK');
      return { success: false, error: '密钥已被撤销' };
    }
    
    // 🔧 v2: 检查是否过期（用数据库 expiry_date 而非 key 串）
    // expiry_date=0 表示未激活，不判过期；非0才判
    if (keyRecord.expiry_date > 0 && Math.floor(Date.now() / 1000) > keyRecord.expiry_date) {
      await client.query('ROLLBACK');
      return { success: false, error: '密钥已过期' };
    }
    
    // 🔍 检查是否已激活此硬件（同设备重复激活）
    const sameDeviceQuery = 'SELECT * FROM activations WHERE key_id = $1 AND hardware_fingerprint = $2 AND is_active = 1;';
    const sameDeviceResult = await client.query(sameDeviceQuery, [keyRecord.id, hardwareFingerprint]);
    
    if (sameDeviceResult.rows.length > 0) {
      // 同设备 → 更新 last_verified 时间（刷新）并提交
      await client.query(
        'UPDATE activations SET last_verified = $1 WHERE id = $2;',
        [Math.floor(Date.now() / 1000), sameDeviceResult.rows[0].id]
      );
      await client.query('COMMIT');
      console.log('✅ 此设备已激活（刷新）:', key);
      
      // 🔧 v2: 返回更新后的 key 记录（含正确的 expiry_date）
      const refreshedResult = await client.query('SELECT * FROM keys WHERE id = $1;', [keyRecord.id]);
      return { 
        success: true, 
        message: '此设备已激活', 
        key: refreshedResult.rows[0],
        server_time: Math.floor(Date.now() / 1000)
      };
    }
    
    // 🔧 检查是否需要挤掉旧设备
    const activeActivationsQuery = 'SELECT * FROM activations WHERE key_id = $1 AND is_active = 1;';
    const activeActivationsResult = await client.query(activeActivationsQuery, [keyRecord.id]);
    
    let deviceReplaced = false;
    if (activeActivationsResult.rows.length >= keyRecord.max_activations) {
      // 单机模式 (max_activations=1): 直接挤掉旧设备
      for (const oldActivation of activeActivationsResult.rows) {
        await client.query(
          'UPDATE activations SET is_active = 0 WHERE id = $1;',
          [oldActivation.id]
        );
        deviceReplaced = true;
        console.log(`[激活] ⚠️ 密钥 ${key} 已从设备 ${oldActivation.hardware_fingerprint} 转移到 ${hardwareFingerprint}`);
      }
    }
    
    // 创建新激活记录
    const activationId = generateId();
    const activatedAt = Math.floor(Date.now() / 1000);
    
    await client.query(`
      INSERT INTO activations (id, key_id, hardware_fingerprint, activated_at, last_verified, is_active)
      VALUES ($1, $2, $3, $4, $5, $6);
    `, [activationId, keyRecord.id, hardwareFingerprint, activatedAt, activatedAt, 1]);
    
    // 🔧 v2 关键修复：首次激活时计算真正的 expiry_date 并更新 key 串
    let updatedKey = keyRecord.key;  // 默认不变
    if (keyRecord.current_activations === 0 && !deviceReplaced) {
      // 首次激活（之前没有任何设备激活过）
      const realExpiryDate = activatedAt + (keyRecord.months * 30 * 24 * 60 * 60);
      
      // 更新数据库 expiry_date 和 activated_at
      await client.query(
        'UPDATE keys SET expiry_date = $1, activated_at = $2, current_activations = current_activations + 1 WHERE id = $3;',
        [realExpiryDate, activatedAt, keyRecord.id]
      );
      
      // 更新 key 串中的时间戳（把占位 9999999999 替换为真正的过期时间戳）
      const parts = keyRecord.key.split('-');
      parts[parts.length - 1] = realExpiryDate.toString();
      updatedKey = parts.join('-');
      
      await client.query('UPDATE keys SET key = $1 WHERE id = $2;', [updatedKey, keyRecord.id]);
      
      console.log(`[激活] ✅ 首次激活，过期时间从激活时刻计算: ${new Date(realExpiryDate * 1000).toISOString()}`);
    } else if (deviceReplaced) {
      // 挤掉旧设备，current_activations 不变
      // 注意：expiry_date 已在首次激活时设置过，不需要再改
    } else {
      // 非首次激活（其他情况）
      await client.query('UPDATE keys SET current_activations = current_activations + 1 WHERE id = $1;', [keyRecord.id]);
    }
    
    await client.query('COMMIT');
    
    // 获取更新后的密钥记录
    const updatedKeyResult = await client.query('SELECT * FROM keys WHERE id = $1;', [keyRecord.id]);
    
    console.log('✅ 激活成功:', updatedKey, deviceReplaced ? '(设备已替换)' : '');
    return { 
      success: true, 
      message: deviceReplaced ? '激活成功（旧设备已退出）' : '激活成功', 
      key: updatedKeyResult.rows[0],
      updatedKey: updatedKey,  // 🔧 v2: 返回更新后的 key 串，客户端需要保存
      deviceReplaced: deviceReplaced,
      server_time: Math.floor(Date.now() / 1000)
    };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ 激活密钥失败:', error);
    return { success: false, error: '激活失败: ' + error.message };
  } finally {
    client.release();
  }
}

// 验证激活
// v2: 处理 expiry_date=0（未激活）情况，返回 server_time 供客户端防时间回退
async function verifyActivation(key, hardwareFingerprint) {
  try {
    // 查找密钥
    const keyQuery = 'SELECT * FROM keys WHERE key = $1;';
    const keyResult = await pool.query(keyQuery, [key]);
    
    if (keyResult.rows.length === 0) {
      return { valid: false, error: '密钥不存在' };
    }
    
    const keyRecord = keyResult.rows[0];
    const serverTime = Math.floor(Date.now() / 1000);
    
    // 检查是否已撤销
    if (keyRecord.is_revoked) {
      return { valid: false, error: '密钥已被撤销', server_time: serverTime };
    }
    
    // 🔧 v2: expiry_date=0 表示未激活（不应该走到这里，但防御性判断）
    if (keyRecord.expiry_date === 0) {
      return { valid: false, error: '密钥尚未激活', server_time: serverTime };
    }
    
    // 🔧 v2: 用服务器时间检查过期（而非客户端时间）
    if (serverTime > keyRecord.expiry_date) {
      return { 
        valid: false, 
        error: '密钥已过期',
        expiryDate: new Date(keyRecord.expiry_date * 1000).toISOString(),
        server_time: serverTime
      };
    }
    
    // 🔍 检查激活记录（不再过滤 is_active，需要检查 is_active 状态）
    const activationQuery = 'SELECT * FROM activations WHERE key_id = $1 AND hardware_fingerprint = $2;';
    const activationResult = await pool.query(activationQuery, [keyRecord.id, hardwareFingerprint]);
    
    if (activationResult.rows.length === 0) {
      // 没有激活记录 → 说明被其他设备挤掉了
      return { 
        valid: false, 
        error: 'DEVICE_REPLACED', 
        reason: '该密钥已在其他设备上激活',
        server_time: serverTime
      };
    }
    
    const record = activationResult.rows[0];
    
    // 🔍 检查激活记录是否仍然有效
    if (!record.is_active) {
      // 该设备的激活已被标记为失效（被其他设备挤掉了）
      return { 
        valid: false, 
        error: 'DEVICE_REPLACED', 
        reason: '该密钥已在其他设备上登录，您已被强制下线',
        server_time: serverTime
      };
    }
    
    // ✅ 更新最后验证时间
    const lastVerified = Math.floor(Date.now() / 1000);
    await pool.query('UPDATE activations SET last_verified = $1 WHERE id = $2;', [lastVerified, record.id]);
    
    console.log('✅ 验证成功:', key);
    return { 
      valid: true, 
      expiryDate: new Date(keyRecord.expiry_date * 1000).toISOString(), 
      accountName: keyRecord.account_name,
      server_time: serverTime  // 🔧 v2: 返回服务器时间，供客户端检测时间回退
    };
  } catch (error) {
    console.error('❌ 验证激活失败:', error);
    return { valid: false, error: '验证失败: ' + error.message };
  }
}

// 撤销密钥
async function revokeKey(key) {
  const query = 'UPDATE keys SET is_revoked = 1 WHERE key = $1;';
  
  try {
    const result = await pool.query(query, [key]);
    if (result.rowCount > 0) {
      console.log('✅ 密钥撤销成功:', key);
      return true;
    }
    return false;
  } catch (error) {
    console.error('❌ 撤销密钥失败:', error);
    return false;
  }
}

// 获取所有密钥
async function getAllKeys() {
  const query = 'SELECT * FROM keys ORDER BY created_at DESC;';
  
  try {
    const result = await pool.query(query);
    return result.rows;
  } catch (error) {
    console.error('❌ 获取所有密钥失败:', error);
    return [];
  }
}

// 获取统计信息
async function getStats() {
  try {
    const totalKeysResult = await pool.query('SELECT COUNT(*) as total FROM keys;');
    const revokedKeysResult = await pool.query('SELECT COUNT(*) as revoked FROM keys WHERE is_revoked = 1;');
    const activatedKeysResult = await pool.query('SELECT COUNT(*) as activated FROM keys WHERE current_activations > 0;');
    const totalActivationsResult = await pool.query('SELECT COUNT(*) as total FROM activations;');
    const activeActivationsResult = await pool.query('SELECT COUNT(*) as active FROM activations WHERE is_active = 1;');
    
    return {
      total_keys: parseInt(totalKeysResult.rows[0].total),
      revoked_keys: parseInt(revokedKeysResult.rows[0].revoked),
      activated_keys: parseInt(activatedKeysResult.rows[0].activated),
      total_activations: parseInt(totalActivationsResult.rows[0].total),
      active_activations: parseInt(activeActivationsResult.rows[0].active)
    };
  } catch (error) {
    console.error('❌ 获取统计信息失败:', error);
    return {
      total_keys: 0,
      revoked_keys: 0,
      activated_keys: 0,
      total_activations: 0,
      active_activations: 0
    };
  }
}

// 关闭数据库连接
async function closeDB() {
  await pool.end();
  console.log('✅ 数据库连接已关闭');
}

module.exports = {
  initDB,
  generateKey,
  findKey,
  findKeyById,
  activateKey,
  verifyActivation,
  revokeKey,
  getAllKeys,
  getStats,
  closeDB
};

// 修复激活计数（简单版：根据activations表重新统计）
async function fixActivationCounts() {
  const client = await pool.connect();
  try {
    // 先把所有key的current_activations重置为0
    await client.query('UPDATE keys SET current_activations = 0;');
    // 然后根据每个key的active activations重新计数
    const result = await client.query(`
      UPDATE keys k
      SET current_activations = sub.cnt
      FROM (SELECT key_id, COUNT(*) as cnt FROM activations WHERE is_active = 1 GROUP BY key_id) sub
      WHERE k.id = sub.key_id;
    `);
    console.log('✅ 修复完成, 影响行数:', result.rowCount);
    return { success: true, rowsAffected: result.rowCount };
  } catch (err) {
    console.error('❌ 修复失败:', err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  initDB,
  generateKey,
  findKey,
  findKeyById,
  activateKey,
  verifyActivation,
  revokeKey,
  getAllKeys,
  getStats,
  closeDB,
  fixActivationCounts
};
