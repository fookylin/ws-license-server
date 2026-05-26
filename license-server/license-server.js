/**
 * WS多开管理器 - 授权服务器
 * 部署：Render.com 免费 tier（Node.js + SQLite 或 PostgreSQL）
 *
 * 数据库自动选择：
 *   - DATABASE_URL 以 postgres 开头 → PostgreSQL（推荐生产环境）
 *   - 否则 → SQLite（默认，适合开发/测试）
 *
 * API 端点：
 *   POST /api/activate   — 激活授权
 *   POST /api/verify     — 验证授权
 *   POST /api/deactivate — 注销授权
 *   GET  /api/health     — 健康检查
 *   GET  /admin/licenses — 管理接口（生产环境需加鉴权）
 */

const express = require('express')
const crypto = require('crypto')
const path = require('path')

// ========== 北京时间工具函数（无第三方依赖）==========
process.env.TZ = 'Asia/Shanghai'

/**
 * 获取当前北京时间（Unix 时间戳，秒）
 * 北京时间 = UTC+8，中国不实行夏令时，偏移固定
 */
function beijingNow() {
  return Math.floor((Date.now() + 8 * 3600 * 1000) / 1000)
}

/**
 * 北京时间时间戳格式化为可读字符串
 * @param {number} ts - Unix 时间戳（秒）
 * @returns {string} 格式：2026-05-26 14:30:00+08:00
 */
function formatBeijingTime(ts) {
  const d = new Date((ts + 8 * 3600) * 1000)
  return d.toISOString().replace('Z', '+08:00').replace('T', ' ').substring(0, 19)
}

const app = express()
const PORT = process.env.PORT || 3000

// ========== 数据库抽象层 ==========
const USE_POSTGRES = process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('postgres')

let sqliteDb = null
let pgPool = null

if (USE_POSTGRES) {
  const { Pool } = require('pg')
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  })
  console.log('[数据库] 使用 PostgreSQL')
} else {
  const sqlite3 = require('sqlite3').verbose()
  const DB_PATH = process.env.DATABASE_URL || path.join(__dirname, 'licenses.db')
  sqliteDb = new sqlite3.Database(DB_PATH)
  console.log('[数据库] 使用 SQLite:', DB_PATH)
}

// ---------- 数据库抽象函数（统一 Promise 接口）----------

/**
 * 执行 SELECT 查询（返回所有行）
 * @param {string} sql - SQL 语句（使用 ? 作为占位符）
 * @param {Array} params - 参数数组
 * @returns {Promise<Array>} 行数组
 */
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (USE_POSTGRES) {
      const { sql: pgSql, values } = toPostgresSql(sql, params)
      pgPool.query(pgSql, values)
        .then(result => resolve(result.rows))
        .catch(reject)
    } else {
      sqliteDb.all(sql, params, (err, rows) => {
        if (err) reject(err)
        else resolve(rows)
      })
    }
  })
}

/**
 * 执行 SELECT 查询（返回单行）
 * @param {string} sql - SQL 语句（使用 ? 作为占位符）
 * @param {Array} params - 参数数组
 * @returns {Promise<Object|null>} 单行或 null
 */
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (USE_POSTGRES) {
      const { sql: pgSql, values } = toPostgresSql(sql, params)
      pgPool.query(pgSql, values)
        .then(result => resolve(result.rows[0] || null))
        .catch(reject)
    } else {
      sqliteDb.get(sql, params, (err, row) => {
        if (err) reject(err)
        else resolve(row || null)
      })
    }
  })
}

/**
 * 执行 INSERT/UPDATE/DELETE
 * @param {string} sql - SQL 语句（使用 ? 作为占位符）
 * @param {Array} params - 参数数组
 * @returns {Promise<Object>} { lastID, changes }
 */
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (USE_POSTGRES) {
      const { sql: pgSql, values } = toPostgresSql(sql, params)
      pgPool.query(pgSql, values)
        .then(result => resolve({ lastID: result.rows[0]?.id || 0, changes: result.rowCount }))
        .catch(reject)
    } else {
      sqliteDb.run(sql, params, function(err) {
        if (err) reject(err)
        else resolve({ lastID: this.lastID, changes: this.changes })
      })
    }
  })
}

/**
 * 将 SQLite 风格 SQL（? 占位符）转换为 PostgreSQL 风格（$1, $2, ...）
 * @param {string} sql - SQLite 风格 SQL
 * @param {Array} params - 参数数组
 * @returns {{ sql: string, values: Array }} PostgreSQL 风格 SQL + 参数
 */
function toPostgresSql(sql, params) {
  let pgSql = sql
  let idx = 1
  while (pgSql.includes('?')) {
    pgSql = pgSql.replace('?', `$${idx}`)
    idx++
  }
  return { sql: pgSql, values: params }
}

// ========== 数据库初始化 ==========
function initDB() {
  return new Promise((resolve, reject) => {
    if (USE_POSTGRES) {
      // PostgreSQL 初始化
      const initSql = `
        CREATE TABLE IF NOT EXISTS licenses (
          id SERIAL PRIMARY KEY,
          key TEXT UNIQUE NOT NULL,
          hardware_fingerprint TEXT,
          account_name TEXT,
          issued_at INTEGER,
          expires_at INTEGER,
          is_revoked INTEGER DEFAULT 0,
          created_at INTEGER DEFAULT EXTRACT(EPOCH FROM NOW())
        );
        CREATE INDEX IF NOT EXISTS idx_key ON licenses(key);
        CREATE INDEX IF NOT EXISTS idx_hardware ON licenses(hardware_fingerprint);
      `
      pgPool.query(initSql)
        .then(() => { console.log('[数据库] PostgreSQL 初始化完成'); resolve() })
        .catch(reject)
    } else {
      // SQLite 初始化
      sqliteDb.serialize(() => {
        sqliteDb.run(`
          CREATE TABLE IF NOT EXISTS licenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT UNIQUE NOT NULL,
            hardware_fingerprint TEXT,
            account_name TEXT,
            issued_at INTEGER,
            expires_at INTEGER,
            is_revoked INTEGER DEFAULT 0,
            created_at INTEGER DEFAULT (strftime('%s', 'now'))
          )
        `, (err) => {
          if (err) { reject(err); return }
          sqliteDb.run(`CREATE INDEX IF NOT EXISTS idx_key ON licenses(key)`, (err2) => {
            if (err2) { reject(err2); return }
            sqliteDb.run(`CREATE INDEX IF NOT EXISTS idx_hardware ON licenses(hardware_fingerprint)`, (err3) => {
              if (err3) { reject(err3); return }
              console.log('[数据库] SQLite 初始化完成')
              resolve()
            })
          })
        })
      })
    }
  })
}

initDB().catch(err => {
  console.error('[数据库] 初始化失败:', err)
  process.exit(1)
})

// ========== 中间件 ==========
app.use(express.json())

// CORS（允许 Electron 客户端调用）
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', 'Content-Type')
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200)
  }
  next()
})

// ========== 工具函数 ==========

// 验证密钥格式（WS-{32位十六进制}-{有效期天数}）
function validateLicenseKey(key) {
  const parts = key.split('-')
  if (parts.length < 3) return false
  if (parts[0] !== 'WS') return false
  const randomPart = parts.slice(1, -1).join('-')
  if (!/^[0-9A-Fa-f]{32}$/.test(randomPart)) return false
  const lastNum = parseInt(parts[parts.length - 1])
  if (isNaN(lastNum)) return false
  return true
}

// 解析密钥中的有效期（天）
function parseDurationDays(key) {
  const parts = key.split('-')
  const lastPart = parts[parts.length - 1]
  const lastNum = parseInt(lastPart)
  if (!isNaN(lastNum)) {
    // 时间戳通常很大（> 1e10），天数通常很小（< 36500）
    if (lastNum > 1e10) {
      const now = beijingNow()
      const daysRemaining = Math.floor((lastNum - now) / 86400)
      return Math.max(daysRemaining, 1)
    }
    return lastNum
  }
  console.warn('[激活] 无法解析有效期，使用默认30天')
  return 30
}

// 验证硬件指纹格式
function verifyHardwareFingerprint(fp) {
  return fp && fp.length === 16 && /^[0-9A-Fa-f]+$/.test(fp)
}

// ========== API 端点 ==========

/**
 * POST /api/activate
 * Body: { key: string, hardware_fingerprint: string, account_name?: string }
 */
app.post('/api/activate', async (req, res) => {
  const { key, hardware_fingerprint, account_name } = req.body

  if (!key || !hardware_fingerprint) {
    return res.json({ success: false, error: 'MISSING_PARAMS' })
  }

  if (!validateLicenseKey(key)) {
    return res.json({ success: false, error: 'INVALID_FORMAT' })
  }

  if (!verifyHardwareFingerprint(hardware_fingerprint)) {
    return res.json({ success: false, error: 'INVALID_FINGERPRINT' })
  }

  const now = beijingNow()
  const durationDays = parseDurationDays(key)
  const durationSec = durationDays * 86400
  const expiresAt = now + durationSec

  console.log(`[激活] 北京时间: ${formatBeijingTime(now)}，有效期: ${durationDays}天，过期时间: ${formatBeijingTime(expiresAt)}`)

  try {
    const row = await dbGet('SELECT * FROM licenses WHERE key = ?', [key])

    if (row) {
      // 密钥已存在
      if (row.is_revoked) {
        return res.json({ success: false, error: 'REVOKED' })
      }

      if (row.hardware_fingerprint === hardware_fingerprint) {
        // 同一设备重新激活 → 刷新过期时间
        const newExpiresAt = now + durationSec
        await dbRun('UPDATE licenses SET issued_at = ?, expires_at = ? WHERE key = ?', [now, newExpiresAt, key])
        console.log(`[激活] 刷新成功，新过期时间: ${formatBeijingTime(newExpiresAt)}`)
        return res.json({ success: true, message: '激活成功（已刷新过期时间）', expiresAt: newExpiresAt })
      } else {
        return res.json({
          success: false,
          error: 'DEVICE_REPLACED',
          reason: '该密钥已在其他设备上激活，请联系技术支持。'
        })
      }
    } else {
      // 新密钥
      await dbRun(`
        INSERT INTO licenses (key, hardware_fingerprint, account_name, issued_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `, [key, hardware_fingerprint, account_name || null, now, expiresAt])
      console.log(`[激活] 新密钥激活成功，过期时间: ${formatBeijingTime(expiresAt)}`)
      return res.json({ success: true, message: '激活成功', expiresAt })
    }
  } catch (err) {
    console.error('[激活] 数据库错误:', err)
    return res.json({ success: false, error: 'DATABASE_ERROR' })
  }
})

/**
 * POST /api/verify
 * Body: { key: string, hardware_fingerprint: string }
 */
app.post('/api/verify', async (req, res) => {
  const { key, hardware_fingerprint } = req.body

  if (!key || !hardware_fingerprint) {
    return res.json({ valid: false, error: 'MISSING_PARAMS' })
  }

  if (!validateLicenseKey(key)) {
    return res.json({ valid: false, error: 'INVALID_FORMAT' })
  }

  try {
    const row = await dbGet('SELECT * FROM licenses WHERE key = ?', [key])

    if (!row) {
      return res.json({ valid: false, error: 'NOT_FOUND' })
    }

    if (row.is_revoked) {
      return res.json({ valid: false, error: 'REVOKED' })
    }

    // 检查硬件指纹
    if (row.hardware_fingerprint !== hardware_fingerprint) {
      return res.json({
        valid: false,
        error: 'DEVICE_REPLACED',
        reason: '该密钥已在其他设备上激活，本机授权已失效。'
      })
    }

    // 检查过期
    const now = beijingNow()
    if (now > row.expires_at) {
      console.log(`[验证] 已过期: key=${key.substring(0, 20)}..., now=${formatBeijingTime(now)}, expires=${formatBeijingTime(row.expires_at)}`)
      return res.json({ valid: false, error: 'EXPIRED', expiryDate: formatBeijingTime(row.expires_at) })
    }

    // 验证通过
    const daysRemaining = Math.floor((row.expires_at - now) / 86400)
    console.log(`[验证] 通过: key=${key.substring(0, 20)}..., 剩余${daysRemaining}天`)
    return res.json({
      valid: true,
      expiryDate: formatBeijingTime(row.expires_at),
      daysRemaining
    })
  } catch (err) {
    console.error('[验证] 数据库错误:', err)
    return res.json({ valid: false, error: 'DATABASE_ERROR' })
  }
})

/**
 * POST /api/deactivate
 * Body: { key: string, hardware_fingerprint: string }
 */
app.post('/api/deactivate', async (req, res) => {
  const { key, hardware_fingerprint } = req.body

  if (!key || !hardware_fingerprint) {
    return res.json({ success: false, error: 'MISSING_PARAMS' })
  }

  try {
    const row = await dbGet('SELECT * FROM licenses WHERE key = ?', [key])

    if (!row) {
      return res.json({ success: false, error: 'NOT_FOUND' })
    }

    if (row.hardware_fingerprint !== hardware_fingerprint) {
      return res.json({ success: false, error: 'DEVICE_MISMATCH' })
    }

    await dbRun('UPDATE licenses SET is_revoked = 1 WHERE key = ?', [key])
    console.log(`[注销] 成功: key=${key.substring(0, 20)}...`)
    return res.json({ success: true, message: '注销成功' })
  } catch (err) {
    console.error('[注销] 数据库错误:', err)
    return res.json({ success: false, error: 'DATABASE_ERROR' })
  }
})

/**
 * GET /api/health
 * 健康检查（Render.com 需要）
 */
app.get('/api/health', async (req, res) => {
  try {
    if (USE_POSTGRES) {
      await pgPool.query('SELECT 1')
    } else {
      await new Promise((resolve, reject) => {
        sqliteDb.get('SELECT 1', (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
    res.json({ status: 'ok', timestamp: Date.now(), database: USE_POSTGRES ? 'postgres' : 'sqlite' })
  } catch (err) {
    res.json({ status: 'error', error: err.message })
  }
})

/**
 * GET /admin/licenses
 * 简单管理接口（生产环境需加鉴权）
 */
app.get('/admin/licenses', async (req, res) => {
  try {
    const rows = await dbAll('SELECT id, key, hardware_fingerprint, account_name, issued_at, expires_at, is_revoked FROM licenses ORDER BY id DESC', [])

    const licenses = rows.map(row => ({
      id: row.id,
      key: row.key.substring(0, 20) + '...',  // 脱敏
      hardware_fingerprint: row.hardware_fingerprint,
      account_name: row.account_name,
      issued_at: formatBeijingTime(row.issued_at),
      expires_at: formatBeijingTime(row.expires_at),
      is_revoked: !!row.is_revoked
    }))

    res.json({ licenses })
  } catch (err) {
    console.error('[管理] 查询失败:', err)
    return res.json({ error: 'DATABASE_ERROR' })
  }
})

// ========== 启动服务器 ==========
app.listen(PORT, () => {
  console.log(`[授权服务器] 启动在端口 ${PORT}`)
  console.log(`[授权服务器] 健康检查: http://localhost:${PORT}/api/health`)
  console.log(`[授权服务器] 数据库类型: ${USE_POSTGRES ? 'PostgreSQL' : 'SQLite'}`)
})

// ========== 优雅退出 ==========
process.on('SIGINT', async () => {
  console.log('[授权服务器] 正在关闭...')
  if (USE_POSTGRES) {
    await pgPool.end()
    console.log('[授权服务器] PostgreSQL 连接池已关闭')
  } else {
    sqliteDb.close((err) => {
      if (err) {
        console.error('[授权服务器] 关闭数据库失败:', err)
      } else {
        console.log('[授权服务器] 数据库已关闭')
      }
    })
  }
  process.exit(0)
})
