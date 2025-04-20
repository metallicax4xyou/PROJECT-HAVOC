// /workspaces/arbitrum-flash/constants/tokens.js
// --- UPDATED WITH CHAINID, TYPE, and NEW TOKENS ---

const { Token } = require('@uniswap/sdk-core');

// Define constants for chain IDs
const ARBITRUM_CHAIN_ID = 42161;

// --- Helper function to add metadata consistently ---
// (This improves readability slightly over adding properties individually)
function createTokenWithMetadata(chainId, address, decimals, symbol, name, metadata) {
    const token = new Token(chainId, address, decimals, symbol, name);
    // Assign canonicalSymbol, type, and any other metadata
    Object.assign(token, metadata);
    // Ensure canonicalSymbol defaults to symbol if not provided
    if (!token.canonicalSymbol) {
        token.canonicalSymbol = token.symbol;
    }
    return token;
}


// --- Define Tokens for Arbitrum ---
// Find official addresses from Arbiscan/Project Docs/CoinGecko

// Existing Tokens (Enhanced)
const _WETH = createTokenWithMetadata(
    ARBITRUM_CHAIN_ID, '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 18, 'WETH', 'Wrapped Ether',
    { canonicalSymbol: 'WETH', type: 'native' } // Type: Native/Wrapped Native
);

const _USDC = createTokenWithMetadata(
    ARBITRUM_CHAIN_ID, '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6, 'USDC', 'USD Coin',
    { canonicalSymbol: 'USDC', type: 'stablecoin' } // Type: Stablecoin (Native Arbitrum version)
);

const _USDCe = createTokenWithMetadata(
    ARBITRUM_CHAIN_ID, '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', 6, 'USDC.e', 'USD Coin Bridged',
    { canonicalSymbol: 'USDC', type: 'stablecoin-bridged' } // Type: Stablecoin (Bridged) - maps to USDC
);

const _USDT = createTokenWithMetadata(
    ARBITRUM_CHAIN_ID, '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6, 'USDT', 'Tether USD',
    { canonicalSymbol: 'USDT', type: 'stablecoin' } // Type: Stablecoin
);

const _ARB = createTokenWithMetadata(
    ARBITRUM_CHAIN_ID, '0x912CE59144191C1204E64559FE8253a0e49E6548', 18, 'ARB', 'Arbitrum',
    { canonicalSymbol: 'ARB', type: 'governance' } // Type: Governance/Native L2
);

const _DAI = createTokenWithMetadata(
    ARBITRUM_CHAIN_ID, '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', 18, 'DAI', 'Dai Stablecoin',
    { canonicalSymbol: 'DAI', type: 'stablecoin' } // Type: Stablecoin
);

const _WBTC = createTokenWithMetadata(
    ARBITRUM_CHAIN_ID, '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', 8, 'WBTC', 'Wrapped BTC',
    { canonicalSymbol: 'WBTC', type: 'btc-wrapped' } // Type: Wrapped Asset
);

// New Tokens to Add (Verify Addresses/Decimals!)
const _LINK = createTokenWithMetadata(
    ARBITRUM_CHAIN_ID, '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4', 18, 'LINK', 'ChainLink Token',
    { canonicalSymbol: 'LINK', type: 'oracle' } // Type: Oracle/Infrastructure
);

const _FRAX = createTokenWithMetadata(
    ARBITRUM_CHAIN_ID, '0x17FC002b466eEc40DaE837Fc4bE5c67993ddBd6F', 18, 'FRAX', 'Frax',
    { canonicalSymbol: 'FRAX', type: 'stablecoin-algorithmic' } // Type: Stablecoin (Algorithmic)
);

const _GMX = createTokenWithMetadata(
    ARBITRUM_CHAIN_ID, '0xfc5A1A6EB076a2C7140eC451cC31Ba958Ed97231', 18, 'GMX', 'GMX',
    { canonicalSymbol: 'GMX', type: 'defi-perp' } // Type: DeFi / Perp Dex
);

const _MAGIC = createTokenWithMetadata(
    ARBITRUM_CHAIN_ID, '0x539bdE0d7Dbd336b79148AA742883198BBF60342', 18, 'MAGIC', 'Magic',
    { canonicalSymbol: 'MAGIC', type: 'gaming' } // Type: Gaming / Metaverse
);

// --- Add more tokens as needed ---

// Define the main export object using the modified tokens
const ARBITRUM_TOKENS = {
    // Existing
    WETH: _WETH,
    USDC: _USDC,
    'USDC.e': _USDCe, // Key remains 'USDC.e' to match config files
    USDT: _USDT,
    ARB: _ARB,
    DAI: _DAI,
    WBTC: _WBTC,
    // New
    LINK: _LINK,
    FRAX: _FRAX,
    GMX: _GMX,
    MAGIC: _MAGIC,
};

// --- Export based on current network ---
// (Keep your existing network switch logic)
const networkName = process.env.NETWORK?.toLowerCase() || 'arbitrum';
let TOKENS_TO_EXPORT;
switch (networkName) {
    case 'arbitrum':
        TOKENS_TO_EXPORT = ARBITRUM_TOKENS;
        break;
    default:
        // Use a proper logger instance here if available, otherwise console
        (console.warn || console.log)(`[tokens.js] Network "${networkName}" not explicitly configured in tokens.js, defaulting to Arbitrum tokens.`);
        TOKENS_TO_EXPORT = ARBITRUM_TOKENS;
}

// Ensure logger is defined or imported - replace if necessary
const logger = { info: console.log, warn: console.warn, error: console.error, debug: console.log };
logger.info(`[tokens.js] Exporting tokens for network: ${networkName}`);

// Optional: Debug log to verify metadata after loading
// Object.values(TOKENS_TO_EXPORT).forEach(token => {
//    logger.debug(`[tokens.js] Token: ${token.symbol}, Addr: ${token.address}, Canon: ${token.canonicalSymbol}, Type: ${token.type}, ChainId: ${token.chainId}`);
// });

module.exports = {
    TOKENS: TOKENS_TO_EXPORT,
};
