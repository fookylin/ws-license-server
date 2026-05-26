# WS多开管理器 - 授权服务器部署指南

## 快速部署到 Render.com

### 第一步：准备文件

确保以下文件在 `license-server/` 目录中：
- `license-server.js` （主服务器文件）
- `package.json` （已创建）
- `render.yaml` （已创建）

### 第二步：推送到 Git 仓库

```bash
# 在项目根目录初始化 git（如果还没有）
git init
git add license-server/
git commit -m "添加授权服务器"
git remote add origin https://github.com/你的用户名/ws-license-server.git
git push -u origin main
```

### 第三步：在 Render.com 部署

1. 访问 https://render.com 并登录（支持 GitHub/Google 登录）
2. 点击 **New +** → **Web Service**
3. 连接你的 GitHub 仓库
4. 配置：
   - **Name**: `ws-license-server`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node license-server.js`
   - **Plan**: `Free`
5. 展开 **Advanced** 添加环境变量：
   - `TZ` = `Asia/Shanghai`
   - `PORT` = `3000`（Render.com 会自动分配 PORT，这里填 3000 作为默认值）
   - `DATABASE_URL`（可选，使用 PostgreSQL 时填写）
6. 点击 **Create Web Service**

### 第四步：获取服务器 URL

部署完成后，Render.com 会提供一个 URL，格式类似：
```
https://ws-license-server.onrender.com
```

复制这个 URL，配置到客户端的 `LICENSE_SERVER_URL` 环境变量中。

### 第五步：配置客户端

在用户电脑上启动应用时，设置环境变量：
```bash
set LICENSE_SERVER_URL=https://ws-license-server.onrender.com
```

或者修改 `main.js` 第 12 行的默认值：
```javascript
const LICENSE_SERVER_URL = process.env.LICENSE_SERVER_URL || 'https://你的实际render地址.onrender.com'
```

---

## 生成激活码

激活码格式：`WS-{32位十六进制}-{有效期天数}`

### 方法一：手动生成

```bash
node -e "
const crypto = require('crypto');
const random = crypto.randomBytes(16).toString('hex').toUpperCase();
const days = 365; // 有效期天数
console.log('WS-' + random + '-' + days);
"
```

### 方法二：使用在线工具

访问 http://localhost:3000/admin/generate-key?days=365（需要先启动本地服务器）

---

## 生产环境注意事项

### 使用 PostgreSQL 替代 SQLite

Render.com 免费版的 SQLite 数据库会在每次部署时被重置（文件系统不持久）。

**解决方案**：使用 Render.com 的免费 PostgreSQL 插件：

1. 在 Render.com 控制台，进入你的 Web Service
2. 点击 **Environment** → **Add Environment Variable**
3. 添加 PostgreSQL 插件（Render.com 提供免费 PostgreSQL）
4. 修改 `license-server.js` 支持 PostgreSQL（见下方代码）

### 修改 license-server.js 支持 PostgreSQL

在 `license-server.js` 开头添加：

```javascript
const postgres = process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('postgres');

let db;
if (postgres) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  db = pool;
} else {
  const sqlite3 = require('sqlite3').verbose();
  db = new sqlite3.Database(process.env.DATABASE_URL || path.join(__dirname, 'licenses.db'));
}
```

**注意**：需要 `npm install pg` 安装 PostgreSQL 客户端。

---

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/activate` | POST | 激活授权 |
| `/api/verify` | POST | 验证授权 |
| `/api/deactivate` | POST | 注销授权 |
| `/api/health` | GET | 健康检查 |
| `/admin/licenses` | GET | 查看所有授权（管理接口） |

---

## 故障排查

### 服务器无法启动
- 检查 `package.json` 中的依赖是否正确安装
- 查看 Render.com 的部署日志

### 客户端无法连接
- 确认 `LICENSE_SERVER_URL` 配置正确
- 检查防火墙是否阻止了出站连接
- 使用 `curl` 测试 API 端点是否可访问

### 激活码无效
- 检查激活码格式是否正确（`WS-{32位十六进制}-{天数}`）
- 检查服务器时间与北京时间是否一致（应使用 `TZ=Asia/Shanghai`）
