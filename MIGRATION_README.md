# MCP服务器配置管理说明

## 概述

本项目使用数据库存储MCP服务器配置，提供完整的RESTful API进行配置管理。这提供了动态配置能力、数据持久化和更好的管理体验。

## 配置存储

MCP服务器配置存储在SQLite数据库的 `mcp_servers` 表中：

```sql
CREATE TABLE mcp_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_name TEXT NOT NULL UNIQUE,
    server_type TEXT NOT NULL CHECK (server_type IN ('http', 'stdio')),
    url TEXT,
    command TEXT,
    args TEXT,  -- JSON格式
    headers TEXT, -- JSON格式
    env TEXT, -- JSON格式
    description TEXT,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## RESTful API

提供完整的MCP服务器管理API：

- `GET /api/mcp-servers` - 获取服务器列表
- `POST /api/mcp-servers` - 创建新服务器
- `GET /api/mcp-servers/:id` - 获取特定服务器
- `PUT /api/mcp-servers/:id` - 更新服务器
- `DELETE /api/mcp-servers/:id` - 删除服务器

## 旧配置文件迁移 (已弃用)

如果需要从旧的 `mcp-servers.json` 文件迁移配置：

```bash
# 注意：此功能仅用于迁移旧配置，新项目请直接使用API
node migrate-mcp-servers.js
```

迁移脚本会：
1. 读取旧的配置文件（如果存在）
2. 将配置迁移到数据库
3. 创建配置文件备份
4. 跳过已存在的服务器配置

## API 使用示例

### 获取所有启用的服务器
```bash
curl http://localhost:3000/api/mcp-servers?enabled=true
```

### 创建新的STDIO服务器
```bash
curl -X POST http://localhost:3000/api/mcp-servers \
  -H "Content-Type: application/json" \
  -d '{
    "server_name": "my-server",
    "server_type": "stdio",
    "command": "npx",
    "args": ["my-package"],
    "description": "我的MCP服务器"
  }'
```

### 创建新的HTTP服务器
```bash
curl -X POST http://localhost:3000/api/mcp-servers \
  -H "Content-Type: application/json" \
  -d '{
    "server_name": "my-http-server",
    "server_type": "http",
    "url": "https://example.com/mcp",
    "headers": {
      "Authorization": "Bearer token"
    },
    "description": "HTTP MCP服务器"
  }'
```

### 更新服务器配置
```bash
curl -X PUT http://localhost:3000/api/mcp-servers/1 \
  -H "Content-Type: application/json" \
  -d '{
    "description": "更新后的描述",
    "enabled": false
  }'
```

### 删除服务器
```bash
curl -X DELETE http://localhost:3000/api/mcp-servers/1
```

## 优势

1. **动态配置**: 可以在运行时通过API修改服务器配置，无需重启应用
2. **数据持久化**: 使用SQLite数据库，支持更复杂的查询和管理
3. **RESTful API**: 提供完整的管理接口，便于集成到其他系统
4. **配置验证**: 支持数据验证和错误处理
5. **版本控制**: 数据库包含创建和更新时间，便于追踪变更

## 注意事项

1. **数据库文件**: 配置存储在 `tools_vector.db` 文件中
2. **权限管理**: 生产环境建议对API接口添加适当的权限控制
3. **备份**: 建议定期备份数据库文件
4. **配置文件**: 不再使用 `mcp-servers.json` 文件，所有配置通过数据库管理

## 故障排除

### 问题：MCP客户端初始化失败
- 检查数据库文件是否存在且有正确权限
- 确认数据库中有启用的MCP服务器配置
- 查看应用日志中的错误信息
- 使用API检查服务器状态：`GET /api/mcp-servers?enabled=true`

### 问题：服务器无法连接
- 确认服务器配置正确（URL、命令、参数等）
- 检查网络连接和防火墙设置
- 验证服务器类型是否正确（http/stdio）
- 使用API更新服务器配置：`PUT /api/mcp-servers/:id`

### 问题：API接口无法访问
- 确认MCP服务器已启动
- 检查端口配置（默认3000）
- 验证CORS设置
- 测试健康检查端点：`GET /health`

### 问题：如何查看当前配置的服务器
```bash
# 获取所有启用的服务器
curl http://localhost:3000/api/mcp-servers?enabled=true

# 直接查询数据库
sqlite3 tools_vector.db "SELECT server_name, server_type, url, command FROM mcp_servers WHERE enabled = 1;"
```