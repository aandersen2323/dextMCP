// SQLite数据库管理模块 (使用better-sqlite3 + sqlite-vec)
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 数据库文件路径
const DB_PATH = join(__dirname, 'tools_vector.db');

class VectorDatabase {
    constructor() {
        this.db = null;
    }

    /**
     * 初始化数据库连接
     */
    async initialize() {
        try {
            // 创建数据库连接
            this.db = new Database(DB_PATH);
            
            // 加载sqlite-vec扩展
            this.loadVectorExtension();
            
            // 执行建表语句
            this.createTables();
            
            console.log('✅ 数据库初始化成功 (使用better-sqlite3 + sqlite-vec)');
            console.log(`📁 数据库文件路径: ${DB_PATH}`);
            
            return true;
        } catch (error) {
            console.error('❌ 数据库初始化失败:', error.message);
            throw error;
        }
    }

    /**
     * 加载sqlite-vec扩展
     */
    loadVectorExtension() {
        try {
            sqliteVec.load(this.db);
            console.log('✅ sqlite-vec扩展加载成功');
        } catch (error) {
            console.error('❌ 加载sqlite-vec扩展失败:', error.message);
            throw error;
        }
    }

    /**
     * 创建数据库表
     */
    createTables() {
        try {
            // 读取SQL文件
            const schemaPath = join(__dirname, 'database_schema.sql');
            const schema = readFileSync(schemaPath, 'utf8');
            
            // 解析SQL语句
            const statements = [];
            let currentStatement = '';
            const lines = schema.split('\n');
            
            for (const line of lines) {
                const trimmedLine = line.trim();
                
                // 跳过注释行和空行
                if (trimmedLine.startsWith('--') || trimmedLine === '') {
                    continue;
                }
                
                currentStatement += line + '\n';
                
                // 如果行以分号结尾，表示语句结束
                if (trimmedLine.endsWith(';')) {
                    const statement = currentStatement.trim();
                    if (statement) {
                        statements.push(statement);
                    }
                    currentStatement = '';
                }
            }
            
            // 执行所有SQL语句
            for (const statement of statements) {
                console.log(`📝 执行SQL: ${statement.substring(0, 50)}...`);
                this.db.exec(statement);
            }
            
            console.log('📋 数据库表创建成功');
        } catch (error) {
            console.error('❌ 创建数据库表失败:', error.message);
            throw error;
        }
    }

    /**
     * 生成工具文本的MD5哈希值
     * @param {string} toolName - 工具名称
     * @param {string} description - 工具描述
     * @returns {string} MD5哈希值
     */
    generateToolMD5(toolName, description = '') {
        const text = `${toolName}${description}`.trim();
        return crypto.createHash('md5').update(text, 'utf8').digest('hex');
    }

    /**
     * 保存工具向量数据
     * @param {string} toolName - 工具名称
     * @param {string} description - 工具描述
     * @param {Array<number>} vector - 向量数据
     * @param {string} modelName - 模型名称
     * @returns {number} 插入的记录ID
     */
    saveToolVector(toolName, description, vector, modelName) {
        try {
            const toolMD5 = this.generateToolMD5(toolName, description);

            // 检查是否已存在
            const existingStmt = this.db.prepare('SELECT id FROM tool_vectors WHERE tool_md5 = ? AND model_name = ?');
            const existing = existingStmt.get(toolMD5, modelName);

            let toolId;

            if (existing) {
                // 更新现有记录
                const updateStmt = this.db.prepare('UPDATE tool_vectors SET tool_name = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
                updateStmt.run(toolName, description, existing.id);
                toolId = existing.id;
                console.log(`🔄 更新工具向量: ${toolName} (ID: ${toolId})`);
            } else {
                // 插入新记录
                const insertStmt = this.db.prepare('INSERT INTO tool_vectors (tool_md5, model_name, tool_name, description) VALUES (?, ?, ?, ?)');
                const result = insertStmt.run(toolMD5, modelName, toolName, description);
                toolId = result.lastInsertRowid;
                console.log(`✅ 保存工具元数据: ${toolName} (ID: ${toolId})`);
            }

            // 将向量插入到vec_tool_embeddings表中
            const vectorFloat32 = new Float32Array(vector);
            const vecInsertStmt = this.db.prepare('INSERT INTO vec_tool_embeddings(tool_vector) VALUES (?)');
            const vecResult = vecInsertStmt.run(vectorFloat32);

            const vecRowId = vecResult.lastInsertRowid;

            // 在映射表中建立关联
            const mappingStmt = this.db.prepare('INSERT OR REPLACE INTO tool_mapping (rowid, tool_id) VALUES (?, ?)');
            mappingStmt.run(vecRowId, toolId);

            console.log(`✅ 保存工具向量: ${toolName} (MD5: ${toolMD5}, 向量ID: ${vecRowId}, 维度: ${vector.length})`);

            return toolId;
        } catch (error) {
            console.error(`❌ 保存工具向量失败 (${toolName}):`, error.message);
            throw error;
        }
    }

    /**
     * 批量保存工具向量数据
     * @param {Array} toolsData - 工具数据数组
     * @param {string} modelName - 模型名称
     * @returns {Array<number>} 插入的记录ID数组
     */
    saveToolVectorsBatch(toolsData, modelName) {
        try {
            const results = [];
            
            // 开始事务
            const transaction = this.db.transaction((tools) => {
                for (const toolData of tools) {
                    const { toolName, description, vector } = toolData;
                    const result = this.saveToolVector(toolName, description, vector, modelName);
                    results.push(result);
                }
            });
            
            // 执行事务
            transaction(toolsData);
            
            console.log(`✅ 批量保存完成: ${toolsData.length} 个工具向量`);
            return results;
        } catch (error) {
            console.error('❌ 批量保存工具向量失败:', error.message);
            throw error;
        }
    }

    /**
     * 向量相似性搜索
     * @param {Array<number>} queryVector - 查询向量
     * @param {number} limit - 返回结果数量限制
     * @param {number} threshold - 相似度阈值
     * @param {Array<string>} serverNames - 可选的服务器名称列表，用于过滤工具
     * @returns {Array} 相似工具列表
     */
    searchSimilarVectors(queryVector, limit = 5, threshold = 0.1, serverNames = null) {
        try {
            const queryVectorFloat32 = new Float32Array(queryVector);

            let stmt;
            let params;

            if (serverNames && serverNames.length > 0) {
                // 构建服务器名称过滤条件
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
                    JOIN tool_mapping tm ON vte.rowid = tm.rowid
                    JOIN tool_vectors tv ON tm.tool_id = tv.id
                    WHERE (1.0 - vec_distance_cosine(vte.tool_vector, ?)) >= ?
                    AND (${serverConditions})
                    ORDER BY distance ASC
                    LIMIT ?
                `;

                stmt = this.db.prepare(sql);
                params = [queryVectorFloat32, queryVectorFloat32, queryVectorFloat32, threshold, ...serverParams, limit];
            } else {
                // 不进行服务器过滤的原始查询
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
                    JOIN tool_mapping tm ON vte.rowid = tm.rowid
                    JOIN tool_vectors tv ON tm.tool_id = tv.id
                    WHERE (1.0 - vec_distance_cosine(vte.tool_vector, ?)) >= ?
                    ORDER BY distance ASC
                    LIMIT ?
                `;

                stmt = this.db.prepare(sql);
                params = [queryVectorFloat32, queryVectorFloat32, queryVectorFloat32, threshold, limit];
            }

            const results = stmt.all(...params);

            if (serverNames && serverNames.length > 0) {
                console.log(`📊 向量搜索完成，找到 ${results.length} 个相似工具 (服务器过滤: ${serverNames.join(', ')})`);
            } else {
                console.log(`📊 向量搜索完成，找到 ${results.length} 个相似工具`);
            }

            return results;
        } catch (error) {
            console.error('❌ 向量相似性搜索失败:', error.message);
            throw error;
        }
    }

    /**
     * 根据MD5查询工具信息
     * @param {string} toolMD5 - 工具MD5哈希值
     * @param {string} modelName - 模型名称
     * @returns {Object|null} 工具信息
     */
    getToolByMD5(toolMD5, modelName) {
        try {
            const stmt = this.db.prepare('SELECT * FROM tool_vectors WHERE tool_md5 = ? AND model_name = ?');
            const row = stmt.get(toolMD5, modelName);
            return row || null;
        } catch (error) {
            console.error('❌ 根据MD5查询工具失败:', error.message);
            throw error;
        }
    }

    /**
     * 删除工具向量数据
     * @param {string} toolMD5 - 工具MD5哈希值
     * @param {string} modelName - 模型名称
     * @returns {number} 删除的记录数
     */
    deleteToolVector(toolMD5, modelName = null) {
        try {
            // 使用事务确保数据一致性
            const transaction = this.db.transaction(() => {
                // 1. 首先查找要删除的工具ID
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

                // 2. 删除映射关系和向量数据
                for (const toolId of toolIds) {
                    // 查找映射的向量行
                    const mappingStmt = this.db.prepare('SELECT rowid FROM tool_mapping WHERE tool_id = ?');
                    const mappings = mappingStmt.all(toolId);
                    
                    // 删除向量数据
                    for (const mapping of mappings) {
                        const deleteVecStmt = this.db.prepare('DELETE FROM vec_tool_embeddings WHERE rowid = ?');
                        deleteVecStmt.run(mapping.rowid);
                    }
                    
                    // 删除映射关系
                    const deleteMappingStmt = this.db.prepare('DELETE FROM tool_mapping WHERE tool_id = ?');
                    deleteMappingStmt.run(toolId);
                }

                // 3. 删除工具元数据
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
            
            console.log(`🗑️  删除工具向量: ${toolMD5} (删除数量: ${deletedCount})`);
            return deletedCount;
        } catch (error) {
            console.error('❌ 删除工具向量失败:', error.message);
            throw error;
        }
    }

    /**
     * 获取数据库统计信息
     * @returns {Object} 统计信息
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
            
            console.log('📊 数据库统计信息:', stats);
            return stats;
        } catch (error) {
            console.error('❌ 获取统计信息失败:', error.message);
            throw error;
        }
    }

    /**
     * 获取服务器所属的分组名称列表
     * @param {number} serverId - MCP服务器ID
     * @returns {Array<string>} 分组名称列表
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
            console.error('❌ 获取服务器分组失败:', error.message);
            throw error;
        }
    }

    /**
     * 根据分组名称获取服务器名称列表
     * @param {Array<string>} groupNames - 分组名称列表
     * @param {Object} options - 选项
     * @param {boolean} options.enabledOnly - 是否仅返回启用的服务器
     * @returns {Array<string>} 服务器名称列表
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
            console.error('❌ 根据分组获取服务器失败:', error.message);
            throw error;
        }
    }

    /**
     * 获取session的历史检索工具
     * @param {string} sessionId - 会话ID
     * @returns {Array} 历史检索的工具列表
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
            console.log(`📋 获取session ${sessionId} 的历史记录: ${results.length} 个工具`);
            return results;
        } catch (error) {
            console.error('❌ 获取session历史记录失败:', error.message);
            throw error;
        }
    }

    /**
     * 检查工具是否已被session检索过
     * @param {string} sessionId - 会话ID
     * @param {string} toolMD5 - 工具MD5
     * @returns {boolean} 是否已检索过
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
            console.error('❌ 检查工具检索状态失败:', error.message);
            throw error;
        }
    }

    /**
     * 记录session检索的工具
     * @param {string} sessionId - 会话ID
     * @param {string} toolMD5 - 工具MD5
     * @param {string} toolName - 工具名称
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
                console.log(`✅ 记录session工具检索: ${sessionId} -> ${toolName} (MD5: ${toolMD5})`);
                return result.lastInsertRowid;
            } else {
                console.log(`⚠️ 工具已存在，跳过记录: ${sessionId} -> ${toolName}`);
                return null;
            }
        } catch (error) {
            console.error('❌ 记录session工具检索失败:', error.message);
            throw error;
        }
    }

    /**
     * 批量记录session检索的工具
     * @param {string} sessionId - 会话ID
     * @param {Array} tools - 工具列表，格式: [{toolMD5, toolName}, ...]
     * @returns {Array<number>} 插入的记录ID数组
     */
    recordSessionToolRetrievalBatch(sessionId, tools) {
        try {
            const results = [];

            // 开始事务
            const transaction = this.db.transaction((sessionId, tools) => {
                for (const tool of tools) {
                    const { toolMD5, toolName } = tool;
                    const result = this.recordSessionToolRetrieval(sessionId, toolMD5, toolName);
                    if (result) {
                        results.push(result);
                    }
                }
            });

            // 执行事务
            transaction(sessionId, tools);

            console.log(`✅ 批量记录session工具检索完成: ${sessionId} -> ${results.length} 个新工具`);
            return results;
        } catch (error) {
            console.error('❌ 批量记录session工具检索失败:', error.message);
            throw error;
        }
    }

    /**
     * 清理session的历史记录
     * @param {string} sessionId - 会话ID
     * @returns {number} 删除的记录数
     */
    clearSessionHistory(sessionId) {
        try {
            const stmt = this.db.prepare('DELETE FROM session_tool_history WHERE session_id = ?');
            const result = stmt.run(sessionId);
            console.log(`🗑️ 清理session历史记录: ${sessionId} (删除数量: ${result.changes})`);
            return result.changes;
        } catch (error) {
            console.error('❌ 清理session历史记录失败:', error.message);
            throw error;
        }
    }

    /**
     * 获取session的统计信息
     * @param {string} sessionId - 会话ID
     * @returns {Object} 统计信息
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
            console.error('❌ 获取session统计信息失败:', error.message);
            throw error;
        }
    }

    /**
     * 关闭数据库连接
     */
    close() {
        if (this.db) {
            try {
                this.db.close();
                console.log('✅ 数据库连接已关闭');
            } catch (error) {
                console.error('❌ 关闭数据库失败:', error.message);
                throw error;
            }
        }
    }
}

// 导出数据库实例
export default VectorDatabase;