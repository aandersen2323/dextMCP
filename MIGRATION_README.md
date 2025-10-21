# MCP Server Configuration Management Guide

## Overview

This project stores MCP server configuration in a database and exposes a full RESTful API for managing it. The approach enables dynamic configuration, data persistence, and an improved operational experience.

## Configuration Storage

MCP server configuration lives in the SQLite `mcp_servers` table:

```sql
CREATE TABLE mcp_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_name TEXT NOT NULL UNIQUE,
    server_type TEXT NOT NULL CHECK (server_type IN ('http', 'stdio')),
    url TEXT,
    command TEXT,
    args TEXT,  -- JSON formatted
    headers TEXT, -- JSON formatted
    env TEXT, -- JSON formatted
    description TEXT,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## RESTful API

The API surface for MCP server management includes:

- `GET /api/mcp-servers` – Retrieve all servers
- `POST /api/mcp-servers` – Create a new server
- `GET /api/mcp-servers/:id` – Fetch a specific server
- `PUT /api/mcp-servers/:id` – Update a server
- `DELETE /api/mcp-servers/:id` – Delete a server

## Legacy Configuration Migration (Deprecated)

To migrate an old `mcp-servers.json` configuration file into the database:

```bash
# Note: Only use this helper when migrating an existing configuration file.
node migrate-mcp-servers.js
```

The migration script:

1. Reads the legacy configuration file (when present)
2. Imports the configuration into the database
3. Creates a backup of the original file
4. Skips servers that already exist in the database

## API Usage Examples

### Retrieve all enabled servers
```bash
curl http://localhost:3398/api/mcp-servers?enabled=true
```

### Create a new STDIO server
```bash
curl -X POST http://localhost:3398/api/mcp-servers \
  -H "Content-Type: application/json" \
  -d '{
    "server_name": "my-server",
    "server_type": "stdio",
    "command": "npx",
    "args": ["my-package"],
    "description": "My MCP server"
  }'
```

### Create a new HTTP server
```bash
curl -X POST http://localhost:3398/api/mcp-servers \
  -H "Content-Type: application/json" \
  -d '{
    "server_name": "my-http-server",
    "server_type": "http",
    "url": "https://example.com/mcp",
    "headers": {
      "Authorization": "Bearer token"
    },
    "description": "HTTP MCP server"
  }'
```

### Update a server configuration
```bash
curl -X PUT http://localhost:3398/api/mcp-servers/1 \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Updated description",
    "enabled": false
  }'
```

### Delete a server
```bash
curl -X DELETE http://localhost:3398/api/mcp-servers/1
```

## Benefits

1. **Dynamic configuration** – Modify server configuration at runtime via the API without restarts
2. **Data persistence** – SQLite storage supports richer queries and management workflows
3. **RESTful API** – Provides a comprehensive management interface for integration with other systems
4. **Validation** – Includes data validation and error handling
5. **Version tracking** – Creation and update timestamps make change history easy to audit

## Operational Notes

1. **Database file** – Configuration is stored in `tools_vector.db`
2. **Access control** – Add authentication/authorization before exposing the API in production
3. **Backups** – Regularly back up the database file
4. **Configuration files** – `mcp-servers.json` is deprecated; manage configuration exclusively through the database

## Troubleshooting

### Issue: MCP client fails to initialize
- Ensure the database file exists and has appropriate permissions
- Confirm there are enabled MCP server entries in the database
- Inspect application logs for detailed error messages
- Query server status via `GET /api/mcp-servers?enabled=true`

### Issue: Unable to connect to a server
- Verify the server configuration (URL, command, arguments, etc.)
- Check network connectivity and firewall rules
- Confirm the server type is correct (`http` or `stdio`)
- Update the configuration with `PUT /api/mcp-servers/:id`

### Issue: API endpoints are unreachable
- Confirm the MCP server is running
- Verify the port configuration (defaults to 3398)
- Check CORS settings
- Test the health check endpoint: `GET /health`

### Issue: How to inspect configured servers
```bash
# Retrieve enabled servers via the API
curl http://localhost:3398/api/mcp-servers?enabled=true

# Query the database directly
sqlite3 tools_vector.db "SELECT server_name, server_type, url, command FROM mcp_servers WHERE enabled = 1;"
```
