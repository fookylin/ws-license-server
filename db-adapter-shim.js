/**
 * better-sqlite3 拦截模块
 * 当 server.js 执行 require('better-sqlite3') 时，返回此模块
 */
const { DatabaseCompat } = require('./db-adapter');
module.exports = DatabaseCompat;
