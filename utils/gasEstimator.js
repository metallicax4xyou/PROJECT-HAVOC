// utils/gasEstimator.js
// Provides utility functions for estimating transaction gas costs.
// --- VERSION v1.16 --- Corrected arguments passed to encodeFunctionData for UniV3 flash loans.

const { ethers } = require('ethers');
const logger = require('./logger');
const { ArbitrageError } = require('./errorHandler');
const ErrorHandler = require('./errorHandler');
// const TxParamBuilder = require('../core/tx/paramBuilder'); // Keep commented if using lazy require


class GasEstimator {
    /**
     * @param {object} config - The application configuration object.
     * @param {ethers.Provider} provider - The ethers provider instance.
     * @param {Array<object>} flashSwapABI - The ABI array for the FlashSwap contract.
     */
    constructor(config, provider, flashSwapABI) {
        logger.debug('[GasEstimator v1.16] Initializing...'); // Version bump

        if (!config || !provider) throw new ArbitrageError('GasEstimatorInit', 'Config/Provider required.');
        if (!config.GAS_COST_ESTIMATES?.FLASH_SWAP_BASE) logger.warn('[GasEstInit] GAS_COST_ESTIMATES incomplete.');

        // Check for FlashSwap ABI presence and create Interface
        if (!flashSwapABI || !Array.isArray(flashSwapABI)) {
            logger.error('[GasEstInit] CRITICAL: FlashSwap ABI not provided or invalid.');
            this.flashSwapInterface = null;
        } else {
             try {
                 // --- ADDED DETAILED ABI LOGGING ---
                 logger.debug("[GasEstInit] Received FlashSwap ABI (first 5 entries):", JSON.stringify(flashSwapABI.slice(0, 5), null, 2)); // Log snippet
                 logger.debug("[GasEstInit] Received FlashSwap ABI (last 5 entries):", JSON.stringify(flashSwapABI.slice(-5), null, 2)); // Log snippet
                 logger.debug(`[GasEstInit] Received FlashSwap ABI total length: ${flashSwapABI.length}`);
                 // --- END DETAILED ABI LOGGING ---


                 this.flashSwapInterface = new ethers.Interface(flashSwapABI); // Use the provided ABI

                 // --- ADDED DETAILED FUNCTION CHECK LOGGING ---
                 // CORRECTED: Check for initiateUniswapV3FlashLoan instead of initiateFlashSwap
                 const hasInitiateUniswapV3FlashLoan = this.flashSwapInterface.hasFunction('initiateUniswapV3FlashLoan'); // Corrected check
                 const hasInitiateAaveFlashLoan = this.flashSwapInterface.hasFunction('initiateAaveFlashLoan');
                 logger.debug(`[GasEstInit] Check result: hasFunction('initiateUniswapV3FlashLoan'): ${hasInitiateUniswapV3FlashLoan}`); // Updated log
                 logger.debug(`[GasEstInit] Check result: hasFunction('initiateAaveFlashLoan'): ${hasInitiateAaveFlashLoan}`);
                 // --- END DETAILED FUNCTION CHECK LOGGING ---


                 // Check if necessary initiation functions exist in the interface
                 // CORRECTED: Check for initiateUniswapV3FlashLoan OR initiateAaveFlashLoan
                 if (!hasInitiateUniswapV3FlashLoan && !hasInitiateAaveFlashLoan) {
                     // Throw critical error only if *neither* required function is found
                     logger.error('[GasEstInit] CRITICAL: Provided FlashSwap ABI is missing *both* initiateUniswapV3FlashLoan and initiateAaveFlashLoan function definitions.');
                     this.flashSwapInterface = null; // Mark as unavailable if key functions are missing
                 } else if (!hasInitiateUniswapV3FlashLoan) {
                      logger.warn('[GasEstInit] WARNING: FlashSwap ABI is missing initiateUniswapV3FlashLoan definition. UniV3 estimateGas checks will fail.');
                 } else if (!hasInitiateAaveFlashLoan) {
                      logger.warn('[GasEstInit] WARNING: FlashSwap ABI is missing initiateAaveFlashLoan definition. Aave estimateGas checks will fail.');
                 } else {
                      logger.debug('[GasEstInit] FlashSwap Interface created successfully from provided ABI.');
                 }
             } catch (abiError) {
                 logger.error('[GasEstInit] CRITICAL: Failed to create Interface from provided FlashSwap ABI.', abiError);
                 this.flashSwapInterface = null;
             }
        }


        // Update the check here as well for clarity, although the constructor check above is the critical one.
        // If flashSwapInterface is null at this point, it means a critical function was missing.
        if (!this.flashSwapInterface) {
             logger.error('[GasEstInit] FlashSwap Interface could not be initialized. EstimateGas checks will fail.');
        }
        // Add check for TITHE_WALLET_ADDRESS in config (still needed for builders)
        if (!config.TITHE_WALLET_ADDRESS || !ethers.isAddress(config.TITHE_WALLET_ADDRESS)) {
             logger.warn('[GasEstInit] WARNING: TITHE_WALLET_ADDRESS is missing or invalid in config. Parameter builders may fail.');
        }


        this.config = config;
        this.provider = provider;

        this.gasEstimates = config.GAS_COST_ESTIMATES || {};
        this.maxGasPriceGwei = ethers.parseUnits(String(config.MAX_GAS_GWEI || 1), 'gwei');
        this.fallbackGasLimit = BigInt(config.FALLBACK_GAS_LIMIT || 3000000);

        logger.info(`[GasEstimator v1.16] Initialized. Path-based est + Provider-specific estimateGas check. Max Gas Price: ${ethers.formatUnits(this.maxGasPriceGwei, 'gwei')} Gwei`); // Version bump
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
     * Uses minimal amounts (1 wei borrow, 1 wei min out for intermediate/final for estimateGas purposes).
     * Passes the titheRecipient address from config to the parameter builders.
     * @param {object} opportunity The opportunity object.
     * @param {string} providerType 'UNIV3' or 'AAVE'.
     * @returns {{ calldata: string, contractFunctionName: string, errorMessage?: string } | null} Encoded data and function name, or null on error.
     * @private Internal helper method
     */
    async _encodeMinimalCalldataForEstimate(opportunity, providerType) {
        const logPrefix = `[GasEstimator Opp ${opportunity?.pairKey} ENC v1.16]`; // Version bump

        // Use the interface created in the constructor
        // Ensure the necessary initiation function exists for the chosen providerType before proceeding
        let requiredFunctionName = '';
        let args = []; // Array to hold arguments for encodeFunctionData

        // Retrieve titheRecipient from config - needed for both Aave and UniV3 initiation functions based on ABI
        const titheRecipient = this.config.TITHE_WALLET_ADDRESS;
         // Validation of titheRecipient address format
         if (!titheRecipient || typeof titheRecipient !== 'string' || !ethers.isAddress(titheRecipient)) {
             const errorMsg = `Invalid TITHE_WALLET_ADDRESS in config: ${titheRecipient}. Cannot encode minimal calldata.`;
             logger.error(`${logPrefix} ${errorMsg}`);
             return { calldata: null, contractFunctionName: null, errorMessage: errorMsg };
         }


        // Import main builder index lazily inside function scope
        let TxParamBuilder;
        try {
             // Path assumes TxParamBuilder is in ../core/tx/paramBuilder from utils/
             TxParamBuilder = require('../core/tx/paramBuilder');
        } catch (requireError) {
             const errorMsg = `Failed to require main TxParamBuilder: ${requireError.message}`;
             logger.error(`${logPrefix} ${errorMsg}`);
             return { calldata: null, contractFunctionName: null, errorMessage: requireError.message }; // Return original error message
        }


        try {
            // Corrected minimal simulation result placeholder for builders.
            // Use 1n for initial, hop1, and final amounts to ensure minimal amounts > 0 are passed.
            // This is specifically for the estimateGas check encoding, not for profit simulation.
            const correctedMinimalSimResult = {
                initialAmount: 1n, // Minimal borrow amount (e.g., 1 wei)
                hop1AmountOutSimulated: 1n, // Minimal intermediate out amount (e.g., 1 wei)
                finalAmountSimulated: 1n, // Minimal final out amount (e.g., 1 wei)
            };
            let builderFunction;
            let buildResult;

            // --- Separate encoding logic based on providerType ---
            if (providerType === 'UNIV3') {
                 requiredFunctionName = 'initiateUniswapV3FlashLoan';
                 // Find the correct builder for the opportunity type/path
                 const dexPath = opportunity.path.map(p => p.dex).join('->');
                 if (opportunity.type === 'spatial' && dexPath === 'uniswapV3->uniswapV3') {
                     builderFunction = TxParamBuilder.buildTwoHopParams; // Expects 4 args: opportunity, simResult, config, titheRecipient
                 } else if (opportunity.type === 'triangular') {
                     builderFunction = TxParamBuilder.buildTriangularParams; // Expects 4 args: opportunity, simResult, config, titheRecipient
                 } else {
                      const errorMsg = `Unsupported opportunity type/path for UniV3 estimateGas encoding: ${opportunity.type} / ${dexPath}`;
                     throw new ArbitrageError(errorMsg, 'PARAM_BUILD_ERROR');
                 }
                 if (!builderFunction) {
                      const errorMsg = "UniV3 builder function not found or not exported in TxParamBuilder.";
                     throw new ArbitrageError(errorMsg, 'INTERNAL_ERROR');
                 }

                 // Pass titheRecipient and corrected minimal sim result to the builder
                 buildResult = builderFunction(opportunity, correctedMinimalSimResult, this.config, titheRecipient);


                 // Encoding logic for initiateUniswapV3FlashLoan(uint8 _callbackType, address _poolAddress, uint256 _amount0, uint256 _amount1, bytes _params, address _titheRecipient)
                 // Need to determine the correct callback type enum value. Assuming 0 for spatial two-hop for now.
                 const callbackTypeEnum = 0; // Needs confirmation from FlashSwap.sol enum definition (e.g., SWAP_V3_TWO_HOP = 0)

                 const borrowPoolAddress = opportunity.path[0].address; // V3 Flashloan is initiated from the pool contract itself
                 if (!borrowPoolAddress) {
                     const errorMsg = "Invalid V3 borrow pool address for estimateGas encoding.";
                     throw new ArbitrageError(errorMsg, 'INTERNAL_ERROR');
                 }
                 const borrowTokenAddress = opportunity.path[0].tokenInAddress; // Token being borrowed (first step input)
                 const token0Address = opportunity.path[0].poolState.token0.address; // Token0 of the pool
                 const token1Address = opportunity.path[0].poolState.token1.address; // Token1 of the pool

                 let amount0 = 0n; let amount1 = 0n;
                 const borrowAmountMinimal = correctedMinimalSimResult.initialAmount; // This is 1n

                 // Determine if the borrow token is token0 or token1 of the V3 pool
                 if (borrowTokenAddress.toLowerCase() === token0Address.toLowerCase()) amount0 = borrowAmountMinimal;
                 else if (borrowTokenAddress.toLowerCase() === token1Address.toLowerCase()) amount1 = borrowAmountMinimal;
                 else {
                     const errorMsg = `Borrow token ${opportunity.path[0].tokenInSymbol} mismatch with UniV3 pool tokens for estimateGas encoding.`;
                     throw new ArbitrageError(errorMsg, 'INTERNAL_ERROR');
                 }

                 const encodedParamsBytes = ethers.AbiCoder.defaultAbiCoder().encode([buildResult.typeString], [buildResult.params]);

                 // Arguments for initiateUniswapV3FlashLoan
                 args = [callbackTypeEnum, borrowPoolAddress, amount0, amount1, encodedParamsBytes, titheRecipient];
                 logger.debug(`${logPrefix} Arguments for UniV3 encoding:`, args);


            } else if (providerType === 'AAVE') {
                 requiredFunctionName = 'initiateAaveFlashLoan';
                 builderFunction = TxParamBuilder.buildAavePathParams; // Expects 5 args: opportunity, simResult, config, flashSwapManager (temp or real), titheRecipient
                 if (!builderFunction) {
                      const errorMsg = "Aave builder function not found or not exported in TxParamBuilder.";
                     throw new ArbitrageError(errorMsg, 'INTERNAL_ERROR');
                 }

                 // Pass null for FlashSwapManager as AavePathBuilder shouldn't need a real one for encoding for estimateGas
                 const minimalFlashSwapManager = null; // Represents a minimal placeholder

                 // Pass titheRecipient and corrected minimal sim result to the builder
                 buildResult = await builderFunction(opportunity, correctedMinimalSimResult, this.config, minimalFlashSwapManager, titheRecipient);

                 // Encoding Logic for initiateAaveFlashLoan(address[] assets, uint256[] amounts, bytes params)
                 // The builder (AavePathBuilder) should return { params: { path: SwapStep[], titheRecipient: address }, typeString: "tuple(...)" }
                 // Access the path array from the builder's result params for DODO adjustment if needed.
                 let adjustedParams = { ...buildResult.params }; // Should be the ArbParams struct { path: SwapStep[], titheRecipient: address }
                 let adjustedPath = [...adjustedParams.path]; // Array of SwapStep structs
                 adjustedParams.path = adjustedPath; // Assign the copied path array back

                 let needsReEncoding = false; // Flag if adjustment occurred

                 // The DODO adjustment logic: Ensure minimal amounts > 0 for estimateGas if the builder set them to 0.
                 // This might be redundant now if the builder correctly uses correctedMinimalSimResult.
                 // Let's simplify this adjustment. If any SwapStep's minOut is 0, set it to 1n for estimateGas check.
                 for(let i = 0; i < adjustedPath.length; i++) {
                      const step = adjustedPath[i]; // This is a SwapStep struct { dexType, pool, tokenIn, tokenOut, minOut, fee }
                      if (step.minOut === 0n) {
                           //logger.debug(`${logPrefix} Adjusting minOut from 0 to 1n for step ${i} during gas estimation encoding.`);
                           adjustedPath[i] = { ...step, minOut: 1n };
                           needsReEncoding = true;
                      }
                 }

                 // Re-encode the *adjusted* params struct if changes were made
                 const encodedArbParamsBytes = ethers.AbiCoder.defaultAbiCoder().encode([buildResult.typeString], [needsReEncoding ? adjustedParams : buildResult.params]);

                 // Args for initiateAaveFlashLoan(address[] assets, uint256[] amounts, bytes params)
                 // Borrowed asset and amount for the minimal sim:
                 // Aave builder should return borrow asset/amount info in buildResult
                 const assetMinimal = buildResult.borrowTokenAddress; // Builder should provide this (first token in path[0] or specific borrow token)
                 const amountMinimal = correctedMinimalSimResult.initialAmount; // This is 1n

                 // Arguments for initiateAaveFlashLoan
                 args = [[assetMinimal], [amountMinimal], encodedArbParamsBytes]; // Pass encoded ArbParams struct
                 logger.debug(`${logPrefix} Arguments for Aave encoding:`, args);


            } else {
                const errorMsg = `Invalid providerType passed to _encodeMinimalCalldataForEstimate: ${providerType}`;
                logger.error(`${logPrefix} ${errorMsg}`);
                return { calldata: null, contractFunctionName: null, errorMessage: errorMsg };
            }

            // --- End Separate encoding logic ---

            // Check if the required function exists in the interface AFTER determining the type
             if (!this.flashSwapInterface.hasFunction(requiredFunctionName)) {
                 const errorMsg = `FlashSwap Interface is missing function "${requiredFunctionName}". Cannot encode.`;
                 logger.error(`${logPrefix} ${errorMsg}`);
                 return { calldata: null, contractFunctionName: null, errorMessage: errorMsg };
            }


            const calldata = this.flashSwapInterface.encodeFunctionData(requiredFunctionName, args); // Use requiredFunctionName and constructed args
            return { calldata, contractFunctionName: requiredFunctionName }; // Return the actual function name used


        } catch (error) {
            let errorMessage = error.message;
            if (error instanceof ArbitrageError && error.type === 'PARAM_BUILD_ERROR') {
                logger.error(`${logPrefix} Parameter build error: ${error.message}`, error.details);
                errorMessage = `Parameter build error: ${error.message}`;
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
    async estimateTxGasCost(opportunity, walletSignerAddress) { // Renamed from signerAddress for clarity
        const logPrefix = `[GasEstimator Opp ${opportunity?.pairKey}]`;
        logger.debug(`${logPrefix} Starting path-based gas estimation & validity check...`);

        if (!walletSignerAddress || !ethers.isAddress(walletSignerAddress)) {
             const errorMsg = `Invalid walletSignerAddress received: ${walletSignerAddress}.`;
             logger.error(`${logPrefix} ${errorMsg}`);
             return { pathGasLimit: 0n, effectiveGasPrice: 0n, totalCostWei: 0n, estimateGasSuccess: false, errorMessage: errorMsg };
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
             // Use the specific gas estimate key for each DEX type
             if (dexKey === 'uniswapv3') hopCost = BigInt(this.gasEstimates.UNISWAP_V3_SWAP || 0);
             else if (dexKey === 'sushiswap') hopCost = BigInt(this.gasEstimates.SUSHISWAP_V2_SWAP || 0);
             else if (dexKey === 'dodo') hopCost = BigInt(this.gasEstimates.DODO_SWAP || 0);
             else { logger.warn(`${logPrefix} Unknown DEX '${step.dex}' in path gas cost calc.`); }
             if (hopCost === 0n) logger.debug(`${logPrefix} Gas estimate missing or zero for DEX '${step.dex}'. Using 0 for hop.`);
             pathGasLimit += hopCost;
         }

         // Apply buffer only if pathGasLimit is meaningful
         if (pathGasLimit > 0n) {
             const bufferPercent = BigInt(this.config.GAS_ESTIMATE_BUFFER_PERCENT || 0);
             if (bufferPercent > 0n) {
                 pathGasLimit += (pathGasLimit * bufferPercent) / 100n;
             }
         }
         else { // This else should follow directly after the closing bracket of the if block above
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
        // Determine the flash loan provider type based on the first step's DEX
        const firstHopDex = opportunity.path[0].dex?.toLowerCase();
        let providerType;
        let borrowTokenSymbol = opportunity.path[0].tokenInSymbol; // Assume borrow is first token in first hop

        if (firstHopDex === 'uniswapv3' && opportunity.path.length >= 1) { // UniV3 flash loans are initiated from the pool
             // This logic is more complex for UniV3 as it's not a single function call on the main contract
             // It relies on the callback mechanism. The GasEstimator should likely simulate the *entire transaction* that calls the pool's flash method.
             // For now, let's stick to the initiateUniswapV3FlashLoan on FlashSwap if that's the design.
             // If the path starts with V3, assume the flash loan provider is UniV3
             providerType = 'UNIV3';
              // For V3, the borrowed token is explicitly passed to initiateUniswapV3FlashLoan, not just the first step's tokenIn
              // The opportunity object should perhaps explicitly state the borrow token.
              // Based on _createOpportunity, tokenIn for the opportunity is the borrowed token
              borrowTokenSymbol = opportunity.tokenIn.symbol; // Get borrowed token symbol from opportunity
              logger.debug(`${logPrefix} Determined UniV3 provider. Borrow token: ${borrowTokenSymbol}`);


        } else if (firstHopDex === 'sushiswap' || firstHopDex === 'dodo' || opportunity.path.length >= 1) {
             // If the first hop is V2/Sushi/Dodo or a multi-hop, assume Aave flash loan
             providerType = 'AAVE';
             // For Aave, the borrowed asset is explicitly passed to initiateAaveFlashLoan
             // The opportunity object should perhaps explicitly state the borrow token.
              // Based on _createOpportunity, tokenIn for the opportunity is the borrowed token
              borrowTokenSymbol = opportunity.tokenIn.symbol; // Get borrowed token symbol from opportunity
             logger.debug(`${logPrefix} Determined Aave provider. Borrow token: ${borrowTokenSymbol}`);

        } else {
             const errorMsg = `Could not determine flash loan provider type for path starting with ${firstHopDex}.`;
             logger.error(`${logPrefix} ${errorMsg}`);
             return { pathGasLimit, effectiveGasPrice, totalCostWei: pathGasLimit * effectiveGasPrice, estimateGasSuccess: false, errorMessage: errorMsg };
        }


        logger.debug(`${logPrefix} Encoding minimal calldata for provider type: ${providerType}`);
        // Pass the determined providerType to the encoding function
        const encodedResult = await this._encodeMinimalCalldataForEstimate(opportunity, providerType);


        if (!encodedResult || !encodedResult.calldata) {
             const errorMsg = encodedResult?.errorMessage || "Minimal calldata encoding failed. Cannot perform estimateGas check.";
             logger.warn(`${logPrefix} ${errorMsg}. Assuming tx invalid.`);
             return { pathGasLimit, effectiveGasPrice, totalCostWei: pathGasLimit * effectiveGasPrice, estimateGasSuccess: false, errorMessage: errorMsg };
        }
        const { calldata: encodedData, contractFunctionName } = encodedResult;
        logger.debug(`${logPrefix} Minimal calldata encoded for function: "${contractFunctionName}"`);

        // --- 4. Perform estimateGas as a Validity Check ---
        let estimateGasSuccess = false;
        let estimateGasError = null;
        let estimatedGasLimitFromProvider = 0n;
        let estimateGasErrorMessage = undefined;

        // Ensure FlashSwap contract address is in config
        if (!this.config.FLASH_SWAP_CONTRACT_ADDRESS || !ethers.isAddress(this.config.FLASH_SWAP_CONTRACT_ADDRESS)) {
             const errorMsg = `FLASH_SWAP_CONTRACT_ADDRESS is missing or invalid in config: ${this.config.FLASH_SWAP_CONTRACT_ADDRESS}. Cannot perform estimateGas check.`;
             logger.error(`${logPrefix} ${errorMsg}`);
             return { pathGasLimit, effectiveGasPrice, totalCostWei: pathGasLimit * effectiveGasPrice, estimateGasSuccess: false, errorMessage: errorMsg };
        }


        try {
            logger.debug(`${logPrefix} Performing provider.estimateGas check for ${contractFunctionName} from ${walletSignerAddress}...`);
            estimatedGasLimitFromProvider = await this.provider.estimateGas({
                to: this.config.FLASH_SWAP_CONTRACT_ADDRESS,
                data: encodedData,
                from: walletSignerAddress
            });
            estimateGasSuccess = true;

             // Decide which gas limit to use: Provider estimate or heuristic + buffer
             // Provider estimate is more accurate for the *minimal* tx. If it succeeds, use it,
             // but add the buffer back as the minimal tx is smaller than the real one.
             // Or, use the Provider estimate as a minimum threshold for the heuristic + buffer.
             // Let's refine: If estimateGas succeeds, the transaction *is likely* valid on chain (reverts aside).
             // The returned value is the *actual gas used* by the minimal tx *on the fork*.
             // We should probably use `estimatedGasLimitFromProvider` as the base for our final gas limit,
             // adding the buffer to it. The heuristic could serve as a very rough fallback or sanity check.

             const bufferPercent = BigInt(this.config.GAS_ESTIMATE_BUFFER_PERCENT || 0);
             const finalGasLimit = estimatedGasLimitFromProvider + (estimatedGasLimitFromProvider * bufferPercent) / 100n;

             // Use the provider estimate as the final gas limit after adding buffer
             pathGasLimit = finalGasLimit;

            logger.debug(`${logPrefix} estimateGas check PASSED. Provider Estimated Gas Used: ${estimatedGasLimitFromProvider}. Final gas limit (with buffer): ${pathGasLimit}`);
        } catch (error) {
             estimateGasError = error;
             let reason = error.reason || error.code || error.message;
             logger.warn(`${logPrefix} estimateGas check FAILED for ${contractFunctionName} (TX likely reverts): ${reason}. Marking opportunity invalid.`);
             ErrorHandler.handleError(error, `GasEstimator estimateGas Check (${contractFunctionName})`, {
                 opportunity: { pairKey: opportunity?.pairKey, type: opportunity?.type },
                 contractFunction: contractFunctionName,
                 encodedData: encodedData?.substring(0, 200) + '...' // Log snippet
             });
             estimateGasSuccess = false;
             estimateGasErrorMessage = reason;

              // If estimateGas fails, the transaction WILL revert. Set totalCostWei to 0
              // as there's no profit, but maybe return the pathGasLimit for debug context.
             return { pathGasLimit, effectiveGasPrice: 0n, totalCostWei: 0n, estimateGasSuccess: false, errorMessage: estimateGasErrorMessage };
        }

        // --- 5. Calculate Final Cost ---
        // Only calculate cost if estimateGas check passed
        const totalCostWei = estimateGasSuccess ? pathGasLimit * effectiveGasPrice : 0n;

        logger.info(`${logPrefix} Final Estimated Gas: Limit=${pathGasLimit}, Price=${ethers.formatUnits(effectiveGasPrice, 'gwei')} Gwei, Cost=${ethers.formatEther(totalCostWei)} ${this.config.NATIVE_CURRENCY_SYMBOL}. estimateGas check: ${estimateGasSuccess ? 'OK' : 'FAIL'}`); // Use config native symbol


        return {
            pathGasLimit: pathGasLimit,
            effectiveGasPrice: effectiveGasPrice,
            totalCostWei: totalCostWei,
            estimateGasSuccess: estimateGasSuccess,
            errorMessage: estimateGasSuccess ? undefined : (estimateGasError?.reason || estimateGasError?.message || "EstimateGas check failed.")
        };
    }
     // Add a helper method to get the native currency symbol
     get nativeSymbol() {
          // Use WETH as fallback if NATIVE_CURRENCY_SYMBOL is not explicitly defined in config
          return this.config.NATIVE_CURRENCY_SYMBOL || 'WETH';
     }
}

module.exports = GasEstimator;
