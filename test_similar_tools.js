// Script to test similar-tool detection and cleanup
import VectorSearch from './vector_search.js';
import { vectorizeString } from './lib/embedding.js';

async function testSimilarToolDetection() {
    try {
        console.log('🧪 Starting similar-tool detection test...');
        
        // Initialize vector search engine
        const vectorSearch = new VectorSearch();
        await vectorSearch.initialize();
        
        // Validate string similarity calculation
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
        
        // Test similar tool identification
        console.log('\n🔍 Identifying similar tools:');
        
        // Create sample tool data
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
                description: 'Similar tool used for document processing',
                similarity: 0.96  // Near threshold but below
            }
        ];
        
        const toDelete = vectorSearch.identifySimilarToolsToDelete(
            'new_tool_v2',
            'This is a new tool for document processing and editing',
            testTools,
            0.97  // Threshold
        );
        
        console.log(`✅ Tools marked for removal: ${toDelete.length}`);
        toDelete.forEach(tool => {
            console.log(`   - ${tool.tool_name} (similarity: ${tool.similarity})`);
        });
        
        // Fetch statistics
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

// Run test
testSimilarToolDetection().catch(console.error);