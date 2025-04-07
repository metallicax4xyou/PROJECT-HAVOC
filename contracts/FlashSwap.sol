// SPDX-License-Identifier: MIT
pragma solidity =0.7.6; // Match periphery library version
pragma abicoder v2;

// --- Imports ---
import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3FlashCallback.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
// Note: PoolAddress library might be directly available via periphery depending on exact package structure
// If compilation fails, you might need to adjust path or copy library source
import "@uniswap/v3-periphery/contracts/libraries/PoolAddress.sol";
import "@uniswap/v3-periphery/contracts/libraries/CallbackValidation.sol";
import "@openzeppelin/contracts@3.4.0/token/ERC20/IERC20.sol"; // Specify OZ version for clarity
import "@openzeppelin/contracts@3.4.0/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts@3.4.0/math/SafeMath.sol";
import "@openzeppelin/contracts@3.4.0/utils/ReentrancyGuard.sol";

// Optional: Only if you need console.log during Hardhat tests
// import "hardhat/console.sol";

// --- Contract Definition ---
/**
 * @title FlashSwap
 * @notice Executes arbitrage trades between two Uniswap V3 pools using a flash swap.
 * Designed to be called by an off-chain bot. Uses Solidity 0.7.6 for Uni V3 compatibility.
 */
contract FlashSwap is IUniswapV3FlashCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;

    // --- State Variables ---
    ISwapRouter public immutable SWAP_ROUTER;
    address public immutable owner;
    // Using immutable reference for Arbitrum One Uniswap V3 Factory
    address public immutable V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    uint constant DEADLINE_OFFSET = 60; // Seconds after block timestamp for swap deadline (Increased slightly)

    // --- Structs ---
    // Data passed into the flash callback, encoded
    struct FlashCallbackData {
        uint amount0Borrowed;
        uint amount1Borrowed;
        address caller; // The EOA/contract that initiated the flash swap via this contract
        address token0; // Pool's token0 address
        address token1; // Pool's token1 address
        uint24 fee;     // Pool's fee tier
        bytes params;   // Encoded ArbitrageParams
    }

    // Parameters needed for the arbitrage logic within the callback
    struct ArbitrageParams {
        address tokenIntermediate; // The token being swapped *to* in swap1 and *from* in swap2
        address poolA;          // Address of the pool for the first swap (can be the flash loan pool or the other)
        address poolB;          // Address of the pool for the second swap
        uint24 feeA;            // Fee tier for poolA
        uint24 feeB;            // Fee tier for poolB
        uint amountOutMinimum1; // Slippage protection for swap 1 (set to 0 for debugging)
        uint amountOutMinimum2; // Slippage protection for swap 2 (set to 0 for debugging)
    }

    // --- Events ---
    event FlashSwapInitiated(address indexed caller, address indexed pool, uint amount0, uint amount1);
    event ArbitrageAttempt(address indexed poolA, address indexed poolB, address tokenBorrowed, uint amountBorrowed, uint feePaid);
    event SwapExecuted(uint indexed swapNumber, address indexed tokenIn, address indexed tokenOut, uint amountIn, uint amountOut);
    event RepaymentSuccess(address indexed token, uint amountRepaid);
    event ProfitTransferred(address indexed token, address indexed recipient, uint amount);
    event EmergencyWithdrawal(address indexed token, address indexed recipient, uint amount);
    // More detailed debug event
    event DebugSwapValues(uint amountOutMin1, uint actualAmountIntermediate, uint amountOutMin2, uint actualFinalAmount, uint requiredRepayment);

    // --- Modifiers ---
    modifier onlyOwner() {
        require(msg.sender == owner, "FlashSwap: Not owner");
        _;
    }

    // --- Constructor ---
    constructor(address _swapRouter) {
        require(_swapRouter != address(0), "FlashSwap: Invalid SwapRouter address");
        SWAP_ROUTER = ISwapRouter(_swapRouter);
        owner = msg.sender;
        // console.log("FlashSwap Deployed - Owner:", owner, "Router:", _swapRouter);
    }

    // --- Uniswap V3 Flash Callback ---
    /**
     * @notice Callback function executed by the Uniswap V3 Pool after the flash loan.
     * @dev Must implement IUniswapV3FlashCallback. Validates caller, executes swaps, repays loan, sends profit.
     * @param fee0 The fee accrued for borrowing token0
     * @param fee1 The fee accrued for borrowing token1
     * @param data Encoded FlashCallbackData struct
     */
    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external override nonReentrant { // 'override' is required here
        // Decode core flash loan data
        FlashCallbackData memory internalData = abi.decode(data, (FlashCallbackData));

        // --- Security Check: Ensure callback originates from a genuine Uniswap V3 Pool ---
        PoolAddress.PoolKey memory poolKey = PoolAddress.PoolKey({
            token0: internalData.token0,
            token1: internalData.token1,
            fee: internalData.fee
        });
        // This check prevents malicious contracts calling this function directly
        CallbackValidation.verifyCallback(V3_FACTORY, poolKey);

        // Decode arbitrage parameters
        ArbitrageParams memory arbParams = abi.decode(internalData.params, (ArbitrageParams));

        // Determine which token was borrowed and the amount to repay
        address tokenBorrowed;
        uint amountBorrowed;
        uint totalAmountToRepay;
        uint feePaid;

        if (internalData.amount1Borrowed > 0) {
            tokenBorrowed = internalData.token1;
            amountBorrowed = internalData.amount1Borrowed;
            feePaid = fee1;
            totalAmountToRepay = amountBorrowed.add(feePaid);
        } else {
            tokenBorrowed = internalData.token0;
            amountBorrowed = internalData.amount0Borrowed;
            feePaid = fee0;
            totalAmountToRepay = amountBorrowed.add(feePaid);
            // Sanity check: Ensure only one token was borrowed as expected
            require(internalData.amount1Borrowed == 0, "FlashSwap: Both tokens borrowed?");
        }
        require(amountBorrowed > 0, "FlashSwap: Zero borrow amount"); // Should be caught earlier, but good check
        require(arbParams.poolA != address(0) && arbParams.poolB != address(0), "FlashSwap: Invalid pool address in params");

        emit ArbitrageAttempt(arbParams.poolA, arbParams.poolB, tokenBorrowed, amountBorrowed, feePaid);

        // --- Arbitrage Execution ---
        uint amountIntermediateReceived;
        uint finalAmountReceived;

        // --- Swap 1: Borrowed Token -> Intermediate Token ---
        // Reset allowance, then approve exact amount for safety
        IERC20(tokenBorrowed).safeApprove(address(SWAP_ROUTER), 0);
        IERC20(tokenBorrowed).safeApprove(address(SWAP_ROUTER), amountBorrowed);

        ISwapRouter.ExactInputSingleParams memory params1 = ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenBorrowed,
                tokenOut: arbParams.tokenIntermediate,
                fee: arbParams.feeA,
                recipient: address(this), // Swap output goes to this contract
                deadline: block.timestamp + DEADLINE_OFFSET, // Use dynamic deadline
                amountIn: amountBorrowed,
                amountOutMinimum: arbParams.amountOutMinimum1, // Use parameter for slippage control
                sqrtPriceLimitX96: 0 // 0 indicates no price limit (most common for arbitrage)
            });

        // Use try/catch for robust error handling during swaps
        try SWAP_ROUTER.exactInputSingle(params1) returns (uint amountOut) {
            amountIntermediateReceived = amountOut;
            emit SwapExecuted(1, tokenBorrowed, arbParams.tokenIntermediate, amountBorrowed, amountIntermediateReceived);
        } catch Error(string memory reason) {
            // Bubble up specific revert reason from the Router/Pool
            revert(string(abi.encodePacked("FlashSwap: Swap 1 execution failed: ", reason)));
        } catch {
            // Catch generic/low-level errors
            revert("FlashSwap: Swap 1 failed (Low-Level Error)");
        }

        // Require swap 1 produced output before proceeding
        require(amountIntermediateReceived > 0, "FlashSwap: Swap 1 produced zero output");

        // --- Swap 2: Intermediate Token -> Borrowed Token ---
        // Reset allowance, then approve exact amount for safety
        IERC20(arbParams.tokenIntermediate).safeApprove(address(SWAP_ROUTER), 0);
        IERC20(arbParams.tokenIntermediate).safeApprove(address(SWAP_ROUTER), amountIntermediateReceived);

        ISwapRouter.ExactInputSingleParams memory params2 = ISwapRouter.ExactInputSingleParams({
                tokenIn: arbParams.tokenIntermediate,
                tokenOut: tokenBorrowed, // Swap back to the originally borrowed token
                fee: arbParams.feeB,
                recipient: address(this),
                deadline: block.timestamp + DEADLINE_OFFSET,
                amountIn: amountIntermediateReceived,
                amountOutMinimum: arbParams.amountOutMinimum2,
                sqrtPriceLimitX96: 0
            });

         try SWAP_ROUTER.exactInputSingle(params2) returns (uint amountOut) {
             finalAmountReceived = amountOut;
             emit SwapExecuted(2, arbParams.tokenIntermediate, tokenBorrowed, amountIntermediateReceived, finalAmountReceived);
         } catch Error(string memory reason) {
             revert(string(abi.encodePacked("FlashSwap: Swap 2 execution failed: ", reason)));
         } catch {
             revert("FlashSwap: Swap 2 failed (Low-Level Error)");
         }

        // Emit debug event *before* checking final balance vs repayment
        emit DebugSwapValues(arbParams.amountOutMinimum1, amountIntermediateReceived, arbParams.amountOutMinimum2, finalAmountReceived, totalAmountToRepay);

        // --- Repayment ---
        // Check if we received enough back to cover the loan + fee
        uint currentBalanceBorrowedToken = IERC20(tokenBorrowed).balanceOf(address(this));
        require(currentBalanceBorrowedToken >= totalAmountToRepay, "FlashSwap: Insufficient funds to repay loan + fee");

        // Repay the flash loan + fee to the pool (msg.sender of the callback)
        IERC20(tokenBorrowed).safeTransfer(msg.sender, totalAmountToRepay);
        emit RepaymentSuccess(tokenBorrowed, totalAmountToRepay);

        // --- Profit Handling ---
        // Calculate remaining balance after repayment, which is profit
        uint profit = currentBalanceBorrowedToken.sub(totalAmountToRepay);

        // If profitable, transfer the profit to the contract owner
        if (profit > 0) {
            emit ProfitTransferred(tokenBorrowed, owner, profit);
            IERC20(tokenBorrowed).safeTransfer(owner, profit);
        }
    }

    // --- Initiate Flash Swap ---
    /**
     * @notice Owner-controlled function to initiate a flash swap via a specified Uniswap V3 Pool.
     * @param _poolAddress The address of the Uniswap V3 pool to borrow from.
     * @param _amount0 The amount of token0 to borrow (must be 0 if borrowing token1).
     * @param _amount1 The amount of token1 to borrow (must be 0 if borrowing token0).
     * @param _params Encoded ArbitrageParams struct containing swap details.
     */
    function initiateFlashSwap(
        address _poolAddress,
        uint _amount0,
        uint _amount1,
        bytes calldata _params // Use calldata for external functions
    ) external onlyOwner { // No 'override' here
        require(_poolAddress != address(0), "FlashSwap: Invalid pool address");
        // Ensure only one token type is borrowed per flash swap
        require((_amount0 > 0 && _amount1 == 0) || (_amount1 > 0 && _amount0 == 0), "FlashSwap: Must borrow exactly one token type");
        require(_params.length > 0, "FlashSwap: Params cannot be empty");

        IUniswapV3Pool pool = IUniswapV3Pool(_poolAddress);
        // Read pool properties needed for the callback data
        address token0 = pool.token0();
        address token1 = pool.token1();
        uint24 fee = pool.fee();

        emit FlashSwapInitiated(msg.sender, _poolAddress, _amount0, _amount1);

        // Prepare the data to be passed into the callback
        FlashCallbackData memory callbackData = FlashCallbackData({
            amount0Borrowed: _amount0,
            amount1Borrowed: _amount1,
            caller: msg.sender, // Store the original caller (owner)
            token0: token0,
            token1: token1,
            fee: fee,
            params: _params // Pass through the encoded arbitrage parameters
        });

        // Initiate the flash loan on the target pool
        pool.flash(
            address(this), // The recipient of the loan and caller of uniswapV3FlashCallback
            _amount0,
            _amount1,
            abi.encode(callbackData) // Encode the callback data struct
        );
    }

    // --- Emergency Withdrawal Functions ---
    /**
     * @notice Allows the owner to withdraw any accidentally sent Ether.
     */
     function withdrawEther() external onlyOwner { // No 'override' here
         uint balance = address(this).balance;
         require(balance > 0, "FlashSwap: No Ether balance to withdraw");
         emit EmergencyWithdrawal(address(0), owner, balance); // Use address(0) for Ether
         payable(owner).transfer(balance);
     }

    /**
     * @notice Allows the owner to withdraw any specific ERC20 token balance.
     * @param tokenAddress The address of the ERC20 token to withdraw.
     */
    function withdrawToken(address tokenAddress) external onlyOwner { // No 'override' here
        require(tokenAddress != address(0), "FlashSwap: Invalid token address");
        IERC20 token = IERC20(tokenAddress);
        uint balance = token.balanceOf(address(this));
        require(balance > 0, "FlashSwap: No token balance to withdraw");
        emit EmergencyWithdrawal(tokenAddress, owner, balance);
        token.safeTransfer(owner, balance);
    }

    // --- Fallback Function ---
    // Allow the contract to receive Ether (e.g., if accidentally sent)
    receive() external payable {}
}
