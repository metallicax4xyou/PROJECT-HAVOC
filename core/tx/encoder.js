// core/tx/encoder.js
// --- VERSION v3.0 --- Simplified to only handle final function data encoding.
// Depends on txParameterPreparer providing the function name and args.

const { ethers } = require('ethers');
const logger = require('../../utils/logger');
const { ABIS } = require('../../constants/abis');
const { ArbitrageError } = require('../../utils/errorHandler');

// Ensure FlashSwap ABI is loaded
if (!ABIS.FlashSwap) {
    const errorMsg = '[TxEncoder Init] CRITICAL: FlashSwap ABI not found.';
    logger.error(errorMsg);
    // Throwing here is safe during startup initialization
    throw new Error(errorMsg);
}
const flashSwapInterface = new ethers.Interface(ABIS.FlashSwap);
const logPrefix = '[TxEncoder]';
logger.debug(`${logPrefix} Initialized with FlashSwap ABI.`);


/**
 * Encodes the function call data for a specific function on the FlashSwap contract.
 * This is the final step before sending the transaction.
 * It takes the function name and the prepared arguments array (from txParameterPreparer).
 *
 * @param {string} functionName - The name of the function to call on FlashSwap.sol (e.g., 'initiateAaveFlashLoan', 'initiateUniswapV3FlashLoan').
 * @param {Array<any>} functionArgs - The ordered array of arguments for the specified function, as prepared by txParameterPreparer.
 * @returns {string} The ABI-encoded transaction calldata (bytes string).
 * @throws {ArbitrageError} If encoding fails.
 */
function encodeFlashSwapCall(functionName, functionArgs) {
    logger.debug(`${logPrefix} Encoding function call data for ${functionName} with arguments:`, functionArgs);

    if (!functionName || !Array.isArray(functionArgs)) {
        const errorMsg = 'Missing functionName or invalid functionArgs for encoding.';
        logger.error(`${logPrefix} ${errorMsg}`);
        throw new ArbitrageError('EncodingError', errorMsg);
    }

    try {
        // Use the FlashSwap interface to encode the specific function call
        const calldata = flashSwapInterface.encodeFunctionData(functionName, functionArgs);
        logger.debug(`${logPrefix} Function call encoded successfully: ${calldata.substring(0, 74)}...`);
        return calldata;

    } catch (encodeError) {
        logger.error(`${logPrefix} Failed to encode function call data for ${functionName}: ${encodeError.message}`, { functionName, functionArgsError: encodeError.message });
         // Log sensitive arguments only if debug level is high? Or just avoid?
         // logger.debug(`${logPrefix} Failed to encode function call data for ${functionName}. Args:`, functionArgs); // Potentially too verbose/sensitive

        throw new ArbitrageError(`Failed to encode FlashSwap function call for ${functionName}: ${encodeError.message}`, 'EncodingError', { originalError: encodeError, functionName });
    }
}

module.exports = {
    encodeFlashSwapCall,
};
