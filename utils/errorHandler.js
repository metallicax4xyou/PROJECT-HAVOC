// utils/errorHandler.js
// Enhanced error handling with more detailed logging

class ArbitrageError extends Error {
    constructor(message, type = 'GENERIC', details = {}) {
        super(message);
        this.type = type; // e.g., 'RPC_ERROR', 'SIMULATION_ERROR', 'GAS_ERROR', 'CONFIG_ERROR'
        this.details = details; // Optional extra context
        this.name = 'ArbitrageError';
        Error.captureStackTrace(this, this.constructor); // Capture stack trace properly
    }
}

// Enhanced handler - logs more details for different error types
function handleError(error, context = 'Unknown context') {
    console.error(`\n--- ERROR ENCOUNTERED ---`);
    console.error(`Context: ${context}`);
    console.error(`Timestamp: ${new Date().toISOString()}`);

    if (error instanceof ArbitrageError) {
        console.error(`Type: ArbitrageError (${error.type})`);
        console.error(`Message: ${error.message}`);
        if (error.details && Object.keys(error.details).length > 0) {
             // Attempt to stringify details safely
             try {
                 console.error("Details:", JSON.stringify(error.details, (key, value) =>
                     typeof value === 'bigint' ? value.toString() : value, // Convert BigInts for stringify
                 2));
             } catch (e) {
                  console.error("Details: (Could not stringify details)", error.details);
             }
        }
        // console.error("Stack:", error.stack); // Optionally log stack

    } else if (error.code && typeof error.code === 'string') { // Ethers-like errors
         console.error(`Type: EthersError (Code: ${error.code})`);
         console.error(`Reason: ${error.reason || 'No reason provided'}`);
         console.error(`Message: ${error.message}`);
         // Log the full error object structure, trying to handle BigInts
         console.error("--- Full EthersError Object Start ---");
         try {
             console.error(JSON.stringify(error, (key, value) =>
                 typeof value === 'bigint' ? `BigInt(${value.toString()})` : value, // Special format for BigInts
             2));
         } catch (e) {
             console.error("(Could not fully stringify error object):", error);
         }
         console.error("--- Full EthersError Object End ---");

    } else {
        // Generic unexpected errors
        console.error(`Type: Unexpected Error`);
        console.error(`Message: ${error.message || 'No message provided'}`);
        console.error("--- Full Unexpected Error Object Start ---");
        console.error(error); // Log the raw object
        console.error("--- Full Unexpected Error Object End ---");
        // console.error("Stack:", error.stack); // Log stack for unexpected errors
    }
    console.error(`--- END ERROR LOG ---\n`);

    // Decide if the error should halt the bot or just be logged
}

module.exports = {
    ArbitrageError,
    handleError,
};
