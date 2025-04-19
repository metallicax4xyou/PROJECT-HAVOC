// core/txExecutor.js
const { ethers } = require('ethers');
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const config = require('../config/index.js'); // Load main config
const FlashSwapManager = require('./flashSwapManager'); // For type hint
const GasEstimator = require('./gasEstimator'); // For type hint

// Helper function to calculate minimum amount out based on slippage
// (Moved here from quoteSimulator for better cohesion)
function calculateMinAmountOut(amountOut, slippageToleranceBps) {
    if (!amountOut || amountOut <= 0n || slippageToleranceBps < 0) {
        return 0n; // Or throw error
    }
    const BPS_DIVISOR = 10000n; // Basis points divisor
    const slippageFactor = BPS_DIVISOR - BigInt(slippageToleranceBps);
    // Calculate min amount: amountOut * (1 - slippage)
    // minAmount = (amountOut * (10000 - slippageBps)) / 10000
    return (amountOut * slippageFactor) / BPS_DIVISOR;
}

/**
 * Executes the arbitrage transaction. Handles both 2-hop and 3-hop paths.
 *
 * @param {object} opportunity The opportunity object from PoolScanner/ArbitrageEngine.
 *                  - For type='triangular': { type, pathSymbols, pools, estimatedRate, rawRate, groupName }
 *                  - For type='cyclic' (if supported later): { type, ... other fields ... }
 * @param {object} simulationResult The result from QuoteSimulator. Needs { initialAmount, finalAmount }.
 *                  (Note: Changed initialAmountToken0 to initialAmount, finalAmountToken0 to finalAmount)
 * @param {FlashSwapManager} manager The initialized FlashSwapManager instance.
 * @param {GasEstimator} gasEstimator The GasEstimator instance.
 * @returns {Promise<{success: boolean, txHash: string|null, error: Error|null}>} Execution status.
 */
async function executeTransaction(opportunity, simulationResult, manager, gasEstimator) {
    const functionSig = `[TxExecutor OppType: ${opportunity?.type}, Group: ${opportunity?.groupName}]`;
    logger.log(`${functionSig} Preparing execution...`);

    // --- Input Validation ---
    if (!opportunity || !opportunity.type || !simulationResult || !manager || !gasEstimator) {
        logger.error(`${functionSig} Missing required arguments for execution.`, { opportunity, simulationResult, manager, gasEstimator });
        return { success: false, txHash: null, error: new ArbitrageError('Missing arguments for execution.', 'EXECUTION_ERROR', { opportunity, simulationResult }) };
    }
    if (typeof simulationResult.initialAmount === 'undefined' || typeof simulationResult.finalAmount === 'undefined') {
        logger.error(`${functionSig} Invalid simulationResult structure. Missing initialAmount or finalAmount.`, simulationResult);
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

        // --- Logic for TRIANGULAR Path ---
        if (opportunity.type === 'triangular') {
            contractFunctionName = 'initiateTriangularFlashSwap'; // Target new function

            // Validate triangular opportunity structure
            if (!opportunity.pools || opportunity.pools.length !== 3 || !opportunity.pathSymbols || opportunity.pathSymbols.length !== 4) {
                 throw new ArbitrageError('Invalid triangular opportunity structure.', 'EXECUTION_ERROR', { opportunity });
            }
            const [poolAB, poolBC, poolCA] = opportunity.pools;
            const [tokenASymbol, tokenBSymbol, tokenCSymbol] = opportunity.pathSymbols; // We only need A, B, C

            // Find the SDK Token objects from config using symbols
            const tokenA = config.TOKENS[tokenASymbol];
            const tokenB = config.TOKENS[tokenBSymbol];
            const tokenC = config.TOKENS[tokenCSymbol];
            if (!tokenA || !tokenB || !tokenC) {
                throw new ArbitrageError(`Could not find SDK Token instance for symbols: ${tokenASymbol}, ${tokenBSymbol}, ${tokenCSymbol}`, 'INTERNAL_ERROR');
            }

            // Determine borrow pool and amount (assume borrow happens from first pool in path)
            // We borrow tokenA from poolAB
            borrowPoolAddress = poolAB.address;
            borrowTokenAddress = tokenA.address;
            // Borrow amount comes from simulation result (the initial amount used for sim)
            borrowAmount = simulationResult.initialAmount;

            // Calculate final minimum amount out using slippage
            const finalAmountSimulated = simulationResult.finalAmount; // Amount of TokenA expected back
            const minAmountOutFinal = calculateMinAmountOut(finalAmountSimulated, config.SLIPPAGE_TOLERANCE_BPS);
            logger.debug(`${functionSig} Slippage Tolerance: ${config.SLIPPAGE_TOLERANCE_BPS} bps`);
            logger.debug(`${functionSig} Final Amount Simulated (${tokenASymbol}): ${ethers.formatUnits(finalAmountSimulated, tokenA.decimals)}`);
            logger.debug(`${functionSig} Min Amount Out Final (${tokenASymbol}): ${ethers.formatUnits(minAmountOutFinal, tokenA.decimals)}`);

            if (minAmountOutFinal <= 0n) {
                throw new ArbitrageError('Calculated zero minimum final amount out, aborting.', 'SLIPPAGE_ERROR', { finalAmountSimulated, minAmountOutFinal });
            }

            // Prepare parameters for TriangularPathParams struct
            const triangularParams = {
                pool1: poolAB.address,
                pool2: poolBC.address,
                pool3: poolCA.address,
                tokenA: tokenA.address,
                tokenB: tokenB.address,
                tokenC: tokenC.address,
                fee1: poolAB.fee, // Assuming fee is already number here
                fee2: poolBC.fee,
                fee3: poolCA.fee,
                amountOutMinimumFinal: minAmountOutFinal
            };

            // Define the struct type for encoding
            const triangularParamTypes = ["(address pool1, address pool2, address pool3, address tokenA, address tokenB, address tokenC, uint24 fee1, uint24 fee2, uint24 fee3, uint256 amountOutMinimumFinal)"];

            // Encode parameters
            try {
                encodedParams = ethers.AbiCoder.defaultAbiCoder().encode(triangularParamTypes, [triangularParams]);
                logger.debug(`${functionSig} Triangular callback parameters encoded.`);
            } catch (encodeError) {
                throw new ArbitrageError(`Failed to encode triangular parameters: ${encodeError.message}`, 'ENCODING_ERROR', { originalError: encodeError, params: triangularParams });
            }

        }
        // --- Logic for TWO_HOP Path (Example Placeholder) ---
        else if (opportunity.type === 'cyclic' /* or 'twoHop' */) {
            contractFunctionName = 'initiateFlashSwap'; // Target original function

            // --- !!! Placeholder: Need to adapt this logic based on actual 2-hop opportunity structure !!! ---
            logger.warn(`${functionSig} 2-Hop execution logic is placeholder - needs implementation based on actual opportunity structure.`);
            // Example structure needed: opportunity.token0, opportunity.token1, opportunity.borrowAmount,
            // opportunity.poolHop1, opportunity.poolHop2, simulationResult.trade1, simulationResult.trade2
            const sdkTokenBorrowed = opportunity.token0; // EXAMPLE
            const sdkTokenIntermediate = opportunity.token1; // EXAMPLE
            const poolA = opportunity.poolHop1; // EXAMPLE
            const poolB = opportunity.poolHop2; // EXAMPLE
            const trade1 = simulationResult.trade1; // EXAMPLE: Assume sim result includes SDK Trade objects
            const trade2 = simulationResult.trade2; // EXAMPLE

            if (!sdkTokenBorrowed || !sdkTokenIntermediate || !poolA || !poolB || !trade1 || !trade2) {
                 throw new ArbitrageError('Invalid 2-hop opportunity structure for execution.', 'EXECUTION_ERROR', { opportunity });
            }

            borrowPoolAddress = poolA.address; // EXAMPLE: Assume borrow from first pool
            borrowTokenAddress = sdkTokenBorrowed.address;
            borrowAmount = simulationResult.initialAmount;

            // Calculate min amounts out for BOTH swaps
            const minAmountOut1 = calculateMinAmountOut(trade1.outputAmount.quotient, config.SLIPPAGE_TOLERANCE_BPS);
            const minAmountOut2 = calculateMinAmountOut(trade2.outputAmount.quotient, config.SLIPPAGE_TOLERANCE_BPS);

            if (minAmountOut1 <= 0n || minAmountOut2 <= 0n) {
                 throw new ArbitrageError('Calculated zero minimum amount out (2-hop), aborting.', 'SLIPPAGE_ERROR');
            }

            // Prepare parameters for TwoHopParams struct
            const twoHopParams = {
                tokenIntermediate: sdkTokenIntermediate.address,
                poolA: poolA.address,
                feeA: poolA.fee,
                poolB: poolB.address,
                feeB: poolB.fee,
                amountOutMinimum1: minAmountOut1,
                amountOutMinimum2: minAmountOut2
            };

            // Define the struct type for encoding
            const twoHopParamTypes = ["(address tokenIntermediate, address poolA, uint24 feeA, address poolB, uint24 feeB, uint256 amountOutMinimum1, uint256 amountOutMinimum2)"];

            // Encode parameters
            try {
                encodedParams = ethers.AbiCoder.defaultAbiCoder().encode(twoHopParamTypes, [twoHopParams]);
                logger.debug(`${functionSig} 2-Hop callback parameters encoded.`);
            } catch (encodeError) {
                throw new ArbitrageError(`Failed to encode 2-hop parameters: ${encodeError.message}`, 'ENCODING_ERROR', { originalError: encodeError, params: twoHopParams });
            }
            // --- !!! End Placeholder !!! ---

        } else {
            throw new ArbitrageError(`Unsupported opportunity type for execution: ${opportunity.type}`, 'EXECUTION_ERROR');
        }


        // --- Determine Borrow Amounts (amount0/amount1) for Flash Call ---
        // We need token0/token1 addresses OF THE BORROW POOL
        const borrowPoolContract = new ethers.Contract(borrowPoolAddress, ABIS.UniswapV3Pool, provider);
        let borrowPoolToken0Addr, borrowPoolToken1Addr;
         try {
              [borrowPoolToken0Addr, borrowPoolToken1Addr] = await Promise.all([
                  borrowPoolContract.token0(),
                  borrowPoolContract.token1()
              ]);
         } catch (tokenFetchError) {
             throw new ArbitrageError(`Error fetching token0/1 from borrow pool ${borrowPoolAddress}: ${tokenFetchError.message}`, 'RPC_ERROR', { originalError: tokenFetchError });
         }

        // Check if the token we decided to borrow is token0 or token1 of the borrow pool
        if (ethers.getAddress(borrowTokenAddress) === ethers.getAddress(borrowPoolToken0Addr)) { amount0ToBorrow = borrowAmount; }
        else if (ethers.getAddress(borrowTokenAddress) === ethers.getAddress(borrowPoolToken1Addr)) { amount1ToBorrow = borrowAmount; }
        else { throw new ArbitrageError(`Borrowed token address ${borrowTokenAddress} mismatch for borrow pool ${borrowPoolAddress}. Expected ${borrowPoolToken0Addr} or ${borrowPoolToken1Addr}.`, 'INTERNAL_ERROR'); }
        logger.debug(`${functionSig} Determined Borrow Amounts: amount0=${amount0ToBorrow}, amount1=${amount1ToBorrow}`);


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
        if (txOverrides.maxFeePerGas) delete txOverrides.gasPrice; else { delete txOverrides.maxFeePerGas; delete txOverrides.maxPriorityFeePerGas; }


        // --- EXECUTE TRANSACTION ---
        if (config.DRY_RUN) {
             logger.warn(`[DRY RUN] ${functionSig} Skipping actual transaction submission.`);
             logger.warn(`[DRY RUN] Would call ${contractFunctionName} on ${flashSwapContract.target}`);
             logger.warn(`[DRY RUN] Arguments: ${JSON.stringify(contractCallArgs, null, 2)}`);
             logger.warn(`[DRY RUN] Overrides: ${JSON.stringify(txOverrides, null, 2)}`);
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
                if (executionError.code === 'NONCE_EXPIRED' || executionError.code === 'REPLACEMENT_UNDERPRICED') {
                     logger.warn(`${functionSig} Nonce error detected, attempting resync...`);
                     await signer.resyncNonce(); // Call resync on NonceManager instance
                }
                throw new ArbitrageError(`Transaction execution failed: ${executionError.message}`, 'EXECUTION_ERROR', { originalError: executionError });
            }
        }

    } catch (error) {
        // Catch errors from preparation steps or re-thrown errors from execution
        if (!(error instanceof ArbitrageError)) { // Wrap unexpected errors
             handleError(error, 'TxExecutor Unexpected');
             return { success: false, txHash: null, error: new ArbitrageError(`Unexpected Executor error: ${error.message}`, 'UNKNOWN_EXECUTION_ERROR', { originalError: error }) };
        } else {
             // Log known ArbitrageErrors
             handleError(error, 'TxExecutor');
             return { success: false, txHash: null, error: error };
        }
    }
}

module.exports = { executeTransaction };
