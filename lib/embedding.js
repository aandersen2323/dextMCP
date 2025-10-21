import { OpenAIEmbeddings } from '@langchain/openai';

function buildEmbeddingConfig(overrides = {}) {
    const {
        openAIApiKey = process.env.EMBEDDING_API_KEY,
        model = process.env.EMBEDDING_MODEL_NAME || 'doubao-embedding-text-240715',
        dimensions = parseInt(process.env.EMBEDDING_VECTOR_DIMENSION, 10) || 1024,
        configuration = {
            baseURL: process.env.EMBEDDING_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3'
        }
    } = overrides;

    if (!openAIApiKey) {
        throw new Error('API密钥未设置。请在.env文件中设置EMBEDDING_API_KEY或作为参数传入。');
    }

    return { openAIApiKey, model, dimensions, configuration };
}

async function vectorizeString(text, overrides = {}) {
    const config = buildEmbeddingConfig(overrides);
    const embeddings = new OpenAIEmbeddings(config);
    const vectors = await embeddings.embedQuery(text);
    return vectors;
}

async function vectorizeMultipleStrings(texts, overrides = {}) {
    const config = buildEmbeddingConfig(overrides);
    const embeddings = new OpenAIEmbeddings(config);
    const vectors = await embeddings.embedDocuments(texts);
    return vectors;
}

export {
    buildEmbeddingConfig,
    vectorizeString,
    vectorizeMultipleStrings
};

export default {
    buildEmbeddingConfig,
    vectorizeString,
    vectorizeMultipleStrings
};
