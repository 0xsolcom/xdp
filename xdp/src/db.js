import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
// override: .env 优先于 Shell 环境变量（部署机上常有别的项目导出的 DB_* / CHAIN_* 变量）
dotenv.config({ override: true });

export const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  timezone: 'Z',        // DATETIME 按 UTC 解释
  decimalNumbers: true,
});

// TIMESTAMP 列（CURRENT_TIMESTAMP / NOW()）默认按服务器时区算。
// 把每个连接的会话时区固定成 UTC，读到的 updated_at / checked_at 才和写进去的一致。
pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'", () => {});
});
