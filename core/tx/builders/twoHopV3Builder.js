// core/tx/builders/twoHopV3Builder.js
// Builds parameters for the initiateFlashSwap (V3 -> V3 two-hop) function.
// Includes the titheRecipient address.
// Correctly handles minimal simulation results for GasEstimator encoding.
// --- VERSION v1.6 --- Restructured minOut calculation/validation for minimal sim.

const { ethers } = require('ethers');
const logger = require('../../../utils/logger'); // Adjust path
const { ArbitrageError } = require('../../../utils/errorHandler'); // Adjust path
const { calculateMinAmountOut } = require('../../profitCalcUtils'); // Import from profitCalcUtils

/**
 * Builds parameters for the initiateUniswapV3FlashLoan function.
 * Includes the titheRecipient address.
 * Correctly handles minimal simulation results for GasEstimator encoding vs. full simulation results for execution.
 * @param {object} opportunity The opportunity object.
 * @param {object} simulationResult The result from the SwapSimulator ({ initialAmount: bigint, hop1AmountOutSimulated: bigint, finalAmountSimulated: bigint }).
 * @param {object} config The application configuration object.
 * @param {string} titheRecipient The wallet address to send the tithe to.
 * @returns {{ params: object, borrowTokenAddress: string, borrowAmount: bigint, typeString: string, contractFunctionName: string }}
 * @throws {ArbitrageError}
 */
function buildTwoHopParams(opportunity, simulationResult, config, titheRecipient) {
    const functionSig = `[Builder TwoHopV3 v1.6]`; // Updated version
    logger.debug(`${functionSig} Building parameters...`);

    // Validation (remains unchanged)
    if (!opportunity || opportunity.type !== 'spatial' || !opportunity.path || opportunity.path.length !== 2) { throw new ArbitrageError('Invalid spatial opportunity for V3->V3 param build.', 'PARAM_BUILD_ERROR'); }
    if (opportunity.path[0].dex !== 'uniswapV3' || opportunity.path[1].dex !== 'uniswapV3') { throw new ArbitrageError('Opportunity path is not V3->V3.', 'PARAM_BUILD_ERROR'); }
    if (!opportunity.tokenIn || !opportunity.tokenIntermediate) { throw new ArbitrageError('Missing tokenIn or tokenIntermediate in V3->V3 opportunity.', 'PARAM_BUILD_ERROR'); }

    // --- Check simulationResult structure ---
    if (!simulationResult || typeof simulationResult.initialAmount !== 'bigint' || typeof simulationResult.hop1AmountOutSimulated !== 'bigint' || typeof simulationResult.finalAmountSimulated !== 'bigint') {
        logger.error(`${functionSig} Invalid simulationResult structure:`, simulationResult);
        throw new ArbitrageError('Invalid simulationResult structure for V3->V3 param build.', 'PARAM_BUILD_ERROR');
    }
    // --- End check ---

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


    // --- Correctly handle simulation results for real execution vs. minimal for estimateGas ---
    const isMinimalGasEstimateSim = (simulationResult.initialAmount === 1n && simulationResult.hop1AmountOutSimulated === 1n && simulationResult.finalAmountSimulated === 1n); // Define minimal case by inputs being 1n

    let minAmountOut1;
    let minAmountOut2;

    if (isMinimalGasEstimateSim) {
        // For the minimal estimateGas sim, min amounts should match the minimal outputs (1n or 0n) with 0% slippage.
        minAmountOut1 = calculateMinAmountOut(simulationResult.hop1AmountOutSimulated, 0); // Use 0% slippage for minimal sim outputs
        minAmountOut2 = calculateMinAmountOut(simulationResult.finalAmountSimulated, 0); // Use 0% slippage for minimal sim outputs
        logger.debug(`${functionSig} Using minimal sim results for minOuts (0% slippage): Hop1 Min=${minAmountOut1}, Hop2 Min=${minAmountOut2}.`);

        // No validation against zero min amounts for the minimal sim case.

    } else {
        // For a real simulation result, calculate min amounts with configured slippage.
        minAmountOut1 = calculateMinAmountOut(simulationResult.hop1AmountOutSimulated, config.SLIPPAGE_TOLERANCE_BPS);
        minAmountOut2 = calculateMinAmountOut(simulationResult.finalAmountSimulated, config.SLIPPAGE_TOLERANCE_BPS);
         logger.debug(`${functionSig} Using real sim results for minOuts (${config.SLIPPAGE_TOLERANCE_BPS}% slippage): Hop1 Min=${minAmountOut1}, Hop2 Min=${minAmountOut2}.`);


        // Validate that minimum amounts are positive for real execution scenarios.
        if (minAmountOut1 <= 0n || minAmountOut2 <= 0n) {
            logger.debug(`${functionSig} Calculated zero minimum amount out from simulation results for real execution. Hop1 Min=${minAmountOut1}, Hop2 Min=${minAmountOut2}. Aborting param build.`);
            throw new ArbitrageError('Calculated zero minimum amount out from simulation for execution.', 'SLIPPAGE_ERROR');
        }
    }
    // --- End handling of simulation results ---


    // Prepare parameters object matching the Solidity struct `TwoHopParams`
    const params = {
        tokenIntermediate: tokenIntermediate.address, // Address of the intermediate token (T0)
        feeA: feeA, // Fee tier for the first hop (T1->T0)
        feeB: feeB, // Fee tier for the second hop (T0->T1)
        // --- Use the calculated minOuts based on whether it's minimal sim or real sim ---
        amountOutMinimum1: minAmountOut1,
        amountOutMinimum2: minAmountOut2,
        // --- End use of calculated minOuts ---
        titheRecipient: titheRecipient // Wallet address to send the tithe to
    };

    // Define the struct type string for encoding. Must exactly match the struct in FlashSwap.sol
    const typeString = "tuple(address tokenIntermediate, uint24 feeA, uint24 feeB, uint256 amountOutMinimum1, uint256 amountOutMinimum2, address titheRecipient)";
    const contractFunctionName = 'initiateUniswapV3FlashLoan'; // Use the actual function name

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
