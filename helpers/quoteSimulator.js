// helpers/quoteSimulator.js
const { ethers } = require("ethers");

/**
 * Simulate a single exactInput swap using Uniswap V3 QuoterV2
 * @returns { success, amountOut, gasEstimate, ticksCrossed, reason, rawData }
 */
async function tryQuote({ tokenIn, tokenOut, amountIn, fee, quoter }) {
  const params = {
    tokenIn,
    tokenOut,
    amountIn,
    fee,
    sqrtPriceLimitX96: 0n
  };
  try {
    // Use callStatic for read-only quote calls in ethers v6
    const result = await quoter.quoteExactInputSingle.staticCall(params);
    return {
      success: true,
      amountOut: result.amountOut,
      gasEstimate: result.gasEstimate, // Note: This is Quoter's estimate, not full tx gas
      ticksCrossed: result.initializedTicksCrossed
    };
  } catch (err) {
    // Try decoding error data if possible
    let reason = err.reason || err.message;
    if (!reason && err.data && err.data !== '0x') {
        try {
            const decodedError = quoter.interface.parseError(err.data);
            reason = `${decodedError?.name}(${decodedError?.args})` || reason;
        } catch (decodeErr) {
             // Ignore if can't decode, keep original reason
        }
    }
    return {
      success: false,
      reason: reason,
      rawData: err.data || null
    };
  }
}

module.exports = {
  tryQuote
};
