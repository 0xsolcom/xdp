// scripts/init-db.js
// 建库 + 导入 schema.sql，创建抓取所需的全部表。
// 用法: npm run initdb
import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
// override: .env 优先于 Shell 环境变量（部署机上常有别的项目导出的 DB_* / CHAIN_* 变量）
dotenv.config({ override: true });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.resolve(__dirname, '..', 'schema.sql');

const DB_NAME = process.env.DB_NAME || 'okx_xdp';
const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_USER = process.env.DB_USER;
const DB_PASSWORD = process.env.DB_PASSWORD;

const REQUIRED_TABLES = ['trades', 'wallet_rank', 'rank_meta', 'crawl_cursor', 'contract_check', 'okx_route', 'okx_launchpool_snap'];

if (!DB_USER) {
  console.error('❌ 请在 .env 配置 DB_USER / DB_PASSWORD');
  process.exit(1);
}
if (!fs.existsSync(SCHEMA_FILE)) {
  console.error('❌ 找不到 schema.sql:', SCHEMA_FILE);
  process.exit(1);
}

async function main() {
  console.log('=== 初始化数据库 ===');
  console.log('Host    :', DB_HOST + ':' + DB_PORT);
  console.log('Database:', DB_NAME);

  const conn = await mysql.createConnection({
    host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD,
    multipleStatements: true,
  });

  try {
    await conn.query('CREATE DATABASE IF NOT EXISTS `' + DB_NAME + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    await conn.query('USE `' + DB_NAME + '`');
    console.log('✅ 数据库就绪');

    const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
    await conn.query(sql);
    console.log('✅ 已执行 schema.sql');

    const [rows] = await conn.query('SHOW TABLES');
    const tables = rows.map((r) => Object.values(r)[0]);
    console.log('当前表  :', tables.join(', ') || '(空)');

    const missing = REQUIRED_TABLES.filter((t) => !tables.includes(t));
    if (missing.length) throw new Error('缺少表: ' + missing.join(', '));
    console.log('✅ 所需表齐全:', REQUIRED_TABLES.join(', '));
  } finally {
    await conn.end();
  }
}

main().catch((e) => { console.error('❌ 初始化失败:', e.message); process.exit(1); });
