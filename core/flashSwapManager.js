// core/flashSwapManager.js
// --- VERSION UPDATED FOR PHASE 1 REFACTOR ---
// Manages connection to FlashSwap contract and nonce-managed signer

const { ethers, Wallet, Contract } = require('ethers');
const config = require('../config'); // Uses consolidated config loader
const NonceManager = require('../utils/nonceManager');
const { getProvider } = require('../utils/provider'); // Assumes this utility correctly returns a provider
const logger = require('../utils/logger');
const FlashSwapABI = require('../abis/FlashSwap.json'); // Make sure the path is correct
const { ArbitrageError, handleError } = require('../utils/errorHandler');

class FlashSwapManager {
    constructor() {
        logger.debug('[FlashSwapManager] Initializing...');
        this.config = config; // Store the loaded config
        this.provider = getProvider(); // Get provider instance

        // --- Validate required configuration ---
        if (!this.config.PRIVATE_KEY) {
            // Log sensitive info absence carefully
            logger.error('[FlashSwapManager] Critical Error: Private key not found in configuration.');
            throw new ArbitrageError('BotInitialization', 'FlashSwapManager: Private key not found in configuration.');
        }
        // Add '0x' prefix if missing, critical for Wallet constructor
        const privateKeyWithPrefix = this.config.PRIVATE_KEY.startsWith('0x')
            ? this.config.PRIVATE_KEY
            : "0x" + this.config.PRIVATE_KEY;

        const flashSwapAddress = this.config.FLASH_SWAP_CONTRACT_ADDRESS;
        if (!flashSwapAddress || !ethers.utils.isAddress(flashSwapAddress)) {
             logger.error(`[FlashSwapManager] Critical Error: Invalid or missing Flash Swap contract address in configuration: ${flashSwapAddress}`);
             throw new ArbitrageError('BotInitialization', `FlashSwapManager: Invalid or missing Flash Swap contract address: ${flashSwapAddress}`);
        }
         if (flashSwapAddress === ethers.constants.AddressZero) {
             logger.error(`[FlashSwapManager] Critical Error: Flash Swap contract address is the Zero Address.`);
             throw new ArbitrageError('BotInitialization', 'FlashSwapManager: Flash Swap contract address cannot be the Zero Address.');
         }
        // --- End Validation ---


        try {
            // Create the base wallet instance from the private key
            const baseWallet = new Wallet(privateKeyWithPrefix, this.provider);
            logger.info(`[FlashSwapManager] Base wallet created for address: ${baseWallet.address}`);

            // Wrap the wallet with the NonceManager for automated nonce handling
            this.signer = new NonceManager(baseWallet); // The signer *is* the NonceManager instance
            logger.info(`[FlashSwapManager] NonceManager initialized for signer: ${this.signer.address}`);

            // Ensure ABI is correctly accessed (sometimes nested under .abi)
            const abi = FlashSwapABI.abi || FlashSwapABI;
            if (!abi || abi.length === 0) {
                 throw new Error("FlashSwap ABI is invalid or empty.");
            }

            // Create the contract instance using the NonceManager as the signer
            this.flashSwapContract = new Contract(
                flashSwapAddress,
                abi,
                this.signer // Use the NonceManager instance which acts as a Signer
            );
            logger.info(`[FlashSwapManager] Connected to FlashSwap contract at ${flashSwapAddress}`);

        } catch (error) {
             // Catch errors during wallet/signer/contract creation
             const errorMessage = error.message || 'Unknown error during Signer/Contract setup';
             logger.error(`[FlashSwapManager Init Error] ${errorMessage}`, { stack: error.stack, code: error.code });
             const errorContext = error.code ? `Ethers error: ${errorMessage} (Code: ${error.code})` : `Setup Error: ${errorMessage}`;

             // Use global error handler if available
             if (typeof handleError === 'function') {
                handleError(error, 'FlashSwapManagerInit');
             }
             // Throw a specific error indicating initialization failure
             throw new ArbitrageError('BotInitialization', `Error setting up Signer/Contract: ${errorContext}`, error);
        }
        logger.info('[FlashSwapManager] Initialization complete.');
    }

    /**
     * Returns the provider instance used by this manager.
     * @returns {ethers.providers.Provider} The provider instance.
     */
    getProvider() {
        if (!this.provider) {
             // This should not happen if constructor succeeded
             logger.error("[FlashSwapManager] Provider accessed before initialization!");
             throw new Error("FlashSwapManager provider not initialized.");
        }
        return this.provider;
    }

    /**
     * Returns the signer instance (nonce-managed) used by this manager.
     * The NonceManager itself implements the Signer interface needed by ethers.js.
     * @returns {NonceManager} The NonceManager instance wrapping the base Wallet.
     */
     getSigner() {
          if (!this.signer) {
             // This should not happen if constructor succeeded
             logger.error("[FlashSwapManager] Signer (NonceManager) accessed before initialization!");
             throw new Error("FlashSwapManager signer (NonceManager) not available.");
          }
          return this.signer; // Return the NonceManager instance
     }

     /**
      * Returns the address of the nonce-managed signer.
      * @returns {Promise<string>} The checksummed address of the signer. Returns directly as NonceManager stores it.
      */
      async getSignerAddress() {
           // No async needed as NonceManager stores address, but keep async for potential future signer types
           if (!this.signer) {
              logger.error("[FlashSwapManager] Signer (NonceManager) not initialized! Cannot get address.");
              throw new Error("FlashSwapManager signer (NonceManager) not available.");
           }
           // NonceManager wrapper likely stores the address directly from the underlying signer
           return this.signer.address;
      }

     /**
      * Returns the FlashSwap contract instance connected to the nonce-managed signer.
      * @returns {ethers.Contract} The contract instance.
      */
      getFlashSwapContract() {
           if (!this.flashSwapContract) {
             // This should not happen if constructor succeeded
             logger.error("[FlashSwapManager] FlashSwapContract accessed before initialization!");
             throw new Error("FlashSwapManager contract instance not available.");
           }
           return this.flashSwapContract;
      }
}

module.exports = FlashSwapManager;
