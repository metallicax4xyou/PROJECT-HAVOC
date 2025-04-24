// core/tx/paramBuilder.js
// --- VERSION v2.0 ---
// Fixes buildTwoHopParams, Adds buildV3SushiParams, buildSushiV3Params
// Aligns parameter structs with updated FlashSwap.sol (v3.0+)

const { ethers } = require('ethers');
const logger = require('../../utils/logger'); // Adjust path
const { ArbitrageError } = require('../../utils/errorHandler'); // Adjust path
const { TOKENS } = require('../../constants/tokens'); // Import TOKENS for config lookup

// Helper function to calculate minimum amount out based on slippage
function calculateMinAmountOut(amountOut, slippageToleranceBps) {
    if (amountOut == null || typeof amountOut !== 'bigint' || amountOut <= 0n || slippageToleranceBps < 0) {
        logger.warn(`[calculateMinAmountOut] Invalid input: amountOut=${amountOut} (type: ${typeof amountOut}), slippage=${slippageToleranceBps}. Returning 0n.`);
        return 0n;
    }
    const BPS_DIVISOR = 10000n;
    const slippageFactor = BPS_DIVISOR - BigInt(slippageToleranceBps);
    if (slippageFactor < 0) { // Avoid negative factor
        logger.warn(`[calculateMinAmountOut] Slippage tolerance ${slippageToleranceBps} > 10000 BPS. Returning 0n.`);
        return 0n;
    }
    return (amountOut * slippageFactor) / BPS_DIVISOR;
}

/**
 * Builds parameters for the initiateTriangularFlashSwap function.
 * TODO: Update params structure to match updated FlashSwap.sol (remove pool addresses)
 * @param {object} opportunity The triangular opportunity object.
 * @param {object} simulationResult Result from SwapSimulator ({ initialAmount, finalAmount }).
 * @param {object} config The application config object (needed for SLIPPAGE).
 * @returns {{ params: object, borrowTokenAddress: string, borrowAmount: bigint, typeString: string, contractFunctionName: string }}
 */
function buildTriangularParams(opportunity, simulationResult, config) {
    const functionSig = `[ParamBuilder Triangular]`; // Removed group name as it's often null
    logger.debug(`${functionSig} Building parameters...`);

    // Basic validation
    if (!opportunity || typeof opportunity !== 'object' || !simulationResult || typeof simulationResult !== 'object' || !config || typeof config !== 'object') {
         throw new ArbitrageError('Missing or invalid inputs for Triangular param build.', 'PARAM_BUILD_ERROR');
    }
    // Validate triangular opportunity structure
    // Assuming opportunity structure includes: type='triangular', pools=[p1,p2,p3], pathSymbols=[A,B,C,A], tokenA, tokenB, tokenC
    if (opportunity.type !== 'triangular' || !opportunity.pools || opportunity.pools.length !== 3 || !opportunity.pathSymbols || opportunity.pathSymbols.length !== 4 || !opportunity.tokenA || !opportunity.tokenB || !opportunity.tokenC) {
        throw new ArbitrageError('Invalid triangular opportunity structure for param building.', 'PARAM_BUILD_ERROR', { opportunity });
    }
    // Validate simulation result
    if (simulationResult.initialAmount == null || typeof simulationResult.initialAmount !== 'bigint' || simulationResult.finalAmount == null || typeof simulationResult.finalAmount !== 'bigint') {
        throw new ArbitrageError('Invalid simulationResult for param building (missing or invalid amounts).', 'PARAM_BUILD_ERROR', { simulationResult });
    }

    const [poolAB, poolBC, poolCA] = opportunity.pools;
    const tokenA = opportunity.tokenA; // Assuming these are SDK Token objects attached to the opportunity
    const tokenB = opportunity.tokenB;
    const tokenC = opportunity.tokenC;

    // Determine borrow details (assume borrow TokenA)
    const borrowTokenAddress = tokenA.address;
    const borrowAmount = simulationResult.initialAmount;

    // Calculate final minimum amount out using slippage
    const finalAmountSimulated = simulationResult.finalAmount; // Amount of TokenA expected back
    const minAmountOutFinal = calculateMinAmountOut(finalAmountSimulated, config.SLIPPAGE_TOLERANCE_BPS);
    logger.debug(`${functionSig} Slippage Tolerance: ${config.SLIPPAGE_TOLERANCE_BPS} bps`);
    logger.debug(`${functionSig} Final Amount Simulated (${tokenA.symbol}): ${ethers.formatUnits(finalAmountSimulated, tokenA.decimals)}`);
    logger.debug(`${functionSig} Min Amount Out Final (${tokenA.symbol}): ${ethers.formatUnits(minAmountOutFinal, tokenA.decimals)}`);

    if (minAmountOutFinal <= 0n) {
        logger.error(`${functionSig} Calculated zero minimum final amount out.`, { finalAmountSimulated, minAmountOutFinal });
        throw new ArbitrageError('Calculated zero minimum final amount out, aborting parameter build.', 'SLIPPAGE_ERROR', { finalAmountSimulated, minAmountOutFinal });
    }

    // Prepare parameters object matching the Solidity struct
    // !!! TODO: Update this struct definition and typeString if FlashSwap.sol changes TriangularPathParams !!!
    const params = {
        // pool1: poolAB.address, // Likely removed from updated contract struct
        // pool2: poolBC.address, // Likely removed from updated contract struct
        // pool3: poolCA.address, // Likely removed from updated contract struct
        tokenA: tokenA.address,
        tokenB: tokenB.address,
        tokenC: tokenC.address,
        fee1: poolAB.fee,
        fee2: poolBC.fee,
        fee3: poolCA.fee,
        amountOutMinimumFinal: minAmountOutFinal
    };

    // !!! TODO: Update this typeString if FlashSwap.sol changes TriangularPathParams !!!
    const typeString = "tuple(address tokenA, address tokenB, address tokenC, uint24 fee1, uint24 fee2, uint24 fee3, uint256 amountOutMinimumFinal)";
    const contractFunctionName = 'initiateTriangularFlashSwap';

    logger.debug(`${functionSig} Parameters built successfully.`);
    return { params, borrowTokenAddress, borrowAmount, typeString, contractFunctionName };
}


/**
 * Builds parameters for the initiateFlashSwap (V3 -> V3 two-hop) function.
 * @param {object} opportunity The spatial opportunity object from spatialFinder.
 * @param {object} simulationResult Result from SwapSimulator ({ initialAmount, hop1AmountOut, finalAmount }).
 * @param {object} config The application config object (needed for SLIPPAGE).
 * @returns {{ params: object, borrowTokenAddress: string, borrowAmount: bigint, typeString: string, contractFunctionName: string }}
 */
function buildTwoHopParams(opportunity, simulationResult, config) {
    const functionSig = `[ParamBuilder TwoHop (V3->V3)]`;
    logger.debug(`${functionSig} Building parameters...`);

    // Validation
    if (!opportunity || opportunity.type !== 'spatial' || !opportunity.path || opportunity.path.length !== 2) {
        throw new ArbitrageError('Invalid spatial opportunity for V3->V3 param build.', 'PARAM_BUILD_ERROR', { opportunity });
    }
    if (opportunity.path[0].dex !== 'uniswapV3' || opportunity.path[1].dex !== 'uniswapV3') {
        throw new ArbitrageError('Opportunity path is not V3->V3.', 'PARAM_BUILD_ERROR', { path: opportunity.path.map(p => p.dex) });
    }
    if (!simulationResult || typeof simulationResult.initialAmount !== 'bigint' || typeof simulationResult.hop1AmountOut !== 'bigint' || typeof simulationResult.finalAmount !== 'bigint') {
        throw new ArbitrageError('Invalid simulationResult for V3->V3 param build.', 'PARAM_BUILD_ERROR', { simulationResult });
    }
    if (!opportunity.tokenIn || !opportunity.tokenIntermediate) {
         throw new ArbitrageError('Missing tokenIn or tokenIntermediate in V3->V3 opportunity.', 'PARAM_BUILD_ERROR', { opportunity });
    }

    const leg1 = opportunity.path[0];
    const leg2 = opportunity.path[1];

    // Extract necessary info
    const tokenBorrowed = opportunity.tokenIn; // This is an SDK Token object
    const tokenIntermediate = opportunity.tokenIntermediate; // This is an SDK Token object
    const feeA = Number(leg1.fee); // V3 Fee for Hop 1
    const feeB = Number(leg2.fee); // V3 Fee for Hop 2

    if (isNaN(feeA) || isNaN(feeB) || feeA < 0 || feeB < 0 || feeA > 1000000 || feeB > 1000000) { // Sanity check fee values
        throw new ArbitrageError(`Invalid V3 fees found: feeA=${feeA}, feeB=${feeB}`, 'CONFIG_ERROR', { opportunity });
    }

    // Amounts from simulation
    const borrowAmount = simulationResult.initialAmount;
    const hop1AmountOutSimulated = simulationResult.hop1AmountOut;
    const hop2AmountOutSimulated = simulationResult.finalAmount;

    // Calculate minimum amounts out using slippage
    const minAmountOut1 = calculateMinAmountOut(hop1AmountOutSimulated, config.SLIPPAGE_TOLERANCE_BPS);
    const minAmountOut2 = calculateMinAmountOut(hop2AmountOutSimulated, config.SLIPPAGE_TOLERANCE_BPS);

    logger.debug(`${functionSig} Hop1: Sim Out=${ethers.formatUnits(hop1AmountOutSimulated, tokenIntermediate.decimals)}, Min Out=${ethers.formatUnits(minAmountOut1, tokenIntermediate.decimals)} (${tokenIntermediate.symbol})`);
    logger.debug(`${functionSig} Hop2: Sim Out=${ethers.formatUnits(hop2AmountOutSimulated, tokenBorrowed.decimals)}, Min Out=${ethers.formatUnits(minAmountOut2, tokenBorrowed.decimals)} (${tokenBorrowed.symbol})`);

    if (minAmountOut1 <= 0n || minAmountOut2 <= 0n) {
        logger.error(`${functionSig} Calculated zero minimum amount out.`, { minAmountOut1, minAmountOut2 });
        throw new ArbitrageError('Calculated zero minimum amount out (V3->V3), aborting.', 'SLIPPAGE_ERROR', { minAmountOut1, minAmountOut2 });
    }

    // Prepare parameters object matching the Solidity struct `TwoHopParams`
    const params = {
        tokenIntermediate: tokenIntermediate.address,
        feeA: feeA,
        feeB: feeB,
        amountOutMinimum1: minAmountOut1,
        amountOutMinimum2: minAmountOut2
    };

    // Define the struct type string for encoding
    const typeString = "tuple(address tokenIntermediate, uint24 feeA, uint24 feeB, uint256 amountOutMinimum1, uint256 amountOutMinimum2)";
    const contractFunctionName = 'initiateFlashSwap'; // Function for V3->V3

    logger.debug(`${functionSig} Parameters built successfully.`);
    return { params, borrowTokenAddress: tokenBorrowed.address, borrowAmount, typeString, contractFunctionName };
}


/**
 * Builds parameters for the initiateV3SushiFlashSwap function.
 * @param {object} opportunity The spatial opportunity object (V3 -> Sushi).
 * @param {object} simulationResult Result from SwapSimulator ({ initialAmount, hop1AmountOut, finalAmount }).
 * @param {object} config The application config object (needed for SLIPPAGE).
 * @returns {{ params: object, borrowTokenAddress: string, borrowAmount: bigint, typeString: string, contractFunctionName: string }}
 */
function buildV3SushiParams(opportunity, simulationResult, config) {
    const functionSig = `[ParamBuilder V3->Sushi]`;
    logger.debug(`${functionSig} Building parameters...`);

     // Validation
    if (!opportunity || opportunity.type !== 'spatial' || !opportunity.path || opportunity.path.length !== 2) {
        throw new ArbitrageError('Invalid spatial opportunity for V3->Sushi param build.', 'PARAM_BUILD_ERROR', { opportunity });
    }
    if (opportunity.path[0].dex !== 'uniswapV3' || opportunity.path[1].dex !== 'sushiswap') {
        throw new ArbitrageError('Opportunity path is not V3->Sushi.', 'PARAM_BUILD_ERROR', { path: opportunity.path.map(p => p.dex) });
    }
    if (!simulationResult || typeof simulationResult.initialAmount !== 'bigint' || typeof simulationResult.hop1AmountOut !== 'bigint' || typeof simulationResult.finalAmount !== 'bigint') {
        throw new ArbitrageError('Invalid simulationResult for V3->Sushi param build.', 'PARAM_BUILD_ERROR', { simulationResult });
    }
     if (!opportunity.tokenIn || !opportunity.tokenIntermediate) {
         throw new ArbitrageError('Missing tokenIn or tokenIntermediate in V3->Sushi opportunity.', 'PARAM_BUILD_ERROR', { opportunity });
    }

    const leg1 = opportunity.path[0]; // V3 Leg
    // const leg2 = opportunity.path[1]; // Sushi Leg (don't need fee from here for MixedPathParams)

    // Extract necessary info
    const tokenBorrowed = opportunity.tokenIn; // SDK Token object
    const tokenIntermediate = opportunity.tokenIntermediate; // SDK Token object
    const feeHop1 = Number(leg1.fee); // V3 Fee for Hop 1
    const feeHop2 = 0; // Sushi fee is not part of MixedPathParams, set to 0

     if (isNaN(feeHop1) || feeHop1 < 0 || feeHop1 > 1000000) {
        throw new ArbitrageError(`Invalid V3 fee found: feeHop1=${feeHop1}`, 'CONFIG_ERROR', { opportunity });
    }

    // Amounts from simulation
    const borrowAmount = simulationResult.initialAmount;
    const hop1AmountOutSimulated = simulationResult.hop1AmountOut;
    const hop2AmountOutSimulated = simulationResult.finalAmount;

    // Calculate minimum amounts out using slippage
    const minAmountOut1 = calculateMinAmountOut(hop1AmountOutSimulated, config.SLIPPAGE_TOLERANCE_BPS);
    const minAmountOut2 = calculateMinAmountOut(hop2AmountOutSimulated, config.SLIPPAGE_TOLERANCE_BPS);

    logger.debug(`${functionSig} Hop1 (V3): Sim Out=${ethers.formatUnits(hop1AmountOutSimulated, tokenIntermediate.decimals)}, Min Out=${ethers.formatUnits(minAmountOut1, tokenIntermediate.decimals)} (${tokenIntermediate.symbol})`);
    logger.debug(`${functionSig} Hop2 (Sushi): Sim Out=${ethers.formatUnits(hop2AmountOutSimulated, tokenBorrowed.decimals)}, Min Out=${ethers.formatUnits(minAmountOut2, tokenBorrowed.decimals)} (${tokenBorrowed.symbol})`);

    if (minAmountOut1 <= 0n || minAmountOut2 <= 0n) {
         logger.error(`${functionSig} Calculated zero minimum amount out.`, { minAmountOut1, minAmountOut2 });
        throw new ArbitrageError('Calculated zero minimum amount out (V3->Sushi), aborting.', 'SLIPPAGE_ERROR', { minAmountOut1, minAmountOut2 });
    }

    // Prepare parameters object matching the Solidity struct `MixedPathParams`
    const params = {
        tokenIntermediate: tokenIntermediate.address,
        feeHop1: feeHop1,
        amountOutMinimum1: minAmountOut1,
        feeHop2: feeHop2, // Set to 0 as placeholder
        amountOutMinimum2: minAmountOut2
    };

    // Define the struct type string for encoding
    const typeString = "tuple(address tokenIntermediate, uint24 feeHop1, uint256 amountOutMinimum1, uint24 feeHop2, uint256 amountOutMinimum2)";
    const contractFunctionName = 'initiateV3SushiFlashSwap'; // Specific function for V3->Sushi

    logger.debug(`${functionSig} Parameters built successfully.`);
    return { params, borrowTokenAddress: tokenBorrowed.address, borrowAmount, typeString, contractFunctionName };
}


/**
 * Builds parameters for the initiateSushiV3FlashSwap function.
 * @param {object} opportunity The spatial opportunity object (Sushi -> V3).
 * @param {object} simulationResult Result from SwapSimulator ({ initialAmount, hop1AmountOut, finalAmount }).
 * @param {object} config The application config object (needed for SLIPPAGE).
 * @returns {{ params: object, borrowTokenAddress: string, borrowAmount: bigint, typeString: string, contractFunctionName: string }}
 */
function buildSushiV3Params(opportunity, simulationResult, config) {
    const functionSig = `[ParamBuilder Sushi->V3]`;
    logger.debug(`${functionSig} Building parameters...`);

     // Validation
    if (!opportunity || opportunity.type !== 'spatial' || !opportunity.path || opportunity.path.length !== 2) {
        throw new ArbitrageError('Invalid spatial opportunity for Sushi->V3 param build.', 'PARAM_BUILD_ERROR', { opportunity });
    }
    if (opportunity.path[0].dex !== 'sushiswap' || opportunity.path[1].dex !== 'uniswapV3') {
        throw new ArbitrageError('Opportunity path is not Sushi->V3.', 'PARAM_BUILD_ERROR', { path: opportunity.path.map(p => p.dex) });
    }
     if (!simulationResult || typeof simulationResult.initialAmount !== 'bigint' || typeof simulationResult.hop1AmountOut !== 'bigint' || typeof simulationResult.finalAmount !== 'bigint') {
        throw new ArbitrageError('Invalid simulationResult for Sushi->V3 param build.', 'PARAM_BUILD_ERROR', { simulationResult });
    }
      if (!opportunity.tokenIn || !opportunity.tokenIntermediate) {
         throw new ArbitrageError('Missing tokenIn or tokenIntermediate in Sushi->V3 opportunity.', 'PARAM_BUILD_ERROR', { opportunity });
    }

    // const leg1 = opportunity.path[0]; // Sushi Leg (don't need fee)
    const leg2 = opportunity.path[1]; // V3 Leg

    // Extract necessary info
    const tokenBorrowed = opportunity.tokenIn; // SDK Token object
    const tokenIntermediate = opportunity.tokenIntermediate; // SDK Token object
    const feeHop1 = 0; // Sushi fee is not part of MixedPathParams, set to 0
    const feeHop2 = Number(leg2.fee); // V3 Fee for Hop 2

    if (isNaN(feeHop2) || feeHop2 < 0 || feeHop2 > 1000000) {
        throw new ArbitrageError(`Invalid V3 fee found: feeHop2=${feeHop2}`, 'CONFIG_ERROR', { opportunity });
    }

    // Amounts from simulation
    const borrowAmount = simulationResult.initialAmount;
    const hop1AmountOutSimulated = simulationResult.hop1AmountOut;
    const hop2AmountOutSimulated = simulationResult.finalAmount;

    // Calculate minimum amounts out using slippage
    const minAmountOut1 = calculateMinAmountOut(hop1AmountOutSimulated, config.SLIPPAGE_TOLERANCE_BPS);
    const minAmountOut2 = calculateMinAmountOut(hop2AmountOutSimulated, config.SLIPPAGE_TOLERANCE_BPS);

    logger.debug(`${functionSig} Hop1 (Sushi): Sim Out=${ethers.formatUnits(hop1AmountOutSimulated, tokenIntermediate.decimals)}, Min Out=${ethers.formatUnits(minAmountOut1, tokenIntermediate.decimals)} (${tokenIntermediate.symbol})`);
    logger.debug(`${functionSig} Hop2 (V3): Sim Out=${ethers.formatUnits(hop2AmountOutSimulated, tokenBorrowed.decimals)}, Min Out=${ethers.formatUnits(minAmountOut2, tokenBorrowed.decimals)} (${tokenBorrowed.symbol})`);

    if (minAmountOut1 <= 0n || minAmountOut2 <= 0n) {
        logger.error(`${functionSig} Calculated zero minimum amount out.`, { minAmountOut1, minAmountOut2 });
        throw new ArbitrageError('Calculated zero minimum amount out (Sushi->V3), aborting.', 'SLIPPAGE_ERROR', { minAmountOut1, minAmountOut2 });
    }

    // Prepare parameters object matching the Solidity struct `MixedPathParams`
    const params = {
        tokenIntermediate: tokenIntermediate.address,
        feeHop1: feeHop1, // Set to 0 as placeholder
        amountOutMinimum1: minAmountOut1,
        feeHop2: feeHop2,
        amountOutMinimum2: minAmountOut2
    };

    // Define the struct type string for encoding
    const typeString = "tuple(address tokenIntermediate, uint24 feeHop1, uint256 amountOutMinimum1, uint24 feeHop2, uint256 amountOutMinimum2)";
    const contractFunctionName = 'initiateSushiV3FlashSwap'; // Specific function for Sushi->V3

    logger.debug(`${functionSig} Parameters built successfully.`);
    return { params, borrowTokenAddress: tokenBorrowed.address, borrowAmount, typeString, contractFunctionName };
}


module.exports = {
    buildTriangularParams,
    buildTwoHopParams, // Now builds V3->V3 correctly
    buildV3SushiParams, // New builder for V3->Sushi
    buildSushiV3Params  // New builder for Sushi->V3
};
