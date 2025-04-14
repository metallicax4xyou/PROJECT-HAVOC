// helpers/monitor.js
const { ethers } = require('ethers');
const { CurrencyAmount, TradeType } = require('@uniswap/sdk-core');
const { Pool, Route, Trade } = require('@uniswap/v3-sdk');
const IUniswapV3PoolABI = require('@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json').abi;
const { attemptArbitrage } = require('./arbitrage');

// --- Constants ---
const FETCH_TIMEOUT_MS = 15000; // Shorter timeout for data fetching per cycle
const MAX_UINT128 = (1n << 128n) - 1n; // Used for liquidity check

// --- Helper: Timeout Promise ---
function createTimeout(ms, message = 'Operation timed out') {
    return new Promise((_, reject) =>
        setTimeout(() => reject(new Error(message)), ms)
    );
}

// --- Helper: Calculate Flash Loan Repayment ---
function calculateRepaymentAmount(borrowAmount, flashLoanFeeBps) {
    const fee = (borrowAmount * BigInt(flashLoanFeeBps)) / 10000n; // Basis points calculation
    return borrowAmount + fee;
}

// --- Helper: Estimate Gas Cost ---
function estimateGasCost(feeData, gasLimitEstimate) {
    // Use maxFeePerGas for EIP-1559 transactions if available, else gasPrice
    const effectiveGasPrice = feeData.maxFeePerGas || feeData.gasPrice || 0n;
    if (effectiveGasPrice <= 0n) {
        console.warn("  [Gas] Warning: Could not determine effective gas price from feeData.");
        return 0n; // Return 0 if gas price is unknown/invalid
    }
    return effectiveGasPrice * gasLimitEstimate;
}

// --- Core Simulation Function ---
async function simulateTrade(
    poolForTrade, // Uniswap SDK Pool object for the swap pool
    tokenIn,      // Uniswap SDK Token object for input token
    tokenOut,     // Uniswap SDK Token object for output token
    amountIn      // Amount of tokenIn (as CurrencyAmount)
) {
    try {
        // Create a route using the single pool
        const route = new Route([poolForTrade], tokenIn, tokenOut);
        // Create a trade object for an exact input trade
        const trade = await Trade.fromRoute(route, amountIn, TradeType.EXACT_INPUT);
        return trade;
    } catch (error) {
        // Often catches insufficient liquidity errors from the SDK
        // console.debug(`    [Simulate SDK] SDK Error creating trade (${tokenIn.symbol} -> ${tokenOut.symbol}): ${error.message}`);
        return null; // Return null if trade simulation fails
    }
}

// --- Main Monitoring Function ---
async function monitorPools(state) {
    const { provider, signer, contracts, config, networkName } = state;
    const { quoterContract } = contracts; // Only need quoter for basic checks now, not core sim

    // --- Pre-checks ---
    if (!quoterContract) { console.error(`[Monitor-${networkName}] CRITICAL: Quoter contract instance missing.`); return; }
    if (!config || !config.POOL_GROUPS || Object.keys(config.POOL_GROUPS).length === 0) {
        console.log(`[Monitor-${networkName}] No pool groups configured. Skipping cycle.`); return;
    }

    console.log(`\n[Monitor-${networkName}] ${new Date().toISOString()} - Checking ${Object.keys(config.POOL_GROUPS).length} pool groups...`);
    const cycleStartTime = Date.now();

    // --- Fetch Global Data (Gas Price) ---
    let feeData;
    try {
        feeData = await Promise.race([
            provider.getFeeData(),
            createTimeout(FETCH_TIMEOUT_MS / 3, 'Fee data fetch timeout')
        ]);
        if (feeData instanceof Error) throw feeData;
    } catch (err) {
        console.error(`[Monitor-${networkName}] FAILED Fetch: Fee Data - ${err.message}`);
        return; // Cannot proceed without fee data
    }

    // Calculate estimated gas cost ONCE per cycle
    const estimatedGasCostWei = estimateGasCost(feeData, config.GAS_LIMIT_ESTIMATE);
    if (estimatedGasCostWei <= 0n) {
        console.error(`[Monitor-${networkName}] FAILED: Invalid estimated gas cost. Skipping cycle.`);
        return;
    }
    console.log(`  [Gas] Est. Tx Cost: ~${ethers.formatUnits(estimatedGasCostWei, config.NATIVE_SYMBOL === 'MATIC' ? 18 : 18)} ${config.NATIVE_SYMBOL}`);


    // --- Iterate Through Pool Groups ---
    let bestOpportunityOverall = null;

    for (const groupKey in config.POOL_GROUPS) {
        const group = config.POOL_GROUPS[groupKey];
        const { token0, token1, borrowToken, quoteToken, borrowAmount, minNetProfit, pools: poolInfos } = group; // Destructure group config

        console.log(`\n  --- Group: ${groupKey} (${token0.symbol}/${token1.symbol}) ---`);
        console.log(`      Borrowing ${ethers.formatUnits(borrowAmount, borrowToken.decimals)} ${borrowToken.symbol}`);

        if (!poolInfos || poolInfos.length < 2) {
            console.log(`    Skipping group ${groupKey} - requires at least 2 configured pools.`);
            continue;
        }

        // --- Fetch Live Pool States for this Group ---
        const poolStatePromises = poolInfos.map(poolInfo => {
            const poolContract = new ethers.Contract(poolInfo.address, IUniswapV3PoolABI, provider);
            // Fetch slot0 and liquidity concurrently
            return Promise.allSettled([
                poolContract.slot0(),
                poolContract.liquidity(),
                // Optional: Add poolContract.tickSpacing() if needed, but fee tier usually implies it
            ]).then(results => ({
                poolInfo: poolInfo, // Include original info
                slot0Result: results[0],
                liquidityResult: results[1]
            }));
        });

        let poolStatesRaw;
        try {
            console.log(`    Fetching states for ${poolInfos.length} pools in group ${groupKey}...`);
            poolStatesRaw = await Promise.race([
                Promise.all(poolStatePromises), // Wait for all state fetches for the group
                createTimeout(FETCH_TIMEOUT_MS * 2 / 3, `Pool state fetch timeout for group ${groupKey}`)
            ]);
            if (poolStatesRaw instanceof Error) throw poolStatesRaw;
        } catch (groupFetchError) {
            console.error(`    ❌ FETCH FAILED for group ${groupKey}: ${groupFetchError.message}`);
            continue; // Skip to next group if fetching fails
        }

        // Process fetched states and create SDK Pool objects
        const livePools = {}; // { poolAddress: { sdkPool: Pool, tick: number, ...poolInfo } }
        let validPoolsFound = 0;

        for (const stateResult of poolStatesRaw) {
            const { poolInfo, slot0Result, liquidityResult } = stateResult;
            if (slot0Result.status !== 'fulfilled' || liquidityResult.status !== 'fulfilled') {
                console.warn(`      Pool ${poolInfo.feeBps}bps (${poolInfo.address.substring(0,6)}...) Fetch FAIL: ${slot0Result.reason?.message || liquidityResult.reason?.message || 'Unknown reason'}`);
                continue;
            }

            const slot0 = slot0Result.value;
            const liquidity = liquidityResult.value;

            // Basic validation of fetched data
            if (slot0 == null || typeof slot0.sqrtPriceX96 === 'undefined' || typeof slot0.tick === 'undefined' || liquidity == null || liquidity > MAX_UINT128) {
                 console.warn(`      Pool ${poolInfo.feeBps}bps (${poolInfo.address.substring(0,6)}...) Invalid State Data: SqrtPrice=${slot0?.sqrtPriceX96}, Tick=${slot0?.tick}, Liquidity=${liquidity}`);
                 continue;
            }
            // Optional: Check if liquidity is zero, though SDK might handle this
            if (liquidity === 0n) {
                 console.log(`      Pool ${poolInfo.feeBps}bps (${poolInfo.address.substring(0,6)}...) has zero liquidity.`);
                 continue;
            }

            try {
                const tickCurrent = Number(slot0.tick);
                const sqrtPriceX96 = slot0.sqrtPriceX96;

                // Create Uniswap SDK Pool object
                const sdkPool = new Pool(
                    token0, // Group's token0 (SDK object)
                    token1, // Group's token1 (SDK object)
                    poolInfo.feeBps,
                    sqrtPriceX96.toString(), // Must be string
                    liquidity.toString(),    // Must be string
                    tickCurrent
                );

                livePools[poolInfo.address] = {
                    ...poolInfo, // Keep original address and feeBps
                    sdkPool: sdkPool,
                    tick: tickCurrent,
                    liquidity: liquidity,
                };
                validPoolsFound++;
                console.log(`      Pool ${poolInfo.feeBps}bps (${poolInfo.address.substring(0,6)}...) State OK: Tick=${tickCurrent}, Liq=${liquidity.toString()}`);

            } catch (sdkError) {
                console.error(`      Pool ${poolInfo.feeBps}bps (${poolInfo.address.substring(0,6)}...) SDK Error: ${sdkError.message}`);
            }
        } // End processing fetched states

        if (validPoolsFound < 2) {
            console.log(`    Skipping comparisons for group ${groupKey} - less than 2 valid live pools found.`);
            continue;
        }

        // --- Pairwise Comparison within the Group ---
        const livePoolAddresses = Object.keys(livePools);
        for (let i = 0; i < livePoolAddresses.length; i++) {
            for (let j = i + 1; j < livePoolAddresses.length; j++) {
                const poolAddress1 = livePoolAddresses[i];
                const poolAddress2 = livePoolAddresses[j];
                const livePool1 = livePools[poolAddress1];
                const livePool2 = livePools[poolAddress2];

                const tick1 = livePool1.tick;
                const tick2 = livePool2.tick;
                const tickDelta = Math.abs(tick1 - tick2);
                const TICK_DIFF_THRESHOLD = 1; // Minimum tick difference to consider

                console.log(`      Compare ${livePool1.feeBps}bps(${tick1}) vs ${livePool2.feeBps}bps(${tick2}) | Delta: ${tickDelta}`);

                let startPoolLive = null, swapPoolLive = null; // Live pool objects { sdkPool, tick, feeBps, address }
                let intermediateToken = null; // SDK Token object

                // Determine direction based on price (tick)
                // Price is higher in the pool with the higher tick (for token0 relative to token1)
                // If tick2 > tick1, Pool2 price is higher. Borrow from Pool1 (lower price), swap on Pool2 (higher price).
                if (tick2 > tick1 + TICK_DIFF_THRESHOLD) {
                    startPoolLive = livePool1;
                    swapPoolLive = livePool2;
                } else if (tick1 > tick2 + TICK_DIFF_THRESHOLD) {
                    startPoolLive = livePool2;
                    swapPoolLive = livePool1;
                } else {
                    continue; // Ticks too close, no opportunity
                }

                // Determine the intermediate token (the one NOT being borrowed)
                if (borrowToken.equals(token0)) {
                    intermediateToken = token1;
                } else if (borrowToken.equals(token1)) {
                    intermediateToken = token0;
                } else {
                    console.error(`        Configuration Error: Borrow token ${borrowToken.symbol} is not token0 or token1 of group ${groupKey}.`);
                    continue; // Skip this pair if config is wrong
                }

                console.log(`        Potential: Borrow ${borrowToken.symbol} from ${startPoolLive.feeBps}bps -> Swap on ${swapPoolLive.feeBps}bps`);
                console.log(`        Simulating with ${ethers.formatUnits(borrowAmount, borrowToken.decimals)} ${borrowToken.symbol}...`);

                // --- Accurate Simulation using Uniswap SDK ---
                try {
                    // 1. Calculate Required Repayment
                    const flashFee = (borrowAmount * BigInt(config.FLASH_LOAN_FEE_BPS)) / 10000n;
                    const requiredRepaymentAmount = borrowAmount + flashFee;

                    // 2. Simulate Swap 1: borrowToken -> intermediateToken on swapPoolLive
                    const amountInSwap1 = CurrencyAmount.fromRawAmount(borrowToken, borrowAmount.toString());
                    const trade1 = await simulateTrade(swapPoolLive.sdkPool, borrowToken, intermediateToken, amountInSwap1);

                    if (!trade1) { console.log(`        -> Sim Swap 1 FAIL (likely insufficient liquidity on swap pool ${swapPoolLive.feeBps}bps)`); continue; }
                    const amountOutSwap1 = trade1.outputAmount; // Amount of intermediateToken received
                    console.log(`        Sim Swap 1 OK: ${amountInSwap1.toSignificant(6)} ${borrowToken.symbol} -> ${amountOutSwap1.toSignificant(6)} ${intermediateToken.symbol} (Pool ${swapPoolLive.feeBps}bps)`);

                    // 3. Simulate Swap 2: intermediateToken -> borrowToken on swapPoolLive
                    // Input for Swap 2 is the output amount from Swap 1
                    const amountInSwap2 = amountOutSwap1;
                    const trade2 = await simulateTrade(swapPoolLive.sdkPool, intermediateToken, borrowToken, amountInSwap2);

                    if (!trade2) { console.log(`        -> Sim Swap 2 FAIL (likely insufficient liquidity on swap pool ${swapPoolLive.feeBps}bps)`); continue; }
                    const amountOutSwap2 = trade2.outputAmount; // Final amount of borrowToken received
                    const finalAmountReceived = BigInt(amountOutSwap2.quotient.toString()); // Convert SDK CurrencyAmount back to BigInt

                    console.log(`        Sim Swap 2 OK: ${amountInSwap2.toSignificant(6)} ${intermediateToken.symbol} -> ${amountOutSwap2.toSignificant(6)} ${borrowToken.symbol} (Pool ${swapPoolLive.feeBps}bps)`);
                    console.log(`        Sim Final Out: ${ethers.formatUnits(finalAmountReceived, borrowToken.decimals)} ${borrowToken.symbol} | Repay Req: ${ethers.formatUnits(requiredRepaymentAmount, borrowToken.decimals)} ${borrowToken.symbol}`);

                    // 4. Calculate Gross Profit
                    if (finalAmountReceived <= requiredRepaymentAmount) {
                        console.log(`        -> Gross Profit Check FAIL.`);
                        continue;
                    }
                    const grossProfit = finalAmountReceived - requiredRepaymentAmount;
                    console.log(`        -> Gross Profit: ${ethers.formatUnits(grossProfit, borrowToken.decimals)} ${borrowToken.symbol}`);

                    // 5. Calculate Net Profit (Compare Gross Profit vs Gas Cost)
                    let netProfit = -1n; // Sentinel value for unknown net profit
                    let netProfitCheckPassed = false;

                    // If borrowToken is the native network token, comparison is direct
                    if (borrowToken.symbol === config.NATIVE_SYMBOL) {
                        if (grossProfit > estimatedGasCostWei) {
                            netProfit = grossProfit - estimatedGasCostWei;
                            if (netProfit >= minNetProfit) { // Check against configured minimum
                                console.log(`        -> ✅✅ NET Profit Check SUCCESS (Native): ~${ethers.formatUnits(netProfit, borrowToken.decimals)} ${borrowToken.symbol} (>= min ${ethers.formatUnits(minNetProfit, borrowToken.decimals)})`);
                                netProfitCheckPassed = true;
                            } else {
                                console.log(`        -> ❌ NET Profit Check FAIL (Native): ~${ethers.formatUnits(netProfit, borrowToken.decimals)} ${borrowToken.symbol} (< min ${ethers.formatUnits(minNetProfit, borrowToken.decimals)})`);
                            }
                        } else {
                            console.log(`        -> ❌ NET Profit Check FAIL (Native): Gross Profit (${ethers.formatUnits(grossProfit, borrowToken.decimals)}) <= Gas Cost (${ethers.formatUnits(estimatedGasCostWei, borrowToken.decimals)})`);
                        }
                    } else {
                        // If borrowToken is NOT native, need a price feed for accurate check.
                        // ** TEMPORARY HEURISTIC: Assume profit if grossProfit seems significant **
                        // Replace this with a real price feed check later!
                        const TEMP_STABLE_PROFIT_THRESHOLD_WEI = config.MIN_NET_PROFIT_WEI[borrowToken.symbol] || ethers.parseUnits('0.5', borrowToken.decimals); // Use config min profit or default $0.50
                        if (grossProfit >= TEMP_STABLE_PROFIT_THRESHOLD_WEI) {
                             console.log(`        -> ✅ NET Profit Check APPROX SUCCESS (Non-Native): Gross Profit ${ethers.formatUnits(grossProfit, borrowToken.decimals)} ${borrowToken.symbol} seems significant (>= ${ethers.formatUnits(TEMP_STABLE_PROFIT_THRESHOLD_WEI, borrowToken.decimals)}). Requires Price Feed for accuracy.`);
                             // For now, consider it a potential opportunity based on gross profit heuristic
                             netProfitCheckPassed = true;
                             netProfit = grossProfit; // Store gross as proxy net until price feed
                        } else {
                             console.log(`        -> ❌ NET Profit Check APPROX FAIL (Non-Native): Gross Profit ${ethers.formatUnits(grossProfit, borrowToken.decimals)} ${borrowToken.symbol} is too low (< ${ethers.formatUnits(TEMP_STABLE_PROFIT_THRESHOLD_WEI, borrowToken.decimals)}).`);
                        }
                    }

                    // 6. Update Best Opportunity if this one is better
                    if (netProfitCheckPassed) {
                        // Prioritize native token profits? Or just highest net profit?
                        // For now, just take the best found so far based on calculated/estimated netProfit.
                        if (bestOpportunityOverall === null || netProfit > bestOpportunityOverall.estimatedNetProfit) {
                            console.log(`        ---> New best overall opportunity!`);
                            bestOpportunityOverall = {
                                groupKey: groupKey,
                                startPoolInfo: startPoolLive, // Includes address, feeBps, tick etc.
                                swapPoolInfo: swapPoolLive,   // Includes address, feeBps, tick etc.
                                tokenBorrowed: borrowToken,     // SDK Token object
                                tokenIntermediate: intermediateToken, // SDK Token object
                                borrowAmount: borrowAmount,     // BigInt
                                requiredRepayment: requiredRepaymentAmount, // BigInt
                                estimatedGrossProfit: grossProfit, // BigInt
                                estimatedNetProfit: netProfit, // BigInt (can be estimate for non-native)
                                // Store minimum amounts out from SDK Trades for slippage control in arbitrage.js
                                // Use a small buffer (e.g., 0.1% = 10 basis points)
                                // Ensure SLIPPAGE_TOLERANCE is defined in config or use Percent directly
                                amountOutMinimum1: trade1.minimumAmountOut(config.SLIPPAGE_TOLERANCE || new Percent(10, 10000)).quotient, // trade1 output (intermediate)
                                amountOutMinimum2: trade2.minimumAmountOut(config.SLIPPAGE_TOLERANCE || new Percent(10, 10000)).quotient, // trade2 output (borrowed)
                                swapFeeA: swapPoolLive.feeBps, // Fee for swap1 (X->Y on swapPool)
                                swapFeeB: swapPoolLive.feeBps, // Fee for swap2 (Y->X on swapPool)
                                estimatedGasCost: estimatedGasCostWei // Store for reference
                            };
                        }
                    }

                } catch (simError) {
                    console.error(`      ❌ Simulation Error (${startPoolLive.feeBps}->${swapPoolLive.feeBps}): ${simError.message}`);
                    // Don't log full stack trace usually, just message
                }
                // --- End Accurate Simulation ---

            } // End inner loop (j)
        } // End outer loop (i)

    } // End group loop

    // --- Trigger Arbitrage Attempt for the BEST overall opportunity ---
    if (bestOpportunityOverall) {
        console.log(`\n[Monitor-${networkName}] Best opportunity found: ${bestOpportunityOverall.groupKey} | Start ${bestOpportunityOverall.startPoolInfo.feeBps}bps -> Swap ${bestOpportunityOverall.swapPoolInfo.feeBps}bps`);
        console.log(`  Borrow: ${ethers.formatUnits(bestOpportunityOverall.borrowAmount, bestOpportunityOverall.tokenBorrowed.decimals)} ${bestOpportunityOverall.tokenBorrowed.symbol}`);
        console.log(`  Est. Gross Profit: ${ethers.formatUnits(bestOpportunityOverall.estimatedGrossProfit, bestOpportunityOverall.tokenBorrowed.decimals)} ${bestOpportunityOverall.tokenBorrowed.symbol}`);
        console.log(`  Est. Net Profit:   ${bestOpportunityOverall.estimatedNetProfit >= 0n ? '~' + ethers.formatUnits(bestOpportunityOverall.estimatedNetProfit, bestOpportunityOverall.tokenBorrowed.decimals) : 'N/A (Non-Native)'} ${bestOpportunityOverall.tokenBorrowed.symbol}`);
        console.log(`  Min Amount Out Swap1: ${ethers.formatUnits(bestOpportunityOverall.amountOutMinimum1, bestOpportunityOverall.tokenIntermediate.decimals)} ${bestOpportunityOverall.tokenIntermediate.symbol}`);
        console.log(`  Min Amount Out Swap2: ${ethers.formatUnits(bestOpportunityOverall.amountOutMinimum2, bestOpportunityOverall.tokenBorrowed.decimals)} ${bestOpportunityOverall.tokenBorrowed.symbol}`);

        try {
            // Pass the necessary parts of state and the detailed opportunity
            await attemptArbitrage({
                provider,
                signer,
                contracts,
                config, // Pass full active config
                networkName,
                opportunity: bestOpportunityOverall, // Pass the structured opportunity object
                feeData // Pass current fee data for potential use in execution
            });
        } catch (arbitrageError) {
             console.error(`[Monitor-${networkName}] Error during attemptArbitrage call: ${arbitrageError.message}`);
        }

    } else {
        console.log(`\n[Monitor-${networkName}] No profitable opportunity found this cycle.`);
    }

    const cycleEndTime = Date.now();
    console.log(`[Monitor-${networkName}] ${new Date().toISOString()} - Cycle End (${cycleEndTime - cycleStartTime}ms).`);
}

module.exports = { monitorPools };

// Helper to add Percent class if not globally available (or adjust import strategy)
// Ensure Percent is imported correctly
const { Percent } = require('@uniswap/sdk-core');
