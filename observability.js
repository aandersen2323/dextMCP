const LEVELS = {
    trace: 10,
    debug: 20,
    info: 30,
    warn: 40,
    error: 50,
    fatal: 60
};

const levelName = (process.env.LOG_LEVEL || 'info').toLowerCase();
const levelThreshold = LEVELS[levelName] ?? LEVELS.info;

function normalizeError(err) {
    if (!(err instanceof Error)) {
        return err;
    }

    return {
        name: err.name,
        message: err.message,
        stack: err.stack
    };
}

class Logger {
    constructor(bindings = {}) {
        this.bindings = bindings;
    }

    child(extraBindings = {}) {
        return new Logger({ ...this.bindings, ...extraBindings });
    }

    log(level, dataOrMessage, maybeMessage) {
        if ((LEVELS[level] ?? LEVELS.info) < levelThreshold) {
            return;
        }

        let message;
        let data;

        if (typeof dataOrMessage === 'string') {
            message = dataOrMessage;
            data = typeof maybeMessage === 'object' ? maybeMessage : undefined;
        } else {
            data = dataOrMessage;
            message = typeof maybeMessage === 'string' ? maybeMessage : undefined;
        }

        const payload = {
            level,
            time: new Date().toISOString(),
            ...this.bindings
        };

        if (message) {
            payload.msg = message;
        }

        if (data && typeof data === 'object') {
            const normalized = {};
            for (const [key, value] of Object.entries(data)) {
                if (value === undefined) {
                    continue;
                }

                if (key === 'err') {
                    normalized.err = normalizeError(value);
                } else {
                    normalized[key] = value;
                }
            }
            Object.assign(payload, normalized);
        }

        try {
            const line = JSON.stringify(payload);
            process.stdout.write(`${line}\n`);
        } catch (serializationError) {
            process.stdout.write(JSON.stringify({
                level: 'error',
                time: new Date().toISOString(),
                msg: 'Failed to serialize log entry',
                bindings: this.bindings,
                originalMessage: message,
                serializationError: normalizeError(serializationError)
            }) + '\n');
        }
    }

    trace(dataOrMessage, maybeMessage) { this.log('trace', dataOrMessage, maybeMessage); }
    debug(dataOrMessage, maybeMessage) { this.log('debug', dataOrMessage, maybeMessage); }
    info(dataOrMessage, maybeMessage) { this.log('info', dataOrMessage, maybeMessage); }
    warn(dataOrMessage, maybeMessage) { this.log('warn', dataOrMessage, maybeMessage); }
    error(dataOrMessage, maybeMessage) { this.log('error', dataOrMessage, maybeMessage); }
    fatal(dataOrMessage, maybeMessage) { this.log('fatal', dataOrMessage, maybeMessage); }
}

export const logger = new Logger();

export function createChildLogger(bindings = {}) {
    return logger.child(bindings);
}

class Histogram {
    constructor({ name, help, buckets, labelNames }) {
        this.name = name;
        this.help = help;
        this.buckets = buckets.sort((a, b) => a - b);
        this.labelNames = labelNames;
        this.series = new Map();
    }

    _getSeries(labels) {
        const key = this.labelNames.map(label => labels[label] ?? '').join('::');
        if (!this.series.has(key)) {
            this.series.set(key, {
                labels,
                counts: Array(this.buckets.length + 1).fill(0),
                sum: 0,
                total: 0
            });
        }

        return this.series.get(key);
    }

    observe(value, labels) {
        const series = this._getSeries(labels);
        series.sum += value;
        series.total += 1;

        let bucketIndex = this.buckets.findIndex(bucket => value <= bucket);
        if (bucketIndex === -1) {
            bucketIndex = this.buckets.length;
        }

        series.counts[bucketIndex] += 1;
    }

    async toPrometheus() {
        const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];

        for (const series of this.series.values()) {
            let cumulative = 0;
            this.buckets.forEach((bucket, index) => {
                cumulative += series.counts[index];
                const labels = { ...series.labels, le: bucket };
                lines.push(`${this.name}_bucket${formatLabels(labels)} ${cumulative}`);
            });

            cumulative += series.counts[this.buckets.length];
            lines.push(`${this.name}_bucket${formatLabels({ ...series.labels, le: '+Inf' })} ${cumulative}`);
            lines.push(`${this.name}_sum${formatLabels(series.labels)} ${series.sum}`);
            lines.push(`${this.name}_count${formatLabels(series.labels)} ${series.total}`);
        }

        return lines.join('\n');
    }
}

function formatLabels(labels) {
    const keys = Object.keys(labels);
    if (keys.length === 0) {
        return '';
    }

    const serialized = keys
        .map(key => `${key}="${String(labels[key]).replace(/"/g, '\\"')}"`)
        .join(',');
    return `{${serialized}}`;
}

const httpRequestHistogram = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10]
});

const histograms = [httpRequestHistogram];

export function metricsMiddleware(req, res, next) {
    const start = process.hrtime.bigint();

    res.on('finish', () => {
        const diff = process.hrtime.bigint() - start;
        const seconds = Number(diff) / 1_000_000_000;
        const route = req.route?.path || req.originalUrl || 'unknown';
        httpRequestHistogram.observe(seconds, {
            method: req.method,
            route,
            status_code: String(res.statusCode)
        });
    });

    next();
}

export async function metricsHandler(_req, res) {
    try {
        const sections = await Promise.all(histograms.map(hist => hist.toPrometheus()));
        res.set('Content-Type', 'text/plain; version=0.0.4');
        res.send(sections.filter(Boolean).join('\n') + '\n');
    } catch (error) {
        logger.error({ err: error }, 'Failed to render metrics');
        res.status(500).send('Metrics collection failed');
    }
}

export function createRequestLogger({ loggerInstance = logger } = {}) {
    return function requestLogger(req, res, next) {
        const start = process.hrtime.bigint();
        const child = loggerInstance.child({
            requestId: req.headers['x-request-id'] || undefined,
            method: req.method,
            url: req.originalUrl
        });

        child.info('incoming request');

        res.on('finish', () => {
            const durationNs = process.hrtime.bigint() - start;
            const durationMs = Number(durationNs) / 1_000_000;
            child.info({
                statusCode: res.statusCode,
                durationMs: Number(durationMs.toFixed(3))
            }, 'request completed');
        });

        next();
    };
}

export const metricsRegistry = {
    async toPrometheus() {
        const sections = await Promise.all(histograms.map(hist => hist.toPrometheus()));
        return sections.filter(Boolean).join('\n');
    }
};
