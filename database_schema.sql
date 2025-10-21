-- SQLite database schema design (using the sqlite-vec extension)
-- Stores vectorized tool data to enable efficient vector similarity search

-- Tool vector table (sqlite-vec)
CREATE TABLE IF NOT EXISTS tool_vectors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_md5 TEXT NOT NULL,                         -- MD5 hash of tool name and description
    model_name TEXT NOT NULL,                       -- Model name used for vectorization
    tool_name TEXT NOT NULL,                        -- Tool name (for debugging)
    description TEXT,                               -- Tool description (for debugging)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create vector index table (sqlite-vec)
CREATE VIRTUAL TABLE IF NOT EXISTS vec_tool_embeddings USING vec0(
    tool_vector FLOAT[1024]                         -- Vector data; defaults to EMBEDDING_VECTOR_DIMENSION length
);

-- MCP server configuration table
CREATE TABLE IF NOT EXISTS mcp_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_name TEXT NOT NULL UNIQUE,              -- Server name (unique key)
    server_type TEXT NOT NULL CHECK (server_type IN ('http', 'stdio')), -- Server type
    url TEXT,                                      -- HTTP server URL (http type only)
    command TEXT,                                  -- Command (stdio type only)
    args TEXT,                                     -- Command arguments (JSON format, stdio only)
    headers TEXT,                                  -- HTTP headers (JSON format, http only)
    env TEXT,                                      -- Environment variables (JSON format)
    description TEXT,                              -- Server description
    enabled INTEGER DEFAULT 1 CHECK (enabled IN (0, 1)), -- Whether the server is enabled (0=disabled, 1=enabled)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Session tool retrieval history table
CREATE TABLE IF NOT EXISTS session_tool_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,                      -- Session ID
    tool_md5 TEXT NOT NULL,                        -- Tool MD5 hash
    tool_name TEXT NOT NULL,                       -- Tool name
    retrieved_at DATETIME DEFAULT CURRENT_TIMESTAMP,-- Retrieval timestamp
    UNIQUE(session_id, tool_md5)                   -- Prevent duplicate records
);

-- Indexes to improve query performance
CREATE INDEX IF NOT EXISTS idx_tool_vectors_md5 ON tool_vectors(tool_md5);
CREATE INDEX IF NOT EXISTS idx_tool_vectors_model ON tool_vectors(model_name);
CREATE INDEX IF NOT EXISTS idx_tool_vectors_name ON tool_vectors(tool_name);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_name ON mcp_servers(server_name);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_type ON mcp_servers(server_type);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled);
CREATE INDEX IF NOT EXISTS idx_session_history_session_id ON session_tool_history(session_id);
CREATE INDEX IF NOT EXISTS idx_session_history_tool_md5 ON session_tool_history(tool_md5);

-- View to simplify querying tool vectors
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

-- MCP server configuration view
CREATE VIEW IF NOT EXISTS v_mcp_servers AS
SELECT
    ms.id,
    ms.server_name,
    ms.server_type,
    ms.url,
    ms.command,
    ms.args,
    ms.headers,
    ms.env,
    ms.description,
    ms.enabled,
    ms.created_at,
    ms.updated_at
FROM mcp_servers ms;

-- MCP server group table
CREATE TABLE IF NOT EXISTS mcp_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_name TEXT NOT NULL UNIQUE,             -- Group name (unique)
    description TEXT,                            -- Group description
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- MCP server/group relation table (supports assigning a server to multiple groups)
CREATE TABLE IF NOT EXISTS mcp_server_groups (
    server_id INTEGER NOT NULL,                  -- MCP server ID
    group_id INTEGER NOT NULL,                   -- Group ID
    PRIMARY KEY (server_id, group_id),
    FOREIGN KEY (server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES mcp_groups(id) ON DELETE CASCADE
);

-- Indexes for group lookups
CREATE INDEX IF NOT EXISTS idx_mcp_groups_name ON mcp_groups(group_name);
CREATE INDEX IF NOT EXISTS idx_mcp_server_groups_group ON mcp_server_groups(group_id);
CREATE INDEX IF NOT EXISTS idx_mcp_server_groups_server ON mcp_server_groups(server_id);
