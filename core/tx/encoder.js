// core/tx/encoder.js
const { ethers } = require('ethers');
// *** CORRECTED PATHS ***
const logger = require('../../utils/logger');
const { ABIS } = require('../../constants/abis');
const { ArbitrageError } = require('../../utils/errorHandler'); // Correct path from core/tx/

// Ensure FlashSwap ABI is loaded
if (!ABIS.FlashSwap) {
    const errorMsg = '[Encoder Init] CRITICAL: FlashSwap ABI not found.';
    logger.error(errorMsg); throw new Error(errorMsg);
}
const flashSwapInterface = new ethers.Interface(ABIS.FlashSwap);

/**
 * Encodes parameters for a specific struct type using ethers AbiCoder.
 */
function encodeParams(params, typeString) {
    const functionSig = `[Encoder]`; logger.debug(`${functionSig} Encoding params: ${typeString}`);
    if (!params || !typeString) { throw new ArbitrageError('Missing params or typeString for encoding.', 'ENCODING_ERROR'); }
    try {
        const encodedData = ethers.AbiCoder.defaultAbiCoder().encode([typeString], [params]);
        logger.debug(`${functionSig} Params encoded successfully.`);
        return encodedData;
    } catch (encodeError) {
        logger.error(`${functionSig} Failed to encode parameters: ${encodeError.message}`, { params: JSON.stringify(params), typeString });
        throw new ArbitrageError(`Failed to encode parameters: ${encodeError.message}`, 'ENCODING_ERROR', { originalError: encodeError });
    }
}

/**
 * Encodes the complete calldata for the `initiateFlashSwap` function.
 * Assumes a spatial (2-hop) opportunity structure.
 */
function encodeInitiateFlashSwapData(opportunity, config) {
    const functionName = 'initiateFlashSwap';
    const logPrefix = '[TxEncoder.initiateFlashSwap]';
    try {
        logger.debug(`${logPrefix} Encoding for opportunity: ${opportunity.pairKey}`);
        if (opportunity.type !== 'spatial' || opportunity.path?.length !== 2) throw new Error('Invalid opp type/path.');

        // --- Borrow Details ---
        const borrowTokenSymbol = opportunity.tokenIn;
        const borrowToken = config.TOKENS[borrowTokenSymbol];
        if (!borrowToken?.address || !borrowToken?.decimals) throw new Error(`Borrow token invalid: ${borrowTokenSymbol}`);
        const borrowAmount = BigInt(opportunity.amountIn);
        if (borrowAmount <= 0n) throw new Error(`Invalid borrow amount: ${opportunity.amountIn}`);
        const poolBorrowedFromState = opportunity.path[0].poolState;
        const poolBorrowedFromAddress = poolBorrowedFromState?.address;
        if (!poolBorrowedFromAddress || !ethers.isAddress(poolBorrowedFromAddress)) throw new Error("Invalid borrow pool address.");
        let amount0ToBorrow = 0n; let amount1ToBorrow = 0n;
        if (!poolBorrowedFromState.token0?.address || !poolBorrowedFromState.token1?.address) throw new Error("Borrow pool state missing token addresses.");
        if (borrowToken.address.toLowerCase() === poolBorrowedFromState.token0.address.toLowerCase()) { amount0ToBorrow = borrowAmount; }
        else if (borrowToken.address.toLowerCase() === poolBorrowedFromState.token1.address.toLowerCase()) { amount1ToBorrow = borrowAmount; }
        else { throw new Error(`Borrow token ${borrowToken.symbol} not in borrow pool ${poolBorrowedFromAddress}`); }
        // logger.debug(`${logPrefix} Borrow Details: Pool=${poolBorrowedFromAddress}, Token=${borrowToken.symbol}, Amt0=${amount0ToBorrow}, Amt1=${amount1ToBorrow}`);

        // --- TwoHopParams ---
        const intermediateTokenSymbol = opportunity.tokenIntermediate;
        const intermediateToken = config.TOKENS[intermediateTokenSymbol];
        if (!intermediateToken?.address) throw new Error(`Intermediate token invalid: ${intermediateTokenSymbol}`);
        const leg1 = opportunity.path[0]; const leg2 = opportunity.path[1];
        if (!leg1?.poolState?.address || !leg2?.poolState?.address) throw new Error("Path missing pool state addresses.");
        const feeA = Number(leg1.poolState.fee); const feeB = Number(leg2.poolState.fee);
        if (isNaN(feeA) || isNaN(feeB) || feeA < 0 || feeB < 0) throw new Error("Invalid pool fee.");
        const amountOutMinimum1 = 0n; const amountOutMinimum2 = 0n; // Use 0 for gas estimation
        const twoHopParams = { tokenIntermediate: intermediateToken.address, poolA: leg1.poolState.address, feeA, poolB: leg2.poolState.address, feeB, amountOutMinimum1, amountOutMinimum2 };
        // logger.debug(`${logPrefix} TwoHopParams:`, twoHopParams);

        // --- Encode Params bytes ---
        const twoHopParamsType = "tuple(address tokenIntermediate, address poolA, uint24 feeA, address poolB, uint24 feeB, uint256 amountOutMinimum1, uint256 amountOutMinimum2)";
        const encodedTwoHopParams = encodeParams(twoHopParams, twoHopParamsType);
        if (!encodedTwoHopParams) throw new Error("Failed to encode TwoHopParams.");

        // --- Encode Function Call ---
        const functionArgs = [ poolBorrowedFromAddress, amount0ToBorrow, amount1ToBorrow, encodedTwoHopParams ];
        const encodedCallData = flashSwapInterface.encodeFunctionData(functionName, functionArgs);
        logger.debug(`${logPrefix} Encoded Call Data generated: ${encodedCallData.substring(0, 74)}...`);
        return encodedCallData;

    } catch (error) {
        logger.error(`${logPrefix} Error encoding ${functionName} data: ${error.message}`, error);
        return null;
    }
}

module.exports = {
    encodeParams,
    encodeInitiateFlashSwapData,
};
