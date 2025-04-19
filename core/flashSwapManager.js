// core/flashSwapManager.js
// --- VERSION UPDATED FOR ETHERS V6 UTILS ---
// Manages connection to FlashSwap contract and nonce-managed signer

const { ethers, Wallet, Contract } = require('ethers'); // Ethers v6+
const config = require('../config');
const NonceManager = require('../utils/nonceManager');
const { getProvider } = require('../utils/provider');
const logger = require('../utils/logger');
const FlashSwapABI = require('../abis/FlashSwap.json');
const { ArbitrageError, handleError } = require('../utils/errorHandler');

class FlashSwapManager {
    constructor() {
        logger.debug('[FlashSwapManager] Initializing...');
        this.config = config;
        this.provider = getProvider();

        if (!this.config.PRIVATE_KEY) {
            logger.error('[FlashSwapManager] Critical Error: Private key not found in configuration.');
            throw new ArbitrageError('BotInitialization', 'FlashSwapManager: Private key not found in configuration.');
        }
        const privateKeyWithPrefix = this.config.PRIVATE_KEY.startsWith('0x') ? this.config.PRIVATE_KEY : "0x" + this.config.PRIVATE_KEY;

        const flashSwapAddress = this.config.FLASH_SWAP_CONTRACT_ADDRESS;
        // --- Use ethers.isAddress (v6 syntax) ---
        if (!flashSwapAddress || !ethers.isAddress(flashSwapAddress)) {
            logger.error(`[FlashSwapManager] Critical Error: Invalid or missing Flash Swap contract address in configuration: ${flashSwapAddress}`);
            throw new ArbitrageError('BotInitialization', `FlashSwapManager: Invalid or missing Flash Swap contract address: ${flashSwapAddress}`);
        }
        // --- Use ethers.ZeroAddress (v6 constant) ---
         if (flashSwapAddress === ethers.ZeroAddress) {
             logger.error(`[FlashSwapManager] Critical Error: Flash Swap contract address is the Zero Address.`);
             throw new ArbitrageError('BotInitialization', 'FlashSwapManager: Flash Swap contract address cannot be the Zero Address.');
         }
        // --- ---

        try {
            const baseWallet = new Wallet(privateKeyWithPrefix, this.provider);
            logger.info(`[FlashSwapManager] Base wallet created for address: ${baseWallet.address}`);

            this.signer = new NonceManager(baseWallet);
            logger.info(`[FlashSwapManager] NonceManager initialized for signer: ${this.signer.address}`);

            const abi = FlashSwapABI.abi || FlashSwapABI;
            if (!abi || abi.length === 0) { throw new Error("FlashSwap ABI is invalid or empty."); }

            this.flashSwapContract = new Contract(flashSwapAddress, abi, this.signer);
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

    getProvider() {
        if (!this.provider) { throw new Error("FlashSwapManager provider not initialized."); }
        return this.provider;
    }

     getSigner() {
          if (!this.signer) { throw new Error("FlashSwapManager signer (NonceManager) not available."); }
          return this.signer;
     }

      async getSignerAddress() {
           if (!this.signer) { throw new Error("FlashSwapManager signer (NonceManager) not available."); }
           return this.signer.address;
      }

      getFlashSwapContract() {
           if (!this.flashSwapContract) { throw new Error("FlashSwapManager contract instance not available."); }
           return this.flashSwapContract;
      }
}

module.exports = FlashSwapManager;
