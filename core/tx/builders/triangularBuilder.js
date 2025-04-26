// core/tx/builders/triangularBuilder.js
// --- VERSION v1.2 --- Removes pool addresses to match Solidity struct v3.6+.

const { ethers } = require('ethers');
const logger = require('../../../utils/logger'); // Adjust path back to utils
const { ArbitrageError } = require('../../../utils/errorHandler'); // Adjust path back to utils
// Assume calculateMinAmountOut is now in profitCalcUtils
const { calculateMinAmountOut } = require('../../profitCalcUtils'); // Adjust path as needed

/**
 * Builds parameters for the initiateTriangularFlashSwap function.
 * Matches the TriangularPathParams struct in FlashSwap.sol v3.6+ (no pool addresses).
 */
function buildTriangularParams(opportunity, simulationResult, config) {
    const functionSig = `[Builder Triangular v1.2]`; // Updated version
    logger.debug(`${functionSig} Building parameters...`);

    // Validation (remains unchanged)
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

     // Validate essential pool info needed for params (fees still needed)
     if (poolAB?.fee === undefined || poolBC?.fee === undefined || poolCA?.fee === undefined) {
         throw new ArbitrageError('Missing required fee in triangular opportunity pools.', 'PARAM_BUILD_ERROR');
     }
     // Remove address checks as they are no longer part of the params struct
     // if (!poolAB?.address || !poolBC?.address || !poolCA?.address) { ... }

    // Determine borrow details (remains unchanged)
    const borrowTokenAddress = tokenA.address;
    const borrowAmount = simulationResult.initialAmount;

    // Calculate final minimum amount out (remains unchanged)
    const finalAmountSimulated = simulationResult.finalAmount;
    const minAmountOutFinal = calculateMinAmountOut(finalAmountSimulated, config.SLIPPAGE_TOLERANCE_BPS);
    logger.debug(`${functionSig} Slippage: ${config.SLIPPAGE_TOLERANCE_BPS}bps, FinalSim: ${ethers.formatUnits(finalAmountSimulated, tokenA.decimals)}, MinOut: ${ethers.formatUnits(minAmountOutFinal, tokenA.decimals)}`);
    if (minAmountOutFinal <= 0n) {
        throw new ArbitrageError('Calculated zero minimum final amount out.', 'SLIPPAGE_ERROR');
    }

    // --- Prepare parameters object - REMOVED pool addresses ---
    const params = {
        // pool1: poolAB.address, // REMOVED
        // pool2: poolBC.address, // REMOVED
        // pool3: poolCA.address, // REMOVED
        tokenA: tokenA.address,
        tokenB: tokenB.address,
        tokenC: tokenC.address,
        fee1: Number(poolAB.fee), // V3 fee tier (or relevant fee)
        fee2: Number(poolBC.fee),
        fee3: Number(poolCA.fee),
        amountOutMinimumFinal: minAmountOutFinal // Slippage adjusted min amount back
    };
    // --- ---

    // Define the struct type string - REMOVED pool addresses
    const typeString = "tuple(address tokenA, address tokenB, address tokenC, uint24 fee1, uint24 fee2, uint24 fee3, uint256 amountOutMinimumFinal)";
    const contractFunctionName = 'initiateTriangularFlashSwap'; // Assuming this remains the target function

    logger.debug(`${functionSig} Parameters built successfully.`);
    return { params, borrowTokenAddress, borrowAmount, typeString, contractFunctionName };
}

module.exports = {
    buildTriangularParams,
};
