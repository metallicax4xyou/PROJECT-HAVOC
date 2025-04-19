// core/flashSwapManager.js
// Manages connection to FlashSwap contract and nonce-managed signer

const { ethers, Wallet, Contract } = require('ethers');
const config = require('../config'); // Uses consolidated config
const NonceManager = require('../utils/nonceManager');
const { getProvider } = require('../utils/provider');
const logger = require('../utils/logger');
const FlashSwapABI = require('../abis/FlashSwap.json');
const { ArbitrageError, handleError } = require('../utils/errorHandler');

class FlashSwapManager {
    constructor() {
        logger.debug('[FlashSwapManager] Initializing...');
        this.config = config;
        this.provider = getProvider(); // Get provider via utility

        // Validate required config for manager setup
        if (!this.config.PRIVATE_KEY) {
            throw new ArbitrageError('BotInitialization', 'FlashSwapManager: Private key not found in configuration.');
        }
        // Add '0x' prefix for Wallet constructor
        const privateKeyWithPrefix = "0x" + this.config.PRIVATE_KEY;

        if (!this.config.FLASH_SWAP_CONTRACT_ADDRESS || this.config.FLASH_SWAP_CONTRACT_ADDRESS === ethers.ZeroAddress) {
             throw new ArbitrageError('BotInitialization', 'FlashSwapManager: Flash Swap contract address not found or is ZeroAddress in configuration.');
        }
        const flashSwapAddress = this.config.FLASH_SWAP_CONTRACT_ADDRESS;


        try {
            // Create the base wallet instance
            const baseWallet = new Wallet(privateKeyWithPrefix, this.provider);
            // Wrap the wallet with the NonceManager
            this.signer = new NonceManager(baseWallet);
            logger.info(`[FlashSwapManager] NonceManager initialized for signer: ${this.signer.address}`);

            // Create the contract instance using the NonceManager as the signer
            this.flashSwapContract = new Contract(
                flashSwapAddress,
                FlashSwapABI.abi || FlashSwapABI, // Handle case where ABI is nested under .abi key
                this.signer // Use the NonceManager instance
            );
            logger.info(`[FlashSwapManager] Connected to FlashSwap contract at ${flashSwapAddress}`);

        } catch (error) {
             const errorMessage = error.message || 'Unknown error during Signer/Contract setup';
             logger.error(`[FlashSwapManager Init Error] ${errorMessage}`, error);
             const errorContext = error.code ? `Ethers error: ${errorMessage} (Code: ${error.code})` : `Error: ${errorMessage}`;
             // Ensure error handler is used if available
             if (typeof handleError === 'function') {
                handleError(error, 'FlashSwapManagerInit');
             }
             throw new ArbitrageError('BotInitialization', `Error setting up Signer/Contract: ${errorContext}`, error);
        }
        logger.info('[FlashSwapManager] Initialization complete.');
    }

    /**
     * Returns the provider instance used by this manager.
     * @returns {ethers.Provider} The provider instance.
     */
    getProvider() {
        if (!this.provider) {
             logger.error("[FlashSwapManager] Provider not initialized!");
             // Potentially re-fetch or throw, but should be set in constructor
             this.provider = getProvider();
        }
        return this.provider;
    }

    /**
     * Returns the signer instance (nonce-managed) used by this manager.
     * @returns {NonceManager} The NonceManager instance wrapping the Wallet.
     */
     getSigner() {
          if (!this.signer) {
             logger.error("[FlashSwapManager] Signer (NonceManager) not initialized!");
             // This indicates a constructor failure, likely fatal
             throw new Error("FlashSwapManager signer (NonceManager) not available.");
          }
          return this.signer;
     }

     /**
      * Returns the FlashSwap contract instance connected to the nonce-managed signer.
      * @returns {ethers.Contract} The contract instance.
      */
      getFlashSwapContract() {
           if (!this.flashSwapContract) {
             logger.error("[FlashSwapManager] FlashSwapContract not initialized!");
             // This indicates a constructor failure, likely fatal
             throw new Error("FlashSwapManager contract instance not available.");
           }
           return this.flashSwapContract;
      }

    // REMOVED getNextNonce() - Call manager.getSigner().getNextNonce() instead
    // REMOVED executeFlashSwap() - Logic moved to txExecutor.js
    // REMOVED getTokenSymbol() - No longer needed here
}

module.exports = FlashSwapManager;
