const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const readline = require("readline");

// Uniswap V3 Subgraph for Polygon
const GRAPH_API = "https://api.thegraph.com/subgraphs/name/ianlapham/uniswap-v3-polygon";

async function fetchPools(token0, token1) {
  const query = `
  {
    pools(where: {
      token0: "${token0.toLowerCase()}",
      token1: "${token1.toLowerCase()}"
    }) {
      id
      feeTier
      liquidity
      token0 { symbol }
      token1 { symbol }
    }
  }
  `;

  try { // Add try...catch for network errors
    const res = await fetch(GRAPH_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });

    const responseBody = await res.json(); // Get the full response body

    // --- DEBUGGING ---
    // Check if the expected data structure exists
    if (responseBody && responseBody.data && responseBody.data.pools) {
      // Expected structure found, return pools
      return responseBody.data.pools || [];
    } else {
      // Data structure missing, log the entire response (could be an error)
      console.error("Error: Unexpected response structure from The Graph API.");
      console.error("API Response Body:", JSON.stringify(responseBody, null, 2)); // Log the raw response
      return []; // Return empty array on error
    }
    // --- END DEBUGGING ---

  } catch (error) {
    console.error("Error fetching data from The Graph API:", error);
    return []; // Return empty array on fetch error
  }
}

function promptInput(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(query, answer => {
    rl.close();
    resolve(answer.trim());
  }));
}

(async () => {
  console.log("=== Uniswap V3 Pool Finder (Polygon) ===");
  const token0Addr = await promptInput("Enter token0 address (e.g., WETH): ");
  const token1Addr = await promptInput("Enter token1 address (e.g., USDC): ");

  // Basic validation (optional but good)
  if (!token0Addr.startsWith('0x') || !token1Addr.startsWith('0x')) {
      console.error("Invalid address format. Please enter addresses starting with '0x'.");
      return;
  }

  console.log(`\nSearching for pools between:\n - token0: ${token0Addr}\n - token1: ${token1Addr}\n`);

  const pools = await fetchPools(token0Addr, token1Addr);

  if (pools.length === 0) {
    // Check if the error was logged inside fetchPools
    if (!console.error.called) { // Simple check, assumes no other console.error was called
         console.log("No matching pools found or API error occurred (check logs above).");
    }
    return;
  }

  console.log("Found pools:\n");
  pools.forEach(pool => {
    console.log(`Pool Address: ${pool.id}`);
    console.log(`Fee Tier: ${Number(pool.feeTier) / 10000}%`); // Fee tier is in ppm (parts per million), divide by 10000 for %
    console.log(`Liquidity: ${pool.liquidity}`);
    // Check if token symbols exist before accessing
    const token0Symbol = pool.token0 && pool.token0.symbol ? pool.token0.symbol : 'Unknown';
    const token1Symbol = pool.token1 && pool.token1.symbol ? pool.token1.symbol : 'Unknown';
    console.log(`Pair: ${token0Symbol}/${token1Symbol}`);
    console.log("-".repeat(40));
  });
})();

// Track if console.error was called (simple mechanism)
const originalConsoleError = console.error;
console.error.called = false;
console.error = (...args) => {
    console.error.called = true;
    originalConsoleError(...args);
};
