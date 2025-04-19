// core/txExecutor.js - Refactored
const { ethers } = require('ethers');
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const config = require('../config/index.js'); // Load main config
const FlashSwapManager = require('./flashSwapManager'); // For type hint
const GasEstimator = require('./gasEstimator'); // For type hint
const TxUtils = require('./tx'); // Import helpers from the new module
const { ABIS } = require('../constants/abis'); // Need Pool ABI

/**
 * Executes the arbitrage transaction using parameter builders and encoders.
 *
 * @param {object} opportunity The opportunity object from PoolScanner/ArbitrageEngine.
 * @param {object} simulationResult The result from QuoteSimulator. Needs { initialAmount, finalAmount }.
 * @param {FlashSwapManager} manager The initialized FlashSwapManager instance.
 * @param {GasEstimator} gasEstimator The GasEstimator instance.
 * @returns {Promise<{success: boolean, txHash: string|null, error: Error|null}>} Execution status.
 */
async function executeTransaction(opportunity, simulationResult, manager, gasEstimator) {
    const functionSig = `[TxExecutor OppType: ${opportunity?.type}, Group: ${opportunity?.groupName}]`;
    logger.log(`${functionSig} Preparing execution...`);

    // --- Input Validation ---
    if (!opportunity || !opportunity.type || !simulationResult || !manager || !gasEstimator) {
        logger.error(`${functionSig} Missing required arguments for execution.`, { opportunity, simulationResult: !!simulationResult, manager: !!manager, gasEstimator: !!gasEstimator });
        return { success: false, txHash: null, error: new ArbitrageError('Missing arguments for execution.', 'EXECUTION_ERROR') };
    }
    // Specific checks moved inside builder, but keep basic check here
    if (simulationResult.initialAmount == null || simulationResult.finalAmount == null) {
         logger.error(`${functionSig} Invalid simulationResult structure for execution. Missing initialAmount or finalAmount.`, simulationResult);
         return { success: false, txHash: null, error: new ArbitrageError('Invalid simulationResult structure.', 'EXECUTION_ERROR', { simulationResult }) };
     }

    // --- Get Core Components ---
    const flashSwapContract = manager.getFlashSwapContract();
    const signer = manager.getSigner(); // NonceManager instance
    const provider = manager.getProvider(); // Provider instance
    if (!flashSwapContract || !signer || !provider) {
         logger.error(`${functionSig} FlashSwap contract, signer, or provider not available from manager.`);
         return { success: false, txHash: null, error: new ArbitrageError('Missing core components from Manager.', 'EXECUTION_ERROR') };
    }

    try {
        let contractFunctionName;
        let encodedParams;
        let borrowPoolAddress;
        let borrowTokenAddress;
        let borrowAmount;
        let amount0ToBorrow = 0n;
        let amount1ToBorrow = 0n;

        // --- Build and Encode Parameters using Helpers ---
        let buildResult;
        if (opportunity.type === 'triangular') {
            buildResult = TxUtils.ParamBuilder.buildTriangularParams(opportunity, simulationResult, config);
            // Determine borrow pool (assumed to be the first pool in the path for triangular)
            borrowPoolAddress = opportunity.pools[0].address;
        } else if (opportunity.type === 'cyclic' /* or 'twoHop' */) {
            // Use placeholder builder for now
            buildResult = TxUtils.ParamBuilder.buildTwoHopParams(opportunity, simulationResult, config);
            // Determine borrow pool (assumed to be the first pool in the path for 2-hop placeholder)
            borrowPoolAddress = opportunity.pools[0].address;
        } else {
            throw new ArbitrageError(`Unsupported opportunity type for execution: ${opportunity.type}`, 'EXECUTION_ERROR');
        }

        // Extract common results from builder
        contractFunctionName = buildResult.contractFunctionName;
        borrowTokenAddress = buildResult.borrowTokenAddress;
        borrowAmount = buildResult.borrowAmount;

        // Encode the parameters
        encodedParams = TxUtils.Encoder.encodeParams(buildResult.params, buildResult.typeString);
        // --- End Parameter Building/Encoding ---


        // --- Determine Borrow Amounts (amount0/amount1) for Flash Call ---
        const borrowPoolContract = new ethers.Contract(borrowPoolAddress, ABIS.UniswapV3Pool, provider);
        let borrowPoolToken0Addr, borrowPoolToken1Addr;
         try {
              logger.debug(`${functionSig} Fetching token0/token1 for borrow pool ${borrowPoolAddress}...`);
              [borrowPoolToken0Addr, borrowPoolToken1Addr] = await Promise.all([
                  borrowPoolContract.token0(),
                  borrowPoolContract.token1()
              ]);
              logger.debug(`${functionSig} Borrow Pool Tokens: T0=${borrowPoolToken0Addr}, T1=${borrowPoolToken1Addr}`);
         } catch (tokenFetchError) {
             throw new ArbitrageError(`Error fetching token0/1 from borrow pool ${borrowPoolAddress}: ${tokenFetchError.message}`, 'RPC_ERROR', { originalError: tokenFetchError });
         }

        // Check if the token we decided to borrow is token0 or token1 of the borrow pool
        if (ethers.getAddress(borrowTokenAddress) === ethers.getAddress(borrowPoolToken0Addr)) {
            amount0ToBorrow = borrowAmount;
            logger.debug(`${functionSig} Borrowing amount0: ${ethers.formatUnits(amount0ToBorrow, config.TOKENS[opportunity.pathSymbols[0]]?.decimals || 18)}`); // Log with decimals if possible
        } else if (ethers.getAddress(borrowTokenAddress) === ethers.getAddress(borrowPoolToken1Addr)) {
            amount1ToBorrow = borrowAmount;
             logger.debug(`${functionSig} Borrowing amount1: ${ethers.formatUnits(amount1ToBorrow, config.TOKENS[opportunity.pathSymbols[0]]?.decimals || 18)}`);
        } else {
             throw new ArbitrageError(`Borrowed token address ${borrowTokenAddress} mismatch for borrow pool ${borrowPoolAddress}. Expected ${borrowPoolToken0Addr} or ${borrowPoolToken1Addr}.`, 'INTERNAL_ERROR', { borrowTokenAddress, borrowPoolToken0Addr, borrowPoolToken1Addr });
        }


        // --- Prepare arguments for the specific contract function call ---
        const contractCallArgs = [
            borrowPoolAddress, // Pool to borrow from
            amount0ToBorrow,
            amount1ToBorrow,
            encodedParams      // Encoded specific parameters (Triangular or TwoHop)
        ];

        // --- Final Gas Estimation ---
        let estimatedGasLimit;
        const txRequestForGas = {
             to: flashSwapContract.target, // Use .target for address in ethers v6
             data: flashSwapContract.interface.encodeFunctionData(contractFunctionName, contractCallArgs),
             // from: signer.address // 'from' is often inferred by provider/signer but can be explicit
        };
        try {
             logger.log(`${functionSig} Performing final gas estimation for ${contractFunctionName}...`);
             estimatedGasLimit = await gasEstimator.estimateGasLimit(txRequestForGas); // Use GasEstimator class method
             logger.log(`${functionSig} Final Gas Estimate (with buffer): ${estimatedGasLimit.toString()}`);
        } catch (gasEstimateError) {
            // Error likely already logged by gasEstimator, just re-throw specific error
             handleError(gasEstimateError, `TxExecutor EstimateGas (${contractFunctionName})`);
             throw new ArbitrageError(`Gas estimation failed for ${contractFunctionName}: ${gasEstimateError.message}`, 'GAS_ESTIMATION_ERROR', { originalError: gasEstimateError });
        }

        // --- Get Gas Fees and Nonce ---
        const gasPriceData = await gasEstimator.getGasPriceData(); // Use GasEstimator class method
        if (!gasPriceData) {
             throw new ArbitrageError('Failed to get current gas parameters for execution.', 'GAS_PRICE_ERROR');
        }
        // Get nonce using the NonceManager instance from FlashSwapManager
        const nonce = await signer.getNextNonce();
        logger.debug(`${functionSig} Using Nonce: ${nonce}`);
        if (gasPriceData.maxFeePerGas) {
            logger.debug(`${functionSig} Using Gas Fees: maxFeePerGas=${ethers.formatUnits(gasPriceData.maxFeePerGas, 'gwei')} Gwei, maxPriorityFeePerGas=${ethers.formatUnits(gasPriceData.maxPriorityFeePerGas, 'gwei')} Gwei`);
        } else {
             logger.debug(`${functionSig} Using Gas Fees: gasPrice=${ethers.formatUnits(gasPriceData.gasPrice, 'gwei')} Gwei`);
        }

        // --- Construct Transaction Overrides ---
        const txOverrides = {
            gasLimit: estimatedGasLimit, // Use buffered limit from estimator
            nonce: nonce,
            maxFeePerGas: gasPriceData.maxFeePerGas, // Use fee data from estimator
            maxPriorityFeePerGas: gasPriceData.maxPriorityFeePerGas,
            gasPrice: gasPriceData.gasPrice // Use legacy gasPrice if EIP-1559 not available
        };
        // Clean up overrides based on what fee data we got
        if (txOverrides.maxFeePerGas != null) { // Check for null/undefined explicitly
             delete txOverrides.gasPrice;
         } else {
             delete txOverrides.maxFeePerGas;
             delete txOverrides.maxPriorityFeePerGas;
         }


        // --- EXECUTE TRANSACTION ---
        if (config.DRY_RUN) {
             logger.warn(`[DRY RUN] ${functionSig} Skipping actual transaction submission.`);
             logger.warn(`[DRY RUN] Would call ${contractFunctionName} on ${flashSwapContract.target}`);
             // Log arguments cleanly
             logger.warn(`[DRY RUN] Args: borrowPool=${contractCallArgs[0]}, amt0=${contractCallArgs[1]}, amt1=${contractCallArgs[2]}, encodedParams=${contractCallArgs[3]}`);
             logger.warn(`[DRY RUN] Overrides: ${JSON.stringify(txOverrides, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)}`); // Handle BigInt serialization
             return { success: true, txHash: 'DRY_RUN_SUCCESS', error: null };
        } else {
            logger.warn(`>>> [LIVE] ${functionSig} ATTEMPTING TO SEND TRANSACTION <<<`);
            try {
                // Call the specific function using array arguments and overrides
                const txResponse = await flashSwapContract[contractFunctionName](...contractCallArgs, txOverrides);

                logger.log(`>>> [LIVE] ${functionSig} TRANSACTION SENT! HASH: ${txResponse.hash}`);
                // Optional: Wait for receipt
                // logger.log(">>> Waiting for 1 confirmation...");
                // const receipt = await txResponse.wait(1);
                // logger.log(`>>> TRANSACTION CONFIRMED! Block: ${receipt.blockNumber}, Status: ${receipt.status === 1 ? 'Success' : 'Failed'}, Gas Used: ${receipt.gasUsed.toString()}`);
                // if (receipt.status !== 1) { throw new Error(`Transaction ${txResponse.hash} failed on-chain.`); }

                return { success: true, txHash: txResponse.hash, error: null };

            } catch (executionError) {
                handleError(executionError, `TxExecutor SendTransaction (${contractFunctionName})`);
                // Attempt to resync nonce on specific errors
                if (executionError.code === 'NONCE_EXPIRED' || executionError.code === 'REPLACEMENT_UNDERPRICED' || (executionError.message && executionError.message.includes('nonce too low'))) {
                     logger.warn(`${functionSig} Nonce error detected ('${executionError.code || executionError.message}'), attempting resync...`);
                     await signer.resyncNonce(); // Call resync on NonceManager instance
                }
                throw new ArbitrageError(`Transaction execution failed: ${executionError.message}`, 'EXECUTION_ERROR', { originalError: executionError });
            }
        }

    } catch (error) {
        // Catch errors from preparation steps (builders, encoders, token fetch) or re-thrown errors from execution
        if (!(error instanceof ArbitrageError)) { // Wrap unexpected errors
             handleError(error, 'TxExecutor Unexpected');
             return { success: false, txHash: null, error: new ArbitrageError(`Unexpected Executor error: ${error.message}`, 'UNKNOWN_EXECUTION_ERROR', { originalError: error }) };
        } else {
             // Log known ArbitrageErrors (already handled if needed)
             handleError(error, 'TxExecutor'); // Log it again here for context
             return { success: false, txHash: null, error: error };
        }
    }
}

module.exports = { executeTransaction };
