// core/flashSwapManager.js
// --- VERSION 1.5 --- Added debug logs for __dirname and process.cwd()

const { ethers } = require('ethers');
const logger = require('../utils/logger');
const NonceManager = require('../utils/nonceManager'); // Import NonceManager
const { AbiCoder } = require('ethers'); // Import AbiCoder
const path = require('path'); // Import Node.js path module

// --- DEBUGGING PATHS ---
const currentDirDebug = __dirname;
const processCwdDebug = process.cwd();
logger.debug(`[FlashSwapManager Debug Path] __dirname: ${currentDirDebug}`);
logger.debug(`[FlashSwapManager Debug Path] process.cwd(): ${processCwdDebug}`);
// --- END DEBUGGING PATHS ---


// --- USING ABSOLUTE PATH FOR ABI (Using path.resolve) ---
// Get the directory of the current script (core/)
const currentDir = __dirname;

// Construct the absolute path to the FlashSwap contract artifact using path.resolve.
// path.resolve(from, to) resolves 'to' relative to 'from'.
// path.resolve(currentDir, '..', '..', 'artifacts', 'contracts', 'FlashSwap.sol', 'FlashSwap.json')
// This means: start at currentDir, go up one level, go up another level, then into artifacts/...
const flashSwapArtifactPath = path.resolve(currentDir, '..', '..', 'artifacts', 'contracts', 'FlashSwap.sol', 'FlashSwap.json');

logger.debug(`[FlashSwapManager] Attempting to load ABI from resolved path: ${flashSwapArtifactPath}`);

let FlashSwapArtifact;
try {
    // Require the FlashSwap contract artifact using the constructed absolute path.
    // This contains the ABI needed to interact with the deployed contract.
    FlashSwapArtifact = require(flashSwapArtifactPath);
    logger.debug('[FlashSwapManager] Successfully loaded ABI.');
} catch (e) {
    logger.error(`[FlashSwapManager] CRITICAL ERROR: Failed to load ABI from path: ${flashSwapArtifactPath}`, e);
     // Re-throw a clear error indicating the ABI loading failed
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
        logger.debug('[FlashSwapManager] Initializing...');
        this.config = config;
        this.provider = provider;

        // Ensure the flash swap contract address is provided and is not the zero address
        // Note: Config validation for this happens before this point.
        if (!this.config.FLASH_SWAP_CONTRACT_ADDRESS || this.config.FLASH_SWAP_CONTRACT_ADDRESS === ethers.ZeroAddress) {
             // This error should ideally be caught during config loading, but check here too.
             logger.error('[FlashSwapManager] Critical Error: Flash Swap contract address is the Zero Address.');
             const err = new Error('Flash Swap contract address cannot be the Zero Address.');
             err.type = 'FlashSwapManager: Flash Swap contract address cannot be the Zero Address.';
             throw err; // Throw here to stop initialization
        }

        this.flashSwapAddress = this.config.FLASH_SWAP_CONTRACT_ADDRESS;
        // Use the ABI from the loaded artifact
        this.flashSwapABI = FlashSwapArtifact.abi; // ABI is now available from the require block above

        // Setup signer and wrap with NonceManager
        if (!this.config.PRIVATE_KEY) {
             logger.error('[FlashSwapManager] Critical Error: Private key is missing.');
             const err = new Error('Private key is required for signing transactions.');
             err.type = 'FlashSwapManager: Private key is missing.';
             throw err; // Throw here to stop initialization
        }
        // Create a wallet instance from the private key
        const wallet = new ethers.Wallet(this.config.PRIVATE_KEY, this.provider);
        // Wrap the wallet with NonceManager for reliable transaction signing and nonce handling
        this.signer = new NonceManager(wallet, logger);

        // Create contract instance using the NonceManager-wrapped signer
        try {
             this.flashSwapContract = new ethers.Contract(
                 this.flashSwapAddress,
                 this.flashSwapABI,
                 this.signer // Use the signer which includes the NonceManager
             );
             logger.debug('[FlashSwapManager] FlashSwap contract instance created.');
        } catch (contractInitError) {
             logger.error('[FlashSwapManager] Critical Error: Failed to create FlashSwap contract instance.', contractInitError);
             const err = new Error('Failed to create FlashSwap contract instance.');
             err.type = 'FlashSwapManager: Contract initialization failed.';
             err.details = { address: this.flashSwapAddress, error: contractInitError.message };
             throw err;
        }


        // Initialize AbiCoder for encoding parameters.
        // Used for encoding the parameters passed to the FlashSwap contract's functions.
        this.abiCoder = AbiCoder.defaultAbiCoder();

        logger.debug('[FlashSwapManager] Initialized.');
    }

    /**
     * Gets the address of the signer (EOA) being used by the manager.
     * @returns {Promise<string>} The signer address.
     */
    async getSignerAddress() {
        // The NonceManager instance has an underlying signer (the wallet)
        // We can call getAddress() directly on the NonceManager, which passes the call to the underlying signer.
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
        tradeType, // e.g., 'TwoHop', 'Triangular' - Used to determine CallbackType enum value
        params, // e.g., { tokenIntermediate, feeA, feeB, amountOutMinimum1, amountOutMinimum2 } for TwoHop
                // or { tokenA, tokenB, tokenC, fee1, fee2, fee3, amountOutMinimumFinal } for Triangular
        estimatedGasLimit, // Expected gas limit from off-chain estimation
        maxGasPriceGwei // Max acceptable gas price in Gwei
    ) {
        logger.info(`[FlashSwapManager] Initiating UniV3 Flash Loan: Pool=${poolAddress}, Amount0=${amount0}, Amount1=${amount1}, Type=${tradeType}`);

        // Map string tradeType to the corresponding CallbackType enum value (0 for TwoHop, 1 for Triangular)
        let callbackTypeEnum;
        if (tradeType === 'TwoHop') {
            callbackTypeEnum = 0;
        } else if (tradeType === 'Triangular') {
            callbackTypeEnum = 1;
        } else {
             // This should ideally be validated earlier when building the trade data
            throw new Error(`[FlashSwapManager] Invalid UniV3 trade type provided: ${tradeType}`);
        }

         // Encode the specific trade parameters (TwoHopParams or TriangularPathParams struct)
         // The encoding must exactly match the `abi.decode` structure in FlashSwap.sol::uniswapV3FlashCallback
         // These encoded bytes are passed as the `params` argument in the FlashCallbackData struct.
         let encodedParams;
         if (tradeType === 'TwoHop') {
              // Encoding for struct TwoHopParams { address tokenIntermediate; uint24 feeA; uint24 feeB; uint amountOutMinimum1; uint amountOutMinimum2; }
              encodedParams = this.abiCoder.encode(
                  ['address', 'uint24', 'uint24', 'uint256', 'uint256'],
                  [params.tokenIntermediate, params.feeA, params.feeB, params.amountOutMinimum1, params.amountOutMinimum2]
              );
         } else if (tradeType === 'Triangular') {
              // Encoding for struct TriangularPathParams { address tokenA; address tokenB; address tokenC; uint24 fee1; uint24 fee2; uint24 fee3; uint amountOutMinimumFinal; }
              // Note: tokenA is the borrowed token and is handled by the callback logic, but included in the struct encoding.
              encodedParams = this.abiCoder.encode(
                  ['address', 'address', 'address', 'uint24', 'uint24', 'uint24', 'uint256'],
                  [params.tokenA, params.tokenB, params.tokenC, params.fee1, params.fee2, params.fee3, params.amountOutMinimumFinal]
              );
         } else {
              // Fallback for unhandled types
             throw new Error(`[FlashSwapManager] Encoding error: Unhandled UniV3 trade type for encoding: ${tradeType}`);
         }


        // Prepare the transaction options, including gas limit and price
        const txOptions = {
            gasLimit: estimatedGasLimit, // Use estimated gas limit from off-chain calculation
            gasPrice: ethers.parseUnits(maxGasPriceGwei.toString(), 'gwei'), // Set max gas price (in Gwei)
            // Nonce is automatically handled by the NonceManager wrapper around the signer
        };

         // Note: UniV3 flash loan initiation usually doesn't require sending ETH (value: ...)
         // unless the calling contract or setup specifically requires it for some reason.
         // The borrowed funds are made available within the callback.

        logger.debug('[FlashSwapManager] Calling initiateUniswapV3FlashLoan on contract...');

        try {
            // Call the external function on the deployed FlashSwap contract instance
            const tx = await this.flashSwapContract.initiateUniswapV3FlashLoan(
                callbackTypeEnum, // CallbackType enum (0 or 1)
                poolAddress,      // The V3 pool address to borrow from
                amount0,          // Amount of token0 to borrow (as BigInt)
                amount1,          // Amount of token1 to borrow (as BigInt)
                encodedParams     // Abi-encoded trade parameters bytes
            , txOptions); // Pass transaction options including gas limit and price

            logger.info(`[FlashSwapManager] UniV3 Flash Loan Tx Sent: ${tx.hash}`);
            return tx; // Return the ethers TransactionResponse object
        } catch (txError) {
            logger.error('[FlashSwapManager] UniV3 Flash Loan Tx Failed:', txError);
             // Wrap the error with context before re-throwing
             const err = new Error(`UniV3 Flash Loan transaction failed: ${txError.message}`);
             err.type = 'FlashSwapManager: UniV3 Flash Loan Tx Failed';
             err.details = { originalError: txError, txOptions };
             throw err; // Re-throw the wrapped error
        }
    }

    /**
     * Initiates an Aave V3 flash loan by calling the FlashSwap contract.
     * Called by the off-chain bot logic when a profitable Aave-based opportunity is found.
     * The FlashSwap contract's executeOperation function will be executed by the Aave Pool.
     * @param {string} asset - The address of the asset to borrow.
     * @param {bigint} amount - The amount of the asset to borrow.
     * @param {Array<object>} path - The array of SwapStep objects defining the trade path.
     * @param {number} estimatedGasLimit - The estimated gas limit for the transaction triggering the flash loan.
     * @param {bigint} maxGasPriceGwei - The maximum gas price (in Gwei) to use.
     * @returns {Promise<ethers.TransactionResponse>} The transaction response.
     */
    async initiateAaveFlashLoan(
        asset,
        amount,
        path, // Array of SwapStep objects [{ pool, tokenIn, tokenOut, fee, minOut, dexType }, ...]
        estimatedGasLimit,
        maxGasPriceGwei
    ) {
        logger.info(`[FlashSwapManager] Initiating Aave Flash Loan: Asset=${asset}, Amount=${amount}`);

        // The `path` array of SwapStep objects is passed directly as an argument
        // to the initiateAaveFlashLoan function in FlashSwap.sol.
        // The encoding into the ArbParams struct happens *inside* the Solidity contract.
        // We just need to ensure the `path` variable here is the correct structure (Array of objects matching SwapStep).

        // Prepare the transaction options, including gas limit and price
        const txOptions = {
             gasLimit: estimatedGasLimit, // Use estimated gas limit from off-chain calculation
             gasPrice: ethers.parseUnits(maxGasPriceGwei.toString(), 'gwei'), // Set max gas price (in Gwei)
             // Nonce is automatically handled by the NonceManager wrapper around the signer
        };

        logger.debug('[FlashSwapManager] Calling initiateAaveFlashLoan on contract...');

        try {
            // Call the external function on the deployed FlashSwap contract instance
            const tx = await this.flashSwapContract.initiateAaveFlashLoan(
                asset, // The asset address to borrow
                amount, // The amount to borrow (as BigInt)
                path // The array of SwapStep objects
             , txOptions); // Pass transaction options

            logger.info(`[FlashSwapManager] Aave Flash Loan Tx Sent: ${tx.hash}`);
            return tx; // Return the ethers TransactionResponse object
        } catch (txError) {
            logger.error('[FlashSwapManager] Aave Flash Loan Tx Failed:', txError);
            // Wrap the error with context before re-throwing
            const err = new Error(`Aave Flash Loan transaction failed: ${txError.message}`);
            err.type = 'FlashSwapManager: Aave Flash Loan Tx Failed';
            err.details = { originalError: txError, txOptions };
            throw err; // Re-throw the wrapped error
        }
    }

     // Add other helper methods needed by the bot, like getting the contract address or signer address.
     // getSignerAddress and getFlashSwapContract are implemented above.
}

module.exports = FlashSwapManager;
