// helpers/simulateSwap.js
const { ethers } = require('ethers'); // Keep ethers if needed for other helpers potentially

// Simulates Quoter call via estimateGas
async function simulateSwap(poolDesc, tokenIn, tokenOut, amountInWei, feeBps, quoterContract) {
    if (!quoterContract || typeof quoterContract.quoteExactInputSingle !== 'function') {
        console.error(`  [Quoter Sim - ${poolDesc}] ERROR: Invalid Quoter contract instance provided.`);
        return false;
    }

    const params = {
        tokenIn: tokenIn,
        tokenOut: tokenOut,
        amountIn: amountInWei,
        fee: feeBps,
        sqrtPriceLimitX96: 0n // Use BigInt literal 0n
    };

    // console.log(`  [Quoter Sim DEBUG - ${poolDesc}] Params:`, JSON.stringify(params, (k, v) => typeof v === 'bigint' ? v.toString() : v));

    try {
        // estimateGas only succeeds or throws, doesn't return value.
        await quoterContract.quoteExactInputSingle.estimateGas(params, { gasLimit: 1_000_000 }); // Reasonable limit for simulation
        // <<< UPDATED SUCCESS LOG >>>
        console.log(`  [Quoter Sim - ${poolDesc}] ✅ SUCCESS (estimateGas ok)`);
        return true; // Simulation succeeded
    } catch (error) {
        // <<< UPDATED FAILURE LOG >>>
        // Log concise reason first
        console.error(`  [Quoter Sim - ${poolDesc}] ❌ FAILED: ${error.reason || error.message}`);
        // Optional: Log more details if available, useful for debugging reverts
        // if (error.data && error.data !== '0x') console.error(`    Data: ${error.data}`);
        // if (error.stack) console.error(`    Stack: ${error.stack}`); // Might be too verbose
        return false; // Simulation failed
    }
}

module.exports = { simulateSwap };
