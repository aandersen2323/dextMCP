#!/usr/bin/env node

// MCP server configuration migration script
// Migrates legacy JSON configuration into the database

import fs from 'fs';
import path from 'path';
import { fileURLToPath, dirname } from 'url';
import VectorDatabase from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function migrateMcpServers() {
    console.log('🚀 Migrating MCP server configuration from JSON into the database...');
    console.log('ℹ️  Use this tool only when migrating an existing mcp-servers.json file.');
    console.log('ℹ️  New deployments should manage servers through the REST API.');

    try {
        // 1. Load configuration file
        const configPath = path.join(process.cwd(), 'mcp-servers.json');
        let mcpConfig;

        try {
            const configData = fs.readFileSync(configPath, 'utf8');
            mcpConfig = JSON.parse(configData);
            console.log(`📁 Loaded configuration file: ${configPath}`);
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log('ℹ️ Configuration file not found; nothing to migrate.');
                console.log('💡 To add MCP servers, call the REST API:');
                console.log('   POST /api/mcp-servers');
                return;
            }
            throw new Error(`Failed to read configuration file: ${error.message}`);
        }

        if (!mcpConfig.servers || Object.keys(mcpConfig.servers).length === 0) {
            console.log('ℹ️ Configuration file does not contain any servers; nothing to migrate.');
            console.log('💡 To add MCP servers, call the REST API:');
            console.log('   POST /api/mcp-servers');
            return;
        }

        // 2. Initialize database
        console.log('🗄️ Initializing database...');
        const vectorDatabase = new VectorDatabase();
        await vectorDatabase.initialize();
        const db = vectorDatabase.db;

        // 3. Migrate each server configuration
        const servers = mcpConfig.servers;
        let migratedCount = 0;
        let skippedCount = 0;

        for (const [serverName, serverConfig] of Object.entries(servers)) {
            try {
                // Skip servers that already exist
                const existing = db.prepare('SELECT id FROM mcp_servers WHERE server_name = ?').get(serverName);

                if (existing) {
                    console.log(`⚠️ Server ${serverName} already exists; skipping migration`);
                    skippedCount++;
                    continue;
                }

                // Determine server type
                let serverType, url, command, args;

                if (serverConfig.url) {
                    serverType = 'http';
                    url = serverConfig.url;
                } else if (serverConfig.command && serverConfig.args) {
                    serverType = 'stdio';
                    command = serverConfig.command;
                    args = JSON.stringify(serverConfig.args);
                } else {
                    console.log(`❌ Server ${serverName} is misconfigured; skipping migration`);
                    skippedCount++;
                    continue;
                }

                // Prepare additional fields
                const headers = serverConfig.headers ? JSON.stringify(serverConfig.headers) : null;
                const env = serverConfig.env ? JSON.stringify(serverConfig.env) : null;
                const description = serverConfig.description || null;
                const enabled = 1; // enable by default

                // Insert into database
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

        // 4. Create a backup of the original file
        if (migratedCount > 0) {
            const backupPath = path.join(process.cwd(), 'mcp-servers.json.backup');
            fs.copyFileSync(configPath, backupPath);
            console.log(`💾 Configuration file backed up to: ${backupPath}`);

            console.log('\n📝 Migration summary:');
            console.log('   - Configuration migrated into the database');
            console.log('   - Original JSON file backed up');
            console.log('   - Remove the original file after confirming the migration:');
            console.log(`     rm ${configPath}`);
        }

        console.log(`\n🎉 Migration complete! Migrated: ${migratedCount}, skipped: ${skippedCount}`);

        // 5. Cleanup
        vectorDatabase.close();

    } catch (error) {
        console.error('❌ Migration failed:', error.message);
        process.exit(1);
    }
}

// Display usage information
function showUsage() {
    console.log(`
📖 MCP Server Configuration Migration Tool (deprecated)

⚠️  Use this helper only when migrating an existing mcp-servers.json file.
💡 Prefer the REST API for ongoing MCP server management:
     GET    /api/mcp-servers     - List servers
     POST   /api/mcp-servers     - Create a new server
     GET    /api/mcp-servers/:id - Retrieve a server
     PUT    /api/mcp-servers/:id - Update a server
     DELETE /api/mcp-servers/:id - Delete a server

Usage (legacy migrations only):
  node migrate-mcp-servers.js

What it does:
  - Reads the legacy mcp-servers.json configuration
  - Migrates entries into the mcp_servers database table
  - Skips servers that already exist
  - Creates a backup of the original file

Notes:
  - Only use this script for migrating legacy configurations
  - New projects should rely on the REST API instead
  - Ensure the database is initialized before running the migration
`);
}

// Check command line arguments
if (process.argv.includes('--help') || process.argv.includes('-h')) {
    showUsage();
    process.exit(0);
}

// Execute migration when invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
    migrateMcpServers().catch(console.error);
}

export { migrateMcpServers };
