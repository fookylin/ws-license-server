#!/bin/bash
# Render 启动脚本：确保 better-sqlite3 原生模块正确编译
set -e

echo "=== Render 启动脚本 ==="
echo "Node 版本: $(node -v)"
echo "NPM 版本: $(npm -v)"

# 重新编译原生模块（better-sqlite3）
if [ -d "node_modules/better-sqlite3" ]; then
  echo "正在重新编译 better-sqlite3..."
  npm rebuild better-sqlite3 --build-from-source 2>&1 || {
    echo "⚠️  better-sqlite3 编译失败，尝试使用预编译版本..."
    npm install better-sqlite3@latest 2>&1
  }
fi

# 验证数据库路径
echo "数据库路径: ${DB_PATH:-默认本地路径}"

# 启动服务
echo "启动服务器..."
exec node server.js
