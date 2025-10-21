/**
 * Utility functions for concurrency control and common operations
 */

/**
 * Execute items with controlled concurrency
 * @param {Array} items - Items to process
 * @param {number} limit - Maximum concurrent operations
 * @param {Function} handler - Handler function for each item
 * @returns {Promise<void>}
 */
export async function runWithConcurrency(items, limit, handler) {
    const concurrency = Math.max(1, Number.isFinite(limit) ? limit : 1);
    let index = 0;

    const workers = Array.from({ length: Math.min(concurrency, items.length || 0) }, async () => {
        while (true) {
            const currentIndex = index;
            index += 1;

            if (currentIndex >= items.length) {
                break;
            }

            await handler(items[currentIndex], currentIndex);
        }
    });

    await Promise.all(workers);
}
