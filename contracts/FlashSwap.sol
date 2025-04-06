// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

// --- Imports ---
import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3FlashCallback.sol";
// --- ADDED Imports for Validation ---
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import "@uniswap/v3-periphery/contracts/libraries/PoolAddress.sol"; // Library to compute pool address
import "@uniswap/v3-periphery/contracts/libraries/CallbackValidation.sol"; // Library for validation
// --- End Added Imports ---
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "hardhat/console.sol";

// --- Contract Definition ---
// Consider inheriting PeripheryImmutableState if using more periphery features
contract FlashSwap is IUniswapV3FlashCallback {
    using SafeERC20 for IERC20;

    // --- State Variables ---
    ISwapRouter public immutable SWAP_ROUTER;
    address public immutable owner;
    // --- ADDED Factory Address (Needed for Validation) ---
    // Get Factory address for Arbitrum One from Uniswap docs (or pass in constructor)
    address public immutable V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;


    // --- Structs ---
    struct FlashCallbackData { // Data encoded by initiateFlashSwap
        uint amount0Borrowed;
        uint amount1Borrowed;
        address caller;
        address token0; // Need tokens to reconstruct pool key
        address token1; // Need tokens to reconstruct pool key
        uint24 fee;     // Need fee to reconstruct pool key
        bytes params;   // Arbitrage params
    }

    struct ArbitrageParams { // Decoded from FlashCallbackData.params
        address tokenIntermediate;
        address poolA;
        address poolB;
        uint24 feeA;
        uint24 feeB;
        uint amountOutMinimum1;
        uint amountOutMinimum2;
    }

    // --- Events ---
    // ... (Keep existing events) ...

    // --- Modifiers ---
    modifier onlyOwner() { /* ... */ }

    // --- Constructor ---
    constructor(address _swapRouter) {
        SWAP_ROUTER = ISwapRouter(_swapRouter);
        owner = msg.sender;
        console.log("FlashSwap Deployed"); /* ... */
    }

    // --- Uniswap V3 Flash Callback ---
    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external override {
        FlashCallbackData memory internalData = abi.decode(data, (FlashCallbackData));

        // --- ADDED CALLBACK VALIDATION ---
        // Reconstruct the PoolKey
        PoolAddress.PoolKey memory poolKey = PoolAddress.PoolKey({
            token0: internalData.token0,
            token1: internalData.token1,
            fee: internalData.fee
        });
        // Verify that the caller (msg.sender) is the legitimate pool address for the given key
        CallbackValidation.verifyCallback(V3_FACTORY, poolKey);
        // --- END VALIDATION ---


        // Original require check is now redundant if verifyCallback passes, but keep for defense-in-depth
        // require(msg.sender == internalData.poolAddress, "FlashSwap: Callback from unexpected pool"); // Can potentially remove

        ArbitrageParams memory arbParams = abi.decode(internalData.params, (ArbitrageParams));

        IUniswapV3Pool loanPool = IUniswapV3Pool(msg.sender); // Use msg.sender as it's verified pool address
        address tokenBorrowed;
        uint amountBorrowed;
        uint totalAmountToRepay;
        uint feePaid;

        // Determine borrow details (no change needed here)
        if (internalData.amount1Borrowed > 0) { /* ... */ } else { /* ... */ }

        // ... (Logging - No change needed) ...

        emit ArbitrageAttempt(arbParams.poolA, arbParams.poolB, tokenBorrowed, amountBorrowed);

        uint amountIntermediateReceived;
        uint finalAmountReceived;

        // --- Swap 1 ---
        // ... (Approve, Params, Swap try/catch - No change needed) ...
        try SWAP_ROUTER.exactInputSingle(params1) returns (uint amountOut) { /* ... */ } catch Error(string memory reason) { revert("FlashSwap: Swap 1 execution failed"); } catch { revert("FlashSwap: Swap 1 execution failed (low level)"); }

        // --- Swap 2 ---
        // ... (Require, Approve, Params, Swap try/catch - No change needed) ...
         try SWAP_ROUTER.exactInputSingle(params2) returns (uint amountOut) { /* ... */ } catch Error(string memory reason) { revert("FlashSwap: Swap 2 execution failed"); } catch { revert("FlashSwap: Swap 2 execution failed (low level)"); }

        // --- Repayment ---
        // ... (Balance check, require, transfer - No change needed) ...
        IERC20(tokenBorrowed).safeTransfer(msg.sender, totalAmountToRepay); // Repay to msg.sender (verified pool)

        // ... (Profit logging - No change needed) ...
    }


    // --- Initiate Flash Swap ---
    function initiateFlashSwap(
        address _poolAddress,
        uint _amount0,
        uint _amount1,
        bytes calldata _params // Contains encoded ArbitrageParams
    ) external { /* onlyOwner? */
        require((_amount0 > 0 && _amount1 == 0) || (_amount1 > 0 && _amount0 == 0), "...");
        require(_params.length > 0, "...");

        // --- ADD Fetching Pool Details for Callback Data ---
        IUniswapV3Pool pool = IUniswapV3Pool(_poolAddress);
        address token0 = pool.token0();
        address token1 = pool.token1();
        uint24 fee = pool.fee();
        // --- END Fetching Pool Details ---

        emit FlashSwapInitiated(msg.sender, _poolAddress, _amount0, _amount1);

        // Prepare internal data for the callback INCLUDING pool key details
        FlashCallbackData memory callbackData = FlashCallbackData({
            amount0Borrowed: _amount0,
            amount1Borrowed: _amount1,
            caller: msg.sender,
            // poolAddress: _poolAddress, // No longer strictly needed in callback if using verifyCallback
            token0: token0, // Pass token0
            token1: token1, // Pass token1
            fee: fee,       // Pass fee
            params: _params
        });

        // Trigger the flash loan
        pool.flash( address(this), _amount0, _amount1, abi.encode(callbackData) );
    }

    // --- Profit Withdrawal Functions ---
    // ... (No change needed) ...

    // --- Fallback ---
    receive() external payable {}
}
