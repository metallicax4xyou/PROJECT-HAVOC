// utils/logger.js
// Logger utility with levels controlled by LOG_LEVEL environment variable

// Define logging levels with numerical values (higher means more verbose)
const LOG_LEVELS = {
    FATAL: 0,
    ERROR: 1,
    WARN: 2,
    INFO: 3,
    DEBUG: 4,
    VERBOSE: 5,
};

// Get the desired log level from environment variables, default to INFO
const currentLogLevel = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;

// Helper function to format log messages
function formatMessage(level, ...args) {
    const timestamp = new Date().toISOString();
    const levelName = Object.keys(LOG_LEVELS).find(key => LOG_LEVELS[key] === level);
    return `[${timestamp}] ${levelName}: ${args.map(arg => {
        if (typeof arg === 'object' && arg !== null) {
            // Use util.inspect for objects to get better detail, handle circular refs
            const util = require('util');
            return util.inspect(arg, { depth: null, colors: true });
        }
        return String(arg);
    }).join(' ')}`;
}

// Generic log function that checks the level
function log(level, ...args) {
    if (level <= currentLogLevel) {
        const message = formatMessage(level, ...args);
        if (level >= LOG_LEVELS.ERROR) {
            console.error(message);
        } else if (level === LOG_LEVELS.WARN) {
            console.warn(message);
        } else {
            console.log(message);
        }
    }
}

// Public interface with specific level functions
module.exports = {
    fatal: (...args) => log(LOG_LEVELS.FATAL, ...args),
    error: (...args) => log(LOG_LEVELS.ERROR, ...args),
    warn: (...args) => log(LOG_LEVELS.WARN, ...args),
    info: (...args) => log(LOG_LEVELS.INFO, ...args),
    debug: (...args) => log(LOG_LEVELS.DEBUG, ...args),
    verbose: (...args) => log(LOG_LEVELS.VERBOSE, ...args),

    // Expose levels for internal use if needed (optional)
    levels: LOG_LEVELS,
};
