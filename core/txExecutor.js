// core/txExecutor.js
// --- VERSION UPDATED FOR ETHERS V6 UTILS & PHASE 1 REFACTOR ---
// Receives prepared args, gas estimate, fees; Handles nonce and submission.

const { ethers } = require('ethers'); // Ethers v6+
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const FlashSwapManager = require('./flashSwapManager'); // Keep for type hint if using JSDoc/TS

/**
 * Executes a prepared transaction.
 * Assumes parameters are built, gas is estimated, and fees are fetched upstream.
 *
 * @param {string} contractFunctionName The name of the function to call on the FlashSwap contract.
 * @param {Array<any>} contractCallArgs The array of arguments for the contract function call.
 * @param {FlashSwapManager} manager The initialized FlashSwapManager instance.
 * @param {bigint} gasEstimate The final, buffered gas limit for the transaction (as BigInt).
 * @param {ethers.FeeData} feeData The fee data (maxFeePerGas, etc.) to use for the transaction.
 * @param {object} logger The logger instance passed from the engine context.
 * @param {boolean} dryRun If true, logs the transaction details instead of sending.
 * @returns {Promise<{success: boolean, txHash: string|null, error: Error|null}>} Execution status.
 */
async function executeTransaction(
    contractFunctionName,
    contractCallArgs,
    manager,
    gasEstimate, // Expecting BigInt
    feeData,
    logger, // Expecting a passed-in logger instance
    dryRun
) {
    const functionSig = `[TxExecutor Fn: ${contractFunctionName}]`;
    logger.info(`${functionSig} Preparing execution...`);

    // --- Input Validation ---
    if (!contractFunctionName || !Array.isArray(contractCallArgs) || !manager || typeof gasEstimate !== 'bigint' || !feeData || !logger || typeof dryRun === 'undefined') {
        const errorMsg = `${functionSig} Missing or invalid required arguments for execution.`;
        logger.error(errorMsg, {
            functionName: !!contractFunctionName, argsLength: contractCallArgs?.length, manager: !!manager,
            gasEstimateType: typeof gasEstimate, feeData: !!feeData, logger: !!logger, dryRunType: typeof dryRun
        });
        return { success: false, txHash: null, error: new ArbitrageError(errorMsg, 'EXECUTION_ERROR_INVALID_ARGS') };
    }
    if (gasEstimate <= 0n) { // BigInt comparison
         logger.error(`${functionSig} Invalid gasEstimate provided (must be positive): ${gasEstimate.toString()}`);
         return { success: false, txHash: null, error: new ArbitrageError('Invalid gasEstimate for execution (must be positive).', 'EXECUTION_ERROR_INVALID_ARGS') };
    }
     // Ensure feeData has usable pricing info (EIP-1559 or legacy)
     const hasMaxFee = feeData.maxFeePerGas && typeof feeData.maxFeePerGas === 'bigint';
     const hasGasPrice = feeData.gasPrice && typeof feeData.gasPrice === 'bigint';
     if (!hasMaxFee && !hasGasPrice) {
          logger.error(`${functionSig} Invalid feeData provided (missing valid maxFeePerGas or gasPrice).`, feeData);
          return { success: false, txHash: null, error: new ArbitrageError('Invalid feeData for execution.', 'EXECUTION_ERROR_INVALID_ARGS') };
     }
     // --- End Validation ---


    // --- Get Core Components ---
    let flashSwapContract;
    let signer;
    let contractAddress;
    try {
        flashSwapContract = manager.getFlashSwapContract();
        signer = manager.getSigner(); // NonceManager instance
        contractAddress = await flashSwapContract.getAddress(); // ethers v6+ uses async getAddress
    } catch (managerError) {
         logger.error(`${functionSig} Failed to get components from FlashSwapManager: ${managerError.message}`, managerError);
         return { success: false, txHash: null, error: new ArbitrageError(`Failed to get components from Manager: ${managerError.message}`, 'EXECUTION_ERROR', managerError) };
    }
    // Redundant check as caught above, but safe
    if (!flashSwapContract || !signer || !contractAddress) {
         logger.error(`${functionSig} FlashSwap contract, signer, or address not available from manager (redundant check).`);
         return { success: false, txHash: null, error: new ArbitrageError('Missing core components from Manager.', 'EXECUTION_ERROR') };
    }


    try {
        // --- Get Nonce ---
        const nonce = await signer.getNextNonce();
        logger.debug(`${functionSig} Using Nonce: ${nonce}`);

        // --- Construct Transaction Overrides ---
        const txOverrides = {
            gasLimit: gasEstimate, // Already BigInt
            nonce: nonce, // Number from NonceManager
            // Prioritize EIP-1559 fields if available
            maxFeePerGas: hasMaxFee ? feeData.maxFeePerGas : null,
            maxPriorityFeePerGas: hasMaxFee ? feeData.maxPriorityFeePerGas || null : null, // Allow null priority fee
            // Include legacy gasPrice ONLY if EIP-1559 isn't available
            gasPrice: hasMaxFee ? null : (hasGasPrice ? feeData.gasPrice : null)
        };

        // Add a default priority fee if using EIP-1559 and it's missing/zero
        if (txOverrides.maxFeePerGas && (!txOverrides.maxPriorityFeePerGas || txOverrides.maxPriorityFeePerGas <= 0n)) {
             // --- Use ethers.parseUnits (v6 syntax) ---
             txOverrides.maxPriorityFeePerGas = ethers.parseUnits('1', 'gwei'); // Default 1 Gwei tip
             logger.debug(`${functionSig} Using default priority fee: ${ethers.formatUnits(txOverrides.maxPriorityFeePerGas, 'gwei')} Gwei`);
        }

        // Log fee type being used
        if (txOverrides.maxFeePerGas) {
             // --- Use ethers.formatUnits (v6 syntax) ---
             logger.debug(`${functionSig} Using EIP-1559 Fees: Max=${ethers.formatUnits(txOverrides.maxFeePerGas, 'gwei')} Gwei, Priority=${ethers.formatUnits(txOverrides.maxPriorityFeePerGas || 0n, 'gwei')} Gwei`);
             delete txOverrides.gasPrice; // Explicitly remove legacy field
        } else if (txOverrides.gasPrice) {
             // --- Use ethers.formatUnits (v6 syntax) ---
             logger.debug(`${functionSig} Using Legacy Gas Price: ${ethers.formatUnits(txOverrides.gasPrice, 'gwei')} Gwei`);
             delete txOverrides.maxFeePerGas; // Explicitly remove EIP-1559 fields
             delete txOverrides.maxPriorityFeePerGas;
        } else {
             // Should be impossible due to validation, but acts as safeguard
             throw new ArbitrageError('Could not determine valid fee data (maxFee or gasPrice).', 'INTERNAL_ERROR');
        }
        logger.debug(`${functionSig} Transaction Overrides Prepared:`, { gasLimit: txOverrides.gasLimit.toString(), nonce: txOverrides.nonce });


        // --- EXECUTE TRANSACTION ---
        if (dryRun) {
             logger.warn(`[DRY RUN] ${functionSig} Skipping actual transaction submission.`);
             logger.warn(`[DRY RUN] Contract: ${contractAddress}`);
             logger.warn(`[DRY RUN] Function: ${contractFunctionName}`);
             // Log arguments cleanly - use JSON.stringify for complex/nested args, handling BigInts
             try {
                  // Use replacer function for BigInts
                  const argsString = JSON.stringify(contractCallArgs, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
                  logger.warn(`[DRY RUN] Args: ${argsString}`);
             } catch (jsonError) {
                  logger.warn(`[DRY RUN] Args (could not stringify reliably):`, contractCallArgs); // Log raw if stringify fails
             }
             // Log overrides, handling BigInts
             const overridesString = JSON.stringify(txOverrides, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
             logger.warn(`[DRY RUN] Overrides: ${overridesString}`);

             return { success: true, txHash: 'DRY_RUN_SUCCESS', error: null };
        } else {
            logger.warn(`>>> [LIVE] ${functionSig} ATTEMPTING TO SEND TRANSACTION <<<`);
            try {
                // Ensure the function exists on the contract object/interface before calling
                if (typeof flashSwapContract[contractFunctionName] !== 'function') {
                    // Check interface as fallback
                     if (!flashSwapContract.interface.hasFunction(contractFunctionName)) {
                          throw new ArbitrageError(`Function '${contractFunctionName}' does not exist on FlashSwap contract ABI/instance.`, 'INTERNAL_ERROR');
                     }
                     logger.warn(`${functionSig} Direct contract function access check failed, but function exists in ABI. Proceeding.`);
                }

                // Call the specific function using spread arguments and overrides
                // The NonceManager instance (`signer`) handles the actual signing and sending
                const txResponse = await flashSwapContract[contractFunctionName](...contractCallArgs, txOverrides);

                logger.log(`>>> [LIVE] ${functionSig} TRANSACTION SENT! HASH: ${txResponse.hash}`);
                 // --- Use ethers.formatUnits (v6 syntax) ---
                logger.info(`${functionSig} Transaction details: Nonce=${txResponse.nonce}, GasLimit=${txResponse.gasLimit.toString()}, MaxFeePerGas=${txResponse.maxFeePerGas ? ethers.formatUnits(txResponse.maxFeePerGas, 'gwei') : 'N/A'} Gwei`);

                // NOTE: Waiting for confirmation is generally NOT recommended for MEV/Arbitrage
                // as it slows down the bot significantly. Only enable for debugging.
                // const WAIT_CONFIRMATIONS = 0; // Example: Get from config
                // if (WAIT_CONFIRMATIONS > 0) { /* ... wait logic ... */ }

                // Return success immediately after sending
                return { success: true, txHash: txResponse.hash, error: null };

            } catch (executionError) {
                // Use the passed-in logger instance for consistent logging context
                handleError(executionError, `TxExecutor SendTransaction (${contractFunctionName})`, logger);

                // Attempt to resync nonce on specific errors
                const message = executionError.message?.toLowerCase() || '';
                const code = executionError.code; // Ethers v6 uses error codes more reliably
                // Use standard ethers v6 error codes
                if (code === 'NONCE_EXPIRED' || code === ethers.ErrorCode.NONCE_EXPIRED || message.includes('nonce too low') || message.includes('invalid nonce')) {
                     logger.warn(`${functionSig} Nonce error detected ('${code || message}'), attempting resync...`);
                     try {
                          await signer.resyncNonce(); // Call resync on NonceManager instance
                          logger.info(`${functionSig} Nonce resync completed.`);
                     } catch (resyncError) {
                          logger.error(`${functionSig} Nonce resync failed: ${resyncError.message}`, resyncError);
                     }
                     throw new ArbitrageError(`Nonce error during execution: ${executionError.message}`, 'NONCE_ERROR', { originalError: executionError });
                } else if (code === 'INSUFFICIENT_FUNDS' || code === ethers.ErrorCode.INSUFFICIENT_FUNDS || message.includes('insufficient funds')) {
                    throw new ArbitrageError(`Insufficient funds for transaction: ${executionError.message}`, 'INSUFFICIENT_FUNDS', { originalError: executionError });
                } else if (code === 'REPLACEMENT_UNDERPRICED' || code === ethers.ErrorCode.REPLACEMENT_UNDERPRICED || message.includes('replacement transaction underpriced')) {
                    throw new ArbitrageError(`Replacement transaction underpriced: ${executionError.message}`, 'REPLACEMENT_UNDERPRICED', { originalError: executionError });
                }
                // For other errors, wrap them generically
                 throw new ArbitrageError(`Transaction execution failed: ${executionError.message}`, 'EXECUTION_ERROR', { originalError: executionError });
            }
        } // End else (LIVE mode)

    } catch (error) { // Catch errors from nonce fetching or re-thrown errors
        if (!(error instanceof ArbitrageError)) { // Wrap unexpected errors
             handleError(error, 'TxExecutor Unexpected', logger);
             return { success: false, txHash: null, error: new ArbitrageError(`Unexpected Executor error: ${error.message}`, 'UNKNOWN_EXECUTION_ERROR', { originalError: error }) };
        } else {
             // Log known ArbitrageErrors
             logger.error(`${functionSig} Execution failed: ${error.message} (Type: ${error.type}, Code: ${error.code || 'N/A'})`);
             return { success: false, txHash: null, error: error }; // Return the original ArbitrageError
        }
    } // End outer try/catch
} // End executeTransaction

module.exports = { executeTransaction };
