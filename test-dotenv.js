// test-dotenv.js
console.log('Attempting to load .env file...');
try {
    const result = require('dotenv').config();

    if (result.error) {
        console.error('dotenv Error:', result.error);
    } else {
        console.log('dotenv loaded successfully. Parsed content:', result.parsed); // Shows what it actually parsed
    }

    console.log('\n--- Checking process.env ---');
    console.log('NETWORK:', process.env.NETWORK);
    console.log('ARBITRUM_RPC_URLS:', process.env.ARBITRUM_RPC_URLS);
    console.log('FLASH_SWAP_ADDRESS:', process.env.FLASH_SWAP_ADDRESS);
    console.log('PRIVATE_KEY exists?:', process.env.PRIVATE_KEY !== undefined);
    console.log('PRIVATE_KEY length:', process.env.PRIVATE_KEY?.length);
    console.log('WETH_USDC_POOLS exists?:', process.env.WETH_USDC_POOLS !== undefined);
    console.log('--------------------------');

} catch (e) {
    console.error('CRITICAL ERROR during dotenv loading:', e);
}
