// Test helper for verifying similar tool detection and removal
import VectorSearch from './vector_search.js';
import { vectorizeString } from './lib/embedding.js';

async function testSimilarToolDetection() {
    try {
        console.log('🧪 Starting similar tool detection and cleanup test...');

        // Initialize the vector search engine
        const vectorSearch = new VectorSearch();
        await vectorSearch.initialize();
        
        // Validate the string similarity calculation
        console.log('\n📊 Testing string similarity:');
        const testCases = [
            ['docx_block_create', 'docx_block_create'],
            ['docx_block_create', 'docx_block_update'],
            ['file_upload', 'file_download'],
            ['completely_different', 'totally_other']
        ];
        
        for (const [str1, str2] of testCases) {
            const similarity = vectorSearch.calculateNameSimilarity(str1, str2);
            console.log(`   "${str1}" vs "${str2}": ${similarity.toFixed(4)}`);
        }
        
        // Evaluate similar tool detection
        console.log('\n🔍 Testing similar tool identification:');

        // Create sample tool metadata
        const testTools = [
            {
                tool_name: 'existing_tool_v1',
                description: 'Existing tool used for document processing',
                similarity: 0.98  // High similarity
            },
            {
                tool_name: 'different_tool',
                description: 'Completely different tool',
                similarity: 0.5   // Low similarity
            },
            {
                tool_name: 'similar_tool',
                description: 'Similar tool for document processing features',
                similarity: 0.96  // Near the threshold but below it
            }
        ];

        const toDelete = vectorSearch.identifySimilarToolsToDelete(
            'new_tool_v2',
            'A new tool for document processing and editing',
            testTools,
            0.97  // Threshold
        );

        console.log(`✅ Tools flagged for removal: ${toDelete.length}`);
        toDelete.forEach(tool => {
            console.log(`   - ${tool.tool_name} (similarity: ${tool.similarity})`);
        });

        // Retrieve statistics
        console.log('\n📊 Database statistics:');
        const stats = await vectorSearch.getSearchStats();
        console.log(stats);
        
        await vectorSearch.close();
        console.log('\n🎉 Test complete!');

    } catch (error) {
        console.error('❌ Test failed:', error.message);
        console.error(error.stack);
    }
}

// Execute the test
testSimilarToolDetection().catch(console.error);