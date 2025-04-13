const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const readline = require("readline");

// --- UPDATED Uniswap V3 Subgraph for Polygon (Messari) ---
const GRAPH_API = "https://api.thegraph.com/subgraphs/name/messari/uniswap-v3-polygon";
// --- Explicitly log the endpoint being used ---
console.log(`[Debug] Using Graph API Endpoint: ${GRAPH_API}`);
// --- END UPDATE ---

async function fetchPools(token0, token1) {
  // Ensure addresses are lowercase for consistent matching in subgraph
  const token0Lower = token0.toLowerCase();
  const token1Lower = token1.toLowerCase();

  // Query pools where the pair matches in either order
  const query = `
  {
    pools(where: { or: [
        { token0: "${token0Lower}", token1: "${token1Lower}" },
        { token0: "${token1Lower}", token1: "${token0Lower}" }
      ]}) {
      id # Pool address
      feeTier
      liquidity
      sqrtPrice  # Current price state
      token0 { id symbol decimals }
      token1 { id symbol decimals }
      totalValueLockedUSD # TVL can indicate pool significance
    }
  }
  `;

  try { // Add try...catch for network errors
    console.log(`[Debug] Sending query to ${GRAPH_API}...`); // Log before fetch
    const res = await fetch(GRAPH_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    console.log(`[Debug] Received response status: ${res.status}`); // Log response status

    const responseBody = await res.json(); // Get the full response body

    // Check if the expected data structure exists
    if (responseBody && responseBody.data && responseBody.data.pools) {
      console.log("[Debug] API response contains expected data structure."); // Log success
      // Expected structure found, return pools
      return responseBody.data.pools || [];
    } else {
      // Data structure missing, log the entire response (could be an error)
      console.error("Error: Unexpected response structure from The Graph API.");
      console.error("API Response Body:", JSON.stringify(responseBody, null, 2)); // Log the raw response
      return []; // Return empty array on error
    }

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
  pools.sort((a, b) => Number(a.feeTier) - Number(b.feeTier)); // Sort by fee tier

  pools.forEach(pool => {
    console.log(`Pool Address: ${pool.id}`);
    console.log(`Fee Tier: ${Number(pool.feeTier) / 10000}% (${pool.feeTier} ppm)`); // Fee tier is in ppm
    console.log(`Liquidity: ${pool.liquidity}`);
    console.log(`TVL (USD): ${pool.totalValueLockedUSD ? parseFloat(pool.totalValueLockedUSD).toFixed(2) : 'N/A'}`);
    // Check if token symbols exist before accessing
    const token0Symbol = pool.token0 && pool.token0.symbol ? pool.token0.symbol : pool.token0.id; // Fallback to ID
    const token1Symbol = pool.token1 && pool.token1.symbol ? pool.token1.symbol : pool.token1.id; // Fallback to ID
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
