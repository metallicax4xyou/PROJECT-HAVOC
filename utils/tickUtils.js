// utils/tickUtils.js

/**
 * Calculates the Uniswap V3 tick bitmap word index for a given tick and spacing.
 * @param {number} tick The tick index.
 * @param {number} tickSpacing The tick spacing of the pool.
 * @returns {number | null} The word index, or null if inputs are invalid.
 */
function tickToWord(tick, tickSpacing) {
    // Basic input validation
    if (typeof tick !== 'number' || typeof tickSpacing !== 'number' || !Number.isInteger(tickSpacing) || tickSpacing <= 0) {
        console.error(`[tickUtils] Invalid input to tickToWord: tick=${tick}, tickSpacing=${tickSpacing}`);
        return null; // Or throw an error
    }
    // Calculate the compressed tick index
    const compressed = Math.floor(tick / tickSpacing);
    // Calculate the word index (each word stores 256 compressed ticks)
    // Right shift by 8 is equivalent to floor(x / 256) for non-negative integers
    // return compressed >> 8;
    // Using Math.floor for potentially better clarity/safety across environments
    return Math.floor(compressed / 256);
}

module.exports = {
    tickToWord,
};
