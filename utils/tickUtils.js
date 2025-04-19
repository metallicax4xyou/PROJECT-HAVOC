// utils/tickUtils.js
const logger = require('./logger');

/**
 * Calculates the Uniswap V3 tick bitmap word index for a given tick and spacing.
 * Aligns with Solidity's signed integer right shift for word position calculation.
 *
 * @param {number} tick The tick index. Can be negative.
 * @param {number} tickSpacing The tick spacing of the pool (must be positive integer).
 * @returns {number | null} The word index (int16 range), or null if inputs are invalid.
 */
function tickToWord(tick, tickSpacing) {
    if (typeof tick !== 'number' || !Number.isFinite(tick) ||
        typeof tickSpacing !== 'number' || !Number.isInteger(tickSpacing) || tickSpacing <= 0) {
        logger.error(`[tickUtils] Invalid input to tickToWord: tick=${tick}, tickSpacing=${tickSpacing}`);
        return null;
    }

    // Calculate the compressed tick index (integer division)
    // Ensure intermediate result is handled as an integer
    const compressed = Math.floor(tick / tickSpacing);

    // Calculate the word position using signed right bit shift (>>)
    // This mimics Solidity's behavior for int256 >> 8 -> int16 conversion for bitmap index
    // We need to ensure the result fits within int16 range if TickLens expects that.
    // int16 range: -32768 to 32767
    const wordPos = compressed >> 8; // Signed right shift by 8

    // Optional: Check if the result is within the expected int16 range
    const MIN_INT16 = -32768;
    const MAX_INT16 = 32767;
    if (wordPos < MIN_INT16 || wordPos > MAX_INT16) {
         logger.warn(`[tickUtils] Calculated wordPos ${wordPos} is outside int16 range for tick ${tick}, spacing ${tickSpacing}. Might be invalid for TickLens.`);
         // Depending on TickLens behavior, we might return null or clamp the value.
         // Let's return it for now and see if TickLens handles it or reverts.
    }

    // logger.debug(`[tickUtils] tickToWord: tick=${tick}, spacing=${tickSpacing} -> compressed=${compressed} -> wordPos=${wordPos}`);
    return wordPos;
}

module.exports = {
    tickToWord,
};
