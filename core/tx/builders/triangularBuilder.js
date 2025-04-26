// core/tx/builders/triangularBuilder.js
// Builder for initiateTriangularFlashSwap function params.

const { ethers } = require('ethers');
const logger = require('../../../utils/logger'); // Adjust path back to utils
const { ArbitrageError } = require('../../../utils/errorHandler'); // Adjust path back to utils
const { calculateMinAmountOut } = require('../txUtils'); // Import shared helper

/**
 * Builds parameters for the initiateTriangularFlashSwap function.
 * STRUCTURE UPDATED TO MATCH FlashSwap.sol v3.0+
 */
function buildTriangularParams(opportunity, simulationResult, config) {
    const functionSig = `[Builder Triangular]`; // Shortened prefix
    logger.debug(`${functionSig} Building parameters...`);

    // Validation ... (as before)
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

    if (!poolAB?.address || !poolBC?.address || !poolCA?.address || poolAB.fee === undefined || poolBC.fee === undefined || poolCA.fee === undefined) {
        throw new ArbitrageError('Missing required pool address or fee in triangular opportunity pools.', 'PARAM_BUILD_ERROR');
    }

    const borrowTokenAddress = tokenA.address;
    const borrowAmount = simulationResult.initialAmount;
    const finalAmountSimulated = simulationResult.finalAmount;
    const minAmountOutFinal = calculateMinAmountOut(finalAmountSimulated, config.SLIPPAGE_TOLERANCE_BPS);

    logger.debug(`${functionSig} Slippage: ${config.SLIPPAGE_TOLERANCE_BPS}bps, FinalSim: ${ethers.formatUnits(finalAmountSimulated, tokenA.decimals)}, MinOut: ${ethers.formatUnits(minAmountOutFinal, tokenA.decimals)}`);

    if (minAmountOutFinal <= 0n) {
        throw new ArbitrageError('Calculated zero minimum final amount out.', 'SLIPPAGE_ERROR');
    }

    const params = {
        pool1: poolAB.address, pool2: poolBC.address, pool3: poolCA.address,
        tokenA: tokenA.address, tokenB: tokenB.address, tokenC: tokenC.address,
        fee1: Number(poolAB.fee), fee2: Number(poolBC.fee), fee3: Number(poolCA.fee),
        amountOutMinimumFinal: minAmountOutFinal
    };
    const typeString = "tuple(address pool1, address pool2, address pool3, address tokenA, address tokenB, address tokenC, uint24 fee1, uint24 fee2, uint24 fee3, uint256 amountOutMinimumFinal)";
    const contractFunctionName = 'initiateTriangularFlashSwap';

    logger.debug(`${functionSig} Parameters built successfully.`);
    return { params, borrowTokenAddress, borrowAmount, typeString, contractFunctionName };
}

module.exports = {
    buildTriangularParams,
};
