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
