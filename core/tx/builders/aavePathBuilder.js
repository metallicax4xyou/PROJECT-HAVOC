// core/tx/builders/aavePathBuilder.js
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
 * Assumes ProfitCalculator provides final amountOut and amountIn in tradeData.
 * Applies slippage only to the final amountOut for the last step's minOut.
 *
 * @param {object} opportunity The tradeData object (containing path, amounts, etc.).
 * @param {object} simulationResult // NOTE: We primarily use amounts from the 'opportunity' (tradeData) object now. This might be redundant or used for consistency check.
 * @param {object} config The application config object (needed for SLIPPAGE).
 * @param {object} flashSwapManagerInstance Needed to get the initiator address.
 * @returns {{ params: object, borrowTokenAddress: string, borrowAmount: bigint, typeString: string, contractFunctionName: string }}
 * @throws {ArbitrageError} If inputs are invalid or processing fails.
 */
async function buildAavePathParams(opportunity, simulationResult, config, flashSwapManagerInstance) {
    const functionSig = `[ParamBuilder AavePath]`;
    logger.debug(`${functionSig} Building parameters...`);

    // --- Input Validation ---
    if (!opportunity?.path || !Array.isArray(opportunity.path) || opportunity.path.length === 0) {
        throw new ArbitrageError('Invalid or empty path in opportunity object.', 'PARAM_BUILD_ERROR', { opportunity });
    }
    if (!opportunity.tokenIn?.address || !opportunity.amountIn) {
        throw new ArbitrageError('Missing borrow token address or amountIn in opportunity object.', 'PARAM_BUILD_ERROR', { opportunity });
    }
     if (!opportunity.amountOut) { // Need final amount for slippage calc
        throw new ArbitrageError('Missing final amountOut in opportunity object.', 'PARAM_BUILD_ERROR', { opportunity });
    }
    if (!config?.SLIPPAGE_TOLERANCE_BPS === undefined) { // Check existence specifically
        throw new ArbitrageError('Missing SLIPPAGE_TOLERANCE_BPS in config.', 'CONFIG_ERROR');
    }
     if (!flashSwapManagerInstance || typeof flashSwapManagerInstance.getSignerAddress !== 'function') {
         throw new ArbitrageError('Invalid or missing flashSwapManagerInstance.', 'PARAM_BUILD_ERROR');
     }
    // --- End Validation ---

    // --- Determine Borrow Details ---
    const borrowTokenAddress = opportunity.tokenIn.address;
    const borrowAmount = BigInt(opportunity.amountIn);
    const finalAmountSimulated = BigInt(opportunity.amountOut); // Final amount of borrowToken expected back

    // --- Calculate final minimum amount out (applied only to last step) ---
    const minAmountOutFinal = calculateMinAmountOut(finalAmountSimulated, config.SLIPPAGE_TOLERANCE_BPS);
    logger.debug(`${functionSig} Slippage Tolerance: ${config.SLIPPAGE_TOLERANCE_BPS} bps`);
    logger.debug(`${functionSig} Final Amount Simulated (${opportunity.tokenIn.symbol}): ${ethers.formatUnits(finalAmountSimulated, opportunity.tokenIn.decimals)}`);
    logger.debug(`${functionSig} Min Amount Out Final (${opportunity.tokenIn.symbol}): ${ethers.formatUnits(minAmountOutFinal, opportunity.tokenIn.decimals)}`);

    if (minAmountOutFinal <= 0n) {
        logger.error(`${functionSig} Calculated zero minimum final amount out.`, { finalAmountSimulated, minAmountOutFinal });
        throw new ArbitrageError('Calculated zero minimum final amount out, aborting Aave parameter build.', 'SLIPPAGE_ERROR', { finalAmountSimulated, minAmountOutFinal });
    }

    // --- Construct SwapStep[] Array ---
    const swapStepArray = [];
    for (let i = 0; i < opportunity.path.length; i++) {
        const step = opportunity.path[i];

        if (!step || !step.address || !step.tokenInAddress || !step.tokenOutAddress || !step.dex) {
             throw new ArbitrageError(`Invalid step structure at index ${i} in opportunity path.`, 'PARAM_BUILD_ERROR', { step });
        }

        // Determine minOut for this step
        // Use 0 for all steps except the last one
        const stepMinOut = (i === opportunity.path.length - 1) ? minAmountOutFinal : 0n;

        // Get numeric DEX type
        const dexType = mapDexType(step.dex);

        // Fee: Ensure it's a number, default if necessary (e.g., for non-V3)
        let feeUint24 = 0;
        if (step.fee !== undefined && step.fee !== null) {
            feeUint24 = Number(step.fee);
            if (isNaN(feeUint24) || feeUint24 < 0 || feeUint24 > 16777215) { // Check validity for uint24
                logger.warn(`${functionSig} Invalid fee ${step.fee} for step ${i}. Using 0.`);
                feeUint24 = 0;
            }
        } else if (step.dex === 'uniswapV3') {
             logger.warn(`${functionSig} Missing fee for V3 step ${i}. Using 0.`);
             feeUint24 = 0; // Should not happen if fetcher/opp structure is correct
        }
        // Non-V3 pools might not need fee in struct, check Solidity

        swapStepArray.push({
            pool: step.address, // Pool address for this hop
            tokenIn: step.tokenInAddress, // Address of token being input to this step
            tokenOut: step.tokenOutAddress, // Address of token expected out from this step
            fee: feeUint24, // Uniswap V3 fee tier (or 0/placeholder for others if struct requires it)
            minOut: stepMinOut, // Minimum amount expected out (only non-zero for last step currently)
            dexType: dexType // Numeric identifier for the DEX
        });
    }

    // --- Get Initiator Address ---
    const initiatorAddress = await flashSwapManagerInstance.getSignerAddress();

    // --- Construct ArbParams Object ---
    const params = {
        path: swapStepArray,
        initiator: initiatorAddress // Address executing the flash loan tx
    };

    // --- Define Type String (MUST MATCH FlashSwap.sol ArbParams struct) ---
    const swapStepTypeString = "tuple(address pool, address tokenIn, address tokenOut, uint24 fee, uint256 minOut, uint8 dexType)";
    const typeString = `tuple(${swapStepTypeString}[] path, address initiator)`;

    // --- Return Result ---
    logger.debug(`${functionSig} Parameters built successfully for initiateAaveFlashLoan.`);
    return {
        params: params,             // The JS object matching ArbParams struct
        typeString: typeString,     // ABI encoding string for ArbParams
        borrowTokenAddress: borrowTokenAddress, // Address of token borrowed from Aave
        borrowAmount: borrowAmount, // Amount (BigInt) borrowed from Aave
        contractFunctionName: 'initiateAaveFlashLoan' // Target function on FlashSwap.sol
    };
}

module.exports = {
    buildAavePathParams,
};
