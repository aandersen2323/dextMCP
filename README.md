# Node.js + LangChain MCP 适配器项目

这是一个集成了LangChain MCP适配器的Node.js项目，支持多服务器MCP客户端连接。

## 项目结构

```
langchain-project/
├── package.json      # 项目配置文件（包含MCP适配器依赖）
├── index.js          # 项目入口文件（集成MCP客户端）
├── README.md         # 项目说明文档
└── .gitignore        # Git忽略文件配置
```

## 依赖

主要依赖包括：
- `@langchain/mcp-adapters` - LangChain MCP适配器，用于连接多个MCP服务器
- `@langchain/openai` - LangChain OpenAI集成，支持embedding功能
- `langchain` - LangChain核心库
- `mcp-remote-oauth-client-provider` - MCP远程OAuth客户端提供者

## 安装依赖

```bash
npm install
```

## 运行项目

```bash
# 启动项目
npm start

# 或者直接运行
node index.js
```

## 项目功能

- 基础的Node.js应用架构
- **LangChain MCP多服务器客户端集成**
- **Doubao Embedding向量化功能**
- 支持多种MCP服务器连接类型：
  - STDIO传输（本地服务器）
  - HTTP/HTTPS传输（远程服务器）
  - Server-Sent Events (SSE)
  - OAuth 2.0认证支持
- 预配置的MCP服务器示例：
  - 数学计算服务器
  - 文件系统服务器
  - 天气服务器
  - GitHub集成服务器
- 自动重连和错误处理
- 工具名称前缀配置
- 标准化内容块格式支持

### 向量化功能

项目集成了使用Doubao embedding模型的文本向量化功能：

- **单个字符串向量化**: 使用 `vectorizeString()` 函数
- **批量字符串向量化**: 使用 `vectorizeMultipleStrings()` 函数
- **OpenAI兼容接口**: 支持标准的embedding API调用
- **自动错误处理**: 内置错误捕获和日志记录

## 向量化功能使用指南

### 环境配置

使用向量化功能前，需要配置.env文件。项目根目录已包含.env模板文件，请根据需要修改配置：

```env
# Doubao Embedding API 配置
DOUBAO_API_KEY=your-doubao-api-key-here
DOUBAO_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
DOUBAO_MODEL_NAME=doubao-embedding-text-240715
DOUBAO_VECTOR_DIMENSION=1024

# 其他配置
MCP_SERVER_URL=http://localhost:8788/mcp
MCP_CALLBACK_PORT=12334
```

**重要**：请将 `your-doubao-api-key-here` 替换为您的实际API密钥。

### 基本使用示例

#### 方式一：使用.env配置（推荐）

```javascript
import { vectorizeString, vectorizeMultipleStrings } from './index.js';

// 单个字符串向量化 - 自动使用.env中的配置
const text = "这是一个测试文本";

try {
    const vector = await vectorizeString(text);
    console.log(`向量维度: ${vector.length}`);
    console.log(`向量值: ${vector.slice(0, 5)}...`); // 显示前5个值
} catch (error) {
    console.error('向量化失败:', error.message);
}

// 批量字符串向量化 - 自动使用.env中的配置
const texts = [
    "人工智能技术发展迅速",
    "自然语言处理很有趣",
    "向量化是关键技术"
];

try {
    const vectors = await vectorizeMultipleStrings(texts);
    console.log(`成功向量化 ${vectors.length} 个文本`);
    vectors.forEach((vector, index) => {
        console.log(`文本 ${index + 1} 向量维度: ${vector.length}`);
    });
} catch (error) {
    console.error('批量向量化失败:', error.message);
}
```

#### 方式二：直接传入API密钥

```javascript
import { vectorizeString, vectorizeMultipleStrings } from './index.js';

const apiKey = "your-doubao-api-key";

// 单个字符串向量化
const vector = await vectorizeString("测试文本", apiKey);

// 批量字符串向量化
const vectors = await vectorizeMultipleStrings(["文本1", "文本2"], apiKey);
```

### API参数说明

#### vectorizeString(text, apiKey?)
- `text`: 要向量化的字符串
- `apiKey`: (可选) Doubao API密钥。如果不提供，会自动从.env文件中读取DOUBAO_API_KEY
- 返回值: Promise<number[]> - 向量数组

#### vectorizeMultipleStrings(texts, apiKey?)
- `texts`: 要向量化的字符串数组
- `apiKey`: (可选) Doubao API密钥。如果不提供，会自动从.env文件中读取DOUBAO_API_KEY
- 返回值: Promise<number[][]> - 向量数组的数组

### 配置变量说明

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `DOUBAO_API_KEY` | - | Doubao API密钥（必须设置） |
| `DOUBAO_BASE_URL` | `https://ark.cn-beijing.volces.com/api/v3` | API端点地址 |
| `DOUBAO_MODEL_NAME` | `doubao-embedding-text-240715` | 使用的模型名称 |
| `DOUBAO_VECTOR_DIMENSION` | `1024` | 预期的向量维度 |

### 模型配置信息

- **模型名称**: `doubao-embedding-text-240715`
- **API端点**: `https://ark.cn-beijing.volces.com/api/v3`
- **兼容性**: OpenAI embedding API标准
- **向量维度**: 由模型决定（通常为768或1024维）

## 开发指南

1. 在 [`index.js`](index.js:1) 中编写你的主要应用逻辑
2. 使用 `npm start` 启动应用
3. 根据需要添加更多的依赖包
4. 配置Doubao API密钥以使用向量化功能

## 许可证

MIT