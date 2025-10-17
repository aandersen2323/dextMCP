-- SQLite数据库表结构设计（使用sqlite-vec向量搜索版）
-- 用于存储工具的向量化数据，实现高效的向量相似性搜索

-- 工具向量表 (使用sqlite-vec)
CREATE TABLE IF NOT EXISTS tool_vectors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_md5 TEXT NOT NULL,                         -- 工具名称+描述的MD5哈希值
    model_name TEXT NOT NULL,                       -- 向量化使用的模型名称
    tool_name TEXT NOT NULL,                        -- 工具名称（用于调试）
    description TEXT,                               -- 工具描述（用于调试）
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 创建向量索引表 (sqlite-vec)
CREATE VIRTUAL TABLE IF NOT EXISTS vec_tool_embeddings USING vec0(
    tool_vector FLOAT[2560]                         -- 向量数据，假设使用2560维度
);

-- 工具元数据映射表
CREATE TABLE IF NOT EXISTS tool_mapping (
    rowid INTEGER PRIMARY KEY,                      -- 对应vec_tool_embeddings的rowid
    tool_id INTEGER NOT NULL,                       -- 对应tool_vectors的id
    FOREIGN KEY (tool_id) REFERENCES tool_vectors(id) ON DELETE CASCADE
);

-- 创建索引以提高查询性能
CREATE INDEX IF NOT EXISTS idx_tool_vectors_md5 ON tool_vectors(tool_md5);
CREATE INDEX IF NOT EXISTS idx_tool_vectors_model ON tool_vectors(model_name);
CREATE INDEX IF NOT EXISTS idx_tool_vectors_name ON tool_vectors(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_mapping_tool_id ON tool_mapping(tool_id);

-- 创建视图方便查询
CREATE VIEW IF NOT EXISTS v_tool_search AS
SELECT 
    tv.id,
    tv.tool_md5,
    tv.model_name,
    tv.tool_name,
    tv.description,
    tv.created_at,
    tv.updated_at
FROM tool_vectors tv;
