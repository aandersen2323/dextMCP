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
        console.log('MCP server started successfully!');
    } catch (error) {
        console.error('Failed to start MCP server:', error.message);
    }
}

function greet(name) {
    return `Hello, ${name}! Welcome to the Node.js world!`;
}

async function bootstrapDiagnostics(mcpClient) {
    const embeddingApiKey = process.env.EMBEDDING_NG_API_KEY ?? process.env.EMBEDDING_API_KEY;
    if (embeddingApiKey && embeddingApiKey !== 'your-doubao-api-key-here') {
        console.log('\nDetected API key configuration. Running embedding diagnostics...');
        await runVectorizationDiagnostics();
        if (mcpClient) {
            console.log('\n🔍 Starting vector search diagnostics...');
            await runVectorSearchDiagnostics(mcpClient);
        }
    } else {
        console.log('\n🗄️  Testing database initialization...');
        await runDatabaseInitializationDiagnostics();
    }
}

async function main() {
    console.log(greet('developer'));
    console.log('Project bootstrap complete! 🚀');

    console.log('\nInitializing MCP client...');
    const mcpClient = await initializeMCPClient();

    if (mcpClient) {
        console.log('MCP client ready—tools can now be used!');
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
        console.log('MCP client initialization failed, but the app will continue running.');
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
