// core/flashSwapManager.js
// --- VERSION 1.7 --- Added getFlashSwapABI method.

const { ethers } = require('ethers');
const logger = require('../utils/logger');
const NonceManager = require('../utils/nonceManager'); // Import NonceManager
const { AbiCoder } = require('ethers'); // Import AbiCoder
const path = require('path'); // Import Node.js path module

// --- DEBUGGING PATHS ---
// Log the directory of the current script (__dirname) and the process's current working directory (process.cwd())
// This helps diagnose path resolution issues.
const currentDirDebug = __dirname;
const processCwdDebug = process.cwd();
logger.debug(`[FlashSwapManager Debug Path] __dirname: ${currentDirDebug}`);
logger.debug(`[FlashSwapManager Debug Path] process.cwd(): ${processCwdDebug}`);
// --- END DEBUGGING PATHS ---


// --- USING ABSOLUTE PATH FOR ABI ---
const currentDir = __dirname;
const flashSwapArtifactPath = path.resolve(currentDir, '..', 'artifacts', 'contracts', 'FlashSwap.sol', 'FlashSwap.json');

logger.debug(`[FlashSwapManager] Attempting to load ABI from resolved path: ${flashSwapArtifactPath}`);

let FlashSwapArtifact;
try {
    FlashSwapArtifact = require(flashSwapArtifactPath);
    logger.debug('[FlashSwapManager] Successfully loaded ABI.');
} catch (e) {
    logger.error(`[FlashSwapManager] CRITICAL ERROR: Failed to load ABI from path: ${flashSwapArtifactPath}`, e);
     const abiError = new Error(`Failed to load FlashSwap contract ABI from ${flashSwapArtifactPath}.`);
     abiError.type = 'FlashSwapManager: ABI Load Failed';
     abiError.details = { pathAttempted: flashSwapArtifactPath, originalError: e.message };
     throw abiError; // Stop execution if ABI cannot be loaded
}
// --- END USING ABSOLUTE PATH ---


class FlashSwapManager {
    /**
     * @param {object} config - The application configuration object.
     * @param {ethers.Provider} provider - The ethers provider instance.
     */
    constructor(config, provider) {
        logger.debug('[FlashSwapManager v1.7] Initializing...'); // Version bump
        this.config = config;
        this.provider = provider;

        if (!this.config.FLASH_SWAP_CONTRACT_ADDRESS || this.config.FLASH_SWAP_CONTRACT_ADDRESS === ethers.ZeroAddress) {
             logger.error('[FlashSwapManager] Critical Error: Flash Swap contract address is the Zero Address.');
             const err = new Error('Flash Swap contract address cannot be the Zero Address.');
             err.type = 'FlashSwapManager: Flash Swap contract address cannot be the Zero Address.';
             throw err;
        }

        this.flashSwapAddress = this.config.FLASH_SWAP_CONTRACT_ADDRESS;
        // Use the ABI from the loaded artifact
        this.flashSwapABI = FlashSwapArtifact.abi; // ABI is available from the require block above

        // Setup signer and wrap with NonceManager
        if (!this.config.PRIVATE_KEY) {
             logger.error('[FlashSwapManager] Critical Error: Private key is missing.');
             const err = new Error('Private key is required for signing transactions.');
             err.type = 'FlashSwapManager: Private key is missing.';
             throw err;
        }
        const wallet = new ethers.Wallet(this.config.PRIVATE_KEY, this.provider);
        this.signer = new NonceManager(wallet, logger);

        // Create contract instance using the NonceManager-wrapped signer
        try {
             this.flashSwapContract = new ethers.Contract(
                 this.flashSwapAddress,
                 this.flashSwapABI, // Use the ABI from the loaded artifact
                 this.signer
             );
             logger.debug('[FlashSwapManager] FlashSwap contract instance created.');
        } catch (contractInitError) {
             logger.error('[FlashSwapManager] Critical Error: Failed to create FlashSwap contract instance.', contractInitError);
             const err = new Error('Failed to create FlashSwap contract instance.');
             err.type = 'FlashSwapManager: Contract initialization failed.';
             err.details = { address: this.flashSwapAddress, error: contractInitError.message };
             throw err;
        }

        this.abiCoder = AbiCoder.defaultAbiCoder();

        logger.debug('[FlashSwapManager v1.7] Initialized.'); // Version bump
    }

    /**
     * Gets the address of the signer (EOA) being used by the manager.
     * @returns {Promise<string>} The signer address.
     */
    async getSignerAddress() {
        return await this.signer.getAddress();
    }

     /**
      * Gets the ethers Contract instance for the deployed FlashSwap contract.
      * @returns {ethers.Contract | null} The contract instance or null if not initialized.
      */
     getFlashSwapContract() {
          return this.flashSwapContract;
     }

     /**
      * Returns the loaded ABI for the FlashSwap contract.
      * This should be the same ABI used to create the contract instance.
      * @returns {Array<object> | null} The FlashSwap ABI, or null if loading failed.
      */
     getFlashSwapABI() {
         return this.flashSwapABI;
     }


    /**
     * Initiates a Uniswap V3 flash loan by calling the FlashSwap contract.
     * Called by the off-chain bot logic when a profitable UniV3 opportunity is found.
     * The FlashSwap contract's uniswapV3FlashCallback function will be executed by the V3 pool.
     * @param {string} poolAddress - The Uniswap V3 pool address to borrow from.
     * @param {bigint} amount0 - The amount of token0 to borrow.
     * @param {bigint} amount1 - The amount of token1 to borrow.
     * @param {string} tradeType - The string representation of the trade path type ('TwoHop' or 'Triangular').
     * @param {object} params - The specific parameters struct for the given trade type (TwoHopParams or TriangularPathParams).
     * @param {number} estimatedGasLimit - The estimated gas limit for the transaction triggering the flash loan.
     * @param {bigint} maxGasPriceGwei - The maximum gas price (in Gwei) to use for the transaction.
     * @returns {Promise<ethers.TransactionResponse>} The transaction response.
     */
    async initiateUniswapV3FlashLoan(
        poolAddress,
        amount0,
        amount1,
        tradeType,
        params,
        estimatedGasLimit,
        maxGasPriceGwei
    ) {
        logger.info(`[FlashSwapManager] Initiating UniV3 Flash Loan: Pool=${poolAddress}, Amount0=${amount0}, Amount1=${amount1}, Type=${tradeType}`);

        let callbackTypeEnum;
        if (tradeType === 'TwoHop') {
            callbackTypeEnum = 0;
        } else if (tradeType === 'Triangular') {
            callbackTypeEnum = 1;
        } else {
            throw new Error(`[FlashSwapManager] Invalid UniV3 trade type provided: ${tradeType}`);
        }

         let encodedParams;
         if (tradeType === 'TwoHop') {
              // Encoding for struct TwoHopParams { address tokenIntermediate; uint24 feeA; uint24 feeB; uint amountOutMinimum1; uint amountOutMinimum2; address titheRecipient; }
              // Check the builder's struct definition carefully if needed
              encodedParams = this.abiCoder.encode(
                  ['address', 'uint24', 'uint24', 'uint256', 'uint256', 'address'], // Updated type string
                  [params.tokenIntermediate, params.feeA, params.feeB, params.amountOutMinimum1, params.amountOutMinimum2, params.titheRecipient] // Pass all fields including titheRecipient
              );
         } else if (tradeType === 'Triangular') {
              // Encoding for struct TriangularPathParams { address tokenA; address tokenB; address tokenC; uint24 fee1; uint24 fee2; uint24 fee3; uint amountOutMinimumFinal; address titheRecipient; }
              // Check the builder's struct definition carefully if needed
              encodedParams = this.abiCoder.encode(
                  ['address', 'address', 'address', 'uint24', 'uint24', 'uint24', 'uint256', 'address'], // Updated type string
                  [params.tokenA, params.tokenB, params.tokenC, params.fee1, params.fee2, params.fee3, params.amountOutMinimumFinal, params.titheRecipient] // Pass all fields including titheRecipient
              );
         } else {
              // Fallback for unhandled types
             throw new Error(`[FlashSwapManager] Encoding error: Unhandled UniV3 trade type for encoding: ${tradeType}`);
         }


        const txOptions = {
            gasLimit: estimatedGasLimit,
            gasPrice: ethers.parseUnits(maxGasPriceGwei.toString(), 'gwei'),
        };

        logger.debug('[FlashSwapManager] Calling initiateUniswapV3FlashLoan on contract...');

        try {
            const tx = await this.flashSwapContract.initiateUniswapV3FlashLoan(
                callbackTypeEnum,
                poolAddress,
                amount0,
                amount1,
                encodedParams
            , txOptions);

            logger.info(`[FlashSwapManager] UniV3 Flash Loan Tx Sent: ${tx.hash}`);
            return tx;
        } catch (txError) {
            logger.error('[FlashSwapManager] UniV3 Flash Loan Tx Failed:', txError);
             const err = new Error(`UniV3 Flash Loan transaction failed: ${txError.message}`);
             err.type = 'FlashSwapManager: UniV3 Flash Loan Tx Failed';
             err.details = { originalError: txError, txOptions };
             throw err;
        }
    }

    /**
     * Initiates an Aave V3 flash loan by calling the FlashSwap contract.
     * @param {string} asset - The address of the asset to borrow.
     * @param {bigint} amount - The amount of the asset to borrow.
     * @param {Array<object>} path - The array of SwapStep objects defining the trade path (includes titheRecipient).
     * @param {number} estimatedGasLimit - The estimated gas limit for the transaction triggering the flash loan.
     * @param {bigint} maxGasPriceGwei - The maximum gas price (in Gwei) to use.
     * @returns {Promise<ethers.TransactionResponse>} The transaction response.
     */
    async initiateAaveFlashLoan(
        asset,
        amount,
        path, // Array of SwapStep objects matching SwapStep struct { uint8 dexType; address pool; address tokenIn; address tokenOut; uint minOut; uint24 fee; } PLUS titheRecipient at the end
        estimatedGasLimit,
        maxGasPriceGwei
    ) {
        logger.info(`[FlashSwapManager] Initiating Aave Flash Loan: Asset=${asset}, Amount=${amount}`);

        // The `path` array of SwapStep objects and the titheRecipient are now expected
        // to be included and correctly ordered in the arguments passed to the builder.
        // The builder should return encoded bytes for the ArbParams struct.

        // This function needs to call the AavePathBuilder to get the encoded ArbParams.
        // Import the AavePathBuilder here or lazily if needed, but it was already used in GasEstimator.
        // For consistency, let's use the builder.

         // Import AavePathBuilder lazily
         let AavePathBuilder;
         try {
             AavePathBuilder = require('./tx/builders/aavePathBuilder');
         } catch (requireError) {
              logger.error(`[FlashSwapManager] Failed to require AavePathBuilder: ${requireError.message}`);
              throw new Error(`Failed to load AavePathBuilder: ${requireError.message}`);
         }


         // We need the *full* opportunity object and simulation result to build parameters here.
         // This method's signature seems designed to take only asset, amount, path.
         // This points to a potential architectural inconsistency. The TradeHandler should perhaps
         // build the *final* parameters using the relevant builder before calling FSM.
         // For *now*, let's assume the `path` array *already* contains the necessary info for the builder,
         // and that the builder function can be called just before encoding the args for the contract.

         // Let's rebuild the parameters using the builder here before encoding the calldata.
         // This means the `initiateAaveFlashLoan` in FlashSwap.sol should probably take `bytes` calldata
         // for the parameters, not the structured `SwapStep[] path`.
         // Let's assume the contract's initiateAaveFlashLoan takes (address[] assets, uint256[] amounts, bytes params).
         // And `bytes params` is the encoded ArbParams struct: { SwapStep[] path; address titheRecipient; }

         // *** REASSESSMENT: The FlashSwap.sol initiateAaveFlashLoan takes `(address[] assets, uint256[] amounts, bytes params)`.
         // *** The `bytes params` argument is the ABI encoded `struct ArbParams { SwapStep[] path; address titheRecipient; }`.
         // *** So, the AavePathBuilder should produce this `bytes` calldata.
         // *** The initiateAaveFlashLoan *in FlashSwapManager* needs to call the builder to get this bytes.

         // The original `path` parameter passed *into this FSM function* is the *raw* path from the opportunity.
         // It does NOT contain the titheRecipient at the end yet.
         // We need the titheRecipient from config to call the builder here.

         const titheRecipient = this.config.TITHE_WALLET_ADDRESS;
          if (!titheRecipient || !ethers.isAddress(titheRecipient)) {
             const errorMsg = `Invalid TITHE_WALLET_ADDRESS in config: ${titheRecipient}. Cannot build Aave parameters.`;
             logger.error(`[FlashSwapManager] ${errorMsg}`);
             throw new Error(errorMsg); // Stop if tithe recipient is invalid
          }

         // Okay, let's use the AavePathBuilder here to build the `bytes params` expected by the contract.
         // The builder needs the raw path, config, FlashSwapManager (for signer address check), and titheRecipient.
         // Note: This requires the original opportunity and simulation result, which aren't passed to this FSM function.
         // *** THIS REVEALS A LOGIC FLAW: The FSM functions (`initiateUniswapV3FlashLoan`, `initiateAaveFlashLoan`)
         // *** should receive the *already built and encoded parameters* (bytes) from the TradeHandler, not raw opportunity data.
         // *** The TradeHandler should be responsible for calling the correct builder based on the opportunity type and loan provider. ***

         // Let's revert this part of FlashSwapManager for now to avoid deeper re-architecture mid-debug.
         // We will assume for the *minimal calldata encoding in GasEstimator* that the builder function
         // receives the raw path and titheRecipient correctly.
         // The issue we are fixing is in GasEstimator -> Builder call, NOT FSM -> Builder call yet.
         // The FSM->Contract call logic will be debugged later when we try an actual execution.

         // Reverting to original Aave Flash Loan encoding logic in FSM for now.
         // This assumes the `path` received here is ALREADY the correct SwapStep[] format
         // expected by the contract, with titheRecipient handled elsewhere (in the builder
         // called by TradeHandler when preparing for *actual* execution).
         // The minimal calldata encoding in GasEstimator needs to mimic the FINAL calldata structure.
         // So, GasEstimator should encode `struct ArbParams { SwapStep[] path; address titheRecipient; }`

         // Let's add the titheRecipient encoding to the minimal Aave calldata in GasEstimator.
         // The builder in GasEstimator should return { path: SwapStep[], titheRecipient: address, typeString: "tuple(SwapStep[] path, address titheRecipient)" }
         // And GasEstimator encodes this whole struct.

         // This section of FSM remains as it was before adding titheRecipient to the struct encoding for minimal calldata.
         // The `path` parameter received *here* for actual execution will need to be the full ArbParams struct encoded as bytes.

         throw new Error("[FlashSwapManager] initiateAaveFlashLoan needs re-architecting to accept encoded parameters.");

    }
     // The above initiateAaveFlashLoan implementation needs to be fixed to accept bytes params from TradeHandler.
     // For now, we focus on fixing the GasEstimator's minimal calldata encoding.


}

module.exports = FlashSwapManager;
