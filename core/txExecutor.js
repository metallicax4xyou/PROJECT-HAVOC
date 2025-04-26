// core/txExecutor.js
// --- VERSION v1.1 --- Adjusts default priority fee logic

const { ethers, ErrorCode } = require('ethers'); // Import ErrorCode
const { ArbitrageError, handleError } = require('../utils/errorHandler');
// Ensure FlashSwapManager type hint is consistent if using JSDoc/TS
// const FlashSwapManager = require('./flashSwapManager');

/**
 * Executes a prepared transaction.
 * Assumes parameters are built, gas is estimated, and fees are fetched upstream.
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
    if (!contractFunctionName || !Array.isArray(contractCallArgs) || !manager || typeof gasEstimate !== 'bigint' || !feeData || !logger || typeof dryRun === 'undefined') { /* ... */ const errorMsg = `${functionSig} Missing or invalid required arguments.`; logger.error(errorMsg); return { success: false, txHash: null, error: new ArbitrageError(errorMsg, 'EXECUTION_ERROR_INVALID_ARGS') }; }
    if (gasEstimate <= 0n) { /* ... */ logger.error(`${functionSig} Invalid gasEstimate: ${gasEstimate.toString()}`); return { success: false, txHash: null, error: new ArbitrageError('Invalid gasEstimate (must be positive).', 'EXECUTION_ERROR_INVALID_ARGS') }; }
    const hasMaxFee = feeData.maxFeePerGas && typeof feeData.maxFeePerGas === 'bigint'; const hasGasPrice = feeData.gasPrice && typeof feeData.gasPrice === 'bigint';
    if (!hasMaxFee && !hasGasPrice) { /* ... */ logger.error(`${functionSig} Invalid feeData (missing maxFee or gasPrice).`, feeData); return { success: false, txHash: null, error: new ArbitrageError('Invalid feeData.', 'EXECUTION_ERROR_INVALID_ARGS') }; }
    // --- End Validation ---


    // --- Get Core Components ---
    let flashSwapContract; let signer; let contractAddress;
    try { flashSwapContract = manager.getFlashSwapContract(); signer = manager.getSigner(); contractAddress = await flashSwapContract.getAddress(); }
    catch (managerError) { /* ... */ logger.error(`${functionSig} Failed to get components from Manager: ${managerError.message}`); return { success: false, txHash: null, error: new ArbitrageError(`Failed Manager components: ${managerError.message}`, 'EXECUTION_ERROR', managerError) }; }
    if (!flashSwapContract || !signer || !contractAddress) { /* ... */ logger.error(`${functionSig} Missing core components from Manager.`); return { success: false, txHash: null, error: new ArbitrageError('Missing core components.', 'EXECUTION_ERROR') }; }


    try {
        // --- Get Nonce ---
        // NonceManager instance handles getting the nonce internally when signer.sendTransaction is called
        // However, we fetch it here for logging/override construction clarity
        // If signer IS NonceManager, getNextNonce is the method. If it's a plain Wallet, we might need getTransactionCount.
        // Assume signer IS the NonceManager instance based on FlashSwapManager setup.
        let nonce;
        if (typeof signer.getNextNonce === 'function') {
             nonce = await signer.getNextNonce(); // Use NonceManager's method
             logger.debug(`${functionSig} Using Nonce from NonceManager: ${nonce}`);
        } else {
             // Fallback if signer doesn't look like our NonceManager (shouldn't happen)
             logger.warn(`${functionSig} Signer doesn't have getNextNonce, fetching manually.`);
             nonce = await manager.getProvider().getTransactionCount(await signer.getAddress(), 'pending');
        }


        // --- Construct Transaction Overrides ---
        const txOverrides = {
            gasLimit: gasEstimate,
            nonce: nonce,
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
                // Clamp priority fee to be slightly less than maxFee (e.g., maxFee - 1 wei, or a smaller fraction)
                // Ensure maxFeePerGas is at least 1 wei if we subtract
                effectivePriorityFee = txOverrides.maxFeePerGas > 1n ? txOverrides.maxFeePerGas - 1n : 1n; // Clamp to 1 wei minimum if maxFee is tiny
                logger.warn(`${functionSig} Clamped priority fee to: ${ethers.formatUnits(effectivePriorityFee, 'gwei')} Gwei`);
            }
            txOverrides.maxPriorityFeePerGas = effectivePriorityFee; // Assign the potentially clamped value
        }
        // --- *** END MODIFICATION *** ---


        // Log fee type being used
        if (txOverrides.maxFeePerGas) {
             logger.debug(`${functionSig} Using EIP-1559 Fees: Max=${ethers.formatUnits(txOverrides.maxFeePerGas, 'gwei')} Gwei, Priority=${ethers.formatUnits(txOverrides.maxPriorityFeePerGas || 0n, 'gwei')} Gwei`);
             delete txOverrides.gasPrice; // Explicitly remove legacy field
        } else if (txOverrides.gasPrice) {
             logger.debug(`${functionSig} Using Legacy Gas Price: ${ethers.formatUnits(txOverrides.gasPrice, 'gwei')} Gwei`);
             delete txOverrides.maxFeePerGas; delete txOverrides.maxPriorityFeePerGas;
        } else { throw new ArbitrageError('Could not determine valid fee data.', 'INTERNAL_ERROR'); }
        logger.debug(`${functionSig} Transaction Overrides Prepared:`, { gasLimit: txOverrides.gasLimit.toString(), nonce: txOverrides.nonce });


        // --- EXECUTE TRANSACTION ---
        if (dryRun) {
             logger.warn(`[DRY RUN] ${functionSig} Skipping actual transaction submission.`);
             logger.warn(`[DRY RUN] Contract: ${contractAddress}`);
             logger.warn(`[DRY RUN] Function: ${contractFunctionName}`);
             try { const argsString = JSON.stringify(contractCallArgs, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2); logger.warn(`[DRY RUN] Args: ${argsString}`); }
             catch (jsonError) { logger.warn(`[DRY RUN] Args (could not stringify reliably):`, contractCallArgs); }
             const overridesString = JSON.stringify(txOverrides, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
             logger.warn(`[DRY RUN] Overrides: ${overridesString}`);
             return { success: true, txHash: 'DRY_RUN_SUCCESS', error: null };
        } else {
            logger.warn(`>>> [LIVE] ${functionSig} ATTEMPTING TO SEND TRANSACTION <<<`);
            try {
                if (typeof flashSwapContract[contractFunctionName] !== 'function') { if (!flashSwapContract.interface.hasFunction(contractFunctionName)) { throw new ArbitrageError(`Function '${contractFunctionName}' does not exist on contract ABI.`, 'INTERNAL_ERROR'); } logger.warn(`${functionSig} Direct function access check failed, but exists in ABI. Proceeding.`); }

                // The NonceManager instance (`signer`) should handle signing and sending when used here
                // The actual tx sending happens when the contract method is called with overrides
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
                if (code === 'NONCE_EXPIRED' || (ErrorCode && code === ErrorCode.NONCE_EXPIRED) || message.includes('nonce too low') || message.includes('invalid nonce')) {
                     logger.warn(`${functionSig} Nonce error detected ('${code || message}'), attempting resync...`);
                     if (typeof signer.resyncNonce === 'function') {
                         try { await signer.resyncNonce(); logger.info(`${functionSig} Nonce resync completed.`); }
                         catch (resyncError) { logger.error(`${functionSig} Nonce resync failed: ${resyncError.message}`, resyncError); }
                     } else { logger.error(`${functionSig} Signer does not support resyncNonce.`); }
                     throw new ArbitrageError(`Nonce error during execution: ${executionError.message}`, 'NONCE_ERROR', { originalError: executionError });
                } else if (code === 'INSUFFICIENT_FUNDS' || (ErrorCode && code === ErrorCode.INSUFFICIENT_FUNDS) || message.includes('insufficient funds')) {
                     throw new ArbitrageError(`Insufficient funds: ${executionError.message}`, 'INSUFFICIENT_FUNDS', { originalError: executionError });
                } else if (code === 'REPLACEMENT_UNDERPRICED' || (ErrorCode && code === ErrorCode.REPLACEMENT_UNDERPRICED) || message.includes('replacement transaction underpriced')) {
                     throw new ArbitrageError(`Replacement underpriced: ${executionError.message}`, 'REPLACEMENT_UNDERPRICED', { originalError: executionError });
                } else if (code === 'BAD_DATA') { // Handle the BAD_DATA error specifically
                    throw new ArbitrageError(`Transaction data invalid (BAD_DATA): ${executionError.message}`, 'BAD_DATA_ERROR', { originalError: executionError });
                }
                // --- *** END MODIFICATION *** ---

                // For other errors, wrap them generically
                 throw new ArbitrageError(`Transaction execution failed: ${executionError.message}`, 'EXECUTION_ERROR', { originalError: executionError });
            }
        } // End else (LIVE mode)

    } catch (error) { // Catch errors from nonce fetching or re-thrown errors
        if (!(error instanceof ArbitrageError)) { handleError(error, 'TxExecutor Unexpected', logger); return { success: false, txHash: null, error: new ArbitrageError(`Unexpected Executor error: ${error.message}`, 'UNKNOWN_EXECUTION_ERROR', { originalError: error }) }; }
        else { logger.error(`${functionSig} Execution failed: ${error.message} (Type: ${error.type}, Code: ${error.code || 'N/A'})`); return { success: false, txHash: null, error: error }; }
    } // End outer try/catch
} // End executeTransaction

module.exports = { executeTransaction };
