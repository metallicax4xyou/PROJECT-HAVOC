// /workspaces/arbitrum-flash/constants/tokens.js
// --- UPDATED WITH CANONICAL SYMBOLS ---

const { Token } = require('@uniswap/sdk-core');

// Define constants for chain IDs
const ARBITRUM_CHAIN_ID = 42161;
// Add other chain IDs if you plan to support more networks later
// const POLYGON_CHAIN_ID = 137;
// const BASE_CHAIN_ID = 8453;
// const OPTIMISM_CHAIN_ID = 10;

// --- Define Tokens for Arbitrum ---
// Create instances first
const _WETH = new Token(
    ARBITRUM_CHAIN_ID,
    '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // Official WETH on Arbitrum
    18,
    'WETH',
    'Wrapped Ether'
);
const _USDC = new Token( // Representing native Arbitrum USDC
    ARBITRUM_CHAIN_ID,
    '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // Official Native USDC on Arbitrum
    6,
    'USDC',
    'USD Coin'
);
const _USDCe = new Token( // Representing bridged USDC from Ethereum (often has .e suffix)
    ARBITRUM_CHAIN_ID,
    '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', // Bridged USDC.e on Arbitrum
    6,
    'USDC.e', // Symbol remains the same
    'USD Coin Bridged'
);
const _USDT = new Token(
    ARBITRUM_CHAIN_ID,
    '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', // Official USDT on Arbitrum
    6,
    'USDT',
    'Tether USD'
);
const _ARB = new Token(
    ARBITRUM_CHAIN_ID,
    '0x912CE59144191C1204E64559FE8253a0e49E6548', // Verified ARB
    18,
    'ARB',
    'Arbitrum'
);
const _DAI = new Token(
    ARBITRUM_CHAIN_ID,
    '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', // Verified DAI
    18,
    'DAI',
    'Dai Stablecoin'
);
const _WBTC = new Token(
    ARBITRUM_CHAIN_ID,
    '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', // Verified WBTC
    8, // WBTC has 8 decimals
    'WBTC',
    'Wrapped BTC'
);

// --- Add canonicalSymbol property to each token object ---
_WETH.canonicalSymbol = 'WETH';
_USDC.canonicalSymbol = 'USDC'; // Canonical for native USDC
_USDCe.canonicalSymbol = 'USDC'; // Canonical for bridged USDC.e (maps to USDC)
_USDT.canonicalSymbol = 'USDT';
_ARB.canonicalSymbol = 'ARB';
_DAI.canonicalSymbol = 'DAI';
_WBTC.canonicalSymbol = 'WBTC';
// --- ---

// Define the main export object using the modified tokens
const ARBITRUM_TOKENS = {
    WETH: _WETH,
    USDC: _USDC,
    'USDC.e': _USDCe, // Key remains 'USDC.e' to match config files
    USDT: _USDT,
    ARB: _ARB,
    DAI: _DAI,
    WBTC: _WBTC,
};

// --- Export based on current network ---
const networkName = process.env.NETWORK?.toLowerCase() || 'arbitrum'; // Default to arbitrum

let TOKENS_TO_EXPORT;

switch (networkName) {
    case 'arbitrum':
        TOKENS_TO_EXPORT = ARBITRUM_TOKENS;
        break;
    // Add cases for other networks if needed
    // case 'polygon':
    //     TOKENS_TO_EXPORT = POLYGON_TOKENS; // Define POLYGON_TOKENS similarly
    //     break;
    default:
        console.warn(`[tokens.js] Network "${networkName}" not explicitly configured in tokens.js, defaulting to Arbitrum tokens.`);
        TOKENS_TO_EXPORT = ARBITRUM_TOKENS;
}

// Ensure logger is defined or imported
const logger = { // Replace with your actual logger import if needed
    info: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.log,
};

logger.info(`[tokens.js] Exporting tokens for network: ${networkName}`);
// Optional: Debug log to verify canonical symbols
// Object.values(TOKENS_TO_EXPORT).forEach(token => {
//    logger.debug(`[tokens.js] Token: ${token.symbol}, Canonical: ${token.canonicalSymbol}`);
// });


module.exports = {
    TOKENS: TOKENS_TO_EXPORT,
};
