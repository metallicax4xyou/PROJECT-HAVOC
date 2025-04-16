// core/flashSwapManager.js

const { ethers, Wallet, Contract } = require('ethers');
const config = require('../config');
const NonceManager = require('../utils/nonceManager');
const { getProvider } = require('../utils/provider'); // Import the provider getter from utils
const logger = require('../utils/logger');
const FlashSwapABI = require('../abis/FlashSwap.json');
const { ArbitrageError, handleError } = require('../utils/errorHandler');

class FlashSwapManager {
    constructor() {
        this.config = config;
        // --->>> Get the provider instance via the utility function <<<---
        this.provider = getProvider(); // Initialize this.provider

        if (!this.config.PRIVATE_KEY) {
            throw new ArbitrageError('BotInitialization', 'Private key not found in configuration.');
        }
        if (!this.config.FLASH_SWAP_CONTRACT_ADDRESS || this.config.FLASH_SWAP_CONTRACT_ADDRESS === ethers.ZeroAddress) {
             throw new ArbitrageError('BotInitialization', 'Flash Swap contract address not found or is ZeroAddress in configuration.');
        }

        try {
            const baseWallet = new Wallet(this.config.PRIVATE_KEY, this.provider);
            this.signer = new NonceManager(baseWallet);
            logger.info(`[NonceManager] Initialized for signer: ${this.signer.address}`);

            this.flashSwapContract = new Contract(
                this.config.FLASH_SWAP_CONTRACT_ADDRESS,
                FlashSwapABI,
                this.signer
            );
            logger.info(`[FlashSwap] Connected to FlashSwap contract at ${this.config.FLASH_SWAP_CONTRACT_ADDRESS}`);

        } catch (error) {
             const errorMessage = error.message || 'Unknown error during Signer/Contract setup';
             logger.error(`[FlashSwapManager Init Error] ${errorMessage}`, error);
             const errorContext = error.code ? `Ethers error: ${errorMessage} (Code: ${error.code})` : `Error: ${errorMessage}`;
             throw new ArbitrageError('BotInitialization', `Error setting up Signer/Contract: ${errorContext}`, error);
        }
    }

    // --->>> ADDED THIS METHOD <<<---
    /**
     * Returns the provider instance used by this manager.
     * @returns {ethers.Provider} The provider instance.
     */
    getProvider() {
        return this.provider;
    }
    // --->>> --- <<<---

    // --->>> Added method to get signer <<<---
    /**
     * Returns the signer instance (nonce-managed) used by this manager.
     * @returns {NonceManager} The signer instance.
     */
     getSigner() {
          return this.signer;
     }
     // --->>> --- <<<---

     // --->>> Added method to get contract <<<---
     /**
      * Returns the FlashSwap contract instance.
      * @returns {ethers.Contract} The contract instance.
      */
      getFlashSwapContract() {
           return this.flashSwapContract;
      }
      // --->>> --- <<<---

      // --->>> Added method to get next nonce <<<---
      /**
       * Gets the next nonce from the managed signer.
       * @returns {Promise<number>} The next nonce.
       */
       async getNextNonce() {
            if (this.signer && typeof this.signer.getNonce === 'function') {
                 return await this.signer.getNonce('latest'); // Or 'pending' based on strategy
            } else {
                 logger.error("[FlashSwapManager] Signer or getNonce method not available!");
                 // Fallback or throw error - might need manual check if NonceManager fails
                 const baseNonce = await this.provider.getTransactionCount(this.signer.address, 'latest');
                 logger.warn(`[FlashSwapManager] Falling back to provider.getTransactionCount: ${baseNonce}`);
                 return baseNonce;
            }
       }
       // --->>> --- <<<---


    /**
     * Executes the flash swap via the smart contract.
     * @param {string} borrowTokenAddress - The address of the token to borrow.
     * @param {BigInt} borrowAmount - The amount of the token to borrow.
     * @param {Array<object>} swapRoute - An array defining the swaps: [{ pool: string, tokenIn: string, tokenOut: string, fee: number }]
     * @param {ethers.BigNumberish} estimatedGasLimit - Estimated gas limit for the transaction.
     * @param {ethers.BigNumberish} gasPrice - The gas price to use for the transaction (Note: might be maxFeePerGas/maxPriorityFeePerGas).
     * @returns {Promise<ethers.TransactionResponse | null>} Transaction response or null if dry run/error.
     */
    async executeFlashSwap(borrowTokenAddress, borrowAmount, swapRoute, estimatedGasLimit, gasParams) {
        // IMPORTANT: This function signature might need adjustment based on how gasParams (maxFee/maxPriority) are handled
        // For now, assuming gasParams contains { maxFeePerGas, maxPriorityFeePerGas }

        if (this.config.DRY_RUN) {
            logger.warn(`[DryRun] Would execute flash swap on ${this.config.FLASH_SWAP_CONTRACT_ADDRESS}`);
            const borrowTokenSymbol = this.getTokenSymbol(borrowTokenAddress);
            const borrowTokenDecimals = this.config.TOKENS[borrowTokenSymbol]?.decimals ?? 18;
            logger.warn(`[DryRun]  - Borrow Amount: ${ethers.formatUnits(borrowAmount, borrowTokenDecimals)} ${borrowTokenSymbol}`);
            logger.warn(`[DryRun]  - Swap Route: ${JSON.stringify(swapRoute)}`);
            logger.warn(`[DryRun]  - Est. Gas Limit: ${estimatedGasLimit}`);
            logger.warn(`[DryRun]  - Gas Fees: maxFee=${ethers.formatUnits(gasParams.maxFeePerGas || 0, 'gwei')} Gwei, maxPriorityFee=${ethers.formatUnits(gasParams.maxPriorityFeePerGas || 0, 'gwei')} Gwei`);
            return null;
        }

        try {
            const path = swapRoute.map(swap => ({
                pool: swap.pool,
                tokenIn: swap.tokenIn,
                tokenOut: swap.tokenOut,
                fee: swap.fee
            }));

            const borrowTokenSymbol = this.getTokenSymbol(borrowTokenAddress);
            logger.info(`[FlashSwap] Attempting flash swap... Borrow: ${ethers.formatUnits(borrowAmount, this.config.TOKENS[borrowTokenSymbol]?.decimals ?? 18)} ${borrowTokenSymbol}`);

            let gasLimit = estimatedGasLimit;
            logger.debug(`[FlashSwap] Using provided gas limit estimate: ${gasLimit}`);

            const nonce = await this.getNextNonce(); // Use helper method
            logger.info(`[FlashSwap] Using nonce: ${nonce}`);

            // Prepare transaction overrides using EIP-1559 fields if available
            const txOverrides = {
                 gasLimit: gasLimit,
                 nonce: nonce,
                 maxFeePerGas: gasParams.maxFeePerGas,
                 maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas
             };
             // Remove nullish values that ethers might complain about
             if (!txOverrides.maxFeePerGas) delete txOverrides.maxFeePerGas;
             if (!txOverrides.maxPriorityFeePerGas) delete txOverrides.maxPriorityFeePerGas;
             // If neither EIP-1559 field is set, maybe use legacy gasPrice (needs gasParams to include it)
             // if (!txOverrides.maxFeePerGas && !txOverrides.maxPriorityFeePerGas && gasParams.gasPrice) {
             //     txOverrides.gasPrice = gasParams.gasPrice;
             // }


            const tx = await this.flashSwapContract.executeFlashSwap(
                borrowTokenAddress,
                borrowAmount,
                path,
                txOverrides // Pass the prepared overrides
            );

            logger.info(`[FlashSwap] Transaction sent! Hash: ${tx.hash}`);
            logger.info(`[FlashSwap]   Nonce: ${tx.nonce}, Gas Limit: ${tx.gasLimit}`);
             if(tx.maxFeePerGas) logger.info(`[FlashSwap]   Max Fee Per Gas: ${ethers.formatUnits(tx.maxFeePerGas, 'gwei')} Gwei`);
             if(tx.maxPriorityFeePerGas) logger.info(`[FlashSwap]   Max Priority Fee Per Gas: ${ethers.formatUnits(tx.maxPriorityFeePerGas, 'gwei')} Gwei`);
             if(tx.gasPrice) logger.info(`[FlashSwap]   Gas Price (Legacy): ${ethers.formatUnits(tx.gasPrice, 'gwei')} Gwei`);

            return tx;

        } catch (error) {
            const errorMessage = error.reason || error.message;
            logger.error(`[FlashSwap] Error executing flash swap: ${errorMessage}`, { code: error.code });
            // Rethrow as ArbitrageError for consistent handling upstream
            throw new ArbitrageError('TransactionExecution', `Flash swap execution failed: ${errorMessage}`, error);
        }
    }

    // Helper to get token symbol from address
    getTokenSymbol(address) {
       const checkAddress = ethers.getAddress(address);
       for (const symbol in this.config.TOKENS) {
           if (ethers.getAddress(this.config.TOKENS[symbol].address) === checkAddress) {
               return symbol;
           }
       }
       logger.warn(`[getTokenSymbol] Symbol not found in config for address: ${address}`);
       return address;
    }
}

module.exports = FlashSwapManager;
