// bot.js
require('dotenv').config();

const logger = require('./utils/logger');
const ErrorHandler = require('./utils/errorHandler');
const { TOKENS } = require('./constants/tokens');
const { validateTokenConfig } = require('./utils/tokenUtils');
const { getProvider } = require('./utils/provider');
const { ethers } = require('ethers');
const FlashSwapManager = require('./core/flashSwapManager');
const ArbitrageEngine = require('./core/arbitrageEngine');
const SwapSimulator = require('./core/swapSimulator');
const GasEstimator = require('./utils/gasEstimator'); // *** IMPORT GasEstimator ***
const config = require('./config');

// --- Graceful Shutdown (Keep as is) ---
let isShuttingDown = false; let arbitrageEngineInstance = null; async function gracefulShutdown(signal) { /* ... */ }
process.on('SIGINT', () => gracefulShutdown('SIGINT')); process.on('SIGTERM', () => gracefulShutdown('SIGTERM')); process.on('uncaughtException', (error, origin) => { /* ... */ }); process.on('unhandledRejection', (reason, promise) => { /* ... */ });

// --- Main Bot Logic ---
async function main() {
    logger.info('\n=============================================='); logger.info('>>> PROJECT HAVOC ARBITRAGE BOT STARTING <<<'); logger.info('==============================================');
    let flashSwapManagerInstance = null; let provider = null; let swapSimulatorInstance = null; let gasEstimatorInstance = null; // Add gas estimator var
    try {
        logger.info('[Main] Validating token configuration...'); validateTokenConfig(TOKENS); logger.info('[Main] Token configuration validated.');
        logger.info('[Main] Getting Provider instance...'); provider = getProvider(config.RPC_URLS); const network = await provider.getNetwork(); logger.info(`[Main] Provider connected to ${network.name} (ID: ${network.chainId})`); config.provider = provider; logger.debug('[Main] Added provider to config object.');

        logger.info('[Main] Initializing Swap Simulator...'); if (typeof SwapSimulator !== 'function') throw new TypeError(`SwapSimulator class not loaded.`); swapSimulatorInstance = new SwapSimulator(config, provider); logger.info('[Main] Swap Simulator initialized.');

        // *** Instantiate GasEstimator ***
        logger.info('[Main] Initializing Gas Estimator...'); if (typeof GasEstimator !== 'function') throw new TypeError(`GasEstimator class not loaded.`); gasEstimatorInstance = new GasEstimator(config, provider); logger.info('[Main] Gas Estimator initialized.');
        // *** --- ***

        logger.info('[Main] Initializing Flash Swap Manager instance...'); if (typeof FlashSwapManager !== 'function') throw new TypeError(`FlashSwapManager class not loaded.`); flashSwapManagerInstance = new FlashSwapManager(config, provider); const signerAddress = await flashSwapManagerInstance.getSignerAddress(); logger.info(`[Main] Flash Swap Manager initialized. Signer: ${signerAddress}`); const contractTarget = flashSwapManagerInstance.getFlashSwapContract()?.target; logger.info(`[Main] Using FlashSwap contract at: ${contractTarget || 'Not Initialized'}`);

        logger.info('[Main] Initializing Arbitrage Engine...'); if (typeof ArbitrageEngine !== 'function') throw new TypeError(`ArbitrageEngine constructor not found!`);
        // *** Pass gasEstimatorInstance to ArbitrageEngine ***
        arbitrageEngineInstance = new ArbitrageEngine(config, provider, swapSimulatorInstance, gasEstimatorInstance); logger.info('[Main] Arbitrage Engine initialized.');

        arbitrageEngineInstance.on('profitableOpportunities', (trades) => { /* ... */ });
        logger.info('[Main] Starting Arbitrage Engine cycle...'); await arbitrageEngineInstance.start();
        logger.info('\n>>> BOT IS RUNNING <<<'); logger.info('(Press Ctrl+C to stop)'); logger.info('======================');
    } catch (error) { /* ... */ }
}
main().catch(error => { /* ... */ });
