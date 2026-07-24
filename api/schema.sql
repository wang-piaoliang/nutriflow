-- NutriFlow 云同步的表结构。Worker 每次请求会自动 CREATE TABLE IF NOT EXISTS，
-- 一般不用手动跑这个文件；留档以便查看/需要时手动初始化。
CREATE TABLE IF NOT EXISTS documents (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
