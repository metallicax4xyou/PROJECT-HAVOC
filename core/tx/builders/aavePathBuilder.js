// core/tx/builders/aavePathBuilder.js
// --- VERSION v1.1 --- Corrects minOut calc during gas estimation.

const { ethers } = require('ethers');
const logger = require('../../../utils/logger'); // Adjust path if needed
const { ArbitrageError } = require('../../../utils/errorHandler'); // Adjust path if needed
const { Token } = require('@uniswap/sdk-core'); // For type checking if needed
const { calculateMinAmountOut } = require('../../profitCalcUtils'); // Assuming helper moved here

// --- Constants for DEX Type Mapping (MUST MATCH FlashSwap.sol) ---
// Example: Adjust these values based on your Solidity implementation
const DEX_TYPE_UNISWAP_V3 = 0;
const DEX_TYPE_SUSHISWAP = 1;
const DEX_TYPE_DODO = 2;
// Add others if needed (Camelot, etc.)
// ---

/**
 * Maps DEX string identifier to numeric type for Solidity struct.
 * @param {string} dexString ('uniswapV3', 'sushiswap', 'dodo', etc.)
 * @returns {number} Numeric identifier matching FlashSwap.sol _executeSwapPath
 * @throws {ArbitrageError} If DEX type is unsupported.
 */
function mapDexType(dexString) {
    const lowerDex = dexString?.toLowerCase();
    switch (lowerDex) {
        case 'uniswapv3': return DEX_TYPE_UNISWAP_V3;
        case 'sushiswap': return DEX_TYPE_SUSHISWAP;
        case 'dodo':      return DEX_TYPE_DODO;
        // Add other supported DEXs here
        default:
            throw new ArbitrageError(`Unsupported DEX type for Aave path building: ${dexString}`, 'PARAM_BUILD_ERROR');
    }
}

/**
 * Builds parameters for the initiateAaveFlashLoan function.
 * Creates the ArbParams struct including the SwapStep array.
 * Uses amountIn from opportunity, but finalAmount from simulationResult.
 * Applies slippage only to the final amountOut for the last step's minOut.
 * Handles gas estimation mode where simulationResult provides minimal amounts.
 *
 * @param {object} opportunity The tradeData object (containing path, amountIn, tokenIn).
 * @param {object} simulationResult Contains simulation amounts { initialAmount, hop1AmountOut, finalAmount }. Used for minOut calculation.
 * @param {object} config The application config object (needed for SLIPPAGE).
 * @param {object} flashSwapManagerInstance Needed to get the initiator address.
 * @returns {{ params: object, borrowTokenAddress: string, borrowAmount: bigint, typeString: string, contractFunctionName: string }}
 * @throws {ArbitrageError} If inputs are invalid or processing fails.
 */
async function buildAavePathParams(opportunity, simulationResult, config, flashSwapManagerInstance) {
    const functionSig = `[ParamBuilder AavePath v1.1]`; // Added version
    logger.debug(`${functionSig} Building parameters...`);

    // --- Input Validation ---
    if (!opportunity?.path || !Array.isArray(opportunity.path) || opportunity.path.length === 0) { throw new ArbitrageError('Invalid or empty path in opportunity object.', 'PARAM_BUILD_ERROR', { opportunity }); }
    if (!opportunity.tokenIn?.address || !opportunity.amountIn) { throw new ArbitrageError('Missing borrow token address or amountIn in opportunity object.', 'PARAM_BUILD_ERROR', { opportunity }); }
    // Now check simulationResult for finalAmount needed for minOut calculation
    if (simulationResult?.finalAmount === undefined || simulationResult?.finalAmount === null) { throw new ArbitrageError('Missing finalAmount in simulationResult object.', 'PARAM_BUILD_ERROR', { simulationResult }); }
    if (!config?.SLIPPAGE_TOLERANCE_BPS === undefined) { throw new ArbitrageError('Missing SLIPPAGE_TOLERANCE_BPS in config.', 'CONFIG_ERROR'); }
    if (!flashSwapManagerInstance || typeof flashSwapManagerInstance.getSignerAddress !== 'function') { throw new ArbitrageError('Invalid or missing flashSwapManagerInstance.', 'PARAM_BUILD_ERROR'); }
    // --- End Validation ---

    // --- Determine Borrow Details (Use Opportunity for actual borrow amount) ---
    const borrowTokenAddress = opportunity.tokenIn.address;
    const borrowAmount = BigInt(opportunity.amountIn); // The amount we actually intend to borrow

    // --- Use finalAmount from simulationResult for slippage calculation ---
    const finalAmountSimulated = BigInt(simulationResult.finalAmount);

    // Calculate final minimum amount out (applied only to last step)
    const minAmountOutFinal = calculateMinAmountOut(finalAmountSimulated, config.SLIPPAGE_TOLERANCE_BPS);
    logger.debug(`${functionSig} Slippage Tolerance: ${config.SLIPPAGE_TOLERANCE_BPS} bps`);
    logger.debug(`${functionSig} Final Amount Simulated (from input): ${ethers.formatUnits(finalAmountSimulated, opportunity.tokenIn.decimals)} ${opportunity.tokenIn.symbol}`);
    logger.debug(`${functionSig} Min Amount Out Final (${opportunity.tokenIn.symbol}): ${ethers.formatUnits(minAmountOutFinal, opportunity.tokenIn.decimals)}`);

    // --- Adjusted Check for Zero minAmountOut ---
    // Only throw error if the *actual* simulated amount was positive but resulted in zero minOut.
    // If finalAmountSimulated was already 0 (like in gas estimation), minAmountOutFinal will also be 0, which is expected.
    if (finalAmountSimulated > 0n && minAmountOutFinal <= 0n) {
        logger.error(`${functionSig} Calculated zero minimum final amount out from a positive simulation result.`, { finalAmountSimulated, minAmountOutFinal });
        throw new ArbitrageError('Calculated zero minimum final amount out from positive simulation, aborting.', 'SLIPPAGE_ERROR', { finalAmountSimulated, minAmountOutFinal });
    } else if (finalAmountSimulated <= 0n) {
         // This is expected during gas estimation mode where minimalSimResult.finalAmount is 0n
         logger.debug(`${functionSig} Using zero minimum final amount out (likely gas estimation mode).`);
         // minAmountOutFinal will already be 0n from calculateMinAmountOut
    }
    // --- End Adjusted Check ---

    // --- Construct SwapStep[] Array ---
    const swapStepArray = [];
    for (let i = 0; i < opportunity.path.length; i++) {
        const step = opportunity.path[i];
        if (!step || !step.address || !step.tokenInAddress || !step.tokenOutAddress || !step.dex) { throw new ArbitrageError(`Invalid step structure at index ${i} in opportunity path.`, 'PARAM_BUILD_ERROR', { step }); }
        // Determine minOut for this step (0 except for last step)
        const stepMinOut = (i === opportunity.path.length - 1) ? minAmountOutFinal : 0n;
        const dexType = mapDexType(step.dex);
        let feeUint24 = 0;
        if (step.fee !== undefined && step.fee !== null) { feeUint24 = Number(step.fee); if (isNaN(feeUint24) || feeUint24 < 0 || feeUint24 > 16777215) { logger.warn(`${functionSig} Invalid fee ${step.fee} for step ${i}. Using 0.`); feeUint24 = 0; }
        } else if (step.dex === 'uniswapV3') { logger.warn(`${functionSig} Missing fee for V3 step ${i}. Using 0.`); feeUint24 = 0; }

        swapStepArray.push({
            pool: step.address, tokenIn: step.tokenInAddress, tokenOut: step.tokenOutAddress,
            fee: feeUint24, minOut: stepMinOut, dexType: dexType
        });
    }

    // --- Get Initiator Address ---
    const initiatorAddress = await flashSwapManagerInstance.getSignerAddress();

    // --- Construct ArbParams Object ---
    const params = { path: swapStepArray, initiator: initiatorAddress };

    // --- Define Type String (MUST MATCH FlashSwap.sol ArbParams struct) ---
    const swapStepTypeString = "tuple(address pool, address tokenIn, address tokenOut, uint24 fee, uint256 minOut, uint8 dexType)";
    const typeString = `tuple(${swapStepTypeString}[] path, address initiator)`;

    // --- Return Result ---
    logger.debug(`${functionSig} Parameters built successfully for initiateAaveFlashLoan.`);
    return {
        params: params, typeString: typeString,
        borrowTokenAddress: borrowTokenAddress, borrowAmount: borrowAmount,
        contractFunctionName: 'initiateAaveFlashLoan'
    };
}

module.exports = {
    buildAavePathParams,
};
