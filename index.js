import 'dotenv/config';

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
        console.log('MCP server started successfully!');
    } catch (error) {
        console.error('MCP server startup failed:', error.message);
    }
}

function greet(name) {
    return `Hello, ${name}! Welcome to the Node.js world!`;
}

async function bootstrapDiagnostics(mcpClient) {
    if (process.env.EMBEDDING_API_KEY && process.env.EMBEDDING_API_KEY !== 'your-doubao-api-key-here') {
        console.log('\nAPI key configuration detected, starting vectorization test...');
        await runVectorizationDiagnostics();
        if (mcpClient) {
            console.log('\n🔍 Starting vector search function test...');
            await runVectorSearchDiagnostics(mcpClient);
        }
    } else {
        console.log('\n🗄️  Testing database initialization function...');
        await runDatabaseInitializationDiagnostics();
    }
}

async function main() {
    console.log(greet('Developer'));
    console.log('Project started successfully! 🚀');

    console.log('\nInitializing MCP client...');
    const mcpClient = await initializeMCPClient();

    if (mcpClient) {
        console.log('MCP client is ready, various tool services can be used!');
        const tools = await mcpClient.getTools();
        const toolNames = tools.map(tool => tool.name);
        const dynamicServerName = `dext-with-${toolNames.join(', ')}`;

        console.log(`Dynamic server name: ${dynamicServerName}`);

        globalThis.mcpToolsInfo = {
            serverName: dynamicServerName,
            tools
        };

        console.log('\nStarting MCP server...');
        await startMCPServer();
    } else {
        console.log('MCP client initialization failed, but application can still run normally。');
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
