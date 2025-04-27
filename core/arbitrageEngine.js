// core/arbitrageEngine.js
// --- VERSION v1.5 --- Added config debug log

const { EventEmitter } = require('events');
const { ethers } = require('ethers');
const PoolScanner = require('./poolScanner');
const ProfitCalculator = require('./profitCalculator');
const SpatialFinder = require('./finders/spatialFinder');
const logger = require('../utils/logger');
const { ArbitrageError } = require('../utils/errorHandler');
const { TOKENS } = require('../constants/tokens');

class ArbitrageEngine extends EventEmitter {
    constructor(config, provider, swapSimulator, gasEstimator, flashSwapManager) {
        super();
        logger.info('[AE v1.5] Initializing ArbitrageEngine components...'); // Version bump
        // Validation...
        if (!config) throw new ArbitrageError('InitializationError', 'AE: Missing config.');
        if (!provider) throw new ArbitrageError('InitializationError', 'AE: Missing provider.');
        if (!swapSimulator?.simulateSwap) throw new ArbitrageError('InitializationError', 'AE: Invalid SwapSimulator.');
        if (!gasEstimator?.estimateTxGasCost) throw new ArbitrageError('InitializationError', 'AE: Invalid GasEstimator.');
        if (!flashSwapManager || typeof flashSwapManager.getSignerAddress !== 'function') { throw new ArbitrageError('InitializationError', 'AE: Invalid FlashSwapManager instance required.'); }
        // No need to check config.provider here, bot.js ensures it

        this.config = config;
        this.provider = provider;
        this.flashSwapManager = flashSwapManager;
        // Pass dependencies directly to ProfitCalculator constructor
        this.profitCalculator = new ProfitCalculator(this.config, this.provider, swapSimulator, gasEstimator);

        this.isRunning = false; this.cycleInterval = null; this.isCycleRunning = false;
        this.nativeSymbol = this.config.NATIVE_CURRENCY_SYMBOL || 'ETH';

        // +++ ADD DEBUG LOG +++
        logger.debug('[AE Constructor] Received config object keys:', Object.keys(config));
        // Log specifically if FINDER_SETTINGS exists and its type
        logger.debug(`[AE Constructor] config.FINDER_SETTINGS exists: ${!!config.FINDER_SETTINGS}, type: ${typeof config.FINDER_SETTINGS}`);
        // Optionally log the FINDER_SETTINGS content if debug is needed (can be large)
        // try { logger.debug('[AE Constructor] config.FINDER_SETTINGS content:', JSON.stringify(config.FINDER_SETTINGS, (k,v) => typeof v === 'bigint' ? v.toString() : v, 2)); } catch {}
        // +++ END DEBUG LOG +++

        try {
            // Initialize components used within the cycle
            this.poolScanner = new PoolScanner(config); // Pass full config
            // This is where the error occurs if config is missing FINDER_SETTINGS
            this.spatialFinder = new SpatialFinder(config); // Pass full config
        } catch (error) {
            logger.error(`[AE] CRITICAL ERROR during component init: ${error.message}`, error);
            // Add more context to the wrapping error
            throw new ArbitrageError(`InitializationError`, `Failed AE components: ${error.message}`, error);
        }
        logger.info('[AE v1.5] ArbitrageEngine components initialized successfully.');
    }

    async start() { /* ... unchanged ... */ logger.info('[AE.start] Attempting to start engine...'); if (this.isRunning) { logger.warn('[AE.start] Engine already running.'); return; } this.isRunning = true; logger.info('[AE.start] Engine marked as running. Executing initial runCycle...'); try { logger.debug('[AE.start] >>> Calling initial runCycle...'); await this.runCycle(); logger.debug('[AE.start] <<< Initial runCycle finished.'); } catch(error) { logger.error('[AE.start] CRITICAL ERROR during initial runCycle execution:', error); logger.info('[AE.start] Stopping engine due to initial cycle failure.'); this.stop(); return; } if (this.isRunning) { logger.debug('[AE.start] Setting up cycle interval...'); this.cycleInterval = setInterval(() => { this.runCycle().catch(intervalError => { logger.error('[AE Interval Error] Error caught from runCycle:', intervalError); }); }, this.config.CYCLE_INTERVAL_MS); if (this.cycleInterval) { logger.info(`[AE.start] Engine started successfully. Cycle interval: ${this.config.CYCLE_INTERVAL_MS}ms`); } else { logger.error('[AE.start] Failed to set cycle interval!'); this.stop(); } } else { logger.warn('[AE.start] Engine stopped during initial runCycle.'); } }
    stop() { /* ... unchanged ... */ logger.info('[AE.stop] Stopping Arbitrage Engine...'); if (!this.isRunning && !this.cycleInterval) { logger.warn('[AE.stop] Engine already stopped.'); return; } this.isRunning = false; if (this.cycleInterval) { clearInterval(this.cycleInterval); this.cycleInterval = null; logger.debug('[AE.stop] Cycle interval cleared.'); } this.isCycleRunning = false; logger.info('[AE.stop] Arbitrage Engine stopped.'); }

    async runCycle() { /* ... unchanged ... */ const cycleStartTime = Date.now(); logger.info('[AE.runCycle] ===== Starting New Cycle ====='); if (!this.isRunning) { logger.info('[AE.runCycle] Engine stopped.'); return; } if (this.isCycleRunning) { logger.warn('[AE.runCycle] Previous cycle still running. Skipping.'); return; } this.isCycleRunning = true; let cycleStatus = 'FAILED'; try { const { poolStates, pairRegistry } = await this._fetchPoolData(); const allOpportunities = this._findOpportunities(poolStates, pairRegistry); if (allOpportunities.length > 0) { const profitableTrades = await this._calculateProfitability(allOpportunities); if (profitableTrades.length > 0) { this._handleProfitableTrades(profitableTrades); } } else { logger.info('[AE.runCycle] No potential opportunities found by finders.'); } cycleStatus = 'COMPLETED'; } catch (error) { logger.error('[AE.runCycle] !!!!!!!! ERROR during cycle !!!!!!!!!!'); logger.error(`[AE.runCycle] Error Type: ${error.constructor.name}, Msg: ${error.message}`); if (!(error instanceof ArbitrageError)) { logger.error('[AE.runCycle] Stack:', error.stack); } cycleStatus = `FAILED (${error.type || error.constructor.name})`; } finally { const cycleEndTime = Date.now(); const duration = cycleEndTime - cycleStartTime; logger.info(`[AE.runCycle] ===== Cycle ${cycleStatus}. Duration: ${duration}ms =====`); this.isCycleRunning = false; } }
    async _fetchPoolData() { /* ... unchanged ... */ logger.info('[AE._fetchPoolData] Fetching pool states...'); if (!this.poolScanner) throw new ArbitrageError("PoolScanner missing.", 'INTERNAL_ERROR'); const { poolStates, pairRegistry } = await this.poolScanner.fetchPoolStates(); logger.info(`[AE._fetchPoolData] Fetched ${poolStates.length} pool states. Registry size: ${pairRegistry.size}`); return { poolStates, pairRegistry }; }
    _findOpportunities(poolStates, pairRegistry) { /* ... unchanged ... */ logger.info('[AE._findOpportunities] Finding potential opportunities...'); let allOpportunities = []; if (this.spatialFinder && pairRegistry) { this.spatialFinder.updatePairRegistry(pairRegistry); } if (this.spatialFinder && poolStates.length > 0) { logger.info('[AE._findOpportunities] Running SpatialFinder...'); const spatialOpportunities = this.spatialFinder.findArbitrage(poolStates); logger.info(`[AE._findOpportunities] SpatialFinder found ${spatialOpportunities.length} potentials.`); allOpportunities = allOpportunities.concat(spatialOpportunities); } else if (!this.spatialFinder) { logger.warn("[AE._findOpportunities] SpatialFinder missing."); } logger.info(`[AE._findOpportunities] Total potential opportunities found: ${allOpportunities.length}`); return allOpportunities; }
    async _calculateProfitability(opportunities) { /* ... unchanged ... */ logger.info(`[AE._calculateProfitability] Calculating profitability for ${opportunities.length} opportunities...`); if (!this.profitCalculator) { logger.error("[AE._calculateProfitability] ProfitCalculator instance missing!"); return []; } if (!this.flashSwapManager) { logger.error("[AE._calculateProfitability] FlashSwapManager instance missing!"); return []; } let signerAddress = null; try { signerAddress = await this.flashSwapManager.getSignerAddress(); if (!signerAddress || !ethers.isAddress(signerAddress)) { throw new Error(`Invalid signer address returned: ${signerAddress}`); } logger.debug(`[AE._calculateProfitability] Using signer address for gas estimation: ${signerAddress}`); } catch (addrError) { logger.error(`[AE._calculateProfitability] CRITICAL: Could not get signer address: ${addrError.message}`); throw new ArbitrageError(`Failed to retrieve signer address: ${addrError.message}`, 'INTERNAL_ERROR', addrError); } const profitableTrades = await this.profitCalculator.calculate(opportunities, signerAddress); logger.info(`[AE._calculateProfitability] Found ${profitableTrades.length} profitable trades (after gas/threshold).`); return profitableTrades; }
    _handleProfitableTrades(profitableTrades) { /* ... unchanged ... */ logger.info(`[AE._handleProfitableTrades] --- ✅ Profitable Trades Found (${profitableTrades.length}) ---`); profitableTrades.forEach((trade, index) => { this._logTradeDetails(trade, index + 1); }); this.emit('profitableOpportunities', profitableTrades); logger.info(`[AE._handleProfitableTrades] --- Emitted 'profitableOpportunities' event ---`); }
    _logTradeDetails(trade, index) { /* ... unchanged ... */ try { const pathDesc = trade.path?.map(p => { const symbols = p.poolState?.token0Symbol && p.poolState?.token1Symbol ? `${p.poolState.token0Symbol}/${p.poolState.token1Symbol}` : '?/?'; return `${p.dex || '?'}(${symbols})`; }).join('->') || 'N/A'; const formatEth = (weiStr) => { if (!weiStr) return 'N/A'; try { return ethers.formatEther(BigInt(weiStr)); } catch { return 'Error'; } }; const formatUnits = (amountStr, tokenSymbol) => { if (!amountStr || !tokenSymbol) return 'N/A'; try { const token = this.config.TOKENS[tokenSymbol]; const decimals = token?.decimals || 18; return ethers.formatUnits(BigInt(amountStr), decimals); } catch { return 'Error'; } }; const profitEth = formatEth(trade.netProfitNativeWei); const gasEth = formatEth(trade.gasCostNativeWei); const thresholdEth = formatEth(trade.thresholdNativeWei); logger.info(`  [${index}] ${trade.type} | ${pathDesc}`); logger.info(`      In: ${formatUnits(trade.amountIn, trade.tokenIn?.symbol)} ${trade.tokenIn?.symbol} | Sim Out: ${formatUnits(trade.amountOut, trade.tokenOut?.symbol)} ${trade.tokenOut?.symbol}`); logger.info(`      NET Profit: ~${profitEth} ${this.nativeSymbol} (Gas Cost ~${gasEth} ${this.nativeSymbol})`); logger.info(`      Threshold Used (Native): ${thresholdEth} ${this.nativeSymbol}`); if (trade.profitPercentage) { logger.info(`      Profit Percentage: ~${trade.profitPercentage.toFixed(4)}%`); } } catch (logError) { logger.error(`[AE._logTradeDetails] Error logging trade details for index ${index}: ${logError.message}`); try { logger.debug("Raw trade object:", JSON.stringify(trade, null, 2)); } catch { logger.debug("Raw trade object: (Cannot stringify)");} } }

} // End ArbitrageEngine class

module.exports = ArbitrageEngine;
