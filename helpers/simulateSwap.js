// helpers/simulateSwap.js
const { ethers } = require('ethers'); // For formatUnits if needed in logging

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
        sqrtPriceLimitX96: 0n // 0n for BigInt zero literal in ethers v6
    };

    // Use minimal logging inside this helper
    // console.log(`  [Quoter Sim - ${poolDesc}] Params:`, JSON.stringify(params, (key, value) =>
    //     typeof value === 'bigint' ? value.toString() : value // Convert BigInts for logging
    // ));

    try {
        // estimateGas does not return a value on success, it just doesn't throw.
        // We need to provide overrides if the function is payable, but QuoterV2 isn't typically.
        // We add a gasLimit override just in case, to prevent infinite loops on reverts.
        await quoterContract.quoteExactInputSingle.estimateGas(params, { gasLimit: 1_000_000 }); // Set a reasonable gas limit for simulation
        // console.log(`  [Quoter Sim - ${poolDesc}] SUCCESS (Simulation likely ok)`);
        return true; // Simulation succeeded
    } catch (error) {
        // Log the error reason concisely
        // console.error(`  [Quoter Sim - ${poolDesc}] FAILED: ${error.reason || error.message}`);
        // Optional: More detailed logging for debugging specific simulation failures
        // if (error.data) console.error(`    Data: ${error.data}`);
        return false; // Simulation failed
    }
}

module.exports = { simulateSwap };
