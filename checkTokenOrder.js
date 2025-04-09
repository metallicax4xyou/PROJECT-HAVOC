// checkTokenOrder.js
const { ethers } = require("ethers");
const config = require("./config"); // Load RPC_URL and pool addresses

// Minimal Pool ABI with token0() and token1()
const IUniswapV3PoolMinimalABI = [
    "function token0() external view returns (address)",
    "function token1() external view returns (address)"
];

async function checkOrder() {
    if (!config.RPC_URL) {
        console.error("RPC_URL not found in config.js");
        return;
    }
    const provider = new ethers.JsonRpcProvider(config.RPC_URL);

    const poolAAddress = config.POOL_A_ADDRESS; // Correct 0.01%
    const poolBAddress = config.POOL_B_ADDRESS; // Correct 0.30%

    console.log(`Checking token order for pools on Arbitrum...`);
    console.log(`WETH Address: ${config.WETH_ADDRESS}`);
    console.log(`USDC Address: ${config.USDC_ADDRESS}`);
    console.log(`---`);

    try {
        const poolAContract = new ethers.Contract(poolAAddress, IUniswapV3PoolMinimalABI, provider);
        const token0_A = await poolAContract.token0();
        const token1_A = await poolAContract.token1();
        console.log(`Pool A (0.01% - ${poolAAddress}):`);
        console.log(`  token0: ${token0_A} ${token0_A.toLowerCase() === config.USDC_ADDRESS.toLowerCase() ? '(USDC)' : token0_A.toLowerCase() === config.WETH_ADDRESS.toLowerCase() ? '(WETH)' : '(Unknown)'}`);
        console.log(`  token1: ${token1_A} ${token1_A.toLowerCase() === config.USDC_ADDRESS.toLowerCase() ? '(USDC)' : token1_A.toLowerCase() === config.WETH_ADDRESS.toLowerCase() ? '(WETH)' : '(Unknown)'}`);
        console.log(`---`);

        const poolBContract = new ethers.Contract(poolBAddress, IUniswapV3PoolMinimalABI, provider);
        const token0_B = await poolBContract.token0();
        const token1_B = await poolBContract.token1();
        console.log(`Pool B (0.30% - ${poolBAddress}):`);
        console.log(`  token0: ${token0_B} ${token0_B.toLowerCase() === config.USDC_ADDRESS.toLowerCase() ? '(USDC)' : token0_B.toLowerCase() === config.WETH_ADDRESS.toLowerCase() ? '(WETH)' : '(Unknown)'}`);
        console.log(`  token1: ${token1_B} ${token1_B.toLowerCase() === config.USDC_ADDRESS.toLowerCase() ? '(USDC)' : token1_B.toLowerCase() === config.WETH_ADDRESS.toLowerCase() ? '(WETH)' : '(Unknown)'}`);
        console.log(`---`);

    } catch (error) {
        console.error("Error checking token order:", error);
    }
}

checkOrder();
