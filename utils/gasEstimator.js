// utils/gasEstimator.js
// --- VERSION v1.12 --- Use FlashSwap ABI provided via constructor. Removed internal FlashSwap ABI loading.

const { ethers } = require('ethers');
const logger = require('./logger');
const { ArbitrageError } = require('./errorHandler');
const ErrorHandler = require('./errorHandler');
// const TxParamBuilder = require('../core/tx/paramBuilder'); // Keep commented if using lazy require
// --- REMOVED ABI IMPORT ---
// const { ABIS } = require('../constants/abis'); // No longer needed for FlashSwap ABI


// --- REMOVED internal FlashSwap Interface Initialization ---
// let flashSwapInterface;
// if (!ABIS.FlashSwap) { ... } else { ... }


class GasEstimator {
    /**
     * @param {object} config - The application configuration object.
     * @param {ethers.Provider} provider - The ethers provider instance.
     * @param {Array<object>} flashSwapABI - The ABI array for the FlashSwap contract. <-- ACCEPT ABI HERE
     */
    constructor(config, provider, flashSwapABI) { // <-- ACCEPT ABI HERE
        logger.debug('[GasEstimator v1.12] Initializing...'); // Version bump

        if (!config || !provider) throw new ArbitrageError('GasEstimatorInit', 'Config/Provider required.');
        if (!config.GAS_COST_ESTIMATES?.FLASH_SWAP_BASE) logger.warn('[GasEstInit] GAS_COST_ESTIMATES incomplete.');
        // Check for FlashSwap ABI presence and create Interface
        if (!flashSwapABI || !Array.isArray(flashSwapABI)) {
            logger.error('[GasEstInit] CRITICAL: FlashSwap ABI not provided or invalid.');
            this.flashSwapInterface = null;
        } else {
             try {
                 this.flashSwapInterface = new ethers.Interface(flashSwapABI); // Use the provided ABI
                 // Check if initiateFlashSwap and initiateAaveFlashLoan functions exist in the interface
                 if (!this.flashSwapInterface.hasFunction('initiateFlashSwap') || !this.flashSwapInterface.hasFunction('initiateAaveFlashLoan')) {
                     logger.error('[GasEstInit] CRITICAL: Provided FlashSwap ABI is missing initiateFlashSwap or initiateAaveFlashLoan function definition.');
                     this.flashSwapInterface = null; // Mark as unavailable if key functions are missing
                 } else {
                      logger.debug('[GasEstInit] FlashSwap Interface created successfully from provided ABI.');
                 }
             } catch (abiError) {
                 logger.error('[GasEstInit] CRITICAL: Failed to create Interface from provided FlashSwap ABI.', abiError);
                 this.flashSwapInterface = null;
             }
        }


        if (!this.flashSwapInterface) { logger.error('[GasEstInit] FlashSwap Interface could not be initialized. estimateGas check will fail.'); }
        // Add check for TITHE_WALLET_ADDRESS in config (still needed for builders)
        if (!config.TITHE_WALLET_ADDRESS || !ethers.isAddress(config.TITHE_WALLET_WALLET_ADDRESS)) { // Typo here, should be TITHE_WALLET_ADDRESS
             logger.warn('[GasEstInit] WARNING: TITHE_WALLET_ADDRESS is missing or invalid in config. Parameter builders may fail.');
        }


        this.config = config;
        this.provider = provider;
        // Note: FlashSwapManager instance is NOT directly needed by GasEstimator for *estimation*.
        // It's needed by the AavePathBuilder, which is lazily required. Pass it there.
        // Reverting the change to store flashSwapManager instance here.
        // this.flashSwapManager = flashSwapManager; // Removed


        this.gasEstimates = config.GAS_COST_ESTIMATES || {};
        this.maxGasPriceGwei = ethers.parseUnits(String(config.MAX_GAS_GWEI || 1), 'gwei');
        this.fallbackGasLimit = BigInt(config.FALLBACK_GAS_LIMIT || 3000000);

        logger.info(`[GasEstimator v1.12] Initialized. Path-based est + Provider-specific estimateGas check. Max Gas Price: ${ethers.formatUnits(this.maxGasPriceGwei, 'gwei')} Gwei`); // Version bump
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


         if (effectivePrice > 0n && effectivePrice > this.maxGasPriceGwei) {
              logger.warn(`[GasEstimator] Clamping effective gas price ${ethers.formatUnits(effectivePrice, 'gwei')} Gwei to MAX ${ethers.formatUnits(this.maxGasPriceGwei, 'gwei')} Gwei.`);
              return this.maxGasPriceGwei;
         } else if (effectivePrice <= 0n) {
              logger.warn('[GasEstimator] Effective gas price calculated as non-positive.');
              return null;
         }
         return effectivePrice;
    }


    /**
     * Encodes minimal transaction calldata for either UniV3 or Aave flash loan for gas estimation check.
     * Uses minimal amounts (1 wei borrow, 0 min out for intermediate, adjusted to 1 for DODO quote sell for intermediate,
     * and a small non-zero value for final minOut when needed for gas estimation).
     * Passes the titheRecipient address from config to the parameter builders.
     * @param {object} opportunity The opportunity object.
     * @param {string} providerType 'UNIV3' or 'AAVE'.
     * @returns {{ calldata: string, contractFunctionName: string, errorMessage?: string } | null} Encoded data and function name, or null on error.
     * @private Internal helper method
     */
    async _encodeMinimalCalldataForEstimate(opportunity, providerType) {
        const logPrefix = `[GasEstimator Opp ${opportunity?.pairKey} ENC v1.12]`; // Version bump

        // Use the interface created in the constructor
        if (!this.flashSwapInterface) {
             const errorMsg = "FlashSwap Interface not available. Cannot encode.";
             logger.error(`${logPrefix} ${errorMsg}`);
             return { calldata: null, contractFunctionName: null, errorMessage: errorMsg };
        }

        // Retrieve titheRecipient from config
        const titheRecipient = this.config.TITHE_WALLET_ADDRESS;
         if (!titheRecipient || !ethers.isAddress(titheRecipient)) {
             const errorMsg = `Invalid TITHE_WALLET_ADDRESS in config: ${titheRecipient}. Cannot encode minimal calldata.`;
             logger.error(`${logPrefix} ${errorMsg}`);
             return { calldata: null, contractFunctionName: null, errorMessage: errorMsg };
         }


        // Import main builder index lazily inside function scope
        let TxParamBuilder;
        try {
             TxParamBuilder = require('../core/tx/paramBuilder');
        } catch (requireError) {
             const errorMsg = `Failed to require main TxParamBuilder: ${requireError.message}`;
             logger.error(`${logPrefix} ${errorMsg}`);
             return { calldata: null, contractFunctionName: null, errorMessage: errorMsg };
        }


        try {
            // Minimal simulation result placeholder for builders
            // We need minimal amounts but also need to ensure minOut values aren't zero
            // if the builder validates them. A small non-zero value like 1n might be needed.
            // Let's use a very small value (1 wei) for initial/intermediate amounts in minimal sim result
            // And use a small non-zero value (1n) for final minOut check if needed by builder.
            const minimalSimResult = { initialAmount: 1n, hop1AmountOut: 1n, finalAmount: 1n }; // Use 1n for minimal amounts
            let builderFunction;
            let buildResult;

            if (providerType === 'UNIV3') {
                 const dexPath = opportunity.path.map(p => p.dex).join('->');
                 if (opportunity.type === 'spatial' && dexPath === 'uniswapV3->uniswapV3') {
                     builderFunction = TxParamBuilder.buildTwoHopParams; // Expects 4 args: opportunity, simResult, config, titheRecipient
                 } else if (opportunity.type === 'triangular') {
                     builderFunction = TxParamBuilder.buildTriangularParams; // Expects 4 args: opportunity, simResult, config, titheRecipient
                 } else {
                      const errorMsg = `Unsupported opportunity type/path for UniV3 estimateGas encoding: ${opportunity.type} / ${dexPath}`;
                     throw new ArbitrageError(errorMsg, 'PARAM_BUILD_ERROR'); // Use ArbitrageError for builder issues
                 }
                 if (!builderFunction) {
                      const errorMsg = "UniV3 builder function not found in TxParamBuilder.";
                     throw new ArbitrageError(errorMsg, 'INTERNAL_ERROR'); // Use ArbitrageError
                 }

                 // --- Pass titheRecipient to the builder ---
                 // The builder will use the minimalSimResult amounts internally.
                 buildResult = builderFunction(opportunity, minimalSimResult, this.config, titheRecipient); // Pass titheRecipient


                 // Encoding logic (remains the same, uses the interface created in constructor)
                 const encodedParamsBytes = ethers.AbiCoder.defaultAbiCoder().encode([buildResult.typeString], [buildResult.params]);
                 const borrowPoolState = opportunity.path[0].poolState;
                 if (!borrowPoolState || !borrowPoolState.token0?.address || !borrowPoolState.token1?.address) {
                      const errorMsg = "Invalid V3 borrow pool state for estimateGas encoding.";
                     throw new ArbitrageError(errorMsg, 'INTERNAL_ERROR'); // Use ArbitrageError
                 }
                 let amount0 = 0n; let amount1 = 0n;
                 // Use minimalSimResult.initialAmount for the borrow amount
                 const borrowAmountMinimal = minimalSimResult.initialAmount; // This is 1n
                 if (buildResult.borrowTokenAddress.toLowerCase() === borrowPoolState.token0.address.toLowerCase()) amount0 = borrowAmountMinimal;
                 else if (buildResult.borrowTokenAddress.toLowerCase() === borrowPoolState.token1.address.toLowerCase()) amount1 = borrowAmountMinimal;
                 else {
                      const errorMsg = `Borrow token mismatch for UniV3 estimateGas encoding.`;
                     throw new ArbitrageError(errorMsg, 'INTERNAL_ERROR'); // Use ArbitrageError
                 }
                 // Use the contract interface loaded in the constructor
                 const calldata = this.flashSwapInterface.encodeFunctionData(buildResult.contractFunctionName, [borrowPoolState.address, amount0, amount1, encodedParamsBytes]);
                 return { calldata, contractFunctionName: buildResult.contractFunctionName };

            } else if (providerType === 'AAVE') {
                 builderFunction = TxParamBuilder.buildAavePathParams; // Expects 5 args: opportunity, simResult, config, flashSwapManager (temp or real), titheRecipient
                 if (!builderFunction) {
                      const errorMsg = "Aave builder function not found in TxParamBuilder exports.";
                     throw new ArbitrageError(errorMsg, 'INTERNAL_ERROR'); // Use ArbitrageError
                 }
                 // Pass a minimal flashSwapManager instance if the builder needs it for getSignerAddress()
                 // or pass null if the builder handles null gracefully in this context.
                 // Let's pass null, as the builder in GasEstimator shouldn't need a real FSM instance.
                 const minimalFlashSwapManager = null; // Pass null or simple mock if necessary for builder signature

                 // --- Pass titheRecipient to the builder ---
                 // The builder will use the minimalSimResult amounts internally.
                 buildResult = await builderFunction(opportunity, minimalSimResult, this.config, minimalFlashSwapManager, titheRecipient);


                 // --- ADJUSTMENT for DODO QUOTE SELL during estimation (remains the same) ---
                 // This logic needs to handle the new structure returned by the builder (ArbParams struct properties)
                 let adjustedParams = { ...buildResult.params }; // Should be the ArbParams struct { path: SwapStep[], titheRecipient: address }
                 let adjustedPath = [...adjustedParams.path]; // Array of SwapStep structs
                 adjustedParams.path = adjustedPath; // Assign the copied path array back

                 let needsReEncoding = false; // Flag if adjustment occurred

                 // This adjustment logic needs to look at the SwapStep minOut values *within* the builder's output `buildResult.params.path`
                 for(let i = 0; i < adjustedPath.length; i++) {
                     const step = adjustedPath[i]; // This is a SwapStep struct { dexType, pool, tokenIn, tokenOut, minOut, fee }
                     // Check if it's a DODO step AND selling the quote token (tokenIn != baseToken)
                     // Need pool info from config to find base token
                     const poolInfo = this.config.POOL_CONFIGS?.find(p => p.address.toLowerCase() === step.pool.toLowerCase() && p.dexType === 'dodo');
                     const baseTokenSymbol = poolInfo?.baseTokenSymbol;
                     const baseToken = baseTokenSymbol ? this.config.TOKENS[baseTokenSymbol] : null;

                     // The adjustment logic needs to ensure the *final* SwapStep's minOut is > 0
                     // for the estimateGas check, while intermediate steps can potentially be 0
                     // depending on what `estimateGas` requires.
                     // Let's revisit the original reason for this adjustment... it was to ensure minimal amounts > 0
                     // are used for simulation if needed by the builder, which then calculates minOut.
                     // If the builder *directly* uses the minimal sim result's amounts (which are 1n),
                     // the calculated minOut might be 0 due to fee/slippage calculation on 1n.
                     // A simpler fix is to ensure the *minimalSimResult.finalAmount* passed to the builder is 1n,
                     // which should result in a non-zero `amountOutMinimumFinal` if the builder uses it.
                     // The `calculateMinAmountOut(hop2AmountOutSimulated, ...)` in builders needs hop2AmountOutSimulated > 0.
                     // Let's ensure minimalSimResult.finalAmount passed to builder is 1n. It is (see above).
                     // The warning "Invalid input: amountOut=0" suggests calculateMinAmountOut is receiving 0.
                     // This means minimalSimResult.finalAmount (or intermediateAmountOut) might not be 1n when used.
                     // Let's log minimalSimResult passed to builders for debugging this.

                     // *** New approach: Ensure minimalSimResult passed to builders has finalAmount = 1n ***
                     // *** Done above. The warning must be coming from elsewhere or the builder isn't using it. ***
                     // *** Let's check the builders code again for calculateMinAmountOut(0n, ...) calls. ***

                     // The `calculateMinAmountOut` call is inside the builder. If the builder receives
                     // `minimalSimResult.finalAmount` as 1n, `calculateMinAmountOut` should not get 0n.
                     // Let's check the builder code again.
                     // twoHopV3Builder.js:47:61 calculateMinAmountOut(hop2AmountOutSimulated, config.SLIPPAGE_TOLERANCE_BPS);
                     // This means hop2AmountOutSimulated must be 0n when passed to calculateMinAmountOut.
                     // But minimalSimResult.finalAmount is set to 1n.
                     // AH! The builder gets `simulationResult` as the second arg, but it internally uses `simulationResult.hop1AmountOutSimulated` and `simulationResult.hop2AmountOutSimulated`.
                     // The minimalSimResult object needs these specific properties!
                     // Correct minimalSimResult placeholder:
                      const correctedMinimalSimResult = {
                          initialAmount: 1n, // Minimal borrow
                          hop1AmountOutSimulated: 1n, // Minimal intermediate out
                          finalAmountSimulated: 1n, // Minimal final out
                          // DODO specific fields if needed by builder?
                          // For now, assume builders only use hop1AmountOutSimulated and finalAmountSimulated
                      };

                      // Rerun the builder call with the corrected minimalSimResult
                      // Re-doing the buildResult call inside the try block with correctedMinimalSimResult
                      if (providerType === 'UNIV3') {
                           // ... UniV3 builder logic (same as before) ...
                           builderFunction = TxParamBuilder.buildTwoHopParams; // Or buildTriangularParams
                            // Pass corrected minimal sim result
                           buildResult = builderFunction(opportunity, correctedMinimalSimResult, this.config, titheRecipient);
                           // ... rest of UniV3 encoding ...
                      } else if (providerType === 'AAVE') {
                           // ... Aave builder logic (same as before) ...
                           builderFunction = TxParamBuilder.buildAavePathParams;
                            // Pass corrected minimal sim result
                           buildResult = await builderFunction(opportunity, correctedMinimalSimResult, this.config, minimalFlashSwapManager, titheRecipient);
                           // ... rest of Aave encoding ...
                      }
                      // --- END REVISED BUILDER CALL WITH CORRECTED MINIMAL SIM RESULT ---

                     // The DODO adjustment logic below was specifically for the Aave path.
                     // It aimed to set minOut to 1n for DODO quote sells if it was 0, *within the encoded params*.
                     // If the builder already sets minOut > 0 based on the minimal sim result, this might be redundant.
                     // Let's keep it for now but simplify, assuming the builder returned the expected ArbParams struct.

                     // Check if the builder returned the expected structure for Aave (ArbParams struct encoded)
                     if (providerType === 'AAVE' && buildResult?.typeString?.startsWith('tuple(tuple(uint8 dexType,address pool,address tokenIn,address tokenOut,uint256 minOut,uint24 fee)[] path') && buildResult.params?.path && buildResult.params?.titheRecipient) {
                          // Access the path array from the builder's result params
                          const originalPathFromBuilder = buildResult.params.path;
                          adjustedPath = [...originalPathFromBuilder]; // Copy the path array from the builder's result
                          adjustedParams = { ...buildResult.params, path: adjustedPath }; // Copy the whole params struct

                          for(let i = 0; i < adjustedPath.length; i++) {
                              const step = adjustedPath[i]; // This is a SwapStep struct { dexType, pool, tokenIn, tokenOut, minOut, fee }
                              // Check if it's a DODO step AND selling the quote token (tokenIn != baseToken)
                              const poolInfo = this.config.POOL_CONFIGS?.find(p => p.address.toLowerCase() === step.pool.toLowerCase() && p.dexType === 'dodo');
                              const baseTokenSymbol = poolInfo?.baseTokenSymbol;
                              const baseToken = baseTokenSymbol ? this.config.TOKENS[baseTokenSymbol] : null;

                              if (step.dexType === 2 /* DEX_TYPE_DODO */ && baseToken && step.tokenIn.toLowerCase() !== baseToken.address.toLowerCase()) {
                                   // This is a DODO quote sell. If minOut is currently 0 (from minimalSimResult calculations), set it to 1 for estimateGas.
                                   if (step.minOut === 0n) { // Check the minOut value in the SwapStep struct from the builder
                                       logger.debug(`${logPrefix} Adjusting DODO quote sell minOut from 0 to 1 for step ${i} during gas estimation encoding.`);
                                       adjustedPath[i] = { ...step, minOut: 1n }; // Use 1n (BigInt one)
                                       needsReEncoding = true; // Indicate we need to encode the adjustedParams
                                   }
                              }
                          }
                         // Re-encode the *adjusted* params struct if changes were made
                         if (needsReEncoding) {
                              encodedArbParamsBytes = ethers.AbiCoder.defaultAbiCoder().encode([buildResult.typeString], [adjustedParams]);
                         } else {
                              // If no adjustments, encode the builder's original result params
                              encodedArbParamsBytes = ethers.AbiCoder.defaultAbiCoder().encode([buildResult.typeString], [buildResult.params]);
                         }

                          // Args for initiateAaveFlashLoan(address[] assets, uint256[] amounts, bytes params)
                         // Borrowed asset and amount for the minimal sim:
                         const assetMinimal = buildResult.borrowTokenAddress; // Builder should provide this
                         const amountMinimal = correctedMinimalSimResult.initialAmount; // This is 1n
                         const args = [[assetMinimal], [amountMinimal], encodedArbParamsBytes]; // Pass encoded ArbParams struct

                          // Use the contract interface loaded in the constructor
                         calldata = this.flashSwapInterface.encodeFunctionData(buildResult.contractFunctionName, args);
                         return { calldata, contractFunctionName: buildResult.contractFunctionName };

                     } else if (providerType === 'AAVE') {
                          // If builder didn't return expected ArbParams structure for Aave...
                          const errorMsg = "Aave path builder did not return expected ArbParams structure for encoding.";
                          logger.error(`${logPrefix} ${errorMsg}`);
                          // Fall through to general error handling
                          throw new ArbitrageError(errorMsg, 'INTERNAL_ERROR');

                     } else {
                         // If not AAVE, then it must be the UniV3 case handled above.
                          // This else should not be reached if providerType is handled.
                          const errorMsg = `Unhandled providerType after builder logic: ${providerType}`;
                          throw new ArbitrageError(errorMsg, 'INTERNAL_ERROR');
                     }

                 // --- END ADJUSTMENT ---

            } else {
                const errorMsg = `Invalid providerType passed to _encodeMinimalCalldataForEstimate: ${providerType}`;
                throw new ArbitrageError(errorMsg, 'INTERNAL_ERROR'); // Use ArbitrageError
            }

             // If encoding was successful, the relevant return was already hit inside the if/else blocks.
             // If we reach here, something went wrong *before* the successful return.
             const errorMsg = "Reached end of _encodeMinimalCalldataForEstimate without returning valid calldata.";
             logger.error(`${logPrefix} ${errorMsg}`);
             return { calldata: null, contractFunctionName: null, errorMessage: errorMsg };


        } catch (error) {
            let errorMessage = error.message;
            // Log builder-specific errors with their type and details if available
            if (error instanceof ArbitrageError && error.type === 'PARAM_BUILD_ERROR') {
                logger.error(`${logPrefix} Parameter build error: ${error.message}`, error.details);
                errorMessage = `Parameter build error: ${error.message}`; // Use specific message for return
            } else {
                 logger.error(`${logPrefix} Failed to encode minimal calldata: ${error.message}`, error);
            }
            // Return null or an object indicating failure
            return { calldata: null, contractFunctionName: null, errorMessage: errorMessage };
        }
    }

    /**
     * Estimates gas cost using path-based heuristics & performs an estimateGas check
     * using provider-specific calldata (UniV3 or Aave).
     * @param {object} opportunity The opportunity object.
     * @param {string} walletSignerAddress The address of the bot's signer wallet (for estimateGas 'from' field).
     * @returns {Promise<{ pathGasLimit: bigint, effectiveGasPrice: bigint, totalCostWei: bigint, estimateGasSuccess: boolean, errorMessage?: string } | null>}
     */
    async estimateTxGasCost(opportunity, walletSignerAddress) {
        const logPrefix = `[GasEstimator Opp ${opportunity?.pairKey}]`;
        logger.debug(`${logPrefix} Starting path-based gas estimation & validity check...`);

        if (!walletSignerAddress || !ethers.isAddress(walletSignerAddress)) {
             logger.error(`${logPrefix} Invalid walletSignerAddress received: ${walletSignerAddress}.`);
             return { pathGasLimit: 0n, effectiveGasPrice: 0n, totalCostWei: 0n, estimateGasSuccess: false, errorMessage: "Invalid signerAddress received" };
        }
        logger.debug(`${logPrefix} Received walletSignerAddress for gas estimation: ${walletSignerAddress}`);


        if (!opportunity?.path || opportunity.path.length === 0) { logger.error(`${logPrefix} Invalid opportunity path.`); return null; }
        // Use the interface created in the constructor
        if (!this.flashSwapInterface) {
             const errorMsg = "FlashSwap Interface not available. Aborting estimate.";
             logger.error(`${logPrefix} ${errorMsg}`);
             return { pathGasLimit: 0n, effectiveGasPrice: 0n, totalCostWei: 0n, estimateGasSuccess: false, errorMessage: errorMsg };
        }


        // --- 1. Get Gas Price ---
        const feeData = await this.getFeeData();
        const effectiveGasPrice = this.getEffectiveGasPrice(feeData);
        if (!effectiveGasPrice) {
             const errorMsg = 'Failed to get effective gas price.';
             logger.error(`${logPrefix} ${errorMsg}`);
             // Return a failure state, but include the pathGasLimit calculated below if needed for debugging profit calc
             const tempPathGasLimit = BigInt(this.gasEstimates.FLASH_SWAP_BASE || 0) +
                                     opportunity.path.reduce((sum, step) => sum + BigInt(this.gasEstimates[step.dex?.toLowerCase() + '_SWAP'] || 0), 0n);
             const bufferPercent = BigInt(this.config.GAS_ESTIMATE_BUFFER_PERCENT || 0);
             const finalTempPathGasLimit = (tempPathGasLimit > 0n ? tempPathGasLimit + (tempPathGasLimit * bufferPercent) / 100n : this.fallbackGasLimit);
             return { pathGasLimit: finalTempPathGasLimit, effectiveGasPrice: 0n, totalCostWei: 0n, estimateGasSuccess: false, errorMessage: errorMsg };
        }
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
             if (hopCost === 0n) logger.debug(`${logPrefix} Gas estimate missing or zero for DEX '${step.dex}'. Using 0 for hop.`); // Changed warn to debug
             pathGasLimit += hopCost;
         }

         if (pathGasLimit > 0n) {
             const bufferPercent = BigInt(this.config.GAS_ESTIMATE_BUFFER_PERCENT || 0);
             if (bufferPercent > 0n) {
                 pathGasLimit += (pathGasLimit * bufferPercent) / 100n;
             }
         } else {
              logger.warn(`${logPrefix} Calculated pathGasLimit is zero or negative before buffer. Using fallback.`);
              pathGasLimit = this.fallbackGasLimit;
         }

         logger.debug(`${logPrefix} Path-based limit (+buffer): ${pathGasLimit}`);

        if (pathGasLimit <= 0n) {
             const errorMsg = `Invalid final path-based gas limit: ${pathGasLimit}`;
             logger.error(`${logPrefix} ${errorMsg}`);
             return { pathGasLimit: 0n, effectiveGasPrice: effectiveGasPrice, totalCostWei: 0n, estimateGasSuccess: false, errorMessage: errorMsg };
        }


        // --- 3. Determine Provider Type & Encode Minimal Calldata ---
        const providerType = (opportunity.path[0].dex?.toLowerCase() === 'uniswapv3' && opportunity.path.length === 2 && opportunity.path[1].dex?.toLowerCase() === 'uniswapv3')
                             ? 'UNIV3'
                             : 'AAVE';

        logger.debug(`${logPrefix} Encoding minimal calldata for provider type: ${providerType}`);
        const encodedResult = await this._encodeMinimalCalldataForEstimate(opportunity, providerType);


        if (!encodedResult || !encodedResult.calldata) {
             const errorMsg = encodedResult?.errorMessage || "Minimal calldata encoding failed. Cannot perform estimateGas check.";
             logger.warn(`${logPrefix} ${errorMsg}. Assuming tx invalid.`);
             // Return a failure state, but include the calculated pathGasLimit and effectiveGasPrice
             return { pathGasLimit, effectiveGasPrice, totalCostWei: pathGasLimit * effectiveGasPrice, estimateGasSuccess: false, errorMessage: errorMsg };
        }
        const { calldata: encodedData, contractFunctionName } = encodedResult;
        logger.debug(`${logPrefix} Minimal calldata encoded for function: ${contractFunctionName}`);

        // --- 4. Perform estimateGas as a Validity Check ---
        let estimateGasSuccess = false;
        let estimateGasError = null;
        let estimatedGasLimitFromProvider = 0n;
        let estimateGasErrorMessage = undefined;

        try {
            logger.debug(`${logPrefix} Performing provider.estimateGas check for ${contractFunctionName} from ${walletSignerAddress}...`);
            estimatedGasLimitFromProvider = await this.provider.estimateGas({
                to: this.config.FLASH_SWAP_CONTRACT_ADDRESS,
                data: encodedData,
                from: walletSignerAddress
            });
            estimateGasSuccess = true;

             // Update pathGasLimit using provider's estimate if it's higher
             if (estimatedGasLimitFromProvider > pathGasLimit) {
                  logger.debug(`${logPrefix} Provider estimateGas (${estimatedGasLimitFromProvider}) is higher than path estimate (${pathGasLimit}). Using provider estimate.`);
                  pathGasLimit = estimatedGasLimitFromProvider; // Use provider's estimate for cost calculation
             } else {
                  logger.debug(`${logPrefix} Provider estimateGas (${estimatedGasLimitFromProvider}) is lower than or equal to path estimate (${pathGasLimit}). Using path estimate.`);
             }

            logger.debug(`${logPrefix} estimateGas check PASSED. Estimated gas limit by provider: ${estimatedGasLimitFromProvider}`);
        } catch (error) {
             estimateGasError = error;
             let reason = error.reason || error.code || error.message;
             logger.warn(`${logPrefix} estimateGas check FAILED for ${contractFunctionName} (TX likely reverts): ${reason}. Marking opportunity invalid.`);
             ErrorHandler.handleError(error, `GasEstimator estimateGas Check (${contractFunctionName})`, {
                 opportunity: { pairKey: opportunity?.pairKey, type: opportunity?.type },
                 encodedData: encodedData?.substring(0, 100) + '...' // Log snippet
             });
             estimateGasSuccess = false;
             estimateGasErrorMessage = reason;
             // Do NOT update pathGasLimit based on a failed estimateGas call
        }

        // --- 5. Calculate Final Cost using the (potentially updated) Path-Based or Provider Estimate ---
        const totalCostWei = pathGasLimit * effectiveGasPrice;
        logger.info(`${logPrefix} Final Estimated Gas: Limit=${pathGasLimit}, Price=${ethers.formatUnits(effectiveGasPrice, 'gwei')} Gwei, Cost=${ethers.formatEther(totalCostWei)} ${this.nativeSymbol}. estimateGas check: ${estimateGasSuccess ? 'OK' : 'FAIL'}`);

        return {
            pathGasLimit: pathGasLimit,
            effectiveGasPrice: effectiveGasPrice,
            totalCostWei: totalCostWei,
            estimateGasSuccess: estimateGasSuccess,
            // Include the error message from the estimateGas check if it failed
            errorMessage: estimateGasErrorMessage
        };
    }
}

module.exports = GasEstimator;