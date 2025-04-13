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

  const res = await fetch(GRAPH_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  const data = await res.json();
  return data.data.pools || [];
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
  const token0 = await promptInput("Enter token0 address (e.g., WETH): ");
  const token1 = await promptInput("Enter token1 address (e.g., USDC): ");

  console.log(`\nSearching for pools between:\n - token0: ${token0}\n - token1: ${token1}\n`);

  const pools = await fetchPools(token0, token1);

  if (pools.length === 0) {
    console.log("No matching pools found.");
    return;
  }

  console.log("Found pools:\n");
  pools.forEach(pool => {
    console.log(`Pool Address: ${pool.id}`);
    console.log(`Fee Tier: ${Number(pool.feeTier) / 10000}%`);
    console.log(`Liquidity: ${pool.liquidity}`);
    console.log(`Pair: ${pool.token0.symbol}/${pool.token1.symbol}`);
    console.log("-".repeat(40));
  });
})();
