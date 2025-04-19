// core/tx/paramBuilder.js
const { ethers } = require('ethers');
const logger = require('../../utils/logger'); // Adjust path
const { ArbitrageError } = require('../../utils/errorHandler'); // Adjust path
// No direct config needed here if passed in, but needed for TOKENS lookup

// Helper function to calculate minimum amount out based on slippage
function calculateMinAmountOut(amountOut, slippageToleranceBps) {
    if (amountOut == null || amountOut <= 0n || slippageToleranceBps < 0) { // Use == null to check for undefined/null
        logger.warn(`[calculateMinAmountOut] Invalid input: amountOut=${amountOut}, slippage=${slippageToleranceBps}. Returning 0n.`);
        return 0n;
    }
    const BPS_DIVISOR = 10000n; // Basis points divisor
    const slippageFactor = BPS_DIVISOR - BigInt(slippageToleranceBps);
    // Calculate min amount: amountOut * (1 - slippage)
    // minAmount = (amountOut * (10000 - slippageBps)) / 10000
    return (amountOut * slippageFactor) / BPS_DIVISOR;
}

/**
 * Builds parameters for the initiateTriangularFlashSwap function.
 * @param {object} opportunity The triangular opportunity object.
 * @param {object} simulationResult Result from QuoteSimulator ({ initialAmount, finalAmount }).
 * @param {object} config The application config object (needed for TOKENS, SLIPPAGE).
 * @returns {{ params: object, borrowTokenAddress: string, borrowAmount: bigint, typeString: string, contractFunctionName: string }}
 */
function buildTriangularParams(opportunity, simulationResult, config) {
    const functionSig = `[ParamBuilder Triangular, Group: ${opportunity?.groupName}]`;
    logger.debug(`${functionSig} Building parameters...`);

    // Validate triangular opportunity structure
    if (!opportunity.pools || opportunity.pools.length !== 3 || !opportunity.pathSymbols || opportunity.pathSymbols.length !== 4) {
        throw new ArbitrageError('Invalid triangular opportunity structure for param building.', 'PARAM_BUILD_ERROR', { opportunity });
    }
    if (simulationResult.initialAmount == null || simulationResult.finalAmount == null) {
        throw new ArbitrageError('Invalid simulationResult for param building (missing amounts).', 'PARAM_BUILD_ERROR', { simulationResult });
    }

    const [poolAB, poolBC, poolCA] = opportunity.pools;
    const [tokenASymbol, tokenBSymbol, tokenCSymbol] = opportunity.pathSymbols.slice(0, 3); // Need A, B, C

    // Find the SDK Token objects from config using symbols
    const tokenA = config.TOKENS[tokenASymbol];
    const tokenB = config.TOKENS[tokenBSymbol];
    const tokenC = config.TOKENS[tokenCSymbol];
    if (!tokenA || !tokenB || !tokenC) {
        throw new ArbitrageError(`Could not find SDK Token instance for symbols: ${tokenASymbol}, ${tokenBSymbol}, ${tokenCSymbol}`, 'CONFIG_ERROR', { opportunity });
    }

    // Determine borrow details (assume borrow TokenA from poolAB)
    const borrowTokenAddress = tokenA.address;
    const borrowAmount = simulationResult.initialAmount;

    // Calculate final minimum amount out using slippage
    const finalAmountSimulated = simulationResult.finalAmount; // Amount of TokenA expected back
    const minAmountOutFinal = calculateMinAmountOut(finalAmountSimulated, config.SLIPPAGE_TOLERANCE_BPS);
    logger.debug(`${functionSig} Slippage Tolerance: ${config.SLIPPAGE_TOLERANCE_BPS} bps`);
    logger.debug(`${functionSig} Final Amount Simulated (${tokenASymbol}): ${ethers.formatUnits(finalAmountSimulated, tokenA.decimals)}`);
    logger.debug(`${functionSig} Min Amount Out Final (${tokenASymbol}): ${ethers.formatUnits(minAmountOutFinal, tokenA.decimals)}`);

    if (minAmountOutFinal <= 0n) {
        throw new ArbitrageError('Calculated zero minimum final amount out, aborting parameter build.', 'SLIPPAGE_ERROR', { finalAmountSimulated, minAmountOutFinal });
    }

    // Prepare parameters object matching the Solidity struct
    const params = {
        pool1: poolAB.address,
        pool2: poolBC.address,
        pool3: poolCA.address,
        tokenA: tokenA.address,
        tokenB: tokenB.address,
        tokenC: tokenC.address,
        fee1: poolAB.fee,
        fee2: poolBC.fee,
        fee3: poolCA.fee,
        amountOutMinimumFinal: minAmountOutFinal
    };

    // Define the struct type string for encoding
    const typeString = "tuple(address pool1, address pool2, address pool3, address tokenA, address tokenB, address tokenC, uint24 fee1, uint24 fee2, uint24 fee3, uint256 amountOutMinimumFinal)";
    const contractFunctionName = 'initiateTriangularFlashSwap';

    logger.debug(`${functionSig} Parameters built successfully.`);
    return { params, borrowTokenAddress, borrowAmount, typeString, contractFunctionName };
}


/**
 * Builds parameters for the initiateFlashSwap (two-hop) function.
 * !!! Placeholder implementation !!!
 * @param {object} opportunity The two-hop/cyclic opportunity object.
 * @param {object} simulationResult Result from QuoteSimulator.
 * @param {object} config The application config object.
 * @returns {{ params: object, borrowTokenAddress: string, borrowAmount: bigint, typeString: string, contractFunctionName: string }}
 */
 function buildTwoHopParams(opportunity, simulationResult, config) {
    const functionSig = `[ParamBuilder TwoHop, Group: ${opportunity?.groupName}]`;
    logger.warn(`${functionSig} Building parameters using PLACEHOLDER logic.`);

    // --- !!! Placeholder: Needs implementation based on actual 2-hop opportunity structure !!! ---
    // Example structure needed: opportunity.token0, opportunity.token1, opportunity.borrowAmount,
    // opportunity.poolHop1, opportunity.poolHop2, simulationResult.trade1, simulationResult.trade2

    // Example validation (replace with actual checks)
    if (!opportunity || !simulationResult || !config) {
        throw new ArbitrageError('Missing inputs for placeholder two-hop param build.', 'PARAM_BUILD_ERROR');
    }
    // Assuming opportunity structure like triangular for now, which is WRONG
    if (!opportunity.pools || opportunity.pools.length < 2 || !opportunity.pathSymbols || opportunity.pathSymbols.length < 3) {
         throw new ArbitrageError('Invalid placeholder two-hop opportunity structure.', 'PARAM_BUILD_ERROR', { opportunity });
    }
    if (simulationResult.initialAmount == null /*|| simulationResult.intermediateAmount == null || simulationResult.finalAmount == null */) { // Need intermediate amount from sim
         throw new ArbitrageError('Invalid simulationResult for placeholder two-hop param build.', 'PARAM_BUILD_ERROR', { simulationResult });
    }


    // Example Token/Pool lookup (replace with actual logic)
    const poolA = opportunity.pools[0];
    const poolB = opportunity.pools[1];
    const tokenBorrowedSymbol = opportunity.pathSymbols[0];
    const tokenIntermediateSymbol = opportunity.pathSymbols[1];
    const tokenBorrowed = config.TOKENS[tokenBorrowedSymbol];
    const tokenIntermediate = config.TOKENS[tokenIntermediateSymbol];

    if (!tokenBorrowed || !tokenIntermediate || !poolA || !poolB) {
        throw new ArbitrageError(`Placeholder: Could not find tokens/pools for two-hop.`, 'CONFIG_ERROR', { opportunity });
    }


    // Determine borrow details (replace with actual logic)
    const borrowTokenAddress = tokenBorrowed.address;
    const borrowAmount = simulationResult.initialAmount;

    // Calculate min amounts out for BOTH swaps (replace with actual logic using simulationResult.trade1/trade2 if available)
    // Using finalAmount from sim as a dummy value for both minimums - THIS IS WRONG
    const minAmountOut1 = calculateMinAmountOut(simulationResult.finalAmount || 0n, config.SLIPPAGE_TOLERANCE_BPS);
    const minAmountOut2 = calculateMinAmountOut(simulationResult.finalAmount || 0n, config.SLIPPAGE_TOLERANCE_BPS);

    if (minAmountOut1 <= 0n || minAmountOut2 <= 0n) {
         throw new ArbitrageError('Placeholder: Calculated zero minimum amount out (2-hop), aborting.', 'SLIPPAGE_ERROR');
    }

    // Prepare parameters object matching the TwoHopParams struct (replace with actual struct)
    const params = {
        tokenIntermediate: tokenIntermediate.address,
        poolA: poolA.address,
        feeA: poolA.fee,
        poolB: poolB.address,
        feeB: poolB.fee,
        amountOutMinimum1: minAmountOut1,
        amountOutMinimum2: minAmountOut2
    };

    // Define the struct type string for encoding (replace with actual struct)
    const typeString = "tuple(address tokenIntermediate, address poolA, uint24 feeA, address poolB, uint24 feeB, uint256 amountOutMinimum1, uint256 amountOutMinimum2)";
    const contractFunctionName = 'initiateFlashSwap'; // Original function for 2-hop

    logger.warn(`${functionSig} Placeholder parameters built.`);
    return { params, borrowTokenAddress, borrowAmount, typeString, contractFunctionName };
}


module.exports = {
    buildTriangularParams,
    buildTwoHopParams,
    // Not exporting calculateMinAmountOut as it's internal to the builders now
};
