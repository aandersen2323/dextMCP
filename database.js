// SQLite database management module (using better-sqlite3 + sqlite-vec)
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { readFileSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { createChildLogger } from './observability.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Database file path
const dbPathFromEnv = process.env.TOOLS_DB_PATH;
const DB_PATH = dbPathFromEnv
    ? (isAbsolute(dbPathFromEnv) ? dbPathFromEnv : join(process.cwd(), dbPathFromEnv))
    : join(__dirname, 'tools_vector.db');

const dbLogger = createChildLogger({ module: 'database' });

class VectorDatabase {
    constructor() {
        this.db = null;
    }

    /**
     * Initialize database connection
     */
    async initialize() {
        try {
            // Create database connection
            this.db = new Database(DB_PATH);

            // Load sqlite-vec extension
            this.loadVectorExtension();

            // Execute table creation statements
            this.createTables();
            
            dbLogger.info('✅ Database initialized successfully (using better-sqlite3 + sqlite-vec)');
            dbLogger.info(`📁 Database file path: ${DB_PATH}`);
            
            return true;
        } catch (error) {
            dbLogger.error({ err: error }, '❌ Database initialization failed');
            throw error;
        }
    }

    /**
     * Load sqlite-vec extension
     */
    loadVectorExtension() {
        try {
            sqliteVec.load(this.db);
            dbLogger.info('✅ sqlite-vec extension loaded successfully');
        } catch (error) {
            dbLogger.error({ err: error }, '❌ Failed to load sqlite-vec extension');
            throw error;
        }
    }

    /**
     * Create database tables
     */
    createTables() {
        try {
            // Read SQL file
            const schemaPath = join(__dirname, 'database_schema.sql');
            const schema = readFileSync(schemaPath, 'utf8');

            // Parse SQL statements
            const statements = [];
            let currentStatement = '';
            const lines = schema.split('\n');

            for (const line of lines) {
                const trimmedLine = line.trim();

                // Skip comment lines and empty lines
                if (trimmedLine.startsWith('--') || trimmedLine === '') {
                    continue;
                }

                currentStatement += line + '\n';

                // If line ends with semicolon, statement is complete
                if (trimmedLine.endsWith(';')) {
                    const statement = currentStatement.trim();
                    if (statement) {
                        statements.push(statement);
                    }
                    currentStatement = '';
                }
            }

            // Execute all SQL statements
            for (const statement of statements) {
                dbLogger.info(`📝 Executing SQL: ${statement.substring(0, 50)}...`);
                this.db.exec(statement);
            }

            dbLogger.info('📋 Database tables created successfully');
        } catch (error) {
            dbLogger.error({ err: error }, '❌ Failed to create database tables');
            throw error;
        }
    }

    /**
     * Generate MD5 hash for tool text
     * @param {string} toolName - Tool name
     * @param {string} description - Tool description
     * @returns {string} MD5 hash value
     */
    generateToolMD5(toolName, description = '') {
        const text = `${toolName}${description}`.trim();
        return crypto.createHash('md5').update(text, 'utf8').digest('hex');
    }

    /**
     * Save tool vector data
     * @param {string} toolName - Tool name
     * @param {string} description - Tool description
     * @param {Array<number>} vector - Vector data
     * @param {string} modelName - Model name
     * @returns {number} Inserted record ID
     */
    saveToolVector(toolName, description, vector, modelName) {
        try {
            const toolMD5 = this.generateToolMD5(toolName, description);

            // Check if already exists
            const existingStmt = this.db.prepare('SELECT id FROM tool_vectors WHERE tool_md5 = ? AND model_name = ?');
            const existing = existingStmt.get(toolMD5, modelName);

            let toolId;

            if (existing) {
                // Update existing record
                const updateStmt = this.db.prepare('UPDATE tool_vectors SET tool_name = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
                updateStmt.run(toolName, description, existing.id);
                toolId = existing.id;
                dbLogger.info(`🔄 Updated tool vector: ${toolName} (ID: ${toolId})`);
            } else {
                // Insert new record
                const insertStmt = this.db.prepare('INSERT INTO tool_vectors (tool_md5, model_name, tool_name, description) VALUES (?, ?, ?, ?)');
                const result = insertStmt.run(toolMD5, modelName, toolName, description);
                toolId = result.lastInsertRowid;
                dbLogger.info(`✅ Saved tool metadata: ${toolName} (ID: ${toolId})`);
            }

            // Store vector in vec_tool_embeddings table using tool ID as rowid
            const vectorFloat32 = new Float32Array(vector);
            const deleteExistingVecStmt = this.db.prepare('DELETE FROM vec_tool_embeddings WHERE rowid = ?');
            deleteExistingVecStmt.run(toolId);
            const vecInsertStmt = this.db.prepare('INSERT INTO vec_tool_embeddings(rowid, tool_vector) VALUES (?, ?)');
            vecInsertStmt.run(toolId, vectorFloat32);

            dbLogger.info(`✅ Saved tool vector: ${toolName} (MD5: ${toolMD5}, Vector ID: ${toolId}, Dimension: ${vector.length})`);

            return toolId;
        } catch (error) {
            dbLogger.error({ err: error, toolName }, '❌ Failed to save tool vector');
            throw error;
        }
    }

    /**
     * Batch save tool vector data
     * @param {Array} toolsData - Tool data array
     * @param {string} modelName - Model name
     * @returns {Array<number>} Inserted record ID array
     */
    saveToolVectorsBatch(toolsData, modelName) {
        try {
            const results = [];
            
            // Start transaction
            const transaction = this.db.transaction((tools) => {
                for (const toolData of tools) {
                    const { toolName, description, vector } = toolData;
                    const result = this.saveToolVector(toolName, description, vector, modelName);
                    results.push(result);
                }
            });
            
            // Execute transaction
            transaction(toolsData);
            
            dbLogger.info(`✅ Batch save completed: ${toolsData.length} tool vectors`);
            return results;
        } catch (error) {
            dbLogger.error({ err: error }, '❌ Failed to batch save tool vectors');
            throw error;
        }
    }

    /**
     * Vector similarity search
     * @param {Array<number>} queryVector - Query vector
     * @param {number} limit - Return result quantity limit
     * @param {number} threshold - Similarity threshold
     * @param {Array<string>} serverNames - Optional server name list for filtering tools
     * @returns {Array} Similar tools list
     */
    searchSimilarVectors(queryVector, limit = 5, threshold = 0.1, serverNames = null) {
        try {
            const queryVectorFloat32 = new Float32Array(queryVector);

            let stmt;
            let params;

            if (serverNames && serverNames.length > 0) {
                // Build server name filter conditions
                const serverConditions = serverNames.map(() => 'tv.tool_name LIKE ?').join(' OR ');
                const serverParams = serverNames.map(serverName => `${serverName}__%`);

                const sql = `
                    SELECT
                        tv.id,
                        tv.tool_md5,
                        tv.model_name,
                        tv.tool_name,
                        tv.description,
                        vec_distance_cosine(vte.tool_vector, ?) as distance,
                        (1.0 - vec_distance_cosine(vte.tool_vector, ?)) as similarity,
                        tv.created_at
                    FROM vec_tool_embeddings vte
                    JOIN tool_vectors tv ON tv.id = vte.rowid
                    WHERE (1.0 - vec_distance_cosine(vte.tool_vector, ?)) >= ?
                    AND (${serverConditions})
                    ORDER BY distance ASC
                    LIMIT ?
                `;

                stmt = this.db.prepare(sql);
                params = [queryVectorFloat32, queryVectorFloat32, queryVectorFloat32, threshold, ...serverParams, limit];
            } else {
                // Original query without server filtering
                const sql = `
                    SELECT
                        tv.id,
                        tv.tool_md5,
                        tv.model_name,
                        tv.tool_name,
                        tv.description,
                        vec_distance_cosine(vte.tool_vector, ?) as distance,
                        (1.0 - vec_distance_cosine(vte.tool_vector, ?)) as similarity,
                        tv.created_at
                    FROM vec_tool_embeddings vte
                    JOIN tool_vectors tv ON tv.id = vte.rowid
                    WHERE (1.0 - vec_distance_cosine(vte.tool_vector, ?)) >= ?
                    ORDER BY distance ASC
                    LIMIT ?
                `;

                stmt = this.db.prepare(sql);
                params = [queryVectorFloat32, queryVectorFloat32, queryVectorFloat32, threshold, limit];
            }

            const results = stmt.all(...params);

            if (serverNames && serverNames.length > 0) {
                dbLogger.info(`📊 Vector search completed, found ${results.length} similar tools (server filter: ${serverNames.join(', ')})`);
            } else {
                dbLogger.info(`📊 Vector search completed, found ${results.length} similar tools`);
            }

            return results;
        } catch (error) {
            dbLogger.error({ err: error }, '❌ Vector similarity search失败');
            throw error;
        }
    }

    /**
     * Query tool information by MD5
     * @param {string} toolMD5 - Tool MD5 hash value
     * @param {string} modelName - Model name
     * @returns {Object|null} Tool information
     */
    getToolByMD5(toolMD5, modelName) {
        try {
            const stmt = this.db.prepare('SELECT * FROM tool_vectors WHERE tool_md5 = ? AND model_name = ?');
            const row = stmt.get(toolMD5, modelName);
            return row || null;
        } catch (error) {
            dbLogger.error({ err: error }, '❌ Failed to query tool by MD5');
            throw error;
        }
    }

    /**
     * Delete tool vector data
     * @param {string} toolMD5 - Tool MD5 hash value
     * @param {string} modelName - Model name
     * @returns {number} Number of deleted records
     */
    deleteToolVector(toolMD5, modelName = null) {
        try {
            // Use transaction to ensure data consistency
            const transaction = this.db.transaction(() => {
                // 1. First find tool IDs to delete
                let toolIds = [];
                if (modelName) {
                    const findStmt = this.db.prepare('SELECT id FROM tool_vectors WHERE tool_md5 = ? AND model_name = ?');
                    const tools = findStmt.all(toolMD5, modelName);
                    toolIds = tools.map(tool => tool.id);
                } else {
                    const findStmt = this.db.prepare('SELECT id FROM tool_vectors WHERE tool_md5 = ?');
                    const tools = findStmt.all(toolMD5);
                    toolIds = tools.map(tool => tool.id);
                }

                if (toolIds.length === 0) {
                    return 0;
                }

                // 2. Delete mapping relationships and vector data
                for (const toolId of toolIds) {
                    const deleteVecStmt = this.db.prepare('DELETE FROM vec_tool_embeddings WHERE rowid = ?');
                    deleteVecStmt.run(toolId);
                }

                // 3. Delete tool metadata
                let result;
                if (modelName) {
                    const deleteStmt = this.db.prepare('DELETE FROM tool_vectors WHERE tool_md5 = ? AND model_name = ?');
                    result = deleteStmt.run(toolMD5, modelName);
                } else {
                    const deleteStmt = this.db.prepare('DELETE FROM tool_vectors WHERE tool_md5 = ?');
                    result = deleteStmt.run(toolMD5);
                }

                return result.changes;
            });

            const deletedCount = transaction();
            
            dbLogger.info(`🗑️  Deleted tool vector: ${toolMD5} (deleted count: ${deletedCount})`);
            return deletedCount;
        } catch (error) {
            dbLogger.error({ err: error }, '❌ Deleted tool vector失败');
            throw error;
        }
    }

    run(sql, params = []) {
        try {
            const stmt = this.db.prepare(sql);
            return stmt.run(...params);
        } catch (error) {
            dbLogger.error({ err: error, sql }, '❌ SQL execution failed');
            throw error;
        }
    }

    /**
     * Get database statistics
     * @returns {Object} Statistics
     */
    getStats() {
        try {
            const totalCountStmt = this.db.prepare('SELECT COUNT(*) as count FROM tool_vectors');
            const totalCount = totalCountStmt.get();

            const vectorCountStmt = this.db.prepare('SELECT COUNT(*) as count FROM vec_tool_embeddings');
            const vectorCount = vectorCountStmt.get();
            
            const modelStatsStmt = this.db.prepare(`
                SELECT model_name, COUNT(*) as count 
                FROM tool_vectors 
                GROUP BY model_name
                ORDER BY model_name
            `);
            const modelStats = modelStatsStmt.all();
            
            const stats = {
                totalTools: totalCount.count,
                totalVectors: vectorCount.count,
                modelStats: modelStats
            };
            
            dbLogger.info('📊 数据库Statistics:', stats);
            return stats;
        } catch (error) {
            dbLogger.error({ err: error }, '❌ 获取Statistics失败');
            throw error;
        }
    }

    /**
     * Get group names for server
     * @param {number} serverId - MCP server ID
     * @returns {Array<string>} Group name list
     */
    getGroupNamesForServer(serverId) {
        try {
            const stmt = this.db.prepare(`
                SELECT g.group_name
                FROM mcp_server_groups msg
                JOIN mcp_groups g ON g.id = msg.group_id
                WHERE msg.server_id = ?
                ORDER BY g.group_name
            `);

            const rows = stmt.all(serverId);
            return rows.map(row => row.group_name);
        } catch (error) {
            dbLogger.error({ err: error }, '❌ Failed to get server groups');
            throw error;
        }
    }

    /**
     * Get server names by group names
     * @param {Array<string>} groupNames - Group name list
     * @param {Object} options - Options
     * @param {boolean} options.enabledOnly - Whether to return only enabled servers
     * @returns {Array<string>} Server names list
     */
    getServerNamesForGroups(groupNames, { enabledOnly = true } = {}) {
        try {
            if (!Array.isArray(groupNames) || groupNames.length === 0) {
                return [];
            }

            const placeholders = groupNames.map(() => '?').join(', ');
            let sql = `
                SELECT DISTINCT ms.server_name
                FROM mcp_groups g
                JOIN mcp_server_groups msg ON g.id = msg.group_id
                JOIN mcp_servers ms ON ms.id = msg.server_id
                WHERE g.group_name IN (${placeholders})
            `;

            if (enabledOnly) {
                sql += ' AND ms.enabled = 1';
            }

            sql += ' ORDER BY ms.server_name';

            const stmt = this.db.prepare(sql);
            const rows = stmt.all(...groupNames);

            const serverNames = rows.map(row => row.server_name);
            return Array.from(new Set(serverNames));
        } catch (error) {
            dbLogger.error({ err: error }, '❌ Failed to get servers by groups');
            throw error;
        }
    }

    /**
     * Get group names for server
     * @param {number} serverId - MCP server ID
     * @returns {Array<string>} Group name list
     */
    getGroupNamesForServer(serverId) {
        try {
            const stmt = this.db.prepare(`
                SELECT g.group_name
                FROM mcp_server_groups msg
                JOIN mcp_groups g ON g.id = msg.group_id
                WHERE msg.server_id = ?
                ORDER BY g.group_name
            `);

            const rows = stmt.all(serverId);
            return rows.map(row => row.group_name);
        } catch (error) {
            console.error('❌ Failed to get server groups:', error.message);
            throw error;
        }
    }

    /**
     * Get server names by group names
     * @param {Array<string>} groupNames - Group name list
     * @param {Object} options - Options
     * @param {boolean} options.enabledOnly - Whether to return only enabled servers
     * @returns {Array<string>} Server names list
     */
    getServerNamesForGroups(groupNames, { enabledOnly = true } = {}) {
        try {
            if (!Array.isArray(groupNames) || groupNames.length === 0) {
                return [];
            }

            const placeholders = groupNames.map(() => '?').join(', ');
            let sql = `
                SELECT DISTINCT ms.server_name
                FROM mcp_groups g
                JOIN mcp_server_groups msg ON g.id = msg.group_id
                JOIN mcp_servers ms ON ms.id = msg.server_id
                WHERE g.group_name IN (${placeholders})
            `;

            if (enabledOnly) {
                sql += ' AND ms.enabled = 1';
            }

            sql += ' ORDER BY ms.server_name';

            const stmt = this.db.prepare(sql);
            const rows = stmt.all(...groupNames);

            const serverNames = rows.map(row => row.server_name);
            return Array.from(new Set(serverNames));
        } catch (error) {
            console.error('❌ Failed to get servers by groups:', error.message);
            throw error;
        }
    }

    /**
     * Get session historical retrieval tools
     * @param {string} sessionId - Session ID
     * @returns {Array} Historical retrieval tool list
     */
    getSessionHistory(sessionId) {
        try {
            const stmt = this.db.prepare(`
                SELECT tool_md5, tool_name, retrieved_at
                FROM session_tool_history
                WHERE session_id = ?
                ORDER BY retrieved_at DESC
            `);
            const results = stmt.all(sessionId);
            dbLogger.info(`📋 Retrieved session history for: ${results.length} tools`);
            return results;
        } catch (error) {
            dbLogger.error({ err: error, sessionId }, '❌ Failed to get session history');
            throw error;
        }
    }

    /**
     * Check if tool was retrieved by session
     * @param {string} sessionId - Session ID
     * @param {string} toolMD5 - 工具MD5
     * @returns {boolean} Whether retrieved
     */
    isToolRetrievedBySession(sessionId, toolMD5) {
        try {
            const stmt = this.db.prepare(`
                SELECT COUNT(*) as count
                FROM session_tool_history
                WHERE session_id = ? AND tool_md5 = ?
            `);
            const result = stmt.get(sessionId, toolMD5);
            return result.count > 0;
        } catch (error) {
            dbLogger.error({ err: error, sessionId, toolMD5 }, '❌ Failed to check tool retrieval status');
            throw error;
        }
    }

    /**
     * Record session tool retrieval
     * @param {string} sessionId - Session ID
     * @param {string} toolMD5 - 工具MD5
     * @param {string} toolName - Tool name
     * @returns {number} 插入的记录ID
     */
    recordSessionToolRetrieval(sessionId, toolMD5, toolName) {
        try {
            const stmt = this.db.prepare(`
                INSERT OR IGNORE INTO session_tool_history (session_id, tool_md5, tool_name)
                VALUES (?, ?, ?)
            `);
            const result = stmt.run(sessionId, toolMD5, toolName);
            if (result.changes > 0) {
                dbLogger.info(`✅ Recorded session tool retrieval: ${sessionId} -> ${toolName} (MD5: ${toolMD5})`);
                return result.lastInsertRowid;
            } else {
                dbLogger.info(`⚠️ Tool already exists, skipping record: ${sessionId} -> ${toolName}`);
                return null;
            }
        } catch (error) {
            dbLogger.error({ err: error, sessionId, toolMD5, toolName }, '❌ Recorded session tool retrieval失败');
            throw error;
        }
    }

    /**
     * 批量Record session tool retrieval
     * @param {string} sessionId - Session ID
     * @param {Array} tools - 工具列表，格式: [{toolMD5, toolName}, ...]
     * @returns {Array<number>} Inserted record ID array
     */
    recordSessionToolRetrievalBatch(sessionId, tools) {
        try {
            const results = [];

            // Start transaction
            const transaction = this.db.transaction((sessionId, tools) => {
                for (const tool of tools) {
                    const { toolMD5, toolName } = tool;
                    const result = this.recordSessionToolRetrieval(sessionId, toolMD5, toolName);
                    if (result) {
                        results.push(result);
                    }
                }
            });

            // Execute transaction
            transaction(sessionId, tools);

            dbLogger.info(`✅ 批量Recorded session tool retrieval完成: ${sessionId} -> ${results.length} new tools`);
            return results;
        } catch (error) {
            dbLogger.error({ err: error, sessionId, toolsCount: tools?.length }, '❌ 批量Recorded session tool retrieval失败');
            throw error;
        }
    }

    /**
     * Clear session history
     * @param {string} sessionId - Session ID
     * @returns {number} Number of deleted records
     */
    clearSessionHistory(sessionId) {
        try {
            const stmt = this.db.prepare('DELETE FROM session_tool_history WHERE session_id = ?');
            const result = stmt.run(sessionId);
            dbLogger.info(`🗑️ Cleared session history: ${sessionId} (deleted count: ${result.changes})`);
            return result.changes;
        } catch (error) {
            dbLogger.error({ err: error, sessionId }, '❌ Cleared session history失败');
            throw error;
        }
    }

    /**
     * 获取session的Statistics
     * @param {string} sessionId - Session ID
     * @returns {Object} Statistics
     */
    getSessionStats(sessionId) {
        try {
            const countStmt = this.db.prepare(`
                SELECT COUNT(*) as count
                FROM session_tool_history
                WHERE session_id = ?
            `);
            const countResult = countStmt.get(sessionId);

            const latestStmt = this.db.prepare(`
                SELECT MAX(retrieved_at) as latest_retrieval
                FROM session_tool_history
                WHERE session_id = ?
            `);
            const latestResult = latestStmt.get(sessionId);

            return {
                session_id: sessionId,
                tools_count: countResult.count,
                latest_retrieval: latestResult.latest_retrieval
            };
        } catch (error) {
            dbLogger.error({ err: error, sessionId }, '❌ 获取sessionStatistics失败');
            throw error;
        }
    }

    /**
     * Close database connection
     */
    close() {
        if (this.db) {
            try {
                this.db.close();
                dbLogger.info('✅ Database connection closed');
            } catch (error) {
                dbLogger.error({ err: error }, '❌ Failed to close database');
                throw error;
            }
        }
    }
}

// Export database instance
export default VectorDatabase;
