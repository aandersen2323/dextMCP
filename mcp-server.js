import './lib/loadEnv.js';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import VectorDatabase from './database.js';
import { initializeMCPClient, getMCPClient } from './lib/mcpClient.js';
import { getRecommender } from './tool_recommender.js';
import crypto from 'crypto';
import {
    buildCorsOptions,
    createAdminAuthenticator,
    createInMemoryRateLimiter,
    secureSessionId,
    maskError
} from './security.js';
import {
    createChildLogger,
    createRequestLogger,
    logger,
    metricsHandler,
    metricsMiddleware
} from './observability.js';

const appLogger = createChildLogger({ module: 'mcp-server' });

// Read server information from database and generate enhanced description
async function getEnhancedServerDescription() {
    try {
        const serverDescriptions = [];

        // Ensure the MCP client is ready
        try {
            const mcpClient = await ensureMCPClientReady();
            const tools = await mcpClient.getTools();

            // Group tools by server
            const toolsByServer = {};
            tools.forEach(tool => {
                // Extract server name from tool identifier (format: serverName__toolName)
                const parts = tool.name.split('__');
                const serverName = parts[0] || 'unknown';
                const toolName = parts.slice(1).join('__') || tool.name;

                if (!toolsByServer[serverName]) {
                    toolsByServer[serverName] = [];
                }
                toolsByServer[serverName].push(toolName);
            });

            // Load server configuration from the database
            await ensureVectorDatabaseReady();
            const db = vectorDatabase.db;
            const stmt = db.prepare('SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY server_name');
            const mcpServers = stmt.all();

            for (const serverRow of mcpServers) {
                let description = serverRow.server_name;

                if (serverRow.description) {
                    description += `(${serverRow.description})`;
                }

                // Append tool list to the description
                const serverTools = toolsByServer[serverRow.server_name];
                if (serverTools && serverTools.length > 0) {
                    description += ` - Tools: ${serverTools.join(', ')}`;
                }

                serverDescriptions.push(description);
            }
        } catch (error) {
            appLogger.error({ err: error }, 'Failed to get MCP tool information');
            // If getting tool information fails, still return basic server description
            try {
                await ensureVectorDatabaseReady();
                const db = vectorDatabase.db;
                const stmt = db.prepare('SELECT server_name, description FROM mcp_servers WHERE enabled = 1 ORDER BY server_name');
                const mcpServers = stmt.all();

                for (const serverRow of mcpServers) {
                    if (serverRow.description) {
                        serverDescriptions.push(`${serverRow.server_name}(${serverRow.description})`);
                    } else {
                        serverDescriptions.push(serverRow.server_name);
                    }
                }
            } catch (dbError) {
                appLogger.error({ err: dbError }, 'Failed to read server configuration from database');
            }
        }

        if (serverDescriptions.length > 0) {
            return `Currently available servers: ${serverDescriptions.join(', ')}. Do not use them directly—use them only for retrieval.`;
        }

        return '';
    } catch (error) {
        appLogger.error({ err: error }, 'Failed to get enhanced server description');
        return '';
    }
}

// Retrieve the dynamic server name
const mcpToolsInfo = globalThis.mcpToolsInfo || { serverName: 'dext', tools: [] };
const dynamicServerName = mcpToolsInfo.serverName || 'dext';

// Create an MCP server with dynamic name
const server = new McpServer({
    name: dynamicServerName,
    version: '1.0.0'
});

appLogger.info(`Creating MCP server: ${dynamicServerName}`);

const vectorDatabase = new VectorDatabase();
let vectorDatabaseInitPromise = null;
let mcpClient = null;
let mcpClientInitPromise = null;
const toolRecommender = getRecommender();
let recommenderInitPromise = null;

async function ensureToolRecommenderReady() {
    if (toolRecommender.isReady) {
        return toolRecommender;
    }

    if (recommenderInitPromise) {
        return recommenderInitPromise;
    }

    recommenderInitPromise = (async () => {
        await ensureVectorDatabaseReady();
        const client = await ensureMCPClientReady();
        await toolRecommender.initialize(client, { autoIndex: true });
        appLogger.info('✅ Tool recommendation system is ready');
        return toolRecommender;
    })();

    try {
        return await recommenderInitPromise;
    } catch (error) {
        recommenderInitPromise = null;
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
    // First try to reuse an existing initialized client
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
                appLogger.info('✅ MCP client initialized successfully');
            } else {
                appLogger.info('⚠️ MCP client initialization failed, using an empty client');
                mcpClient = { async getTools() { return []; } };
            }
            return mcpClient;
        } catch (error) {
            appLogger.error({ err: error }, '❌ MCP client initialization failed');
            mcpClient = { async getTools() { return []; } };
            return mcpClient;
        }
    })();

    return await mcpClientInitPromise;
}



server.registerTool(
    'retriever',
    {
        title: 'Tool Retrieval',
        description: 'Use natural language descriptions to discover the most relevant tools and return detailed results.',
        inputSchema: {
            descriptions: z
                .array(
                    z
                        .string()
                        .min(1, 'Query cannot be empty')
                        .describe(
                            'Describe the tool or capability you want. Keep each desired tool in a separate entry so the retriever can match them precisely.'
                        )
                )
                .describe(
                    'Provide one or more descriptions in a single request. Example: "Insert a timeline block into a Feishu doc. First fetch the document contents, then determine the best insertion point, then create the timeline."'
                ),
            sessionId: z
                .string()
                .describe('Optional session identifier (six alphanumeric characters) used to avoid duplicate recommendations'),
            serverNames: z
                .array(z.string())
                .optional()
                .describe("Optional: limit search to specific server names, e.g. ['feishu', 'linear']"),
            groupNames: z
                .array(z.string())
                .optional()
                .describe("Optional: filter by server groups, e.g. ['devtools']")
        }
    },
    async ({ descriptions, sessionId, serverNames, groupNames }) => {
        try {
            await ensureVectorDatabaseReady();
            const mcpClient = await ensureMCPClientReady();
            const recommender = await ensureToolRecommenderReady();

            // Retrieve enhanced server description
            const enhancedServerDescription = await getEnhancedServerDescription();

            // Handle the sessionId: regenerate when there is no prior history
            let finalSessionId = sessionId;
            let needToGenerateNewSession = false;
            let isFirstTimeSession = false;

            if (finalSessionId) {
                // Check whether the provided sessionId already has history
                const sessionHistory = vectorDatabase.getSessionHistory(finalSessionId);
                if (!sessionHistory || sessionHistory.length === 0) {
                    appLogger.info(`⚠️ SessionId ${finalSessionId} has no history; generating a new identifier`);
                    needToGenerateNewSession = true;
                }
            } else {
                needToGenerateNewSession = true;
            }

            if (needToGenerateNewSession) {
                finalSessionId = secureSessionId();
                console.log(`🆕 Generated new sessionId: ${finalSessionId}`);
                isFirstTimeSession = true;
            }

            // Read the retrieval history for this session
            const sessionHistory = vectorDatabase.getSessionHistory(finalSessionId);
            const knownToolMD5s = new Set(sessionHistory.map(item => item.tool_md5));
            appLogger.info(`📋 Session ${finalSessionId} already has ${knownToolMD5s.size} retrieved tools`);

            const topK = parseInt(process.env.TOOL_RETRIEVER_TOP_K || '5', 10);
            const threshold = Number(process.env.TOOL_RETRIEVER_THRESHOLD || '0.1');

            // Process each description and retrieve matching tools
            const newTools = [];      // Newly retrieved tools (full detail)
            const knownTools = [];    // Already-known tools (basic detail)

            for (let i = 0; i < descriptions.length; i++) {
                const description = descriptions[i];

                // Use recommendTools to gather complete MCP tool information
                const recommendations = await vectorSearch.recommendTools(
                    description,
                    mcpClient,
                    modelName,
                    { topK, threshold, includeDetails: true, serverNames, groupNames }
                );

                const topResult = recommendations || [];

                // Separate newly discovered tools from known ones
                const newToolsForQuery = [];
                const knownToolsForQuery = [];

                topResult.forEach((rec, index) => {
                    const toolInfo = {
                        rank: index + 1,
                        tool_name: rec.tool_name,
                        md5: rec.tool_md5
                    };

                    if (knownToolMD5s.has(rec.tool_md5)) {
                        // Known tool; return only minimal details
                        knownToolsForQuery.push(toolInfo);
                    } else {
                        // New tool; return full details
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

                // Aggregate results
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

            // Persist newly retrieved tools into the session history
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

            // Build the response payload
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

            // Only include the server description for a brand-new session
            if (isFirstTimeSession) {
                result.server_description = enhancedServerDescription;
            }

            appLogger.info(`✅ Retrieval complete - new tools: ${result.summary.new_tools_count}, known tools: ${result.summary.known_tools_count}`);

            return {
                content: [
                    { type: 'text', text: JSON.stringify(result) },
                    { type: 'text', text: `📋 Session ID: ${finalSessionId} (save this ID for follow-up retrievals)` }
                ]
            };

        } catch (error) {
            const message = `Tool retrieval failed: ${error.message}`;
            appLogger.error({ err: error }, '❌ Retriever tool execution failed');

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
        title: 'MCP Tool Executor',
        description: 'Proxy execution helper for calling MCP tools',
        inputSchema: {
            md5: z.string().min(1, 'Tool MD5 cannot be empty').describe('Tool MD5 hash'),
            parameters: z.record(z.unknown()).describe('Tool parameters')
        }
    },
    async ({ md5, parameters }) => {
        try {
            await ensureMCPClientReady();
            const mcpClient = await ensureMCPClientReady();

            // Retrieve available tools
            const tools = await mcpClient.getTools();
            // Locate the tool by MD5 hash
            const tool = tools.find(t => crypto.createHash('md5').update(`${t.name}${t.description}`.trim(), 'utf8').digest('hex') === md5);
            if (!tool) {
                return {
                    content: [{ type: 'text', text: `No tool found with MD5 ${md5}` }],
                    isError: true
                };
            }

            // Invoke the tool
            const result = await tool.invoke(parameters);

            return {
                content: [{ type: 'text', text: JSON.stringify(result) }]
            };
        } catch (error) {
            appLogger.error({ err: error }, 'Tool execution failed');
            const errorMessage = `Tool execution failed: ${error.message}`;
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

app.use(createRequestLogger({ loggerInstance: logger }));
app.use(metricsMiddleware);

// CORS configuration
const corsOptions = buildCorsOptions();

app.use(cors(corsOptions));
app.use(express.json());

// Handle preflight requests for the /mcp endpoint
app.options('/mcp', cors(corsOptions));

const adminRateLimitWindowMs = parseInt(process.env.ADMIN_RATE_LIMIT_WINDOW_MS || '60000', 10);
const adminRateLimitMax = parseInt(process.env.ADMIN_RATE_LIMIT_MAX || '120', 10);
const adminRateLimiter = createInMemoryRateLimiter({
    windowMs: Number.isFinite(adminRateLimitWindowMs) ? adminRateLimitWindowMs : 60000,
    max: Number.isFinite(adminRateLimitMax) ? adminRateLimitMax : 120
});
const adminAuthenticator = createAdminAuthenticator();
const adminRouter = express.Router();
adminRouter.use((req, res, next) => {
    if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
    }
    next();
});
adminRouter.use(adminRateLimiter);
adminRouter.use(adminAuthenticator);
app.use('/api', adminRouter);

// Health check endpoint
app.get('/health', cors(corsOptions), (_req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        server: 'dext MCP server',
        version: '1.0.0'
    });
});

app.get('/metrics', metricsHandler);

// MCP Servers CRUD API

adminRouter.post('/sync', async (_req, res) => {
    try {
        await ensureVectorDatabaseReady();
        const client = await ensureMCPClientReady();

        if (!client) {
            return res.status(503).json({ error: 'MCP client is not ready; synchronization cannot run' });
        }

        const recommender = await ensureToolRecommenderReady();
        const results = await recommender.reindex();

        res.json({
            message: 'Tool index synchronization completed',
            indexed: Array.isArray(results) ? results.length : 0
        });
    } catch (error) {
        appLogger.error({ err: error }, 'Failed to trigger tool index synchronization');
        res.status(500).json(maskError());
    }
});

// Input validation schemas
const createMcpServerSchema = z.object({
    server_name: z.string().min(1, 'Server name is required'),
    server_type: z.enum(['http', 'stdio'], { errorMap: () => ({ message: 'Server type must be http or stdio' }) }),
    url: z.string().url('URL is invalid').optional().or(z.literal('')),
    command: z.string().min(1, 'Command is required').optional().or(z.literal('')),
    args: z.array(z.string()).optional(),
    headers: z.record(z.string()).optional(),
    env: z.record(z.string()).optional(),
    description: z.string().optional(),
    enabled: z.boolean().optional(),
    group_names: z.array(z.string().min(1, 'Group name is required')).optional()
});

const updateMcpServerSchema = z.object({
    server_name: z.string().min(1, 'Server name is required').optional(),
    server_type: z.enum(['http', 'stdio']).optional(),
    url: z.string().url('URL is invalid').optional().or(z.literal('')),
    command: z.string().min(1, 'Command is required').optional().or(z.literal('')),
    args: z.array(z.string()).optional(),
    headers: z.record(z.string()).optional(),
    env: z.record(z.string()).optional(),
    description: z.string().optional(),
    enabled: z.boolean().optional(),
    group_names: z.array(z.string().min(1, 'Group name is required')).optional()
});

const createGroupSchema = z.object({
    group_name: z.string().min(1, 'Group name is required'),
    description: z.string().optional()
});

const updateGroupSchema = z.object({
    group_name: z.string().min(1, 'Group name is required').optional(),
    description: z.string().optional()
});

const manageServerGroupsSchema = z.object({
    group_names: z.array(z.string().min(1, 'Group name is required')).min(1, 'Provide at least one group name')
});

// Validation middleware
const validateCreateMcpServer = (req, res, next) => {
    try {
        const validated = createMcpServerSchema.parse(req.body);
        req.validatedBody = validated;

        // Type-specific validation
        if (validated.server_type === 'http' && !validated.url) {
            return res.status(400).json({ error: 'HTTP servers must provide a URL' });
        }
        if (validated.server_type === 'stdio' && !validated.command) {
            return res.status(400).json({ error: 'STDIO servers must provide a command' });
        }

        next();
    } catch (error) {
        return res.status(400).json({
            error: 'Input validation failed',
            details: error.errors?.map(e => e.message) || error.message
        });
    }
};


function getServerRowWithGroups(db, serverId) {
    if (!db) return null;

    return db.prepare(`
        SELECT ms.*, GROUP_CONCAT(DISTINCT mg.group_name) AS group_names
        FROM mcp_servers ms
        LEFT JOIN mcp_server_groups msg ON ms.id = msg.server_id
        LEFT JOIN mcp_groups mg ON mg.id = msg.group_id
        WHERE ms.id = ?
        GROUP BY ms.id
    `).get(serverId);
}

// Helper function to convert database row to API response
function formatMcpServerRow(row) {
    if (!row) return null;

    let groupNames = [];

    try {
        if (row.group_names !== undefined && row.group_names !== null) {
            if (Array.isArray(row.group_names)) {
                groupNames = row.group_names;
            } else if (typeof row.group_names === 'string') {
                groupNames = row.group_names
                    .split(',')
                    .map(name => name.trim())
                    .filter(Boolean);
            }
        } else if (vectorDatabase?.db) {
            groupNames = vectorDatabase.getGroupNamesForServer(row.id);
        }
    } catch (error) {
        console.error('Failed to get server group information:', error.message);
    }

    groupNames = Array.from(new Set(groupNames)).sort();

    return {
        id: row.id,
        server_name: row.server_name,
        server_type: row.server_type,
        url: row.url,
        command: row.command,
        args: row.args ? JSON.parse(row.args) : null,
        headers: row.headers ? JSON.parse(row.headers) : null,
        env: row.env ? JSON.parse(row.env) : null,
        description: row.description,
        enabled: Boolean(row.enabled),
        group_names: groupNames,
        created_at: row.created_at,
        updated_at: row.updated_at
    };
}

function formatMcpGroupRow(row) {
    if (!row) return null;

    return {
        id: row.id,
        group_name: row.group_name,
        description: row.description,
        server_count: row.server_count ?? 0,
        created_at: row.created_at,
        updated_at: row.updated_at
    };
}

// GET /api/mcp-servers - List all MCP servers
adminRouter.get('/mcp-servers', async (req, res) => {
    try {
        await ensureVectorDatabaseReady();
        const db = vectorDatabase.db;

        const { enabled, server_type, page = 1, limit = 50 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        const conditions = [];
        const params = [];

        if (enabled !== undefined) {
            conditions.push('ms.enabled = ?');
            params.push(enabled === 'true' ? 1 : 0);
        }

        if (server_type) {
            conditions.push('ms.server_type = ?');
            params.push(server_type);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        // Fetch total count
        const countSql = `SELECT COUNT(*) as total FROM mcp_servers ms ${whereClause}`;
        const countResult = db.prepare(countSql).get(...params);
        const total = countResult.total;

        // Fetch paginated data
        const dataSql = `
            SELECT ms.*, GROUP_CONCAT(DISTINCT mg.group_name) AS group_names
            FROM mcp_servers ms
            LEFT JOIN mcp_server_groups msg ON ms.id = msg.server_id
            LEFT JOIN mcp_groups mg ON mg.id = msg.group_id
            ${whereClause}
            GROUP BY ms.id
            ORDER BY ms.created_at DESC
            LIMIT ? OFFSET ?
        `;
        const dataParams = [...params, parseInt(limit), offset];
        const rows = db.prepare(dataSql).all(...dataParams);

        const servers = rows.map(formatMcpServerRow);

        res.json({
            data: servers,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                totalPages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (error) {
        console.error('Failed to fetch MCP server list:', error);
        res.status(500).json(maskError());
    }
});

// GET /api/mcp-servers/:id - Get MCP server by ID
adminRouter.get('/mcp-servers/:id', async (req, res) => {
    try {
        await ensureVectorDatabaseReady();
        const db = vectorDatabase.db;

        const { id } = req.params;

        if (!id || isNaN(parseInt(id))) {
            return res.status(400).json({ error: 'Invalid server ID' });
        }

        const row = getServerRowWithGroups(db, parseInt(id));

        if (!row) {
            return res.status(404).json({ error: 'Server not found' });
        }

        const server = formatMcpServerRow(row);
        res.json({ data: server });
    } catch (error) {
        console.error('Failed to retrieve MCP server:', error);
        res.status(500).json(maskError());
    }
});

// POST /api/mcp-servers - Create MCP server
adminRouter.post('/mcp-servers', validateCreateMcpServer, async (req, res) => {
    try {
        await ensureVectorDatabaseReady();
        const db = vectorDatabase.db;

        const data = req.validatedBody;

        // Check whether the server name already exists
        const existing = db.prepare('SELECT id FROM mcp_servers WHERE server_name = ?').get(data.server_name);
        if (existing) {
            return res.status(409).json({ error: 'Server name already exists' });
        }

        let groupIds = [];
        if (data.group_names && data.group_names.length > 0) {
            const uniqueGroupNames = Array.from(new Set(data.group_names.map(name => name.trim()).filter(Boolean)));

            if (uniqueGroupNames.length === 0) {
                return res.status(400).json({ error: 'Group name is required' });
            }

            const placeholders = uniqueGroupNames.map(() => '?').join(', ');
            const rows = db.prepare(`SELECT id, group_name FROM mcp_groups WHERE group_name IN (${placeholders})`).all(...uniqueGroupNames);
            const foundNames = rows.map(row => row.group_name);
            const missing = uniqueGroupNames.filter(name => !foundNames.includes(name));

            if (missing.length > 0) {
                return res.status(400).json({ error: `The following groups do not exist: ${missing.join(', ')}` });
            }

            groupIds = rows.map(row => row.id);
        }

        // Prepare insertion data
        const insertData = {
            server_name: data.server_name,
            server_type: data.server_type,
            url: data.server_type === 'http' ? data.url || null : null,
            command: data.server_type === 'stdio' ? data.command || null : null,
            args: (data.args && data.args.length > 0) ? JSON.stringify(data.args) : null,
            headers: (data.headers && Object.keys(data.headers).length > 0) ? JSON.stringify(data.headers) : null,
            env: (data.env && Object.keys(data.env).length > 0) ? JSON.stringify(data.env) : null,
            description: data.description || null,
            enabled: data.enabled !== undefined ? (data.enabled ? 1 : 0) : 1
        };

        const stmt = db.prepare(`
            INSERT INTO mcp_servers (server_name, server_type, url, command, args, headers, env, description, enabled)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const result = stmt.run(
            insertData.server_name,
            insertData.server_type,
            insertData.url,
            insertData.command,
            insertData.args,
            insertData.headers,
            insertData.env,
            insertData.description,
            insertData.enabled
        );

        const newServerId = result.lastInsertRowid;

        if (groupIds.length > 0) {
            const insertGroupStmt = db.prepare('INSERT INTO mcp_server_groups (server_id, group_id) VALUES (?, ?)');
            const insertMany = db.transaction((ids) => {
                ids.forEach(groupId => insertGroupStmt.run(newServerId, groupId));
            });
            insertMany(groupIds);
        }

        // Fetch created server data
        const newRow = getServerRowWithGroups(db, newServerId) || db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(newServerId);
        const server = formatMcpServerRow(newRow);

        console.log(`✅ Create MCP server: ${data.server_name} (ID: ${newServerId})`);

        res.status(201).json({
            message: 'Server created successfully',
            data: server
        });
    } catch (error) {
        console.error('Failed to create MCP server:', error);
        res.status(500).json(maskError());
    }
});

// PATCH /api/mcp-servers/:id - Update MCP server
adminRouter.patch('/mcp-servers/:id', async (req, res) => {
    try {
        await ensureVectorDatabaseReady();
        const db = vectorDatabase.db;

        const { id } = req.params;

        if (!id || isNaN(parseInt(id))) {
            return res.status(400).json({ error: 'Invalid server ID' });
        }

        // Retrieve existing server data
        const existingRow = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(parseInt(id));
        if (!existingRow) {
            return res.status(404).json({ error: 'Server not found' });
        }

        req.existingServer = existingRow;

        // Validate input data
        try {
            const validated = updateMcpServerSchema.parse(req.body);
            req.validatedBody = validated;

            // Type-specific validation if both type and respective fields are provided
            if (validated.server_type === 'http' && !validated.url && !req.existingServer?.url) {
                return res.status(400).json({ error: 'HTTP servers must provide a URL' });
            }
            if (validated.server_type === 'stdio' && !validated.command && !req.existingServer?.command) {
                return res.status(400).json({ error: 'STDIO servers must provide a command' });
            }
        } catch (error) {
            return res.status(400).json({
                error: 'Input validation failed',
                details: error.errors?.map(e => e.message) || error.message
            });
        }

        const data = req.validatedBody;

        let updatedGroupIds = null;
        if (data.group_names !== undefined) {
            const originalLength = data.group_names.length;
            const uniqueGroupNames = Array.from(new Set(data.group_names.map(name => name.trim()).filter(Boolean)));

            if (uniqueGroupNames.length === 0) {
                if (originalLength > 0) {
                    return res.status(400).json({ error: 'Group name is required' });
                }
                updatedGroupIds = [];
            } else {
                const placeholders = uniqueGroupNames.map(() => '?').join(', ');
                const rows = db.prepare(`SELECT id, group_name FROM mcp_groups WHERE group_name IN (${placeholders})`).all(...uniqueGroupNames);
                const foundNames = rows.map(row => row.group_name);
                const missing = uniqueGroupNames.filter(name => !foundNames.includes(name));

                if (missing.length > 0) {
                    return res.status(400).json({ error: `The following groups do not exist: ${missing.join(', ')}` });
                }

                updatedGroupIds = rows.map(row => row.id);
            }
        }

        // Ensure server name is not used by another entry
        if (data.server_name && data.server_name !== existingRow.server_name) {
            const nameExists = db.prepare('SELECT id FROM mcp_servers WHERE server_name = ? AND id != ?').get(data.server_name, parseInt(id));
            if (nameExists) {
                return res.status(409).json({ error: 'Server name already exists' });
            }
        }

        // Build update fields
        const updateFields = [];
        const updateValues = [];

        if (data.server_name !== undefined) {
            updateFields.push('server_name = ?');
            updateValues.push(data.server_name);
        }
        if (data.server_type !== undefined) {
            updateFields.push('server_type = ?');
            updateValues.push(data.server_type);
        }
        if (data.url !== undefined) {
            updateFields.push('url = ?');
            updateValues.push(data.url || null);
        }
        if (data.command !== undefined) {
            updateFields.push('command = ?');
            updateValues.push(data.command || null);
        }
        if (data.args !== undefined) {
            updateFields.push('args = ?');
            updateValues.push((data.args && data.args.length > 0) ? JSON.stringify(data.args) : null);
        }
        if (data.headers !== undefined) {
            updateFields.push('headers = ?');
            updateValues.push((data.headers && Object.keys(data.headers).length > 0) ? JSON.stringify(data.headers) : null);
        }
        if (data.env !== undefined) {
            updateFields.push('env = ?');
            updateValues.push((data.env && Object.keys(data.env).length > 0) ? JSON.stringify(data.env) : null);
        }
        if (data.description !== undefined) {
            updateFields.push('description = ?');
            updateValues.push(data.description);
        }
        if (data.enabled !== undefined) {
            updateFields.push('enabled = ?');
            updateValues.push(data.enabled ? 1 : 0);
        }

        if (updateFields.length === 0 && updatedGroupIds === null) {
            return res.status(400).json({ error: 'No fields provided for update' });
        }

        let updateStatement = null;
        let updateParams = [];

        if (updateFields.length > 0) {
            updateFields.push('updated_at = CURRENT_TIMESTAMP');
            updateStatement = `UPDATE mcp_servers SET ${updateFields.join(', ')} WHERE id = ?`;
            updateParams = [...updateValues, parseInt(id)];
        }

        const runUpdateTransaction = db.transaction(() => {
            if (updateStatement) {
                const stmt = db.prepare(updateStatement);
                const result = stmt.run(...updateParams);

                if (result.changes === 0) {
                    throw new Error('NO_CHANGES');
                }
            }

            if (updatedGroupIds !== null) {
                const deleteStmt = db.prepare('DELETE FROM mcp_server_groups WHERE server_id = ?');
                deleteStmt.run(parseInt(id));

                if (updatedGroupIds.length > 0) {
                    const insertStmt = db.prepare('INSERT INTO mcp_server_groups (server_id, group_id) VALUES (?, ?)');
                    updatedGroupIds.forEach(groupId => insertStmt.run(parseInt(id), groupId));
                }

                db.prepare('UPDATE mcp_servers SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(parseInt(id));
            }

            return getServerRowWithGroups(db, parseInt(id));
        });

        let updatedRow;
        try {
            updatedRow = runUpdateTransaction();
        } catch (error) {
            if (error.message === 'NO_CHANGES') {
                return res.status(500).json({ error: 'Update failed; no records were modified' });
            }
            throw error;
        }

        const server = formatMcpServerRow(updatedRow);

        appLogger.info(`✅ Update MCP server: ${server.server_name} (ID: ${id})`);

        res.json({
            message: 'Server updated successfully',
            data: server
        });
    } catch (error) {
        console.error('Failed to update MCP server:', error);
        res.status(500).json(maskError());
    }
});

// POST /api/mcp-servers/:id/groups - Add server groups
adminRouter.post('/mcp-servers/:id/groups', async (req, res) => {
    try {
        await ensureVectorDatabaseReady();
        const db = vectorDatabase.db;

        const { id } = req.params;
        const serverId = parseInt(id);

        if (!id || isNaN(serverId)) {
            return res.status(400).json({ error: 'Invalid server ID' });
        }

        const existingRow = getServerRowWithGroups(db, serverId);
        if (!existingRow) {
            return res.status(404).json({ error: 'Server not found' });
        }

        let body;
        try {
            body = manageServerGroupsSchema.parse(req.body);
        } catch (error) {
            return res.status(400).json({
                error: 'Input validation failed',
                details: error.errors?.map(e => e.message) || error.message
            });
        }

        const uniqueGroupNames = Array.from(new Set(body.group_names.map(name => name.trim()).filter(Boolean)));

        if (uniqueGroupNames.length === 0) {
            return res.status(400).json({ error: 'Group name is required' });
        }

        const placeholders = uniqueGroupNames.map(() => '?').join(', ');
        const groupRows = db.prepare(`SELECT id, group_name FROM mcp_groups WHERE group_name IN (${placeholders})`).all(...uniqueGroupNames);
        const foundNames = groupRows.map(row => row.group_name);
        const missing = uniqueGroupNames.filter(name => !foundNames.includes(name));

        if (missing.length > 0) {
            return res.status(400).json({ error: `The following groups do not exist: ${missing.join(', ')}` });
        }

        const addGroups = db.transaction((rows) => {
            const insertStmt = db.prepare('INSERT OR IGNORE INTO mcp_server_groups (server_id, group_id) VALUES (?, ?)');
            rows.forEach(row => insertStmt.run(serverId, row.id));
            db.prepare('UPDATE mcp_servers SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(serverId);
        });

        addGroups(groupRows);

        const updatedRow = getServerRowWithGroups(db, serverId);
        const server = formatMcpServerRow(updatedRow);

        res.json({
            message: 'Server groups updated successfully',
            data: server
        });
    } catch (error) {
        console.error('Failed to update server groups:', error);
        res.status(500).json(maskError());
    }
});

// DELETE /api/mcp-servers/:id/groups - Remove server groups
adminRouter.delete('/mcp-servers/:id/groups', async (req, res) => {
    try {
        await ensureVectorDatabaseReady();
        const db = vectorDatabase.db;

        const { id } = req.params;
        const serverId = parseInt(id);

        if (!id || isNaN(serverId)) {
            return res.status(400).json({ error: 'Invalid server ID' });
        }

        const existingRow = getServerRowWithGroups(db, serverId);
        if (!existingRow) {
            return res.status(404).json({ error: 'Server not found' });
        }

        let body;
        try {
            body = manageServerGroupsSchema.parse(req.body);
        } catch (error) {
            return res.status(400).json({
                error: 'Input validation failed',
                details: error.errors?.map(e => e.message) || error.message
            });
        }

        const uniqueGroupNames = Array.from(new Set(body.group_names.map(name => name.trim()).filter(Boolean)));

        if (uniqueGroupNames.length === 0) {
            return res.status(400).json({ error: 'Group name is required' });
        }

        const placeholders = uniqueGroupNames.map(() => '?').join(', ');
        const groupRows = db.prepare(`SELECT id, group_name FROM mcp_groups WHERE group_name IN (${placeholders})`).all(...uniqueGroupNames);
        const foundNames = groupRows.map(row => row.group_name);
        const missing = uniqueGroupNames.filter(name => !foundNames.includes(name));

        if (missing.length > 0) {
            return res.status(400).json({ error: `The following groups do not exist: ${missing.join(', ')}` });
        }

        const groupIds = groupRows.map(row => row.id);
        const membershipPlaceholders = groupIds.map(() => '?').join(', ');
        const membershipSql = `SELECT group_id FROM mcp_server_groups WHERE server_id = ? AND group_id IN (${membershipPlaceholders})`;
        const membershipRows = db.prepare(membershipSql).all(serverId, ...groupIds);

        if (membershipRows.length === 0) {
            return res.status(400).json({ error: 'Server is not part of the specified group' });
        }

        const removeGroups = db.transaction((rows) => {
            const deleteStmt = db.prepare('DELETE FROM mcp_server_groups WHERE server_id = ? AND group_id = ?');
            rows.forEach(row => deleteStmt.run(serverId, row.group_id));
            db.prepare('UPDATE mcp_servers SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(serverId);
        });

        removeGroups(membershipRows);

        const updatedRow = getServerRowWithGroups(db, serverId);
        const server = formatMcpServerRow(updatedRow);

        res.json({
            message: 'Server groups removed successfully',
            data: server
        });
    } catch (error) {
        console.error('Failed to remove server groups:', error);
        res.status(500).json(maskError());
    }
});

// DELETE /api/mcp-servers/:id - Delete MCP server
adminRouter.delete('/mcp-servers/:id', async (req, res) => {
    try {
        await ensureVectorDatabaseReady();
        const db = vectorDatabase.db;

        const { id } = req.params;

        if (!id || isNaN(parseInt(id))) {
            return res.status(400).json({ error: 'Invalid server ID' });
        }

        // Verify that the server exists
        const existingRow = db.prepare('SELECT server_name FROM mcp_servers WHERE id = ?').get(parseInt(id));
        if (!existingRow) {
            return res.status(404).json({ error: 'Server not found' });
        }

        // Delete the server
        const stmt = db.prepare('DELETE FROM mcp_servers WHERE id = ?');
        const result = stmt.run(parseInt(id));

        if (result.changes === 0) {
            return res.status(500).json({ error: 'Delete failed; no records were removed' });
        }

        appLogger.info(`✅ Deleted MCP server: ${existingRow.server_name} (ID: ${id})`);

        res.json({
            message: 'Server deleted successfully',
            deleted_id: parseInt(id),
            deleted_server_name: existingRow.server_name
        });
    } catch (error) {
        console.error('Failed to delete MCP server:', error);
        res.status(500).json(maskError());
    }
});

// GET /api/mcp-groups - List all groups
adminRouter.get('/mcp-groups', async (_req, res) => {
    try {
        await ensureVectorDatabaseReady();
        const db = vectorDatabase.db;

        const rows = db.prepare(`
            SELECT g.id, g.group_name, g.description, g.created_at, g.updated_at,
                   COUNT(msg.server_id) AS server_count
            FROM mcp_groups g
            LEFT JOIN mcp_server_groups msg ON g.id = msg.group_id
            GROUP BY g.id
            ORDER BY g.group_name
        `).all();

        res.json({ data: rows.map(formatMcpGroupRow) });
    } catch (error) {
        console.error('Failed to fetch group list:', error);
        res.status(500).json(maskError());
    }
});

// GET /api/mcp-groups/:id - Get group details
adminRouter.get('/mcp-groups/:id', async (req, res) => {
    try {
        await ensureVectorDatabaseReady();
        const db = vectorDatabase.db;

        const { id } = req.params;
        if (!id || isNaN(parseInt(id))) {
            return res.status(400).json({ error: 'Invalid group ID' });
        }

        const row = db.prepare(`
            SELECT g.id, g.group_name, g.description, g.created_at, g.updated_at,
                   (SELECT COUNT(*) FROM mcp_server_groups msg WHERE msg.group_id = g.id) AS server_count
            FROM mcp_groups g
            WHERE g.id = ?
        `).get(parseInt(id));

        if (!row) {
            return res.status(404).json({ error: 'Group not found' });
        }

        res.json({ data: formatMcpGroupRow(row) });
    } catch (error) {
        console.error('Failed to fetch group:', error);
        res.status(500).json(maskError());
    }

    appLogger.error({ err }, 'Unhandled server error');
    res.status(err?.status || 500).json(maskError());
});

// POST /api/mcp-groups - Create group
adminRouter.post('/mcp-groups', async (req, res) => {
    try {
        await ensureVectorDatabaseReady();
        const db = vectorDatabase.db;

        const validated = createGroupSchema.parse(req.body);
        const groupName = validated.group_name.trim();

        if (!groupName) {
            return res.status(400).json({ error: 'Group name is required' });
        }

        const existing = db.prepare('SELECT id FROM mcp_groups WHERE group_name = ?').get(groupName);
        if (existing) {
            return res.status(409).json({ error: 'Group name already exists' });
        }

        const description = validated.description?.trim() || null;
        const stmt = db.prepare('INSERT INTO mcp_groups (group_name, description) VALUES (?, ?)');
        const result = stmt.run(groupName, description);

        const row = db.prepare(`
            SELECT g.id, g.group_name, g.description, g.created_at, g.updated_at,
                   0 AS server_count
            FROM mcp_groups g
            WHERE g.id = ?
        `).get(result.lastInsertRowid);

        console.log(`✅ Create group: ${groupName} (ID: ${result.lastInsertRowid})`);

        res.status(201).json({
            message: 'Group created successfully',
            data: formatMcpGroupRow(row)
        });
    } catch (error) {
        console.error('Failed to create group:', error);
        if (error.errors) {
            return res.status(400).json({
                error: 'Input validation failed',
                details: error.errors.map(e => e.message)
            });
        }
        res.status(500).json(maskError());
    }
});

// PATCH /api/mcp-groups/:id - Update group
adminRouter.patch('/mcp-groups/:id', async (req, res) => {
    try {
        await ensureVectorDatabaseReady();
        const db = vectorDatabase.db;

        const { id } = req.params;
        if (!id || isNaN(parseInt(id))) {
            return res.status(400).json({ error: 'Invalid group ID' });
        }

        const existing = db.prepare('SELECT * FROM mcp_groups WHERE id = ?').get(parseInt(id));
        if (!existing) {
            return res.status(404).json({ error: 'Group not found' });
        }

        const validated = updateGroupSchema.parse(req.body);

        const updateFields = [];
        const updateValues = [];

        if (validated.group_name !== undefined) {
            const trimmedName = validated.group_name.trim();
            if (!trimmedName) {
                return res.status(400).json({ error: 'Group name is required' });
            }

            const nameExists = db.prepare('SELECT id FROM mcp_groups WHERE group_name = ? AND id != ?').get(trimmedName, parseInt(id));
            if (nameExists) {
                return res.status(409).json({ error: 'Group name already exists' });
            }

            updateFields.push('group_name = ?');
            updateValues.push(trimmedName);
        }

        if (validated.description !== undefined) {
            updateFields.push('description = ?');
            updateValues.push(validated.description?.trim() || null);
        }

        if (updateFields.length === 0) {
            return res.status(400).json({ error: 'No fields provided for update' });
        }

        updateFields.push('updated_at = CURRENT_TIMESTAMP');
        updateValues.push(parseInt(id));

        const stmt = db.prepare(`UPDATE mcp_groups SET ${updateFields.join(', ')} WHERE id = ?`);
        const result = stmt.run(...updateValues);

        if (result.changes === 0) {
            return res.status(500).json({ error: 'Update failed; no records were modified' });
        }

        const row = db.prepare(`
            SELECT g.id, g.group_name, g.description, g.created_at, g.updated_at,
                   (SELECT COUNT(*) FROM mcp_server_groups msg WHERE msg.group_id = g.id) AS server_count
            FROM mcp_groups g
            WHERE g.id = ?
        `).get(parseInt(id));

        console.log(`✅ Update group: ${row.group_name} (ID: ${id})`);

        res.json({
            message: 'Group updated successfully',
            data: formatMcpGroupRow(row)
        });
    } catch (error) {
        console.error('Failed to update group:', error);
        if (error.errors) {
            return res.status(400).json({
                error: 'Input validation failed',
                details: error.errors.map(e => e.message)
            });
        }
        res.status(500).json(maskError());
    }
});

// DELETE /api/mcp-groups/:id - Delete group
adminRouter.delete('/mcp-groups/:id', async (req, res) => {
    try {
        await ensureVectorDatabaseReady();
        const db = vectorDatabase.db;

        const { id } = req.params;
        if (!id || isNaN(parseInt(id))) {
            return res.status(400).json({ error: 'Invalid group ID' });
        }

        const existing = db.prepare('SELECT group_name FROM mcp_groups WHERE id = ?').get(parseInt(id));
        if (!existing) {
            return res.status(404).json({ error: 'Group not found' });
        }

        db.prepare('DELETE FROM mcp_groups WHERE id = ?').run(parseInt(id));

        console.log(`🗑️  Deleted group: ${existing.group_name} (ID: ${id})`);

        res.json({ message: 'Group deleted successfully' });
    } catch (error) {
        console.error('Failed to delete group:', error);
        res.status(500).json(maskError());
    }
});

app.use((err, _req, res, next) => {
    if (err?.message === 'Not allowed by CORS') {
        res.status(err.status || 403).json({ error: 'Origin not allowed.' });
        return;
    }

    if (res.headersSent) {
        return next(err);
    }

    console.error('Unhandled server error:', err);
    res.status(err?.status || 500).json(maskError());
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

let httpServer = null;

export function startHttpServer({ port } = {}) {
    const resolvedPort = Number.parseInt(port ?? process.env.MCP_SERVER_PORT ?? '3000', 10);

    if (httpServer) {
        return httpServer;
    }

    httpServer = app.listen(resolvedPort, () => {
        appLogger.info(`Demo MCP Server running on http://localhost:${resolvedPort}/mcp`);
    });

    httpServer.on('error', error => {
        appLogger.error({ err: error }, 'Server error');
        if (process.env.NODE_ENV !== 'test') {
            process.exit(1);
        }
    });

    return httpServer;
}

export async function stopHttpServer() {
    if (!httpServer) {
        return;
    }

    await new Promise((resolve, reject) => {
        httpServer.close(err => {
            if (err) {
                reject(err);
                return;
            }

            resolve();
        });
    });

    httpServer = null;
}

export { app };

if (import.meta.url === `file://${process.argv[1]}`) {
    startHttpServer();
}
