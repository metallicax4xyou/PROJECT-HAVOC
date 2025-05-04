// core/tx/txParameterPreparer.js
// Handles the logic for preparing the specific function name and arguments
// for the FlashSwap contract based on the profitable trade details.

const { ethers } = require('ethers');
const logger = require('../../utils/logger'); // Needs logger utility
const { ArbitrageError } = require('../../utils/errorHandler'); // Needs error types

// Lazy require TxParamBuilder here to avoid potential circular dependencies
// TxParamBuilder is in the same directory but might pull in other core modules.
const TxParamBuilder = require('./paramBuilder');


/**
 * Prepares the function name and arguments required to call the FlashSwap contract
 * for a given profitable trade opportunity.
 * @param {object} tradeToExecute - The selected profitable trade object from ProfitCalculator.
 *                                Includes path, amountIn, amountOut, estimatedProfitNativeWei, etc.
 * @param {object} config - The application configuration object.
 * @param {FlashSwapManager} flashSwapManager - Instance of FlashSwapManager (needed for signer address).
 * @param {string} titheRecipient - The address for the tithe recipient.
 * @returns {Promise<{contractFunctionName: string, flashLoanArgs: Array<any>, providerType: string, gasLimit: bigint}>} - Object containing prepared execution details.
 * @throws {ArbitrageError | Error} - Throws if parameter preparation fails.
 */
async function prepareExecutionParams(tradeToExecute, config, flashSwapManager, titheRecipient) {
     const logPrefix = '[TxParamPreparer]';
    logger.debug(`${logPrefix} Preparing execution parameters...`);

    let providerType = 'UNKNOWN'; // 'UNIV3' or 'AAVE'
    let contractFunctionName = 'unknownFunction'; // Function to call on FlashSwap.sol
    let gasLimit = 0n; // Gas limit must be determined and returned


    try {
        // --- Validate trade path exists ---
        if (!tradeToExecute.path || !Array.isArray(tradeToExecute.path) || tradeToExecute.path.length === 0) {
             const errorMsg = 'Trade object missing valid path information for parameter preparation.';
             logger.error(`${logPrefix} CRITICAL: ${errorMsg}`);
             throw new ArbitrageError('ParameterPreparationError', errorMsg);
        }

        // --- 1. Determine Flash Loan Provider ---
        if (tradeToExecute.path[0].dex === 'uniswapV3') {
            providerType = 'UNIV3';
            logger.debug(`${logPrefix} First hop is UniV3. Preparing for UniV3 Flash Loan.`);
        } else {
            providerType = 'AAVE';
            logger.debug(`${logPrefix} First hop is ${tradeToExecute.path[0].dex}. Preparing for AAVE Flash Loan.`);
            // Add check if Aave is configured/enabled? (TradeHandler constructor already does this validation)
        }

        // --- 2. Prepare Simulation Data for Builder ---
        // Builders need consistent input regardless of provider
        const simResultForBuilder = {
            initialAmount: BigInt(tradeToExecute.amountIn || 0n), // Borrowed amount
            hop1AmountOut: BigInt(tradeToExecute.intermediateAmountOut || 0n), // Amount after first hop
            finalAmount: BigInt(tradeToExecute.amountOut || 0n), // Amount after final hop
            // Add other fields if needed by other builders (e.g., triangular)
        };
        // initialAmount must be > 0, finalAmount can be 0 or negative in sim but builder might expect positive
        if (simResultForBuilder.initialAmount <= 0n) {
             const errorMsg = `Trade data missing required amountIn field or amountIn is invalid for builder (${simResultForBuilder.initialAmount.toString()}).`;
             logger.error(`${logPrefix} CRITICAL: ${errorMsg}`);
             throw new ArbitrageError('ParameterPreparationError', errorMsg);
        }
         // Check profit calculator results are included
         if (tradeToExecute.gasEstimate?.pathGasLimit === undefined || tradeToExecute.gasEstimate.pathGasLimit === null) {
             const errorMsg = `Trade data missing required gasEstimate.pathGasLimit field from ProfitCalculator.`;
             logger.error(`${logPrefix} CRITICAL: ${errorMsg}`);
             throw new ArbitrageError('ParameterPreparationError', errorMsg);
         }


        let buildResult;
        let flashLoanArgs; // Arguments passed to the actual FlashSwap contract function (initiateAaveFlashLoan or flash)

        // --- 3. Select Builder & Call ---
        if (providerType === 'UNIV3') {
            let builderFunction;
            const dexPath = tradeToExecute.path.map(p => p.dex).join('->');

            // TODO: Refine UniV3 builder selection logic based on trade.type and path
            if (tradeToExecute.type === 'spatial' && dexPath === 'uniswapV3->uniswapV3') {
                 // Assuming two-hop spatial arbitrage uses buildTwoHopParams
                 builderFunction = TxParamBuilder.buildTwoHopParams;
                 contractFunctionName = 'initiateUniswapV3FlashLoan'; // Function name on FlashSwap.sol
            } else if (tradeToExecute.type === 'triangular') { // Assuming triangular always uses UniV3 loan from the first pool
                 builderFunction = TxParamBuilder.buildTriangularParams;
                 contractFunctionName = 'initiateUniswapV3FlashLoan'; // Assuming same function for triangular V3 loan
                 logger.warn(`${logPrefix} Using triangular builder (UniV3 Loan). Ensure paramBuilder TODO is resolved.`);
            } else {
                 const errorMsg = `Unsupported type/path for UniV3 Flash Loan: ${tradeToExecute.type} / ${dexPath}`;
                 logger.warn(`${logPrefix} Skipping parameter preparation: ${errorMsg}`);
                 // Return null/undefined or throw a specific type if this is a non-critical path
                 throw new ArbitrageError('UnsupportedTradeTypeError', errorMsg); // Throw to signal unsupported
            }

            if (!builderFunction || typeof builderFunction !== 'function') {
                const errorMsg = `UniV3 builder function not found for type ${tradeToExecute.type} / path ${dexPath} in TxParamBuilder.`;
                logger.error(`${logPrefix} CRITICAL: ${errorMsg}`);
                throw new ArbitrageError('ParameterPreparationError', errorMsg);
            }
             logger.debug(`${logPrefix} Selected builder: ${builderFunction.name}`);

            // --- Call UniV3 Builder ---
            // Pass the titheRecipient to the builder
            // Assuming buildUniV3Params signature: (opportunity, simResult, config, titheRecipient)
            buildResult = builderFunction(tradeToExecute, simResultForBuilder, config, titheRecipient); // Pass config and titheRecipient

            // --- Validate UniV3 Builder Output ---
            if (!buildResult || buildResult.params === undefined || buildResult.borrowTokenAddress === undefined || buildResult.borrowAmount === undefined || buildResult.typeString === undefined || buildResult.contractFunctionName !== contractFunctionName) {
                 const errorMsg = `UniV3 parameter builder failed to return expected structure or function name (${contractFunctionName}). Received: ${JSON.stringify(buildResult)}`;
                logger.error(`${logPrefix} CRITICAL: ${errorMsg}`);
                throw new ArbitrageError('ParameterPreparationError', errorMsg);
            }

            // --- Encode Parameters Struct ---
            const encodedParamsBytes = ethers.AbiCoder.defaultAbiCoder().encode([buildResult.typeString], [buildResult.params]);
             logger.debug(`${logPrefix} Encoded UniV3 params bytes: ${encodedParamsBytes.slice(0, 100)}...`);


            // --- Determine amount0/amount1 for FlashSwap.sol::flash() or similar UniV3 entry ---
            const borrowPoolState = tradeToExecute.path[0].poolState; // Already checked path[0] exists and is V3 loan
            if (!borrowPoolState || !borrowPoolState.token0?.address || !borrowPoolState.token1?.address) {
                 const errorMsg = "Cannot determine flash loan amounts: Invalid borrow pool state for UniV3 loan.";
                 logger.error(`${logPrefix} CRITICAL: ${errorMsg}`);
                 throw new ArbitrageError('ParameterPreparationError', errorMsg);
            }
            let amount0ToBorrow = 0n; let amount1ToBorrow = 0n;
            const borrowTokenAddrLower = buildResult.borrowTokenAddress.toLowerCase();
            if (borrowTokenAddrLower === borrowPoolState.token0.address.toLowerCase()) amount0ToBorrow = buildResult.borrowAmount;
            else if (borrowTokenAddrLower === borrowPoolState.token1.address.toLowerCase()) amount1ToBorrow = buildResult.borrowAmount;
            else {
                 const errorMsg = `Borrow token ${buildResult.borrowTokenAddress} does not match UniV3 borrow pool tokens ${borrowPoolState.token0.address}/${borrowPoolState.token1.address}.`;
                 logger.error(`${logPrefix} CRITICAL: ${errorMsg}`);
                 throw new ArbitrageError('ParameterPreparationError', errorMsg);
            }
             logger.debug(`${logPrefix} UniV3 Flash Loan Amounts: Amt0=${amount0ToBorrow.toString()}, Amt1=${amount1ToBorrow.toString()}`);


            // --- Prepare Flash Loan Initiation Arguments for FlashSwap.sol ---
             // FlashSwap.sol function signature for UniV3 Loan assumed:
             // function initiateUniswapV3FlashLoan(CallbackType callbackType, address poolAddress, uint256 amount0, uint256 amount1, bytes calldata params)
             let callbackTypeEnum; // Need to map trade type to enum used in CallbackType lib
             // These enum values must match the CallbackType Solidity library used by FlashSwap.sol
             // Example: enum CallbackType { TwoHop, Triangular, ... }
             if (tradeToExecute.type === 'spatial' && dexPath === 'uniswapV3->uniswapV3') callbackTypeEnum = 0; // Assuming 0 for TwoHop
             else if (tradeToExecute.type === 'triangular') callbackTypeEnum = 1; // Assuming 1 for Triangular
             else {
                 const errorMsg = `Cannot map UniV3 trade type ${tradeToExecute.type} / path ${dexPath} to CallbackType enum.`;
                 logger.error(`${logPrefix} CRITICAL: ${errorMsg}`);
                 throw new ArbitrageError('ParameterPreparationError', errorMsg);
             }


             flashLoanArgs = [
                 callbackTypeEnum,        // CallbackType enum (uint8 in Solidity)
                 borrowPoolState.address, // address poolAddress
                 amount0ToBorrow,         // uint256 amount0
                 amount1ToBorrow,         // uint256 amount1
                 encodedParamsBytes       // bytes calldata params (encoded builder struct)
             ];


        } else if (providerType === 'AAVE') {
            // --- Select Aave Builder ---
             if (!TxParamBuilder.buildAavePathParams) { // Check if builder exists and is exported by index
                  const errorMsg = "Aave parameter builder (buildAavePathParams) not found in paramBuilder index.";
                 logger.error(`${logPrefix} CRITICAL: ${errorMsg}`);
                 throw new ArbitrageError('ParameterPreparationError', errorMsg);
             }
             contractFunctionName = 'initiateAaveFlashLoan'; // Function name on FlashSwap.sol

            // --- Call Aave Builder ---
             // buildAavePathParams signature: (opportunity, simResult, config, flashSwapManagerInstance, titheRecipient)
             // Need the signer address for Aave V3 builder (which needs permit info) - flashSwapManager can provide this.
             buildResult = await TxParamBuilder.buildAavePathParams(tradeToExecute, simResultForBuilder, config, flashSwapManager, titheRecipient); // Pass config, FSM, titheRecipient

            // --- Validate Aave Builder Output ---
             if (!buildResult || buildResult.params === undefined || buildResult.borrowTokenAddress === undefined || buildResult.borrowAmount === undefined || buildResult.typeString === undefined || buildResult.contractFunctionName !== contractFunctionName) {
                 const errorMsg = `Aave parameter builder failed to return expected structure or function name (${contractFunctionName}). Received: ${JSON.stringify(buildResult)}`;
                logger.error(`${logPrefix} CRITICAL: ${errorMsg}`);
                throw new ArbitrageError('ParameterPreparationError', errorMsg);
             }

            // --- Encode Parameters Struct (ArbParams) ---
             // ArbParams struct definition (example): struct ArbParams { address recipient; address[] path; uint256[] amounts; ... }
             const encodedArbParamsBytes = ethers.AbiCoder.defaultAbiCoder().encode([buildResult.typeString], [buildResult.params]);
             logger.debug(`${logPrefix} Encoded Aave params bytes: ${encodedArbParamsBytes.slice(0, 100)}...`);

            // --- Prepare Flash Loan Initiation Arguments for FlashSwap.sol ---
             // FlashSwap.sol function signature for Aave Loan assumed:
             // function initiateAaveFlashLoan(address[] assets, uint256[] amounts, bytes params)
             flashLoanArgs = [
                 [buildResult.borrowTokenAddress], // address[] memory assets (array of one asset)
                 [buildResult.borrowAmount],       // uint256[] memory amounts (array of one amount)
                 encodedArbParamsBytes             // bytes memory params (encoded builder struct containing path + titheRecipient)
             ];

        } else {
             // Should not happen if initial check is correct, but safeguard
             const errorMsg = `Unknown providerType determined during parameter preparation: ${providerType}.`;
             logger.error(`${logPrefix} CRITICAL: ${errorMsg}`);
             throw new ArbitrageError('ParameterPreparationError', errorMsg);
        }

         // --- Get Gas Limit from Trade Object ---
         // ProfitCalculator should have added the estimated pathGasLimit to the trade object
         // (within the gasEstimate field).
         if (tradeToExecute.gasEstimate?.pathGasLimit === undefined || tradeToExecute.gasEstimate.pathGasLimit === null) {
              const errorMsg = `Trade object missing gasEstimate.pathGasLimit for execution! Cannot determine gas limit.`;
              logger.error(`${logPrefix} CRITICAL: ${errorMsg}`);
              throw new ArbitrageError('ParameterPreparationError', errorMsg);
         }
         gasLimit = BigInt(tradeToExecute.gasEstimate.pathGasLimit); // Ensure it's BigInt

         if (gasLimit <= 0n) {
             const errorMsg = `Invalid gas limit determined (${gasLimit.toString()}) for execution.`;
             logger.error(`${logPrefix} CRITICAL: ${errorMsg}`);
             throw new ArbitrageError('ParameterPreparationError', errorMsg);
         }
         logger.debug(`${logPrefix} Determined Gas Limit: ${gasLimit.toString()}`);


        logger.debug(`${logPrefix} Parameter preparation successful.`);

        // Return the prepared details needed for executeTransaction
        return {
            contractFunctionName,
            flashLoanArgs,
            providerType, // Also return providerType for logging in TradeHandler
            gasLimit // Return the determined gas limit
        };

    } catch (error) {
         logger.error(`${logPrefix} Failed during parameter preparation: ${error.message}`);
         // Re-throw the error as an ArbitrageError or standard Error
         if (!(error instanceof ArbitrageError)) {
             throw new ArbitrageError('ParameterPreparationError', `Uncaught error during preparation: ${error.message}`, error);
         }
        throw error; // Re-throw existing ArbitrageError
    }
}

// Export the preparation function
module.exports = {
    prepareExecutionParams
};
