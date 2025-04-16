// core/flashSwapManager.js

const { ethers, Wallet, Contract } = require('ethers');
// --- Corrected Config Import ---
const config = require('../config'); // Import the config object directly
// --- ---
const NonceManager = require('../utils/nonceManager'); // Use our custom NonceManager
const { getProvider } = require('../utils/provider'); // Import the provider getter
const { logger } = require('../utils/logger');
const FlashSwapABI = require('../abis/FlashSwap.json'); // Load ABI
const { ArbitrageError, handleError } = require('../utils/errorHandler');

class FlashSwapManager {
    constructor() {
        // --- Use the imported config object ---
        this.config = config; // Assign the imported object
        // --- ---
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
            logger.info(`[NonceManager] Initialized for signer: ${this.signer.address}`);

            this.flashSwapContract = new Contract(
                this.config.FLASH_SWAP_CONTRACT_ADDRESS,
                FlashSwapABI,
                this.signer // Use the nonce-managed signer
            );
            logger.info(`[FlashSwap] Connected to FlashSwap contract at ${this.config.FLASH_SWAP_CONTRACT_ADDRESS}`);

        } catch (error) {
            // Catch specific ethers errors or general errors during setup
            if (error.code) { // Ethers errors often have a code
                 throw new ArbitrageError(
                     'BotInitialization',
                     `Ethers error during Signer/Contract setup: ${error.message} (Code: ${error.code})`,
                     error
                 );
            } else {
                 throw new ArbitrageError(
                     'BotInitialization',
                     `Error setting up Signer/Contract: ${error.message}`,
                     error
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
            logger.warn(`[DryRun] Would execute flash swap on ${this.config.FLASH_SWAP_CONTRACT_ADDRESS}`);
            logger.warn(`[DryRun]  - Borrow Token: ${borrowTokenAddress}`);
            logger.warn(`[DryRun]  - Borrow Amount: ${ethers.formatUnits(borrowAmount, this.config.TOKENS[this.config.getTokenSymbol(borrowTokenAddress)]?.decimals ?? 18)}`);
            logger.warn(`[DryRun]  - Swap Route: ${JSON.stringify(swapRoute)}`);
            logger.warn(`[DryRun]  - Est. Gas Limit: ${estimatedGasLimit}`);
            logger.warn(`[DryRun]  - Gas Price: ${ethers.formatUnits(gasPrice, 'gwei')} gwei`);
            return null; // Do not proceed in dry run mode
        }

        try {
            // Prepare the swap path data for the contract call
            // Contract expects: address pool, address tokenIn, address tokenOut, uint24 fee
            const path = swapRoute.map(swap => ({
                pool: swap.pool,
                tokenIn: swap.tokenIn,
                tokenOut: swap.tokenOut,
                fee: swap.fee // Assuming fee here is the V3 pool fee tier (e.g., 500, 3000)
            }));

            logger.info(`[FlashSwap] Attempting flash swap... Borrow: ${ethers.formatUnits(borrowAmount, this.config.getTokenSymbol(borrowTokenAddress))} ${this.config.getTokenSymbol(borrowTokenAddress)}`);

            // Estimate gas using the contract's method if possible, otherwise use provided estimate
            let gasLimit;
            try {
                 // Note: Direct estimation might be tricky due to state changes during the actual call.
                 // Using the pre-calculated estimate might be more reliable here.
                 // gasLimit = await this.flashSwapContract.executeFlashSwap.estimateGas(
                 //     borrowTokenAddress,
                 //     borrowAmount,
                 //     path,
                 //     { gasPrice: gasPrice } // Provide gasPrice if needed for estimation context
                 // );
                 // Add a buffer to the estimate?
                 // gasLimit = gasLimit * 120n / 100n; // Example: 20% buffer
                 gasLimit = estimatedGasLimit; // Use the estimate passed in for now
                 logger.debug(`[FlashSwap] Using provided gas limit estimate: ${gasLimit}`);
             } catch (estimationError) {
                 logger.warn(`[FlashSwap] Gas estimation failed: ${estimationError.message}. Falling back to default estimate.`);
                 // Decide if fallback is okay or if it should throw
                 gasLimit = this.config.GAS_LIMIT_ESTIMATE; // Use global fallback
                 // Alternatively: throw new ArbitrageError('GasEstimation', `Failed to estimate gas for flash swap: ${estimationError.message}`);
             }


            // --->>> Fetch the current nonce using the custom manager <<<---
            const nonce = await this.signer.getNonce('latest'); // Or 'pending' if needed
            logger.info(`[FlashSwap] Using nonce: ${nonce}`);


            // Execute the flash swap transaction
            const tx = await this.flashSwapContract.executeFlashSwap(
                borrowTokenAddress,
                borrowAmount,
                path,
                {
                    gasLimit: gasLimit,
                    gasPrice: gasPrice, // Use the calculated gas price
                    nonce: nonce         // Provide the fetched nonce explicitly
                }
            );

            logger.info(`[FlashSwap] Transaction sent! Hash: ${tx.hash}`);
            logger.info(`[FlashSwap]   Nonce: ${tx.nonce}, Gas Price: ${ethers.formatUnits(tx.gasPrice || '0', 'gwei')} Gwei, Gas Limit: ${tx.gasLimit}`);

            // Optional: Increment nonce locally immediately after sending (if manager doesn't handle pending txs well)
            // this.signer.incrementNonce(); // If needed, depends on NonceManager logic

            return tx;

        } catch (error) {
            // Decrement nonce if the transaction failed before being mined? Risky, depends on NonceManager logic.
            // if (error.code === 'REPLACEMENT_UNDERPRICED' || ...) {
            //     this.signer.decrementNonce(); // Be VERY careful with this
            // }

            // Throw a structured error
            const errorMessage = error.reason || error.message; // Ethers errors often have 'reason'
            logger.error(`[FlashSwap] Error executing flash swap: ${errorMessage}`, { // Log full details
                 code: error.code,
                 // transaction: error.transaction, // Contains details if it's an Ethers error
                 // receipt: error.receipt // May be present if it failed on-chain
             });

             throw new ArbitrageError(
                 'TransactionExecution',
                 `Flash swap execution failed: ${errorMessage}`,
                 error // Attach original error
             );
        }
    }

    // Helper to get token symbol from address (useful for logging) - might need refinement
    // Consider moving this to a central utility or config helper if used widely
    getTokenSymbol(address) {
       for (const symbol in this.config.TOKENS) {
           if (ethers.getAddress(this.config.TOKENS[symbol].address) === ethers.getAddress(address)) {
               return symbol;
           }
       }
       return address; // Return address if symbol not found
    }
}

module.exports = FlashSwapManager;
