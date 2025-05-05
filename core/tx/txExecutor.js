// core/tx/txExecutor.js
// Handles the actual execution of a transaction on the blockchain.
// --- VERSION v1.4 --- Refactored executeTransaction into helper methods.

const { ethers } = require('ethers');
const logger = require('../../utils/logger');
const { ArbitrageError, handleError } = require('../../utils/errorHandler'); // Import error handling
// Assuming provider utility is still available and necessary for provider.call in _handleTransactionOutcome
// const { getProvider } = require('../../utils/provider'); // Not needed if provider is passed in constructor


class TxExecutor {
    /**
     * @param {object} config - Application configuration.
     * @param {ethers.Provider} provider - Ethers provider.
     * @param {object} nonceManager - The NonceManager instance wrapping the signer.
     */
    constructor(config, provider, nonceManager) {
        logger.debug('[TxExecutor v1.4 Init] Initializing...'); // Version bump
        if (!config || !provider || !nonceManager) throw new ArbitrageError('TxExecutorInit', 'Config, Provider, and NonceManager required.');
        if (!nonceManager.signer || typeof nonceManager.sendTransaction !== 'function' || typeof nonceManager.getAddress !== 'function') { // Check for sendTransaction method
             throw new ArbitrageError('TxExecutorInit', 'Invalid NonceManager instance provided (missing signer, sendTransaction, or getAddress).');
        }

        this.config = config;
        this.provider = provider;
        this.nonceManager = nonceManager; // Store the NonceManager instance
        this.numConfirmations = config.TX_CONFIRMATIONS || 1; // Read confirmations from config

        logger.info('[TxExecutor v1.4 Init] Initialized. Confirmations required: %d', this.numConfirmations); // Version bump
    }

    /**
     * Handles the dry run scenario, logging transaction details without sending.
     * @param {string} toAddress - The recipient address.
     * @param {string} calldata - The ABI-encoded function call data.
     * @param {bigint} estimatedGasLimit - The estimated gas limit.
     * @param {bigint} effectiveGasPrice - The effective gas price.
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
     * Validates the required input parameters for transaction execution.
     * @param {bigint} estimatedGasLimit - The estimated gas limit.
     * @param {bigint} effectiveGasPrice - The effective gas price.
     * @param {string} logPrefix - Logging prefix.
     * @throws {ArbitrageError} If inputs are invalid.
     */
    _validateExecutionInputs(estimatedGasLimit, effectiveGasPrice, logPrefix) {
         logger.debug(`${logPrefix} Validating execution inputs...`);
         // Ensure gas parameters are valid BigInts and positive
         if (typeof estimatedGasLimit !== 'bigint' || estimatedGasLimit <= 0n) {
              const errorMsg = `Invalid estimatedGasLimit received: ${estimatedGasLimit}.`;
              logger.error(`${logPrefix} ${errorMsg}`);
              throw new ArbitrageError('TxExecutionError:InvalidInput', errorMsg);
         }
         // Note: effectiveGasPrice might be 0n on some dev chains or if using baseFee/priorityFee,
         // but for simplicity and robustness, let's assume it should be positive or handle 0n cases explicitly if needed.
         // For now, keeping the check simple based on the previous version.
         if (typeof effectiveGasPrice !== 'bigint' || effectiveGasPrice <= 0n) {
              const errorMsg = `Invalid effectiveGasPrice received: ${effectiveGasPrice}.`;
              logger.error(`${logPrefix} ${errorMsg}`);
              throw new ArbitrageError('TxExecutionError:InvalidInput', errorMsg);
         }
         logger.debug(`${logPrefix} Inputs validated.`);
    }

    /**
     * Builds the transaction object.
     * @param {string} toAddress - The recipient address.
     * @param {string} calldata - The ABI-encoded function call data.
     * @param {bigint} gasLimit - The gas limit.
     * @param {bigint} gasPrice - The gas price.
     * @returns {ethers.TransactionRequest} The transaction object.
     */
    _buildTransactionObject(toAddress, calldata, gasLimit, gasPrice) {
        // Prepare the transaction object
        const tx = {
            to: toAddress,
            data: calldata, // The encoded function call
            gasLimit: gasLimit, // Use the estimated limit
            // Use gasPrice for legacy transactions, or maxFeePerGas/maxPriorityFeePerGas for EIP-1559
            // For simplicity with Hardhat node, gasPrice is often sufficient.
            // If targeting Arbitrum mainnet with EIP-1559, you'd set maxFeePerGas and maxPriorityFeePerGas here
            gasPrice: gasPrice, // Use the effective gas price
            // value: 0n, // Flash loans typically don't require sending ETH with the initial tx
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
        logger.info(`${logPrefix} Broadcasting transaction... Gas Limit: ${tx.gasLimit?.toString()}, Gas Price: ${tx.gasPrice ? ethers.formatUnits(tx.gasPrice, 'gwei') + ' Gwei' : 'N/A'}`);
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
     * @param {ethers.TransactionResponse} txResponse - The transaction response object.
     * @param {string} logPrefix - Logging prefix.
     * @returns {Promise<ethers.TransactionReceipt | null>} The receipt if successful, null if failed.
     */
    async _handleTransactionOutcome(receipt, txResponse, logPrefix) {
        if (receipt?.status === 1) {
            logger.info(`${logPrefix} Transaction successful! Tx Hash: ${receipt.hash}, Block: ${receipt.blockNumber}`);
            logger.debug(`${logPrefix} Gas Used: ${receipt.gasUsed.toString()}`);
            // You might want to emit an event here: this.emit('transactionSuccessful', receipt);
            return receipt; // Return the transaction receipt on success
        } else {
            // Transaction failed (e.g., reverted)
             const errorMsg = `Transaction failed (status ${receipt?.status || 'N/A'}) or reverted. Tx Hash: ${receipt?.hash || 'N/A'}, Block: ${receipt?.blockNumber || 'N/A'}, Gas Used: ${receipt?.gasUsed?.toString() || 'N/A'}.`;
             logger.error(`${logPrefix} ${errorMsg}`);

             // Attempt to decode the revert reason if possible
             let revertReason = "Unknown revert reason";
             if (txResponse && receipt) { // Ensure we have response and receipt to simulate
                 try {
                      // Use provider.call to simulate the transaction *in the block it was mined*.
                      // This is the standard way to get revert reasons for mined transactions.
                      // We need the original transaction request details and the block number.
                      // The txResponse should contain the original tx details.
                      // The receipt provides the block number.
                      const failedTx = {
                           to: txResponse.to,
                           from: txResponse.from, // Need 'from' address for simulation
                           data: txResponse.data,
                           value: txResponse.value,
                           gasLimit: txResponse.gasLimit, // Use original gas limit
                           gasPrice: txResponse.gasPrice, // Use original gas price
                           // Add other EIP-1559 fields if applicable
                           maxFeePerGas: (txResponse).maxFeePerGas,
                           maxPriorityFeePerGas: (txResponse).maxPriorityFeePerGas,
                           // Include nonce? Not strictly necessary for provider.call, but good practice
                           nonce: txResponse.nonce
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

             // Return null to indicate failure to the caller (TradeHandler)
             return null;
        }
    }


    /**
     * Sends a transaction to the blockchain and waits for confirmation.
     * This is the main public method called by the TradeHandler.
     *
     * @param {string} toAddress - The recipient address (FlashSwap contract address).
     * @param {string} calldata - The ABI-encoded function call data for the transaction.
     * @param {bigint} estimatedGasLimit - The estimated gas limit for the transaction (BigInt).
     * @param {object} feeData - Ethers FeeData object containing gas price info.
     * @param {string} opportunityDetails - A summary string of the opportunity for logging.
     * @param {boolean} isDryRun - Flag indicating if this is a dry run (don't actually send tx).
     * @returns {Promise<ethers.TransactionReceipt | null>} The transaction receipt on success, or null on failure or if in dry run mode.
     * @throws {ArbitrageError} If there's a critical error during transaction execution.
     */
    async executeTransaction(
        toAddress,
        calldata,
        estimatedGasLimit,
        // effectiveGasPrice, // Removed - use feeData instead for EIP-1559 compatibility
        feeData, // Pass feeData object instead of single effective price
        opportunityDetails = "Opportunity", // Default for logging
        isDryRun = false // Default to not dry run
    ) {
        const logPrefix = `[TxExecutor ${opportunityDetails}]`; // Add opportunity context to logs
        logger.info(`${logPrefix} Preparing transaction for execution...`);

        // Pass estimatedGasLimit, but derive gas price/fees from feeData within the tx object
        this._validateExecutionInputs(estimatedGasLimit, feeData.gasPrice || feeData.maxFeePerGas, logPrefix); // Validate at least one fee type

        if (isDryRun) {
            // Pass relevant fee data for dry run logging
            const effectiveGasPriceForLog = feeData.gasPrice || feeData.maxFeePerGas; // Choose one for log
            await this._handleDryRun(toAddress, calldata, estimatedGasLimit, effectiveGasPriceForLog, logPrefix);
            return null; // Return null for dry run
        }

        let txResponse = null;
        let receipt = null;

        try {
            // Build the transaction object using the provided feeData
            const tx = {
                to: toAddress,
                data: calldata,
                gasLimit: estimatedGasLimit,
                // Apply EIP-1559 fees if available, otherwise fallback to gasPrice
                ...(feeData.maxFeePerGas && feeData.maxPriorityFeePerGas ?
                    { maxFeePerGas: feeData.maxFeePerGas, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas } :
                    { gasPrice: feeData.gasPrice } // Use gasPrice for legacy or if EIP-1559 fees aren't provided
                ),
                // value: 0n is default
            };

            // Send the transaction and wait for confirmation
            ({ txResponse, receipt } = await this._sendAndWaitForConfirmation(tx, logPrefix));

            // Handle the transaction outcome (success or failure)
            return await this._handleTransactionOutcome(receipt, txResponse, logPrefix);


        } catch (error) {
            // Handle errors during sending or waiting (e.g., network issues, nonce problems, wait timeout)
            // The specific errors from _sendAndWaitForConfirmation are already logged there, but we catch
            // them here to ensure consistent top-level error handling and potential re-throwing.
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
