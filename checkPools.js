// checkPools.js
const { ethers } = require("ethers");

// Function to calculate Create2 address (simplified, ensure imports work or use ethers v6 method if available)
// Using ethers v6 computeAddress directly is simpler if applicable
async function getPoolAddress(factory, tokenA, tokenB, fee, initCodeHash) {
    const [token0, token1] = tokenA.toLowerCase() < tokenB.toLowerCase()
        ? [tokenA, tokenB]
        : [tokenB, tokenA];

    const salt = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'address', 'uint24'],
        [token0, token1, fee]
    ));

    // ethers.getCreate2Address requires the bytecode hash (initCodeHash)
    return ethers.getCreate2Address(factory, salt, initCodeHash);
}


// --- Constants ---
const FACTORY_ADDRESS = "0x1F98431c8aD98523631AE4a59f267346ea31F984"; // UniswapV3Factory (Same across chains)
// Arbitrum V3 Pool Init Code Hash (Verify this is correct for Arbitrum deployment)
// Common value is: 0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54
// Let's double-check from Uniswap docs/resources if issues arise. For now, assume it's standard.
const V3_INIT_CODE_HASH = "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";

const WETH_ADDRESS = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"; // WETH
const USDC_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"; // Native USDC

// --- Fees to Check ---
const FEE_001 = 100;    // 0.01%
const FEE_005 = 500;    // 0.05%
const FEE_030 = 3000;   // 0.30%

// --- Calculate and Log ---
async function checkAddresses() {
    console.log("Calculating expected Uniswap V3 Pool Addresses for WETH/USDC on Arbitrum:");
    console.log("Factory:", FACTORY_ADDRESS);
    console.log("Init Code Hash:", V3_INIT_CODE_HASH);
    console.log("---");

    try {
        const addr_001 = await getPoolAddress(FACTORY_ADDRESS, WETH_ADDRESS, USDC_ADDRESS, FEE_001, V3_INIT_CODE_HASH);
        console.log(`Fee ${FEE_001} bps (0.01%): Calculated = ${addr_001}`);
        console.log(`                     (Current Config Pool A = 0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443)`); // From your last config

        const addr_005 = await getPoolAddress(FACTORY_ADDRESS, WETH_ADDRESS, USDC_ADDRESS, FEE_005, V3_INIT_CODE_HASH);
        console.log(`Fee ${FEE_005} bps (0.05%): Calculated = ${addr_005}`);
        // Add your config address for 0.05% if you have it handy or check config.js

        const addr_030 = await getPoolAddress(FACTORY_ADDRESS, WETH_ADDRESS, USDC_ADDRESS, FEE_030, V3_INIT_CODE_HASH);
        console.log(`Fee ${FEE_030} bps (0.30%): Calculated = ${addr_030}`);
         console.log(`                     (Current Config Pool B = 0x17c14D2c404D167802b16C450d3c99F88F2c4F4d)`); // From your last config

    } catch (error) {
        console.error("Error calculating pool addresses:", error);
    }
}

checkAddresses();
