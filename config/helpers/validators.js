// config/helpers/validators.js
const { ethers } = require('ethers');
let logger; try { logger = require('../../utils/logger'); } catch(e) { console.error("No logger for validators"); logger = console; } // Adjusted path

function validateAndNormalizeAddress(rawAddress, contextName) {
    const addressString = String(rawAddress || '').trim();
    if (!addressString) { return null; }
    try {
        const cleanAddress = addressString.replace(/^['"]+|['"]+$/g, '');
        if (!ethers.isAddress(cleanAddress)) {
            logger.warn(`[Config Validate] ${contextName}: Invalid address format "${cleanAddress}".`);
            return null;
        }
        return ethers.getAddress(cleanAddress);
    } catch (error) {
        logger.warn(`[Config Validate] ${contextName}: Validation error for "${rawAddress}" - ${error.message}`);
        return null;
    }
}

function validatePrivateKey(rawKey, contextName) {
    const keyString = String(rawKey||'').trim().replace(/^0x/,'');
    const valid = /^[a-fA-F0-9]{64}$/.test(keyString);
    if(!valid) logger.error(`[Config Validate PK] Invalid PK for ${contextName}, length ${keyString.length}`);
    return valid ? keyString : null;
}

function validateRpcUrls(rawUrls, contextName) {
    logger.debug(`[ValidateRPC INNER] Received rawUrls for ${contextName}: "${rawUrls}"`);
    const urlsString = String(rawUrls || '').trim();
    if (!urlsString) { logger.error(`[Config Validate] CRITICAL ${contextName}: RPC URL(s) string is empty.`); return null; }
    const urls = urlsString.split(',')
        .map(url => url.trim())
        .filter(url => {
            if (!url) return false;
            const isValidFormat = /^(https?|wss?):\/\/.+/i.test(url);
            if (!isValidFormat) { logger.warn(`[Config Validate] ${contextName}: Invalid URL format skipped: "${url}"`); return false; }
            return true;
        });
    logger.debug(`[ValidateRPC INNER] Filtered URLs count: ${urls.length}`);
    if (urls.length === 0) { logger.error(`[Config Validate] CRITICAL ${contextName}: No valid RPC URLs found.`); return null; }
    logger.debug(`[ValidateRPC INNER] Validation successful for ${contextName}.`);
    return urls;
}

function safeParseBigInt(valueStr, contextName, defaultValue = 0n) {
    try {
        const s = String(valueStr || '').trim();
        if (s.includes('.')) throw new Error("Decimal in BigInt");
        return s ? BigInt(s) : defaultValue;
    } catch (e) {
        logger.warn(`[Config Parse BigInt] ${contextName}: Failed "${valueStr}": ${e.message}`);
        return defaultValue;
    }
}

function safeParseInt(valueStr, contextName, defaultValue = 0) {
    const n = parseInt(String(valueStr || '').trim(), 10);
    if (isNaN(n)) {
        logger.warn(`[Config Parse Int] ${contextName}: Failed "${valueStr}"`);
        return defaultValue;
    }
    return n;
}

function parseBoolean(valueStr) {
    return String(valueStr || '').trim().toLowerCase() !== 'false';
}

module.exports = {
    validateAndNormalizeAddress,
    validatePrivateKey,
    validateRpcUrls,
    safeParseBigInt,
    safeParseInt,
    parseBoolean,
};
