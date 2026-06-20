/**
 * GitHub 数据库备份同步模块
 * 
 * 功能：
 * 1. 启动时检测本地无数据 → 从 GitHub 拉取 backup
 * 2. 数据变更后自动上传 backup 到 GitHub
 * 
 * 环境变量：
 * - GITHUB_TOKEN: GitHub PAT（用于推送备份）
 * - GITHUB_REPO: 格式 owner/repo（默认 fookylin/ws-license-server）
 * - BACKUP_BRANCH: 备份分支（默认 main）
 * - BACKUP_PATH: 仓库中的备份文件路径（默认 data/admin.db.backup）
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'fookylin/ws-license-server';
const BACKUP_BRANCH = process.env.BACKUP_BRANCH || 'main';
const BACKUP_PATH_IN_REPO = process.env.BACKUP_PATH || 'data/admin.db.backup';

// GitHub API 基础 URL
const API_BASE = `https://api.github.com/repos/${GITHUB_REPO}/contents/${BACKUP_PATH_IN_REPO}`;

/**
 * 从 GitHub 拉取数据库备份
 * @param {string} localDbPath 本地数据库路径
 * @returns {boolean} 是否成功拉取
 */
async function fetchBackup(localDbPath) {
  if (!GITHUB_TOKEN) {
    console.log('[GitHub备份] ⚠️ 未配置 GITHUB_TOKEN，跳过拉取');
    return false;
  }

  return new Promise((resolve) => {
    const url = `${API_BASE}?ref=${BACKUP_BRANCH}`;
    console.log(`[GitHub备份] 📥 尝试从 GitHub 拉取备份...`);

    const options = {
      headers: {
        'User-Agent': 'ws-license-server',
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      },
      timeout: 15000
    };

    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            // GitHub API 返回 base64 编码内容
            const fileContent = Buffer.from(json.content, 'base64');

            // 确保目录存在
            const dbDir = path.dirname(localDbPath);
            if (!fs.existsSync(dbDir)) {
              fs.mkdirSync(dbDir, { recursive: true });
            }

            fs.writeFileSync(localDbPath, fileContent);
            console.log(`[GitHub备份] ✅ 备份恢复成功 (${(fileContent.length / 1024).toFixed(1)}KB)`);
            resolve(true);
          } catch (e) {
            console.error('[GitHub备份] ❌ 解析备份失败:', e.message);
            resolve(false);
          }
        } else if (res.statusCode === 404) {
          console.log('[GitHub备份] ℹ️ 远程无备份文件（首次部署正常）');
          resolve(false);
        } else {
          console.error(`[GitHub备份] ❌ 拉取失败 HTTP ${res.statusCode}: ${data.substring(0, 200)}`);
          resolve(false);
        }
      });
    }).on('error', (e) => {
      console.error('[GitHub备份] ❌ 网络错误:', e.message);
      resolve(false);
    }).on('timeout', () => {
        console.error('[GitHub备份] ❌ 拉取超时');
        resolve(false);
    });
  });
}

/**
 * 上传数据库备份到 GitHub
 * @param {string} localDbPath 本地数据库路径
 * @returns {boolean} 是否成功上传
 */
async function pushBackup(localDbPath) {
  if (!GITHUB_TOKEN) {
    console.log('[GitHub备份] ⚠️ 未配置 GITHUB_TOKEN，跳过上传');
    return false;
  }

  if (!fs.existsSync(localDbPath)) {
    console.log('[GitHub备份] ⚠️ 本地数据库不存在，跳过上传');
    return false;
  }

  const fileContent = fs.readFileSync(localDbPath);
  if (fileContent.length === 0) {
    console.log('[GitHub备份] ⚠️ 数据库为空，跳过上传');
    return false;
  }

  const base64Content = fileContent.toString('base64');

  // 先获取文件的 SHA（如果已存在）
  let sha = null;
  try {
    sha = await getFileSha();
  } catch (e) {
    // 文件不存在，sha 保持 null（新建）
  }

  const body = JSON.stringify({
    message: `auto: db backup ${new Date().toISOString().replace(/T/, ' ').substring(0, 19)}`,
    content: base64Content,
    branch: BACKUP_BRANCH,
    ...(sha ? { sha } : {})
  });

  return new Promise((resolve) => {
    const url = API_BASE;
    const options = {
      method: 'PUT',
      headers: {
        'User-Agent': 'ws-license-server',
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 30000
    };

    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          console.log(`[GitHub备份] 📤 上传成功 (${(fileContent.length / 1024).toFixed(1)}KB)`);
          resolve(true);
        } else {
          console.error(`[GitHub备份] ❌ 上传失败 HTTP ${res.statusCode}: ${data.substring(0, 300)}`);
          resolve(false);
        }
      });
    });

    req.on('error', (e) => {
      console.error('[GitHub备份] ❌ 上传网络错误:', e.message);
      resolve(false);
    });
    req.on('timeout', () => {
      req.destroy();
      console.error('[GitHub备份] ❌ 上传超时');
      resolve(false);
    });

    req.write(body);
    req.end();
  });
}

/**
 * 获取远程文件的 SHA
 */
function getFileSha() {
  return new Promise((resolve, reject) => {
    const url = `${API_BASE}?ref=${BACKUP_BRANCH}`;
    const options = {
      headers: {
        'User-Agent': 'ws-license-server',
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      },
      timeout: 10000
    };

    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            resolve(json.sha);
          } catch (e) { reject(e); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    }).on('error', reject).on('timeout', () => {
        reject(new Error('timeout'));
    });
  });
}

module.exports = { fetchBackup, pushBackup };
