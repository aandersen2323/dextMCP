import VectorSearch from '../vector_search.js';
import { vectorizeString, vectorizeMultipleStrings } from '../lib/embedding.js';

async function runVectorizationDiagnostics() {
    try {
        console.log('\n🚀 Starting embedding diagnostics...');
        const modelName = process.env.EMBEDDING_NG_MODEL_NAME || process.env.EMBEDDING_MODEL_NAME || 'doubao-embedding-text-240715';
        const baseUrl = process.env.EMBEDDING_NG_BASE_URL || process.env.EMBEDDING_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
        const vectorDimension = process.env.EMBEDDING_NG_VECTOR_DIMENSION || process.env.EMBEDDING_VECTOR_DIMENSION || '1024';

        console.log(`📋 Current configuration:`);
        console.log(`   - Model: ${modelName}`);
        console.log(`   - Endpoint: ${baseUrl}`);
        console.log(`   - Expected dimension: ${vectorDimension}`);

        const testText = 'This is a test string used to validate the embedding model.';
        const vector = await vectorizeString(testText);
        console.log(`✅ Single-string embedding succeeded, dimension: ${vector.length}`);

        const testTexts = [
            'Artificial intelligence technology is advancing rapidly',
            'Natural language processing is a critical AI discipline',
            'Vectorization is a key step in text processing'
        ];
        const vectors = await vectorizeMultipleStrings(testTexts);
        console.log(`✅ Batch embedding succeeded for ${vectors.length} texts`);

        console.log('🎉 Embedding diagnostics complete!');
    } catch (error) {
        console.error('❌ Embedding diagnostics failed:', error.message);
    }
}

async function runVectorSearchDiagnostics(mcpClient) {
    try {
        console.log('\n🔍 Starting vector search diagnostics...');

        const vectorSearch = new VectorSearch();
        await vectorSearch.initialize();

        if (!mcpClient) {
            console.log('⚠️  MCP client is not initialized; skipping vector search diagnostics');
            await vectorSearch.close();
            return;
        }

        console.log('\n📊 Building vector index for MCP tools...');
        await vectorSearch.indexMCPTools(mcpClient);

        console.log('\n🤖 Testing tool recommender...');
        const testQueries = [
            `docx_block_create

**Best for:** creating any Feishu document block such as text, headings, lists, code, quotes, todos, highlights, tables, media, or plugin blocks.

**Avoid:** creating media blocks without using docx_image_or_video_or_file_create.

**Example:** create a text block with the content "Hello World".

**Returns:** metadata for the newly created block including block ID and rich text content.`
        ];

        for (const query of testQueries) {
            console.log(`\n🔍 Query: "${query}"`);
            const recommendations = await vectorSearch.recommendTools(
                query,
                mcpClient,
                process.env.EMBEDDING_NG_MODEL_NAME || process.env.EMBEDDING_MODEL_NAME || 'doubao-embedding-text-240715',
                { topK: 5, threshold: 0.1, includeDetails: true }
            );

            if (recommendations.length > 0) {
                console.log(`✅ Found ${recommendations.length} recommended tools:`);
                recommendations.forEach((tool, index) => {
                    console.log(`   ${index + 1}. ${tool.tool_name} (similarity: ${tool.similarity.toFixed(4)})`);
                    if (tool.description) {
                        console.log(`      Description: ${tool.description.substring(0, 100)}${tool.description.length > 100 ? '...' : ''}`);
                    }
                });
            } else {
                console.log('❌ No relevant tools found');
            }
        }

        console.log('\n📊 Retrieving vector search statistics...');
        const stats = await vectorSearch.getSearchStats();
        console.log('Statistics:', stats);

        await vectorSearch.close();
        console.log('🎉 Vector search diagnostics complete!');
    } catch (error) {
        console.error('❌ Vector search diagnostics failed:', error.message);
    }
}

async function runDatabaseInitializationDiagnostics() {
    try {
        const vectorSearch = new VectorSearch();
        await vectorSearch.initialize();
        const stats = await vectorSearch.getSearchStats();
        console.log('✅ Database initialized. Stats:', stats);
        await vectorSearch.close();
    } catch (error) {
        console.error('❌ Database initialization diagnostics failed:', error.message);
    }
}

export {
    runVectorizationDiagnostics,
    runVectorSearchDiagnostics,
    runDatabaseInitializationDiagnostics
};
