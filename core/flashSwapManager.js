// core/flashSwapManager.js

const { ethers } = require('ethers');
const NonceManager = require('../utils/nonceManager'); // Adjust path if needed
const { getProvider } = require('../utils/provider'); // Adjust path if needed
const { getConfig } = require('../config'); // Adjust path if needed
const { logger } = require('../utils/logger'); // Adjust path if needed

const FlashSwapABI = require('../abis/FlashSwap.json');
// Remove QuoterV2 ABI require, as it's not initialized here anymore
// const QuoterV2ABI = require('../abis/IQuoterV2.json');

class FlashSwapManager {
    constructor(network) {
        this.network = network;
        this.config = getConfig(network); // Load config specific to the network
        this.provider = null;
        this.signer = null;
        this.flashSwapContract = null;
        this.nonceManager = null;
        // Remove quoter property
        // this.quoterContract = null;
        this.isInitialized = false;

        logger.info(`[Manager] Initializing FlashSwapManager for network: ${this.network} (Chain ID: ${this.config.CHAIN_ID})...`);
    }

    async initialize() {
        if (this.isInitialized) {
            logger.warn('[Manager] Attempted to initialize already initialized FlashSwapManager.');
            return;
        }

        try {
            logger.info('[Manager] Setting up Provider...');
            this.provider = getProvider(this.config); // Use the utility function
            if (!this.provider) {
                throw new Error('Failed to initialize provider.');
            }
            const network = await this.provider.getNetwork();
            const blockNumber = await this.provider.getBlockNumber();
            logger.info(`[Manager] Provider connected. Network: ${network.name} (ID: ${network.chainId}), Current block: ${blockNumber}`);

            logger.info('[Manager] Setting up Signer...');
            if (!this.config.PRIVATE_KEY) {
                throw new Error('Private key not found in configuration.');
            }
            this.signer = new ethers.Wallet(this.config.PRIVATE_KEY, this.provider);
            logger.info(`[Manager] Signer Address: ${this.signer.address}`);

            logger.info('[Manager] Initializing Nonce Manager...');
            this.nonceManager = new NonceManager(this.provider, this.signer.address);
            await this.nonceManager.initialize(); // Fetches initial nonce

            logger.info('[Manager] Initializing Core Contracts...');
            // Initialize FlashSwap Contract
            if (!this.config.CONTRACT_ADDRESS) {
                throw new Error('FlashSwap contract address not found in configuration.');
            }
            this.flashSwapContract = new ethers.Contract(this.config.CONTRACT_ADDRESS, FlashSwapABI, this.signer);
            logger.info(`[Manager] FlashSwap Contract Initialized: ${await this.flashSwapContract.getAddress()}`);

            // --- REMOVED QUOTER INITIALIZATION ---
            // logger.info('[Manager] Initializing QuoterV2 Contract...');
            // this.initializeQuoter(); // <-- REMOVED THIS CALL
            // --- END REMOVED QUOTER INITIALIZATION ---

            this.isInitialized = true;
            logger.info('[Manager] FlashSwapManager Initialized Successfully.');

        } catch (error) {
            logger.error('ERROR: [Manager] CRITICAL INITIALIZATION FAILURE!', error);
            // Re-throw or handle appropriately, maybe set isInitialized to false
            this.isInitialized = false; // Ensure state reflects failure
             // Log specific context if available in the error object
             logger.error(`--- ERROR ENCOUNTERED ---\nContext: [Manager] Initialization\nTimestamp: ${new Date().toISOString()}\nType: ${error.constructor.name}\nMessage: ${error.message}\n--- Full Unexpected Error Object Start ---\n${error.stack || error}\n--- Full Unexpected Error Object End ---\n--- END ERROR LOG ---`);
             throw new Error(`FlashSwapManager initialization failed: ${error.message}`); // Propagate error
        }
    }

    // --- REMOVED initializeQuoter function ---
    // initializeQuoter() {
    //     if (!this.config.QUOTERV2_ADDRESS) {
    //         throw new Error('QuoterV2 address not found in configuration.');
    //     }
    //     this.quoterContract = new ethers.Contract(this.config.QUOTERV2_ADDRESS, QuoterV2ABI, this.provider); // Use provider, not signer
    //     logger.info(`[Manager] QuoterV2 Contract Initialized: ${this.config.QUOTERV2_ADDRESS}`);
    // }
    // --- END REMOVED initializeQuoter function ---


    getProvider() {
        if (!this.isInitialized || !this.provider) {
            logger.warn('[Manager] Provider accessed before initialization.');
            // Potentially throw an error or return null depending on desired strictness
            // throw new Error("Provider not initialized");
        }
        return this.provider;
    }

    getSigner() {
        if (!this.isInitialized || !this.signer) {
             logger.warn('[Manager] Signer accessed before initialization.');
            // throw new Error("Signer not initialized");
        }
        return this.signer;
    }

    getFlashSwapContract() {
         if (!this.isInitialized || !this.flashSwapContract) {
             logger.warn('[Manager] FlashSwap Contract accessed before initialization.');
            // throw new Error("FlashSwap Contract not initialized");
         }
        return this.flashSwapContract;
    }

    getNonceManager() {
        if (!this.isInitialized || !this.nonceManager) {
             logger.warn('[Manager] Nonce Manager accessed before initialization.');
            // throw new Error("Nonce Manager not initialized");
        }
        return this.nonceManager;
    }

    // Optional: Add a getter for config if needed elsewhere safely
    getConfig() {
        return this.config;
    }
}

module.exports = FlashSwapManager;
