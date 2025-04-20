// core/flashSwapManager.js
// --- VERSION CORRECTED TO ACCEPT config/provider IN CONSTRUCTOR ---
// Manages connection to FlashSwap contract and nonce-managed signer

const { ethers, Wallet, Contract } = require('ethers'); // Ethers v6+
// --- Remove independent config/provider imports ---
// const config = require('../config'); // REMOVED
const NonceManager = require('../utils/nonceManager');
// const { getProvider } = require('../utils/provider'); // REMOVED
// --- ---
const logger = require('../utils/logger');
const FlashSwapABI = require('../abis/FlashSwap.json'); // Make sure the path is correct
const { ArbitrageError, handleError } = require('../utils/errorHandler');

class FlashSwapManager {
    // --- MODIFIED CONSTRUCTOR TO ACCEPT ARGUMENTS ---
    constructor(passedConfig, passedProvider) {
        logger.debug('[FlashSwapManager] Initializing...');

        // --- Use passed-in arguments ---
        this.config = passedConfig;
        this.provider = passedProvider;
        // --- ---

        // --- Validate received config and provider ---
        if (!this.config) {
            logger.error('[FlashSwapManager] Critical Error: Configuration object was not passed to constructor.');
            throw new ArbitrageError('BotInitialization', 'FlashSwapManager: Configuration object required.');
        }
        if (!this.provider) {
             logger.error('[FlashSwapManager] Critical Error: Provider object was not passed to constructor.');
             throw new ArbitrageError('BotInitialization', 'FlashSwapManager: Provider object required.');
         }
        // --- End Validation ---

        // --- Validate required configuration properties WITHIN the passed config ---
        if (!this.config.PRIVATE_KEY) {
            logger.error('[FlashSwapManager] Critical Error: Private key not found in provided configuration.');
            throw new ArbitrageError('BotInitialization', 'FlashSwapManager: Private key not found in configuration.');
        }
        const privateKeyWithPrefix = this.config.PRIVATE_KEY.startsWith('0x')
            ? this.config.PRIVATE_KEY
            : "0x" + this.config.PRIVATE_KEY;

        const flashSwapAddress = this.config.FLASH_SWAP_CONTRACT_ADDRESS;
        if (!flashSwapAddress || !ethers.isAddress(flashSwapAddress)) {
            logger.error(`[FlashSwapManager] Critical Error: Invalid or missing Flash Swap contract address in provided configuration: ${flashSwapAddress}`);
            throw new ArbitrageError('BotInitialization', `FlashSwapManager: Invalid or missing Flash Swap contract address: ${flashSwapAddress}`);
        }
         if (flashSwapAddress === ethers.ZeroAddress) {
             logger.error(`[FlashSwapManager] Critical Error: Flash Swap contract address is the Zero Address.`);
             throw new ArbitrageError('BotInitialization', 'FlashSwapManager: Flash Swap contract address cannot be the Zero Address.');
         }
        // --- End Validation ---


        try {
            // Create the base wallet instance from the private key (using the validated provider)
            const baseWallet = new Wallet(privateKeyWithPrefix, this.provider);
            logger.info(`[FlashSwapManager] Base wallet created for address: ${baseWallet.address}`);

            // Wrap the wallet with the NonceManager for automated nonce handling
            this.signer = new NonceManager(baseWallet); // The signer *is* the NonceManager instance
            logger.info(`[FlashSwapManager] NonceManager initialized for signer: ${this.signer.address}`);

            // Ensure ABI is correctly accessed
            const abi = FlashSwapABI.abi || FlashSwapABI;
            if (!abi || !Array.isArray(abi) || abi.length === 0) {
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
             const errorMessage = error.message || 'Unknown error during Signer/Contract setup';
             logger.error(`[FlashSwapManager Init Error] ${errorMessage}`, { stack: error.stack, code: error.code });
             const errorContext = error.code ? `Ethers error: ${errorMessage} (Code: ${error.code})` : `Setup Error: ${errorMessage}`;
             if (typeof handleError === 'function') { handleError(error, 'FlashSwapManagerInit'); }
             throw new ArbitrageError('BotInitialization', `Error setting up Signer/Contract: ${errorContext}`, error);
        }
        logger.info('[FlashSwapManager] Initialization complete.');
    }

    /**
     * Returns the provider instance used by this manager.
     * @returns {ethers.Provider} The provider instance.
     */
    getProvider() {
        if (!this.provider) { logger.error("[FlashSwapManager] Provider accessed before initialization!"); throw new Error("FlashSwapManager provider not initialized."); }
        return this.provider;
    }

    /**
     * Returns the signer instance (nonce-managed) used by this manager.
     * @returns {NonceManager} The NonceManager instance wrapping the base Wallet.
     */
     getSigner() {
          if (!this.signer) { logger.error("[FlashSwapManager] Signer (NonceManager) accessed before initialization!"); throw new Error("FlashSwapManager signer (NonceManager) not available."); }
          return this.signer;
     }

     /**
      * Returns the address of the nonce-managed signer.
      * @returns {Promise<string>} The checksummed address of the signer.
      */
      async getSignerAddress() {
           if (!this.signer) { logger.error("[FlashSwapManager] Signer (NonceManager) not initialized!"); throw new Error("FlashSwapManager signer (NonceManager) not available."); }
           return this.signer.address;
      }

     /**
      * Returns the FlashSwap contract instance connected to the nonce-managed signer.
      * @returns {ethers.Contract} The contract instance.
      */
      getFlashSwapContract() {
           if (!this.flashSwapContract) { logger.error("[FlashSwapManager] FlashSwapContract accessed before initialization!"); throw new Error("FlashSwapManager contract instance not available."); }
           return this.flashSwapContract;
      }
}

module.exports = FlashSwapManager;
