// core/tx/builders/v3SushiBuilder.js
// --- VERSION v1.1 --- Corrects import path for calculateMinAmountOut

const { ethers } = require('ethers');
const logger = require('../../../utils/logger'); // Adjust path
const { ArbitrageError } = require('../../../utils/errorHandler'); // Adjust path
// --- MODIFIED IMPORT PATH ---
const { calculateMinAmountOut } = require('../../profitCalcUtils'); // Import from profitCalcUtils

/**
 * Builds parameters for the initiateV3SushiFlashSwap function.
 * NOTE: This path may not be fully supported by TradeHandler yet.
 */
function buildV3SushiParams(opportunity, simulationResult, config) {
    const functionSig = `[Builder V3->Sushi v1.1]`; // Updated version
    logger.debug(`${functionSig} Building parameters...`);

     // Validation (remains unchanged)
    if (!opportunity || opportunity.type !== 'spatial' || !opportunity.path || opportunity.path.length !== 2) { throw new ArbitrageError('Invalid spatial opportunity for V3->Sushi param build.', 'PARAM_BUILD_ERROR'); }
    if (opportunity.path[0].dex !== 'uniswapV3' || opportunity.path[1].dex !== 'sushiswap') { throw new ArbitrageError('Opportunity path is not V3->Sushi.', 'PARAM_BUILD_ERROR'); }
    if (!simulationResult || typeof simulationResult.initialAmount !== 'bigint' || typeof simulationResult.hop1AmountOut !== 'bigint' || typeof simulationResult.finalAmount !== 'bigint') { throw new ArbitrageError('Invalid simulationResult for V3->Sushi param build.', 'PARAM_BUILD_ERROR'); }
    if (!opportunity.tokenIn || !opportunity.tokenIntermediate) { throw new ArbitrageError('Missing tokenIn or tokenIntermediate in V3->Sushi opportunity.', 'PARAM_BUILD_ERROR'); }

    const leg1 = opportunity.path[0];

    const tokenBorrowed = opportunity.tokenIn;
    const tokenIntermediate = opportunity.tokenIntermediate;
    const feeHop1 = Number(leg1.fee);
    const feeHop2 = 0; // Sushi fee is not part of MixedPathParams

    if (isNaN(feeHop1) || feeHop1 < 0 || feeHop1 > 1000000) { throw new ArbitrageError(`Invalid V3 fee found: feeHop1=${feeHop1}`, 'CONFIG_ERROR'); }

    const borrowAmount = simulationResult.initialAmount;
    const hop1AmountOutSimulated = simulationResult.hop1AmountOut;
    const hop2AmountOutSimulated = simulationResult.finalAmount;

    const minAmountOut1 = calculateMinAmountOut(hop1AmountOutSimulated, config.SLIPPAGE_TOLERANCE_BPS);
    const minAmountOut2 = calculateMinAmountOut(hop2AmountOutSimulated, config.SLIPPAGE_TOLERANCE_BPS);

    logger.debug(`${functionSig} Hop1 (V3): Sim Out=${ethers.formatUnits(hop1AmountOutSimulated, tokenIntermediate.decimals)}, Min Out=${ethers.formatUnits(minAmountOut1, tokenIntermediate.decimals)} (${tokenIntermediate.symbol})`);
    logger.debug(`${functionSig} Hop2 (Sushi): Sim Out=${ethers.formatUnits(hop2AmountOutSimulated, tokenBorrowed.decimals)}, Min Out=${ethers.formatUnits(minAmountOut2, tokenBorrowed.decimals)} (${tokenBorrowed.symbol})`);

    if (minAmountOut1 <= 0n || minAmountOut2 <= 0n) { throw new ArbitrageError('Calculated zero minimum amount out (V3->Sushi), aborting.', 'SLIPPAGE_ERROR'); }

    // Prepare parameters object matching the Solidity struct `MixedPathParams`
    const params = {
        tokenIntermediate: tokenIntermediate.address,
        feeHop1: feeHop1,
        amountOutMinimum1: minAmountOut1,
        feeHop2: feeHop2, // Set to 0 as placeholder
        amountOutMinimum2: minAmountOut2
    };

    // Define the struct type string for encoding
    const typeString = "tuple(address tokenIntermediate, uint24 feeHop1, uint256 amountOutMinimum1, uint24 feeHop2, uint256 amountOutMinimum2)";
    const contractFunctionName = 'initiateV3SushiFlashSwap'; // Specific function for V3->Sushi

    logger.debug(`${functionSig} Parameters built successfully.`);
    return { params, borrowTokenAddress: tokenBorrowed.address, borrowAmount, typeString, contractFunctionName };
}


module.exports = {
    buildV3SushiParams,
};
