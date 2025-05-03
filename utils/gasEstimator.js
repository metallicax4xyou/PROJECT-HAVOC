// utils/gasEstimator.js
// --- VERSION v1.11 --- Pass titheRecipient from config to tx builders during minimal calldata encoding for estimateGas check.

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
        logger.debug('[GasEstimator v1.11] Initializing...'); // Version bump
        if (!config || !provider) throw new ArbitrageError('GasEstimatorInit', 'Config/Provider required.');
        if (!config.GAS_COST_ESTIMATES?.FLASH_SWAP_BASE) logger.warn('[GasEstInit] GAS_COST_ESTIMATES incomplete.');
        if (!flashSwapInterface) logger.error('[GasEstInit] FlashSwap Interface could not be initialized. estimateGas check will fail.');
        // Add check for TITHE_WALLET_ADDRESS in config
        if (!config.TITHE_WALLET_ADDRESS || !ethers.isAddress(config.TITHE_WALLET_ADDRESS)) {
            // This isn't strictly CRITICAL for gas estimation itself, but crucial for builders
             logger.warn('[GasEstInit] WARNING: TITHE_WALLET_ADDRESS is missing or invalid in config. Parameter builders may fail.');
        }


        this.config = config;
        this.provider = provider;
        this.gasEstimates = config.GAS_COST_ESTIMATES || {};
        this.maxGasPriceGwei = ethers.parseUnits(String(config.MAX_GAS_GWEI || 1), 'gwei');
        this.fallbackGasLimit = BigInt(config.FALLBACK_GAS_LIMIT || 3000000);

        logger.info(`[GasEstimator v1.11] Initialized. Path-based est + Provider-specific estimateGas check. Max Gas Price: ${ethers.formatUnits(this.maxGasPriceGwei, 'gwei')} Gwei`); // Version bump
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

         // Added buffer to effective price based on type 2 vs legacy tx, but let's keep simple for now.
         // effectivePrice = feeData.maxFeePerGas ? feeData.maxFeePerGas + (feeData.maxPriorityFeePerGas || 0n) : feeData.gasPrice;

         // Only clamp if effectivePrice is derived validly
         if (effectivePrice > 0n && effectivePrice > this.maxGasPriceGwei) {
              logger.warn(`[GasEstimator] Clamping effective gas price ${ethers.formatUnits(effectivePrice, 'gwei')} Gwei to MAX ${ethers.formatUnits(this.maxGasPriceGwei, 'gwei')} Gwei.`);
              return this.maxGasPriceGwei;
         } else if (effectivePrice <= 0n) {
              logger.warn('[GasEstimator] Effective gas price calculated as non-positive.');
              return null; // Treat non-positive price as invalid
         }
         return effectivePrice;
    }


    /**
     * Encodes minimal transaction calldata for either UniV3 or Aave flash loan for gas estimation check.
     * Uses minimal amounts (1 wei borrow, 0 min out, adjusted to 1 for DODO buyBaseToken during estimate encoding).
     * Passes the titheRecipient address from config to the parameter builders.
     * @param {object} opportunity The opportunity object.
     * @param {string} providerType 'UNIV3' or 'AAVE'.
     * @returns {{ calldata: string, contractFunctionName: string } | null} Encoded data and function name, or null on error.
     * @private Internal helper method
     */
    async _encodeMinimalCalldataForEstimate(opportunity, providerType) {
        const logPrefix = `[GasEstimator Opp ${opportunity?.pairKey} ENC v1.11]`; // Version bump
        if (!flashSwapInterface) {
             logger.error(`${logPrefix} FlashSwap Interface not available. Cannot encode.`);
             return null;
        }
        // Retrieve titheRecipient from config
        const titheRecipient = this.config.TITHE_WALLET_ADDRESS;
         if (!titheRecipient || !ethers.isAddress(titheRecipient)) {
             logger.error(`${logPrefix} Invalid TITHE_WALLET_ADDRESS in config: ${titheRecipient}. Cannot encode minimal calldata.`);
             return null; // Cannot proceed without a valid tithe recipient for builders
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
            // Note: initialAmount=1n (minimal borrow), hop1AmountOut=0n (placeholder), finalAmount=0n (placeholder)
            const minimalSimResult = { initialAmount: 1n, hop1AmountOut: 0n, finalAmount: 0n };
            let builderFunction;
            let buildResult;

            if (providerType === 'UNIV3') {
                 const dexPath = opportunity.path.map(p => p.dex).join('->');
                 if (opportunity.type === 'spatial' && dexPath === 'uniswapV3->uniswapV3') {
                     builderFunction = TxParamBuilder.buildTwoHopParams; // Expects 4 args: opportunity, simResult, config, titheRecipient
                 } else if (opportunity.type === 'triangular') {
                     builderFunction = TxParamBuilder.buildTriangularParams; // Expects 4 args: opportunity, simResult, config, titheRecipient
                 } else {
                     throw new Error(`Unsupported opportunity type/path for UniV3 estimateGas encoding: ${opportunity.type} / ${dexPath}`);
                 }
                 if (!builderFunction) throw new Error("UniV3 builder function not found in TxParamBuilder.");

                 // --- Pass titheRecipient to the builder ---
                 buildResult = builderFunction(opportunity, minimalSimResult, this.config, titheRecipient);

                 // Encoding logic (remains the same)
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
                 builderFunction = TxParamBuilder.buildAavePathParams; // Expects 5 args: opportunity, simResult, config, flashSwapManager, titheRecipient
                 if (!builderFunction) throw new Error("Aave builder function not found in TxParamBuilder exports.");
                 // Pass a placeholder manager if needed by the builder, but the actual one is better if it provides signer address etc.
                 // const tempManager = { getSignerAddress: async () => ethers.ZeroAddress }; // Placeholder!
                 // Use the actual flashSwapManager instance if the builder needs it
                 const actualFlashSwapManager = this.flashSwapManager;

                 // --- Pass titheRecipient to the builder ---
                 buildResult = await builderFunction(opportunity, minimalSimResult, this.config, actualFlashSwapManager, titheRecipient);


                 // --- ADJUSTMENT for DODO QUOTE SELL during estimation (remains the same) ---
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
                          if (buildResult.params.path[i].minOut === 0n) { // Check original params minOut value
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

                 // Determine Args (amount = 1 wei for each borrowed token in the minimal sim)
                 // Aave loans require token addresses and amounts arrays
                 // This needs to match the initiateAaveFlashLoan function signature in FlashSwap.sol
                 // minimalSimResult.initialAmount is 1n, buildResult.borrowTokenAddress is the token address
                 const args = [[buildResult.borrowTokenAddress], [minimalSimResult.initialAmount], encodedArbParamsBytes];
                 const calldata = flashSwapInterface.encodeFunctionData('initiateAaveFlashLoan', args);
                 return { calldata, contractFunctionName: 'initiateAaveFlashLoan' };

            } else {
                throw new Error(`Invalid providerType: ${providerType}`);
            }
        } catch (error) {
            logger.error(`${logPrefix} Failed to encode minimal calldata: ${error.message}`, error);
            // Log builder-specific errors with their type and details if available
            if (error instanceof ArbitrageError && error.type === 'PARAM_BUILD_ERROR') {
                logger.error(`${logPrefix} Parameter build error: ${error.message}`, error.details);
            }
            return null; // Return null if encoding fails
        }
    }

    /**
     * Estimates gas cost using path-based heuristics & performs an estimateGas check
     * using provider-specific calldata (UniV3 or Aave).
     * @param {object} opportunity The opportunity object.
     * @param {string} walletSignerAddress The address of the bot's signer wallet (for estimateGas 'from' field).
     * @returns {Promise<{ pathGasLimit: bigint, effectiveGasPrice: bigint, totalCostWei: bigint, estimateGasSuccess: boolean, errorMessage?: string } | null>}
     */
    async estimateTxGasCost(opportunity, walletSignerAddress) { // Renamed from signerAddress for clarity
        const logPrefix = `[GasEstimator Opp ${opportunity?.pairKey}]`;
        logger.debug(`${logPrefix} Starting path-based gas estimation & validity check...`);
        // Use the parameter name consistently
        if (!walletSignerAddress || !ethers.isAddress(walletSignerAddress)) {
             logger.error(`${logPrefix} Invalid walletSignerAddress received: ${walletSignerAddress}.`);
             // Return specific error state instead of null
             return { pathGasLimit: 0n, effectiveGasPrice: 0n, totalCostWei: 0n, estimateGasSuccess: false, errorMessage: "Invalid signerAddress received" };
        }
        logger.debug(`${logPrefix} Received walletSignerAddress for gas estimation: ${walletSignerAddress}`); // Confirm address is received


        if (!opportunity?.path || opportunity.path.length === 0) { logger.error(`${logPrefix} Invalid opportunity path.`); return null; }
        if (!flashSwapInterface) { logger.error(`${logPrefix} FlashSwap Interface not available. Aborting estimate.`); return null; }


        // --- 1. Get Gas Price ---
        const feeData = await this.getFeeData();
        const effectiveGasPrice = this.getEffectiveGasPrice(feeData);
        if (!effectiveGasPrice) { logger.error(`${logPrefix} Failed to get effective gas price.`); return null; }
        logger.debug(`${logPrefix} Effective Gas Price: ${ethers.formatUnits(effectiveGasPrice, 'gwei')} Gwei`);

        // --- 2. Calculate Path-Based Gas Limit (Heuristic) ---
        let pathGasLimit = BigInt(this.gasEstimates.FLASH_SWAP_BASE || 0); // Start with base cost, default to 0 if missing
        if (pathGasLimit <= 0n) {
             logger.warn(`${logPrefix} FLASH_SWAP_BASE gas estimate is missing or zero. Using fallbackGasLimit.`);
             pathGasLimit = this.fallbackGasLimit;
        }
        logger.debug(`${logPrefix} Initial path gas (base): ${pathGasLimit}`);

        logger.debug(`${logPrefix} Calculating path gas: ${opportunity.path.map(p=>p.dex).join('->')}`);
        for (const step of opportunity.path) {
             let hopCost = 0n;
             const dexKey = step.dex?.toLowerCase();
             if (dexKey === 'uniswapv3') hopCost = BigInt(this.gasEstimates.UNISWAP_V3_SWAP || 0);
             else if (dexKey === 'sushiswap') hopCost = BigInt(this.gasEstimates.SUSHISWAP_V2_SWAP || 0);
             else if (dexKey === 'dodo') hopCost = BigInt(this.gasEstimates.DODO_SWAP || 0);
             else { logger.warn(`${logPrefix} Unknown DEX '${step.dex}' in path gas cost calc.`); }
             if (hopCost === 0n) logger.warn(`${logPrefix} Gas estimate missing or zero for DEX '${step.dex}'. Using 0 for hop.`);
             pathGasLimit += hopCost;
         }

         // Apply buffer only if pathGasLimit is meaningful
         if (pathGasLimit > 0n) {
             const bufferPercent = BigInt(this.config.GAS_ESTIMATE_BUFFER_PERCENT || 0);
             if (bufferPercent > 0n) {
                 pathGasLimit += (pathGasLimit * bufferPercent) / 100n;
             }
         } else {
              logger.warn(`${logPrefix} Calculated pathGasLimit is zero or negative before buffer. Using fallback.`);
              pathGasLimit = this.fallbackGasLimit; // Fallback if heuristic results in 0 or less
         }

         logger.debug(`${logPrefix} Path-based limit (+buffer): ${pathGasLimit}`);

         // Final check on pathGasLimit sanity
        if (pathGasLimit <= 0n) {
             const errorMsg = `Invalid final path-based gas limit: ${pathGasLimit}`;
             logger.error(`${logPrefix} ${errorMsg}`);
             // Return specific error state
             return { pathGasLimit: 0n, effectiveGasPrice: effectiveGasPrice, totalCostWei: 0n, estimateGasSuccess: false, errorMessage: errorMsg };
        }


        // --- 3. Determine Provider Type & Encode Minimal Calldata ---
        const providerType = (opportunity.path[0].dex?.toLowerCase() === 'uniswapv3' && opportunity.path.length === 2 && opportunity.path[1].dex?.toLowerCase() === 'uniswapv3')
                             ? 'UNIV3' // UniV3 -> UniV3 two-hop uses initiateFlashSwap directly (requires UniV3 pool as FL provider)
                             : 'AAVE'; // Any other path type (including DODO, Sushi) assumes Aave flash loan is used

        logger.debug(`${logPrefix} Encoding minimal calldata for provider type: ${providerType}`);
        // Pass walletSignerAddress as the 'from' address for the estimateGas call
        const encodedResult = await this._encodeMinimalCalldataForEstimate(opportunity, providerType);


        if (!encodedResult || !encodedResult.calldata) {
             const errorMsg = encodedResult?.errorMessage || "Minimal calldata encoding failed. Cannot perform estimateGas check.";
             logger.warn(`${logPrefix} ${errorMsg}. Assuming tx invalid.`);
             // Return specific error state
             return { pathGasLimit, effectiveGasPrice, totalCostWei: pathGasLimit * effectiveGasPrice, estimateGasSuccess: false, errorMessage: errorMsg };
        }
        const { calldata: encodedData, contractFunctionName } = encodedResult;
        logger.debug(`${logPrefix} Minimal calldata encoded for function: ${contractFunctionName}`);

        // --- 4. Perform estimateGas as a Validity Check ---
        let estimateGasSuccess = false;
        let estimateGasError = null;
        let estimatedGasLimitFromProvider = 0n;

        try {
            logger.debug(`${logPrefix} Performing provider.estimateGas check for ${contractFunctionName} from ${walletSignerAddress}...`);
            // Use the walletSignerAddress as the 'from' address for the estimateGas call
            estimatedGasLimitFromProvider = await this.provider.estimateGas({
                to: this.config.FLASH_SWAP_CONTRACT_ADDRESS,
                data: encodedData,
                from: walletSignerAddress // Use the signer address here
            });
            estimateGasSuccess = true;
             // Use the estimated gas limit from the provider if it's greater than our path heuristic + buffer
             // This provides a more accurate lower bound.
             if (estimatedGasLimitFromProvider > pathGasLimit) {
                  logger.debug(`${logPrefix} Provider estimateGas (${estimatedGasLimitFromProvider}) is higher than path estimate (${pathGasLimit}). Using provider estimate.`);
                  pathGasLimit = estimatedGasLimitFromProvider; // Update pathGasLimit for cost calculation
             } else {
                  logger.debug(`${logPrefix} Provider estimateGas (${estimatedGasLimitFromProvider}) is lower than or equal to path estimate (${pathGasLimit}). Using path estimate.`);
             }

            logger.debug(`${logPrefix} estimateGas check PASSED. Estimated gas limit by provider: ${estimatedGasLimitFromProvider}`); // <<< WE WANT TO SEE THIS!
        } catch (error) {
             estimateGasError = error;
             let reason = error.reason || error.code || error.message;
             logger.warn(`${logPrefix} estimateGas check FAILED for ${contractFunctionName} (TX likely reverts): ${reason}. Marking opportunity invalid.`);
             // Use the imported ErrorHandler for structured logging and potential alerts
             ErrorHandler.handleError(error, `GasEstimator estimateGas Check (${contractFunctionName})`, {
                 opportunity: { pairKey: opportunity?.pairKey, type: opportunity?.type },
                 encodedData: encodedData?.substring(0, 100) + '...' // Log snippet
             });
             estimateGasSuccess = false;
             // Do NOT update pathGasLimit based on a failed estimateGas call
        }

        // --- 5. Calculate Final Cost using the (potentially updated) Path-Based Estimate ---
        // If estimateGas failed, pathGasLimit is still the heuristic one.
        const totalCostWei = pathGasLimit * effectiveGasPrice;
        logger.info(`${logPrefix} Final Estimated Gas: Limit=${pathGasLimit}, Price=${ethers.formatUnits(effectiveGasPrice, 'gwei')} Gwei, Cost=${ethers.formatEther(totalCostWei)} ${this.nativeSymbol}. estimateGas check: ${estimateGasSuccess ? 'OK' : 'FAIL'}`);

        // Return the result object, including success/failure status and potentially an error message
        return {
            pathGasLimit: pathGasLimit,
            effectiveGasPrice: effectiveGasPrice,
            totalCostWei: totalCostWei,
            estimateGasSuccess: estimateGasSuccess,
            errorMessage: estimateGasSuccess ? undefined : (estimateGasError?.reason || estimateGasError?.message || "EstimateGas check failed.")
        };
    }
}

module.exports = GasEstimator;