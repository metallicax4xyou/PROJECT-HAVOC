// core/tx/builders/twoHopV3Builder.js
// Builder for initiateFlashSwap (V3 -> V3 two-hop) function params.

const { ethers } = require('ethers');
const logger = require('../../../utils/logger'); // Adjust path back to utils
const { ArbitrageError } = require('../../../utils/errorHandler'); // Adjust path back to utils
const { calculateMinAmountOut } = require('../txUtils'); // Import shared helper

/**
 * Builds parameters for the initiateFlashSwap (V3 -> V3 two-hop) function.
 * STRUCTURE UPDATED TO MATCH FlashSwap.sol v3.0+ (TwoHopParams struct)
 * @param {object} opportunity The spatial opportunity object from spatialFinder.
 * @param {object} simulationResult Result from SwapSimulator ({ initialAmount, hop1AmountOut, finalAmount }).
 * @param {object} config The application config object (needed for SLIPPAGE).
 * @returns {{ params: object, borrowTokenAddress: string, borrowAmount: bigint, typeString: string, contractFunctionName: string }}
 */
function buildTwoHopParams(opportunity, simulationResult, config) {
    const functionSig = `[Builder TwoHopV3]`; // Shortened prefix
    logger.debug(`${functionSig} Building parameters...`);

    // Validation
    if (!opportunity || opportunity.type !== 'spatial' || !opportunity.path || opportunity.path.length !== 2) {
        throw new ArbitrageError('Invalid spatial opportunity for V3->V3 param build.', 'PARAM_BUILD_ERROR');
    }
    if (opportunity.path[0].dex !== 'uniswapV3' || opportunity.path[1].dex !== 'uniswapV3') {
        throw new ArbitrageError('Opportunity path is not V3->V3.', 'PARAM_BUILD_ERROR');
    }
    if (!simulationResult || typeof simulationResult.initialAmount !== 'bigint' || typeof simulationResult.hop1AmountOut !== 'bigint' || typeof simulationResult.finalAmount !== 'bigint') {
        throw new ArbitrageError('Invalid simulationResult for V3->V3 param build.', 'PARAM_BUILD_ERROR');
    }
    if (!opportunity.tokenIn || !opportunity.tokenIntermediate) {
         throw new ArbitrageError('Missing tokenIn or tokenIntermediate in V3->V3 opportunity.', 'PARAM_BUILD_ERROR');
    }

    const leg1 = opportunity.path[0];
    const leg2 = opportunity.path[1];

    // Validate essential pool info needed for params
    if (!leg1?.address || !leg2?.address || leg1.fee === undefined || leg2.fee === undefined) {
         throw new ArbitrageError('Missing required pool address or fee in V3->V3 opportunity path legs.', 'PARAM_BUILD_ERROR');
    }

    // Extract necessary info
    const tokenBorrowed = opportunity.tokenIn; // Should be SDK Token object
    const tokenIntermediate = opportunity.tokenIntermediate; // Should be SDK Token object
    const feeA = Number(leg1.fee); // V3 Fee for Hop 1
    const feeB = Number(leg2.fee); // V3 Fee for Hop 2

    if (isNaN(feeA) || isNaN(feeB) || feeA < 0 || feeB < 0 || feeA > 1000000 || feeB > 1000000) {
        throw new ArbitrageError(`Invalid V3 fees found: feeA=${feeA}, feeB=${feeB}`, 'CONFIG_ERROR');
    }

    // Amounts from simulation
    const borrowAmount = simulationResult.initialAmount;
    const hop1AmountOutSimulated = simulationResult.hop1AmountOut;
    const hop2AmountOutSimulated = simulationResult.finalAmount;

    // Calculate minimum amounts out using slippage
    const minAmountOut1 = calculateMinAmountOut(hop1AmountOutSimulated, config.SLIPPAGE_TOLERANCE_BPS);
    const minAmountOut2 = calculateMinAmountOut(hop2AmountOutSimulated, config.SLIPPAGE_TOLERANCE_BPS);

    logger.debug(`${functionSig} Hop1: Sim Out=${ethers.formatUnits(hop1AmountOutSimulated, tokenIntermediate.decimals)}, Min Out=${ethers.formatUnits(minAmountOut1, tokenIntermediate.decimals)}`);
    logger.debug(`${functionSig} Hop2: Sim Out=${ethers.formatUnits(hop2AmountOutSimulated, tokenBorrowed.decimals)}, Min Out=${ethers.formatUnits(minAmountOut2, tokenBorrowed.decimals)}`);

    if (minAmountOut1 <= 0n || minAmountOut2 <= 0n) {
        logger.error(`${functionSig} Calculated zero minimum amount out.`, { minAmountOut1, minAmountOut2 });
        throw new ArbitrageError('Calculated zero minimum amount out (V3->V3), aborting.', 'SLIPPAGE_ERROR');
    }

    // Prepare parameters object matching the Solidity struct `TwoHopParams`
    const params = {
        tokenIntermediate: tokenIntermediate.address,
        poolA: leg1.address, // Address for hop 1 pool
        feeA: feeA,
        poolB: leg2.address, // Address for hop 2 pool
        feeB: feeB,
        amountOutMinimum1: minAmountOut1,
        amountOutMinimum2: minAmountOut2
    };

    // Define the struct type string for encoding - MATCHES Solidity struct
    const typeString = "tuple(address tokenIntermediate, address poolA, uint24 feeA, address poolB, uint24 feeB, uint256 amountOutMinimum1, uint256 amountOutMinimum2)";
    // Use the generic function name expected by FlashSwap.sol for this path
    const contractFunctionName = 'initiateFlashSwap';

    logger.debug(`${functionSig} Parameters built successfully for ${contractFunctionName}.`);
    return { params, borrowTokenAddress: tokenBorrowed.address, borrowAmount, typeString, contractFunctionName };
}

module.exports = {
    buildTwoHopParams,
};
