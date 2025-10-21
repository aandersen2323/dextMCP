import VectorSearch from '../vector_search.js';
import { vectorizeString, vectorizeMultipleStrings } from '../lib/embedding.js';

async function runVectorizationDiagnostics() {
    try {
        console.log('\n🚀 开始测试向量化功能...');
        console.log(`📋 当前配置:`);
        console.log(`   - 模型: ${process.env.EMBEDDING_MODEL_NAME || 'doubao-embedding-text-240715'}`);
        console.log(`   - 端点: ${process.env.EMBEDDING_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3'}`);
        console.log(`   - 预期维度: ${process.env.EMBEDDING_VECTOR_DIMENSION || '1024'}`);

        const testText = '这是一个测试文本，用于验证doubao embedding模型的功能';
        const vector = await vectorizeString(testText);
        console.log(`✅ 单个字符串向量化成功，向量维度: ${vector.length}`);

        const testTexts = [
            '人工智能技术正在快速发展',
            '自然语言处理是AI的重要分支',
            '向量化是文本处理的关键步骤'
        ];
        const vectors = await vectorizeMultipleStrings(testTexts);
        console.log(`✅ 批量向量化成功，共处理 ${vectors.length} 个文本`);

        console.log('🎉 向量化功能测试完成！');
    } catch (error) {
        console.error('❌ 向量化测试失败:', error.message);
    }
}

async function runVectorSearchDiagnostics(mcpClient) {
    try {
        console.log('\n🔍 开始测试向量搜索功能...');

        const vectorSearch = new VectorSearch();
        await vectorSearch.initialize();

        if (!mcpClient) {
            console.log('⚠️  MCP客户端未初始化，跳过向量搜索测试');
            await vectorSearch.close();
            return;
        }

        console.log('\n📊 为MCP工具建立向量索引...');
        await vectorSearch.indexMCPTools(mcpClient);

        console.log('\n🤖 测试工具推荐功能...');
        const testQueries = [
            `docx_block_create飞书-云文档-文档-块-创建块并插入到指定的位置\n\n**最适合:** 文本、标题、列表、代码、引用、待办事项、高亮、表格、图片、附件、文件、视频、插件块（文本绘图、名词解释、时间轴、目录导航、信息收集、倒计时）等所有块类型的创建\n\n**不推荐用于:** 在没有使用docx_image_or_video_or_file_create的情况下直接创建图片、附件、文件、视频块\n\n**示例:** 在文档中创建一个文本块，内容为"Hello World"\n\n**返回:** 新创建的块信息，包括块ID和富文本内容`
        ];

        for (const query of testQueries) {
            console.log(`\n🔍 查询: "${query}"`);
            const recommendations = await vectorSearch.recommendTools(
                query,
                mcpClient,
                process.env.EMBEDDING_MODEL_NAME || 'doubao-embedding-text-240715',
                { topK: 5, threshold: 0.1, includeDetails: true }
            );

            if (recommendations.length > 0) {
                console.log(`✅ 找到 ${recommendations.length} 个推荐工具:`);
                recommendations.forEach((tool, index) => {
                    console.log(`   ${index + 1}. ${tool.tool_name} (相似度: ${tool.similarity.toFixed(4)})`);
                    if (tool.description) {
                        console.log(`      描述: ${tool.description.substring(0, 100)}${tool.description.length > 100 ? '...' : ''}`);
                    }
                });
            } else {
                console.log('❌ 未找到相关工具');
            }
        }

        console.log('\n📊 获取向量搜索统计信息...');
        const stats = await vectorSearch.getSearchStats();
        console.log('统计信息:', stats);

        await vectorSearch.close();
        console.log('🎉 向量搜索功能测试完成！');
    } catch (error) {
        console.error('❌ 向量搜索测试失败:', error.message);
    }
}

async function runDatabaseInitializationDiagnostics() {
    try {
        const vectorSearch = new VectorSearch();
        await vectorSearch.initialize();
        const stats = await vectorSearch.getSearchStats();
        console.log('✅ 数据库初始化成功，统计信息:', stats);
        await vectorSearch.close();
    } catch (error) {
        console.error('❌ 数据库初始化测试失败:', error.message);
    }
}

export {
    runVectorizationDiagnostics,
    runVectorSearchDiagnostics,
    runDatabaseInitializationDiagnostics
};
