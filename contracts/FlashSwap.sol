// SPDX-License-Identifier: MIT
pragma solidity =0.7.6; // Match periphery library version
pragma abicoder v2;

// --- Imports ---
import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3FlashCallback.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import "@uniswap/v3-periphery/contracts/libraries/PoolAddress.sol";
import "@uniswap/v3-periphery/contracts/libraries/CallbackValidation.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol"; // Ensure correct v3 path

import "hardhat/console.sol";

// --- Contract Definition ---
contract FlashSwap is IUniswapV3FlashCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;

    // --- State Variables ---
    ISwapRouter public immutable SWAP_ROUTER;
    address public immutable owner;
    address public immutable V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984; // Arbitrum Factory
    // --- ADDED Deadline Constant ---
    uint constant DEADLINE_OFFSET = 30; // Seconds after block timestamp for swap deadline

    // --- Structs ---
    struct FlashCallbackData { uint amount0Borrowed; uint amount1Borrowed; address caller; address token0; address token1; uint24 fee; bytes params; }
    struct ArbitrageParams { address tokenIntermediate; address poolA; address poolB; uint24 feeA; uint24 feeB; uint amountOutMinimum1; uint amountOutMinimum2; }

    // --- Events ---
    event FlashSwapInitiated(address indexed caller, address indexed pool, uint amount0, uint amount1);
    event ArbitrageAttempt(address indexed poolA, address indexed poolB, address tokenBorrowed, uint amountBorrowed);
    event SwapExecuted(uint indexed swapNumber, address indexed tokenIn, address indexed tokenOut, uint amountIn, uint amountOut);
    event RepaymentSuccess(address indexed token, uint amountRepaid);
    event ProfitTransferred(address indexed token, address indexed recipient, uint amount);
    event EmergencyWithdrawal(address indexed token, address indexed recipient, uint amount);
    event DebugSwapValues(uint min1, uint inter, uint min2, uint final, uint repay);

    // --- Modifiers ---
    modifier onlyOwner() { require(msg.sender == owner, "Not owner"); _; }

    // --- Constructor ---
    constructor(address _swapRouter) {
        SWAP_ROUTER = ISwapRouter(_swapRouter);
        owner = msg.sender;
        console.log("FlashSwap Deployed - V6 (Polished)"); // Version marker
    }

    // --- Uniswap V3 Flash Callback ---
    function uniswapV3FlashCallback( uint256 fee0, uint256 fee1, bytes calldata data ) external override nonReentrant { // Keeps override
        FlashCallbackData memory internalData = abi.decode(data, (FlashCallbackData));
        PoolAddress.PoolKey memory poolKey = PoolAddress.PoolKey({ token0: internalData.token0, token1: internalData.token1, fee: internalData.fee });
        CallbackValidation.verifyCallback(V3_FACTORY, poolKey);

        ArbitrageParams memory arbParams = abi.decode(internalData.params, (ArbitrageParams));
        address tokenBorrowed; uint amountBorrowed; uint totalAmountToRepay; uint feePaid;

        if (internalData.amount1Borrowed > 0) { tokenBorrowed = internalData.token1; amountBorrowed = internalData.amount1Borrowed; feePaid = fee1; totalAmountToRepay = amountBorrowed.add(feePaid); }
        else { tokenBorrowed = internalData.token0; amountBorrowed = internalData.amount0Borrowed; feePaid = fee0; totalAmountToRepay = amountBorrowed.add(feePaid); }
        require(arbParams.poolA != address(0) && arbParams.poolB != address(0), "Pools invalid");

        emit ArbitrageAttempt(arbParams.poolA, arbParams.poolB, tokenBorrowed, amountBorrowed);
        uint amountIntermediateReceived; uint finalAmountReceived;

        // --- Swap 1 ---
        IERC20(tokenBorrowed).safeApprove(address(SWAP_ROUTER), 0);
        IERC20(tokenBorrowed).safeApprove(address(SWAP_ROUTER), amountBorrowed);
        ISwapRouter.ExactInputSingleParams memory params1 = ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenBorrowed, tokenOut: arbParams.tokenIntermediate, fee: arbParams.feeA, recipient: address(this),
                // --- Use Deadline Offset ---
                deadline: block.timestamp + DEADLINE_OFFSET,
                amountIn: amountBorrowed, amountOutMinimum: arbParams.amountOutMinimum1, sqrtPriceLimitX96: 0
            });
        try SWAP_ROUTER.exactInputSingle(params1) returns (uint amountOut) { amountIntermediateReceived = amountOut; emit SwapExecuted(1, tokenBorrowed, arbParams.tokenIntermediate, amountBorrowed, amountIntermediateReceived); }
        catch Error(string memory reason) { revert(string(abi.encodePacked("FlashSwap: Swap 1 failed: ", reason))); }
        catch { revert("FlashSwap: Swap 1 failed (LL)"); }

        // --- Swap 2 ---
        require(amountIntermediateReceived > 0, "Swap1 0");
        IERC20(arbParams.tokenIntermediate).safeApprove(address(SWAP_ROUTER), 0);
        IERC20(arbParams.tokenIntermediate).safeApprove(address(SWAP_ROUTER), amountIntermediateReceived);
        ISwapRouter.ExactInputSingleParams memory params2 = ISwapRouter.ExactInputSingleParams({
                tokenIn: arbParams.tokenIntermediate, tokenOut: tokenBorrowed, fee: arbParams.feeB, recipient: address(this),
                // --- Use Deadline Offset ---
                deadline: block.timestamp + DEADLINE_OFFSET,
                amountIn: amountIntermediateReceived, amountOutMinimum: arbParams.amountOutMinimum2, sqrtPriceLimitX96: 0
            });
         try SWAP_ROUTER.exactInputSingle(params2) returns (uint amountOut) { finalAmountReceived = amountOut; emit SwapExecuted(2, arbParams.tokenIntermediate, tokenBorrowed, amountIntermediateReceived, finalAmountReceived); }
         catch Error(string memory reason) { revert(string(abi.encodePacked("FlashSwap: Swap 2 failed: ", reason))); }
         catch { revert("FlashSwap: Swap 2 failed (LL)"); }

         emit DebugSwapValues(arbParams.amountOutMinimum1, amountIntermediateReceived, arbParams.amountOutMinimum2, finalAmountReceived, totalAmountToRepay);

        // --- Repayment ---
        uint currentBalanceBorrowedToken = IERC20(tokenBorrowed).balanceOf(address(this));
        require(currentBalanceBorrowedToken >= totalAmountToRepay, "Insufficient funds");
        IERC20(tokenBorrowed).safeTransfer(msg.sender, totalAmountToRepay);
        emit RepaymentSuccess(tokenBorrowed, totalAmountToRepay);

        // --- Auto-forward profit to owner ---
        uint profit = currentBalanceBorrowedToken.sub(totalAmountToRepay);
        if (profit > 0) {
            emit ProfitTransferred(tokenBorrowed, owner, profit);
            IERC20(tokenBorrowed).safeTransfer(owner, profit);
        }
    }

    // --- Initiate Flash Swap ---
    // --- Removed override keyword ---
    function initiateFlashSwap( address _poolAddress, uint _amount0, uint _amount1, bytes calldata _params ) external onlyOwner {
        require((_amount0 > 0 && _amount1 == 0) || (_amount1 > 0 && _amount0 == 0), "Borrow 1 token");
        require(_params.length > 0, "Params req");
        IUniswapV3Pool pool = IUniswapV3Pool(_poolAddress);
        address token0 = pool.token0(); address token1 = pool.token1(); uint24 fee = pool.fee();
        emit FlashSwapInitiated(msg.sender, _poolAddress, _amount0, _amount1);
        FlashCallbackData memory callbackData = FlashCallbackData({
            amount0Borrowed: _amount0, amount1Borrowed: _amount1, caller: msg.sender,
            token0: token0, token1: token1, fee: fee, params: _params
        });
        pool.flash( address(this), _amount0, _amount1, abi.encode(callbackData) );
    }

    // --- Profit Withdrawal Functions ---
     // --- Removed override keyword ---
    function withdrawEther() external onlyOwner {
         uint balance = address(this).balance;
         require(balance > 0, "No Ether balance");
         emit EmergencyWithdrawal(address(0), owner, balance);
         payable(owner).transfer(balance);
     }
    // --- Removed override keyword ---
    function withdrawToken(address tokenAddress) external onlyOwner {
        require(tokenAddress != address(0), "Invalid token address");
        IERC20 token = IERC20(tokenAddress);
        uint balance = token.balanceOf(address(this));
        require(balance > 0, "No token balance");
        emit EmergencyWithdrawal(tokenAddress, owner, balance);
        token.safeTransfer(owner, balance);
    }

    // --- Fallback ---
    receive() external payable {}
}
