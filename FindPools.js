const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const readline = require("readline");

// --- Use Official Uniswap V3 Cross-Chain Subgraph ---
const GRAPH_API = "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3";
// --- Explicitly log the endpoint being used ---
console.log(`[Debug] Using Graph API Endpoint: ${GRAPH_API}`);

async function fetchPools(token0, token1) {
  // Ensure addresses are lowercase for consistent matching in subgraph
  const token0Lower = token0.toLowerCase();
  const token1Lower = token1.toLowerCase();

  // --- Updated Query for Cross-Chain Subgraph, filtering by network ---
  const query = `
  query GetPolygonPools($token0: String!, $token1: String!) {
    pools(
      first: 10 # Limit results just in case
      orderBy: totalValueLockedUSD
      orderDirection: desc
      where: {
        # Filter by network explicitly
        network: "POLYGON",
        # Match token pairs in either order
        or: [
          { token0: $token0, token1: $token1 },
          { token0: $token1, token1: $token0 }
        ]
      }
    ) {
      id # Pool address
      feeTier
      liquidity
      sqrtPrice # Current price state
      token0 { id symbol decimals }
      token1 { id symbol decimals }
      totalValueLockedUSD # TVL can indicate pool significance
      # Add volumeUSD if needed: volumeUSD
    }
  }
  `;
  // --- End Updated Query ---

  const variables = {
      token0: token0Lower,
      token1: token1Lower
  };

  try {
    console.log(`[Debug] Sending query to ${GRAPH_API} for network POLYGON...`);
    const res = await fetch(GRAPH_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" }, // Added Accept header
      // Send query and variables separately
      body: JSON.stringify({
        query: query,
        variables: variables
       }),
    });
    console.log(`[Debug] Received response status: ${res.status}`);

    const responseBody = await res.json();

    if (responseBody && responseBody.data && responseBody.data.pools) {
      console.log("[Debug] API response contains expected data structure.");
      return responseBody.data.pools || [];
    } else {
      console.error("Error: Unexpected response structure from The Graph API.");
      console.error("API Response Body:", JSON.stringify(responseBody, null, 2));
      return [];
    }

  } catch (error) {
    console.error("Error fetching data from The Graph API:", error);
    return [];
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

  if (!token0Addr.startsWith('0x') || !token1Addr.startsWith('0x')) {
      console.error("Invalid address format. Please enter addresses starting with '0x'.");
      return;
  }

  console.log(`\nSearching for pools between:\n - token0: ${token0Addr}\n - token1: ${token1Addr}\n`);

  const pools = await fetchPools(token0Addr, token1Addr);

  if (pools.length === 0) {
    if (!console.error.called) {
         console.log("No matching pools found or API error occurred (check logs above).");
    }
    return;
  }

  console.log(`Found ${pools.length} pools:\n`);
  pools.sort((a, b) => Number(a.feeTier) - Number(b.feeTier));

  pools.forEach(pool => {
    console.log(`Pool Address: ${pool.id}`);
    console.log(`Fee Tier: ${Number(pool.feeTier) / 10000}% (${pool.feeTier} ppm)`);
    console.log(`Liquidity: ${pool.liquidity}`);
    console.log(`TVL (USD): ${pool.totalValueLockedUSD ? parseFloat(pool.totalValueLockedUSD).toFixed(2) : 'N/A'}`);
    const token0Symbol = pool.token0 && pool.token0.symbol ? pool.token0.symbol : pool.token0.id;
    const token1Symbol = pool.token1 && pool.token1.symbol ? pool.token1.symbol : pool.token1.id;
    console.log(`Pair: ${token0Symbol}/${token1Symbol}`);
    console.log("-".repeat(40));
  });
})();

// Track if console.error was called
const originalConsoleError = console.error;
console.error.called = false;
console.error = (...args) => {
    console.error.called = true;
    originalConsoleError(...args);
};
