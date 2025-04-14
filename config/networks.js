// config/networks.js
// Basic metadata for supported networks

const { PROTOCOL_ADDRESSES } = require('../constants/addresses'); // Import chain IDs

const NETWORK_METADATA = {
    arbitrum: {
        NAME: 'arbitrum',
        CHAIN_ID: PROTOCOL_ADDRESSES.ARBITRUM_CHAIN_ID,
        NATIVE_SYMBOL: 'ETH',
        EXPLORER_URL: 'https://arbiscan.io/',
    },
    polygon: {
        NAME: 'polygon',
        CHAIN_ID: PROTOCOL_ADDRESSES.POLYGON_CHAIN_ID,
        NATIVE_SYMBOL: 'MATIC',
        EXPLORER_URL: 'https://polygonscan.com/',
    },
    optimism: {
        NAME: 'optimism',
        CHAIN_ID: PROTOCOL_ADDRESSES.OPTIMISM_CHAIN_ID,
        NATIVE_SYMBOL: 'ETH',
        EXPLORER_URL: 'https://optimistic.etherscan.io/',
    },
    base: {
        NAME: 'base',
        CHAIN_ID: PROTOCOL_ADDRESSES.BASE_CHAIN_ID,
        NATIVE_SYMBOL: 'ETH',
        EXPLORER_URL: 'https://basescan.org/',
    }
    // Add other networks here if needed
};

function getNetworkMetadata(networkName) {
    const metadata = NETWORK_METADATA[networkName?.toLowerCase()];
    if (!metadata) {
        throw new Error(`Unsupported network specified: ${networkName}. Supported: ${Object.keys(NETWORK_METADATA).join(', ')}`);
    }
    return metadata;
}

module.exports = {
    NETWORK_METADATA,
    getNetworkMetadata,
};
