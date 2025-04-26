// core/tx/builders/twoHopV3Builder.js
// --- VERSION v1.1 --- Corrects import path for calculateMinAmountOut

const { ethers } = require('ethers');
const logger = require('../../../utils/logger'); // Adjust path
const { ArbitrageError } = require('../../../utils/errorHandler'); // Adjust path
// --- MODIFIED IMPORT PATH ---
const { calculateMinAmountOut } = require('../../profitCalcUtils'); // Import from profitCalcUtils

/**
 * Builds parameters for the initiateFlashSwap (V3 -> V3 two-hop) function.
 */
function buildTwoHopParams(opportunity, simulationResult, config) {
    const functionSig = `[Builder TwoHopV3 v1.1]`; // Updated version
    logger.debug(`${functionSig} Building parameters...`);

    // Validation (remains unchanged)
    if (!opportunity || opportunity.type !== 'spatial' || !opportunity.path || opportunity.path.length !== 2) { throw new ArbitrageError('Invalid spatial opportunity for V3->V3 param build.', 'PARAM_BUILD_ERROR'); }
    if (opportunity.path[0].dex !== 'uniswapV3' || opportunity.path[1].dex !== 'uniswapV3') { throw new ArbitrageError('Opportunity path is not V3->V3.', 'PARAM_BUILD_ERROR'); }
    if (!simulationResult || typeof simulationResult.initialAmount !== 'bigint' || typeof simulationResult.hop1AmountOut !== 'bigint' || typeof simulationResult.finalAmount !== 'bigint') { throw new ArbitrageError('Invalid simulationResult for V3->V3 param build.', 'PARAM_BUILD_ERROR'); }
    if (!opportunity.tokenIn || !opportunity.tokenIntermediate) { throw new ArbitrageError('Missing tokenIn or tokenIntermediate in V3->V3 opportunity.', 'PARAM_BUILD_ERROR'); }

    const leg1 = opportunity.path[0];
    const leg2 = opportunity.path[1];

    const tokenBorrowed = opportunity.tokenIn;
    const tokenIntermediate = opportunity.tokenIntermediate;
    const feeA = Number(leg1.fee);
    const feeB = Number(leg2.fee);

    if (isNaN(feeA) || isNaN(feeB) || feeA < 0 || feeB < 0 || feeA > 1000000 || feeB > 1000000) { throw new ArbitrageError(`Invalid V3 fees found: feeA=${feeA}, feeB=${feeB}`, 'CONFIG_ERROR'); }

    const borrowAmount = simulationResult.initialAmount;
    const hop1AmountOutSimulated = simulationResult.hop1AmountOut;
    const hop2AmountOutSimulated = simulationResult.finalAmount;

    const minAmountOut1 = calculateMinAmountOut(hop1AmountOutSimulated, config.SLIPPAGE_TOLERANCE_BPS);
    const minAmountOut2 = calculateMinAmountOut(hop2AmountOutSimulated, config.SLIPPAGE_TOLERANCE_BPS);

    logger.debug(`${functionSig} Hop1: Sim Out=${ethers.formatUnits(hop1AmountOutSimulated, tokenIntermediate.decimals)}, Min Out=${ethers.formatUnits(minAmountOut1, tokenIntermediate.decimals)} (${tokenIntermediate.symbol})`);
    logger.debug(`${functionSig} Hop2: Sim Out=${ethers.formatUnits(hop2AmountOutSimulated, tokenBorrowed.decimals)}, Min Out=${ethers.formatUnits(minAmountOut2, tokenBorrowed.decimals)} (${tokenBorrowed.symbol})`);

    if (minAmountOut1 <= 0n || minAmountOut2 <= 0n) { throw new ArbitrageError('Calculated zero minimum amount out (V3->V3), aborting.', 'SLIPPAGE_ERROR'); }

    // Prepare parameters object matching the Solidity struct `TwoHopParams`
    const params = {
        tokenIntermediate: tokenIntermediate.address,
        feeA: feeA,
        feeB: feeB,
        amountOutMinimum1: minAmountOut1,
        amountOutMinimum2: minAmountOut2
    };

    // Define the struct type string for encoding
    const typeString = "tuple(address tokenIntermediate, uint24 feeA, uint24 feeB, uint256 amountOutMinimum1, uint256 amountOutMinimum2)";
    const contractFunctionName = 'initiateFlashSwap'; // Function for V3->V3

    logger.debug(`${functionSig} Parameters built successfully.`);
    return { params, borrowTokenAddress: tokenBorrowed.address, borrowAmount, typeString, contractFunctionName };
}


module.exports = {
    buildTwoHopParams,
};
