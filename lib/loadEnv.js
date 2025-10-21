import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const candidateEnvPaths = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), 'data/.env')
];

for (const envPath of candidateEnvPaths) {
    if (existsSync(envPath)) {
        dotenv.config({ path: envPath });
        break;
    }
}
