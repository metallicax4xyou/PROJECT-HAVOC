// core/tx/builders/sushiV3Builder.js
// Builder placeholder for Sushi -> V3 path. WARNING: Not supported by FlashSwap.sol v3.0+.

const { ethers } = require('ethers');
const logger = require('../../../utils/logger'); // Adjust path back to utils
const { ArbitrageError } = require('../../../utils/errorHandler'); // Adjust path back to utils
const { calculateMinAmountOut } = require('../txUtils'); // Import shared helper

/**
 * Builds parameters for a Sushi -> V3 path.
 * WARNING: FlashSwap.sol v3.0+ does NOT support this path explicitly.
 * This function builds a placeholder structure that WILL LIKELY FAIL execution.
 */
function buildSushiV3Params(opportunity, simulationResult, config) {
    const functionSig = `[Builder Sushi->V3 - UNSUPPORTED]`; // Shortened prefix
    // --- WARNING ---
    logger.warn(`${functionSig} WARNING: Current FlashSwap.sol does not support Sushi->V3 path explicitly. Execution will likely fail.`);
    // --- ---
    logger.debug(`${functionSig} Building placeholder parameters...`);

     // Validation ... (as before)
    if (!opportunity || opportunity.type !== 'spatial' || !opportunity.path || opportunity.path.length !== 2) { throw new ArbitrageError('Invalid spatial opportunity for Sushi->V3 param build.', 'PARAM_BUILD_ERROR'); }
    if (opportunity.path[0].dex !== 'sushiswap' || opportunity.path[1].dex !== 'uniswapV3') { throw new ArbitrageError('Opportunity path is not Sushi->V3.', 'PARAM_BUILD_ERROR'); }
    if (!simulationResult || typeof simulationResult.initialAmount !== 'bigint' || typeof simulationResult.hop1AmountOut !== 'bigint' || typeof simulationResult.finalAmount !== 'bigint') { throw new ArbitrageError('Invalid simulationResult for Sushi->V3 param build.', 'PARAM_BUILD_ERROR'); }
    if (!opportunity.tokenIn || !opportunity.tokenIntermediate) { throw new ArbitrageError('Missing tokenIn or tokenIntermediate in Sushi->V3 opportunity.', 'PARAM_BUILD_ERROR'); }

    const leg1 = opportunity.path[0]; // Sushi Leg
    const leg2 = opportunity.path[1]; // V3 Leg

    if (!leg1?.address || !leg2?.address || leg2.fee === undefined) { throw new ArbitrageError('Missing required pool address or fee in Sushi->V3 opportunity path legs.', 'PARAM_BUILD_ERROR'); }

    const tokenBorrowed = opportunity.tokenIn;
    const tokenIntermediate = opportunity.tokenIntermediate;
    const feeHop2 = Number(leg2.fee); // V3 Fee for Hop 2

    if (isNaN(feeHop2) || feeHop2 < 0 || feeHop2 > 1000000) { throw new ArbitrageError(`Invalid V3 fee found: feeHop2=${feeHop2}`, 'CONFIG_ERROR'); }

    const borrowAmount = simulationResult.initialAmount;
    const hop1AmountOutSimulated = simulationResult.hop1AmountOut;
    const hop2AmountOutSimulated = simulationResult.finalAmount;

    const minAmountOut1 = calculateMinAmountOut(hop1AmountOutSimulated, config.SLIPPAGE_TOLERANCE_BPS);
    const minAmountOut2 = calculateMinAmountOut(hop2AmountOutSimulated, config.SLIPPAGE_TOLERANCE_BPS);

    logger.debug(`${functionSig} Hop1(Sushi): Min Out=${ethers.formatUnits(minAmountOut1, tokenIntermediate.decimals)}`);
    logger.debug(`${functionSig} Hop2(V3): Min Out=${ethers.formatUnits(minAmountOut2, tokenBorrowed.decimals)}`);

    if (minAmountOut1 <= 0n || minAmountOut2 <= 0n) { throw new ArbitrageError('Calculated zero minimum amount out (Sushi->V3), aborting.', 'SLIPPAGE_ERROR'); }

    // Prepare parameters object - USING TwoHopParams AS A PLACEHOLDER - THIS IS INCORRECT FOR CONTRACT LOGIC
    const params = {
        tokenIntermediate: tokenIntermediate.address,
        poolA: leg1.address, // Sushi pool - contract cannot handle this
        feeA: 3000,          // Placeholder fee
        poolB: leg2.address, // V3 pool
        feeB: feeHop2,
        amountOutMinimum1: minAmountOut1,
        amountOutMinimum2: minAmountOut2
    };
    // Define the struct type string - USING TwoHopParams AS PLACEHOLDER
    const typeString = "tuple(address tokenIntermediate, address poolA, uint24 feeA, address poolB, uint24 feeB, uint256 amountOutMinimum1, uint256 amountOutMinimum2)";
    // Returning function name that expects this (incorrect) struct
    const contractFunctionName = 'initiateFlashSwap';

    logger.warn(`${functionSig} Parameters built using placeholder struct. Execution will fail.`);
    return { params, borrowTokenAddress: tokenBorrowed.address, borrowAmount, typeString, contractFunctionName };
}

module.exports = {
    buildSushiV3Params,
};
