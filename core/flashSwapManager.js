// core/flashSwapManager.js
const { ethers, Contract, JsonRpcProvider, Wallet } = require('ethers');
const config = require('../config/index.js');
const logger = require('../utils/logger');
const { handleError } = require('../utils/errorHandler');
const { ABIS } = require('../constants/abis');

// --->>> UPDATED IMPORT: Use destructuring for named export <<<---
const { NonceManager } = require('../utils/nonceManager');

class FlashSwapManager {
    constructor() {
        logger.info(`[Manager] Initializing FlashSwapManager for network: ${config.NETWORK_NAME} (Chain ID: ${config.CHAIN_ID})...`);
        this.provider = null;
        this.signer = null;
        this.flashSwapContract = null;
        this.quoterContract = null;
        this.nonceManager = null;
    }

    async initialize() {
        try {
            logger.info('[Manager] Setting up Provider...');
            this.provider = new JsonRpcProvider(config.RPC_URL);
            const network = await this.provider.getNetwork();
            if (network.chainId !== BigInt(config.CHAIN_ID)) {
                throw new Error(`Provider connected to wrong network! Expected Chain ID ${config.CHAIN_ID}, got ${network.chainId}`);
            }
            const blockNumber = await this.provider.getBlockNumber();
            logger.info(`[Manager] Provider connected. Network: ${network.name} (ID: ${network.chainId}), Current block: ${blockNumber}`);

            logger.info('[Manager] Setting up Signer...');
            if (!config.PRIVATE_KEY) {
                throw new Error('PRIVATE_KEY not found in environment configuration.');
            }
            this.signer = new Wallet(config.PRIVATE_KEY, this.provider);
            logger.info(`[Manager] Signer Address: ${this.signer.address}`);
            if (config.BOT_ADDRESS && this.signer.address.toLowerCase() !== config.BOT_ADDRESS.toLowerCase()) {
                 logger.warn(`[Manager] Configured BOT_ADDRESS (${config.BOT_ADDRESS}) does not match derived Signer address (${this.signer.address})!`);
            }

            logger.info('[Manager] Initializing Nonce Manager...');
             // --->>> UPDATED INSTANTIATION: Pass the signer instance <<<---
             // The custom NonceManager class expects the signer object
            this.nonceManager = new NonceManager(this.signer);
            await this.nonceManager.initialize(); // Fetch initial nonce


            logger.info('[Manager] Initializing Core Contracts...');
            // Flash Swap Contract
            if (!config.FLASH_SWAP_CONTRACT_ADDRESS || !ABIS.FlashSwap) {
                 throw new Error('Flash Swap contract address or ABI is missing in configuration/constants.');
            }
            this.flashSwapContract = new Contract(config.FLASH_SWAP_CONTRACT_ADDRESS, ABIS.FlashSwap, this.signer);
            logger.info(`[Manager] FlashSwap Contract Initialized: ${await this.flashSwapContract.getAddress()}`);

            // Quoter Contract (V2)
            if (config.UNISWAP_V3_QUOTER_ADDRESS && ABIS.IQuoterV2) {
                 this.quoterContract = new Contract(config.UNISWAP_V3_QUOTER_ADDRESS, ABIS.IQuoterV2, this.provider);
                 logger.info(`[Manager] Quoter Contract Initialized: ${await this.quoterContract.getAddress()}`);
            } else {
                 logger.warn('[Manager] Quoter V2 address or ABI missing, Quoter contract not initialized.');
            }


            logger.info('[Manager] FlashSwapManager Initialized Successfully.');

        } catch (error) {
            logger.fatal('[Manager] CRITICAL ERROR during FlashSwapManager initialization:', error); // Using fatal here is okay since logger now defines it
            handleError(error, 'FlashSwapManager.initialize');
            throw error; // Re-throw to prevent application start
        }
    }

    getProvider() {
        if (!this.provider) {
            logger.error("[Manager] getProvider() called before provider was initialized!");
        }
        return this.provider;
    }

    getSigner() {
        if (!this.signer) {
             logger.error("[Manager] getSigner() called before signer was initialized!");
        }
        return this.signer;
    }

    getFlashSwapContract() {
         if (!this.flashSwapContract) {
              logger.error("[Manager] getFlashSwapContract() called before contract was initialized!");
         }
        return this.flashSwapContract;
    }

     getNonceManager() {
         if (!this.nonceManager) {
              logger.error("[Manager] getNonceManager() called before nonce manager was initialized!");
         }
         return this.nonceManager;
     }
}

module.exports = FlashSwapManager;
