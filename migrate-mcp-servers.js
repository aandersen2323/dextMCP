#!/usr/bin/env node

// MCP server configuration migration script
// Migrate from JSON configuration files into the database

import fs from 'fs';
import path from 'path';
import { fileURLToPath, dirname } from 'url';
import VectorDatabase from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function migrateMcpServers() {
    console.log('🚀 Starting migration of MCP server configuration from JSON into the database...');
    console.log('ℹ️ Note: this utility only migrates from the legacy mcp-servers.json file');
    console.log('ℹ️ Use the database-backed API for ongoing configuration management');

    try {
        // 1. Read the configuration file
        const configPath = path.join(process.cwd(), 'mcp-servers.json');
        let mcpConfig;

        try {
            const configData = fs.readFileSync(configPath, 'utf8');
            mcpConfig = JSON.parse(configData);
            console.log(`📁 Read configuration file: ${configPath}`);
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log('ℹ️ Configuration file not found; nothing to migrate');
                console.log('💡 Use the admin API to add MCP servers:');
                console.log('   POST /api/mcp-servers');
                return;
            }
            throw new Error(`Failed to read configuration file: ${error.message}`);
        }

        if (!mcpConfig.servers || Object.keys(mcpConfig.servers).length === 0) {
            console.log('ℹ️ No servers found in configuration; nothing to migrate');
            console.log('💡 Use the admin API to add MCP servers:');
            console.log('   POST /api/mcp-servers');
            return;
        }

        // 2. Initialize the database
        console.log('🗄️ Initializing database...');
        const vectorDatabase = new VectorDatabase();
        await vectorDatabase.initialize();
        const db = vectorDatabase.db;

        // 3. Migrate each server entry
        const servers = mcpConfig.servers;
        let migratedCount = 0;
        let skippedCount = 0;

        for (const [serverName, serverConfig] of Object.entries(servers)) {
            try {
                // Check whether the server already exists
                const existing = db.prepare('SELECT id FROM mcp_servers WHERE server_name = ?').get(serverName);

                if (existing) {
                    console.log(`⚠️ Server ${serverName} already exists; skipping`);
                    skippedCount++;
                    continue;
                }

                // Determine the server type
                let serverType, url, command, args;

                if (serverConfig.url) {
                    serverType = 'http';
                    url = serverConfig.url;
                } else if (serverConfig.command && serverConfig.args) {
                    serverType = 'stdio';
                    command = serverConfig.command;
                    args = JSON.stringify(serverConfig.args);
                } else {
                    console.log(`❌ Server ${serverName} has invalid configuration; skipping`);
                    skippedCount++;
                    continue;
                }

                // Prepare remaining fields
                const headers = serverConfig.headers ? JSON.stringify(serverConfig.headers) : null;
                const env = serverConfig.env ? JSON.stringify(serverConfig.env) : null;
                const description = serverConfig.description || null;
                const enabled = 1; // Enabled by default

                // Insert into the database
                const stmt = db.prepare(`
                    INSERT INTO mcp_servers (
                        server_name, server_type, url, command, args,
                        headers, env, description, enabled
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);

                const result = stmt.run(
                    serverName, serverType, url, command, args,
                    headers, env, description, enabled
                );

                console.log(`✅ Migrated server: ${serverName} (ID: ${result.lastInsertRowid}, type: ${serverType})`);
                migratedCount++;

            } catch (error) {
                console.error(`❌ Failed to migrate server ${serverName}:`, error.message);
                skippedCount++;
            }
        }

        // 4. Create a backup
        if (migratedCount > 0) {
            const backupPath = path.join(process.cwd(), 'mcp-servers.json.backup');
            fs.copyFileSync(configPath, backupPath);
            console.log(`💾 Backup written to: ${backupPath}`);

            // Inform the operator that the original file can be removed
            console.log('\n📝 Migration summary:');
            console.log('   - Configuration successfully migrated to the database');
            console.log('   - Original configuration file backed up');
            console.log('   - After verifying the data you may delete the original file');
            console.log(`   - Suggested removal command: rm ${configPath}`);
        }

        console.log(`\n🎉 Migration complete! Success: ${migratedCount}, skipped: ${skippedCount}`);

        // 5. Cleanup
        vectorDatabase.close();

    } catch (error) {
        console.error('❌ Migration failed:', error.message);
        process.exit(1);
    }
}

// Usage instructions
function showUsage() {
    console.log(`
📖 MCP server configuration migration utility (deprecated)

⚠️  Note: use this tool only for migrating from the legacy mcp-servers.json
💡 Use the admin API to manage MCP servers:
     GET    /api/mcp-servers     - List servers
     POST   /api/mcp-servers     - Create server
     GET    /api/mcp-servers/:id - Get server
     PUT    /api/mcp-servers/:id - Update server
     DELETE /api/mcp-servers/:id - Delete server

Usage (only when migrating legacy configuration):
  node migrate-mcp-servers.js

Features:
  - Read configuration from mcp-servers.json (deprecated)
  - Write configuration into the mcp_servers table
  - Skip servers that already exist
  - Create a backup of the original file

Notes:
  - Only for migrating from the old configuration file
  - New deployments should use the API directly
  - Ensure the database is initialized before migrating
`);
}

// Validate CLI arguments
if (process.argv.includes('--help') || process.argv.includes('-h')) {
    showUsage();
    process.exit(0);
}

// Execute migration
if (import.meta.url === `file://${process.argv[1]}`) {
    migrateMcpServers().catch(console.error);
}

export { migrateMcpServers };