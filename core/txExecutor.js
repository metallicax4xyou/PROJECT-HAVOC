// core/txExecutor.js
const { ethers } = require('ethers');
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const { getMinimumAmountOut } = require('./quoteSimulator'); // Use helper to calculate min amounts
const config = require('../config/index.js'); // Load config for slippage etc

/**
 * Executes the arbitrage transaction if simulation passes.
 * @param {object} opportunity The validated opportunity object from previous steps.
 *                   Requires: { startPoolInfo, swapPoolInfo, sdkTokenBorrowed, sdkTokenIntermediate,
 *                             borrowAmount, trade1, trade2 (from simulationResult) }
 * @param {FlashSwapManager} manager The initialized FlashSwapManager instance.
 * @param {object} profitabilityResult The result from ProfitCalculator. Requires { estimatedGasCost }
 * @returns {Promise<{success: boolean, txHash: string|null, error: Error|null}>} Execution status.
 */
async function executeTransaction(opportunity, manager, profitabilityResult) {
    logger.log(`[Executor] Received profitable opportunity for group ${opportunity.groupName}. Preparing execution...`);

    if (!opportunity || !manager || !profitabilityResult || !opportunity.trade1 || !opportunity.trade2) {
        logger.error('[Executor] Missing required data for execution.', { opportunity, manager, profitabilityResult });
        return { success: false, txHash: null, error: new ArbitrageError('Missing data for execution.', 'EXECUTION_ERROR') };
    }

    const {
        startPoolInfo,
        swapPoolInfo,
        sdkTokenBorrowed,
        sdkTokenIntermediate,
        borrowAmount,
        trade1, // SDK Trade object from simulation
        trade2  // SDK Trade object from simulation
    } = opportunity;

    const { estimatedGasCost } = profitabilityResult; // Gas cost estimated by ProfitCalculator

    const flashSwapContract = manager.getFlashSwapContract();
    const signer = manager.getSigner();
    const provider = manager.getProvider(); // Needed for token0/1 lookup

    if (!flashSwapContract || !signer || !provider) {
         logger.error('[Executor] FlashSwap contract, signer, or provider not available from manager.');
         return { success: false, txHash: null, error: new ArbitrageError('Missing core components from Manager.', 'EXECUTION_ERROR') };
    }

    try {
        // 1. Calculate Minimum Amounts Out using slippage tolerance from config
        const minAmountOut1 = getMinimumAmountOut(trade1, config.SLIPPAGE_TOLERANCE_BPS);
        const minAmountOut2 = getMinimumAmountOut(trade2, config.SLIPPAGE_TOLERANCE_BPS);
        logger.debug(`[Executor] Slippage Tolerance: ${config.SLIPPAGE_TOLERANCE_BPS} bps`);
        logger.debug(`[Executor] Min Amount Out Swap 1 (${sdkTokenIntermediate.symbol}): ${ethers.formatUnits(minAmountOut1, sdkTokenIntermediate.decimals)}`);
        logger.debug(`[Executor] Min Amount Out Swap 2 (${sdkTokenBorrowed.symbol}): ${ethers.formatUnits(minAmountOut2, sdkTokenBorrowed.decimals)}`);

        if (minAmountOut1 === 0n || minAmountOut2 === 0n) {
            throw new ArbitrageError('Calculated zero minimum amount out, aborting.', 'SLIPPAGE_ERROR', { min1: minAmountOut1, min2: minAmountOut2 });
        }

        // 2. Prepare Arbitrage Parameters for the callback
        const arbitrageParams = {
            tokenIntermediate: sdkTokenIntermediate.address,
            poolA: swapPoolInfo.address,        // Router uses feeA/feeB, address for clarity/future use
            feeA: swapPoolInfo.feeBps,          // Use swap pool's fee for both swaps
            poolB: swapPoolInfo.address,
            feeB: swapPoolInfo.feeBps,
            amountOutMinimum1: minAmountOut1,   // Use calculated min amount
            amountOutMinimum2: minAmountOut2    // Use calculated min amount
        };

        // 3. Encode Parameters
        let encodedParams;
        try {
            const paramTypes = ['(address tokenIntermediate, address poolA, uint24 feeA, address poolB, uint24 feeB, uint256 amountOutMinimum1, uint256 amountOutMinimum2)'];
            encodedParams = ethers.AbiCoder.defaultAbiCoder().encode(paramTypes, [arbitrageParams]);
            logger.debug('[Executor] Callback parameters encoded.');
        } catch (encodeError) {
            throw new ArbitrageError(`Failed to encode arbitrage parameters: ${encodeError.message}`, 'ENCODING_ERROR', { originalError: encodeError });
        }

        // 4. Determine amount0/amount1 for flash call
        let amount0ToBorrow = 0n;
        let amount1ToBorrow = 0n;
        // Need token0/token1 of the START pool
        // Reuse contract instance creation logic or get from scanner if passed through
        const startPoolContract = manager._getPoolContract ? manager._getPoolContract(startPoolInfo.address) // Prefer manager's cache if exists
                               : new ethers.Contract(startPoolInfo.address, ABIS.UniswapV3Pool, provider);
        let startPoolToken0Addr, startPoolToken1Addr;
         try {
              [startPoolToken0Addr, startPoolToken1Addr] = await Promise.all([
                  startPoolContract.token0(),
                  startPoolContract.token1()
              ]);
         } catch (tokenFetchError) {
             throw new ArbitrageError(`Error fetching token0/1 from start pool ${startPoolInfo.address}: ${tokenFetchError.message}`, 'RPC_ERROR', { originalError: tokenFetchError });
         }

        if (ethers.getAddress(sdkTokenBorrowed.address) === ethers.getAddress(startPoolToken0Addr)) { amount0ToBorrow = borrowAmount; }
        else if (ethers.getAddress(sdkTokenBorrowed.address) === ethers.getAddress(startPoolToken1Addr)) { amount1ToBorrow = borrowAmount; }
        else { throw new ArbitrageError(`Borrowed token address mismatch for start pool ${startPoolInfo.address}.`, 'INTERNAL_ERROR'); }
        logger.debug(`[Executor] Determined Borrow Amounts: amount0=${amount0ToBorrow}, amount1=${amount1ToBorrow}`);


        // 5. Prepare arguments for the initiateFlashSwap call
        const initiateFlashSwapArgs = [
            startPoolInfo.address, // Pool to borrow from
            amount0ToBorrow,
            amount1ToBorrow,
            encodedParams
        ];

        // 6. Final Simulation (estimateGas)
        let estimatedGasLimit;
        try {
             logger.log('[Executor] Performing final gas estimation...');
             estimatedGasLimit = await flashSwapContract.initiateFlashSwap.estimateGas(
                 ...initiateFlashSwapArgs,
                 { from: signer.address } // Simulate from our signer's address
             );
             logger.log(`[Executor] Final Gas Estimate: ${estimatedGasLimit.toString()}`);
        } catch (gasEstimateError) {
            // Attempt to decode revert reason from estimateGas failure
             handleError(gasEstimateError, `TxExecutor EstimateGas`);
             let reason = gasEstimateError.message;
             if (gasEstimateError.data && gasEstimateError.data !== '0x') {
                  try {
                      const decodedError = flashSwapContract.interface.parseError(gasEstimateError.data);
                      reason = `${decodedError?.name}(${decodedError?.args})` || reason;
                  } catch (decodeErr) {}
             }
             throw new ArbitrageError(`Gas estimation failed: ${reason}`, 'GAS_ESTIMATION_ERROR', { originalError: gasEstimateError });
        }

        // Add buffer to gas limit
        const gasLimitWithBuffer = (estimatedGasLimit * 120n) / 100n; // 20% buffer
        logger.debug(`[Executor] Gas Limit with Buffer: ${gasLimitWithBuffer.toString()}`);

        // 7. Get Gas Fees and Nonce
        const gasParams = await getSimpleGasParams(provider); // Get latest fees
        if (!gasParams) {
             throw new ArbitrageError('Failed to get current gas parameters for execution.', 'GAS_PRICE_ERROR');
        }
        const nonce = await manager.getNextNonce(); // Get nonce from manager
        logger.debug(`[Executor] Using Nonce: ${nonce}`);
        logger.debug(`[Executor] Using Gas Fees: maxFeePerGas=${ethers.formatUnits(gasParams.maxFeePerGas, 'gwei')} Gwei, maxPriorityFeePerGas=${ethers.formatUnits(gasParams.maxPriorityFeePerGas, 'gwei')} Gwei`);


        // 8. Construct Transaction Overrides
        const txOverrides = {
            gasLimit: gasLimitWithBuffer,
            maxFeePerGas: gasParams.maxFeePerGas,
            maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas,
            nonce: nonce,
        };

        // =============================================================
        // 9. EXECUTE TRANSACTION (COMMENTED OUT FOR SAFETY)
        // =============================================================
        logger.warn(">>> !!! TRANSACTION EXECUTION IS DISABLED IN txExecutor.js !!! <<<");
        logger.warn(">>> !!! UNCOMMENT THE FOLLOWING BLOCK TO ENABLE LIVE TRADES !!! <<<");
        let txResponse = null; // Initialize as null
        /*
        try {
            logger.log(">>> SENDING TRANSACTION... <<<");
            txResponse = await flashSwapContract.initiateFlashSwap(
                ...initiateFlashSwapArgs,
                txOverrides
            );
            logger.log(`>>> TRANSACTION SENT! HASH: ${txResponse.hash}`);
            // Optional: Wait for receipt here or handle asynchronously elsewhere
            // logger.log(">>> Waiting for receipt...");
            // const receipt = await txResponse.wait(1); // Wait for 1 confirmation
            // logger.log(`>>> TRANSACTION CONFIRMED! Block: ${receipt.blockNumber}, Gas Used: ${receipt.gasUsed.toString()}`);
             return { success: true, txHash: txResponse.hash, error: null };

        } catch (executionError) {
            handleError(executionError, 'TxExecutor SendTransaction');
            // Consider if nonce needs resetting/resyncing on certain errors
            if (executionError.code === 'NONCE_EXPIRED' || executionError.code === 'REPLACEMENT_UNDERPRICED') {
                 await manager.nonceManager?.resyncNonce(); // Attempt to resync
            }
            throw new ArbitrageError(`Transaction execution failed: ${executionError.message}`, 'EXECUTION_ERROR', { originalError: executionError });
        }
        */
       // Remove this return line when enabling execution
       return { success: true, txHash: 'EXECUTION_DISABLED', error: null };
       // =============================================================

    } catch (error) {
        // Catch errors from steps 1-7 or re-thrown errors from step 9
        if (!(error instanceof ArbitrageError)) { // Wrap unexpected errors
             handleError(error, 'TxExecutor Unexpected');
             return { success: false, txHash: null, error: new ArbitrageError(`Unexpected Executor error: ${error.message}`, 'UNKNOWN_EXECUTION_ERROR', { originalError: error }) };
        } else {
            // Log ArbitrageErrors originating from this module or caught from helpers
             handleError(error, 'TxExecutor');
             return { success: false, txHash: null, error: error };
        }
    }
}

module.exports = { executeTransaction };
