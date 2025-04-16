// core/flashSwapManager.js

const { ethers, Wallet, Contract } = require('ethers');
const config = require('../config'); // Import the config object directly
const NonceManager = require('../utils/nonceManager'); // Use our custom NonceManager
const { getProvider } = require('../utils/provider'); // Import the provider getter
// --- Corrected Logger Import ---
const logger = require('../utils/logger'); // Import the logger object directly
// --- ---
const FlashSwapABI = require('../abis/FlashSwap.json'); // Load ABI
const { ArbitrageError, handleError } = require('../utils/errorHandler');

class FlashSwapManager {
    constructor() {
        this.config = config; // Assign the imported object
        this.provider = getProvider(); // Get the provider instance

        if (!this.config.PRIVATE_KEY) {
            throw new ArbitrageError(
                'BotInitialization',
                'Private key not found in configuration.'
            );
        }
        if (!this.config.FLASH_SWAP_CONTRACT_ADDRESS || this.config.FLASH_SWAP_CONTRACT_ADDRESS === ethers.ZeroAddress) {
             throw new ArbitrageError(
                 'BotInitialization',
                 'Flash Swap contract address not found or is ZeroAddress in configuration.'
             );
        }

        try {
            // Wrap the base wallet with our custom nonce manager
            const baseWallet = new Wallet(this.config.PRIVATE_KEY, this.provider);
            // Use the custom NonceManager, passing the base Wallet instance
            this.signer = new NonceManager(baseWallet);
            // --->>> This line should now work <<<---
            logger.info(`[NonceManager] Initialized for signer: ${this.signer.address}`);

            this.flashSwapContract = new Contract(
                this.config.FLASH_SWAP_CONTRACT_ADDRESS,
                FlashSwapABI,
                this.signer // Use the nonce-managed signer
            );
            logger.info(`[FlashSwap] Connected to FlashSwap contract at ${this.config.FLASH_SWAP_CONTRACT_ADDRESS}`);

        } catch (error) {
            // Catch specific ethers errors or general errors during setup
             const errorMessage = error.message || 'Unknown error during Signer/Contract setup';
             // Log the specific error causing the issue (might be the logger line if it was still wrong)
             logger.error(`[FlashSwapManager Init Error] ${errorMessage}`, error);

            if (error.code) { // Ethers errors often have a code
                 throw new ArbitrageError(
                     'BotInitialization',
                     `Ethers error during Signer/Contract setup: ${errorMessage} (Code: ${error.code})`,
                     error
                 );
            } else {
                 throw new ArbitrageError(
                     'BotInitialization',
                     `Error setting up Signer/Contract: ${errorMessage}`,
                     error // Pass the original TypeError or other error
                 );
            }
        }
    }

    /**
     * Executes the flash swap via the smart contract.
     * @param {string} borrowTokenAddress - The address of the token to borrow.
     * @param {BigInt} borrowAmount - The amount of the token to borrow.
     * @param {Array<object>} swapRoute - An array defining the swaps: [{ pool: string, tokenIn: string, tokenOut: string, fee: number }]
     * @param {ethers.BigNumberish} estimatedGasLimit - Estimated gas limit for the transaction.
     * @param {ethers.BigNumberish} gasPrice - The gas price to use for the transaction.
     * @returns {Promise<ethers.TransactionResponse | null>} Transaction response or null if dry run/error.
     */
    async executeFlashSwap(borrowTokenAddress, borrowAmount, swapRoute, estimatedGasLimit, gasPrice) {
        if (this.config.DRY_RUN) {
            // Use logger correctly here too
            logger.warn(`[DryRun] Would execute flash swap on ${this.config.FLASH_SWAP_CONTRACT_ADDRESS}`);
            logger.warn(`[DryRun]  - Borrow Token: ${borrowTokenAddress}`);
            // Ensure getTokenSymbol helper exists or handle symbol lookup robustly
            const borrowTokenSymbol = this.getTokenSymbol(borrowTokenAddress);
            const borrowTokenDecimals = this.config.TOKENS[borrowTokenSymbol]?.decimals ?? 18; // Default to 18 if symbol not found
            logger.warn(`[DryRun]  - Borrow Amount: ${ethers.formatUnits(borrowAmount, borrowTokenDecimals)} ${borrowTokenSymbol}`);
            logger.warn(`[DryRun]  - Swap Route: ${JSON.stringify(swapRoute)}`);
            logger.warn(`[DryRun]  - Est. Gas Limit: ${estimatedGasLimit}`);
            logger.warn(`[DryRun]  - Gas Price: ${ethers.formatUnits(gasPrice, 'gwei')} gwei`);
            return null; // Do not proceed in dry run mode
        }

        try {
            // Prepare the swap path data for the contract call
            const path = swapRoute.map(swap => ({
                pool: swap.pool,
                tokenIn: swap.tokenIn,
                tokenOut: swap.tokenOut,
                fee: swap.fee
            }));

            const borrowTokenSymbol = this.getTokenSymbol(borrowTokenAddress); // Get symbol for logging
            logger.info(`[FlashSwap] Attempting flash swap... Borrow: ${ethers.formatUnits(borrowAmount, this.config.TOKENS[borrowTokenSymbol]?.decimals ?? 18)} ${borrowTokenSymbol}`);

            // Use provided gas estimate for now
            let gasLimit = estimatedGasLimit;
            logger.debug(`[FlashSwap] Using provided gas limit estimate: ${gasLimit}`);

            // Fetch the current nonce using the custom manager
            const nonce = await this.signer.getNonce('latest');
            logger.info(`[FlashSwap] Using nonce: ${nonce}`);

            // Execute the flash swap transaction
            const tx = await this.flashSwapContract.executeFlashSwap(
                borrowTokenAddress,
                borrowAmount,
                path,
                {
                    gasLimit: gasLimit,
                    gasPrice: gasPrice,
                    nonce: nonce
                }
            );

            logger.info(`[FlashSwap] Transaction sent! Hash: ${tx.hash}`);
            logger.info(`[FlashSwap]   Nonce: ${tx.nonce}, Gas Price: ${ethers.formatUnits(tx.gasPrice || '0', 'gwei')} Gwei, Gas Limit: ${tx.gasLimit}`);

            return tx;

        } catch (error) {
            const errorMessage = error.reason || error.message;
            logger.error(`[FlashSwap] Error executing flash swap: ${errorMessage}`, {
                 code: error.code,
                 // transaction: error.transaction, // Ethers error detail
             });

             throw new ArbitrageError(
                 'TransactionExecution',
                 `Flash swap execution failed: ${errorMessage}`,
                 error
             );
        }
    }

    // Helper to get token symbol from address
    getTokenSymbol(address) {
       const checkAddress = ethers.getAddress(address); // Ensure consistent checksum format
       for (const symbol in this.config.TOKENS) {
           if (ethers.getAddress(this.config.TOKENS[symbol].address) === checkAddress) {
               return symbol;
           }
       }
       logger.warn(`[getTokenSymbol] Symbol not found in config for address: ${address}`);
       return address; // Return address if symbol not found
    }
}

module.exports = FlashSwapManager;
