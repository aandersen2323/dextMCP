import VectorSearch from '../vector_search.js';
import { vectorizeString, vectorizeMultipleStrings } from '../lib/embedding.js';

async function runVectorizationDiagnostics() {
    try {
        console.log('\n🚀 Starting vectorization diagnostics...');
        console.log(`📋 Current configuration:`);
        console.log(`   - Model: ${process.env.EMBEDDING_MODEL_NAME || 'doubao-embedding-text-240715'}`);
        console.log(`   - Endpoint: ${process.env.EMBEDDING_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3'}`);
        console.log(`   - Expected dimension: ${process.env.EMBEDDING_VECTOR_DIMENSION || '1024'}`);

        const testText = 'This is a test string to verify the doubao embedding model';
        const vector = await vectorizeString(testText);
        console.log(`✅ Single-string vectorization succeeded; dimension: ${vector.length}`);

        const testTexts = [
            'Artificial intelligence is evolving rapidly',
            'Natural language processing is a key AI discipline',
            'Vectorization is a critical step in text processing'
        ];
        const vectors = await vectorizeMultipleStrings(testTexts);
        console.log(`✅ Batch vectorization succeeded; processed ${vectors.length} texts`);

        console.log('🎉 Vectorization diagnostics complete!');
    } catch (error) {
        console.error('❌ Vectorization diagnostics failed:', error.message);
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

        console.log('\n🤖 Testing tool recommendation...');
        const testQueries = [
            `docx_block_create Feishu Docs block creation request\n\n**Best suited for:** text, headings, lists, code blocks, quotes, tasks, highlights, tables, images, attachments, files, videos, and plugin blocks (diagram, glossary, timeline, outline, intake forms, countdown)\n\n**Not recommended for:** directly creating media blocks without docx_image_or_video_or_file_create\n\n**Example:** Create a text block with the contents "Hello World"\n\n**Return value:** Details about the new block including the block ID and rich-text payload`
        ];

        for (const query of testQueries) {
            console.log(`\n🔍 Query: "${query}"`);
            const recommendations = await vectorSearch.recommendTools(
                query,
                mcpClient,
                process.env.EMBEDDING_MODEL_NAME || 'doubao-embedding-text-240715',
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
                console.log('❌ No matching tools found');
            }
        }

        console.log('\n📊 Fetching vector search statistics...');
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
        console.log('✅ Database initialization succeeded; statistics:', stats);
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
