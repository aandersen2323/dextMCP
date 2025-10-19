import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import VectorSearch from './vector_search.js';
import VectorDatabase from './database.js';
import { initializeMCPClient, getMCPClient } from './index.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// 从配置文件读取服务器信息并生成增强描述
function getEnhancedServerDescription() {
    try {
        const configPath = path.join(process.cwd(), 'mcp-servers.json');
        const configData = fs.readFileSync(configPath, 'utf8');
        const mcpConfig = JSON.parse(configData);

        const serverDescriptions = [];

        if (mcpConfig.servers) {
            for (const [serverName, serverConfig] of Object.entries(mcpConfig.servers)) {
                if (serverConfig.description) {
                    serverDescriptions.push(`${serverName}(${serverConfig.description})`);
                } else {
                    serverDescriptions.push(serverName);
                }
            }
        }

        if (serverDescriptions.length > 0) {
            return `当前可以使用的服务器：${serverDescriptions.join('、')}`;
        }

        return '';
    } catch (error) {
        console.error('读取MCP配置文件失败:', error.message);
        return '';
    }
}

// 获取动态服务器名称
const mcpToolsInfo = global.mcpToolsInfo || { serverName: 'dext', tools: [] };
const dynamicServerName = mcpToolsInfo.serverName || 'dext';

// Create an MCP server with dynamic name
const server = new McpServer({
    name: dynamicServerName,
    version: '1.0.0'
});

console.log(`创建MCP服务器: ${dynamicServerName}`);

const vectorSearch = new VectorSearch();
const vectorDatabase = new VectorDatabase();
let vectorSearchInitPromise = null;
let vectorDatabaseInitPromise = null;
let mcpClient = null;
let mcpClientInitPromise = null;

async function ensureVectorSearchReady() {
    if (vectorSearchInitPromise) {
        await vectorSearchInitPromise;
        return;
    }

    vectorSearchInitPromise = (async () => {
        await vectorSearch.initialize();
    })();

    try {
        await vectorSearchInitPromise;
    } catch (error) {
        vectorSearchInitPromise = null;
        throw error;
    }
}

async function ensureVectorDatabaseReady() {
    if (vectorDatabaseInitPromise) {
        await vectorDatabaseInitPromise;
        return;
    }

    vectorDatabaseInitPromise = (async () => {
        await vectorDatabase.initialize();
    })();

    try {
        await vectorDatabaseInitPromise;
    } catch (error) {
        vectorDatabaseInitPromise = null;
        throw error;
    }
}

async function ensureMCPClientReady() {
    // 首先尝试获取已初始化的客户端
    const existingClient = getMCPClient();
    if (existingClient) {
        return existingClient;
    }

    if (mcpClientInitPromise) {
        return await mcpClientInitPromise;
    }

    mcpClientInitPromise = (async () => {
        try {
            mcpClient = await initializeMCPClient();
            if (mcpClient) {
                console.log('✅ MCP客户端初始化成功');
            } else {
                console.log('⚠️ MCP客户端初始化失败，使用空客户端');
                mcpClient = { async getTools() { return []; } };
            }
            return mcpClient;
        } catch (error) {
            console.error('❌ MCP客户端初始化失败:', error.message);
            mcpClient = { async getTools() { return []; } };
            return mcpClient;
        }
    })();

    return await mcpClientInitPromise;
}



server.registerTool(
    'retriever',
    {
        title: '工具检索',
        description: '通过自然语言描述来智能检索相关工具，返回语义最匹配的工具列表及完整信息。'+getEnhancedServerDescription(),
        inputSchema: {
            descriptions: z.array(z.string().min(1, 'query不能为空').describe("对假想的工具进行详细描述，即你认为这个工具应该是什么样的。对一个目标工具的描述都写在一个描述中，不要写好几个描述都是描述同一个目标工具的。")).describe("鼓励一次性检索多个目标工具，把你的需求一次性说出来。例如："+`用户想要在飞书文档中插入一个时间轴块。首先我需要获取文档内容，然后根据内容在合适的位置插入时间轴块。

如果你需要：

先获取文档内容，了解文档的结构和主题
分析文档内容，确定在哪里插入时间轴块最合适
创建时间轴内容
在合适的位置插入时间轴块，你就一次性提出对两个工具的检索：获取飞书文档内容的工具、创建时间轴块的工具`),
            sessionId: z.string().describe("会话ID，6位字母数字组合"),
            serverNames: z.array(z.string()).optional().describe("可选：指定服务器名称列表来限制检索范围，如 ['feishu', 'linear']")
        },
    },
    async ({ descriptions, sessionId, serverNames }) => {
        try {
            await ensureVectorSearchReady();
            await ensureVectorDatabaseReady();
            const mcpClient = await ensureMCPClientReady();

            // 处理sessionId：如果用户传入的sessionId没有历史记录，则重新生成
            let finalSessionId = sessionId;
            let needToGenerateNewSession = false;

            if (finalSessionId) {
                // 检查传入的sessionId是否有历史记录
                const sessionHistory = vectorDatabase.getSessionHistory(finalSessionId);
                if (!sessionHistory || sessionHistory.length === 0) {
                    console.log(`⚠️ 传入的sessionId ${finalSessionId} 没有历史记录，将重新生成`);
                    needToGenerateNewSession = true;
                }
            } else {
                needToGenerateNewSession = true;
            }

            if (needToGenerateNewSession) {
                finalSessionId = Math.random().toString(36).substring(2, 8);
                console.log(`🆕 生成新的sessionId: ${finalSessionId}`);
            }

            // 获取该session的历史检索记录
            const sessionHistory = vectorDatabase.getSessionHistory(finalSessionId);
            const knownToolMD5s = new Set(sessionHistory.map(item => item.tool_md5));
            console.log(`📋 Session ${finalSessionId} 已检索过的工具数量: ${knownToolMD5s.size}`);

            const modelName = process.env.EMBEDDING_MODEL_NAME || 'doubao-embedding-text-240715';
            const topK = parseInt(process.env.TOOL_RETRIEVER_TOP_K || '5', 10);
            const threshold = Number(process.env.TOOL_RETRIEVER_THRESHOLD || '0.1');

            // 处理多个描述，为每个描述检索工具
            const newTools = [];      // 新检索到的工具（完整信息）
            const knownTools = [];    // 已知工具（只返回基本信息）

            for (let i = 0; i < descriptions.length; i++) {
                const description = descriptions[i];

                // 使用recommendTools方法来获取完整的MCP工具信息
                const recommendations = await vectorSearch.recommendTools(
                    description,
                    mcpClient,
                    modelName,
                    { topK, threshold, includeDetails: true, serverNames }
                );

                const topResult = recommendations || [];

                // 分离新工具和已知工具
                const newToolsForQuery = [];
                const knownToolsForQuery = [];

                topResult.forEach((rec, index) => {
                    const toolInfo = {
                        rank: index + 1,
                        tool_name: rec.tool_name,
                        md5: rec.tool_md5
                    };

                    if (knownToolMD5s.has(rec.tool_md5)) {
                        // 已知工具，只返回基本信息
                        knownToolsForQuery.push(toolInfo);
                    } else {
                        // 新工具，返回完整信息
                        const fullToolInfo = {
                            ...toolInfo,
                            description: rec.description ?? null,
                            similarity: Number(rec.similarity?.toFixed(4) ?? rec.similarity ?? 0),
                            input_schema: JSON.stringify(rec.mcp_tool?.schema) ?? null,
                            output_schema: rec.mcp_tool?.outputSchema ?? null
                        };
                        newToolsForQuery.push(fullToolInfo);
                    }
                });

                // 添加到结果数组
                if (newToolsForQuery.length > 0) {
                    newTools.push({
                        query_index: i,
                        query: description,
                        tools: newToolsForQuery
                    });
                }

                if (knownToolsForQuery.length > 0) {
                    knownTools.push({
                        query_index: i,
                        query: description,
                        tools: knownToolsForQuery
                    });
                }
            }

            // 批量记录新检索的工具到session历史
            if (newTools.length > 0) {
                const newToolsToRecord = [];
                newTools.forEach(queryResult => {
                    queryResult.tools.forEach(tool => {
                        newToolsToRecord.push({
                            toolMD5: tool.md5,
                            toolName: tool.tool_name
                        });
                    });
                });

                if (newToolsToRecord.length > 0) {
                    vectorDatabase.recordSessionToolRetrievalBatch(finalSessionId, newToolsToRecord);
                }
            }

            // 构建返回结果
            const result = {
                session_id: finalSessionId,
                new_tools: newTools,
                known_tools: knownTools,
                summary: {
                    new_tools_count: newTools.reduce((sum, item) => sum + item.tools.length, 0),
                    known_tools_count: knownTools.reduce((sum, item) => sum + item.tools.length, 0),
                    session_history_count: knownToolMD5s.size + newTools.reduce((sum, item) => sum + item.tools.length, 0)
                }
            };

            console.log(`✅ 检索完成 - 新工具: ${result.summary.new_tools_count}, 已知工具: ${result.summary.known_tools_count}`);

            return {
                content: [
                    { type: 'text', text: JSON.stringify(result) },
                    { type: 'text', text: `📋 Session ID: ${finalSessionId} (请保存此ID用于后续检索)` }
                ]
            };

        } catch (error) {
            const message = `工具检索失败: ${error.message}`;
            console.error('❌ Retriever工具执行失败:', error);

            return {
                content: [
                    { type: 'text', text: message },
                    { type: 'text', text: `📋 Session ID: ${finalSessionId || sessionId || 'unknown'}` }
                ],
                isError: true
            };
        }
    }
);

// Add executor tool for proxy MCP tool calls
server.registerTool(
    'executor',
    {
        title: 'MCP工具执行器',
        description: '代理执行具体的MCP工具调用',
        inputSchema: {
            md5: z.string().min(1, '工具md5不能为空').describe("工具md5"),
            parameters: z.record(z.unknown()).describe("工具参数")
        }
    },
    async ({ md5, parameters }) => {
        try {
            await ensureMCPClientReady();
            const mcpClient = await ensureMCPClientReady();

            // 获取可用工具列表
            const tools = await mcpClient.getTools();
            // 根据md5查找工具
            const tool = tools.find(t => crypto.createHash('md5').update(`${t.name}${t.description}`.trim(), 'utf8').digest('hex') === md5);
            if (!tool) {
                return {
                    content: [{ type: 'text', text: `未找到md5为${md5}的工具` }],
                    isError: true
                };
            }

            // 执行工具调用
            const result = await tool.invoke(parameters);

            return {
                content: [{ type: 'text', text: JSON.stringify(result) }]
            };
        } catch (error) {
            console.log(error)
            const errorMessage = `工具执行失败: ${error.message}`;
            return {
                content: [{ type: 'text', text: errorMessage }],
                isError: true
            };
        }
    }
);

// Add a dynamic greeting resource
server.registerResource(
    'greeting',
    new ResourceTemplate('greeting://{name}', { list: undefined }),
    {
        title: 'Greeting Resource', // Display name for UI
        description: 'Dynamic greeting generator'
    },
    async (uri, { name }) => ({
        contents: [
            {
                uri: uri.href,
                text: `Hello, ${name}!`
            }
        ]
    })
);

// Set up Express and HTTP transport
const app = express();

// CORS configuration
const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);

        // In production, you might want to restrict this to specific domains
        // For now, allowing all origins for development
        return callback(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'mcp-protocol-version'],
    optionsSuccessStatus: 200 // some legacy browsers (IE11, various SmartTVs) choke on 204
};

app.use(cors(corsOptions));
app.use(express.json());

// Handle preflight requests for the /mcp endpoint
app.options('/mcp', cors(corsOptions));

// Health check endpoint
app.get('/health', cors(corsOptions), (_req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        server: 'dext MCP server',
        version: '1.0.0'
    });
});

app.post('/mcp', cors(corsOptions), async (req, res) => {
    // Create a new transport for each request to prevent request ID collisions
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
    });

    res.on('close', () => {
        transport.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
});

const port = parseInt(process.env.MCP_SERVER_PORT || '3000');
app.listen(port, () => {
    console.log(`Demo MCP Server running on http://localhost:${port}/mcp`);
}).on('error', error => {
    console.error('Server error:', error);
    process.exit(1);
});
