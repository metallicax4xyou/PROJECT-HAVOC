// utils/provider.js

// Use require for imports
const { ethers, FallbackProvider, JsonRpcProvider } = require('ethers');
const dotenv = require('dotenv');

// --- THIS LINE IS CORRECTED ---
const logger = require('./logger'); // Import the entire logger object
// --- ---

dotenv.config();

const arbitrumRpcUrls = process.env.ARBITRUM_RPC_URLS;

if (!arbitrumRpcUrls) {
    // Now logger.error should work correctly
    logger.error("ARBITRUM_RPC_URLS environment variable is not set.");
    process.exit(1); // Exit if critical config is missing
}

// Split, trim, and filter URLs
const rpcUrls = arbitrumRpcUrls.split(',')
    .map(url => url.trim())
    .filter(url => url); // Filter out empty strings

if (rpcUrls.length === 0) {
    logger.error("No valid RPC URLs found in ARBITRUM_RPC_URLS environment variable.");
    process.exit(1); // Exit if no valid URLs provided
}

logger.info(`[Provider] Setting up FallbackProvider with ${rpcUrls.length} RPC URLs.`);

// Configure providers for FallbackProvider
const providerConfigs = rpcUrls.map((url, index) => {
    try {
        return {
            provider: new JsonRpcProvider(url),
            priority: index, // Lower number means higher priority
            stallTimeout: 1500, // ms before trying next provider
            weight: 1,
        };
    } catch (error) {
        // Catch potential errors during JsonRpcProvider instantiation (e.g., invalid URL format)
        logger.warn(`[Provider] Failed to create JsonRpcProvider for URL: ${url}. Skipping this URL. Error: ${error.message}`);
        return null; // Return null for invalid configs
    }
}).filter(config => config !== null); // Filter out any nulls from failed instantiations

if (providerConfigs.length === 0) {
    logger.error("[Provider] No valid provider configurations could be created from the provided RPC URLs.");
    process.exit(1);
}

// Create the FallbackProvider instance
// Using the network name 'arbitrum' or chain ID 42161 helps ethers.js validate connections
const provider = new FallbackProvider(providerConfigs, 'arbitrum'); // Or use chain ID 42161

// Optional: Event listeners
provider.on('error', (error) => {
    logger.error('[Provider] FallbackProvider encountered an error:', error);
});

// Test connection function
async function testProviderConnection() {
    try {
        const network = await provider.getNetwork();
        const blockNumber = await provider.getBlockNumber();
        logger.info(`[Provider] Successfully connected via FallbackProvider to network: ${network.name} (Chain ID: ${network.chainId}), Current Block: ${blockNumber}`);
    } catch (error) {
        logger.error(`[Provider] Failed to connect to Arbitrum via FallbackProvider: ${error.message}`);
        logger.error('[Provider] Check individual RPC URLs and network connectivity. Ensure ARBITRUM_RPC_URLS in .env is correct.');
        // Consider if failure here should be fatal
        // process.exit(1);
    }
}

// Immediately invoke the test connection
// Note: This runs asynchronously. The provider object is available immediately,
// but the connection test completes later.
testProviderConnection();

// Export the configured provider instance using module.exports
// Ensure flashSwapManager.js uses `const { getProvider } = require(...)` and then `const provider = getProvider()`
module.exports = {
    provider, // Exporting the instance directly might also be used depending on consumer
    getProvider: () => provider // Export a getter function
};
