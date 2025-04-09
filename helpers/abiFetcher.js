// helpers/abiFetcher.js
const axios = require("axios");
const fs = require('fs').promises; // Use promise-based fs
const path = require('path');
const config = require('../config'); // Adjust path as needed

const CACHE_DIR = path.join(__dirname, '..', 'abi-cache'); // Cache dir relative to project root

// Ensure cache directory exists
async function ensureCacheDir() {
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
        // console.log(`[ABI Cache] Cache directory ensured at: ${CACHE_DIR}`);
    } catch (error) {
        console.error(`[ABI Cache] Error creating cache directory: ${CACHE_DIR}`, error);
        // Decide if you want to throw or just warn
        // throw error;
    }
}

async function fetchABIWithCache(contractAddress) {
    await ensureCacheDir(); // Make sure dir exists before read/write
    const cacheFilePath = path.join(CACHE_DIR, `${contractAddress}.json`);

    // 1. Try reading from cache
    try {
        const cachedAbiStr = await fs.readFile(cacheFilePath, 'utf8');
        const parsedAbi = JSON.parse(cachedAbiStr);
        console.log(`[ABI Fetch] Loaded ABI for ${contractAddress} from cache.`);
        return parsedAbi;
    } catch (error) {
        // Ignore file not found errors, log others
        if (error.code !== 'ENOENT') {
            console.warn(`[ABI Fetch] Error reading cache for ${contractAddress}: ${error.message}. Will attempt fetch.`);
        } else {
             console.log(`[ABI Fetch] No cache found for ${contractAddress}. Fetching from Arbiscan...`);
        }
    }

    // 2. Fetch from Arbiscan if cache miss or error
    if (!config.ARBISCAN_API_KEY) {
        throw new Error("[ABI Fetch] ARBISCAN_API_KEY not found in config.");
    }
    const url = `https://api.arbiscan.io/api?module=contract&action=getabi&address=${contractAddress}&apikey=${config.ARBISCAN_API_KEY}`;
    let responseDataResult = null;

    try {
        const response = await axios.get(url);
        responseDataResult = response.data.result;

        if (response.data.status !== "1") {
            console.error(`[ABI Fetch] Arbiscan API Error for ${contractAddress}: Status=${response.data.status}, Message=${response.data.message}, Result=${response.data.result}`);
            throw new Error(`Arbiscan API Error: ${response.data.message} - ${response.data.result}`);
        }

        if (!responseDataResult || typeof responseDataResult !== 'string' || responseDataResult.startsWith('Contract source code not verified')) {
             console.error(`[ABI Fetch] Arbiscan returned status 1 but result is not a valid ABI string for ${contractAddress}. Result:`, responseDataResult);
             throw new Error(`Arbiscan returned invalid ABI data for ${contractAddress}. Is it verified?`);
        }

        // 3. Save to cache if fetched successfully
        try {
            await fs.writeFile(cacheFilePath, responseDataResult, 'utf8');
            console.log(`[ABI Fetch] Successfully fetched and cached ABI for ${contractAddress}.`);
        } catch (writeError) {
            console.warn(`[ABI Fetch] Failed to write ABI cache for ${contractAddress}: ${writeError.message}`);
            // Continue without cache saving, but we still have the ABI string
        }

        // 4. Parse and return the fetched ABI
        const parsedABI = JSON.parse(responseDataResult);
        return parsedABI;

    } catch (err) {
         console.error(`[ABI Fetch] CRITICAL: Failed to get ABI for ${contractAddress}.`);
         if (err instanceof SyntaxError) console.error(`[ABI Fetch] JSON Parsing Error: ${err.message}. Raw Result: ${responseDataResult}`);
         else if (axios.isAxiosError(err)) console.error(`[ABI Fetch] Axios Error: ${err.message}`, err.response?.data);
         else console.error(`[ABI Fetch] Error: ${err.message}`, err.stack);
         throw new Error(`Failed to get valid ABI for ${contractAddress}. Check logs.`);
    }
}

module.exports = { fetchABIWithCache };
