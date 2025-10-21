// Vector search and tool recommendation module (sqlite-vec)
import VectorDatabase from './database.js';
import { vectorizeString } from './lib/embedding.js';
import { createChildLogger } from './observability.js';

async function runWithConcurrency(items, limit, handler) {
    const concurrency = Math.max(1, Number.isFinite(limit) ? limit : 1);
    let index = 0;

    const workers = Array.from({ length: Math.min(concurrency, items.length || 0) }, async () => {
        while (true) {
            const currentIndex = index;
            index += 1;

            if (currentIndex >= items.length) {
                break;
            }

            await handler(items[currentIndex], currentIndex);
        }
    });

    await Promise.all(workers);
}

const vectorLogger = createChildLogger({ module: 'vector-search' });

class VectorSearch {
    constructor() {
        this.db = new VectorDatabase();
        this.isInitialized = false;
    }

    /**
     * Initialize the vector search engine
     */
    async initialize() {
        try {
            await this.db.initialize();
            this.isInitialized = true;
            vectorLogger.info('🔍 Vector search engine initialized (better-sqlite3 + sqlite-vec)');
        } catch (error) {
            vectorLogger.error({ err: error }, '❌ Failed to initialize vector search engine');
            throw error;
        }
    }

    /**
     * Search for similar tools (sqlite-vec optimized)
     * @param {string} query - User query text
     * @param {string} modelName - Embedding model name
     * @param {number} topK - Number of similar tools to return
     * @param {number} threshold - Similarity threshold (0-1)
     * @param {Array<string>} serverNames - Optional server names for filtering
     * @returns {Promise<Array>} Similar tools
     */
    async searchSimilarTools(query, modelName, topK = 5, threshold = 0.1, serverNames = null) {
        try {
            if (!this.isInitialized) {
                throw new Error('Vector search engine is not initialized');
            }

            const serverInfo = serverNames && serverNames.length > 0 ? ` (server filter: ${serverNames.join(', ')})` : '';
            vectorLogger.info(`🔍 Begin search: "${query}" (model: ${modelName}, topK: ${topK}${serverInfo})`);

            // 1. Embed the query text
            const queryVector = await vectorizeString(query);
            vectorLogger.info(`📊 Query vector dimension: ${queryVector.length}`);

            // 2. Run sqlite-vec similarity search
            const results = await this.db.searchSimilarVectors(queryVector, topK, threshold, serverNames);

            if (results.length === 0) {
                vectorLogger.info('⚠️  No tools met the similarity threshold');
                return [];
            }

            vectorLogger.info(`✅ Search completed with ${results.length} similar tools (threshold: ${threshold})`);

            // Log detailed results
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
     * Locate matching tools from the MCP client
     * @param {Array} similarTools - List of similar tools
     * @param {Object} mcpClient - MCP client instance
     * @returns {Promise<Array>} Matching MCP tools
     */
    async findMatchingMCPTools(similarTools, mcpClient) {
        try {
            if (!mcpClient) {
                throw new Error('MCP client not provided');
            }

            vectorLogger.info('🔄 Fetching current tools from MCP client...');
            
            // Fetch all available MCP tools
            const availableTools = await mcpClient.getTools();
            vectorLogger.info(`📋 Available tool count: ${availableTools.length}`);

            const matchedTools = [];

            for (const similarTool of similarTools) {
                // Match each similar tool MD5 against available MCP tools
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
                        
                        vectorLogger.info(`✅ Matching tool found: ${toolName} (similarity: ${similarTool.similarity.toFixed(4)})`);
                        break;
                    }
                }
            }

            vectorLogger.info(`🎯 Matched ${matchedTools.length} available tools`);
            return matchedTools;

        } catch (error) {
            vectorLogger.error({ err: error }, '❌ Failed to resolve MCP tools');
            throw error;
        }
    }

    /**
     * Full tool recommendation workflow
     * @param {string} query - User query
     * @param {Object} mcpClient - MCP client instance
     * @param {string} modelName - Model name
     * @param {Object} options - Search options
     * @returns {Promise<Array>} Recommended tools
     */
    async recommendTools(query, mcpClient, modelName = null, options = {}) {
        try {
            // Use the default model name
            const defaultModelName = modelName
                || process.env.EMBEDDING_NG_MODEL_NAME
                || process.env.EMBEDDING_MODEL_NAME
                || 'doubao-embedding-text-240715';

            const {
                topK = 5,
                threshold = 0.1,
                includeDetails = true,
                serverNames = null,
                groupNames = null
            } = options;

            vectorLogger.info('🤖 Starting tool recommendation workflow (sqlite-vec)...');
            vectorLogger.info(`📝 Query: "${query}"`);
            vectorLogger.info(`🔧 Model: ${defaultModelName}`);
            const serverInfo = serverNames && serverNames.length > 0 ? `, server filter: ${serverNames.join(', ')}` : '';
            const groupInfo = groupNames && groupNames.length > 0 ? `, group filter: ${groupNames.join(', ')}` : '';
            vectorLogger.info(`⚙️  Params: topK=${topK}, threshold=${threshold}${serverInfo}${groupInfo}`);

            let effectiveServerNames = serverNames;

            if (groupNames && groupNames.length > 0) {
                const groupServerNames = this.db.getServerNamesForGroups(groupNames);

                if (groupServerNames.length === 0) {
                    vectorLogger.info('⚠️  No servers matched the requested groups; returning empty result');
                    return [];
                }

                if (effectiveServerNames && effectiveServerNames.length > 0) {
                    effectiveServerNames = effectiveServerNames.filter(name => groupServerNames.includes(name));

                    if (effectiveServerNames.length === 0) {
                        vectorLogger.info('⚠️  Group filter and server filter do not intersect; returning empty result');
                        return [];
                    }
                } else {
                    effectiveServerNames = groupServerNames;
                }
            }

            // 1. Search for similar tools
            const similarTools = await this.searchSimilarTools(query, defaultModelName, topK, threshold, effectiveServerNames);

            if (similarTools.length === 0) {
                vectorLogger.info('⚠️  No similar tools found');
                return [];
            }

            // 2. Match results against current MCP tools
            const matchedTools = await this.findMatchingMCPTools(similarTools, mcpClient);

            // 3. Format the results
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

            vectorLogger.info(`🎉 Tool recommendation complete with ${recommendations.length} results`);

            return recommendations;

        } catch (error) {
            vectorLogger.error({ err: error }, '❌ Tool recommendation failed');
            throw error;
        }
    }

    /**
     * Batch-generate and store vectors for MCP tools
     * @param {Object} mcpClient - MCP client instance
     * @param {string} modelName - Model name
     * @returns {Promise<Array>} Saved results
     */
    async indexMCPTools(mcpClient, modelName = null) {
        try {
            const defaultModelName = modelName
                || process.env.EMBEDDING_NG_MODEL_NAME
                || process.env.EMBEDDING_MODEL_NAME
                || 'doubao-embedding-text-240715';
            
            vectorLogger.info('📊 Building vector index for MCP tools (sqlite-vec)...');
            vectorLogger.info(`🔧 Using model: ${defaultModelName}`);

            // Retrieve all MCP tools
            const tools = await mcpClient.getTools();
            vectorLogger.info(`📋 Retrieved ${tools.length} MCP tools`);

            const toolsToVectorize = [];

            for (const tool of tools) {
                const toolName = tool.name || tool.tool_name || '';
                const description = tool.description || '';
                
                if (toolName) {
                    // Check if the tool already exists
                    const toolMD5 = this.db.generateToolMD5(toolName, description);
                    const existing = await this.db.getToolByMD5(toolMD5, defaultModelName);
                    
                    if (!existing) {
                        toolsToVectorize.push({
                            toolName,
                            description,
                            originalTool: tool
                        });
                    } else {
                        vectorLogger.info(`⏭️  Skipping existing tool: ${toolName}`);
                    }
                }
            }

            if (toolsToVectorize.length === 0) {
                vectorLogger.info('✅ All tools already indexed; nothing to do');
                return [];
            }

            vectorLogger.info(`🎯 Preparing to embed ${toolsToVectorize.length} new tools`);

            // Embed and check for similar tools
            const vectorizedTools = [];
            const deletedToolsCount = { total: 0 };
            const concurrencyFromEnv = parseInt(process.env.VECTORIZE_CONCURRENCY || '4', 10);
            const concurrencyLimit = Number.isFinite(concurrencyFromEnv) && concurrencyFromEnv > 0 ? concurrencyFromEnv : 4;

            await runWithConcurrency(toolsToVectorize, concurrencyLimit, async (tool, index) => {
                try {
                    vectorLogger.info(`📊 Embedding progress: ${index + 1}/${toolsToVectorize.length} - ${tool.toolName}`);

                    const vector = await vectorizeString(`${tool.toolName} ${tool.description}`.trim());

                    vectorLogger.info(`🔍 Checking for similar tools: ${tool.toolName}`);

                    try {
                        const queryVector = vector;
                        const similarTools = await this.db.searchSimilarVectors(queryVector, 10, 0.7);

                        if (similarTools.length > 0) {
                            vectorLogger.info(`📊 Found ${similarTools.length} candidate similar tools`);

                            const toDelete = this.identifySimilarToolsToDelete(
                                tool.toolName,
                                tool.description,
                                similarTools,
                                0.96
                            );

                            for (const oldTool of toDelete) {
                                try {
                                    const deletedCount = await this.db.deleteToolVector(
                                        oldTool.tool_md5,
                                        defaultModelName
                                    );
                                    if (deletedCount > 0) {
                                        deletedToolsCount.total += deletedCount;
                                        vectorLogger.info(`🗑️  Deleted similar tool: ${oldTool.tool_name} (similarity: ${oldTool.similarity.toFixed(4)})`);
                                    }
                                } catch (deleteError) {
                                    vectorLogger.warn(`⚠️  Failed to delete tool "${oldTool.tool_name}": ${deleteError.message}`);
                                }
                            }

                            if (toDelete.length > 0) {
                                vectorLogger.info(`✅ Removed ${toDelete.length} similar tools for new entry "${tool.toolName}"`);
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

            // Batch save to the database
            const saveResults = await this.db.saveToolVectorsBatch(vectorizedTools, defaultModelName);
            
            vectorLogger.info(`✅ Vector indexing complete (sqlite-vec):`);
            vectorLogger.info(`   - Total tools: ${tools.length}`);
            vectorLogger.info(`   - Newly embedded: ${vectorizedTools.length}`);
            vectorLogger.info(`   - Saved to database: ${saveResults.length}`);
            vectorLogger.info(`   - Deleted similar tools: ${deletedToolsCount.total}`);

            return saveResults;

        } catch (error) {
            vectorLogger.error({ err: error }, '❌ Failed to build MCP tool vector index');
            throw error;
        }
    }

    /**
     * Compute the similarity of two strings (Levenshtein)
     * @param {string} str1 - First string
     * @param {string} str2 - Second string
     * @returns {number} Similarity score (0-1)
     */
    calculateNameSimilarity(str1, str2) {
        if (!str1 || !str2) return 0;
        if (str1 === str2) return 1;

        const len1 = str1.length;
        const len2 = str2.length;
        const maxLen = Math.max(len1, len2);
        
        if (maxLen === 0) return 1;

        // Compute Levenshtein distance
        const matrix = Array(len2 + 1).fill().map(() => Array(len1 + 1).fill(0));
        
        for (let i = 0; i <= len1; i++) matrix[0][i] = i;
        for (let j = 0; j <= len2; j++) matrix[j][0] = j;
        
        for (let j = 1; j <= len2; j++) {
            for (let i = 1; i <= len1; i++) {
                if (str1[i - 1] === str2[j - 1]) {
                    matrix[j][i] = matrix[j - 1][i - 1];
                } else {
                    matrix[j][i] = Math.min(
                        matrix[j - 1][i] + 1,     // Deletion
                        matrix[j][i - 1] + 1,     // Insertion
                        matrix[j - 1][i - 1] + 1  // Substitution
                    );
                }
            }
        }
        
        const distance = matrix[len2][len1];
        return 1 - (distance / maxLen);
    }

    /**
     * Identify similar tools to delete
     * @param {string} newToolName - New tool name
     * @param {string} newDescription - New tool description
     * @param {Array} similarTools - List of similar tools
     * @param {number} similarityThreshold - Similarity threshold (default 0.96)
     * @returns {Array} Tools slated for deletion
     */
    identifySimilarToolsToDelete(newToolName, newDescription, similarTools, similarityThreshold = 0.96) {
        const toDelete = [];
        
        vectorLogger.info(`🔍 Evaluating ${similarTools.length} similar tools for deletion (threshold: ${similarityThreshold})`);
        
        for (const similar of similarTools) {
            const vectorSimilarity = similar.similarity;
            const nameSimilarity = this.calculateNameSimilarity(newToolName, similar.tool_name);
            
            vectorLogger.info(`📊 Tool "${similar.tool_name}":`);
            vectorLogger.info(`   - Vector similarity: ${vectorSimilarity.toFixed(4)}`);
            vectorLogger.info(`   - Name similarity: ${nameSimilarity.toFixed(4)}`);
            
            // Rule: similarity >= 0.96 counts as a near-duplicate
            if (vectorSimilarity >= similarityThreshold) {
                vectorLogger.info(`🎯 Marked as near-duplicate; deleting: ${similar.tool_name}`);
                toDelete.push(similar);
            } else {
                vectorLogger.info(`✅ Keeping tool: ${similar.tool_name} (below threshold)`);
            }
        }
        
        vectorLogger.info(`🗑️  Total tools to delete: ${toDelete.length}`);
        return toDelete;
    }

    /**
     * Search vectors directly (without MCP client)
     * @param {string} query - Query text
     * @param {Object} options - Search options
     * @returns {Promise<Array>} Similar tool MD5 list
     */
    async searchSimilar(query, options = {}) {
        try {
            if (!this.isInitialized) {
                throw new Error('Vector search engine is not initialized');
            }

            const {
                topK = 5,
                threshold = 0.1,
                modelName = process.env.EMBEDDING_NG_MODEL_NAME
                    || process.env.EMBEDDING_MODEL_NAME
                    || 'doubao-embedding-text-240715'
            } = options;

            const results = await this.searchSimilarTools(query, modelName, topK, threshold);
            return results;

        } catch (error) {
            vectorLogger.error({ err: error }, '❌ Failed to search similar tools');
            throw error;
        }
    }

    /**
     * Retrieve search engine statistics
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
            vectorLogger.error({ err: error }, '❌ Failed to fetch search statistics');
            throw error;
        }
    }

    /**
     * Clean the index
     * @param {string} modelName - Model name
     * @returns {Promise<number>} Rows removed
     */
    async clearIndex(modelName = null) {
        try {
            const defaultModelName = modelName
                || process.env.EMBEDDING_NG_MODEL_NAME
                || process.env.EMBEDDING_MODEL_NAME
                || 'doubao-embedding-text-240715';
            
            vectorLogger.info(`🗑️  Clearing vector index: ${defaultModelName}`);
            
            // Purge rows from the vector table
            // sqlite-vec requires recreating the table
            await this.db.run('DELETE FROM vec_tool_embeddings');
            await this.db.run('DELETE FROM tool_vectors WHERE model_name = ?', [defaultModelName]);
            
            vectorLogger.info('✅ Vector index cleanup complete');
            
        } catch (error) {
            vectorLogger.error({ err: error }, '❌ Failed to clean vector index');
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
            vectorLogger.error({ err: error }, '❌ Failed to close vector search engine');
            throw error;
        }
    }
}

export default VectorSearch;
