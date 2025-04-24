// core/tx/encoder.js
// --- VERSION v2.0 ---
// Replaces specific gas estimation encoder with a general transaction data encoder.
// Works with paramBuilder v2.0+ to select correct function and encode params.

const { ethers } = require('ethers');
const logger = require('../../utils/logger');
const { ABIS } = require('../../constants/abis');
const { ArbitrageError } = require('../../utils/errorHandler');
const paramBuilder = require('./paramBuilder'); // Import the builders

// Ensure FlashSwap ABI is loaded
if (!ABIS.FlashSwap) {
    const errorMsg = '[Encoder Init] CRITICAL: FlashSwap ABI not found.';
    logger.error(errorMsg);
    throw new Error(errorMsg);
}
const flashSwapInterface = new ethers.Interface(ABIS.FlashSwap);
const logPrefix = '[TxEncoder]';

/**
 * Encodes the raw bytes parameters for a specific trade type using ethers.AbiCoder.
 * @param {object} params The JavaScript object matching the Solidity struct.
 * @param {string} typeString The Solidity tuple definition string (e.g., "tuple(...)").
 * @returns {string} The ABI-encoded bytes string.
 * @throws {ArbitrageError} If encoding fails.
 */
function encodeParams(params, typeString) {
    logger.debug(`${logPrefix} Encoding params with type: ${typeString}`);
    if (!params || !typeString) {
        throw new ArbitrageError('Missing params or typeString for encoding.', 'ENCODING_ERROR', { hasParams: !!params, hasTypeString: !!typeString });
    }
    try {
        const encodedData = ethers.AbiCoder.defaultAbiCoder().encode([typeString], [params]);
        logger.debug(`${logPrefix} Params encoded successfully: ${encodedData.substring(0, 74)}...`);
        return encodedData;
    } catch (encodeError) {
        logger.error(`${logPrefix} Failed encode params: ${encodeError.message}`, { params: JSON.stringify(params), typeString }); // Avoid logging full params if sensitive
        throw new ArbitrageError(`Failed encode params: ${encodeError.message}`, 'ENCODING_ERROR', { originalError: encodeError });
    }
}

/**
 * Determines the V3 pool address from which the flash loan should originate.
 * For spatial arbitrage, this is typically the pool of the first swap leg.
 * For triangular, it's defined differently in the opportunity.
 * @param {object} opportunity The opportunity object.
 * @returns {string} The V3 pool address.
 * @throws {ArbitrageError} If the pool address cannot be determined or is invalid.
 */
function getBorrowPoolAddress(opportunity) {
    let poolAddress = null;
    let poolState = null;

    if (opportunity.type === 'spatial' && opportunity.path?.length > 0) {
        // Borrow from the pool corresponding to the first swap leg
        poolState = opportunity.path[0].poolState;
        poolAddress = poolState?.address;
        // Ensure the pool we borrow from is actually a V3 pool (as flash loan originates there)
        if (opportunity.path[0].dex !== 'uniswapV3') {
             throw new ArbitrageError(`Flash loan cannot originate from non-V3 pool (${opportunity.path[0].dex}) in current setup.`, 'ENCODING_ERROR', { opportunity });
        }

    } else if (opportunity.type === 'triangular') {
        // Assuming the first pool in the list is the borrow pool for triangular
        poolState = opportunity.pools?.[0]; // poolAB in builder
        poolAddress = poolState?.address;
        if (poolState?.dexType !== 'uniswapV3') { // Assuming triangular starts/ends on V3
             throw new ArbitrageError(`Triangular flash loan cannot originate from non-V3 pool (${poolState?.dexType}) in current setup.`, 'ENCODING_ERROR', { opportunity });
        }
    } else {
        throw new ArbitrageError(`Cannot determine borrow pool for opportunity type: ${opportunity.type}`, 'ENCODING_ERROR', { opportunity });
    }

    if (!poolAddress || !ethers.isAddress(poolAddress)) {
        throw new ArbitrageError('Could not determine a valid V3 borrow pool address from opportunity.', 'ENCODING_ERROR', { opportunity });
    }
    if (!poolState?.token0?.address || !poolState?.token1?.address) {
         throw new ArbitrageError('Borrow pool state is missing token address information.', 'ENCODING_ERROR', { poolAddress, poolState });
    }

    logger.debug(`${logPrefix} Determined borrow pool: ${poolAddress} (Type: ${opportunity.type})`);
    return { poolAddress, poolState };
}


/**
 * Encodes the complete transaction calldata for initiating any supported flash swap type.
 * Selects the correct builder, encodes params, and formats the final function call data.
 *
 * @param {object} opportunity - The arbitrage opportunity object (spatial or triangular).
 * @param {object} simulationResult - The result from the SwapSimulator.
 * @param {object} config - The main configuration object.
 * @param {boolean} [isGasEstimation=false] - If true, uses minimal amounts (1 wei borrow, 0 min out) for gas estimation.
 * @returns {{ calldata: string, contractFunctionName: string, borrowPoolAddress: string } | null} Object with encoded calldata, function name, borrow pool address, or null on error.
 */
function encodeTransactionData(opportunity, simulationResult, config, isGasEstimation = false) {
    logger.debug(`${logPrefix} Encoding transaction data. Gas Estimation Mode: ${isGasEstimation}`);

    try {
        // --- 1. Determine Borrow Pool & State ---
        const { poolAddress: borrowPoolAddress, poolState: borrowPoolState } = getBorrowPoolAddress(opportunity);

        // --- 2. Select Builder and Prepare Sim Result ---
        let builderFunction;
        let effectiveSimulationResult = simulationResult;

        if (opportunity.type === 'triangular') {
            builderFunction = paramBuilder.buildTriangularParams;
            // Minimal sim result for gas estimation (Triangular)
            if (isGasEstimation) {
                effectiveSimulationResult = { initialAmount: 1n, finalAmount: 0n }; // Builder uses these for borrow/minOut
            }
        } else if (opportunity.type === 'spatial' && opportunity.path?.length === 2) {
            const dexPath = `${opportunity.path[0].dex}->${opportunity.path[1].dex}`;
            logger.debug(`${logPrefix} Identified spatial path: ${dexPath}`);

            if (dexPath === 'uniswapV3->uniswapV3') {
                builderFunction = paramBuilder.buildTwoHopParams;
            } else if (dexPath === 'uniswapV3->sushiswap') {
                builderFunction = paramBuilder.buildV3SushiParams;
            } else if (dexPath === 'sushiswap->uniswapV3') {
                builderFunction = paramBuilder.buildSushiV3Params;
            } else {
                throw new ArbitrageError(`Unsupported spatial DEX path for encoding: ${dexPath}`, 'ENCODING_ERROR', { opportunity });
            }

            // Minimal sim result for gas estimation (Spatial)
            if (isGasEstimation) {
                 // Builder needs initial, hop1, final. Set initial=1, others=0 for min amounts.
                effectiveSimulationResult = { initialAmount: 1n, hop1AmountOut: 0n, finalAmount: 0n };
            }
        } else {
            throw new ArbitrageError(`Unsupported opportunity type for encoding: ${opportunity.type}`, 'ENCODING_ERROR', { opportunity });
        }

        if (!builderFunction) { // Should be caught above, but safeguard
             throw new ArbitrageError(`Could not find appropriate parameter builder function.`, 'INTERNAL_ERROR', { opportunity });
        }
        logger.debug(`${logPrefix} Using builder: ${builderFunction.name}`);

        // --- 3. Build Parameters using selected builder ---
        // Pass the effective simulation result (real or minimal)
        const { params, borrowTokenAddress, borrowAmount, typeString, contractFunctionName } = builderFunction(
            opportunity,
            effectiveSimulationResult,
            config
        );

        // --- 4. Encode the Specific Parameters Struct ---
        const encodedParamsBytes = encodeParams(params, typeString);
        if (!encodedParamsBytes) { // Should throw from encodeParams, but check
            throw new ArbitrageError("Failed to encode specific parameter bytes.", 'ENCODING_ERROR');
        }

        // --- 5. Determine amount0/amount1 for flash() call ---
        // This depends on the token being borrowed relative to token0/token1 of the V3 pool *where the loan originates*
        let amount0ToBorrow = 0n;
        let amount1ToBorrow = 0n;

        if (borrowTokenAddress.toLowerCase() === borrowPoolState.token0.address.toLowerCase()) {
            amount0ToBorrow = borrowAmount; // borrowAmount is either real simulation amount or 1 wei
        } else if (borrowTokenAddress.toLowerCase() === borrowPoolState.token1.address.toLowerCase()) {
            amount1ToBorrow = borrowAmount;
        } else {
            // This should not happen if builder logic is correct
            throw new ArbitrageError(`Borrow token address ${borrowTokenAddress} does not match borrow pool tokens (${borrowPoolState.token0.address}, ${borrowPoolState.token1.address})`, 'INTERNAL_ERROR', { opportunity });
        }
        logger.debug(`${logPrefix} Flash Loan Amounts: Amt0=${amount0ToBorrow}, Amt1=${amount1ToBorrow}`);

        // --- 6. Encode the Top-Level Function Call ---
        const functionArgs = [
            borrowPoolAddress,  // address _poolAddress (V3 pool to borrow from)
            amount0ToBorrow,    // uint _amount0
            amount1ToBorrow,    // uint _amount1
            encodedParamsBytes  // bytes calldata _params
        ];

        logger.debug(`${logPrefix} Encoding final calldata for function: ${contractFunctionName}`);
        const finalCalldata = flashSwapInterface.encodeFunctionData(contractFunctionName, functionArgs);

        logger.info(`${logPrefix} Successfully encoded calldata for ${contractFunctionName}. Length: ${finalCalldata.length}`);

        return {
            calldata: finalCalldata,
            contractFunctionName: contractFunctionName, // Pass this along for txExecutor
            borrowPoolAddress: borrowPoolAddress // Might be useful context later
        };

    } catch (error) {
        logger.error(`${logPrefix} Failed to encode transaction data: ${error.message}`, error);
        // Ensure error is an ArbitrageError
        if (!(error instanceof ArbitrageError)) {
            throw new ArbitrageError(`Unexpected encoding error: ${error.message}`, 'ENCODING_ERROR', { originalError: error });
        }
        throw error; // Re-throw the ArbitrageError
    }
}

module.exports = {
    // encodeParams, // Keep internal if only used here
    encodeTransactionData,
};
