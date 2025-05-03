// core/tx/builders/twoHopV3Builder.js
// --- VERSION v1.3 --- Modified validation to allow zero minimum output during GasEstimator's minimal calldata encoding.

const { ethers } = require('ethers');
const logger = require('../../../utils/logger'); // Adjust path
const { ArbitrageError } = require('../../../utils/errorHandler'); // Adjust path
const { calculateMinAmountOut } = require('../../profitCalcUtils'); // Import from profitCalcUtils

/**
 * Builds parameters for the initiateFlashSwap (V3 -> V3 two-hop) function.
 * Includes the titheRecipient address.
 * Adjusts validation to handle minimal simulation results (where amounts are 0n)
 * when called by the GasEstimator for `estimateGas` check encoding.
 */
function buildTwoHopParams(opportunity, simulationResult, config, titheRecipient) {
    const functionSig = `[Builder TwoHopV3 v1.3]`; // Updated version
    logger.debug(`${functionSig} Building parameters...`);

    // Validation (remains unchanged)
    if (!opportunity || opportunity.type !== 'spatial' || !opportunity.path || opportunity.path.length !== 2) { throw new ArbitrageError('Invalid spatial opportunity for V3->V3 param build.', 'PARAM_BUILD_ERROR'); }
    if (opportunity.path[0].dex !== 'uniswapV3' || opportunity.path[1].dex !== 'uniswapV3') { throw new ArbitrageError('Opportunity path is not V3->V3.', 'PARAM_BUILD_ERROR'); }
    // simulationResult is expected to be { initialAmount: bigint, hop1AmountOut: bigint, finalAmount: bigint }
    if (!simulationResult || typeof simulationResult.initialAmount !== 'bigint' || typeof simulationResult.hop1AmountOut !== 'bigint' || typeof simulationResult.finalAmount !== 'bigint') {
        logger.error(`${functionSig} Invalid simulationResult structure:`, simulationResult);
        throw new ArbitrageError('Invalid simulationResult structure for V3->V3 param build.', 'PARAM_BUILD_ERROR');
    }
    if (!opportunity.tokenIn || !opportunity.tokenIntermediate) { throw new ArbitrageError('Missing tokenIn or tokenIntermediate in V3->V3 opportunity.', 'PARAM_BUILD_ERROR'); }
    // --- Tithe Recipient Validation ---
    if (!titheRecipient || typeof titheRecipient !== 'string' || !ethers.isAddress(titheRecipient)) {
        logger.error(`${functionSig} Invalid titheRecipient address: "${titheRecipient}"`);
        throw new ArbitrageError('Invalid titheRecipient address provided.', 'PARAM_BUILD_ERROR');
    }


    const leg1 = opportunity.path[0];
    const leg2 = opportunity.path[1];

    const tokenBorrowed = opportunity.tokenIn;
    const tokenIntermediate = opportunity.tokenIntermediate;
    const feeA = Number(leg1.fee); // Expected to be uint24 from UniV3 config, convert to Number for builder params
    const feeB = Number(leg2.fee); // Expected to be uint24 from UniV3 config, convert to Number for builder params

    // Basic fee validation
    if (isNaN(feeA) || isNaN(feeB) || feeA < 0 || feeB < 0 || feeA > 1000000 || feeB > 1000000) { throw new ArbitrageError(`Invalid V3 fees found: feeA=${feeA}, feeB=${feeB}`, 'CONFIG_ERROR'); }

    const borrowAmount = simulationResult.initialAmount; // Amount borrowed for the flash loan
    const hop1AmountOutSimulated = simulationResult.hop1AmountOut; // Amount of tokenIntermediate received after first hop
    const hop2AmountOutSimulated = simulationResult.finalAmount; // Amount of tokenBorrowed received after second hop

    // Calculate minimum amounts out for slippage
    // These are used in the FlashSwap contract to ensure transaction doesn't result in too little output.
    const minAmountOut1 = calculateMinAmountOut(hop1AmountOutSimulated, config.SLIPPAGE_TOLERANCE_BPS);
    const minAmountOut2 = calculateMinAmountOut(hop2AmountOutSimulated, config.SLIPPAGE_TOLERANCE_BPS);

    logger.debug(`${functionSig} Hop1: Sim Out=${ethers.formatUnits(hop1AmountOutSimulated, tokenIntermediate.decimals)}, Min Out=${ethers.formatUnits(minAmountOut1, tokenIntermediate.decimals)} (${tokenIntermediate.symbol})`);
    logger.debug(`${functionSig} Hop2: Sim Out=${ethers.formatUnits(hop2AmountOutSimulated, tokenBorrowed.decimals)}, Min Out=${ethers.formatUnits(minAmountOut2, tokenBorrowed.decimals)} (${tokenBorrowed.symbol})`);


    // --- MODIFIED VALIDATION LOGIC ---
    // Check if simulationResult.finalAmount is 0n AND initialAmount is 1n.
    // This pattern (1n initial, 0n intermediates/final) is characteristic of the minimal sim result used by the GasEstimator.
    // In this specific case, we should NOT throw an error if min amounts out are zero.
    const isMinimalGasEstimateSim = (simulationResult.initialAmount === 1n && simulationResult.finalAmount === 0n);

    if (!isMinimalGasEstimateSim) {
        // This is a real simulation result (not the minimal gas estimate one).
        // In this case, zero minimum output implies the trade is not viable after slippage.
        if (minAmountOut1 <= 0n || minAmountOut2 <= 0n) {
            logger.debug(`${functionSig} Calculated zero minimum amount out from simulation results. Hop1 Min=${minAmountOut1}, Hop2 Min=${minAmountOut2}. Aborting param build for execution.`);
            throw new ArbitrageError('Calculated zero minimum amount out from simulation.', 'SLIPPAGE_ERROR');
        }
    } else {
        // This is the minimal sim result used by the GasEstimator.
        // We explicitly allow min amounts to be 0n here.
        logger.debug(`${functionSig} Using minimal simulation result for gas estimation encoding. minAmountOut validation skipped.`);
    }
    // --- END MODIFIED VALIDATION LOGIC ---


    // Prepare parameters object matching the Solidity struct `TwoHopParams`
    // Note: FlashSwap.sol uses `amount0Out` and `amount1Out` in `uniswapV3SwapCallback`,
    // but the params struct here describes the path *logic*. The contract
    // figures out the exact amounts from the swap results using minAmountOuts.
    const params = {
        tokenIntermediate: tokenIntermediate.address, // Address of the intermediate token (T0)
        feeA: feeA, // Fee tier for the first hop (T1->T0)
        feeB: feeB, // Fee tier for the second hop (T0->T1)
        amountOutMinimum1: minAmountOut1, // Minimum amount of tokenIntermediate expected from first hop
        amountOutMinimum2: minAmountOut2, // Minimum amount of tokenBorrowed expected from second hop
        titheRecipient: titheRecipient // Wallet address to send the tithe to
    };

    // Define the struct type string for encoding. Must exactly match the struct in FlashSwap.sol
    const typeString = "tuple(address tokenIntermediate, uint24 feeA, uint24 feeB, uint256 amountOutMinimum1, uint256 amountOutMinimum2, address titheRecipient)";
    const contractFunctionName = 'initiateFlashSwap'; // The function in FlashSwap.sol that handles V3->V3 two-hops

    logger.debug(`${functionSig} Parameters built successfully.`);
    // Return the structured parameters, the borrowed token address, the total borrowed amount,
    // the corresponding struct type string, and the contract function name.
    return {
        params,
        borrowTokenAddress: tokenBorrowed.address, // Address of the token borrowed (T1)
        borrowAmount, // Total amount of T1 borrowed (BigInt)
        typeString, // Encoding string for the params struct
        contractFunctionName // Name of the function to call on FlashSwap.sol
    };
}


module.exports = {
    buildTwoHopParams,
    // Add other builder functions for V3 paths here if needed (e.g., triangular)
};
