// utils/logger.js
// Basic logger utility (can be expanded later with levels, transports, etc.)

function log(...args) {
    // Add timestamp for clarity
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}]`, ...args);
}

function warn(...args) {
    const timestamp = new Date().toISOString();
    console.warn(`[${timestamp}] WARN:`, ...args);
}

function error(...args) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ERROR:`, ...args);
}

function debug(...args) {
    // Only log debug messages if DEBUG env var is set (e.g., DEBUG=true)
    if (process.env.DEBUG === 'true') {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] DEBUG:`, ...args);
    }
}

module.exports = {
    log,
    // --->>> ADDED THIS LINE <<<---
    info: log, // Map the 'info' standard name to the 'log' function
    // --->>> --- <<<---
    warn,
    error,
    debug,
};
