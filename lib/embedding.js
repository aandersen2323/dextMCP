import { OpenAIEmbeddings } from '@langchain/openai';

function buildEmbeddingConfig(overrides = {}) {
    const envApiKey = process.env.EMBEDDING_NG_API_KEY ?? process.env.EMBEDDING_API_KEY;
    const envModel = process.env.EMBEDDING_NG_MODEL_NAME ?? process.env.EMBEDDING_MODEL_NAME;
    const envDimensions = process.env.EMBEDDING_NG_VECTOR_DIMENSION ?? process.env.EMBEDDING_VECTOR_DIMENSION;
    const envBaseUrl = process.env.EMBEDDING_NG_BASE_URL ?? process.env.EMBEDDING_BASE_URL;

    const {
        openAIApiKey = envApiKey,
        model = envModel || 'doubao-embedding-text-240715',
        dimensions = parseInt(envDimensions, 10) || 1024,
        configuration = {
            baseURL: envBaseUrl || 'https://ark.cn-beijing.volces.com/api/v3'
        }
    } = overrides;

    if (!openAIApiKey) {
        throw new Error('API密钥未设置。请在.env文件中设置 EMBEDDING_NG_API_KEY（或兼容的 EMBEDDING_API_KEY）或作为参数传入。');
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
