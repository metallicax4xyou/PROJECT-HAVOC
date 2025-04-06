// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

// --- Imports ---
import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3FlashCallback.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "hardhat/console.sol"; // Keep for debugging

// --- Contract Definition ---
contract FlashSwap is IUniswapV3FlashCallback {
    using SafeERC20 for IERC20;

    // --- State Variables ---
    ISwapRouter public immutable SWAP_ROUTER;
    address public immutable owner;

    // --- Structs ---
    struct FlashCallbackData {
        uint amount0Borrowed;
        uint amount1Borrowed;
        address caller;
        address poolAddress;
        bytes params;
    }

    struct ArbitrageParams {
        address tokenIntermediate;
        address poolA;
        address poolB;
        uint24 feeA;
        uint24 feeB;
        uint amountOutMinimum1;
        uint amountOutMinimum2;
    }

    // --- Events ---
    event FlashSwapInitiated(address indexed caller, address indexed pool, uint amount0, uint amount1);
    event ArbitrageAttempt(address indexed poolA, address indexed poolB, address tokenBorrowed, uint amountBorrowed);
    event SwapExecuted(uint indexed swapNumber, address indexed tokenIn, address indexed tokenOut, uint amountIn, uint amountOut);
    event RepaymentSuccess(address indexed token, uint amountRepaid);
    event EmergencyWithdrawal(address indexed token, address indexed recipient, uint amount);

    // --- Modifiers ---
    modifier onlyOwner() {
        require(msg.sender == owner, "FlashSwap: Caller is not the owner");
        _;
    }

    // --- Constructor ---
    constructor(address _swapRouter) {
        SWAP_ROUTER = ISwapRouter(_swapRouter);
        owner = msg.sender;
        console.log("FlashSwap Deployed"); // Simple log
        console.log("  Router:", address(SWAP_ROUTER));
        console.log("  Owner:", owner);
    }

    // --- Uniswap V3 Flash Callback ---
    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external override {
        FlashCallbackData memory internalData = abi.decode(data, (FlashCallbackData));
        require(msg.sender == internalData.poolAddress, "FlashSwap: Callback from unexpected pool");

        ArbitrageParams memory arbParams = abi.decode(internalData.params, (ArbitrageParams));

        IUniswapV3Pool loanPool = IUniswapV3Pool(internalData.poolAddress);
        address tokenBorrowed;
        uint amountBorrowed;
        uint totalAmountToRepay;
        uint feePaid;

        if (internalData.amount1Borrowed > 0) {
            tokenBorrowed = loanPool.token1();
            amountBorrowed = internalData.amount1Borrowed;
            feePaid = fee1;
            totalAmountToRepay = amountBorrowed + feePaid;
            require(arbParams.poolA != address(0) && arbParams.poolB != address(0), "Pool addresses invalid");
        } else {
            tokenBorrowed = loanPool.token0();
            amountBorrowed = internalData.amount0Borrowed;
            feePaid = fee0;
            totalAmountToRepay = amountBorrowed + feePaid;
            require(arbParams.poolA != address(0) && arbParams.poolB != address(0), "Pool addresses invalid");
        }

        // --- Updated Logging Start ---
        console.log("--- Callback Details ---");
        console.log("  Loan Pool Addr:", internalData.poolAddress);
        console.log("  Borrowed Token Addr:", tokenBorrowed);
        console.log("  Amount Borrowed:", amountBorrowed);
        console.log("  Fee Paid:", feePaid);
        console.log("  Total to Repay:", totalAmountToRepay);
        console.log("--- Arbitrage Params ---");
        console.log("  Intermediate Token Addr:", arbParams.tokenIntermediate);
        console.log("  Pool A Addr:", arbParams.poolA);
        console.log("  Pool A Fee:", arbParams.feeA);
        console.log("  Pool B Addr:", arbParams.poolB);
        console.log("  Pool B Fee:", arbParams.feeB);
        // --- Updated Logging End ---

        emit ArbitrageAttempt(arbParams.poolA, arbParams.poolB, tokenBorrowed, amountBorrowed);

        uint amountIntermediateReceived;
        uint finalAmountReceived;

        // --- Swap 1 ---
        IERC20(tokenBorrowed).safeApprove(address(SWAP_ROUTER), amountBorrowed);
        ISwapRouter.ExactInputSingleParams memory params1 = ISwapRouter.ExactInputSingleParams({ /* ... params ... */
                tokenIn: tokenBorrowed,
                tokenOut: arbParams.tokenIntermediate,
                fee: arbParams.feeA,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: amountBorrowed,
                amountOutMinimum: arbParams.amountOutMinimum1,
                sqrtPriceLimitX96: 0
            });

        console.log("--- Executing Swap 1 ---"); // Separated log
        try SWAP_ROUTER.exactInputSingle(params1) returns (uint amountOut) {
            amountIntermediateReceived = amountOut;
            console.log("  Swap 1 OK. Received:", amountOut); // Simple log
            console.log("  Intermediate Token Addr:", arbParams.tokenIntermediate);
            emit SwapExecuted(1, tokenBorrowed, arbParams.tokenIntermediate, amountBorrowed, amountIntermediateReceived);
        } catch Error(string memory reason) {
            console.log("!!! Swap 1 FAILED:", reason);
            revert("FlashSwap: Swap 1 execution failed");
        } catch {
            console.log("!!! Swap 1 FAILED (Low Level)");
            revert("FlashSwap: Swap 1 execution failed (low level)");
        }

        // --- Swap 2 ---
        require(amountIntermediateReceived > 0, "FlashSwap: Swap 1 returned zero amount");
        IERC20(arbParams.tokenIntermediate).safeApprove(address(SWAP_ROUTER), amountIntermediateReceived);
        ISwapRouter.ExactInputSingleParams memory params2 = ISwapRouter.ExactInputSingleParams({ /* ... params ... */
                tokenIn: arbParams.tokenIntermediate,
                tokenOut: tokenBorrowed,
                fee: arbParams.feeB,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: amountIntermediateReceived,
                amountOutMinimum: arbParams.amountOutMinimum2,
                sqrtPriceLimitX96: 0
            });

        console.log("--- Executing Swap 2 ---"); // Separated log
         try SWAP_ROUTER.exactInputSingle(params2) returns (uint amountOut) {
             finalAmountReceived = amountOut;
             console.log("  Swap 2 OK. Received:", amountOut); // Simple log
             console.log("  Borrowed Token Addr:", tokenBorrowed);
             emit SwapExecuted(2, arbParams.tokenIntermediate, tokenBorrowed, amountIntermediateReceived, finalAmountReceived);
        } catch Error(string memory reason) {
             console.log("!!! Swap 2 FAILED:", reason);
             revert("FlashSwap: Swap 2 execution failed");
        } catch {
             console.log("!!! Swap 2 FAILED (Low Level)");
            revert("FlashSwap: Swap 2 execution failed (low level)");
        }

        // --- Repayment ---
        console.log("--- Repayment Check ---"); // Separated log
        uint currentBalanceBorrowedToken = IERC20(tokenBorrowed).balanceOf(address(this));
        console.log("  Current Balance (Borrowed Token):", currentBalanceBorrowedToken);
        console.log("  Required Repayment:", totalAmountToRepay);
        console.log("  Borrowed Token Addr:", tokenBorrowed);

        require(currentBalanceBorrowedToken >= totalAmountToRepay, "FlashSwap: Insufficient funds post-arbitrage for repayment");

        console.log("  Repaying loan..."); // Indented log
        IERC20(tokenBorrowed).safeTransfer(internalData.poolAddress, totalAmountToRepay);
        console.log("  Repayment Transfer Sent.");
        emit RepaymentSuccess(tokenBorrowed, totalAmountToRepay);

        uint profit = currentBalanceBorrowedToken - totalAmountToRepay;
        console.log("*** Arbitrage SUCCESSFUL! ***"); // Separated log
        console.log("  Profit (Before Gas):", profit);
        console.log("  Profit Token Addr:", tokenBorrowed);
    }

    // --- Initiate Flash Swap ---
    function initiateFlashSwap(
        address _poolAddress,
        uint _amount0,
        uint _amount1,
        bytes calldata _params
    ) external { /* onlyOwner? */
        require((_amount0 > 0 && _amount1 == 0) || (_amount1 > 0 && _amount0 == 0), "FlashSwap: Borrow only one token type");
        require(_params.length > 0, "FlashSwap: Arbitrage parameters required");

        emit FlashSwapInitiated(msg.sender, _poolAddress, _amount0, _amount1);

        FlashCallbackData memory callbackData = FlashCallbackData({ /* ... */
            amount0Borrowed: _amount0,
            amount1Borrowed: _amount1,
            caller: msg.sender,
            poolAddress: _poolAddress,
            params: _params
        });

        IUniswapV3Pool(_poolAddress).flash(
            address(this),
            _amount0,
            _amount1,
            abi.encode(callbackData)
        );
    }

    // --- Profit Withdrawal Functions ---
    function withdrawEther() external onlyOwner {
        uint balance = address(this).balance;
        require(balance > 0, "FlashSwap: No Ether balance");
        emit EmergencyWithdrawal(address(0), owner, balance);
        payable(owner).transfer(balance);
    }

    function withdrawToken(address tokenAddress) external onlyOwner {
        require(tokenAddress != address(0), "FlashSwap: Invalid token address");
        IERC20 token = IERC20(tokenAddress);
        uint balance = token.balanceOf(address(this));
        require(balance > 0, "FlashSwap: No token balance");
        emit EmergencyWithdrawal(tokenAddress, owner, balance);
        token.safeTransfer(owner, balance);
    }

    // --- Fallback ---
    receive() external payable {}
}
