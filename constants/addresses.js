// constants/addresses.js

// Using CommonJS for now unless package.json specifies "type": "module"
// If using ESM, change to: export const PROTOCOL_ADDRESSES = { ... };

const PROTOCOL_ADDRESSES = {
  ARBITRUM_CHAIN_ID: 42161,
  POLYGON_CHAIN_ID: 137,
  OPTIMISM_CHAIN_ID: 10,
  BASE_CHAIN_ID: 8453,

  // Addresses shared across networks (Verify if applicable)
  UNISWAP_V3_FACTORY: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  QUOTER_V2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', // Often the same, but verify per network if needed

  // Network-specific addresses (examples)
  ARBITRUM: {
    // Add specific addresses if they differ or are only on Arbitrum
    // e.g., WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'
  },
  POLYGON: {
    // e.g., WETH: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619'
  },
  // Add OPTIMISM, BASE placeholders
};

module.exports = {
  PROTOCOL_ADDRESSES,
};
