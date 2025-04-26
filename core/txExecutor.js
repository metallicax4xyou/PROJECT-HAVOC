// core/txExecutor.js
// --- VERSION v1.1 --- Adjusts default priority fee logic and error checking

const { ethers, ErrorCode } = require('ethers'); // Import ErrorCode
const { ArbitrageError, handleError } = require('../utils/errorHandler');

// Ensure FlashSwapManager type hint is consistent if using JSDoc/TS
// We don't strictly need the class import if we just use the instance passed in.
// const FlashSwapManager = require('./flashSwapManager');

/**
 * Executes a prepared transaction.
 * Assumes parameters are built, gas is estimated, and fees are fetched upstream.
 * @param {string} contractFunctionName The name of the function to call on the FlashSwap contract.
 * @param {Array<any>} contractCallArgs The array of arguments for the contract function call.
 * @param {FlashSwapManager} manager The initialized FlashSwapManager instance (provides signer/contract).
 * @param {bigint} gasEstimate The final, buffered gas limit for the transaction (as BigInt).
 * @param {ethers.FeeData} feeData The fee data (maxFeePerGas, etc.) to use for the transaction.
 * @param {object} logger The logger instance passed from the engine context.
 * @param {boolean} dryRun If true, logs the transaction details instead of sending.
 * @returns {Promise<{success: boolean, txHash: string|null, error: Error|null}>} Execution status.
 */
async function executeTransaction(
    contractFunctionName,
    contractCallArgs,
    manager, // FlashSwapManager instance
    gasEstimate, // Expecting BigInt gas limit
    feeData,     // Expecting FeeData object
    logger,      // Logger instance
    dryRun       // Boolean dry run flag
) {
    const functionSig = `[TxExecutor Fn: ${contractFunctionName} v1.1]`; // Version bump
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
    if (gasEstimate <= 0n) {
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
    let signer; // This should be the NonceManager instance
    let contractAddress;
    try {
        flashSwapContract = manager.getFlashSwapContract();
        signer = manager.getSigner(); // Get NonceManager instance
        contractAddress = await flashSwapContract.getAddress();
    } catch (managerError) {
         logger.error(`${functionSig} Failed to get components from FlashSwapManager: ${managerError.message}`, managerError);
         return { success: false, txHash: null, error: new ArbitrageError(`Failed to get components from Manager: ${managerError.message}`, 'EXECUTION_ERROR', managerError) };
    }
    // Redundant check, but safe
    if (!flashSwapContract || !signer || !contractAddress) {
         logger.error(`${functionSig} FlashSwap contract, signer, or address not available from manager.`);
         return { success: false, txHash: null, error: new ArbitrageError('Missing core components from Manager.', 'EXECUTION_ERROR') };
    }


    try {
        // --- Get Nonce ---
        // NonceManager instance handles getting the nonce internally when signer.sendTransaction is called.
        // We don't strictly need to fetch it here again, but keep the logic if needed for overrides pre-population.
        let nonce;
        if (typeof signer.getNextNonce === 'function') {
             // If we fetch it here, it consumes a nonce from the manager *before* sendTransaction does.
             // It's better to let NonceManager handle it entirely within its sendTransaction method.
             // So, we fetch it only if we absolutely needed it for txOverrides *before* send.
             // For now, let NonceManager handle it.
             // nonce = await signer.getNextNonce();
             // logger.debug(`${functionSig} Fetched Nonce from NonceManager: ${nonce}`);
        } else {
             logger.error(`${functionSig} Signer does not appear to be a NonceManager instance.`);
             throw new ArbitrageError('Signer is not a NonceManager', 'INTERNAL_ERROR');
        }


        // --- Construct Transaction Overrides ---
        // Nonce will be added by NonceManager.sendTransaction
        const txOverrides = {
            gasLimit: gasEstimate,
            // nonce: nonce, // Let NonceManager handle this
            maxFeePerGas: hasMaxFee ? feeData.maxFeePerGas : null,
            maxPriorityFeePerGas: hasMaxFee ? feeData.maxPriorityFeePerGas || null : null,
            gasPrice: hasMaxFee ? null : (hasGasPrice ? feeData.gasPrice : null)
        };

        // --- *** MODIFIED DEFAULT PRIORITY FEE LOGIC *** ---
        if (txOverrides.maxFeePerGas) { // Only apply if using EIP-1559
            const DEFAULT_TIP_GWEI = 1n; // 1 Gwei as BigInt
            const defaultTipWei = ethers.parseUnits(DEFAULT_TIP_GWEI.toString(), 'gwei');
            let effectivePriorityFee = txOverrides.maxPriorityFeePerGas;

            if (!effectivePriorityFee || effectivePriorityFee <= 0n) {
                 effectivePriorityFee = defaultTipWei;
                 logger.debug(`${functionSig} Priority fee was zero/null, setting default: ${ethers.formatUnits(effectivePriorityFee, 'gwei')} Gwei`);
            }

            // CRITICAL CHECK: Ensure priority fee is not greater than max fee
            if (effectivePriorityFee >= txOverrides.maxFeePerGas) {
                logger.warn(`${functionSig} Default/provided priority fee (${ethers.formatUnits(effectivePriorityFee, 'gwei')}) >= maxFeePerGas (${ethers.formatUnits(txOverrides.maxFeePerGas, 'gwei')}). Clamping priority fee.`);
                // Clamp priority fee to be slightly less than maxFee (e.g., maxFee - 1 wei, or a smaller fraction like 90%)
                // Ensure maxFeePerGas is at least 2 wei if we subtract 1 wei, otherwise set priority to 1 wei.
                effectivePriorityFee = txOverrides.maxFeePerGas > 1n ? txOverrides.maxFeePerGas - 1n : 1n;
                logger.warn(`${functionSig} Clamped priority fee to: ${ethers.formatUnits(effectivePriorityFee, 'gwei')} Gwei`);
            }
            txOverrides.maxPriorityFeePerGas = effectivePriorityFee; // Assign the potentially clamped value
        }
        // --- *** END MODIFICATION *** ---


        // Log fee type being used
        if (txOverrides.maxFeePerGas) {
             logger.debug(`${functionSig} Using EIP-1559 Fees: Max=${ethers.formatUnits(txOverrides.maxFeePerGas, 'gwei')} Gwei, Priority=${ethers.formatUnits(txOverrides.maxPriorityFeePerGas || 0n, 'gwei')} Gwei`);
             delete txOverrides.gasPrice;
        } else if (txOverrides.gasPrice) {
             logger.debug(`${functionSig} Using Legacy Gas Price: ${ethers.formatUnits(txOverrides.gasPrice, 'gwei')} Gwei`);
             delete txOverrides.maxFeePerGas; delete txOverrides.maxPriorityFeePerGas;
        } else { throw new ArbitrageError('Could not determine valid fee data (logic error).', 'INTERNAL_ERROR'); }
        logger.debug(`${functionSig} Transaction Overrides Prepared (excluding nonce):`, { gasLimit: txOverrides.gasLimit.toString() });


        // --- EXECUTE TRANSACTION ---
        if (dryRun) {
             logger.warn(`[DRY RUN] ${functionSig} Skipping actual transaction submission.`);
             logger.warn(`[DRY RUN] Contract: ${contractAddress}`);
             logger.warn(`[DRY RUN] Function: ${contractFunctionName}`);
             try { const argsString = JSON.stringify(contractCallArgs, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2); logger.warn(`[DRY RUN] Args: ${argsString}`); }
             catch (jsonError) { logger.warn(`[DRY RUN] Args (could not stringify reliably):`, contractCallArgs); }
             // Add nonce=null for dry run logging clarity
             const overridesForLog = {...txOverrides, nonce: 'DRY_RUN (Handled by NonceManager)'};
             const overridesString = JSON.stringify(overridesForLog, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
             logger.warn(`[DRY RUN] Overrides: ${overridesString}`);
             return { success: true, txHash: 'DRY_RUN_SUCCESS', error: null };
        } else {
            logger.warn(`>>> [LIVE] ${functionSig} ATTEMPTING TO SEND TRANSACTION <<<`);
            try {
                // Ensure the function exists on the contract object/interface before calling
                if (typeof flashSwapContract[contractFunctionName] !== 'function') {
                     if (!flashSwapContract.interface.hasFunction(contractFunctionName)) {
                          throw new ArbitrageError(`Function '${contractFunctionName}' does not exist on FlashSwap contract ABI/instance.`, 'INTERNAL_ERROR');
                     }
                     logger.warn(`${functionSig} Direct contract function access check failed, but function exists in ABI. Proceeding.`);
                }

                // Call the specific function using spread arguments and overrides
                // The NonceManager instance (`signer`) handles the actual signing and sending via its sendTransaction method
                const txResponse = await flashSwapContract[contractFunctionName](...contractCallArgs, txOverrides);

                logger.log(`>>> [LIVE] ${functionSig} TRANSACTION SENT! HASH: ${txResponse.hash}`);
                logger.info(`${functionSig} Transaction details: Nonce=${txResponse.nonce}, GasLimit=${txResponse.gasLimit.toString()}, MaxFeePerGas=${txResponse.maxFeePerGas ? ethers.formatUnits(txResponse.maxFeePerGas, 'gwei') : 'N/A'} Gwei`);
                return { success: true, txHash: txResponse.hash, error: null };

            } catch (executionError) {
                handleError(executionError, `TxExecutor SendTransaction (${contractFunctionName})`, logger); // Use the imported handler

                // --- *** MODIFIED NONCE CHECK *** ---
                // Check specific error codes for nonce issues
                const message = executionError.message?.toLowerCase() || '';
                const code = executionError.code;
                // Use standard ethers v6 error codes if available
                // Check if ErrorCode exists before accessing properties
                const isNonceExpired = (code === 'NONCE_EXPIRED') || (ErrorCode && code === ErrorCode.NONCE_EXPIRED) || message.includes('nonce too low') || message.includes('invalid nonce');
                const isInsufficientFunds = (code === 'INSUFFICIENT_FUNDS') || (ErrorCode && code === ErrorCode.INSUFFICIENT_FUNDS) || message.includes('insufficient funds');
                const isReplacementUnderpriced = (code === 'REPLACEMENT_UNDERPRICED') || (ErrorCode && code === ErrorCode.REPLACEMENT_UNDERPRICED) || message.includes('replacement transaction underpriced');
                const isBadData = (code === 'BAD_DATA'); // Added BAD_DATA check

                if (isNonceExpired) {
                     logger.warn(`${functionSig} Nonce error detected ('${code || message}'), attempting resync...`);
                     if (typeof signer.resyncNonce === 'function') {
                         try { await signer.resyncNonce(); logger.info(`${functionSig} Nonce resync completed.`); }
                         catch (resyncError) { logger.error(`${functionSig} Nonce resync failed: ${resyncError.message}`, resyncError); }
                     } else { logger.error(`${functionSig} Signer does not support resyncNonce.`); }
                     // Re-throw specific error type
                     throw new ArbitrageError(`Nonce error during execution: ${executionError.message}`, 'NONCE_ERROR', { originalError: executionError });
                } else if (isInsufficientFunds) {
                     throw new ArbitrageError(`Insufficient funds: ${executionError.message}`, 'INSUFFICIENT_FUNDS', { originalError: executionError });
                } else if (isReplacementUnderpriced) {
                     throw new ArbitrageError(`Replacement underpriced: ${executionError.message}`, 'REPLACEMENT_UNDERPRICED', { originalError: executionError });
                } else if (isBadData) {
                    throw new ArbitrageError(`Transaction data invalid (BAD_DATA): ${executionError.message}`, 'BAD_DATA_ERROR', { originalError: executionError });
                }
                // --- *** END MODIFICATION *** ---

                // For other errors, wrap them generically
                 throw new ArbitrageError(`Transaction execution failed: ${executionError.message}`, 'EXECUTION_ERROR', { originalError: executionError });
            }
        } // End else (LIVE mode)

    } catch (error) { // Catch errors from preparation or re-thrown errors
        // Log and return known ArbitrageErrors
        if (error instanceof ArbitrageError) {
             logger.error(`${functionSig} Execution failed: ${error.message} (Type: ${error.type || 'N/A'}, Code: ${error.code || 'N/A'})`);
             return { success: false, txHash: null, error: error };
        } else {
             // Wrap unexpected errors
             handleError(error, 'TxExecutor Unexpected', logger);
             return { success: false, txHash: null, error: new ArbitrageError(`Unexpected Executor error: ${error.message}`, 'UNKNOWN_EXECUTION_ERROR', { originalError: error }) };
        }
    } // End outer try/catch
} // End executeTransaction

module.exports = { executeTransaction };
