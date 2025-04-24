// core/tx/encoder.js
const { ethers } = require('ethers');
const logger = require('../../utils/logger'); // Adjust path if needed
const { ABIS } = require('../../constants/abis'); // Adjust path if needed
const { ArbitrageError } = require('../utils/errorHandler'); // Adjust path if needed

// Ensure FlashSwap ABI is loaded
if (!ABIS.FlashSwap) {
    // Log critical error and potentially exit or throw fatal error
    const errorMsg = '[Encoder Init] CRITICAL: FlashSwap ABI not found in constants/abis.js. Cannot encode transactions.';
    logger.error(errorMsg);
    throw new Error(errorMsg); // Throw to prevent bot from starting without critical ABI
}
// Create Interface instance using the ABI
const flashSwapInterface = new ethers.Interface(ABIS.FlashSwap);


/**
 * Encodes parameters for a specific struct type using ethers AbiCoder.
 * (Existing function - no changes needed here)
 * @param {object} params The JavaScript object representing the parameters.
 * @param {string} typeString The ABI type string for the structure (e.g., "tuple(...)").
 * @returns {string} The ABI-encoded data string.
 * @throws {ArbitrageError} If encoding fails.
 */
function encodeParams(params, typeString) {
    const functionSig = `[Encoder]`;
    logger.debug(`${functionSig} Encoding parameters with type: ${typeString}`);
    if (!params || !typeString) {
        throw new ArbitrageError('Missing params or typeString for encoding.', 'ENCODING_ERROR');
    }
    try {
        const encodedData = ethers.AbiCoder.defaultAbiCoder().encode([typeString], [params]);
        logger.debug(`${functionSig} Parameters encoded successfully: ${encodedData.substring(0, 42)}...`);
        return encodedData;
    } catch (encodeError) {
        logger.error(`${functionSig} Failed to encode parameters: ${encodeError.message}`, { params, typeString });
        throw new ArbitrageError(`Failed to encode parameters: ${encodeError.message}`, 'ENCODING_ERROR', { originalError: encodeError, params: JSON.stringify(params), typeString: typeString }); // Stringify params for logging
    }
}


// ****** NEW FUNCTION ADDED ******
/**
 * Encodes the complete calldata for the `initiateFlashSwap` function.
 * Assumes a spatial (2-hop) opportunity structure.
 *
 * @param {object} opportunity - The spatial opportunity object.
 * @param {object} config - The main configuration object (needs TOKENS).
 * @returns {string|null} The encoded calldata for the initiateFlashSwap function, or null on error.
 */
function encodeInitiateFlashSwapData(opportunity, config) {
    // *** Verify this function name matches your FlashSwap.sol ***
    const functionName = 'initiateFlashSwap';
    const logPrefix = '[TxEncoder.initiateFlashSwap]';

    try {
        logger.debug(`${logPrefix} Encoding for opportunity: ${opportunity.pairKey}`);
        if (opportunity.type !== 'spatial' || opportunity.path?.length !== 2) {
            throw new Error('Invalid opportunity type or path length for initiateFlashSwap.');
        }

        // --- 1. Determine Borrow Details ---
        const borrowTokenSymbol = opportunity.tokenIn; // Token borrowed = Initial token of the arb path
        const borrowToken = config.TOKENS[borrowTokenSymbol];
        if (!borrowToken?.address || !borrowToken?.decimals) throw new Error(`Borrow token invalid: ${borrowTokenSymbol}`);
        const borrowAmount = BigInt(opportunity.amountIn);
        if (borrowAmount <= 0n) throw new Error(`Invalid borrow amount: ${opportunity.amountIn}`);

        // Borrow pool is the first pool in the path (where we buy the intermediate token)
        const poolBorrowedFromState = opportunity.path[0].poolState;
        const poolBorrowedFromAddress = poolBorrowedFromState?.address;
        if (!poolBorrowedFromAddress || !ethers.isAddress(poolBorrowedFromAddress)) throw new Error("Invalid borrow pool address.");

        // Determine _amount0 / _amount1 args for the flash() call based on pool's token0/token1
        let amount0ToBorrow = 0n; let amount1ToBorrow = 0n;
        if (!poolBorrowedFromState.token0?.address || !poolBorrowedFromState.token1?.address) {
             throw new Error("Borrow pool state missing token addresses.");
        }
        if (borrowToken.address.toLowerCase() === poolBorrowedFromState.token0.address.toLowerCase()) { amount0ToBorrow = borrowAmount; }
        else if (borrowToken.address.toLowerCase() === poolBorrowedFromState.token1.address.toLowerCase()) { amount1ToBorrow = borrowAmount; }
        else { throw new Error(`Borrow token ${borrowToken.symbol} not found in borrow pool ${poolBorrowedFromAddress}`); }
        logger.debug(`${logPrefix} Borrow Details: Pool=${poolBorrowedFromAddress}, Token=${borrowToken.symbol}, Amt0=${amount0ToBorrow}, Amt1=${amount1ToBorrow}`);

        // --- 2. Prepare `TwoHopParams` struct ---
        const intermediateTokenSymbol = opportunity.tokenIntermediate;
        const intermediateToken = config.TOKENS[intermediateTokenSymbol];
        if (!intermediateToken?.address) throw new Error(`Intermediate token invalid: ${intermediateTokenSymbol}`);

        const leg1 = opportunity.path[0]; // Buy leg
        const leg2 = opportunity.path[1]; // Sell leg
        if (!leg1?.poolState?.address || !leg2?.poolState?.address) throw new Error("Path missing pool state addresses.");

        const feeA = Number(leg1.poolState.fee);
        const feeB = Number(leg2.poolState.fee);
        if (isNaN(feeA) || isNaN(feeB) || feeA < 0 || feeB < 0) throw new Error("Invalid pool fee found.");

        // Use 0 for minimums during gas estimation
        const amountOutMinimum1 = 0n; const amountOutMinimum2 = 0n;

        // Ensure parameters match the struct definition in FlashSwap.sol
        const twoHopParams = {
            tokenIntermediate: intermediateToken.address,
            poolA: leg1.poolState.address,
            feeA: feeA,
            poolB: leg2.poolState.address,
            feeB: feeB,
            amountOutMinimum1: amountOutMinimum1,
            amountOutMinimum2: amountOutMinimum2,
        };
        logger.debug(`${logPrefix} TwoHopParams Prepared:`, twoHopParams);

        // --- 3. ABI-Encode the `TwoHopParams` using the generic helper ---
        const twoHopParamsType = "tuple(address tokenIntermediate, address poolA, uint24 feeA, address poolB, uint24 feeB, uint256 amountOutMinimum1, uint256 amountOutMinimum2)";
        const encodedTwoHopParams = encodeParams(twoHopParams, twoHopParamsType);
        if (!encodedTwoHopParams) throw new Error("Failed to encode TwoHopParams."); // Check return

        // --- 4. Encode the `initiateFlashSwap` Function Call ---
        // *** VERIFY PARAMETER ORDER AND TYPES MATCH YOUR SOLIDITY FUNCTION ***
        const functionArgs = [
            poolBorrowedFromAddress, // address _poolAddress
            amount0ToBorrow,         // uint _amount0
            amount1ToBorrow,         // uint _amount1
            encodedTwoHopParams      // bytes calldata _params
        ];
        const encodedCallData = flashSwapInterface.encodeFunctionData(functionName, functionArgs);

        logger.debug(`${logPrefix} Encoded Call Data generated: ${encodedCallData.substring(0, 74)}...`);
        return encodedCallData;

    } catch (error) {
        logger.error(`${logPrefix} Error encoding ${functionName} data: ${error.message}`, error);
        return null; // Return null on failure
    }
}
// ****** END OF NEW FUNCTION ******


module.exports = {
    encodeParams, // Keep generic helper
    encodeInitiateFlashSwapData, // Export the specific spatial swap encoder
};
