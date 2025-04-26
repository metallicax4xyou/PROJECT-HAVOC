// utils/gasEstimator.js
// --- VERSION v1.8 --- Pass minOut=1 to DODO buyBaseToken during estimation

const { ethers } = require('ethers');
const logger = require('./logger');
const { ArbitrageError } = require('./errorHandler');
const ErrorHandler = require('./errorHandler'); // Ensure ErrorHandler is imported
// const TxParamBuilder = require('../core/tx/paramBuilder'); // Keep commented if using lazy require
const { ABIS } = require('../constants/abis'); // Need FlashSwap ABI for interface

// Ensure FlashSwap ABI is loaded for encoding function calls
let flashSwapInterface;
if (!ABIS.FlashSwap) {
    logger.error('[GasEstimator Init] CRITICAL: FlashSwap ABI not found in ABIS constant.');
    flashSwapInterface = null; // Mark as unavailable
} else {
    try {
        flashSwapInterface = new ethers.Interface(ABIS.FlashSwap);
    } catch (abiError) {
        logger.error('[GasEstimator Init] CRITICAL: Failed to create Interface from FlashSwap ABI.', abiError);
        flashSwapInterface = null;
    }
}


class GasEstimator {
    constructor(config, provider) {
        logger.debug('[GasEstimator v1.8] Initializing...'); // Version bump
        if (!config || !provider) throw new ArbitrageError('GasEstimatorInit', 'Config/Provider required.');
        if (!config.GAS_COST_ESTIMATES?.FLASH_SWAP_BASE) logger.warn('[GasEstInit] GAS_COST_ESTIMATES incomplete.');
        if (!flashSwapInterface) logger.error('[GasEstInit] FlashSwap Interface could not be initialized. estimateGas check will fail.');

        this.config = config;
        this.provider = provider;
        this.gasEstimates = config.GAS_COST_ESTIMATES || {};
        this.maxGasPriceGwei = ethers.parseUnits(String(config.MAX_GAS_GWEI || 1), 'gwei');
        this.fallbackGasLimit = BigInt(config.FALLBACK_GAS_LIMIT || 3000000);

        logger.info(`[GasEstimator v1.8] Initialized. Path-based est + Provider-specific estimateGas check. Max Gas Price: ${ethers.formatUnits(this.maxGasPriceGwei, 'gwei')} Gwei`);
    }

    async getFeeData() {
        try {
             const feeData = await this.provider.getFeeData();
             if (!feeData || (!feeData.gasPrice && !feeData.maxFeePerGas)) {
                logger.warn('[GasEstimator] Fetched feeData is missing both gasPrice and maxFeePerGas.');
                 return null;
             }
             return feeData;
         } catch (error) {
             logger.error(`[GasEstimator] Failed to get fee data: ${error.message}`);
             return null;
         }
    }

    getEffectiveGasPrice(feeData) {
         if (!feeData) return null;
         let effectivePrice = 0n;

         if (feeData.maxFeePerGas) { effectivePrice = feeData.maxFeePerGas; }
         else if (feeData.gasPrice) { effectivePrice = feeData.gasPrice; }
         else { logger.warn('[GasEstimator] No valid gas price (maxFeePerGas or gasPrice) in feeData.'); return null; }

         if (effectivePrice > this.maxGasPriceGwei) {
              logger.warn(`[GasEstimator] Clamping effective gas price ${ethers.formatUnits(effectivePrice, 'gwei')} Gwei to MAX ${ethers.formatUnits(this.maxGasPriceGwei, 'gwei')} Gwei.`);
              return this.maxGasPriceGwei;
         }
         return effectivePrice;
    }

    /**
     * Encodes minimal transaction calldata for either UniV3 or Aave flash loan for gas estimation check.
     * Uses minimal amounts (1 wei borrow, 0 min out, adjusted to 1 for DODO quote sell).
     * @param {object} opportunity The opportunity object.
     * @param {string} providerType 'UNIV3' or 'AAVE'.
     * @returns {{ calldata: string, contractFunctionName: string } | null} Encoded data and function name, or null on error.
     * @private Internal helper method
     */
    async _encodeMinimalCalldataForEstimate(opportunity, providerType) {
        const logPrefix = `[GasEstimator Opp ${opportunity?.pairKey} ENC v1.8]`; // Version bump
        if (!flashSwapInterface) {
             logger.error(`${logPrefix} FlashSwap Interface not available. Cannot encode.`);
             return null;
        }

        // Import main builder index lazily inside function scope to potentially help with circular deps
        let TxParamBuilder;
        try {
             TxParamBuilder = require('../core/tx/paramBuilder');
        } catch (requireError) {
             logger.error(`${logPrefix} Failed to require main TxParamBuilder: ${requireError.message}`);
             return null;
        }


        try {
            // Minimal simulation result placeholder for builders
            // Note: finalAmount=0n is key, hop1AmountOut is for buildTwoHopParams
            const minimalSimResult = { initialAmount: 1n, hop1AmountOut: 0n, finalAmount: 0n };
            let builderFunction;
            let buildResult;

            if (providerType === 'UNIV3') {
                 const dexPath = opportunity.path.map(p => p.dex).join('->');
                 if (opportunity.type === 'spatial' && dexPath === 'uniswapV3->uniswapV3') {
                     builderFunction = TxParamBuilder.buildTwoHopParams;
                 } else if (opportunity.type === 'triangular') {
                     builderFunction = TxParamBuilder.buildTriangularParams;
                 } else {
                     throw new Error(`Unsupported opportunity type/path for UniV3 estimateGas encoding: ${opportunity.type} / ${dexPath}`);
                 }
                 if (!builderFunction) throw new Error("UniV3 builder function not found in TxParamBuilder.");

                 buildResult = builderFunction(opportunity, minimalSimResult, this.config);

                 const encodedParamsBytes = ethers.AbiCoder.defaultAbiCoder().encode([buildResult.typeString], [buildResult.params]);
                 const borrowPoolState = opportunity.path[0].poolState;
                 if (!borrowPoolState || !borrowPoolState.token0?.address || !borrowPoolState.token1?.address) { throw new Error("Invalid V3 borrow pool state for estimateGas encoding."); }
                 let amount0 = 0n; let amount1 = 0n;
                 if (buildResult.borrowTokenAddress.toLowerCase() === borrowPoolState.token0.address.toLowerCase()) amount0 = 1n;
                 else if (buildResult.borrowTokenAddress.toLowerCase() === borrowPoolState.token1.address.toLowerCase()) amount1 = 1n;
                 else { throw new Error(`Borrow token mismatch for UniV3 estimateGas encoding.`); }
                 const args = [borrowPoolState.address, amount0, amount1, encodedParamsBytes];
                 const calldata = flashSwapInterface.encodeFunctionData(buildResult.contractFunctionName, args);
                 return { calldata, contractFunctionName: buildResult.contractFunctionName };

            } else if (providerType === 'AAVE') {
                 builderFunction = TxParamBuilder.buildAavePathParams;
                 if (!builderFunction) throw new Error("Aave builder function not found in TxParamBuilder exports.");
                 const tempManager = { getSignerAddress: async () => ethers.ZeroAddress }; // Placeholder!
                 // Call builder with minimal sim results
                 buildResult = await builderFunction(opportunity, minimalSimResult, this.config, tempManager);

                 // --- ADJUSTMENT for DODO QUOTE SELL during estimation ---
                 let adjustedParams = { ...buildResult.params }; // Create a shallow copy
                 let adjustedPath = [...adjustedParams.path]; // Create a shallow copy of the path array
                 adjustedParams.path = adjustedPath; // Assign the copied path array back

                 let needsReEncoding = false; // Flag if adjustment occurred
                 for(let i = 0; i < adjustedPath.length; i++) {
                     const step = adjustedPath[i];
                     // Check if it's a DODO step AND selling the quote token (tokenIn != baseToken)
                     // Need pool info from config to find base token
                     const poolInfo = this.config.POOL_CONFIGS?.find(p => p.address.toLowerCase() === step.pool.toLowerCase() && p.dexType === 'dodo');
                     const baseTokenSymbol = poolInfo?.baseTokenSymbol;
                     const baseToken = baseTokenSymbol ? this.config.TOKENS[baseTokenSymbol] : null;

                     if (step.dexType === 2 /* DEX_TYPE_DODO */ && baseToken && step.tokenIn.toLowerCase() !== baseToken.address.toLowerCase()) {
                          // This is a DODO quote sell. If minOut is currently 0 (from minimalSimResult), set it to 1 for estimation.
                          // We need to check the original buildResult param's minOut value
                          if (buildResult.params.path[i].minOut === 0n) {
                              logger.debug(`${logPrefix} Adjusting DODO quote sell minOut from 0 to 1 for step ${i} during gas estimation encoding.`);
                              // IMPORTANT: Modify the step object within the *copied* path array
                              adjustedPath[i] = { ...step, minOut: 1n }; // Use 1n (BigInt one)
                              needsReEncoding = true; // Indicate we need to encode the adjustedParams
                          }
                     }
                 }
                 // --- END ADJUSTMENT ---

                 // Encode the parameters struct (use adjustedParams if needed, otherwise original)
                 const paramsToEncode = needsReEncoding ? adjustedParams : buildResult.params;
                 const encodedArbParamsBytes = ethers.AbiCoder.defaultAbiCoder().encode([buildResult.typeString], [paramsToEncode]);

                 // Determine Args (amount = 1 wei)
                 const args = [[buildResult.borrowTokenAddress], [1n], encodedArbParamsBytes];
                 const calldata = flashSwapInterface.encodeFunctionData('initiateAaveFlashLoan', args);
                 return { calldata, contractFunctionName: 'initiateAaveFlashLoan' };

            } else {
                throw new Error(`Invalid providerType: ${providerType}`);
            }
        } catch (error) {
            logger.error(`${logPrefix} Failed to encode minimal calldata: ${error.message}`, error);
            return null;
        }
    }

    /**
     * Estimates gas cost using path-based heuristics & performs an estimateGas check
     * using provider-specific calldata (UniV3 or Aave).
     * @param {object} opportunity The opportunity object.
     * @param {string} signerAddress The address of the bot's signer wallet.
     * @returns {Promise<{ pathGasLimit: bigint, effectiveGasPrice: bigint, totalCostWei: bigint, estimateGasSuccess: boolean } | null>}
     */
    async estimateTxGasCost(opportunity, signerAddress) {
        const logPrefix = `[GasEstimator Opp ${opportunity?.pairKey}]`;
        logger.debug(`${logPrefix} Starting path-based gas estimation & validity check...`);
        if (!signerAddress || !ethers.isAddress(signerAddress)) { logger.error(`${logPrefix} Invalid signerAddress.`); return null; }
        if (!opportunity?.path || opportunity.path.length === 0) { logger.error(`${logPrefix} Invalid opportunity path.`); return null; }
        if (!flashSwapInterface) { logger.error(`${logPrefix} FlashSwap Interface not available. Aborting estimate.`); return null; }

        // --- 1. Get Gas Price ---
        const feeData = await this.getFeeData();
        const effectiveGasPrice = this.getEffectiveGasPrice(feeData);
        if (!effectiveGasPrice) { logger.error(`${logPrefix} Failed effective gas price.`); return null; }
        logger.debug(`${logPrefix} Effective Gas Price: ${ethers.formatUnits(effectiveGasPrice, 'gwei')} Gwei`);

        // --- 2. Calculate Path-Based Gas Limit (Heuristic) ---
        let pathGasLimit = this.gasEstimates.FLASH_SWAP_BASE || this.fallbackGasLimit;
        logger.debug(`${logPrefix} Calculating path gas: ${opportunity.path.map(p=>p.dex).join('->')}`);
        for (const step of opportunity.path) {
             let hopCost = 0n;
             const dexKey = step.dex?.toLowerCase();
             if (dexKey === 'uniswapv3') hopCost = this.gasEstimates.UNISWAP_V3_SWAP || 0n;
             else if (dexKey === 'sushiswap') hopCost = this.gasEstimates.SUSHISWAP_V2_SWAP || 0n;
             else if (dexKey === 'dodo') hopCost = this.gasEstimates.DODO_SWAP || 0n;
             else { logger.warn(`${logPrefix} Unknown DEX '${step.dex}' in path gas cost calc.`); }
             if (hopCost === 0n) logger.warn(`${logPrefix} Gas estimate missing or zero for DEX '${step.dex}'.`);
             pathGasLimit += hopCost;
         }
         const bufferPercent = BigInt(this.config.GAS_ESTIMATE_BUFFER_PERCENT || 0);
         if (bufferPercent > 0n) { pathGasLimit += (pathGasLimit * bufferPercent) / 100n; }
         logger.debug(`${logPrefix} Path-based limit (+buffer): ${pathGasLimit}`);
        if (pathGasLimit <= 0n) { logger.error(`${logPrefix} Invalid path-based limit: ${pathGasLimit}`); return null; }

        // --- 3. Determine Provider Type & Encode Minimal Calldata ---
        const providerType = (opportunity.path[0].dex === 'uniswapV3') ? 'UNIV3' : 'AAVE';
        logger.debug(`${logPrefix} Encoding minimal calldata for provider type: ${providerType}`);
        const encodedResult = await this._encodeMinimalCalldataForEstimate(opportunity, providerType);

        if (!encodedResult || !encodedResult.calldata) {
             logger.warn(`${logPrefix} Encoding minimal calldata failed. Cannot perform estimateGas check. Assuming path invalid.`);
             return { pathGasLimit, effectiveGasPrice, totalCostWei: pathGasLimit * effectiveGasPrice, estimateGasSuccess: false };
        }
        const { calldata: encodedData, contractFunctionName } = encodedResult;
        logger.debug(`${logPrefix} Minimal calldata encoded for function: ${contractFunctionName}`);

        // --- 4. Perform estimateGas as a Validity Check ---
        let estimateGasSuccess = false;
        try {
            logger.debug(`${logPrefix} Performing estimateGas validity check for ${contractFunctionName}...`);
            await this.provider.estimateGas({
                to: this.config.FLASH_SWAP_CONTRACT_ADDRESS,
                data: encodedData,
                from: signerAddress
            });
            estimateGasSuccess = true;
            logger.debug(`${logPrefix} estimateGas check PASSED.`); // <<< WE WANT TO SEE THIS!
        } catch (error) {
             let reason = error.reason || error.code || error.message;
             logger.warn(`${logPrefix} estimateGas check FAILED for ${contractFunctionName} (TX likely reverts): ${reason}. Marking opportunity invalid.`);
             // Use the imported ErrorHandler
             ErrorHandler.handleError(error, `GasEstimator estimateGas Check (${contractFunctionName})`);
             estimateGasSuccess = false;
        }

        // --- 5. Calculate Final Cost using Path-Based Estimate ---
        const totalCostWei = pathGasLimit * effectiveGasPrice;
        logger.info(`${logPrefix} Final Estimated Gas: PathLimit=${pathGasLimit}, Price=${ethers.formatUnits(effectiveGasPrice, 'gwei')} Gwei, Cost=${ethers.formatEther(totalCostWei)} ETH. estimateGas check: ${estimateGasSuccess ? 'OK' : 'FAIL'}`);

        return {
            pathGasLimit: pathGasLimit, effectiveGasPrice: effectiveGasPrice,
            totalCostWei: totalCostWei, estimateGasSuccess: estimateGasSuccess
        };
    }
}

module.exports = GasEstimator;
