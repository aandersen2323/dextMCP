# MCP Server 配置说明

Dext 现在使用统一的配置文件来管理所有 MCP 服务器连接。当 `initializeMCPClient()` 被调用时，系统会自动读取配置并为所有配置了 URL 的 MCP server 创建 AuthProvider。

## 配置文件结构

配置文件位于项目根目录下的 `mcp-servers.json`：

```json
{
  "servers": {
    "服务器名称": {
      "url": "服务器地址",
      "description": "服务器描述",
      "headers": {  // 可选：自定义请求头
        "API_KEY": "${API_KEY_ENV_VAR}"
      }
    }
  },
  "oauth": {
    "callbackPort": "${MCP_CALLBACK_PORT:12334}",
    "host": "localhost",
    "clientName": "Dext"
  }
}
```

## 配置说明

### 基本配置
只要配置了 `url` 字段，系统就会自动为该服务器创建 `OAuthClientProvider`。

```json
{
  "feishu": {
    "url": "http://localhost:8788/mcp",
    "description": "飞书文档集成服务"
  },
  "linear": {
    "url": "https://mcp.linear.app/mcp",
    "description": "Linear 项目管理服务"
  }
}
```

### 带 API Key 的配置
如果服务器需要额外的 API Key，可以在 `headers` 字段中配置：

```json
{
  "context7": {
    "url": "https://mcp.context7.com/mcp",
    "headers": {
      "CONTEXT7_API_KEY": "${CONTEXT7_API_KEY}"
    },
    "description": "Context7 AI 服务"
  }
}
```

**注意**：即使配置了 `headers`，系统仍然会为该服务器创建 OAuth 认证提供者。

## 环境变量支持

配置文件支持环境变量替换，格式为 `${VARIABLE_NAME:default_value}`：

- `${MCP_CALLBACK_PORT:12334}` - 从环境变量 `MCP_CALLBACK_PORT` 读取值，如果不存在则使用默认值 `12334`
- `${CONTEXT7_API_KEY}` - 必须设置环境变量，否则值为空

## 使用步骤

1. **配置环境变量**

   复制 `.env.example` 为 `.env` 并配置必要的环境变量：
   ```bash
   cp .env.example .env
   ```

2. **编辑 MCP 服务器配置**

   根据需要修改 `mcp-servers.json` 中的服务器配置。

3. **初始化 MCP 客户端**

   系统会自动读取配置并为所有配置的服务器创建相应的认证提供者：
   ```javascript
   import { initializeMCPClient } from './index.js';

   const mcpClient = await initializeMCPClient();
   ```

## 添加新的 MCP Server

要添加新的 MCP 服务器，只需在 `mcp-servers.json` 中添加相应配置：

```json
{
  "servers": {
    "new_server": {
      "url": "https://api.new-server.com/mcp",
      "description": "新的服务器描述"
    }
  }
}
```

系统会自动为新服务器创建 OAuth 认证提供者。如果需要额外的 API Key，可以添加 `headers` 字段：

```json
{
  "servers": {
    "new_server": {
      "url": "https://api.new-server.com/mcp",
      "description": "新的服务器描述",
      "headers": {
        "AUTH_TOKEN": "${NEW_SERVER_TOKEN}"
      }
    }
  }
}
```

## 配置验证

系统在启动时会验证配置文件的存在和格式。如果配置文件不存在或格式错误，会在控制台输出错误信息并返回 `null`。