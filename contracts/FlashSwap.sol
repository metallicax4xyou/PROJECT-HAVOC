// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

// --- Imports ---
import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3FlashCallback.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol"; // Use SafeERC20 for safer transfers
import "hardhat/console.sol"; // Keep for debugging if needed

// --- Contract Definition ---
contract FlashSwap is IUniswapV3FlashCallback {
    using SafeERC20 for IERC20; // Use safe transfers

    // --- State Variables ---
    ISwapRouter public immutable SWAP_ROUTER; // Use immutable for gas savings
    address public immutable owner;

    // --- Structs ---
    // Data passed internally from initiateFlashSwap to the callback
    struct FlashCallbackData {
        uint amount0Borrowed;
        uint amount1Borrowed;
        address caller;         // Who initiated the flash swap
        address poolAddress;    // Pool where flash loan originated
        bytes params;           // Encoded arbitrage parameters from the user/bot
    }

    // Decoded arbitrage parameters provided by the caller
    struct ArbitrageParams {
        address tokenIntermediate; // The token to swap to in the middle (e.g., USDC)
        address poolA;             // Address of pool for Swap 1 (e.g., WETH->USDC)
        address poolB;             // Address of pool for Swap 2 (e.g., USDC->WETH)
        uint24 feeA;               // Fee tier for Pool A
        uint24 feeB;               // Fee tier for Pool B
        uint amountOutMinimum1;    // Min intermediate token expected from Swap 1
        uint amountOutMinimum2;    // Min final token expected from Swap 2 (Repayment Amount + Profit)
    }

    // --- Events ---
    event FlashSwapInitiated(address indexed caller, address indexed pool, uint amount0, uint amount1);
    event ArbitrageAttempt(address indexed poolA, address indexed poolB, address tokenBorrowed, uint amountBorrowed);
    event SwapExecuted(uint indexed swapNumber, address indexed tokenIn, address indexed tokenOut, uint amountIn, uint amountOut);
    event RepaymentSuccess(address indexed token, uint amountRepaid);
    event ProfitWithdrawn(address indexed token, address indexed recipient, uint amount);
    event EmergencyWithdrawal(address indexed token, address indexed recipient, uint amount); // For owner withdrawal

    // --- Modifiers ---
    modifier onlyOwner() {
        require(msg.sender == owner, "FlashSwap: Caller is not the owner");
        _;
    }

    // --- Constructor ---
    constructor(address _swapRouter) {
        SWAP_ROUTER = ISwapRouter(_swapRouter);
        owner = msg.sender;
        console.log("FlashSwap deployed with Router:", address(SWAP_ROUTER));
        console.log("Owner set to:", owner);
    }

    // --- Uniswap V3 Flash Callback ---
    /// @notice Callback function executed by the Uniswap V3 Pool after the flash loan.
    /// @dev Decodes internal and external parameters, executes arbitrage swaps, and repays the loan.
    /// @param fee0 The fee amount owed for borrowing token0.
    /// @param fee1 The fee amount owed for borrowing token1.
    /// @param data Abi-encoded FlashCallbackData struct.
    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external override {
        // Decode internal callback data
        FlashCallbackData memory internalData = abi.decode(data, (FlashCallbackData));

        // Security Check: Ensure callback originates from the expected pool
        require(msg.sender == internalData.poolAddress, "FlashSwap: Callback from unexpected pool");

        // Decode arbitrage parameters provided by the initiator
        ArbitrageParams memory arbParams = abi.decode(internalData.params, (ArbitrageParams));

        // Determine loan details
        IUniswapV3Pool loanPool = IUniswapV3Pool(internalData.poolAddress);
        address tokenBorrowed;
        address tokenRepay; // The other token in the pair
        uint amountBorrowed;
        uint totalAmountToRepay;

        if (internalData.amount1Borrowed > 0) { // Borrowed token1 (e.g., WETH)
            tokenBorrowed = loanPool.token1();
            tokenRepay = loanPool.token0(); // e.g., USDC
            amountBorrowed = internalData.amount1Borrowed;
            totalAmountToRepay = amountBorrowed + fee1;
             // Basic sanity check (can be made more robust if needed)
            require(arbParams.poolA != address(0) && arbParams.poolB != address(0), "Pool addresses invalid");
        } else { // Borrowed token0 (e.g., USDC)
            tokenBorrowed = loanPool.token0();
            tokenRepay = loanPool.token1(); // e.g., WETH
            amountBorrowed = internalData.amount0Borrowed;
            totalAmountToRepay = amountBorrowed + fee0;
             // Basic sanity check
            require(arbParams.poolA != address(0) && arbParams.poolB != address(0), "Pool addresses invalid");
             // Note: Swap logic below assumes borrowing token1. Adapt if borrowing token0 needed.
             // For now, we will focus swap logic on the token1 borrow case.
             // require(arbParams.tokenIntermediate == tokenRepay, "Param intermediate token mismatch"); // Relaxed check
        }

        console.log("Callback Details:");
        console.log("  Loan Pool:", internalData.poolAddress);
        console.log("  Borrowed Token Addr:", tokenBorrowed); // Changed log
        console.log("  Amount Borrowed:", amountBorrowed);
        console.log("  Fee:", tokenBorrowed == loanPool.token1() ? fee1 : fee0);
        console.log("  Total to Repay:", totalAmountToRepay);
        console.log("Arbitrage Params:");
        console.log("  Intermediate Token Addr:", arbParams.tokenIntermediate); // Changed log
        console.log("  Pool A:", arbParams.poolA, "Fee:", arbParams.feeA);
        console.log("  Pool B:", arbParams.poolB, "Fee:", arbParams.feeB);

        emit ArbitrageAttempt(arbParams.poolA, arbParams.poolB, tokenBorrowed, amountBorrowed);

        // --- ARBITRAGE EXECUTION ---
        // This logic assumes: Borrow Token X -> Swap X for Y (Pool A) -> Swap Y for X (Pool B) -> Repay X
        // It currently focuses on the case where Token X = tokenBorrowed (e.g. WETH)
        // and Token Y = arbParams.tokenIntermediate (e.g. USDC)

        uint amountIntermediateReceived;
        uint finalAmountReceived; // Amount of 'tokenBorrowed' received after 2nd swap

        // --- Swap 1: Borrowed Token -> Intermediate Token (Pool A) ---
        // Approve router for the borrowed amount
        IERC20(tokenBorrowed).safeApprove(address(SWAP_ROUTER), amountBorrowed);

        ISwapRouter.ExactInputSingleParams memory params1 = ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenBorrowed,
                tokenOut: arbParams.tokenIntermediate,
                fee: arbParams.feeA,
                recipient: address(this), // Receive intermediate tokens here
                deadline: block.timestamp, // Use current block timestamp
                amountIn: amountBorrowed,
                amountOutMinimum: arbParams.amountOutMinimum1, // Slippage protection
                sqrtPriceLimitX96: 0 // No price limit
            });

        // UPDATED LOG (Removed .symbol())
        console.log("Executing Swap 1 (Token Addr:", tokenBorrowed, "-> Token Addr:", arbParams.tokenIntermediate, ") on Pool A:", arbParams.poolA);
        try SWAP_ROUTER.exactInputSingle(params1) returns (uint amountOut) {
            amountIntermediateReceived = amountOut;
            // UPDATED LOG (Removed .symbol())
            console.log("Swap 1 OK. Received:", amountIntermediateReceived, "of Token Addr:", arbParams.tokenIntermediate);
            emit SwapExecuted(1, tokenBorrowed, arbParams.tokenIntermediate, amountBorrowed, amountIntermediateReceived);
        } catch Error(string memory reason) {
            console.log("!!! Swap 1 FAILED:", reason);
            revert("FlashSwap: Swap 1 execution failed"); // Revert ensures loan is not kept
        } catch {
            console.log("!!! Swap 1 FAILED (Low Level)");
            revert("FlashSwap: Swap 1 execution failed (low level)");
        }

        // --- Swap 2: Intermediate Token -> Borrowed Token (Pool B) ---
        require(amountIntermediateReceived > 0, "FlashSwap: Swap 1 returned zero amount");
        // Approve router for the intermediate tokens received
        IERC20(arbParams.tokenIntermediate).safeApprove(address(SWAP_ROUTER), amountIntermediateReceived);

        ISwapRouter.ExactInputSingleParams memory params2 = ISwapRouter.ExactInputSingleParams({
                tokenIn: arbParams.tokenIntermediate,
                tokenOut: tokenBorrowed, // Swap back to the originally borrowed token
                fee: arbParams.feeB,
                recipient: address(this), // Receive borrowed tokens back here
                deadline: block.timestamp,
                amountIn: amountIntermediateReceived,
                amountOutMinimum: arbParams.amountOutMinimum2, // Slippage + Profit target
                sqrtPriceLimitX96: 0 // No price limit
            });

        // UPDATED LOG (Removed .symbol())
        console.log("Executing Swap 2 (Token Addr:", arbParams.tokenIntermediate, "-> Token Addr:", tokenBorrowed, ") on Pool B:", arbParams.poolB);
         try SWAP_ROUTER.exactInputSingle(params2) returns (uint amountOut) {
             finalAmountReceived = amountOut; // Store the final amount received
             // UPDATED LOG (Removed .symbol())
             console.log("Swap 2 OK. Received:", finalAmountReceived, "of Token Addr:", tokenBorrowed);
             emit SwapExecuted(2, arbParams.tokenIntermediate, tokenBorrowed, amountIntermediateReceived, finalAmountReceived);
        } catch Error(string memory reason) {
             console.log("!!! Swap 2 FAILED:", reason);
             revert("FlashSwap: Swap 2 execution failed");
        } catch {
             console.log("!!! Swap 2 FAILED (Low Level)");
            revert("FlashSwap: Swap 2 execution failed (low level)");
        }

        // --- Repayment ---
        console.log("Checking balance for repayment...");
        uint currentBalanceBorrowedToken = IERC20(tokenBorrowed).balanceOf(address(this));
        // UPDATED LOG (Removed .symbol())
        console.log("Current Balance:", currentBalanceBorrowedToken, "of Token Addr:", tokenBorrowed);
        // UPDATED LOG (Removed .symbol())
        console.log("Required Repayment:", totalAmountToRepay, "of Token Addr:", tokenBorrowed);


        // THE CRITICAL CHECK: Did the arbitrage yield enough profit to cover the loan + fee?
        // Note: This check implicitly covers gas because the caller pays gas externally.
        // The contract only needs enough *token balance* to repay the loan+fee. Profit is what's left *after* repayment.
        require(currentBalanceBorrowedToken >= totalAmountToRepay, "FlashSwap: Insufficient funds post-arbitrage for repayment");

        console.log("Repaying loan...");
        IERC20(tokenBorrowed).safeTransfer(internalData.poolAddress, totalAmountToRepay);
        console.log("Repayment Transfer Sent.");
        emit RepaymentSuccess(tokenBorrowed, totalAmountToRepay);

        // If we reach here, the flash loan was successful and repaid.
        // Any remaining balance of `tokenBorrowed` is profit (minus external gas costs).
        uint profit = currentBalanceBorrowedToken - totalAmountToRepay;
        // UPDATED LOG (Removed .symbol())
        console.log("*** Arbitrage SUCCESSFUL! Profit (before gas):", profit, "of Token Addr:", tokenBorrowed, " ***");
    }


    // --- Initiate Flash Swap (Called by Owner/Bot) ---
    /// @notice Initiates a Uniswap V3 flash loan and the arbitrage attempt.
    /// @param _poolAddress The address of the Uniswap V3 pool to borrow from.
    /// @param _amount0 Amount of token0 to borrow (must be 0 if _amount1 > 0).
    /// @param _amount1 Amount of token1 to borrow (must be 0 if _amount0 > 0).
    /// @param _params Abi-encoded ArbitrageParams struct defining the swap route.
    function initiateFlashSwap(
        address _poolAddress,
        uint _amount0,
        uint _amount1,
        bytes calldata _params // Use calldata for external calls
    ) external {
        // Can add onlyOwner modifier if only the deployer should initiate
        // require(msg.sender == owner, "FlashSwap: Only owner can initiate");

        require((_amount0 > 0 && _amount1 == 0) || (_amount1 > 0 && _amount0 == 0), "FlashSwap: Borrow only one token type per flash swap");
        require(_params.length > 0, "FlashSwap: Arbitrage parameters required");

        emit FlashSwapInitiated(msg.sender, _poolAddress, _amount0, _amount1);

        // Prepare internal data for the callback
        FlashCallbackData memory callbackData = FlashCallbackData({
            amount0Borrowed: _amount0,
            amount1Borrowed: _amount1,
            caller: msg.sender, // Record who called initiateFlashSwap
            poolAddress: _poolAddress,
            params: _params // Pass through encoded ArbitrageParams
        });

        // Trigger the flash loan on the specified pool
        IUniswapV3Pool(_poolAddress).flash(
            address(this), // recipient is this contract
            _amount0,
            _amount1,
            abi.encode(callbackData) // Encode the internal data struct to be passed to callback
        );
    }

    // --- Profit Withdrawal Functions (Owner Only) ---
    /// @notice Allows the owner to withdraw accumulated ETH profits.
    function withdrawEther() external onlyOwner {
        uint balance = address(this).balance;
        require(balance > 0, "FlashSwap: No Ether balance to withdraw");
        emit EmergencyWithdrawal(address(0), owner, balance); // Use address(0) for ETH
        payable(owner).transfer(balance); // Use direct transfer for ETH
    }

    /// @notice Allows the owner to withdraw accumulated ERC20 token profits.
    /// @param tokenAddress The address of the ERC20 token to withdraw.
    function withdrawToken(address tokenAddress) external onlyOwner {
        require(tokenAddress != address(0), "FlashSwap: Invalid token address");
        IERC20 token = IERC20(tokenAddress);
        uint balance = token.balanceOf(address(this));
        require(balance > 0, "FlashSwap: No token balance to withdraw");
        emit EmergencyWithdrawal(tokenAddress, owner, balance);
        token.safeTransfer(owner, balance);
    }

    // --- Fallback ---
    // Allow contract to receive ETH (e.g., if accidentally sent or for future use)
    receive() external payable {}
}
