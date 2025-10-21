# MCP Server Configuration Management Guide

## Overview

This project stores MCP server configuration in a SQLite database and exposes a full RESTful API for managing the records. The API provides dynamic configuration capabilities, persistent storage, and an improved operational experience compared with static JSON files.

## Configuration Storage

MCP server definitions live in the `mcp_servers` table:

```sql
CREATE TABLE mcp_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_name TEXT NOT NULL UNIQUE,
    server_type TEXT NOT NULL CHECK (server_type IN ('http', 'stdio')),
    url TEXT,
    command TEXT,
    args TEXT,      -- JSON encoded array
    headers TEXT,   -- JSON encoded object
    env TEXT,       -- JSON encoded object
    description TEXT,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

Additional tables track grouping, session history, and vector metadata, but most migrations only need to modify the `mcp_servers` rows.

## RESTful API

The admin API exposes complete CRUD coverage for MCP servers:

- `GET /api/mcp-servers` – List servers
- `POST /api/mcp-servers` – Create a new server
- `GET /api/mcp-servers/:id` – Fetch a single server
- `PATCH /api/mcp-servers/:id` – Update server details
- `DELETE /api/mcp-servers/:id` – Remove a server

Use the `x-api-key` header with your admin API key when calling these endpoints.

## Migrating from `mcp-servers.json` (Deprecated)

If you previously managed servers with the legacy JSON file, follow the steps below to migrate the definitions into the database:

1. **Export the existing JSON**
   ```bash
   cp ~/.config/claude/mcp-servers.json ./mcp-servers.json
   ```
2. **Review the structure** – Each entry should include a unique `server_name`, the `server_type` (`http` or `stdio`), and the connection details (`url` for HTTP servers, or `command`/`args` for STDIO servers).
3. **Create the database entries** – Use the admin API to create matching rows. You can script this process; the example below shows the shape of the payload for HTTP servers:
   ```bash
   curl -X POST http://localhost:3398/api/mcp-servers \
     -H "Content-Type: application/json" \
     -H "x-api-key: YOUR_ADMIN_KEY" \
     -d '{
       "server_name": "github",
       "server_type": "http",
       "url": "http://127.0.0.1:56181",
       "description": "GitHub MCP proxy",
       "enabled": true
     }'
   ```
   For STDIO servers, supply `command` and `args` instead of `url`.
4. **Verify the migration** – Call `GET /api/mcp-servers` to confirm that each server is stored correctly, and restart the Dext service if it was running during the import.

Once the database contains the desired entries, you can remove the deprecated JSON file to avoid confusion. Future configuration changes should be made through the REST API or any tooling that uses it.

