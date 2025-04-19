// core/tx/encoder.js
const { ethers } = require('ethers');
const logger = require('../../utils/logger'); // Adjust path
const { ArbitrageError } = require('../../utils/errorHandler'); // Adjust path

/**
 * Encodes parameters using ethers AbiCoder.
 * @param {object} params The JavaScript object representing the parameters.
 * @param {string} typeString The ABI type string for the structure (e.g., "tuple(...)").
 * @returns {string} The ABI-encoded data string.
 */
function encodeParams(params, typeString) {
    const functionSig = `[Encoder]`;
    logger.debug(`${functionSig} Encoding parameters with type: ${typeString}`);
    if (!params || !typeString) {
        throw new ArbitrageError('Missing params or typeString for encoding.', 'ENCODING_ERROR');
    }
    try {
        // IMPORTANT: encode expects arrays for types and values
        const encodedData = ethers.AbiCoder.defaultAbiCoder().encode([typeString], [params]);
        logger.debug(`${functionSig} Parameters encoded successfully.`);
        return encodedData;
    } catch (encodeError) {
        logger.error(`${functionSig} Failed to encode parameters: ${encodeError.message}`, { params, typeString });
        throw new ArbitrageError(`Failed to encode parameters: ${encodeError.message}`, 'ENCODING_ERROR', { originalError: encodeError, params: params, typeString: typeString });
    }
}

module.exports = {
    encodeParams,
};
