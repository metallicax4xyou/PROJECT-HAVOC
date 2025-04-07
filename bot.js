// bot.js - Arbitrum Uniswap V3 Flash Swap Bot with Debugging (v13 - Correct FlashSwap ABI)

const { ethers } = require("ethers");
require('dotenv').config();

// --- Configuration ---
const RPC_URL = process.env.ARBITRUM_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// Use getAddress for verified/standard addresses
const FLASH_SWAP_CONTRACT_ADDRESS = ethers.getAddress("0x7a00Ec5b64e662425Bbaa0dD78972570C326210f");
const WETH_ADDRESS = ethers.getAddress("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1");
const USDC_ADDRESS = ethers.getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"); // Native USDC

// Use lowercase for potentially problematic addresses
const QUOTER_V2_ADDRESS = "0x61ffe014ba17989e743c5f6d790181c0603c3996"; // Lowercase
const POOL_A_ADDRESS = "0xc31e54c7a869b9fcbecc14363cf510d1c41fa441"; // Lowercase (WETH/USDC 0.05%)
const POOL_B_ADDRESS = "0x17c14d2c404d167802b16c450d3c99f88f2c4f4d"; // Lowercase (WETH/USDC 0.30%)

const POOL_A_FEE_BPS = 500; const POOL_A_FEE_PERCENT = 0.05;
const POOL_B_FEE_BPS = 3000; const POOL_B_FEE_PERCENT = 0.30;
const WETH_DECIMALS = 18; const USDC_DECIMALS = 6;

// --- ABIs ---

// --- PASTED YOUR FlashSwapABI HERE ---
const FlashSwapABI = [
    {
      "inputs": [
        {
          "internalType": "address",
          "name": "_swapRouter",
          "type": "address"
        }
      ],
      "stateMutability": "nonpayable",
      "type": "constructor"
    },
    {
      "anonymous": false,
      "inputs": [
        {
          "indexed": true,
          "internalType": "address",
          "name": "poolA",
          "type": "address"
        },
        {
          "indexed": true,
          "internalType": "address",
          "name": "poolB",
          "type": "address"
        },
        {
          "indexed": false,
          "internalType": "address",
          "name": "tokenBorrowed",
          "type": "address"
        },
        {
          "indexed": false,
          "internalType": "uint256",
          "name": "amountBorrowed",
          "type": "uint256"
        },
        {
          "indexed": false,
          "internalType": "uint256",
          "name": "feePaid",
          "type": "uint256"
        }
      ],
      "name": "ArbitrageAttempt",
      "type": "event"
    },
    {
      "anonymous": false,
      "inputs": [
        {
          "indexed": false,
          "internalType": "uint256",
          "name": "amountOutMin1",
          "type": "uint256"
        },
        {
          "indexed": false,
          "internalType": "uint256",
          "name": "actualAmountIntermediate",
          "type": "uint256"
        },
        {
          "indexed": false,
          "internalType": "uint256",
          "name": "amountOutMin2",
          "type": "uint256"
        },
        {
          "indexed": false,
          "internalType": "uint256",
          "name": "actualFinalAmount",
          "type": "uint256"
        },
        {
          "indexed": false,
          "internalType": "uint256",
          "name": "requiredRepayment",
          "type": "uint256"
        }
      ],
      "name": "DebugSwapValues",
      "type": "event"
    },
    {
      "anonymous": false,
      "inputs": [
        {
          "indexed": true,
          "internalType": "address",
          "name": "token",
          "type": "address"
        },
        {
          "indexed": true,
          "internalType": "address",
          "name": "recipient",
          "type": "address"
        },
        {
          "indexed": false,
          "internalType": "uint256",
          "name": "amount",
          "type": "uint256"
        }
      ],
      "name": "EmergencyWithdrawal",
      "type": "event"
    },
    {
      "anonymous": false,
      "inputs": [
        {
          "indexed": true,
          "internalType": "address",
          "name": "caller",
          "type": "address"
        },
        {
          "indexed": true,
          "internalType": "address",
          "name": "pool",
          "type": "address"
        },
        {
          "indexed": false,
          "internalType": "uint256",
          "name": "amount0",
          "type": "uint256"
        },
        {
          "indexed": false,
          "internalType": "uint256",
          "name": "amount1",
          "type": "uint256"
        }
      ],
      "name": "FlashSwapInitiated",
      "type": "event"
    },
    {
      "anonymous": false,
      "inputs": [
        {
          "indexed": true,
          "internalType": "address",
          "name": "token",
          "type": "address"
        },
        {
          "indexed": true,
          "internalType": "address",
          "name": "recipient",
          "type": "address"
        },
        {
          "indexed": false,
          "internalType": "uint256",
          "name": "amount",
          "type": "uint256"
        }
      ],
      "name": "ProfitTransferred",
      "type": "event"
    },
    {
      "anonymous": false,
      "inputs": [
        {
          "indexed": true,
          "internalType": "address",
          "name": "token",
          "type": "address"
        },
        {
          "indexed": false,
          "internalType": "uint256",
          "name": "amountRepaid",
          "type": "uint256"
        }
      ],
      "name": "RepaymentSuccess",
      "type": "event"
    },
    {
      "anonymous": false,
      "inputs": [
        {
          "indexed": true,
          "internalType": "uint256",
          "name": "swapNumber",
          "type": "uint256"
        },
        {
          "indexed": true,
          "internalType": "address",
          "name": "tokenIn",
          "type": "address"
        },
        {
          "indexed": true,
          "internalType": "address",
          "name": "tokenOut",
          "type": "address"
        },
        {
          "indexed": false,
          "internalType": "uint256",
          "name": "amountIn",
          "type": "uint256"
        },
        {
          "indexed": false,
          "internalType": "uint256",
          "name": "amountOut",
          "type": "uint256"
        }
      ],
      "name": "SwapExecuted",
      "type": "event"
    },
    {
      "inputs": [],
      "name": "SWAP_ROUTER",
      "outputs": [
        {
          "internalType": "contract ISwapRouter",
          "name": "",
          "type": "address"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "V3_FACTORY",
      "outputs": [
        {
          "internalType": "address",
          "name": "",
          "type": "address"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [
        {
          "internalType": "address",
          "name": "_poolAddress",
          "type": "address"
        },
        {
          "internalType": "uint256",
          "name": "_amount0",
          "type": "uint256"
        },
        {
          "internalType": "uint256",
          "name": "_amount1",
          "type": "uint256"
        },
        {
          "internalType": "bytes",
          "name": "_params",
          "type": "bytes"
        }
      ],
      "name": "initiateFlashSwap",
      "outputs": [],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "owner",
      "outputs": [
        {
          "internalType": "address",
          "name": "",
          "type": "address"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [
        {
          "internalType": "uint256",
          "name": "fee0",
          "type": "uint256"
        },
        {
          "internalType": "uint256",
          "name": "fee1",
          "type": "uint256"
        },
        {
          "internalType": "bytes",
          "name": "data",
          "type": "bytes"
        }
      ],
      "name": "uniswapV3FlashCallback",
      "outputs": [],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "withdrawEther",
      "outputs": [],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "inputs": [
        {
          "internalType": "address",
          "name": "tokenAddress",
          "type": "address"
        }
      ],
      "name": "withdrawToken",
      "outputs": [],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "stateMutability": "payable",
      "type": "receive"
    }
];


// --- Using Minimal ABIs for Standard Interfaces ---
const IUniswapV3PoolABI = [
    "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function liquidity() external view returns (uint128)"
];
const IQuoterV2ABI = [
    "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceNextX96, uint32 ticksCrossed, uint256 gasEstimate)"
];


// --- Bot Settings ---
const POLLING_INTERVAL_MS = 10000;
const PROFIT_THRESHOLD_USD = 0.05;
let BORROW_AMOUNT_WETH_WEI = ethers.parseUnits("0.00005", WETH_DECIMALS);

// --- Initialization ---
if (!RPC_URL || !PRIVATE_KEY) { console.error("ENV VAR MISSING"); process.exit(1); }
console.log("[Init] Setting up Provider...");
const provider = new ethers.JsonRpcProvider(RPC_URL);
console.log("[Init] Setting up Signer...");
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

console.log("[Init] Instantiating Contracts...");
let flashSwapContract, quoterContract, poolAContract, poolBContract;
try {
    // Use the full FlashSwapABI pasted above
    flashSwapContract = new ethers.Contract(FLASH_SWAP_CONTRACT_ADDRESS, FlashSwapABI, signer);
    quoterContract = new ethers.Contract(QUOTER_V2_ADDRESS, IQuoterV2ABI, provider);
    poolAContract = new ethers.Contract(POOL_A_ADDRESS, IUniswapV3PoolABI, provider);
    poolBContract = new ethers.Contract(POOL_B_ADDRESS, IUniswapV3PoolABI, provider);
    console.log("[Init] All Contract instances created successfully.");
} catch (contractError) {
    console.error("\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error("FATAL: Error instantiating contracts!");
    console.error("Likely cause: Syntax error or incompleteness in one of the ABIs.");
    console.error(contractError);
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    process.exit(1);
}


// --- Initial Logs ---
console.log(`Bot starting...`);
console.log(` - Signer Address: ${signer.address}`);
console.log(` - FlashSwap Contract: ${FLASH_SWAP_CONTRACT_ADDRESS}`);
console.log(` - Quoter V2 Contract: ${QUOTER_V2_ADDRESS}`);
console.log(` - Monitoring Pools:`);
console.log(`   - Pool A (WETH/USDC ${POOL_A_FEE_PERCENT}%): ${POOL_A_ADDRESS}`);
console.log(`   - Pool B (WETH/USDC ${POOL_B_FEE_PERCENT}%): ${POOL_B_ADDRESS}`);
console.log(` - Debug Borrow Amount: ${ethers.formatUnits(BORROW_AMOUNT_WETH_WEI, WETH_DECIMALS)} WETH`);
console.log(` - Polling Interval: ${POLLING_INTERVAL_MS / 1000} seconds`);
console.log(` - Profit Threshold: $${PROFIT_THRESHOLD_USD} USD (approx, before gas)`);

// --- Helper Functions ---
// (Keep existing simulateSwap function)
async function simulateSwap(poolDesc, tokenIn, tokenOut, amountInWei, feeBps, quoter) {
    try {
        const params = { tokenIn, tokenOut, amountIn: amountInWei, fee: feeBps, sqrtPriceLimitX96: 0n };
        const quoteResult = await quoter.quoteExactInputSingle.staticCall(params);
        return quoteResult[0];
    } catch (error) {
        console.warn(`Quoter simulation failed for ${poolDesc} (Fee: ${feeBps}bps): ${error.reason || error.message || error}`);
        return 0n;
    }
}

// (Keep existing attemptArbitrage function)
async function attemptArbitrage(opportunity) {
    console.log("\n========= Arbitrage Opportunity Detected =========");
    // ... Inside attemptArbitrage ...
    // Find the line where initiateFlashSwapArgs is defined
    const initiateFlashSwapArgs = [ flashLoanPoolAddress, borrowAmount0, borrowAmount1, encodedParams ];

    try {
        console.log("  [1/3] Attempting staticCall simulation...");
        // Ensure the ABI includes initiateFlashSwap
        await flashSwapContract.initiateFlashSwap.staticCall( ...initiateFlashSwapArgs, { gasLimit: 3_000_000 });
        console.log("  ✅ [1/3] staticCall successful.");

        console.log("  [2/3] Attempting estimateGas...");
        try {
            const estimatedGas = await flashSwapContract.initiateFlashSwap.estimateGas(...initiateFlashSwapArgs);
            console.log(`  ✅ [2/3] estimateGas successful. Estimated Gas: ${Number(estimatedGas)}`);
            console.log("  [3/3] Conditions met for sending transaction (Execution Disabled).");
            // --- TX SENDING CODE (COMMENTED) ---
        } catch (gasError) {
            console.error(`  ❌ [2/3] estimateGas failed:`, gasError.reason || gasError.message || gasError);
        }
    } catch (staticCallError) {
        console.error(`  ❌ [1/3] staticCall failed:`, staticCallError.reason || staticCallError.message || staticCallError);
         if (staticCallError.data) {
             console.error(`     Revert Data: ${staticCallError.data}`);
             // Optional: Try decoding custom error data if reason is generic
             // try {
             //     const iface = new ethers.Interface(FlashSwapABI);
             //     const decodedError = iface.parseError(staticCallError.data);
             //     console.error(`     Decoded Error: ${decodedError.name}(${decodedError.args})`);
             // } catch (decodeErr) { /* Ignore if not a known custom error */ }
         }
    }
    console.log("========= Arbitrage Attempt Complete =========");
 } // End attemptArbitrage

// --- Main Monitoring Loop ---
// (Keep existing monitorPools function - includes detailed logging)
async function monitorPools() {
    console.log(`\n[Monitor] START - ${new Date().toISOString()}`);
    try {
        console.log("  [Monitor] Fetching pool states...");
        console.log(`  [Monitor] Calling Promise.all for pool states... (A: ${POOL_A_ADDRESS}, B: ${POOL_B_ADDRESS})`);
        const poolStatePromises = [
            poolAContract.slot0().catch(e => { console.error(`[Monitor] Error fetching slot0 for Pool A (${POOL_A_ADDRESS}): ${e.message || e}`); return null; }), // Log full error
            poolAContract.liquidity().catch(e => { console.error(`[Monitor] Error fetching liquidity for Pool A (${POOL_A_ADDRESS}): ${e.message || e}`); return null; }), // Log full error
            poolBContract.slot0().catch(e => { console.error(`[Monitor] Error fetching slot0 for Pool B (${POOL_B_ADDRESS}): ${e.message || e}`); return null; }), // Log full error
            poolBContract.liquidity().catch(e => { console.error(`[Monitor] Error fetching liquidity for Pool B (${POOL_B_ADDRESS}): ${e.message || e}`); return null; }) // Log full error
        ];
        const [slotA, liqA, slotB, liqB] = await Promise.all(poolStatePromises);
        console.log("  [Monitor] Promise.all for pool states resolved.");

        let poolAStateFetched = false; let poolBStateFetched = false;
        if (slotA && liqA !== null) {
             console.log(`  [Monitor] Pool A State: Tick=${slotA.tick}, Liquidity=${liqA.toString()}`);
             if (liqA === 0n) console.warn("    [Monitor] WARNING: Pool A has ZERO active liquidity!");
             poolAStateFetched = true;
        } else { console.log(`  [Monitor] Pool A State: Failed to fetch.`); }
        if (slotB && liqB !== null) {
             console.log(`  [Monitor] Pool B State: Tick=${slotB.tick}, Liquidity=${liqB.toString()}`);
              if (liqB === 0n) console.warn("    [Monitor] WARNING: Pool B has ZERO active liquidity!");
              poolBStateFetched = true;
        } else { console.log(`  [Monitor] Pool B State: Failed to fetch.`); }

        if (!poolAStateFetched || !poolBStateFetched) {
            console.log("  [Monitor] Could not fetch state for both pools. Skipping simulation cycle.");
            console.log("[Monitor] END (Early exit due to fetch failure)");
            return;
        }

        // ... rest of monitorPools logic (simulations, price checks, opportunity detection) ...

    } catch (error) {
        console.error(`[Monitor] Error in monitoring loop:`, error);
    } finally {
        console.log(`[Monitor] END - ${new Date().toISOString()}`);
    }
} // End monitorPools function


// --- Start the Bot ---
// (Keep existing startup IIFE - includes detailed logging)
(async () => {
    console.log("\n>>> Entering startup async IIFE...");
    // ... startup checks ...
    console.log(">>> Attempting first monitorPools() run...");
    await monitorPools();
    console.log(">>> First monitorPools() run complete.");
    console.log(">>> Setting up setInterval...");
    setInterval(monitorPools, POLLING_INTERVAL_MS);
    console.log(`\nMonitoring started. Will check every ${POLLING_INTERVAL_MS / 1000} seconds.`);
    // ... catch block ...
})();
