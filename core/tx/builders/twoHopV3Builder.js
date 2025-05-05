// core/tx/builders/twoHopV3Builder.js
// Builds parameters for the initiateFlashSwap (V3 -> V3 two-hop) function.
// Includes the titheRecipient address.
// Adjusts validation to handle zero minimum output during GasEstimator's minimal calldata encoding.
// --- VERSION v1.5 --- Corrected simulationResult property names check in validation.

const { ethers } = require('ethers');
const logger = require('../../../utils/logger'); // Adjust path
const { ArbitrageError } = require('../../../utils/errorHandler'); // Adjust path
const { calculateMinAmountOut } = require('../../profitCalcUtils'); // Import from profitCalcUtils

/**
 * Builds parameters for the initiateFlashSwap (V3 -> V3 two-hop) function.
 * Includes the titheRecipient address.
 * Adjusts validation to handle minimal simulation results (where amounts are 0n or 1n for estimateGas).
 * @param {object} opportunity The opportunity object.
 * @param {object} simulationResult The result from the SwapSimulator ({ initialAmount: bigint, hop1AmountOutSimulated: bigint, finalAmountSimulated: bigint }).
 * @param {object} config The application configuration object.
 * @param {string} titheRecipient The wallet address to send the tithe to.
 * @returns {{ params: object, borrowTokenAddress: string, borrowAmount: bigint, typeString: string, contractFunctionName: string }}
 * @throws {ArbitrageError}
 */
function buildTwoHopParams(opportunity, simulationResult, config, titheRecipient) {
    const functionSig = `[Builder TwoHopV3 v1.5]`; // Updated version
    logger.debug(`${functionSig} Building parameters...`);

    // Validation (remains unchanged)
    if (!opportunity || opportunity.type !== 'spatial' || !opportunity.path || opportunity.path.length !== 2) { throw new ArbitrageError('Invalid spatial opportunity for V3->V3 param build.', 'PARAM_BUILD_ERROR'); }
    if (opportunity.path[0].dex !== 'uniswapV3' || opportunity.path[1].dex !== 'uniswapV3') { throw new ArbitrageError('Opportunity path is not V3->V3.', 'PARAM_BUILD_ERROR'); }
    if (!opportunity.tokenIn || !opportunity.tokenIntermediate) { throw new ArbitrageError('Missing tokenIn or tokenIntermediate in V3->V3 opportunity.', 'PARAM_BUILD_ERROR'); }

    // --- Corrected simulationResult structure check ---
    // Check for the corrected property names used by SwapSimulator/ProfitCalculator
    if (!simulationResult || typeof simulationResult.initialAmount !== 'bigint' || typeof simulationResult.hop1AmountOutSimulated !== 'bigint' || typeof simulationResult.finalAmountSimulated !== 'bigint') {
        logger.error(`${functionSig} Invalid simulationResult structure:`, simulationResult);
        throw new ArbitrageError('Invalid simulationResult structure for V3->V3 param build.', 'PARAM_BUILD_ERROR');
    }
    // --- End corrected check ---

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

    // --- Corrected property names when pulling from simulationResult ---
    const hop1AmountOutSimulated = simulationResult.hop1AmountOutSimulated; // Amount of tokenIntermediate received after first hop
    const hop2AmountOutSimulated = simulationResult.finalAmountSimulated; // Amount of tokenBorrowed received after second hop
    // --- End corrected property names ---


    // Calculate minimum amounts out for slippage
    // These are used in the FlashSwap contract to ensure transaction doesn't result in too little output.
    const minAmountOut1 = calculateMinAmountOut(hop1AmountOutSimulated, config.SLIPPAGE_TOLERANCE_BPS);
    const minAmountOut2 = calculateMinAmountOut(hop2AmountOutSimulated, config.SLIPPAGE_TOLERANCE_BPS);

    logger.debug(`${functionSig} Hop1: Sim Out=${ethers.formatUnits(hop1AmountOutSimulated, tokenIntermediate.decimals)}, Min Out=${ethers.formatUnits(minAmountOut1, tokenIntermediate.decimals)} (${tokenIntermediate.symbol})`);
    logger.debug(`${functionSig} Hop2: Sim Out=${ethers.formatUnits(hop2AmountOutSimulated, tokenBorrowed.decimals)}, Min Out=${ethers.formatUnits(minAmountOut2, tokenBorrowed.decimals)} (${tokenBorrowed.symbol})`);


    // --- MODIFIED VALIDATION LOGIC ---
    // Check if simulationResult.finalAmountSimulated is 0n AND initialAmount is 1n.
    // This pattern (1n initial, 0n intermediates/final) is characteristic of the minimal sim result used by the GasEstimator.
    // In this specific case, we should NOT throw an error if min amounts out are zero.
    // CORRECTED: Use finalAmountSimulated in the check
    const isMinimalGasEstimateSim = (simulationResult.initialAmount === 1n && simulationResult.finalAmountSimulated === 0n); // Corrected property name

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
         // For minimal simulation, ensure minOuts are at least 1n if the sim result was > 0n, to avoid issues with estimateGas on some providers/contracts
         // If hop amounts were 1n in minimal sim, minOut should also be 1n.
         // If hop amounts were 0n in minimal sim, minOut should be 0n.
         // This ensures minOuts match the minimal simulation outputs provided.
         // Re-calculate minOuts using 0% slippage for the minimal sim inputs (1n or 0n)
         const minAmountOut1_minimal = calculateMinAmountOut(hop1AmountOutSimulated, 0); // 0% slippage
         const minAmountOut2_minimal = calculateMinAmountOut(hop2AmountOutSimulated, 0); // 0% slippage
         logger.debug(`${functionSig} For minimal sim, setting minAmountOut1 to ${minAmountOut1_minimal} and minAmountOut2 to ${minAmountOut2_minimal}.`);
         // Override the min amounts calculated with slippage for the minimal sim case
         // We need to return the params object with these specific minimal minOuts
         // The params object is constructed below, so we'll use these minimal values there.
         // Keep the original minAmountOut1/2 variables for non-minimal sim cases.
    }
    // --- END MODIFIED VALIDATION LOGIC ---


    // Prepare parameters object matching the Solidity struct `TwoHopParams`
    const params = {
        tokenIntermediate: tokenIntermediate.address, // Address of the intermediate token (T0)
        feeA: feeA, // Fee tier for the first hop (T1->T0)
        feeB: feeB, // Fee tier for the second hop (T0->T1)
        // --- Use minimal minOuts for the minimal sim case, otherwise use slippage-adjusted ones ---
        amountOutMinimum1: isMinimalGasEstimateSim ? calculateMinAmountOut(hop1AmountOutSimulated, 0) : minAmountOut1,
        amountOutMinimum2: isMinimalGasEstimateSim ? calculateMinAmountOut(hop2AmountOutSimulated, 0) : minAmountOut2,
        // --- End use of minimal minOuts ---
        titheRecipient: titheRecipient // Wallet address to send the tithe to
    };

    // Define the struct type string for encoding. Must exactly match the struct in FlashSwap.sol
    const typeString = "tuple(address tokenIntermediate, uint24 feeA, uint24 feeB, uint256 amountOutMinimum1, uint256 amountOutMinimum2, address titheRecipient)";
    const contractFunctionName = 'initiateUniswapV3FlashLoan'; // CORRECTED: Use the actual function name

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
