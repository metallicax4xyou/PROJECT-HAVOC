// core/txExecutor.js
// --- VERSION UPDATED FOR PHASE 1 REFACTOR ---
// Receives prepared args, gas estimate, fees; Handles nonce and submission.

const { ethers } = require('ethers');
// logger instance is passed in, no direct require needed here
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const FlashSwapManager = require('./flashSwapManager'); // Keep for type hint if using JSDoc/TS

/**
 * Executes a prepared transaction.
 * Assumes parameters are built, gas is estimated, and fees are fetched upstream.
 *
 * @param {string} contractFunctionName The name of the function to call on the FlashSwap contract.
 * @param {Array<any>} contractCallArgs The array of arguments for the contract function call.
 * @param {FlashSwapManager} manager The initialized FlashSwapManager instance.
 * @param {ethers.BigNumber} gasEstimate The final, buffered gas limit for the transaction.
 * @param {ethers.providers.FeeData} feeData The fee data (maxFeePerGas, etc.) to use for the transaction.
 * @param {object} logger The logger instance passed from the engine context.
 * @param {boolean} dryRun If true, logs the transaction details instead of sending.
 * @returns {Promise<{success: boolean, txHash: string|null, error: Error|null}>} Execution status.
 */
async function executeTransaction(
    contractFunctionName,
    contractCallArgs,
    manager,
    gasEstimate,
    feeData,
    logger, // Expecting a passed-in logger instance
    dryRun
) {
    const functionSig = `[TxExecutor Fn: ${contractFunctionName}]`;
    logger.info(`${functionSig} Preparing execution...`);

    // --- Input Validation ---
    if (!contractFunctionName || !Array.isArray(contractCallArgs) || !manager || !gasEstimate || !feeData || !logger || typeof dryRun === 'undefined') {
        const errorMsg = `${functionSig} Missing required arguments for execution.`;
        // Use the passed-in logger
        logger.error(errorMsg, {
            functionName: !!contractFunctionName,
            args: Array.isArray(contractCallArgs),
            manager: !!manager,
            gasEstimate: !!gasEstimate,
            feeData: !!feeData,
            logger: !!logger,
            dryRun: typeof dryRun
        });
        return { success: false, txHash: null, error: new ArbitrageError(errorMsg, 'EXECUTION_ERROR') };
    }
    if (!ethers.BigNumber.isBigNumber(gasEstimate) || gasEstimate.lte(0)) {
         logger.error(`${functionSig} Invalid gasEstimate provided: ${gasEstimate?.toString()}`);
         return { success: false, txHash: null, error: new ArbitrageError('Invalid gasEstimate for execution.', 'EXECUTION_ERROR') };
    }
     if (!feeData || (!feeData.maxFeePerGas && !feeData.gasPrice)) { // Check for either EIP1559 or legacy
          logger.error(`${functionSig} Invalid feeData provided (missing maxFeePerGas or gasPrice).`, feeData);
          return { success: false, txHash: null, error: new ArbitrageError('Invalid feeData for execution.', 'EXECUTION_ERROR') };
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

    if (!flashSwapContract || !signer || !contractAddress) {
         logger.error(`${functionSig} FlashSwap contract, signer, or address not available from manager.`);
         return { success: false, txHash: null, error: new ArbitrageError('Missing core components from Manager.', 'EXECUTION_ERROR') };
    }


    try {
        // --- Get Nonce ---
        const nonce = await signer.getNextNonce();
        logger.debug(`${functionSig} Using Nonce: ${nonce}`);

        // --- Construct Transaction Overrides ---
        // Use the provided gasEstimate and feeData directly
        const txOverrides = {
            gasLimit: gasEstimate,
            nonce: nonce,
            // Prioritize EIP-1559 fields if available
            maxFeePerGas: feeData.maxFeePerGas || null, // Set null if undefined
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || null, // Set null if undefined
            // Include legacy gasPrice if EIP-1559 isn't fully present
            gasPrice: feeData.maxFeePerGas ? null : feeData.gasPrice || null // Only use gasPrice if maxFee isn't set
        };

        // Clean up null/undefined values and log fee type
        if (txOverrides.maxFeePerGas) {
            delete txOverrides.gasPrice; // Remove legacy if EIP-1559 is used
            if (!txOverrides.maxPriorityFeePerGas) {
                 // Add a small default/minimum priority fee if missing and using EIP-1559
                 txOverrides.maxPriorityFeePerGas = ethers.utils.parseUnits('1', 'gwei'); // Example: 1 Gwei default tip
                 logger.debug(`${functionSig} Using EIP-1559 Fees: Max=${ethers.utils.formatUnits(txOverrides.maxFeePerGas, 'gwei')} Gwei, Priority=${ethers.utils.formatUnits(txOverrides.maxPriorityFeePerGas, 'gwei')} Gwei (defaulted)`);
            } else {
                 logger.debug(`${functionSig} Using EIP-1559 Fees: Max=${ethers.utils.formatUnits(txOverrides.maxFeePerGas, 'gwei')} Gwei, Priority=${ethers.utils.formatUnits(txOverrides.maxPriorityFeePerGas, 'gwei')} Gwei`);
            }
        } else if (txOverrides.gasPrice) {
            delete txOverrides.maxFeePerGas;
            delete txOverrides.maxPriorityFeePerGas;
            logger.debug(`${functionSig} Using Legacy Gas Price: ${ethers.utils.formatUnits(txOverrides.gasPrice, 'gwei')} Gwei`);
        } else {
             // This case should have been caught by initial validation
             throw new ArbitrageError('Valid fee data (maxFeePerGas or gasPrice) is missing in txOverrides.', 'INTERNAL_ERROR');
        }
        logger.debug(`${functionSig} Transaction Overrides Prepared:`, { gasLimit: txOverrides.gasLimit.toString(), nonce: txOverrides.nonce });


        // --- EXECUTE TRANSACTION ---
        if (dryRun) {
             logger.warn(`[DRY RUN] ${functionSig} Skipping actual transaction submission.`);
             logger.warn(`[DRY RUN] Contract: ${contractAddress}`);
             logger.warn(`[DRY RUN] Function: ${contractFunctionName}`);
             // Log arguments cleanly - use JSON.stringify for complex/nested args, handling BigInts
             try {
                  const argsString = JSON.stringify(contractCallArgs, (_, v) =>
                      typeof v === 'bigint' ? v.toString() : // Convert BigInt to string
                      (ethers.BigNumber.isBigNumber(v) ? v.toString() : v), // Convert ethers BigNumber
                  2);
                  logger.warn(`[DRY RUN] Args: ${argsString}`);
             } catch (jsonError) {
                  logger.warn(`[DRY RUN] Args (could not stringify reliably):`, contractCallArgs); // Log raw if stringify fails
             }
             // Log overrides, handling BigInts
             const overridesString = JSON.stringify(txOverrides, (_, v) =>
                 typeof v === 'bigint' ? v.toString() :
                 (ethers.BigNumber.isBigNumber(v) ? v.toString() : v),
             2);
             logger.warn(`[DRY RUN] Overrides: ${overridesString}`);

             return { success: true, txHash: 'DRY_RUN_SUCCESS', error: null };
        } else {
            logger.warn(`>>> [LIVE] ${functionSig} ATTEMPTING TO SEND TRANSACTION <<<`);
            try {
                // Ensure the function exists on the contract object/interface before calling
                if (typeof flashSwapContract[contractFunctionName] !== 'function') {
                    // Double check via interface just in case proxy interferes with direct access check
                     if (!flashSwapContract.interface.hasFunction(contractFunctionName)) {
                          throw new ArbitrageError(`Function '${contractFunctionName}' does not exist on FlashSwap contract ABI/instance.`, 'INTERNAL_ERROR');
                     }
                     logger.warn(`${functionSig} Direct contract function access check failed, but function exists in ABI. Proceeding.`);
                }

                // Call the specific function using spread arguments and overrides
                // Use the signer directly if the contract was connected with provider only,
                // or use the contract instance if it was connected with the signer (NonceManager).
                // Since FlashSwapManager connects contract with signer, this should work:
                const txResponse = await flashSwapContract[contractFunctionName](...contractCallArgs, txOverrides);

                logger.log(`>>> [LIVE] ${functionSig} TRANSACTION SENT! HASH: ${txResponse.hash}`);
                logger.info(`${functionSig} Transaction details: Nonce=${txResponse.nonce}, GasLimit=${txResponse.gasLimit.toString()}, MaxFeePerGas=${txResponse.maxFeePerGas ? ethers.utils.formatUnits(txResponse.maxFeePerGas, 'gwei') : 'N/A'} Gwei`);


                // Optional: Wait for receipt (consider making this configurable or moving outside this function)
                // const WAIT_CONFIRMATIONS = config.WAIT_CONFIRMATIONS || 0; // Example: Read from config
                // if (WAIT_CONFIRMATIONS > 0) {
                //     logger.log(`>>> Waiting for ${WAIT_CONFIRMATIONS} confirmation(s)...`);
                //     const receipt = await txResponse.wait(WAIT_CONFIRMATIONS);
                //     logger.log(`>>> TRANSACTION CONFIRMED! Block: ${receipt.blockNumber}, Status: ${receipt.status === 1 ? 'Success' : 'Failed'}, Gas Used: ${receipt.gasUsed.toString()}`);
                //     if (receipt.status !== 1) {
                //         // Even if we waited, report failure based on receipt
                //         throw new ArbitrageError(`Transaction ${txResponse.hash} failed on-chain (receipt status 0).`, 'EXECUTION_FAILURE', { txHash: txResponse.hash, receipt });
                //      }
                // } else {
                //      logger.info(`${functionSig} Not waiting for confirmation based on config.`);
                // }

                // Return success immediately after sending (or after waiting if enabled)
                return { success: true, txHash: txResponse.hash, error: null };

            } catch (executionError) {
                // Use the passed-in logger instance for consistent logging context
                handleError(executionError, `TxExecutor SendTransaction (${contractFunctionName})`, logger);

                // Attempt to resync nonce on specific errors that indicate nonce mismatch
                const message = executionError.message?.toLowerCase() || '';
                const code = executionError.code;
                if (code === ethers.errors.NONCE_EXPIRED || message.includes('nonce too low') || message.includes('invalid nonce')) {
                     logger.warn(`${functionSig} Nonce error detected ('${code || message}'), attempting resync...`);
                     try {
                          await signer.resyncNonce(); // Call resync on NonceManager instance
                          logger.info(`${functionSig} Nonce resync completed.`);
                     } catch (resyncError) {
                          logger.error(`${functionSig} Nonce resync failed: ${resyncError.message}`, resyncError);
                     }
                     // Regardless of resync success, the original transaction failed
                     throw new ArbitrageError(`Nonce error during execution: ${executionError.message}`, 'NONCE_ERROR', { originalError: executionError });
                } else if (code === ethers.errors.INSUFFICIENT_FUNDS || message.includes('insufficient funds')) {
                    throw new ArbitrageError(`Insufficient funds for transaction: ${executionError.message}`, 'INSUFFICIENT_FUNDS', { originalError: executionError });
                } else if (code === ethers.errors.REPLACEMENT_UNDERPRICED || message.includes('replacement transaction underpriced')) {
                    throw new ArbitrageError(`Replacement transaction underpriced: ${executionError.message}`, 'REPLACEMENT_UNDERPRICED', { originalError: executionError });
                }
                 // For other errors, wrap them generically
                 throw new ArbitrageError(`Transaction execution failed: ${executionError.message}`, 'EXECUTION_ERROR', { originalError: executionError });
            }
        }

    } catch (error) {
        // Catch errors from nonce fetching or re-thrown errors from execution block
        if (!(error instanceof ArbitrageError)) { // Wrap unexpected errors if they weren't caught above
             handleError(error, 'TxExecutor Unexpected', logger);
             return { success: false, txHash: null, error: new ArbitrageError(`Unexpected Executor error: ${error.message}`, 'UNKNOWN_EXECUTION_ERROR', { originalError: error }) };
        } else {
             // Log known ArbitrageErrors (already handled if needed by specific catcher)
             logger.error(`${functionSig} Execution failed: ${error.message} (Type: ${error.type}, Code: ${error.code})`);
             return { success: false, txHash: null, error: error }; // Return the original ArbitrageError
        }
    }
}

module.exports = { executeTransaction };
