// SPDX-License-Identifier: MIT
pragma solidity =0.7.6; // Match periphery library version
pragma abicoder v2;

// --- Imports ---
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// --- Uniswap Imports ---
import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3FlashCallback.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import "@uniswap/v3-periphery/contracts/libraries/PoolAddress.sol";
import "@uniswap/v3-periphery/contracts/libraries/CallbackValidation.sol";

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
    address public immutable V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984; // Uniswap V3 Factory (Mainnet, Arbitrum, etc.)
    uint constant DEADLINE_OFFSET = 60; // Seconds

    // --- Structs ---
    struct FlashCallbackData {
        uint amount0Borrowed;
        uint amount1Borrowed;
        address caller;
        address token0;
        address token1;
        uint24 fee;
        bytes params; // Encoded ArbitrageParams
    }

    // --- CORRECTED STRUCT ORDER ---
    // Matches the encoding order in arbitrage.js:
    // ['tuple(address tokenIntermediate, address poolA, uint24 feeA, address poolB, uint24 feeB, uint256 amountOutMinimum1, uint256 amountOutMinimum2)']
    struct ArbitrageParams {
        address tokenIntermediate; // Index 0
        address poolA;          // Index 1
        uint24 feeA;            // Index 2 <<< CORRECTED ORDER
        address poolB;          // Index 3 <<< CORRECTED ORDER
        uint24 feeB;            // Index 4
        uint amountOutMinimum1; // Index 5
        uint amountOutMinimum2; // Index 6
    }

    // --- Events ---
    event FlashSwapInitiated(address indexed caller, address indexed pool, uint amount0, uint amount1);
    event ArbitrageAttempt(address indexed poolA, address indexed poolB, address tokenBorrowed, uint amountBorrowed, uint feePaid);
    event SwapExecuted(uint indexed swapNumber, address indexed tokenIn, address indexed tokenOut, uint amountIn, uint amountOut);
    event RepaymentSuccess(address indexed token, uint amountRepaid);
    event ProfitTransferred(address indexed token, address indexed recipient, uint amount);
    event EmergencyWithdrawal(address indexed token, address indexed recipient, uint amount);
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
    ) external override nonReentrant {
        // Decode core flash loan data
        FlashCallbackData memory internalData = abi.decode(data, (FlashCallbackData));

        // --- Security Check: Ensure callback originates from a genuine Uniswap V3 Pool ---
        PoolAddress.PoolKey memory poolKey = PoolAddress.PoolKey({
            token0: internalData.token0,
            token1: internalData.token1,
            fee: internalData.fee
        });
        CallbackValidation.verifyCallback(V3_FACTORY, poolKey);

        // Decode arbitrage parameters using the CORRECTED ArbitrageParams struct
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
            require(internalData.amount0Borrowed == 0, "FlashSwap: Both tokens borrowed?");
        } else {
            tokenBorrowed = internalData.token0;
            amountBorrowed = internalData.amount0Borrowed;
            feePaid = fee0;
            totalAmountToRepay = amountBorrowed.add(feePaid);
            require(internalData.amount1Borrowed == 0, "FlashSwap: Both tokens borrowed?");
        }
        require(amountBorrowed > 0, "FlashSwap: Zero borrow amount");
        require(arbParams.poolA != address(0) && arbParams.poolB != address(0), "FlashSwap: Invalid pool address in params");
        require(tokenBorrowed == internalData.token0 || tokenBorrowed == internalData.token1, "FlashSwap: Borrowed token mismatch"); // Sanity check

        emit ArbitrageAttempt(arbParams.poolA, arbParams.poolB, tokenBorrowed, amountBorrowed, feePaid);

        // --- Arbitrage Execution ---
        uint amountIntermediateReceived;
        uint finalAmountReceived;

        // --- Swap 1: Borrowed Token -> Intermediate Token ---
        IERC20(tokenBorrowed).safeApprove(address(SWAP_ROUTER), 0);
        IERC20(tokenBorrowed).safeApprove(address(SWAP_ROUTER), amountBorrowed);

        ISwapRouter.ExactInputSingleParams memory params1 = ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenBorrowed,
                tokenOut: arbParams.tokenIntermediate,
                fee: arbParams.feeA, // Use feeA from decoded params
                recipient: address(this),
                deadline: block.timestamp + DEADLINE_OFFSET,
                amountIn: amountBorrowed,
                amountOutMinimum: arbParams.amountOutMinimum1,
                sqrtPriceLimitX96: 0
            });

        try SWAP_ROUTER.exactInputSingle(params1) returns (uint amountOut) {
            amountIntermediateReceived = amountOut;
            emit SwapExecuted(1, tokenBorrowed, arbParams.tokenIntermediate, amountBorrowed, amountIntermediateReceived);
        } catch Error(string memory reason) {
            revert(string(abi.encodePacked("FlashSwap: Swap 1 execution failed: ", reason)));
        } catch {
            revert("FlashSwap: Swap 1 failed (Low-Level Error)");
        }

        require(amountIntermediateReceived > 0, "FlashSwap: Swap 1 produced zero output");

        // --- Swap 2: Intermediate Token -> Borrowed Token ---
        IERC20(arbParams.tokenIntermediate).safeApprove(address(SWAP_ROUTER), 0);
        IERC20(arbParams.tokenIntermediate).safeApprove(address(SWAP_ROUTER), amountIntermediateReceived);

        ISwapRouter.ExactInputSingleParams memory params2 = ISwapRouter.ExactInputSingleParams({
                tokenIn: arbParams.tokenIntermediate,
                tokenOut: tokenBorrowed,
                fee: arbParams.feeB, // Use feeB from decoded params
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

        emit DebugSwapValues(arbParams.amountOutMinimum1, amountIntermediateReceived, arbParams.amountOutMinimum2, finalAmountReceived, totalAmountToRepay);

        // --- Repayment ---
        uint currentBalanceBorrowedToken = IERC20(tokenBorrowed).balanceOf(address(this));

        // --- THIS IS THE KEY CHECK THAT MAKES STATICCALL UNRELIABLE for profitability check ---
        // It relies on actual balances which won't exist in static simulation.
        // However, if the decode error was the issue, staticcall might pass now IF the path *would* be profitable.
        // It will still fail if the path is unprofitable.
        require(currentBalanceBorrowedToken >= totalAmountToRepay, "FlashSwap: Insufficient funds to repay loan + fee");

        IERC20(tokenBorrowed).safeTransfer(msg.sender, totalAmountToRepay); // Repay pool
        emit RepaymentSuccess(tokenBorrowed, totalAmountToRepay);

        // --- Profit Handling ---
        uint profit = currentBalanceBorrowedToken.sub(totalAmountToRepay);
        if (profit > 0) {
            emit ProfitTransferred(tokenBorrowed, owner, profit);
            IERC20(tokenBorrowed).safeTransfer(owner, profit);
        }
    }

    // --- Initiate Flash Swap ---
    function initiateFlashSwap(
        address _poolAddress,
        uint _amount0,
        uint _amount1,
        bytes calldata _params // Encoded ArbitrageParams struct
    ) external onlyOwner {
        require(_poolAddress != address(0), "FlashSwap: Invalid pool address");
        require((_amount0 > 0 && _amount1 == 0) || (_amount1 > 0 && _amount0 == 0), "FlashSwap: Must borrow exactly one token type");
        require(_params.length > 0, "FlashSwap: Params cannot be empty");

        IUniswapV3Pool pool = IUniswapV3Pool(_poolAddress);
        address token0 = pool.token0();
        address token1 = pool.token1();
        uint24 fee = pool.fee();

        emit FlashSwapInitiated(msg.sender, _poolAddress, _amount0, _amount1);

        // Prepare the data to be passed into the callback
        FlashCallbackData memory callbackData = FlashCallbackData({
            amount0Borrowed: _amount0,
            amount1Borrowed: _amount1,
            caller: msg.sender,
            token0: token0,
            token1: token1,
            fee: fee,
            params: _params // Pass through the encoded arbitrage parameters
        });

        // Initiate the flash loan
        pool.flash(
            address(this), // recipient / callback target
            _amount0,
            _amount1,
            abi.encode(callbackData) // Encode the callback data struct
        );
    }

    // --- Emergency Withdrawal Functions ---
     function withdrawEther() external onlyOwner {
         uint balance = address(this).balance;
         require(balance > 0, "FlashSwap: No Ether balance to withdraw");
         emit EmergencyWithdrawal(address(0), owner, balance);
         payable(owner).transfer(balance);
     }

    function withdrawToken(address tokenAddress) external onlyOwner {
        require(tokenAddress != address(0), "FlashSwap: Invalid token address");
        IERC20 token = IERC20(tokenAddress);
        uint balance = token.balanceOf(address(this));
        require(balance > 0, "FlashSwap: No token balance to withdraw");
        emit EmergencyWithdrawal(tokenAddress, owner, balance);
        token.safeTransfer(owner, balance);
    }

    // --- Fallback Function ---
    receive() external payable {}
}
