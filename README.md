# Project Havoc - Uniswap V3 Arbitrage Bot (Arbitrum)

**Status:** Under Active Development (Private)

## Overview

Project Havoc is an experimental arbitrage bot designed to identify and execute potentially profitable trading opportunities on Uniswap V3 deployed on the Arbitrum One network. It specifically targets:

1.  **Triangular Arbitrage:** Exploiting price discrepancies between three different assets (e.g., A -> B -> C -> A).
2.  **(Future Scope):** Cyclic Arbitrage (e.g., A -> B -> A across different fee tier pools).

The bot leverages **flash loans** from Uniswap V3 pools to execute these arbitrage cycles without requiring upfront capital (beyond gas fees).

## Core Features & Technologies

*   **Network:** Currently targets **Arbitrum One**.
*   **Protocol:** Interacts exclusively with **Uniswap V3**.
*   **Arbitrage Detection:**
    *   Real-time scanning of configured Uniswap V3 pool states (`slot0`, `liquidity`).
    *   Builds a token graph to identify potential triangular paths.
    *   Uses a **pure BigInt calculation pipeline** for precise, scaled price ratio determination to identify opportunities, avoiding floating-point or `FixedNumber` limitations.
*   **Simulation:**
    *   Uses the `@uniswap/v3-sdk` to simulate the gross profit of identified multi-hop swap paths (currently implementing 3-hop simulation).
    *   **(Work In Progress):** Accurate tick liquidity simulation via a proper TickLens/DataProvider implementation.
*   **Profit Calculation:**
    *   Estimates transaction gas costs.
    *   Utilizes Chainlink price feeds to convert gross profit (in borrow token) to the native token (ETH).
    *   Compares estimated net profit (in ETH) against configurable per-group thresholds.
*   **Execution:**
    *   Uses a custom Solidity smart contract (`FlashSwap.sol`) deployed on-chain.
    *   The contract receives a flash loan, executes the required sequence of swaps via the Uniswap V3 Router, repays the loan plus fee, and transfers profit back to the owner address.
    *   **(Work In Progress):** Contract and off-chain executor (`txExecutor.js`) are being updated to handle 3-hop triangular paths.
*   **Technology Stack:**
    *   **Smart Contracts:** Solidity, Hardhat, OpenZeppelin, Uniswap V3 Interfaces.
    *   **Off-chain Bot:** Node.js, ethers.js v6, Uniswap SDK (v3-sdk, sdk-core).
    *   **Configuration:** `.env` file driven.

## Current Development Stage

The project is currently focused on completing the refactoring required for reliable triangular arbitrage execution:

1.  **Configuration:** Consolidated and validated.
2.  **Scanning:** BigInt pipeline for triangular detection implemented and operational.
3.  **Execution Contract (`FlashSwap.sol`):** Updated to support 3-hop swap execution logic.
4.  **Executor (`txExecutor.js`):** Updated to prepare parameters and call the 3-hop contract function.
5.  **Simulator (`quoteSimulator.js`):** Updated to simulate the 3-hop swap sequence.
6.  **Engine (`arbitrageEngine.js`):** **(NEXT STEP)** Implementing the core loop connecting the scanner, simulator, profit calculator, and executor for triangular opportunities.
7.  **Tick Data Provider:** **(CRITICAL TODO)** Replacing the simulator's stub tick provider with a real implementation for accurate simulations.

## Risk Disclaimer

**HIGH RISK:** This is an experimental software operating in a volatile and complex environment. Automated trading, smart contract interactions, flash loans, and network conditions all carry significant risks, including but not limited to:

*   Loss of funds due to bugs in the bot or smart contract.
*   Loss of funds due to unfavorable market movements during execution (slippage).
*   Loss of funds due to excessive gas costs or failed transactions.
*   Loss of funds due to network latency or RPC issues.
*   Risks associated with private key management.

**This software is for private development and educational purposes. Use at your own extreme risk. Not financial advice.**
