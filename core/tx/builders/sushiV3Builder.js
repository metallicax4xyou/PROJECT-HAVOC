// core/tx/builders/sushiV3Builder.js
// --- VERSION v1.1 --- Corrects import path for calculateMinAmountOut

const { ethers } = require('ethers');
const logger = require('../../../utils/logger'); // Adjust path
const { ArbitrageError } = require('../../../utils/errorHandler'); // Adjust path
// --- MODIFIED IMPORT PATH ---
const { calculateMinAmountOut } = require('../../profitCalcUtils'); // Import from profitCalcUtils

/**
 * Builds parameters for the initiateSushiV3FlashSwap function.
 * NOTE: This path may not be fully supported by TradeHandler yet.
 */
function buildSushiV3Params(opportunity, simulationResult, config) {
    const functionSig = `[Builder Sushi->V3 v1.1]`; // Updated version
    logger.debug(`${functionSig} Building parameters...`);

     // Validation (remains unchanged)
    if (!opportunity || opportunity.type !== 'spatial' || !opportunity.path || opportunity.path.length !== 2) { throw new ArbitrageError('Invalid spatial opportunity for Sushi->V3 param build.', 'PARAM_BUILD_ERROR'); }
    if (opportunity.path[0].dex !== 'sushiswap' || opportunity.path[1].dex !== 'uniswapV3') { throw new ArbitrageError('Opportunity path is not Sushi->V3.', 'PARAM_BUILD_ERROR'); }
    if (!simulationResult || typeof simulationResult.initialAmount !== 'bigint' || typeof simulationResult.hop1AmountOut !== 'bigint' || typeof simulationResult.finalAmount !== 'bigint') { throw new ArbitrageError('Invalid simulationResult for Sushi->V3 param build.', 'PARAM_BUILD_ERROR'); }
    if (!opportunity.tokenIn || !opportunity.tokenIntermediate) { throw new ArbitrageError('Missing tokenIn or tokenIntermediate in Sushi->V3 opportunity.', 'PARAM_BUILD_ERROR'); }

    const leg2 = opportunity.path[1]; // V3 Leg

    const tokenBorrowed = opportunity.tokenIn;
    const tokenIntermediate = opportunity.tokenIntermediate;
    const feeHop1 = 0; // Sushi fee is not part of MixedPathParams
    const feeHop2 = Number(leg2.fee); // V3 Fee for Hop 2

    if (isNaN(feeHop2) || feeHop2 < 0 || feeHop2 > 1000000) { throw new ArbitrageError(`Invalid V3 fee found: feeHop2=${feeHop2}`, 'CONFIG_ERROR'); }

    const borrowAmount = simulationResult.initialAmount;
    const hop1AmountOutSimulated = simulationResult.hop1AmountOut;
    const hop2AmountOutSimulated = simulationResult.finalAmount;

    const minAmountOut1 = calculateMinAmountOut(hop1AmountOutSimulated, config.SLIPPAGE_TOLERANCE_BPS);
    const minAmountOut2 = calculateMinAmountOut(hop2AmountOutSimulated, config.SLIPPAGE_TOLERANCE_BPS);

    logger.debug(`${functionSig} Hop1 (Sushi): Sim Out=${ethers.formatUnits(hop1AmountOutSimulated, tokenIntermediate.decimals)}, Min Out=${ethers.formatUnits(minAmountOut1, tokenIntermediate.decimals)} (${tokenIntermediate.symbol})`);
    logger.debug(`${functionSig} Hop2 (V3): Sim Out=${ethers.formatUnits(hop2AmountOutSimulated, tokenBorrowed.decimals)}, Min Out=${ethers.formatUnits(minAmountOut2, tokenBorrowed.decimals)} (${tokenBorrowed.symbol})`);

    if (minAmountOut1 <= 0n || minAmountOut2 <= 0n) { throw new ArbitrageError('Calculated zero minimum amount out (Sushi->V3), aborting.', 'SLIPPAGE_ERROR'); }

    // Prepare parameters object matching the Solidity struct `MixedPathParams`
    const params = {
        tokenIntermediate: tokenIntermediate.address,
        feeHop1: feeHop1, // Set to 0 as placeholder
        amountOutMinimum1: minAmountOut1,
        feeHop2: feeHop2,
        amountOutMinimum2: minAmountOut2
    };

    // Define the struct type string for encoding
    const typeString = "tuple(address tokenIntermediate, uint24 feeHop1, uint256 amountOutMinimum1, uint24 feeHop2, uint256 amountOutMinimum2)";
    const contractFunctionName = 'initiateSushiV3FlashSwap'; // Specific function for Sushi->V3

    logger.debug(`${functionSig} Parameters built successfully.`);
    return { params, borrowTokenAddress: tokenBorrowed.address, borrowAmount, typeString, contractFunctionName };
}


module.exports = {
    buildSushiV3Params,
};
