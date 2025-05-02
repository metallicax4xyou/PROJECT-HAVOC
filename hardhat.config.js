// hardhat.config.js
require("@nomicfoundation/hardhat-toolbox");
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-verify");
require("hardhat-gas-reporter");
require("dotenv").config();

// --- Environment Variables ---
const NETWORK = process.env.NETWORK || "arbitrum";
const PRIVATE_KEY = process.env.PRIVATE_KEY?.replace(/^0x/, ""); // Strip 0x prefix if present
const ARBISCAN_API_KEY = process.env.ARBISCAN_API_KEY || "";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";
const COINMARKETCAP_API_KEY = process.env.COINMARKETCAP_API_KEY || "";

// --- RPC URLs (with fallbacks) ---
const RPC_URLS = {
arbitrum: process.env.ARBITRUM_RPC_URLS?.split(',')[0] || "https://arb1.arbitrum.io/rpc",
goerli: process.env.GOERLI_RPC_URL || "https://eth-goerli.g.alchemy.com/v2/demo",
arbitrumGoerli: process.env.ARBITRUM_GOERLI_RPC_URL || "https://goerli-rollup.arbitrum.io/rpc"
};

// --- Account Setup ---
const accounts = PRIVATE_KEY ? [`0x${PRIVATE_KEY}`] : [];

// --- Network Validation ---
if (!PRIVATE_KEY) console.warn("⚠️ PRIVATE_KEY missing - transactions will fail");
if (!ARBISCAN_API_KEY) console.warn("⚠️ ARBISCAN_API_KEY missing - contract verification disabled");

// --- Hardhat Config ---
module.exports = {
defaultNetwork: NETWORK,
solidity: {
version: "0.7.6",
settings: {
optimizer: {
enabled: true,
runs: 200
},
evmVersion: "istanbul"
}
},
networks: {
// Mainnets
arbitrum: {
url: RPC_URLS.arbitrum,
accounts,
chainId: 42161,
gasPrice: parseInt(process.env.MAX_GAS_GWEI || "1") * 1e9,
gasMultiplier: 1.25 // Matches GAS_ESTIMATE_BUFFER_PERCENT=25
},

// Testnets
goerli: {
  url: RPC_URLS.goerli,
  accounts,
  chainId: 5,
  gasPrice: parseInt(process.env.MAX_GAS_GWEI || "1") * 1e9
},
arbitrumGoerli: {
  url: RPC_URLS.arbitrumGoerli,
  accounts,
  chainId: 421613,
  gasPrice: parseInt(process.env.MAX_GAS_GWEI || "1") * 1e9
},

// Local
hardhat: {
  chainId: 31337,
  forking: {
    url: RPC_URLS.arbitrum,
    enabled: process.env.FORKING === "true"
  }
}


},
etherscan: {
apiKey: {
arbitrumOne: ARBISCAN_API_KEY,
arbitrumGoerli: ARBISCAN_API_KEY,
goerli: ETHERSCAN_API_KEY
}
},
gasReporter: {
enabled: process.env.REPORT_GAS === "true",
currency: "USD",
coinmarketcap: COINMARKETCAP_API_KEY,
token: "ETH",
gasPrice: parseInt(process.env.MAX_GAS_GWEI || "1")
},
mocha: {
timeout: 120000 // 2 minutes for testnets
}
};
