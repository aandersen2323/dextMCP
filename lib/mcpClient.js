import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { OAuthClientProvider } from 'mcp-remote-oauth-client-provider';
import VectorDatabase from '../database.js';
import { createChildLogger } from '../observability.js';

const clientLogger = createChildLogger({ module: 'mcp-client' });

let globalMCPClient = null;
let initializePromise = null;

function parseEnvVariable(value) {
    if (typeof value !== 'string') {
        return value;
    }

    return value.replace(/\$\{([^:}]+)(?::([^}]*))?\}/g, (_match, variableName, defaultValue) => {
        const envValue = process.env[variableName];
        return envValue !== undefined ? envValue : (defaultValue || '');
    });
}

async function initializeMCPClient() {
    if (globalMCPClient) {
        return globalMCPClient;
    }

    if (initializePromise) {
        return initializePromise;
    }

    initializePromise = (async () => {
        let vectorDatabase;
        try {
            vectorDatabase = new VectorDatabase();
            await vectorDatabase.initialize();

            const stmt = vectorDatabase.db.prepare('SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY server_name');
            const mcpServers = stmt.all();
            clientLogger.info(`Loaded ${mcpServers.length} enabled MCP servers from the database`);

            const callbackPort = process.env.MCP_CALLBACK_PORT || '12334';
            const host = 'localhost';
            const clientName = 'Dext';
            const authProviders = {};

            for (const serverRow of mcpServers) {
                if (serverRow.url) {
                    authProviders[serverRow.server_name] = OAuthClientProvider.createWithAutoAuth({
                        serverUrl: serverRow.url,
                        callbackPort,
                        host,
                        clientName,
                    });
                    clientLogger.debug(`Creating OAuth provider for ${serverRow.server_name}`);
                }
            }

            const mcpServersConfig = {};

            for (const serverRow of mcpServers) {
                const serverConfigForClient = {};

                if (serverRow.server_type === 'stdio' && serverRow.command) {
                    serverConfigForClient.command = serverRow.command;

                    if (serverRow.args) {
                        try {
                            serverConfigForClient.args = JSON.parse(serverRow.args);
                        } catch (error) {
                            clientLogger.warn({ err: error, server: serverRow.server_name }, 'Failed to parse args');
                            continue;
                        }
                    }

                    if (serverRow.env) {
                        try {
                            const envVars = JSON.parse(serverRow.env);
                            serverConfigForClient.env = {};
                            for (const [envName, envValue] of Object.entries(envVars)) {
                                serverConfigForClient.env[envName] = parseEnvVariable(envValue);
                            }
                        } catch (error) {
                            clientLogger.warn({ err: error, server: serverRow.server_name }, 'Failed to parse env');
                        }
                    }

                    clientLogger.info(`Configured stdio server: ${serverRow.server_name}`);
                } else if (serverRow.server_type === 'http' && serverRow.url) {
                    serverConfigForClient.url = serverRow.url;

                    if (authProviders[serverRow.server_name]) {
                        serverConfigForClient.authProvider = authProviders[serverRow.server_name];
                    }

                    if (serverRow.headers) {
                        try {
                            const headers = JSON.parse(serverRow.headers);
                            serverConfigForClient.headers = {};
                            for (const [headerName, headerValue] of Object.entries(headers)) {
                                serverConfigForClient.headers[headerName] = parseEnvVariable(headerValue);
                            }
                        } catch (error) {
                            clientLogger.warn({ err: error, server: serverRow.server_name }, 'Failed to parse headers');
                        }
                    }

                    clientLogger.info(`Configured HTTP server: ${serverRow.server_name}`);
                } else {
                    clientLogger.warn(`Server ${serverRow.server_name} has invalid configuration; skipped`);
                    continue;
                }

                mcpServersConfig[serverRow.server_name] = serverConfigForClient;
            }

            const client = new MultiServerMCPClient({
                throwOnLoadError: false,
                prefixToolNameWithServerName: true,
                additionalToolNamePrefix: '',
                useStandardContentBlocks: true,
                mcpServers: mcpServersConfig,
            });

            await client.getTools();
            clientLogger.info('MCP client initialized');
            globalMCPClient = client;
            return client;
        } catch (error) {
            clientLogger.error({ err: error }, 'Failed to initialize MCP client');
            globalMCPClient = null;
            return null;
        } finally {
            initializePromise = null;
            if (vectorDatabase) {
                vectorDatabase.close();
            }
        }
    })();

    return initializePromise;
}

function getMCPClient() {
    return globalMCPClient;
}

export {
    getMCPClient,
    initializeMCPClient,
    parseEnvVariable
};

export default {
    getMCPClient,
    initializeMCPClient,
    parseEnvVariable
};
