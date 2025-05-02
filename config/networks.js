// config/networks.js
// Basic metadata for supported networks

const { PROTOCOL_ADDRESSES } = require('../constants/addresses'); // Import chain IDs

const NETWORK_METADATA = {
    arbitrum: {
        NAME: 'arbitrum',
        CHAIN_ID: PROTOCOL_ADDRESSES.ARBITRUM_CHAIN_ID, // Should be 42161
        NATIVE_SYMBOL: 'ETH',
        EXPLORER_URL: 'https://arbiscan.io/',
        // Note: RPC URLs are handled in config/index.js via env vars
    },
    polygon: {
        NAME: 'polygon',
        CHAIN_ID: PROTOCOL_ADDRESSES.POLYGON_CHAIN_ID, // Should be 137
        NATIVE_SYMBOL: 'MATIC',
        EXPLORER_URL: 'https://polygonscan.com/',
        // Note: RPC URLs are handled in config/index.js via env vars
    },
    optimism: {
        NAME: 'optimism',
        CHAIN_ID: PROTOCOL_ADDRESSES.OPTIMISM_CHAIN_ID, // Should be 10
        NATIVE_SYMBOL: 'ETH',
        EXPLORER_URL: 'https://optimistic.etherscan.io/',
        // Note: RPC URLs are handled in config/index.js via env vars
    },
    base: {
        NAME: 'base',
        CHAIN_ID: PROTOCOL_ADDRESSES.BASE_CHAIN_ID, // Should be 8453
        NATIVE_SYMBOL: 'ETH',
        EXPLORER_URL: 'https://basescan.org/',
        // Note: RPC URLs are handled in config/index.js via env vars
    },
    // --- NEW: Local Hardhat Fork Metadata (KEY IS NOW LOWERCASE) ---
    localfork: { // <-- Changed key to lowercase 'localfork'
        NAME: 'localFork', // Keep the internal NAME property as 'localFork' for consistency if needed elsewhere
        // When forking Arbitrum, the local node's chain ID is also Arbitrum's
        CHAIN_ID: PROTOCOL_ADDRESSES.ARBITRUM_CHAIN_ID, // Should be 42161
        NATIVE_SYMBOL: 'ETH', // Arbitrum's native currency
        EXPLORER_URL: 'http://localhost:8545/', // Placeholder or local explorer URL
        RPC_URL: 'http://127.0.0.1:8545', // Explicitly set the local RPC URL
    }
    // Add other networks here if needed
};

function getNetworkMetadata(networkName) {
    const metadata = NETWORK_METADATA[networkName?.toLowerCase()]; // This lookup is lowercase
    if (!metadata) {
        throw new Error(`Unsupported network specified: ${networkName}. Supported: ${Object.keys(NETWORK_METADATA).join(', ')}`);
    }
    return metadata;
}

module.exports = {
    NETWORK_METADATA,
    getNetworkMetadata,
};
