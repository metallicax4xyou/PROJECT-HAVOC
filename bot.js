// bot.js - Arbitrum Uniswap V3 Flash Swap Bot with Debugging (v7 - Lowercase Pool Addresses)

const { ethers } = require("ethers");
require('dotenv').config();

// --- Configuration ---
const RPC_URL = process.env.ARBITRUM_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// --- Use getAddress for verified/standard addresses ---
const FLASH_SWAP_CONTRACT_ADDRESS = ethers.getAddress("0x7a00Ec5b64e662425Bbaa0dD78972570C326210f");
const WETH_ADDRESS = ethers.getAddress("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1");
const USDC_ADDRESS = ethers.getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"); // Native USDC
// Uniswap V3 Quoter V2 Address on Arbitrum
const QUOTER_V2_ADDRESS = ethers.getAddress("0x61fFE014bA17989E743c5F6d790181C0603C3996");


// --- Use lowercase for pool addresses to bypass checksum issue ---
// Pool Configuration (WETH/USDC)
const POOL_A_ADDRESS = "0xc696d20fd7ac47c89ea8b8c51065a67b6ffa2067"; // WETH/USDC 0.05% (LOWERCASE) - Still VERIFY if this is the right pool logic address!
const POOL_A_FEE_BPS = 500;
const POOL_A_FEE_PERCENT = 0.05;

const POOL_B_ADDRESS = "0xc31e54c7a869b9fcbecc14363cf510d1c41fa441"; // WETH/USDC 0.30% (LOWERCASE) - Still VERIFY if this is the right pool logic address!
const POOL_B_FEE_BPS = 3000;
const POOL_B_FEE_PERCENT = 0.30;

const WETH_DECIMALS = 18;
const USDC_DECIMALS = 6;

// --- ABIs ---
// (Keep your existing ABIs: FlashSwapABI, IUniswapV3PoolABI, IQuoterV2ABI)
const FlashSwapABI = [ /* ... ABI ... */ ];
const IUniswapV3PoolABI = [ /* ... ABI ... */ ];
const IQuoterV2ABI = [ /* ... ABI ... */ ];


// --- Bot Settings ---
const POLLING_INTERVAL_MS = 10000;
const PROFIT_THRESHOLD_USD = 0.05;
let BORROW_AMOUNT_WETH_WEI = ethers.parseUnits("0.00005", WETH_DECIMALS);

// --- Initialization ---
if (!RPC_URL || !PRIVATE_KEY) {
    console.error("Error: ARBITRUM_RPC_URL and PRIVATE_KEY must be set in .env file.");
    process.exit(1);
}
const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);
// Use checksummed addresses where defined with getAddress
const flashSwapContract = new ethers.Contract(FLASH_SWAP_CONTRACT_ADDRESS, FlashSwapABI, signer);
const quoterContract = new ethers.Contract(QUOTER_V2_ADDRESS, IQuoterV2ABI, provider);
// Use lowercase addresses directly for pools
const poolAContract = new ethers.Contract(POOL_A_ADDRESS, IUniswapV3PoolABI, provider);
const poolBContract = new ethers.Contract(POOL_B_ADDRESS, IUniswapV3PoolABI, provider);

console.log(`Bot starting...`);
console.log(` - Signer Address: ${signer.address}`);
console.log(` - FlashSwap Contract: ${FLASH_SWAP_CONTRACT_ADDRESS}`); // Checksummed
console.log(` - Monitoring Pools:`);
console.log(`   - Pool A (WETH/USDC ${POOL_A_FEE_PERCENT}%): ${POOL_A_ADDRESS}`); // Lowercase
console.log(`   - Pool B (WETH/USDC ${POOL_B_FEE_PERCENT}%): ${POOL_B_ADDRESS}`); // Lowercase
console.log(` - Debug Borrow Amount: ${ethers.formatUnits(BORROW_AMOUNT_WETH_WEI, WETH_DECIMALS)} WETH`);
console.log(` - Polling Interval: ${POLLING_INTERVAL_MS / 1000} seconds`);
console.log(` - Profit Threshold: $${PROFIT_THRESHOLD_USD} USD (approx, before gas)`);

// --- Helper Functions ---
// (Keep existing simulateSwap function - it uses constants passed to it)
async function simulateSwap(poolDesc, tokenIn, tokenOut, amountInWei, feeBps, quoter) {
    try {
        const params = {
            tokenIn: tokenIn, // Uses checksummed WETH/USDC addresses
            tokenOut: tokenOut, // Uses checksummed WETH/USDC addresses
            amountIn: amountInWei,
            fee: feeBps,
            sqrtPriceLimitX96: 0n
        };
        const quoteResult = await quoter.quoteExactInputSingle.staticCall(params);
        return quoteResult[0];
    } catch (error) {
        console.warn(`Quoter simulation failed for ${poolDesc} (Fee: ${feeBps}bps): ${error.reason || error.message || error}`);
        return 0n;
    }
}


// (Keep existing attemptArbitrage function - it uses constants passed to it)
async function attemptArbitrage(opportunity) {
    console.log("\n========= Arbitrage Opportunity Detected =========");
    // Determine parameters based on the detected opportunity direction
    let flashLoanPoolAddress;
    let borrowAmount0 = 0n; // WETH amount
    let borrowAmount1 = 0n; // USDC amount
    let tokenBorrowedAddress;
    let tokenIntermediateAddress;
    let poolAForSwap; // Address of pool for Swap 1 in callback
    let poolBForSwap; // Address of pool for Swap 2 in callback
    let feeAForSwap;  // Fee (bps) for Swap 1
    let feeBForSwap;  // Fee (bps) for Swap 2
    let amountToBorrowWei;

    // WETH is Token0, USDC is Token1 in these pools
    if (opportunity.borrowTokenSymbol === 'WETH') {
        tokenBorrowedAddress = WETH_ADDRESS; // Checksummed
        tokenIntermediateAddress = USDC_ADDRESS; // Checksummed
        amountToBorrowWei = BORROW_AMOUNT_WETH_WEI;
        borrowAmount0 = amountToBorrowWei;
        borrowAmount1 = 0n;
        if (opportunity.startPool === 'A') {
            flashLoanPoolAddress = opportunity.poolA.address; // Lowercase OK here
            poolAForSwap = opportunity.poolA.address; // Lowercase OK here
            feeAForSwap = opportunity.poolA.feeBps;
            poolBForSwap = opportunity.poolB.address; // Lowercase OK here
            feeBForSwap = opportunity.poolB.feeBps;
        } else {
            flashLoanPoolAddress = opportunity.poolB.address; // Lowercase OK here
            poolAForSwap = opportunity.poolB.address; // Lowercase OK here
            feeAForSwap = opportunity.poolB.feeBps;
            poolBForSwap = opportunity.poolA.address; // Lowercase OK here
            feeBForSwap = opportunity.poolA.feeBps;
        }
    } else {
        console.error("Borrowing USDC path not fully implemented yet. Exiting attempt.");
        return;
    }

    console.log(`  Executing Path: Borrow ${ethers.formatUnits(amountToBorrowWei, tokenBorrowedAddress === WETH_ADDRESS ? WETH_DECIMALS : USDC_DECIMALS)} ${opportunity.borrowTokenSymbol} from ${flashLoanPoolAddress}`);
    console.log(`    -> Swap 1 on ${poolAForSwap} (Fee: ${feeAForSwap}bps)`);
    console.log(`    -> Swap 2 on ${poolBForSwap} (Fee: ${feeBForSwap}bps)`);

    // --- Pool State Check ---
    try {
        // Use the correct contract instance based on lowercase address comparison
        const flashLoanPoolContract = flashLoanPoolAddress.toLowerCase() === POOL_A_ADDRESS.toLowerCase() ? poolAContract : poolBContract;
        const [slot0, liquidity] = await Promise.all([
            flashLoanPoolContract.slot0(),
            flashLoanPoolContract.liquidity()
        ]);
        console.log(`  Flash Loan Pool Status (${flashLoanPoolAddress}):`);
        console.log(`    Current Tick: ${slot0.tick}`);
        console.log(`    Active Liquidity: ${liquidity.toString()}`);
         if (liquidity === 0n) console.warn(`    WARNING: Flash loan pool has ZERO active liquidity!`);
         else if (liquidity < 10n**15n) console.warn(`    WARNING: Flash loan pool has very LOW active liquidity!`);
    } catch (err) {
        console.error(`  Error fetching state for pool ${flashLoanPoolAddress}:`, err.message);
    }

    // --- Construct Callback Params ---
    const arbitrageParams = {
        tokenIntermediate: tokenIntermediateAddress, // Checksummed
        poolA: poolAForSwap, // Lowercase OK for params
        poolB: poolBForSwap, // Lowercase OK for params
        feeA: feeAForSwap,
        feeB: feeBForSwap,
        amountOutMinimum1: 0n,
        amountOutMinimum2: 0n
    };
    const encodedParams = ethers.AbiCoder.defaultAbiCoder().encode(
        ['tuple(address tokenIntermediate, address poolA, address poolB, uint24 feeA, uint24 feeB, uint amountOutMinimum1, uint amountOutMinimum2)'],
        [arbitrageParams]
    );
    console.log("  Callback Parameters (Decoded):", { /* ... logging ... */ });
    console.log("  Callback Parameters (Encoded):", encodedParams);

    // --- initiateFlashSwap Args ---
    const initiateFlashSwapArgs = [
        flashLoanPoolAddress, // Lowercase OK here
        borrowAmount0,
        borrowAmount1,
        encodedParams
    ];

    // --- staticCall / estimateGas / Send ---
    try {
        console.log("  [1/3] Attempting staticCall simulation...");
        // Pass lowercase pool address is fine for the first arg
        await flashSwapContract.initiateFlashSwap.staticCall(
            ...initiateFlashSwapArgs, { gasLimit: 3_000_000 }
        );
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
         // if (staticCallError.data) console.error(`     Revert Data: ${staticCallError.data}`);
    }
    console.log("========= Arbitrage Attempt Complete =========");
} // End attemptArbitrage


// --- Main Monitoring Loop ---
async function monitorPools() {
    console.log(`\n${new Date().toISOString()} - Checking for opportunities...`);
    try {
        // Fetch pool states - using lowercase addresses now
        console.log("  Fetching pool states...");
        const [slotA, liqA, slotB, liqB] = await Promise.all([
            poolAContract.slot0().catch(e => { console.error(`Error fetching slot0 for Pool A (${POOL_A_ADDRESS}): ${e.message}`); return null; }),
            poolAContract.liquidity().catch(e => { console.error(`Error fetching liquidity for Pool A (${POOL_A_ADDRESS}): ${e.message}`); return null; }),
            poolBContract.slot0().catch(e => { console.error(`Error fetching slot0 for Pool B (${POOL_B_ADDRESS}): ${e.message}`); return null; }),
            poolBContract.liquidity().catch(e => { console.error(`Error fetching liquidity for Pool B (${POOL_B_ADDRESS}): ${e.message}`); return null; })
        ]);

        // Log pool states
        if (slotA && liqA !== null) {
             console.log(`  Pool A (${POOL_A_ADDRESS} - ${POOL_A_FEE_BPS}bps): Tick=${slotA.tick}, Liquidity=${liqA.toString()}`);
             if (liqA === 0n) console.warn("    WARNING: Pool A has ZERO active liquidity!");
        } else {
             console.log(`  Pool A (${POOL_A_ADDRESS} - ${POOL_A_FEE_BPS}bps): Failed to fetch state.`);
        }
        if (slotB && liqB !== null) {
             console.log(`  Pool B (${POOL_B_ADDRESS} - ${POOL_B_FEE_BPS}bps): Tick=${slotB.tick}, Liquidity=${liqB.toString()}`);
              if (liqB === 0n) console.warn("    WARNING: Pool B has ZERO active liquidity!");
        } else {
              console.log(`  Pool B (${POOL_B_ADDRESS} - ${POOL_B_FEE_BPS}bps): Failed to fetch state.`);
        }
        if (!slotA || liqA === null || !slotB || liqB === null) {
            console.log("  Could not fetch state for both pools. Skipping simulation cycle.");
            return;
        }

        // Simulate swaps
        const simulateAmountWeth = ethers.parseUnits("0.1", WETH_DECIMALS);
        console.log("  Simulating swaps with QuoterV2...");
        const [amountOutA, amountOutB] = await Promise.all([
            simulateSwap("Pool A", WETH_ADDRESS, USDC_ADDRESS, simulateAmountWeth, POOL_A_FEE_BPS, quoterContract),
            simulateSwap("Pool B", WETH_ADDRESS, USDC_ADDRESS, simulateAmountWeth, POOL_B_FEE_BPS, quoterContract)
        ]);

        if (amountOutA === 0n || amountOutB === 0n) {
             console.log("  Failed to get valid quotes for one or both pools. Skipping cycle.");
             return;
        }

        // --- Rest of the loop logic ... ---
        const priceA = parseFloat(ethers.formatUnits(amountOutA, USDC_DECIMALS)) / 0.1;
        const priceB = parseFloat(ethers.formatUnits(amountOutB, USDC_DECIMALS)) / 0.1;
        console.log(`  Pool A Price (USDC/WETH): ${priceA.toFixed(6)}`);
        console.log(`  Pool B Price (USDC/WETH): ${priceB.toFixed(6)}`);
        // ... opportunity detection ...
        // ... profit check ...
        // ... call attemptArbitrage ...


    } catch (error) {
        console.error(`${new Date().toISOString()} - Error in monitoring loop:`, error);
    } finally {
        // setInterval handles next call
    }
} // End monitorPools function

// --- Start the Bot ---
(async () => {
    try {
        console.log(`Signer Address: ${signer.address}`);
        const contractOwner = await flashSwapContract.owner();
        if (contractOwner.toLowerCase() !== signer.address.toLowerCase()) {
             console.warn(`\nWarning: Signer address (${signer.address}) does not match FlashSwap owner (${contractOwner}). 'onlyOwner' calls will fail.\n`);
         } else {
             console.log(`Signer matches contract owner. 'onlyOwner' calls should succeed.\n`);
         }
        await monitorPools(); // First run
        setInterval(monitorPools, POLLING_INTERVAL_MS); // Subsequent runs
        console.log(`\nMonitoring started. Will check every ${POLLING_INTERVAL_MS / 1000} seconds.`);
    } catch (initError) {
        console.error("Initialization Error:", initError);
        process.exit(1);
    }
})();
