#!/bin/bash
set -e
echo "=== Render 启动 ==="
echo "Node: $(node -v)"
npm install --production 2>&1
exec node render-entry.js
