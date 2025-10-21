import './lib/loadEnv.js';

import { initializeMCPClient, getMCPClient } from './lib/mcpClient.js';
import { vectorizeString, vectorizeMultipleStrings } from './lib/embedding.js';
import VectorSearch from './vector_search.js';
import {
    runVectorizationDiagnostics,
    runVectorSearchDiagnostics,
    runDatabaseInitializationDiagnostics
} from './scripts/diagnostics.js';

let mcpServerStarted = false;

async function startMCPServer() {
    if (mcpServerStarted) return;

    try {
        await import('./mcp-server.js');
        mcpServerStarted = true;
        console.log('MCP服务器启动成功!');
    } catch (error) {
        console.error('MCP服务器启动失败:', error.message);
    }
}

function greet(name) {
    return `你好, ${name}! 欢迎来到Node.js世界!`;
}

async function bootstrapDiagnostics(mcpClient) {
    const embeddingApiKey = process.env.EMBEDDING_NG_API_KEY ?? process.env.EMBEDDING_API_KEY;
    if (embeddingApiKey && embeddingApiKey !== 'your-doubao-api-key-here') {
        console.log('\n检测到API密钥配置，开始向量化测试...');
        await runVectorizationDiagnostics();
        if (mcpClient) {
            console.log('\n🔍 开始向量搜索功能测试...');
            await runVectorSearchDiagnostics(mcpClient);
        }
    } else {
        console.log('\n🗄️  测试数据库初始化功能...');
        await runDatabaseInitializationDiagnostics();
    }
}

async function main() {
    console.log(greet('开发者'));
    console.log('项目启动成功! 🚀');

    console.log('\n正在初始化MCP客户端...');
    const mcpClient = await initializeMCPClient();

    if (mcpClient) {
        console.log('MCP客户端已准备就绪，可以使用各种工具服务!');
        const tools = await mcpClient.getTools();
        const toolNames = tools.map(tool => tool.name);
        const dynamicServerName = `dext-with-${toolNames.join(', ')}`;

        console.log(`动态服务器名称: ${dynamicServerName}`);

        globalThis.mcpToolsInfo = {
            serverName: dynamicServerName,
            tools
        };

        console.log('\n正在启动MCP服务器...');
        await startMCPServer();
    } else {
        console.log('MCP客户端初始化失败，但应用仍可正常运行。');
        globalThis.mcpToolsInfo = {
            serverName: 'dext',
            tools: []
        };
        await startMCPServer();
    }

    await bootstrapDiagnostics(mcpClient);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}

export {
    greet,
    initializeMCPClient,
    getMCPClient,
    vectorizeString,
    vectorizeMultipleStrings,
    VectorSearch
};
