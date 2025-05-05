// core/tx/txExecutor.js
// Handles the actual execution of a transaction on the blockchain.
// --- VERSION v1.5 --- Adjusted executeTransaction signature to accept functionName/Args, calls Encoder internally.

const { ethers } = require('ethers');
const logger = require('../../utils/logger');
const { ArbitrageError, handleError } = require('../../utils/errorHandler'); // Import error handling
// Assuming provider utility is still available and necessary for provider.call in _handleTransactionOutcome
// const { getProvider } = require('../../utils/provider'); // Not needed if provider is passed in constructor
// Import the Encoder utility - TxExecutor needs to encode the final calldata
const { encodeFlashSwapCall } = require('./encoder'); // <-- NEW IMPORT


class TxExecutor {
    /**
     * @param {object} config - Application configuration.
     * @param {ethers.Provider} provider - Ethers provider.
     * @param {object} nonceManager - The NonceManager instance wrapping the signer.
     */
    constructor(config, provider, nonceManager) {
        logger.debug('[TxExecutor v1.5 Init] Initializing...'); // Version bump
        if (!config || !provider || !nonceManager) throw new ArbitrageError('TxExecutorInit', 'Config, Provider, and NonceManager required.');
        // Validate NonceManager has expected methods
        if (!nonceManager.signer || typeof nonceManager.sendTransaction !== 'function' || typeof nonceManager.getAddress !== 'function') {
             throw new ArbitrageError('TxExecutorInit', 'Invalid NonceManager instance provided (missing signer, sendTransaction, or getAddress).');
        }
         // Validate Encoder function exists
         if (typeof encodeFlashSwapCall !== 'function') {
             logger.error('[TxExecutor Init] CRITICAL: encodeFlashSwapCall function not found. Is ./encoder.js imported correctly and exporting encodeFlashSwapCall?');
             throw new Error('TxExecutor Init: encodeFlashSwapCall function not available.');
         }


        this.config = config;
        this.provider = provider;
        this.nonceManager = nonceManager; // Store the NonceManager instance
        this.numConfirmations = config.TX_CONFIRMATIONS || 1; // Read confirmations from config

        logger.info('[TxExecutor v1.5 Init] Initialized. Confirmations required: %d', this.numConfirmations); // Version bump
    }

    /**
     * Handles the dry run scenario, logging transaction details without sending.
     * @param {string} toAddress - The recipient address.
     * @param {string} calldata - The ABI-encoded function call data. // Takes calldata directly after it's generated
     * @param {bigint} estimatedGasLimit - The estimated gas limit.
     * @param {bigint} effectiveGasPrice - The effective gas price (derived from feeData for log).
     * @param {string} logPrefix - Logging prefix.
     */
    async _handleDryRun(toAddress, calldata, estimatedGasLimit, effectiveGasPrice, logPrefix) {
        logger.info(`${logPrefix} DRY RUN mode enabled. Skipping transaction broadcast.`);
        const txDetails = {
             to: toAddress,
             data: calldata,
             gasLimit: estimatedGasLimit?.toString() || 'N/A',
             gasPrice: effectiveGasPrice ? ethers.formatUnits(effectiveGasPrice, 'gwei') + ' Gwei' : 'N/A',
             from: await this.nonceManager.getAddress() // Get the signer's address
        };
        logger.debug(`${logPrefix} Dry Run Tx Details:`, txDetails);
    }

    /**
     * Validates the required input parameters for transaction execution *before* sending.
     * Note: Calldata encoding itself is handled by the Encoder utility and validated there.
     * @param {string} toAddress - The recipient address.
     * @param {bigint} estimatedGasLimit - The estimated gas limit.
     * @param {object} feeData - Ethers FeeData object.
     * @param {string} logPrefix - Logging prefix.
     * @throws {ArbitrageError} If inputs are invalid.
     */
    _validateExecutionInputs(toAddress, estimatedGasLimit, feeData, logPrefix) {
         logger.debug(`${logPrefix} Validating execution inputs...`);

         if (!toAddress || !ethers.isAddress(toAddress)) {
              const errorMsg = `Invalid toAddress received: ${toAddress}.`;
              logger.error(`${logPrefix} ${errorMsg}`);
              throw new ArbitrageError('TxExecutionError:InvalidInput', errorMsg);
         }

         // Ensure gas parameters are valid BigInts and positive
         if (typeof estimatedGasLimit !== 'bigint' || estimatedGasLimit <= 0n) {
              const errorMsg = `Invalid estimatedGasLimit received: ${estimatedGasLimit}.`;
              logger.error(`${logPrefix} ${errorMsg}`);
              throw new ArbitrageError('TxExecutionError:InvalidInput', errorMsg);
         }
          // Validate feeData presence and structure
         if (!feeData || (!feeData.gasPrice && !feeData.maxFeePerGas)) {
              const errorMsg = `Invalid or incomplete feeData received for execution.`;
              logger.error(`${logPrefix} ${errorMsg}`, { feeData });
              throw new ArbitrageError('TxExecutionError:InvalidInput', errorMsg);
         }

         logger.debug(`${logPrefix} Inputs validated.`);
    }

    /**
     * Builds the transaction object using fee data.
     * @param {string} toAddress - The recipient address.
     * @param {string} calldata - The ABI-encoded function call data.
     * @param {bigint} gasLimit - The gas limit.
     * @param {object} feeData - Ethers FeeData object.
     * @returns {ethers.TransactionRequest} The transaction object.
     */
    _buildTransactionObject(toAddress, calldata, gasLimit, feeData) {
        // Prepare the transaction object
        const tx = {
            to: toAddress,
            data: calldata, // The encoded function call
            gasLimit: gasLimit, // Use the estimated limit
            // Apply EIP-1559 fees if available, otherwise fallback to gasPrice
            ...(feeData.maxFeePerGas && feeData.maxPriorityFeePerGas ?
                { maxFeePerGas: feeData.maxFeePerGas, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas } :
                { gasPrice: feeData.gasPrice } // Use gasPrice for legacy or if EIP-1559 fees aren't provided
            ),
            // value: 0n is default
            // chainId: this.config.CHAIN_ID, // NonceManager/Signer should handle chainId
        };
        return tx;
    }


    /**
     * Sends the transaction and waits for a specified number of confirmations.
     * @param {ethers.TransactionRequest} tx - The transaction object.
     * @param {string} logPrefix - Logging prefix.
     * @returns {Promise<{txResponse: ethers.TransactionResponse, receipt: ethers.TransactionReceipt | null}>} Transaction response and receipt (receipt can be null if wait fails).
     * @throws {Error} If sending fails or waiting times out/errors.
     */
    async _sendAndWaitForConfirmation(tx, logPrefix) {
        logger.info(`${logPrefix} Broadcasting transaction... Gas Limit: ${tx.gasLimit?.toString()}, ${tx.maxFeePerGas ? 'Max Fee' : 'Gas Price'}: ${ethers.formatUnits(tx.maxFeePerGas || tx.gasPrice || 0n, 'gwei')} Gwei`);
        logger.debug(`${logPrefix} Raw Tx Data Snippet: ${tx.data?.substring(0, 100)}...`);

        // Send the transaction using the NonceManager's wrapped signer
        // NonceManager.sendTransaction handles nonce management and potentially retries
        const txResponse = await this.nonceManager.sendTransaction(tx);

        logger.info(`${logPrefix} Transaction sent! Hash: ${txResponse.hash}`);
        logger.debug(`${logPrefix} Tx Nonce: ${txResponse.nonce}`);


        // Wait for the transaction to be mined and confirmed
        logger.info(`${logPrefix} Waiting for ${this.numConfirmations} confirmation(s) for Tx: ${txResponse.hash}`);

        let receipt = null;
        try {
            receipt = await txResponse.wait(this.numConfirmations);
        } catch (waitError) {
             logger.error(`${logPrefix} Error waiting for transaction receipt (Tx: ${txResponse.hash}): ${waitError.message}`, waitError);
             // Re-throw the error after logging
             throw waitError;
        }

        return { txResponse, receipt };
    }

    /**
     * Handles the outcome of a confirmed transaction based on its receipt status.
     * Decodes revert reason if the transaction failed.
     * @param {ethers.TransactionReceipt} receipt - The transaction receipt.
     * @param {ethers.TransactionResponse} txResponse - The transaction response object. // Pass txResponse for revert reason decoding
     * @param {string} logPrefix - Logging prefix.
     * @returns {Promise<{success: boolean, txHash: string, receipt: ethers.TransactionReceipt | null, error?: Error}>} Object indicating success/failure with details.
     */
    async _handleTransactionOutcome(receipt, txResponse, logPrefix) {
        if (receipt?.status === 1) {
            logger.info(`${logPrefix} Transaction successful! Tx Hash: ${receipt.hash}, Block: ${receipt.blockNumber}`);
            logger.debug(`${logPrefix} Gas Used: ${receipt.gasUsed.toString()}`);
            // You might want to emit an event here: this.emit('transactionSuccessful', receipt);
            return { success: true, txHash: receipt.hash, receipt: receipt }; // Return success object
        } else {
            // Transaction failed (e.g., reverted)
             const errorMsg = `Transaction failed (status ${receipt?.status || 'N/A'}) or reverted. Tx Hash: ${receipt?.hash || 'N/A'}, Block: ${receipt?.blockNumber || 'N/A'}, Gas Used: ${receipt?.gasUsed?.toString() || 'N/A'}.`;
             logger.error(`${logPrefix} ${errorMsg}`);

             // Attempt to decode the revert reason if possible
             let revertReason = "Unknown revert reason";
             if (txResponse && receipt) { // Ensure we have response and receipt to simulate
                 try {
                      // Use provider.call to simulate the transaction *in the block it was mined*.
                      const failedTx = {
                           to: txResponse.to,
                           from: txResponse.from, // Need 'from' address for simulation
                           data: txResponse.data,
                           value: txResponse.value,
                           gasLimit: txResponse.gasLimit, // Use original gas limit
                           // Include gas price/fees from original response
                           gasPrice: txResponse.gasPrice,
                           maxFeePerGas: (txResponse).maxFeePerGas,
                           maxPriorityFeePerGas: (txResponse).maxPriorityFeePerGas,
                      };
                      // Use provider.call with the transaction details and the block number
                     await this.provider.call(failedTx, receipt.blockNumber);
                     // If provider.call succeeds here, it means the simulation didn't revert, which is unexpected if receipt.status is not 1.
                     // This case is unlikely if the receipt correctly reported failure.
                     revertReason = "Provider.call did not revert - reason decoding failed?";

                 } catch (revertError) {
                      // This catch is expected if the transaction reverted
                      revertReason = revertError.reason || revertError.code || revertError.message || JSON.stringify(revertError);
                      logger.error(`${logPrefix} Revert Reason: ${revertReason}`);
                      errorMsg += ` Revert Reason: ${revertReason}`;
                 }
             } else {
                  logger.debug(`${logPrefix} Cannot decode revert reason: Missing txResponse or receipt.`);
             }

            // Log the failure using the central error handler for consistency
             const txFailureError = new Error(errorMsg);
             txFailureError.type = 'TxExecutionError: Reverted';
             txFailureError.details = { txHash: receipt?.hash, blockNumber: receipt?.blockNumber, gasUsed: receipt?.gasUsed?.toString(), revertReason: revertReason };
             handleError(txFailureError, 'TxExecutionFailed');

             // Return a failure object
             return { success: false, txHash: receipt?.hash || 'N/A', receipt: receipt, error: txFailureError };
        }
    }


    /**
     * Sends a transaction to the blockchain and waits for confirmation.
     * This is the main public method called by the TradeHandler.
     * It takes function name and args and encodes calldata internally.
     *
     * @param {string} toAddress - The recipient address (FlashSwap contract address).
     * @param {string} functionName - The name of the function to call on FlashSwap.sol.
     * @param {Array<any>} functionArgs - The arguments for the function call.
     * @param {bigint} estimatedGasLimit - The estimated gas limit for the transaction (BigInt).
     * @param {object} feeData - Ethers FeeData object containing gas price info.
     * @param {string} opportunityDetails - A summary string of the opportunity for logging.
     * @param {boolean} isDryRun - Flag indicating if this is a dry run (don't actually send tx).
     * @returns {Promise<{success: boolean, txHash?: string, receipt?: ethers.TransactionReceipt, error?: Error}>} Object indicating success/failure with details.
     * @throws {ArbitrageError} If there's a critical error during transaction preparation or sending/waiting.
     */
    async executeTransaction(
        toAddress,
        functionName,
        functionArgs,
        estimatedGasLimit,
        feeData,
        opportunityDetails = "Opportunity",
        isDryRun = false
    ) {
        const logPrefix = `[TxExecutor ${opportunityDetails}]`;
        logger.info(`${logPrefix} Preparing transaction for execution...`);

        let calldata;
        try {
            // --- Encode Calldata ---
             // Uses the imported encodeFlashSwapCall utility
             calldata = encodeFlashSwapCall(functionName, functionArgs);
             logger.debug(`${logPrefix} Calldata encoded successfully.`);

             // --- Validate Inputs (now that calldata is ready) ---
            this._validateExecutionInputs(toAddress, estimatedGasLimit, feeData, logPrefix);

        } catch (prepError) {
             // Catch errors from encoding or validation
             logger.error(`${logPrefix} Error during transaction preparation: ${prepError.message}`, prepError);
             const preparationError = new Error(`Tx preparation failed: ${prepError.message}`);
             preparationError.type = prepError.type || 'TxExecutionError:Preparation';
             preparationError.details = { originalError: prepError, functionName, functionArgs };
             handleError(preparationError, 'TxExecutionPreparationFailed');
             throw preparationError; // Re-throw after handling
        }


        if (isDryRun) {
            // Pass calldata directly to dry run handler
            const effectiveGasPriceForLog = feeData.gasPrice || feeData.maxFeePerGas; // Choose one for log
            await this._handleDryRun(toAddress, calldata, estimatedGasLimit, effectiveGasPriceForLog, logPrefix);
            // Return a dry run specific result format
            return { success: true, txHash: 'DRY_RUN', receipt: null, error: null };
        }

        let txResponse = null;
        let receipt = null;

        try {
            // Build the transaction object using the provided feeData and the encoded calldata
            const tx = this._buildTransactionObject(toAddress, calldata, estimatedGasLimit, feeData);

            // Send the transaction and wait for confirmation
            ({ txResponse, receipt } = await this._sendAndWaitForConfirmation(tx, logPrefix));

            // Handle the transaction outcome (success or failure) using the received receipt and response
            return await this._handleTransactionOutcome(receipt, txResponse, logPrefix);


        } catch (error) {
            // Handle errors during sending or waiting (e.g., network issues, nonce problems, wait timeout)
            // Errors from _sendAndWaitForConfirmation are already logged there, but we catch
            // them here for consistent top-level error handling and potential re-throwing.
            logger.error(`${logPrefix} Uncaught error during transaction execution attempt: ${error.message}`, error);

            const executionError = new Error(`Error executing transaction: ${error.message}`);
            executionError.type = error.type || 'TxExecutionError: Send/Wait Failed'; // Preserve custom types
            executionError.details = {
                 originalError: error,
                 txHash: txResponse?.hash || 'N/A', // Include tx hash if available
                 // Include tx options used if available on the error object (Ethers might attach)
                 txOptions: error.tx ? { to: error.tx.to, data: error.tx.data?.substring(0, 100) + '...', gasLimit: error.tx.gasLimit?.toString(), gasPrice: error.tx.gasPrice?.toString() } : {}
            };
            handleError(executionError, 'TxExecutionError');

            // Re-throw the error so the calling function (TradeHandler) can handle it if needed
            throw error;
        }
    }

    // Add other methods like signing messages if needed later.
}

// Export the class
module.exports = TxExecutor;
