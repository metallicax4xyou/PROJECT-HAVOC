// core/tx/builders/v3SushiBuilder.js
// Builder placeholder for V3 -> Sushi path. WARNING: Not supported by FlashSwap.sol v3.0+.

const { ethers } = require('ethers');
const logger = require('../../../utils/logger'); // Adjust path back to utils
const { ArbitrageError } = require('../../../utils/errorHandler'); // Adjust path back to utils
const { calculateMinAmountOut } = require('../txUtils'); // Import shared helper

/**
 * Builds parameters for a V3 -> Sushi path.
 * WARNING: FlashSwap.sol v3.0+ does NOT support this path explicitly.
 * This function builds a placeholder structure that WILL LIKELY FAIL execution.
 */
function buildV3SushiParams(opportunity, simulationResult, config) {
    const functionSig = `[Builder V3->Sushi - UNSUPPORTED]`; // Shortened prefix
    // --- WARNING ---
    logger.warn(`${functionSig} WARNING: Current FlashSwap.sol does not support V3->Sushi path explicitly. Execution will likely fail.`);
    // --- ---
    logger.debug(`${functionSig} Building placeholder parameters...`);

    // Validation ... (as before)
    if (!opportunity || opportunity.type !== 'spatial' || !opportunity.path || opportunity.path.length !== 2) { throw new ArbitrageError('Invalid spatial opportunity for V3->Sushi param build.', 'PARAM_BUILD_ERROR'); }
    if (opportunity.path[0].dex !== 'uniswapV3' || opportunity.path[1].dex !== 'sushiswap') { throw new ArbitrageError('Opportunity path is not V3->Sushi.', 'PARAM_BUILD_ERROR'); }
    if (!simulationResult || typeof simulationResult.initialAmount !== 'bigint' || typeof simulationResult.hop1AmountOut !== 'bigint' || typeof simulationResult.finalAmount !== 'bigint') { throw new ArbitrageError('Invalid simulationResult for V3->Sushi param build.', 'PARAM_BUILD_ERROR'); }
    if (!opportunity.tokenIn || !opportunity.tokenIntermediate) { throw new ArbitrageError('Missing tokenIn or tokenIntermediate in V3->Sushi opportunity.', 'PARAM_BUILD_ERROR'); }

    const leg1 = opportunity.path[0]; // V3 Leg
    const leg2 = opportunity.path[1]; // Sushi Leg

    if (!leg1?.address || !leg2?.address || leg1.fee === undefined) { throw new ArbitrageError('Missing required pool address or fee in V3->Sushi opportunity path legs.', 'PARAM_BUILD_ERROR'); }

    const tokenBorrowed = opportunity.tokenIn;
    const tokenIntermediate = opportunity.tokenIntermediate;
    const feeHop1 = Number(leg1.fee);

    if (isNaN(feeHop1) || feeHop1 < 0 || feeHop1 > 1000000) { throw new ArbitrageError(`Invalid V3 fee found: feeHop1=${feeHop1}`, 'CONFIG_ERROR'); }

    const borrowAmount = simulationResult.initialAmount;
    const hop1AmountOutSimulated = simulationResult.hop1AmountOut;
    const hop2AmountOutSimulated = simulationResult.finalAmount;

    const minAmountOut1 = calculateMinAmountOut(hop1AmountOutSimulated, config.SLIPPAGE_TOLERANCE_BPS);
    const minAmountOut2 = calculateMinAmountOut(hop2AmountOutSimulated, config.SLIPPAGE_TOLERANCE_BPS);

    logger.debug(`${functionSig} Hop1(V3): Min Out=${ethers.formatUnits(minAmountOut1, tokenIntermediate.decimals)}`);
    logger.debug(`${functionSig} Hop2(Sushi): Min Out=${ethers.formatUnits(minAmountOut2, tokenBorrowed.decimals)}`);

    if (minAmountOut1 <= 0n || minAmountOut2 <= 0n) { throw new ArbitrageError('Calculated zero minimum amount out (V3->Sushi), aborting.', 'SLIPPAGE_ERROR'); }

    // Prepare parameters object - USING TwoHopParams AS A PLACEHOLDER - THIS IS INCORRECT FOR CONTRACT LOGIC
    const params = {
        tokenIntermediate: tokenIntermediate.address,
        poolA: leg1.address, feeA: feeHop1,
        poolB: leg2.address, // Sushi pool - contract callback cannot handle this
        feeB: 3000, // Placeholder fee
        amountOutMinimum1: minAmountOut1, amountOutMinimum2: minAmountOut2
    };
    const typeString = "tuple(address tokenIntermediate, address poolA, uint24 feeA, address poolB, uint24 feeB, uint256 amountOutMinimum1, uint256 amountOutMinimum2)";
    const contractFunctionName = 'initiateFlashSwap'; // Returning function name that expects this (incorrect) struct

    logger.warn(`${functionSig} Parameters built using placeholder struct. Execution will fail.`);
    return { params, borrowTokenAddress: tokenBorrowed.address, borrowAmount, typeString, contractFunctionName };
}

module.exports = {
    buildV3SushiParams,
};
