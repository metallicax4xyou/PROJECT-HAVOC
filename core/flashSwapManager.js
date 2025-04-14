// core/flashSwapManager.js
const { ethers } = require('ethers');
const config = require('../config/index.js'); // Load the unified config
const { ABIS } = require('../constants/abis');
const { PROTOCOL_ADDRESSES } = require('../constants/addresses');
const { NonceManager } = require('../utils/nonceManager');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const logger = require('../utils/logger'); // Use our logger utility

class FlashSwapManager {
    constructor() {
        // Config is already loaded and validated by require('../config/index.js')
        this.config = config;
        this.provider = null;
        this.signer = null;
        this.nonceManager = null;
        this.contracts = {
            flashSwap: null,
            quoter: null,
            // Pool contracts will likely be handled by PoolScanner or passed as needed
        };
        this.isInitialized = false;
    }

    /**
     * Initializes the provider, signer, nonce manager, and core contracts.
     * Must be called before other methods.
     */
    async initialize() {
        if (this.isInitialized) {
            logger.warn('FlashSwapManager already initialized.');
            return;
        }

        logger.log(`[Manager] Initializing FlashSwapManager for network: ${this.config.NAME} (Chain ID: ${this.config.CHAIN_ID})...`);

        try {
            // 1. Initialize Provider
            logger.log('[Manager] Setting up Provider...');
            this.provider = new ethers.JsonRpcProvider(this.config.RPC_URL);
            // Test connection
            const blockNumber = await this.provider.getBlockNumber();
            logger.log(`[Manager] Provider connected. Current block: ${blockNumber}`);

            // 2. Initialize Signer
            logger.log('[Manager] Setting up Signer...');
            if (!this.config.PRIVATE_KEY || !this.config.PRIVATE_KEY.startsWith('0x')) {
                throw new ArbitrageError('Private key missing or invalid format (must start with 0x).', 'CONFIG_ERROR');
            }
            this.signer = new ethers.Wallet(this.config.PRIVATE_KEY, this.provider);
            logger.log(`[Manager] Signer Address: ${this.signer.address}`);

            // 3. Initialize Nonce Manager
            logger.log('[Manager] Initializing Nonce Manager...');
            this.nonceManager = new NonceManager(this.signer); // Pass signer
            await this.nonceManager.initialize(); // Fetches initial nonce

            // 4. Initialize Core Contracts
            logger.log('[Manager] Initializing Core Contracts...');
            // FlashSwap Contract
            if (this.config.FLASH_SWAP_CONTRACT_ADDRESS && this.config.FLASH_SWAP_CONTRACT_ADDRESS !== ethers.ZeroAddress) {
                this.contracts.flashSwap = new ethers.Contract(
                    this.config.FLASH_SWAP_CONTRACT_ADDRESS,
                    ABIS.FlashSwap, // Use ABI from constants
                    this.signer     // Use signer for sending transactions
                );
                logger.log(`[Manager] FlashSwap Contract Initialized: ${this.contracts.flashSwap.target}`);
                // Optional: Check owner matches signer
                try {
                    const owner = await this.contracts.flashSwap.owner();
                    if (owner.toLowerCase() !== this.signer.address.toLowerCase()) {
                        logger.warn(`[Manager] Signer (${this.signer.address}) does not match FlashSwap owner (${owner}). Ensure this is intended.`);
                    }
                } catch (ownerError) {
                     logger.warn(`[Manager] Could not verify FlashSwap owner: ${ownerError.message}`);
                }

            } else {
                logger.warn('[Manager] FlashSwap Contract address not configured. Flash swap execution disabled.');
                 throw new ArbitrageError('FlashSwap contract address is required but not configured.', 'CONFIG_ERROR'); // Make this critical
            }

            // Quoter Contract
            if (this.config.QUOTER_ADDRESS && this.config.QUOTER_ADDRESS !== ethers.ZeroAddress) {
                 this.contracts.quoter = new ethers.Contract(
                     this.config.QUOTER_ADDRESS,
                     ABIS.IQuoterV2,  // Use ABI from constants
                     this.provider    // Quoter is read-only, use provider
                 );
                 logger.log(`[Manager] Quoter Contract Initialized: ${this.contracts.quoter.target}`);
            } else {
                logger.warn('[Manager] Quoter Contract address not configured. Quote simulation might fail.');
                // Depending on simulation method, this might be optional or critical
            }

            this.isInitialized = true;
            logger.log('[Manager] FlashSwapManager Initialized Successfully.');

        } catch (error) {
            // Use our central error handler
            handleError(error, 'FlashSwapManager Initialization');
            // Throw a more specific error to halt the bot if initialization fails
            throw new ArbitrageError(`FlashSwapManager failed to initialize: ${error.message}`, 'INITIALIZATION_ERROR', { originalError: error });
        }
    }

    // --- Methods for interacting with contracts (to be added later) ---

    /**
     * Placeholder: Prepares and simulates the initiateFlashSwap call.
     * @param {object} opportunity Details of the arbitrage opportunity.
     * @returns {Promise<object>} Simulation result (success, estimated gas, revert reason).
     */
    async simulateFlashSwap(opportunity) {
        if (!this.isInitialized || !this.contracts.flashSwap) throw new Error('Manager not initialized or FlashSwap contract missing.');
        logger.debug(`[Manager] Simulating flash swap for opportunity: ${opportunity?.groupName}`);
        // TODO: Implement simulation logic using staticCall and estimateGas
        // This will involve encoding params based on opportunity details
        await new Promise(r => setTimeout(r, 50)); // Placeholder delay
        return { success: true, estimatedGas: 500000n }; // Placeholder result
    }

    /**
     * Placeholder: Executes the initiateFlashSwap transaction.
     * @param {object} opportunity Details of the opportunity.
     * @param {object} gasParams Pre-calculated gas parameters.
     * @returns {Promise<ethers.TransactionResponse|null>} Transaction response or null on failure.
     */
    async executeFlashSwap(opportunity, gasParams) {
        if (!this.isInitialized || !this.contracts.flashSwap) throw new Error('Manager not initialized or FlashSwap contract missing.');
        logger.log(`[Manager] Attempting to execute flash swap for opportunity: ${opportunity?.groupName}`);
        // TODO: Implement execution logic
        // 1. Get next nonce from nonceManager
        // 2. Encode params
        // 3. Construct transaction overrides (gasLimit, fees, nonce)
        // 4. Send transaction using flashSwap contract instance
        // 5. Handle errors, potentially release nonce if tx fails pre-send
        await new Promise(r => setTimeout(r, 100)); // Placeholder delay
        logger.warn('[Manager] executeFlashSwap is currently a placeholder - NO TRANSACTION SENT.');
        return null; // Placeholder result
    }

    // --- Getter methods ---
    getProvider() {
        if (!this.isInitialized) throw new Error('Manager not initialized.');
        return this.provider;
    }

    getSigner() {
        if (!this.isInitialized) throw new Error('Manager not initialized.');
        return this.signer;
    }

    getFlashSwapContract() {
         if (!this.isInitialized) throw new Error('Manager not initialized.');
         return this.contracts.flashSwap;
    }

     getQuoterContract() {
         if (!this.isInitialized) throw new Error('Manager not initialized.');
         return this.contracts.quoter;
     }

     getNextNonce() {
          if (!this.isInitialized || !this.nonceManager) throw new Error('Manager or NonceManager not initialized.');
          return this.nonceManager.getNextNonce(); // Delegate to nonce manager
     }

}

module.exports = { FlashSwapManager };
