#!/bin/bash
# Render 启动脚本：确保 better-sqlite3 原生模块正确编译
set -e

echo "=== Render 启动脚本 ==="
echo "Node 版本: $(node -v)"
echo "NPM 版本: $(npm -v)"
echo "工作目录: $(pwd)"
echo "系统: $(uname -a)"

# 显示文件列表（调试用）
echo ""
echo "=== 文件结构 ==="
ls -la || true

# 检查 node_modules
if [ ! -d "node_modules" ]; then
  echo "⚠️  node_modules 不存在，正在安装依赖..."
  npm install --production 2>&1
fi

# 重新编译原生模块（better-sqlite3）
echo ""
echo "=== 检查 better-sqlite3 ==="
if [ -d "node_modules/better-sqlite3" ]; then
  echo "发现 better-sqlite3，尝试编译..."
  
  # 尝试 rebuild
  npm rebuild better-sqlite3 2>&1 && {
    echo "✅ better-sqlite3 编译成功"
  } || {
    echo "⚠️  rebuild 失败，尝试重新安装..."
    rm -rf node_modules/better-sqlite3
    npm install better-sqlite3 --build-from-source 2>&1 || {
      echo "❌ better-sqlite3 安装失败！"
      echo "尝试使用预编译版本..."
      npm install better-sqlite3@latest 2>&1 || {
        echo "❌ 所有安装方式都失败了"
        exit 1
      }
    }
  }
else
  echo "better-sqlite3 未安装，正在安装..."
  npm install better-sqlite3@latest 2>&1 || exit 1
fi

# 验证模块可加载
echo ""
echo "=== 验证 better-sqlite3 ==="
node -e "require('better-sqlite3'); console.log('✅ better-sqlite3 加载成功')" 2>&1 || {
  echo "❌ better-sqlite3 无法加载"
  exit 1
}

# 确保数据库目录存在
echo ""
echo "=== 数据库配置 ==="
DB_DIR=$(dirname "${DB_PATH:-./data/admin.db}")
echo "数据库目录: ${DB_DIR}"
mkdir -p "${DB_DIR}" 2>/dev/null || true

# 启动服务
echo ""
echo "=== 启动服务器 ==="
exec node server.js
