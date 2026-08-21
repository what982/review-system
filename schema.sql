-- 智慧课评系统 · Cloudflare D1 建表 SQL
-- 与原有 Supabase 三表字段对齐；id 由客户端生成（bigint 范围内），
-- 故用 INTEGER PRIMARY KEY（不 AUTOINCREMENT），写入走 INSERT ... ON CONFLICT(id) DO UPDATE。
-- review_records 新增 classTopic 列，彻底解决此前 Supabase 缺列导致的 400 问题。

CREATE TABLE IF NOT EXISTS review_classes (
    id   INTEGER PRIMARY KEY,
    name TEXT
);

CREATE TABLE IF NOT EXISTS review_students (
    id     INTEGER PRIMARY KEY,
    stuId  TEXT,
    name   TEXT,
    classId INTEGER
);

CREATE TABLE IF NOT EXISTS review_records (
    id           INTEGER PRIMARY KEY,
    studentId    INTEGER,
    studentName  TEXT,
    classId      INTEGER,
    classContent TEXT,
    classTopic   TEXT,
    reviewText   TEXT,
    recorddate   TEXT
);

-- 常用查询索引（可选，提升列表排序/过滤速度）
CREATE INDEX IF NOT EXISTS idx_students_classId ON review_students(classId);
CREATE INDEX IF NOT EXISTS idx_records_studentId ON review_records(studentId);
CREATE INDEX IF NOT EXISTS idx_records_classId ON review_records(classId);
CREATE INDEX IF NOT EXISTS idx_records_recorddate ON review_records(recorddate);

-- ─── 登录鉴权相关表（密码哈希存储，绝不存明文）────────────────────────
-- 用户表：pass_hash 存 "盐:派生值"，由 PBKDF2-HMAC-SHA256 生成
CREATE TABLE IF NOT EXISTS review_users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT UNIQUE NOT NULL,
    pass_hash  TEXT NOT NULL,
    created_at INTEGER
);

-- 会话表：token_hash 存会话令牌的 SHA-256（Cookie 里放原始令牌，库里只存哈希）
CREATE TABLE IF NOT EXISTS review_sessions (
    id         TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    user_id    INTEGER NOT NULL,
    created_at INTEGER,
    expire_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON review_sessions(token_hash);

-- 登录失败限流表：同一用户名连续失败 5 次锁定 15 分钟
CREATE TABLE IF NOT EXISTS login_attempts (
    key         TEXT PRIMARY KEY,
    fails       INTEGER DEFAULT 0,
    locked_until INTEGER DEFAULT 0
);
