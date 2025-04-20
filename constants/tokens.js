// /workspaces/arbitrum-flash/constants/tokens.js
// --- FINALIZED: CHAINID, TYPE, NEW TOKENS, VERIFIED ADDRESSES ---

const { Token } = require('@uniswap/sdk-core');

// Define constants for chain IDs
const ARBITRUM_CHAIN_ID = 42161;

// --- Helper function to add metadata consistently ---
function createTokenWithMetadata(chainId, address, decimals, symbol, name, metadata) {
    const token = new Token(chainId, address, decimals, symbol, name);
    Object.assign(token, metadata);
    // Ensure canonicalSymbol defaults to symbol if not provided
    if (!token.canonicalSymbol) {
        token.canonicalSymbol = token.symbol;
    }
    return token;
}


// --- Define Tokens for Arbitrum ---
// Addresses verified via Arbiscan [2025-04-20]

// Existing Tokens (Enhanced)
const _WETH = createTokenWithMetadata(
    ARBITRUM_CHAIN_ID, '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 18, 'WETH', 'Wrapped Ether',
    { canonicalSymbol: 'WETH', type: 'native' }
);

const _USDC = createTokenWithMetadata(
    ARBITRUM_CHAIN_ID, '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6, 'USDC', 'USD Coin',
    { canonicalSymbol: 'USDC', type: 'stablecoin' }
);

const _USDCe = createTokenWithMetadata(
    ARBITRUM_CHAIN_ID, '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', 6, 'USDC.e', 'USD Coin Bridged',
    { canonicalSymbol: 'USDC', type: 'stablecoin-bridged' } // Maps to USDC
);

const _USDT = createTokenWithMetadata(
    ARBITRUM_CHAIN_ID, '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6, 'USDT', 'Tether USD',
    { canonicalSymbol: 'USDT', type: 'stablecoin' }
);

const _ARB = createTokenWithMetadata(
    ARBITRUM_CHAIN_ID, '0x912CE59144191C1204E64559FE8253a0e49E6548', 18, 'ARB', 'Arbitrum',
    { canonicalSymbol: 'ARB', type: 'governance' }
);

const _DAI = createTokenWithMetadata(
    ARBITRUM_CHAIN_ID, '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', 18, 'DAI', 'Dai Stablecoin',
    { canonicalSymbol: 'DAI', type: 'stablecoin' }
);

const _WBTC = createTokenWithMetadata(
    ARBITRUM_CHAIN_ID, '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', 8, 'WBTC', 'Wrapped BTC',
    { canonicalSymbol: 'WBTC', type: 'btc-wrapped' }
);

// Newly Added & Verified Tokens
const _LINK = createTokenWithMetadata(
    ARBITRUM_CHAIN_ID, '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4', 18, 'LINK', 'ChainLink Token',
    { canonicalSymbol: 'LINK', type: 'oracle' }
);

const _FRAX = createTokenWithMetadata(
    ARBITRUM_CHAIN_ID, '0x17FC002b466eEc40DaE837Fc4bE5c67993ddBd6F', 18, 'FRAX', 'Frax',
    { canonicalSymbol: 'FRAX', type: 'stablecoin-algorithmic' }
);

const _GMX = createTokenWithMetadata(
    ARBITRUM_CHAIN_ID,
    '0xfc5a1a6eb076a2c7ad06ed22c90d7e710e35ad0a', // CORRECTED ADDRESS
    18, 'GMX', 'GMX',
    { canonicalSymbol: 'GMX', type: 'defi-perp' }
);

const _MAGIC = createTokenWithMetadata(
    ARBITRUM_CHAIN_ID, '0x539bdE0d7Dbd336b79148AA742883198BBF60342', 18, 'MAGIC', 'Magic',
    { canonicalSymbol: 'MAGIC', type: 'gaming' }
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
const networkName = process.env.NETWORK?.toLowerCase() || 'arbitrum';
let TOKENS_TO_EXPORT;
switch (networkName) {
    case 'arbitrum':
        TOKENS_TO_EXPORT = ARBITRUM_TOKENS;
        break;
    default:
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
