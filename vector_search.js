// Vector search and tool recommendation module (using sqlite-vec)
import VectorDatabase from './database.js';
import { vectorizeString } from './lib/embedding.js';
import { createChildLogger } from './observability.js';
import { runWithConcurrency } from './lib/utils.js';

// Similarity thresholds for duplicate detection
const SIMILARITY_SEARCH_THRESHOLD = 0.7;
const DUPLICATE_DETECTION_THRESHOLD = 0.96;

const vectorLogger = createChildLogger({ module: 'vector-search' });

class VectorSearch {
    constructor() {
        this.db = new VectorDatabase();
        this.isInitialized = false;
    }

    /**
     * Get default model name from environment or fallback
     * @param {string} modelName - Optional model name override
     * @returns {string} Model name to use
     * @private
     */
    _getDefaultModelName(modelName = null) {
        return modelName
            || process.env.EMBEDDING_NG_MODEL_NAME
            || process.env.EMBEDDING_MODEL_NAME
            || 'doubao-embedding-text-240715';
    }

    /**
     * Initialize vector search engine
     */
    async initialize() {
        try {
            await this.db.initialize();
            this.isInitialized = true;
            vectorLogger.info('🔍 Vector search engine initialized successfully (using better-sqlite3 + sqlite-vec)');
        } catch (error) {
            vectorLogger.error({ err: error }, '❌ Vector search engine initialization failed');
            throw error;
        }
    }

    /**
     * Search for most similar tools (using sqlite-vec for efficient search)
     * @param {string} query - User query text
     * @param {string} modelName - Model name to use
     * @param {number} topK - Return top K most similar results
     * @param {number} threshold - similarity threshold (0-1)
     * @param {Array<string>} serverNames - optional server names used to filter tools
     * @returns {Promise<Array>} list of similar tools
     */
    async searchSimilarTools(query, modelName, topK = 5, threshold = 0.1, serverNames = null) {
        try {
            if (!this.isInitialized) {
                throw new Error('Vector search engine not initialized');
            }

            const serverInfo = serverNames && serverNames.length > 0 ? ` (server filter: ${serverNames.join(', ')})` : '';
            vectorLogger.info(`🔍 Starting search: "${query}" (model: ${modelName}, topK: ${topK}${serverInfo})`);

            // 1. Vectorize query text
            const queryVector = await vectorizeString(query);
            vectorLogger.info(`📊 Query vector dimension: ${queryVector.length}`);

            // 2. perform efficient vector similarity search using sqlite-vec
            const results = await this.db.searchSimilarVectors(queryVector, topK, threshold, serverNames);

            if (results.length === 0) {
                vectorLogger.info('⚠️  No similar tools found matching criteria');
                return [];
            }

            vectorLogger.info(`✅ Search completed, found ${results.length} similar tools (threshold: ${threshold})`);

            // Output detailed results
            results.forEach((result, index) => {
                vectorLogger.info(`${index + 1}. ${result.tool_name} (similarity: ${result.similarity.toFixed(4)}, distance: ${result.distance.toFixed(4)})`);
            });

            return results.map(result => ({
                tool_md5: result.tool_md5,
                tool_name: result.tool_name,
                description: result.description,
                similarity: result.similarity,
                distance: result.distance,
                model_name: result.model_name,
                created_at: result.created_at
            }));

        } catch (error) {
            vectorLogger.error({ err: error }, '❌ Failed to search similar tools');
            throw error;
        }
    }

    /**
     * Find matching tools from the MCP client
     * @param {Array} similarTools - list of similar tools
     * @param {Object} mcpClient - MCP client instance
     * @returns {Promise<Array>} list of matching MCP tools
     */
    async findMatchingMCPTools(similarTools, mcpClient) {
        try {
            if (!mcpClient) {
                throw new Error('MCP client not provided');
            }

            vectorLogger.info('🔄 Fetch currently available tools from the MCP client...');
            
            // Retrieve all currently available MCP tools
            const availableTools = await mcpClient.getTools();
            vectorLogger.info(`📋 Available tool count: ${availableTools.length}`);

            const matchedTools = [];

            for (const similarTool of similarTools) {
                // Match each similar tool MD5 against the available MCP tools
                for (const mcpTool of availableTools) {
                    const toolName = mcpTool.name || mcpTool.tool_name || '';
                    const description = mcpTool.description || '';
                    const calculatedMD5 = this.db.generateToolMD5(toolName, description);

                    if (calculatedMD5 === similarTool.tool_md5) {
                        matchedTools.push({
                            similarity: similarTool.similarity,
                            distance: similarTool.distance,
                            tool_md5: similarTool.tool_md5,
                            mcp_tool: mcpTool,
                            tool_name: toolName,
                            description: description
                        });
                        
                        vectorLogger.info(`✅ Matched tool: ${toolName} (similarity: ${similarTool.similarity.toFixed(4)})`);
                        break;
                    }
                }
            }

            vectorLogger.info(`🎯 Matched ${matchedTools.length} available tools`);
            return matchedTools;

        } catch (error) {
            vectorLogger.error({ err: error }, '❌ Failed to find matching MCP tools');
            throw error;
        }
    }

    /**
     * Complete tool recommendation flow
     * @param {string} query - User query
     * @param {Object} mcpClient - MCP client instance
     * @param {string} modelName - Model name
     * @param {Object} options - search options
     * @returns {Promise<Array>} list of recommended tools
     */
    async recommendTools(query, mcpClient, modelName = null, options = {}) {
        try {
            // Use the default model name when none is provided
            const defaultModelName = this._getDefaultModelName(modelName);

            const {
                topK = 5,
                threshold = 0.1,
                includeDetails = true,
                serverNames = null,
                groupNames = null
            } = options;

            vectorLogger.info(`🤖 Starting tool recommendation flow (using sqlite-vec)...`);
            vectorLogger.info(`📝 Query: "${query}"`);
            vectorLogger.info(`🔧 Model: ${defaultModelName}`);
            const serverInfo = serverNames && serverNames.length > 0 ? `, server filter: ${serverNames.join(', ')}` : '';
            const groupInfo = groupNames && groupNames.length > 0 ? `, group filter: ${groupNames.join(', ')}` : '';
            vectorLogger.info(`⚙️  Parameters: topK=${topK}, threshold=${threshold}${serverInfo}${groupInfo}`);

            let effectiveServerNames = serverNames;

            if (groupNames && groupNames.length > 0) {
                const groupServerNames = this.db.getServerNamesForGroups(groupNames);

                if (groupServerNames.length === 0) {
                    vectorLogger.info('⚠️  Specified groups did not match any servers; returning empty result');
                    return [];
                }

                if (effectiveServerNames && effectiveServerNames.length > 0) {
                    effectiveServerNames = effectiveServerNames.filter(name => groupServerNames.includes(name));

                    if (effectiveServerNames.length === 0) {
                        vectorLogger.info('⚠️  Group filter and server filter do not overlap; returning empty result');
                        return [];
                    }
                } else {
                    effectiveServerNames = groupServerNames;
                }
            }

            // 1. Search similar tools
            const similarTools = await this.searchSimilarTools(query, defaultModelName, topK, threshold, effectiveServerNames);

            if (similarTools.length === 0) {
                vectorLogger.info('⚠️  No similar tools found');
                return [];
            }

            // 2. Find matches in the current MCP tools
            const matchedTools = await this.findMatchingMCPTools(similarTools, mcpClient);

            // 3. Format results
            const recommendations = matchedTools.map((tool, index) => {
                const result = {
                    rank: index + 1,
                    tool_name: tool.tool_name,
                    similarity: tool.similarity,
                    distance: tool.distance,
                    tool_md5: tool.tool_md5
                };

                if (includeDetails) {
                    result.description = tool.description;
                    result.mcp_tool = tool.mcp_tool;
                }

                return result;
            });

            vectorLogger.info(`🎉 Tool recommendation completed, returning ${recommendations.length} recommended results`);

            return recommendations;

        } catch (error) {
            vectorLogger.error({ err: error }, '❌ Tool recommendation failed');
            throw error;
        }
    }

    /**
     * Generate and persist vectors for MCP tools in batches
     * @param {Object} mcpClient - MCP client instance
     * @param {string} modelName - Model name
     * @returns {Promise<Array>} persistence results
     */
    async indexMCPTools(mcpClient, modelName = null) {
        try {
            const defaultModelName = this._getDefaultModelName(modelName);

            vectorLogger.info('📊 Starting vector indexing for MCP tools (using sqlite-vec)...');
            vectorLogger.info(`🔧 Model in use: ${defaultModelName}`);

            // Fetch all MCP tools
            const tools = await mcpClient.getTools();
            vectorLogger.info(`📋 Retrieved ${tools.length} MCP tools`);

            const toolsToVectorize = [];

            for (const tool of tools) {
                const toolName = tool.name || tool.tool_name || '';
                const description = tool.description || '';
                
                if (toolName) {
                    // Check whether it already exists
                    const toolMD5 = this.db.generateToolMD5(toolName, description);
                    const existing = await this.db.getToolByMD5(toolMD5, defaultModelName);
                    
                    if (!existing) {
                        toolsToVectorize.push({
                            toolName,
                            description,
                            originalTool: tool
                        });
                    } else {
                        vectorLogger.info(`⏭️  Skip existing tool: ${toolName}`);
                    }
                }
            }

            if (toolsToVectorize.length === 0) {
                vectorLogger.info('✅ All tools already indexed; no action needed');
                return [];
            }

            vectorLogger.info(`🎯 Preparing to vectorize ${toolsToVectorize.length} new tools`);

            // Vectorize and inspect for similar tools
            const vectorizedTools = [];
            const deletedToolsCount = { total: 0 };
            const concurrencyFromEnv = parseInt(process.env.VECTORIZE_CONCURRENCY || '4', 10);
            const concurrencyLimit = Number.isFinite(concurrencyFromEnv) && concurrencyFromEnv > 0 ? concurrencyFromEnv : 4;

            await runWithConcurrency(toolsToVectorize, concurrencyLimit, async (tool, index) => {
                try {
                    vectorLogger.info(`📊 Vectorization progress: ${index + 1}/${toolsToVectorize.length} - ${tool.toolName}`);

                    const vector = await vectorizeString(`${tool.toolName} ${tool.description}`.trim());

                    vectorLogger.info(`🔍 Check for similar tools: ${tool.toolName}`);

                    try {
                        const queryVector = vector;
                        const similarTools = await this.db.searchSimilarVectors(queryVector, 10, SIMILARITY_SEARCH_THRESHOLD);

                        if (similarTools.length > 0) {
                            vectorLogger.info(`📊 Found ${similarTools.length} candidate similar tools`);

                            const toDelete = this.identifySimilarToolsToDelete(
                                tool.toolName,
                                tool.description,
                                similarTools,
                                DUPLICATE_DETECTION_THRESHOLD
                            );

                            for (const oldTool of toDelete) {
                                try {
                                    const deletedCount = await this.db.deleteToolVector(
                                        oldTool.tool_md5,
                                        defaultModelName
                                    );
                                    if (deletedCount > 0) {
                                        deletedToolsCount.total += deletedCount;
                                        vectorLogger.info(`🗑️  Removed similar tool: ${oldTool.tool_name} (similarity: ${oldTool.similarity.toFixed(4)})`);
                                    }
                                } catch (deleteError) {
                                    vectorLogger.warn(`⚠️  Failed to delete tool "${oldTool.tool_name}": ${deleteError.message}`);
                                }
                            }

                            if (toDelete.length > 0) {
                                vectorLogger.info(`✅ For new tool "${tool.toolName}" cleaned up ${toDelete.length} similar existing tools`);
                            }
                        }

                    } catch (searchError) {
                        vectorLogger.warn(`⚠️  Failed to search similar tools for "${tool.toolName}": ${searchError.message}`);
                    }

                    vectorizedTools.push({
                        toolName: tool.toolName,
                        description: tool.description,
                        vector: vector
                    });

                } catch (error) {
                    vectorLogger.warn(`⚠️  Skipping tool "${tool.toolName}": ${error.message}`);
                }
            });

            // Persist in batch to the database
            const saveResults = await this.db.saveToolVectorsBatch(vectorizedTools, defaultModelName);
            
            vectorLogger.info(`✅ Vector index build completed (using sqlite-vec):`);
            vectorLogger.info(`   - Total tools: ${tools.length}`);
            vectorLogger.info(`   - Newly vectorized: ${vectorizedTools.length}`);
            vectorLogger.info(`   - Saved to database: ${saveResults.length}`);
            vectorLogger.info(`   - Deleted similar tools: ${deletedToolsCount.total}`);

            return saveResults;

        } catch (error) {
            vectorLogger.error({ err: error }, '❌ Failed to build MCP tool vector index');
            throw error;
        }
    }

    /**
     * Compute string similarity (Levenshtein distance)
     * @param {string} str1 - First string
     * @param {string} str2 - Second string
     * @returns {number} similarity score (0-1)
     */
    calculateNameSimilarity(str1, str2) {
        if (!str1 || !str2) return 0;
        if (str1 === str2) return 1;

        const len1 = str1.length;
        const len2 = str2.length;
        const maxLen = Math.max(len1, len2);
        
        if (maxLen === 0) return 1;

        // Compute the Levenshtein distance
        const matrix = Array(len2 + 1).fill().map(() => Array(len1 + 1).fill(0));
        
        for (let i = 0; i <= len1; i++) matrix[0][i] = i;
        for (let j = 0; j <= len2; j++) matrix[j][0] = j;
        
        for (let j = 1; j <= len2; j++) {
            for (let i = 1; i <= len1; i++) {
                if (str1[i - 1] === str2[j - 1]) {
                    matrix[j][i] = matrix[j - 1][i - 1];
                } else {
                    matrix[j][i] = Math.min(
                        matrix[j - 1][i] + 1,     // delete
                        matrix[j][i - 1] + 1,     // insert
                        matrix[j - 1][i - 1] + 1  // replace
                    );
                }
            }
        }
        
        const distance = matrix[len2][len1];
        return 1 - (distance / maxLen);
    }

    /**
     * Identify similar tools that should be removed
     * @param {string} newToolName - New tool name
     * @param {string} newDescription - New tool description
     * @param {Array} similarTools - list of similar tools
     * @param {number} similarityThreshold - similarity threshold (default DUPLICATE_DETECTION_THRESHOLD)
     * @returns {Array} Tools flagged for deletion
     */
    identifySimilarToolsToDelete(newToolName, newDescription, similarTools, similarityThreshold = DUPLICATE_DETECTION_THRESHOLD) {
        const toDelete = [];

        vectorLogger.info(`🔍 Checking whether ${similarTools.length} similar tools should be removed (threshold: ${similarityThreshold})`);

        for (const similar of similarTools) {
            const vectorSimilarity = similar.similarity;
            const nameSimilarity = this.calculateNameSimilarity(newToolName, similar.tool_name);

            vectorLogger.info(`📊 Tool "${similar.tool_name}":`);
            vectorLogger.info(`   - Vector similarity: ${vectorSimilarity.toFixed(4)}`);
            vectorLogger.info(`   - Name similarity: ${nameSimilarity.toFixed(4)}`);

            // Tools with high vector similarity are considered duplicates
            if (vectorSimilarity >= similarityThreshold) {
                vectorLogger.info(`🎯 Marked as extremely similar and scheduled for deletion: ${similar.tool_name}`);
                toDelete.push(similar);
            } else {
                vectorLogger.info(`✅ Keep tool: ${similar.tool_name} (similarity below threshold)`);
            }
        }

        vectorLogger.info(`🗑️  Total tools to delete: ${toDelete.length}`);
        return toDelete;
    }

    /**
     * Search vectors directly (no MCP client required)
     * @param {string} query - Query text
     * @param {Object} options - search options
     * @returns {Promise<Array>} list of similar tool MD5 hashes
     */
    async searchSimilar(query, options = {}) {
        try {
            if (!this.isInitialized) {
                throw new Error('Vector search engine not initialized');
            }

            const {
                topK = 5,
                threshold = 0.1,
                modelName = null
            } = options;

            const defaultModelName = this._getDefaultModelName(modelName);
            const results = await this.searchSimilarTools(query, defaultModelName, topK, threshold);
            return results;

        } catch (error) {
            vectorLogger.error({ err: error }, '❌ Failed to search similar tools');
            throw error;
        }
    }

    /**
     * Get search engine statistics
     */
    async getSearchStats() {
        try {
            const dbStats = await this.db.getStats();
            return {
                isInitialized: this.isInitialized,
                database: dbStats,
                engine: 'sqlite-vec'
            };
        } catch (error) {
            vectorLogger.error({ err: error }, '❌ Failed to retrieve search statistics');
            throw error;
        }
    }

    /**
     * Clear index
     * @param {string} modelName - Model name
     * @returns {Promise<number>} number of cleared records
     */
    async clearIndex(modelName = null) {
        try {
            const defaultModelName = this._getDefaultModelName(modelName);

            vectorLogger.info(`🗑️  Clearing vector index: ${defaultModelName}`);
            
            // This step clears data from the vector table
            // Due to sqlite-vec limitations, the table must be recreated
            await this.db.run('DELETE FROM vec_tool_embeddings');
            await this.db.run('DELETE FROM tool_vectors WHERE model_name = ?', [defaultModelName]);
            
            vectorLogger.info('✅ Vector index cleanup complete');
            
        } catch (error) {
            vectorLogger.error({ err: error }, '❌ Failed to clear vector index');
            throw error;
        }
    }

    /**
     * Shut down the vector search engine
     */
    async close() {
        try {
            await this.db.close();
            this.isInitialized = false;
            vectorLogger.info('✅ Vector search engine closed');
        } catch (error) {
            vectorLogger.error({ err: error }, '❌ Failed to shut down the vector search engine');
            throw error;
        }
    }
}

export default VectorSearch;
