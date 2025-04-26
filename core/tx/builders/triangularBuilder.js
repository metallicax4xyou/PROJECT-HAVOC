// core/tx/builders/triangularBuilder.js
// --- VERSION v1.1 --- Correctly adds pool addresses to params.

const { ethers } = require('ethers');
const logger = require('../../../utils/logger'); // Adjust path back to utils
const { ArbitrageError } = require('../../../utils/errorHandler'); // Adjust path back to utils
const { calculateMinAmountOut } = require('../txUtils'); // Import shared helper

/**
 * Builds parameters for the initiateTriangularFlashSwap function.
 * STRUCTURE UPDATED TO MATCH FlashSwap.sol v3.0+ (TriangularPathParams struct)
 */
function buildTriangularParams(opportunity, simulationResult, config) {
    const functionSig = `[Builder Triangular v1.1]`; // Shortened prefix, added version
    logger.debug(`${functionSig} Building parameters...`);

    // Validation
    if (!opportunity || opportunity.type !== 'triangular' || !opportunity.pools || opportunity.pools.length !== 3 || !opportunity.pathSymbols || opportunity.pathSymbols.length !== 4 || !opportunity.tokenA || !opportunity.tokenB || !opportunity.tokenC) {
        throw new ArbitrageError('Invalid triangular opportunity structure.', 'PARAM_BUILD_ERROR');
    }
    if (simulationResult.initialAmount == null || typeof simulationResult.initialAmount !== 'bigint' || simulationResult.finalAmount == null || typeof simulationResult.finalAmount !== 'bigint') {
        throw new ArbitrageError('Invalid simulationResult amounts.', 'PARAM_BUILD_ERROR');
    }

    const [poolAB, poolBC, poolCA] = opportunity.pools;
    const tokenA = opportunity.tokenA;
    const tokenB = opportunity.tokenB;
    const tokenC = opportunity.tokenC;

     // Validate essential pool info needed for params
     if (!poolAB?.address || !poolBC?.address || !poolCA?.address || poolAB.fee === undefined || poolBC.fee === undefined || poolCA.fee === undefined) {
         throw new ArbitrageError('Missing required pool address or fee in triangular opportunity pools.', 'PARAM_BUILD_ERROR');
     }

    // Determine borrow details (assume borrow TokenA)
    const borrowTokenAddress = tokenA.address;
    const borrowAmount = simulationResult.initialAmount;

    // Calculate final minimum amount out using slippage
    const finalAmountSimulated = simulationResult.finalAmount;
    const minAmountOutFinal = calculateMinAmountOut(finalAmountSimulated, config.SLIPPAGE_TOLERANCE_BPS);

    logger.debug(`${functionSig} Slippage: ${config.SLIPPAGE_TOLERANCE_BPS}bps, FinalSim: ${ethers.formatUnits(finalAmountSimulated, tokenA.decimals)}, MinOut: ${ethers.formatUnits(minAmountOutFinal, tokenA.decimals)}`);

    if (minAmountOutFinal <= 0n) {
        throw new ArbitrageError('Calculated zero minimum final amount out.', 'SLIPPAGE_ERROR');
    }

    // --- Prepare parameters object - Now includes pool addresses ---
    const params = {
        pool1: poolAB.address, // Pool A->B address
        pool2: poolBC.address, // Pool B->C address
        pool3: poolCA.address, // Pool C->A address
        tokenA: tokenA.address,
        tokenB: tokenB.address,
        tokenC: tokenC.address,
        fee1: Number(poolAB.fee), // V3 fee tier (or relevant fee)
        fee2: Number(poolBC.fee),
        fee3: Number(poolCA.fee),
        amountOutMinimumFinal: minAmountOutFinal // Slippage adjusted min amount back
    };
    // --- ---

    // Define the struct type string for encoding - Correctly includes pool addresses
    const typeString = "tuple(address pool1, address pool2, address pool3, address tokenA, address tokenB, address tokenC, uint24 fee1, uint24 fee2, uint24 fee3, uint256 amountOutMinimumFinal)";
    const contractFunctionName = 'initiateTriangularFlashSwap';

    logger.debug(`${functionSig} Parameters built successfully.`);
    return { params, borrowTokenAddress, borrowAmount, typeString, contractFunctionName };
}

module.exports = {
    buildTriangularParams,
};
