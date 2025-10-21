import crypto from 'crypto';

function parseAllowedOrigins() {
    const raw = process.env.ALLOWED_ORIGINS;
    if (!raw || raw.trim().length === 0) {
        return ['http://localhost:3398'];
    }

    return raw
        .split(',')
        .map(origin => origin.trim())
        .filter(origin => origin.length > 0);
}

export function buildCorsOptions() {
    const allowedOrigins = parseAllowedOrigins();

    return {
        origin(origin, callback) {
            if (!origin) {
                return callback(null, true);
            }

            if (allowedOrigins.includes(origin)) {
                return callback(null, true);
            }

            const error = new Error('Not allowed by CORS');
            error.status = 403;
            return callback(error);
        },
        credentials: true,
        methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'mcp-protocol-version', 'x-api-key'],
        optionsSuccessStatus: 200
    };
}

export function createInMemoryRateLimiter({ windowMs = 60_000, max = 60, keyGenerator } = {}) {
    const hits = new Map();
    const generator = keyGenerator || ((req) => req.ip || req.headers['x-forwarded-for'] || 'anonymous');

    return function rateLimiter(req, res, next) {
        const key = generator(req);
        const now = Date.now();
        const entry = hits.get(key);

        if (!entry || now >= entry.resetTime) {
            hits.set(key, { count: 1, resetTime: now + windowMs });
            return next();
        }

        if (entry.count >= max) {
            res.status(429).json({ error: 'Too many requests, please slow down.' });
            return;
        }

        entry.count += 1;
        return next();
    };
}

export function createAdminAuthenticator() {
    const allowUnauthenticated = process.env.ALLOW_UNAUTHENTICATED_API === 'true';

    return function authenticateAdminRequest(req, res, next) {
        const adminApiKey = process.env.ADMIN_API_KEY;

        if (!adminApiKey) {
            if (allowUnauthenticated) {
                return next();
            }

            res.status(503).json({ error: 'Admin API disabled: ADMIN_API_KEY is not configured.' });
            return;
        }

        const headerKey = req.headers['x-api-key'];
        const authHeader = req.headers.authorization;
        let providedKey = typeof headerKey === 'string' ? headerKey : undefined;

        if (!providedKey && typeof authHeader === 'string') {
            const token = authHeader.trim();
            if (token.toLowerCase().startsWith('bearer ')) {
                providedKey = token.slice(7).trim();
            } else {
                providedKey = token;
            }
        }

        if (!providedKey) {
            res.status(401).json({ error: 'Missing API key.' });
            return;
        }

        // Use constant-time comparison to avoid timing attacks.
        const requestBuffer = Buffer.from(providedKey, 'utf8');
        const validBuffer = Buffer.from(adminApiKey, 'utf8');

        if (requestBuffer.length !== validBuffer.length) {
            res.status(401).json({ error: 'Invalid API key.' });
            return;
        }

        const match = crypto.timingSafeEqual(requestBuffer, validBuffer);
        if (!match) {
            res.status(401).json({ error: 'Invalid API key.' });
            return;
        }

        return next();
    };
}

export function secureSessionId(length = 6) {
    const normalizedLength = Number.isInteger(length) && length > 0 ? length : 6;
    const bytesNeeded = Math.ceil(normalizedLength / 2);
    return crypto.randomBytes(bytesNeeded).toString('hex').slice(0, normalizedLength);
}

export function maskError() {
    return { error: 'Internal server error. Please try again later.' };
}

export const __internals = {
    parseAllowedOrigins
};
