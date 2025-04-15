// core/flashSwapManager.js
const { ethers, Wallet, Contract, JsonRpcProvider, NonceManager: EthersNonceManager } = require('ethers');
const config = require('../config/index.js');
const logger = require('../utils/logger');
const { ABIS } = require('../constants/abis'); // Load ABIs
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const NonceManager = require('../utils/nonceManager'); // Our custom nonce manager
// --->>> Import the Quoter initializer <<<---
const { initializeQuoter } = require('./quoteSimulator');

class FlashSwapManager {
    constructor() {
        this.provider = null;
        this.signer = null;
        this.flashSwapContract = null;
        this.quoterV2Contract = null; // Added for potential future use
        this.nonceManager = null;
        this.network = null;
    }

    /**
     * Initializes the manager: sets up provider, signer, contracts, and nonce manager.
     * @returns {Promise<boolean>} True if initialization is successful, false otherwise.
     */
    async initialize() {
        const functionSig = '[Manager]';
        logger.info(`${functionSig} Initializing FlashSwapManager for network: ${config.NETWORK_NAME} (Chain ID: ${config.CHAIN_ID})...`);

        try {
            // 1. Setup Provider
            logger.info(`${functionSig} Setting up Provider...`);
            if (!config.RPC_URL) {
                throw new ArbitrageError('ProviderSetupError', 'RPC_URL is not configured.');
            }
            this.provider = new JsonRpcProvider(config.RPC_URL);
            // Verify connection
            this.network = await this.provider.getNetwork();
            const blockNumber = await this.provider.getBlockNumber();
            if (!this.network || !this.network.chainId || blockNumber <= 0) {
                 throw new ArbitrageError('ProviderSetupError', `Failed to connect to provider or get network info. ChainID: ${this.network?.chainId}, Block: ${blockNumber}`);
            }
             // Check if connected Chain ID matches config
             if (this.network.chainId !== BigInt(config.CHAIN_ID)) {
                 throw new ArbitrageError('ProviderSetupError', `Provider connected to wrong network! Expected Chain ID: ${config.CHAIN_ID}, Got: ${this.network.chainId}`);
             }
            logger.info(`${functionSig} Provider connected. Network: ${this.network.name} (ID: ${this.network.chainId}), Current block: ${blockNumber}`);

            // 2. Setup Signer
            logger.info(`${functionSig} Setting up Signer...`);
            if (!config.PRIVATE_KEY) {
                throw new ArbitrageError('SignerSetupError', 'PRIVATE_KEY is not configured.');
            }
            this.signer = new Wallet(config.PRIVATE_KEY, this.provider);
            logger.info(`${functionSig} Signer Address: ${await this.signer.getAddress()}`);

            // 3. Setup Custom Nonce Manager
            logger.info(`${functionSig} Initializing Nonce Manager...`);
            this.nonceManager = new NonceManager(this.signer); // Pass the ethers Signer object
            await this.nonceManager.initialize(); // Fetch initial nonce


            // 4. Initialize Core Contracts
            logger.info(`${functionSig} Initializing Core Contracts...`);
            // FlashSwap Contract
            if (!config.FLASH_SWAP_CONTRACT_ADDRESS || !ethers.isAddress(config.FLASH_SWAP_CONTRACT_ADDRESS)) {
                 throw new ArbitrageError('ContractSetupError', `Invalid or missing FLASH_SWAP_CONTRACT_ADDRESS: ${config.FLASH_SWAP_CONTRACT_ADDRESS}`);
            }
            if (!ABIS.FlashSwap) {
                 throw new ArbitrageError('ContractSetupError', 'FlashSwap ABI not found.');
            }
            this.flashSwapContract = new Contract(config.FLASH_SWAP_CONTRACT_ADDRESS, ABIS.FlashSwap, this.signer);
            logger.info(`${functionSig} FlashSwap Contract Initialized: ${await this.flashSwapContract.getAddress()}`);

            // --->>> Initialize Quoter V2 Contract via quoteSimulator <<<---
            initializeQuoter(this.provider); // Call the initializer function


            // 5. Final Log
            logger.info(`${functionSig} FlashSwapManager Initialized Successfully.`);
            return true;

        } catch (error) {
            logger.fatal(`${functionSig} CRITICAL INITIALIZATION FAILURE!`);
            handleError(error, `${functionSig} Initialization`);
            // Ensure partial initializations are cleared?
            this.provider = null;
            this.signer = null;
            this.flashSwapContract = null;
            this.nonceManager = null;
            return false; // Indicate failure
        }
    }

    // --- Getter Methods ---

    getProvider() {
        if (!this.provider) { logger.warn('[Manager] Provider accessed before initialization.'); }
        return this.provider;
    }

    getSigner() {
        if (!this.signer) { logger.warn('[Manager] Signer accessed before initialization.'); }
        return this.signer;
    }

    getFlashSwapContract() {
        if (!this.flashSwapContract) { logger.warn('[Manager] FlashSwap Contract accessed before initialization.'); }
        return this.flashSwapContract;
    }

    getNonceManager() {
        if (!this.nonceManager) { logger.warn('[Manager] Nonce Manager accessed before initialization.'); }
        return this.nonceManager;
    }

     getNetwork() {
         if (!this.network) { logger.warn('[Manager] Network info accessed before initialization.'); }
         return this.network;
     }

    // --- Utility Methods ---

    /**
     * Checks if the manager has been successfully initialized.
     * @returns {boolean} True if initialized, false otherwise.
     */
    isInitialized() {
        return !!this.provider && !!this.signer && !!this.flashSwapContract && !!this.nonceManager && !!this.network;
    }
}

module.exports = FlashSwapManager;
