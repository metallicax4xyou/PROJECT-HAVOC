// SPDX-License-Identifier: MIT
pragma solidity =0.7.6; // Match periphery library version
pragma abicoder v2;

// --- Imports ---
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3FlashCallback.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import "@uniswap/v3-periphery/contracts/libraries/PoolAddress.sol";
import "@uniswap/v3-periphery/contracts/libraries/CallbackValidation.sol";

contract FlashSwap is IUniswapV3FlashCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;

    ISwapRouter public immutable SWAP_ROUTER;
    address public immutable owner;
    // Use an immutable factory address for gas savings and clarity
    address public immutable V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    uint constant DEADLINE_OFFSET = 60; // Seconds

    // --- Enum for Callback Type ---
    enum CallbackType { TWO_HOP, TRIANGULAR } // Distinguish callback origins

    // --- Structs ---
    // Data passed into the flash callback
    struct FlashCallbackData {
        CallbackType callbackType; // Identifier for the arbitrage type
        uint amount0Borrowed;
        uint amount1Borrowed;
        address caller; // Original initiator (owner)
        address poolBorrowedFrom; // Pool where flash loan originated
        address token0; // token0 of poolBorrowedFrom
        address token1; // token1 of poolBorrowedFrom
        uint24 fee;    // fee of poolBorrowedFrom
        bytes params; // Encoded parameters specific to the arbitrage type
    }

    // Parameters for the original 2-hop arbitrage
    struct TwoHopParams {
        address tokenIntermediate;
        address poolA; // Pool for swap 1 (Borrow -> Inter) - might be same as poolB
        uint24 feeA;
        address poolB; // Pool for swap 2 (Inter -> Borrow) - might be same as poolA
        uint24 feeB;
        uint amountOutMinimum1;
        uint amountOutMinimum2;
    }

    // --- NEW: Parameters for 3-hop triangular arbitrage ---
    struct TriangularPathParams {
        address pool1; // Pool for Swap A -> B
        address pool2; // Pool for Swap B -> C
        address pool3; // Pool for Swap C -> A (back to borrowed token)
        address tokenA; // Borrowed token (also final token)
        address tokenB; // Intermediate token 1
        address tokenC; // Intermediate token 2
        uint24 fee1; // Fee for pool1
        uint24 fee2; // Fee for pool2
        uint24 fee3; // Fee for pool3
        // Only need min amount out for the final swap back to the borrowed token
        uint amountOutMinimumFinal;
    }

    // --- Events ---
    event FlashSwapInitiated(address indexed caller, address indexed pool, CallbackType tradeType, uint amount0, uint amount1);
    // event ArbitrageAttempt(address indexed poolA, address indexed poolB, address tokenBorrowed, uint amountBorrowed, uint feePaid); // Maybe make more generic
    event ArbitrageExecution(CallbackType indexed tradeType, address indexed tokenBorrowed, uint amountBorrowed, uint feePaid);
    event SwapExecuted(uint indexed swapNumber, address indexed tokenIn, address indexed tokenOut, uint amountIn, uint amountOut);
    event RepaymentSuccess(address indexed token, uint amountRepaid);
    event ProfitTransferred(address indexed token, address indexed recipient, uint amount);
    event EmergencyWithdrawal(address indexed token, address indexed recipient, uint amount);
    // event DebugSwapValues(...); // Keep or adjust debugging events as needed

    modifier onlyOwner() {
        require(msg.sender == owner, "FS:NA"); // FS: Not Authorized / Not Owner
        _;
    }

    constructor(address _swapRouter) {
        require(_swapRouter != address(0), "FS:ISR"); // FS: Invalid Swap Router
        SWAP_ROUTER = ISwapRouter(_swapRouter);
        owner = msg.sender;
    }

    // --- Uniswap V3 Flash Callback ---
    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external override nonReentrant {
        FlashCallbackData memory decodedData = abi.decode(data, (FlashCallbackData));

        // --- Security Check: Callback Origin ---
        PoolAddress.PoolKey memory poolKey = PoolAddress.PoolKey({
            token0: decodedData.token0,
            token1: decodedData.token1,
            fee: decodedData.fee
        });
        // Ensure callback comes from the pool we initiated the flash swap on
        require(msg.sender == decodedData.poolBorrowedFrom, "FS:CBW"); // FS: Callback Wrong Pool
        // Ensure the pool exists on the factory
        CallbackValidation.verifyCallback(V3_FACTORY, poolKey);

        // --- Determine Borrowed Amount & Repayment ---
        address tokenBorrowed;
        uint amountBorrowed;
        uint totalAmountToRepay;
        uint feePaid;

        if (decodedData.amount1Borrowed > 0) {
            require(decodedData.amount0Borrowed == 0, "FS:BTB"); // FS: Borrowed Two Tokens?
            tokenBorrowed = decodedData.token1;
            amountBorrowed = decodedData.amount1Borrowed;
            feePaid = fee1;
            totalAmountToRepay = amountBorrowed.add(feePaid);
        } else {
            require(decodedData.amount1Borrowed == 0, "FS:BTB");
            require(decodedData.amount0Borrowed > 0, "FS:BNA"); // FS: Borrowed No Amount?
            tokenBorrowed = decodedData.token0;
            amountBorrowed = decodedData.amount0Borrowed;
            feePaid = fee0;
            totalAmountToRepay = amountBorrowed.add(feePaid);
        }

        emit ArbitrageExecution(decodedData.callbackType, tokenBorrowed, amountBorrowed, feePaid);

        // --- Execute Arbitrage based on Type ---
        uint finalAmountReceived; // Amount of 'tokenBorrowed' received after swaps

        if (decodedData.callbackType == CallbackType.TRIANGULAR) {
            finalAmountReceived = _executeTriangularSwaps(tokenBorrowed, amountBorrowed, decodedData.params);
        } else if (decodedData.callbackType == CallbackType.TWO_HOP) {
            finalAmountReceived = _executeTwoHopSwaps(tokenBorrowed, amountBorrowed, decodedData.params);
        } else {
            revert("FS:UCT"); // FS: Unknown Callback Type
        }

        // --- Repayment & Profit Handling ---
        uint currentBalanceBorrowedToken = IERC20(tokenBorrowed).balanceOf(address(this));
        require(currentBalanceBorrowedToken >= totalAmountToRepay, "FS:IFR"); // FS: Insufficient Funds Repay

        // Repay the pool (msg.sender is the pool in the callback)
        IERC20(tokenBorrowed).safeTransfer(msg.sender, totalAmountToRepay);
        emit RepaymentSuccess(tokenBorrowed, totalAmountToRepay);

        // Calculate and transfer profit to the owner
        uint profit = currentBalanceBorrowedToken.sub(totalAmountToRepay);
        if (profit > 0) {
            emit ProfitTransferred(tokenBorrowed, owner, profit);
            IERC20(tokenBorrowed).safeTransfer(owner, profit);
        }
    }

    // --- Internal function for 2-Hop Swaps ---
    function _executeTwoHopSwaps(
        address _tokenBorrowed,
        uint _amountBorrowed,
        bytes memory _params
    ) internal returns (uint finalAmount) {
        TwoHopParams memory arbParams = abi.decode(_params, (TwoHopParams));

        // Swap 1: Borrowed -> Intermediate
        _approveRouterIfNeeded(_tokenBorrowed, _amountBorrowed);
        uint amountIntermediateReceived = _executeSingleSwap(
            1, // Swap number for event
            _tokenBorrowed,
            arbParams.tokenIntermediate,
            arbParams.feeA,
            _amountBorrowed,
            arbParams.amountOutMinimum1
        );
        require(amountIntermediateReceived > 0, "FS:S1Z"); // FS: Swap 1 Zero Output

        // Swap 2: Intermediate -> Borrowed
        _approveRouterIfNeeded(arbParams.tokenIntermediate, amountIntermediateReceived);
        finalAmount = _executeSingleSwap(
            2, // Swap number for event
            arbParams.tokenIntermediate,
            _tokenBorrowed,
            arbParams.feeB,
            amountIntermediateReceived,
            arbParams.amountOutMinimum2
        );
    }

    // --- NEW: Internal function for 3-Hop Triangular Swaps ---
    function _executeTriangularSwaps(
        address _tokenA, // Borrowed token
        uint _amountA,   // Borrowed amount
        bytes memory _params
    ) internal returns (uint finalAmount) {
        TriangularPathParams memory pathParams = abi.decode(_params, (TriangularPathParams));

        // Verify token path matches _tokenA borrowed
        require(pathParams.tokenA == _tokenA, "FS:TPA"); // FS: Triangular Path tokenA mismatch

        // Swap 1: A -> B (using pool1)
        _approveRouterIfNeeded(_tokenA, _amountA);
        uint amountB = _executeSingleSwap(
            1, // Swap number
            _tokenA,
            pathParams.tokenB,
            pathParams.fee1,
            _amountA,
            0 // No minimum output needed for intermediate swaps typically
        );
        require(amountB > 0, "FS:TS1Z"); // FS: Triangular Swap 1 Zero Output

        // Swap 2: B -> C (using pool2)
        _approveRouterIfNeeded(pathParams.tokenB, amountB);
        uint amountC = _executeSingleSwap(
            2, // Swap number
            pathParams.tokenB,
            pathParams.tokenC,
            pathParams.fee2,
            amountB,
            0 // No minimum output needed for intermediate swaps
        );
         require(amountC > 0, "FS:TS2Z"); // FS: Triangular Swap 2 Zero Output

        // Swap 3: C -> A (back to borrowed token, using pool3)
         _approveRouterIfNeeded(pathParams.tokenC, amountC);
         finalAmount = _executeSingleSwap(
            3, // Swap number
            pathParams.tokenC,
            _tokenA, // Swap back to the original borrowed token
            pathParams.fee3,
            amountC,
            pathParams.amountOutMinimumFinal // Apply slippage protection ONLY on the final swap
        );
        // No zero check needed on final swap, as profit check happens later anyway
    }

    // --- Internal Helper for Single Swap ---
    function _executeSingleSwap(
        uint _swapNumber,
        address _tokenIn,
        address _tokenOut,
        uint24 _fee,
        uint _amountIn,
        uint _amountOutMinimum
    ) internal returns (uint amountOut) {
        ISwapRouter.ExactInputSingleParams memory swapParams = ISwapRouter.ExactInputSingleParams({
                tokenIn: _tokenIn,
                tokenOut: _tokenOut,
                fee: _fee,
                recipient: address(this), // Send output back to this contract
                deadline: block.timestamp + DEADLINE_OFFSET,
                amountIn: _amountIn,
                amountOutMinimum: _amountOutMinimum,
                sqrtPriceLimitX96: 0 // No price limit
            });

        try SWAP_ROUTER.exactInputSingle(swapParams) returns (uint _amountOut) {
            amountOut = _amountOut;
            emit SwapExecuted(_swapNumber, _tokenIn, _tokenOut, _amountIn, amountOut);
        } catch Error(string memory reason) {
            revert(string(abi.encodePacked("FS:S", _numToString(_swapNumber) ,"F:", reason))); // FS: Swap X Failed: reason
        } catch {
            revert(string(abi.encodePacked("FS:S", _numToString(_swapNumber), "FL"))); // FS: Swap X Failed Low-level
        }
    }

    // --- Internal Helper for Approvals ---
    function _approveRouterIfNeeded(address _token, uint _amount) internal {
        // Check current allowance
        uint allowance = IERC20(_token).allowance(address(this), address(SWAP_ROUTER));
        if (allowance < _amount) {
            // Reset approval to 0 first to prevent potential issues with some tokens
            if (allowance > 0) {
                IERC20(_token).safeApprove(address(SWAP_ROUTER), 0);
            }
            // Approve the required amount
            IERC20(_token).safeApprove(address(SWAP_ROUTER), _amount);
        }
    }

    // --- Internal Helper to convert uint to string (for revert messages) ---
    function _numToString(uint _i) internal pure returns (string memory _uintAsString) {
        if (_i == 0) { return "0"; }
        uint j = _i; uint len;
        while (j != 0) { len++; j /= 10; }
        bytes memory bstr = new bytes(len);
        uint k = len - 1;
        while (_i != 0) { bstr[k--] = bytes1(uint8(48 + _i % 10)); _i /= 10; }
        return string(bstr);
    }


    // --- Initiate Flash Swap (Original 2-Hop) ---
    function initiateFlashSwap(
        address _poolAddress,
        uint _amount0,
        uint _amount1,
        bytes calldata _params // Encoded TwoHopParams struct
    ) external onlyOwner {
        require(_poolAddress != address(0), "FS:IP"); // FS: Invalid Pool
        require((_amount0 > 0 && _amount1 == 0) || (_amount1 > 0 && _amount0 == 0), "FS:BAO"); // FS: Borrow Amount One
        require(_params.length > 0, "FS:EP"); // FS: Empty Params

        IUniswapV3Pool pool = IUniswapV3Pool(_poolAddress);
        address token0 = pool.token0();
        address token1 = pool.token1();
        uint24 fee = pool.fee();

        emit FlashSwapInitiated(msg.sender, _poolAddress, CallbackType.TWO_HOP, _amount0, _amount1);

        FlashCallbackData memory callbackData = FlashCallbackData({
            callbackType: CallbackType.TWO_HOP,
            amount0Borrowed: _amount0,
            amount1Borrowed: _amount1,
            caller: msg.sender,
            poolBorrowedFrom: _poolAddress, // Store the pool we borrowed from
            token0: token0,
            token1: token1,
            fee: fee,
            params: _params // Pass through the encoded TwoHopParams
        });

        pool.flash( address(this), _amount0, _amount1, abi.encode(callbackData) );
    }

    // --- NEW: Initiate Triangular Flash Swap ---
    function initiateTriangularFlashSwap(
        address _poolAddress, // Pool to borrow from
        uint _amount0,         // Amount of token0 to borrow (or 0)
        uint _amount1,         // Amount of token1 to borrow (or 0)
        bytes calldata _params // Encoded TriangularPathParams struct
    ) external onlyOwner {
        require(_poolAddress != address(0), "FS:IP");
        require((_amount0 > 0 && _amount1 == 0) || (_amount1 > 0 && _amount0 == 0), "FS:BAO");
        require(_params.length > 0, "FS:EP");

        IUniswapV3Pool pool = IUniswapV3Pool(_poolAddress);
        address token0 = pool.token0();
        address token1 = pool.token1();
        uint24 fee = pool.fee();

        emit FlashSwapInitiated(msg.sender, _poolAddress, CallbackType.TRIANGULAR, _amount0, _amount1);

        FlashCallbackData memory callbackData = FlashCallbackData({
            callbackType: CallbackType.TRIANGULAR,
            amount0Borrowed: _amount0,
            amount1Borrowed: _amount1,
            caller: msg.sender,
            poolBorrowedFrom: _poolAddress,
            token0: token0,
            token1: token1,
            fee: fee,
            params: _params // Pass through the encoded TriangularPathParams
        });

        pool.flash( address(this), _amount0, _amount1, abi.encode(callbackData) );
    }


    // --- Emergency Withdrawal Functions ---
    function withdrawEther() external onlyOwner {
         uint balance = address(this).balance;
         require(balance > 0, "FS:NWE"); // FS: No Withdraw Ether
         emit EmergencyWithdrawal(address(0), owner, balance);
         payable(owner).transfer(balance);
    }

    function withdrawToken(address tokenAddress) external onlyOwner {
        require(tokenAddress != address(0), "FS:IT"); // FS: Invalid Token
        IERC20 token = IERC20(tokenAddress);
        uint balance = token.balanceOf(address(this));
        require(balance > 0, "FS:NWT"); // FS: No Withdraw Token
        emit EmergencyWithdrawal(tokenAddress, owner, balance);
        token.safeTransfer(owner, balance);
    }

    // --- Fallback Function ---
    receive() external payable {}
}
