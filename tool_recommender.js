// Tool recommendation API module
// Provide simple and easy-to-use tool recommendation interface

import VectorSearch from './vector_search.js';

class ToolRecommender {
    constructor() {
        this.vectorSearch = null;
        this.isReady = false;
    }

    /**
     * Initialize tool recommendation system
     * @param {Object} mcpClient - MCP client instance
     * @param {Object} options - Initialization options
     */
    async initialize(mcpClient, options = {}) {
        try {
            console.log('🚀 Initialize tool recommendation system...');
            
            this.mcpClient = mcpClient;
            this.vectorSearch = new VectorSearch();
            
            // Initialize vector search engine
            await this.vectorSearch.initialize();

            // Configure options
            const {
                autoIndex = true,  // Whether to auto-index
                modelName = null   // Model name
            } = options;
            
            this.modelName = modelName
                || process.env.EMBEDDING_NG_MODEL_NAME
                || process.env.EMBEDDING_MODEL_NAME
                || 'doubao-embedding-text-240715';
            
            // Auto-build vector index for MCP tools
            if (autoIndex && mcpClient) {
                console.log('📊 Auto-build vector index for MCP tools...');
                await this.vectorSearch.indexMCPTools(mcpClient, this.modelName);
            }
            
            this.isReady = true;
            console.log('✅ Tool recommendation system initialization completed');
            
        } catch (error) {
            console.error('❌ Tool recommendation system initialization failed:', error.message);
            throw error;
        }
    }

    /**
     * Recommend tools - main API entry point
     * @param {string} query - User query text
     * @param {Object} options - Recommendation options
     * @returns {Promise<Array>} List of recommended tools
     */
    async recommend(query, options = {}) {
        try {
            if (!this.isReady) {
                throw new Error('Tool recommendation system is not initialized');
            }

            const {
                topK = 3,           // Return the first K results
                threshold = 0.1,    // Similarity threshold
                includeDetails = false,  // Include detail information
                format = 'simple',   // Return format: simple, detailed, raw
                serverNames = undefined,
                groupNames = undefined
            } = options;

            console.log(`🔍 Recommend tools: "${query}"`);

            // Retrieve recommendation results
            const recommendations = await this.vectorSearch.recommendTools(
                query,
                this.mcpClient,
                this.modelName,
                { topK, threshold, includeDetails: true, serverNames, groupNames }
            );

            // Return results in requested format
            return this.formatResults(recommendations, format, includeDetails);

        } catch (error) {
            console.error('❌ Tool recommendation failed:', error.message);
            throw error;
        }
    }

    /**
     * Recommend tools in batch
     * @param {Array<string>} queries - Array of query texts
     * @param {Object} options - Recommendation options
     * @returns {Promise<Array>} Batch recommendation results
     */
    async batchRecommend(queries, options = {}) {
        try {
            console.log(`🔍 Batch tool recommendation: ${queries.length} queries`);

            const results = [];

            for (let i = 0; i < queries.length; i++) {
                const query = queries[i];
                console.log(`📋 Processing query ${i + 1}/${queries.length}: "${query}"`);

                try {
                    const recommendations = await this.recommend(query, options);
                    results.push({
                        query,
                        recommendations,
                        success: true
                    });
                } catch (error) {
                    console.warn(`⚠️  Query failed "${query}": ${error.message}`);
                    results.push({
                        query,
                        recommendations: [],
                        success: false,
                        error: error.message
                    });
                }
            }

            console.log(`✅ Batch recommendation completed: ${results.length} results`);
            return results;

        } catch (error) {
            console.error('❌ Batch tool recommendation failed:', error.message);
            throw error;
        }
    }

    /**
     * Get the best tool recommendation (returns the single tool with highest similarity)
     * @param {string} query - User query text
     * @param {number} threshold - Minimum similarity threshold
     * @returns {Promise<Object|null>} The best recommended tool or null
     */
    async getBestTool(query, threshold = 0.3) {
        try {
            const recommendations = await this.recommend(query, { 
                topK: 1, 
                threshold,
                format: 'detailed'
            });
            
            return recommendations.length > 0 ? recommendations[0] : null;

        } catch (error) {
            console.error('❌ Failed to get best tool:', error.message);
            throw error;
        }
    }

    /**
     * Format recommendation results
     * @param {Array} recommendations - Raw recommendation results
     * @param {string} format - Format type
     * @param {boolean} includeDetails - Whether to include detail information
     * @returns {Array} Formatted results
     */
    formatResults(recommendations, format, includeDetails) {
        switch (format) {
            case 'simple':
                return recommendations.map(tool => ({
                    name: tool.tool_name,
                    similarity: parseFloat(tool.similarity.toFixed(4))
                }));

            case 'detailed':
                return recommendations.map(tool => ({
                    rank: tool.rank,
                    name: tool.tool_name,
                    description: tool.description,
                    similarity: parseFloat(tool.similarity.toFixed(4)),
                    confidence: this.getConfidenceLevel(tool.similarity)
                }));

            case 'raw':
                return recommendations;

            default:
                return includeDetails ? 
                    this.formatResults(recommendations, 'detailed', true) :
                    this.formatResults(recommendations, 'simple', false);
        }
    }

    /**
     * Derive confidence level from similarity score
     * @param {number} similarity - Similarity score
     * @returns {string} Confidence level
     */
    getConfidenceLevel(similarity) {
        if (similarity >= 0.8) return 'very_high';
        if (similarity >= 0.6) return 'high';
        if (similarity >= 0.4) return 'medium';
        if (similarity >= 0.2) return 'low';
        return 'very_low';
    }

    /**
     * Re-index MCP tools
     * @returns {Promise<Array>} Indexing results
     */
    async reindex() {
        try {
            if (!this.isReady) {
                throw new Error('Tool recommendation system is not initialized');
            }

            console.log('🔄 Re-indexing MCP tools...');
            const results = await this.vectorSearch.indexMCPTools(this.mcpClient, this.modelName);
            console.log('✅ Re-index completed');

            return results;

        } catch (error) {
            console.error('❌ Re-index failed:', error.message);
            throw error;
        }
    }

    /**
     * Retrieve system status and statistics
     * @returns {Promise<Object>} System status
     */
    async getStatus() {
        try {
            const status = {
                isReady: this.isReady,
                modelName: this.modelName,
                hasMCPClient: !!this.mcpClient
            };

            if (this.vectorSearch) {
                const searchStats = await this.vectorSearch.getSearchStats();
                status.database = searchStats.database;
                status.searchEngine = {
                    isInitialized: searchStats.isInitialized
                };
            }

            return status;

        } catch (error) {
            console.error('❌ Failed to retrieve status:', error.message);
            return {
                isReady: false,
                error: error.message
            };
        }
    }

    /**
     * Search for similar tools (without relying on an MCP client)
     * @param {string} query - Query text
     * @param {Object} options - Search options
     * @returns {Promise<Array>} List of similar tool MD5 hashes
     */
    async searchSimilar(query, options = {}) {
        try {
            if (!this.isReady) {
                throw new Error('Tool recommendation system is not initialized');
            }

            const {
                topK = 5,
                threshold = 0.1
            } = options;

            const results = await this.vectorSearch.searchSimilarTools(
                query, 
                this.modelName, 
                topK, 
                threshold
            );

            return results;

        } catch (error) {
            console.error('❌ Failed to search similar tools:', error.message);
            throw error;
        }
    }

    /**
     * Shut down the tool recommendation system
     */
    async close() {
        try {
            if (this.vectorSearch) {
                await this.vectorSearch.close();
            }

            this.isReady = false;
            console.log('✅ Tool recommendation system closed');

        } catch (error) {
            console.error('❌ Failed to close tool recommendation system:', error.message);
            throw error;
        }
    }
}

// Create a global instance
let globalRecommender = null;

/**
 * Retrieve the global tool recommender instance
 * @returns {ToolRecommender} Tool recommender instance
 */
export function getRecommender() {
    if (!globalRecommender) {
        globalRecommender = new ToolRecommender();
    }
    return globalRecommender;
}

/**
 * Quickly recommend tools - convenience helper
 * @param {string} query - Query text
 * @param {Object} mcpClient - MCP client
 * @param {Object} options - Options
 * @returns {Promise<Array>} Recommendation results
 */
export async function recommendTools(query, mcpClient, options = {}) {
    const recommender = getRecommender();
    
    if (!recommender.isReady) {
        await recommender.initialize(mcpClient, { autoIndex: true });
    }
    
    return recommender.recommend(query, options);
}

export default ToolRecommender;