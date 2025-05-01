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
import "./interfaces/IUniswapV2Router02.sol";
import "./interfaces/IDODOV1V2Pool.sol"; // Keep import for context, even if disabled
// --- Aave Imports ---
interface IPool { function flashLoan( address receiverAddress, address[] calldata assets, uint256[] calldata amounts, uint256[] calldata interestRateModes, address onBehalfOf, bytes calldata params, uint16 referralCode ) external; }
interface IFlashLoanReceiver { function executeOperation( address[] calldata assets, uint256[] calldata amounts, uint256[] calldata premiums, address initiator, bytes calldata params ) external returns (bool); function ADDRESSES_PROVIDER() external view returns (address); function POOL() external view returns (address); }


// --- Contract Definition ---
// --- VERSION v3.12 --- Added 30% tithe to Treasury address
contract FlashSwap is IUniswapV3FlashCallback, IFlashLoanReceiver, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;

    // --- State Variables ---
    ISwapRouter public immutable SWAP_ROUTER;
    IUniswapV2Router02 public immutable SUSHI_ROUTER;
    address payable public immutable owner;
    address public immutable V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984; // Uniswap V3 Factory Address
    IPool public immutable AAVE_POOL;
    address public immutable AAVE_ADDRESSES_PROVIDER;
    uint constant DEADLINE_OFFSET = 60; // Swap deadline in seconds from block.timestamp
    // Address to receive 30% of net profit (the "tithe")
    address public constant TREASURY = 0x50d3414C549a0A9Df8d29eD5872FDaEf97d6748d;


    // --- DEX Type Constants ---
    uint8 constant DEX_TYPE_UNISWAP_V3 = 0;
    uint8 constant DEX_TYPE_SUSHISWAP = 1;
    uint8 constant DEX_TYPE_DODO = 2; // Kept for code structure, currently disabled

    // --- Structs ---
    enum CallbackType { TWO_HOP, TRIANGULAR }
    struct FlashCallbackData { CallbackType callbackType; uint amount0Borrowed; uint amount1Borrowed; address caller; address poolBorrowedFrom; address token0; address token1; uint24 fee; bytes params; }
    struct TwoHopParams { address tokenIntermediate; uint24 feeA; uint24 feeB; uint amountOutMinimum1; uint amountOutMinimum2; }
    struct TriangularPathParams { address tokenA; address tokenB; address tokenC; uint24 fee1; uint24 fee2; uint24 fee3; uint amountOutMinimumFinal; }
    // Note: SwapStep fee is only relevant for V3 swaps in the general path executor
    struct SwapStep { address pool; address tokenIn; address tokenOut; uint24 fee; uint256 minOut; uint8 dexType; }
    struct ArbParams { SwapStep[] path; address initiator; }

    // --- Events ---
    event FlashSwapInitiated(address indexed caller, address indexed pool, CallbackType tradeType, uint amount0, uint amount1);
    event AaveFlashLoanInitiated(address indexed caller, address indexed asset, uint amount);
    event AaveArbitrageExecution(address indexed tokenBorrowed, uint amountBorrowed, uint feePaid);
    event ArbitrageExecution(CallbackType indexed tradeType, address indexed tokenBorrowed, uint amountBorrowed, uint feePaid);
    event SwapExecuted(uint swapNumber, uint8 dexType, address indexed tokenIn, address indexed tokenOut, uint amountIn, uint amountOut);
    event RepaymentSuccess(address indexed token, uint amountRepaid);
    event ProfitTransferred(address indexed token, address indexed recipient, uint amount);
    event EmergencyWithdrawal(address indexed token, address indexed recipient, uint amount);
    event TradeProfit(bytes32 indexed pathHash, address indexed token, uint grossProfit, uint feesPaid, uint netProfit);
    event TithePaid(address indexed token, uint amount);


    // --- Modifiers ---
    modifier onlyOwner() { require(msg.sender == owner || tx.origin == owner, "FS:NA"); _; }

    // --- Constructor ---
    constructor( address _uniswapV3Router, address _sushiRouter, address _aavePoolAddress, address _aaveAddressesProvider ) { require(_uniswapV3Router != address(0), "FS:IUR"); require(_sushiRouter != address(0), "FS:ISR"); require(_aavePoolAddress != address(0), "FS:IAP"); require(_aaveAddressesProvider != address(0), "FS:IAAP"); SWAP_ROUTER = ISwapRouter(_uniswapV3Router); SUSHI_ROUTER = IUniswapV2Router02(_sushiRouter); AAVE_POOL = IPool(_aavePoolAddress); AAVE_ADDRESSES_PROVIDER = _aaveAddressesProvider; owner = payable(msg.sender); }

    // --- Uniswap V3 Flash Callback ---
    // Called by Uniswap V3 pool after successful flash loan
    function uniswapV3FlashCallback( uint256 fee0, uint256 fee1, bytes calldata data ) external override nonReentrant {
        FlashCallbackData memory decodedData = abi.decode(data, (FlashCallbackData));

        // Validate callback
        PoolAddress.PoolKey memory poolKey = PoolAddress.PoolKey({ token0: decodedData.token0, token1: decodedData.token1, fee: decodedData.fee });
        require(msg.sender == decodedData.poolBorrowedFrom, "FS:CBW");
        CallbackValidation.verifyCallback(V3_FACTORY, poolKey);

        address tokenBorrowed;
        uint amountBorrowed;
        uint totalAmountToRepay;
        uint feePaid;

        // Determine which token was borrowed and calculate repayment amount
        if (decodedData.amount1Borrowed > 0) {
            require(decodedData.amount0Borrowed == 0, "FS:BTB"); // Cannot borrow both in UniV3 flash
            tokenBorrowed = decodedData.token1;
            amountBorrowed = decodedData.amount1Borrowed;
            feePaid = fee1; // fee1 applies when borrowing token1
            totalAmountToRepay = amountBorrowed.add(feePaid);
        } else { // amount0Borrowed > 0
            require(decodedData.amount1Borrowed == 0 && decodedData.amount0Borrowed > 0, "FS:BNA"); // Cannot borrow both in UniV3 flash
            tokenBorrowed = decodedData.token0;
            amountBorrowed = decodedData.amount0Borrowed;
            feePaid = fee0; // fee0 applies when borrowing token0
            totalAmountToRepay = amountBorrowed.add(feePaid);
        }

        emit ArbitrageExecution(decodedData.callbackType, tokenBorrowed, amountBorrowed, feePaid);

        // --- Execute Swaps ---
        uint finalAmountReceived;
        if (decodedData.callbackType == CallbackType.TRIANGULAR) {
            finalAmountReceived = _executeTriangularSwaps(tokenBorrowed, amountBorrowed, decodedData.params);
        } else if (decodedData.callbackType == CallbackType.TWO_HOP) {
            finalAmountReceived = _executeTwoHopSwaps(tokenBorrowed, amountBorrowed, decodedData.params);
        } else {
            revert("FS:UCT"); // Unknown callback type
        }

        // --- Repay Loan and Handle Profit ---
        uint currentBalanceBorrowedToken = IERC20(tokenBorrowed).balanceOf(address(this));
        require(currentBalanceBorrowedToken >= totalAmountToRepay, "FS:IFR"); // Insufficient funds for repayment

        uint grossProfit = currentBalanceBorrowedToken > amountBorrowed ? currentBalanceBorrowedToken.sub(amountBorrowed) : 0;
        uint netProfit = currentBalanceBorrowedToken > totalAmountToRepay ? currentBalanceBorrowedToken.sub(totalAmountToRepay) : 0;

        // Repay the loan to the Uniswap V3 pool (msg.sender in this context)
        IERC20(tokenBorrowed).safeTransfer(msg.sender, totalAmountToRepay);
        emit RepaymentSuccess(tokenBorrowed, totalAmountToRepay);

        bytes32 pathHash = keccak256(decodedData.params);
        emit TradeProfit(pathHash, tokenBorrowed, grossProfit, feePaid, netProfit);

        // Distribute Net Profit: 30% to Treasury, 70% to Owner
        if (netProfit > 0) {
            uint titheAmount = (netProfit * 30) / 100;
            uint ownerAmount = netProfit - titheAmount; // This implicitly gets 70%

            // Send tithe to treasury
            IERC20(tokenBorrowed).safeTransfer(TREASURY, titheAmount);
            emit TithePaid(tokenBorrowed, titheAmount);

            // Send remaining profit to owner
            IERC20(tokenBorrowed).safeTransfer(owner, ownerAmount);
            emit ProfitTransferred(tokenBorrowed, owner, ownerAmount); // Updated event to reflect owner's amount
        }
    }

    // --- AAVE V3 Flash Loan Callback ---
    // Called by Aave Pool after successful flash loan
    function executeOperation( address[] calldata assets, uint256[] calldata amounts, uint256[] calldata premiums, address initiator, bytes calldata params ) external override nonReentrant returns (bool) {
        // Validate callback
        require(msg.sender == address(AAVE_POOL), "FS:CBA"); // Must be called by the Aave Pool
        require(initiator == address(this), "FS:IFI"); // Initiator must be this contract
        require(assets.length == 1, "FS:MA"); // Currently supports only one asset for simplicity
        require(assets.length == amounts.length && amounts.length == premiums.length, "FS:ALA"); // Array lengths must match

        ArbParams memory decodedParams = abi.decode(params, (ArbParams));

        address tokenBorrowed = assets[0];
        uint amountBorrowed = amounts[0];
        uint feePaid = premiums[0]; // Aave V3 premium

        emit AaveArbitrageExecution(tokenBorrowed, amountBorrowed, feePaid);

        // --- Execute Swaps ---
        uint finalAmountReceived = _executeSwapPath(decodedParams.path);
        require(finalAmountReceived > 0, "FS:AZA"); // Should receive a positive amount after swaps

        // --- Repay Loan and Handle Profit ---
        uint totalAmountToRepay = amountBorrowed.add(feePaid);
        uint currentBalanceBorrowedTokenAfterSwaps = IERC20(tokenBorrowed).balanceOf(address(this));

        require(currentBalanceBorrowedTokenAfterSwaps >= totalAmountToRepay, "FS:IFR"); // Insufficient funds for repayment

        uint grossProfit = currentBalanceBorrowedTokenAfterSwaps > amountBorrowed ? currentBalanceBorrowedTokenAfterSwaps.sub(amountBorrowed) : 0;
        uint netProfit = currentBalanceBorrowedTokenAfterSwaps > totalAmountToRepay ? currentBalanceBorrowedTokenAfterSwaps.sub(totalAmountToRepay) : 0;

        // Approve Aave Pool to pull the repayment amount.
        // Aave handles the actual transfer when this function returns true.
        _approveSpenderIfNeeded(tokenBorrowed, address(AAVE_POOL), totalAmountToRepay);
        emit RepaymentSuccess(tokenBorrowed, totalAmountToRepay); // Event indicating funds are ready for repayment

        bytes32 pathHash = keccak256(params);
        emit TradeProfit(pathHash, tokenBorrowed, grossProfit, feePaid, netProfit);

        // Distribute Net Profit: 30% to Treasury, 70% to Owner
        if (netProfit > 0) {
            uint titheAmount = (netProfit * 30) / 100;
            uint ownerAmount = netProfit - titheAmount; // This implicitly gets 70%

             // Send tithe to treasury
            IERC20(tokenBorrowed).safeTransfer(TREASURY, titheAmount);
            emit TithePaid(tokenBorrowed, titheAmount);

            // Send remaining profit to owner
            IERC20(tokenBorrowed).safeTransfer(owner, ownerAmount);
            emit ProfitTransferred(tokenBorrowed, owner, ownerAmount); // Updated event to reflect owner's amount
        }

        return true; // Signal successful operation to Aave Pool
    }

    // --- Internal functions for UniV3 Flow ---
    function _executeTwoHopSwaps( address _tokenBorrowed, uint _amountBorrowed, bytes memory _params ) internal returns (uint finalAmount) {
        TwoHopParams memory arbParams = abi.decode(_params, (TwoHopParams));

        // Approve Router for the first swap (borrowed token -> intermediate token)
        _approveSpenderIfNeeded(_tokenBorrowed, address(SWAP_ROUTER), _amountBorrowed);
        uint amountIntermediateReceived = _executeSingleV3Swap(
            1, // Swap number 1
            _tokenBorrowed,
            arbParams.tokenIntermediate,
            arbParams.feeA,
            _amountBorrowed,
            arbParams.amountOutMinimum1
        );
        require(amountIntermediateReceived > 0, "FS:S1Z"); // First swap output zero

        // Approve Router for the second swap (intermediate token -> borrowed token)
        _approveSpenderIfNeeded(arbParams.tokenIntermediate, address(SWAP_ROUTER), amountIntermediateReceived);
        finalAmount = _executeSingleV3Swap(
            2, // Swap number 2
            arbParams.tokenIntermediate,
            _tokenBorrowed,
            arbParams.feeB,
            amountIntermediateReceived,
            arbParams.amountOutMinimum2
        );
         require(finalAmount > 0, "FS:S2Z"); // Second swap output zero
    }

    function _executeTriangularSwaps( address _tokenA, uint _amountA, bytes memory _params ) internal returns (uint finalAmount) {
        TriangularPathParams memory pathParams = abi.decode(_params, (TriangularPathParams));
        require(pathParams.tokenA == _tokenA, "FS:TPA"); // Ensure borrowed token matches expected start token

        // Swap 1: tokenA -> tokenB
        _approveSpenderIfNeeded(_tokenA, address(SWAP_ROUTER), _amountA);
        uint amountB = _executeSingleV3Swap(
            1, // Swap number 1
            _tokenA,
            pathParams.tokenB,
            pathParams.fee1,
            _amountA,
            0 // No minOut requirement for intermediate swaps usually
        );
        require(amountB > 0, "FS:TS1Z"); // First swap output zero

        // Swap 2: tokenB -> tokenC
        _approveSpenderIfNeeded(pathParams.tokenB, address(SWAP_ROUTER), amountB);
        uint amountC = _executeSingleV3Swap(
            2, // Swap number 2
            pathParams.tokenB,
            pathParams.tokenC,
            pathParams.fee2,
            amountB,
            0 // No minOut requirement for intermediate swaps usually
        );
        require(amountC > 0, "FS:TS2Z"); // Second swap output zero

        // Swap 3: tokenC -> tokenA (borrowed token)
        _approveSpenderIfNeeded(pathParams.tokenC, address(SWAP_ROUTER), amountC);
        finalAmount = _executeSingleV3Swap(
            3, // Swap number 3
            pathParams.tokenC,
            _tokenA, // Swap back to the borrowed token
            pathParams.fee3,
            amountC,
            pathParams.amountOutMinimumFinal // Apply minOut to the final swap
        );
         require(finalAmount > 0, "FS:TS3Z"); // Final swap output zero
    }

    // Executes a single swap using Uniswap V3's exactInputSingle function
    function _executeSingleV3Swap( uint _swapNumber, address _tokenIn, address _tokenOut, uint24 _fee, uint _amountIn, uint _amountOutMinimum ) internal returns (uint amountOut) {
        ISwapRouter.ExactInputSingleParams memory swapParams = ISwapRouter.ExactInputSingleParams({
            tokenIn: _tokenIn,
            tokenOut: _tokenOut,
            fee: _fee,
            recipient: address(this), // Send output tokens to this contract
            deadline: block.timestamp + DEADLINE_OFFSET,
            amountIn: _amountIn,
            amountOutMinimum: _amountOutMinimum,
            sqrtPriceLimitX96: 0 // No price limit
        });

        // Use try/catch to provide better error messages on swap failure
        try SWAP_ROUTER.exactInputSingle(swapParams) returns (uint _amountOut) {
            amountOut = _amountOut;
            emit SwapExecuted(_swapNumber, DEX_TYPE_UNISWAP_V3, _tokenIn, _tokenOut, _amountIn, amountOut);
        } catch Error(string memory reason) {
            revert(string(abi.encodePacked("FS:S", _numToString(_swapNumber) ,"F:", reason)));
        } catch {
            revert(string(abi.encodePacked("FS:S", _numToString(_swapNumber), "FL"))); // Fallback for non-string errors
        }
    }

        // --- _executeSwapPath (General path executor for Aave flash loans - supports DODO, Sushi, UniV3) ---
    // Executes a sequence of swaps defined by the _path array.
    function _executeSwapPath(SwapStep[] memory _path) internal returns (uint finalAmount) {
        // The initial amount is the balance of the first token in the path, which was borrowed
        // This balance is available *during* the flashloan execution.
        uint amountIn = IERC20(_path[0].tokenIn).balanceOf(address(this));
        require(amountIn > 0, "FS:PSA0"); // Amount in must be positive to start the path

        for (uint i = 0; i < _path.length; i++) {
            SwapStep memory step = _path[i];
            uint amountOut;

            // Approve the spender needed for this step's DEX
            // UniV3 uses the router for single swaps, Sushi uses its router, DODO needs the pool address
            address spender = step.dexType == DEX_TYPE_UNISWAP_V3 ? address(SWAP_ROUTER) :
                              step.dexType == DEX_TYPE_SUSHISWAP ? address(SUSHI_ROUTER) :
                              step.pool; // DODO uses the pool address as spender

            // We approve max uint256 to the spender. This is safe during a flashloan
            // because our balance of amountIn is exactly what was borrowed (or received from the previous swap).
            // If the spender misbehaves, it can only take the tokens currently held *for this swap step*.
            _approveSpenderIfNeeded(step.tokenIn, spender, amountIn);


            // Execute the swap based on the DEX type
            if (step.dexType == DEX_TYPE_UNISWAP_V3) {
                 // Note: fee from SwapStep struct is used by _executeSingleV3Swap
                amountOut = _executeSingleV3Swap(
                    i+1, // Swap number
                    step.tokenIn,
                    step.tokenOut,
                    step.fee, // V3 Fee from SwapStep
                    amountIn,
                    step.minOut
                );
            } else if (step.dexType == DEX_TYPE_SUSHISWAP) {
                // Sushiswap (Uniswap V2 compatible) uses a path array [tokenIn, tokenOut] for simple swaps
                address[] memory path = new address[](2);
                path[0] = step.tokenIn;
                path[1] = step.tokenOut;

                // Use try/catch for better error messages on swap failure
                try SUSHI_ROUTER.swapExactTokensForTokens(
                    amountIn,            // The exact amount of tokenIn to swap
                    step.minOut,         // The minimum amount of tokenOut to receive
                    path,                // The swap path (tokenIn -> tokenOut)
                    address(this),       // The recipient of the output tokens
                    block.timestamp + DEADLINE_OFFSET // The swap deadline
                ) returns (uint[] memory amounts) {
                    // The amounts array contains the amounts at each step of the path.
                    // For a 2-token path, amounts[0] is amountIn, amounts[1] is amountOut.
                    amountOut = amounts[amounts.length - 1]; // Get the last amount (the output)
                    emit SwapExecuted(i+1, DEX_TYPE_SUSHISWAP, step.tokenIn, step.tokenOut, amountIn, amountOut);
                } catch Error(string memory reason) {
                    revert(string(abi.encodePacked("FS:S", _numToString(i+1), "F:", reason))); // Sushi Swap Failed (string error)
                } catch {
                    revert(string(abi.encodePacked("FS:S", _numToString(i+1), "FL"))); // Sushi Swap Failed (Fallback)
                }
            } else if (step.dexType == DEX_TYPE_DODO) {
                // --- DODO Swaps (V1/V2 Pool Interaction) ---
                // Instantiate the DODO pool interface using the pool address from the SwapStep
                IDODOV1V2Pool dodoPool = IDODOV1V2Pool(step.pool);

                // Get the base and quote tokens of this specific DODO pool
                address baseToken = dodoPool.baseToken();
                address quoteToken = dodoPool.quoteToken();

                // Determine swap direction (sell base for quote, or buy base with quote)
                if (step.tokenIn == baseToken && step.tokenOut == quoteToken) {
                    // Selling Base token (step.tokenIn) for Quote token (step.tokenOut)
                    // The amountIn is the amount of baseToken we have to sell.
                    try dodoPool.sellBase(
                        amountIn,            // amountIn: The exact amount of base token to sell
                        step.minOut,         // minQuoteReceive: Minimum amount of quote token to receive
                        address(this),       // beneficiary: Recipient of the quote tokens
                        block.timestamp + DEADLINE_OFFSET // deadline
                    ) returns (uint256 receivedAmount) {
                        amountOut = receivedAmount; // The amount of quote token received
                        emit SwapExecuted(i+1, DEX_TYPE_DODO, step.tokenIn, step.tokenOut, amountIn, amountOut);
                    } catch Error(string memory reason) {
                        revert(string(abi.encodePacked("FS:D", _numToString(i+1), "SF:", reason))); // DODO Sell Failed (string error)
                    } catch {
                        revert(string(abi.encodePacked("FS:D", _numToString(i+1), "SFL"))); // DODO Sell Failed (Fallback)
                    }
                } else if (step.tokenIn == quoteToken && step.tokenOut == baseToken) {
                    // Buying Base token (step.tokenOut) with Quote token (step.tokenIn)
                    // The amountIn is the amount of quoteToken we have to use for buying base.
                     try dodoPool.buyBase(
                        amountIn,           // quoteBuyAmount: The exact amount of quote token to spend
                        step.minOut,        // minBaseReceive: Minimum amount of base token to receive
                        address(this),      // beneficiary: Recipient of the base tokens
                        block.timestamp + DEADLINE_OFFSET // deadline
                    ) returns (uint256 receivedAmount) {
                        amountOut = receivedAmount; // The amount of base token received
                        emit SwapExecuted(i+1, DEX_TYPE_DODO, step.tokenIn, step.tokenOut, amountIn, amountOut);
                    } catch Error(string memory reason) {
                         revert(string(abi.encodePacked("FS:D", _numToString(i+1), "BF:", reason))); // DODO Buy Failed (string error)
                    } catch {
                         revert(string(abi.encodePacked("FS:D", _numToString(i+1), "BFL"))); // DODO Buy Failed (Fallback)
                    }
                } else {
                    // The tokenIn/tokenOut pair provided in the SwapStep does not match the
                    // baseToken/quoteToken pair of the specified DODO pool address.
                    revert("FS:DODO_INVALID_PAIR");
                }
            } else {
                revert("FS:IDT"); // Invalid DEX Type provided in SwapStep
            }

            // After the swap, the amountIn for the *next* step is the amountOut received from *this* step.
            // The balance of step.tokenOut is now amountOut.
            amountIn = amountOut;
            // Crucially, ensure we received a non-zero amount from the swap for the path to continue.
            require(amountIn > 0, string(abi.encodePacked("FS:PS", _numToString(i+1), "Z"))); // Swap X output zero
        }

        // After the loop finishes, the final amount received is the output of the last swap.
        finalAmount = amountIn;
    }

    // --- Helper Functions ---
    // Checks current allowance and approves spender if it's less than max uint256.
    // Approves max uint256 to minimize approval transactions.
    function _approveSpenderIfNeeded(address _token, address _spender, uint _amount) internal {
         // If the amount to approve is zero, no need to do anything.
         // This check is mainly for clarity, as safeApprove(0, max) is usually fine.
         if (_amount == 0) {
             return;
         }

        // Check current allowance. If it's less than the maximum possible value,
        // approve the maximum value. This allows the spender to move any amount
        // up to the contract's balance of this token without needing future approvals.
        // Using type(uint256).max is standard practice for indefinite approvals.
        if (IERC20(_token).allowance(address(this), _spender) < type(uint256).max) {
             // safeApprove handles the check for zero allowance first internally for compatibility.
            IERC20(_token).safeApprove(_spender, type(uint256).max);
        }
        // Else: allowance is already type(uint256).max or sufficient, no action needed.
    }

     // Helper function to convert uint to string (used for error messages)
     // Required for Solidity 0.7.x as abi.encodePacked doesn't natively handle uint to string.
    function _numToString(uint _num) internal pure returns (string memory) {
        if (_num == 0) return "0";
        uint j = _num;
        uint len;
        while (j != 0) {
            len++;
            j /= 10;
        }
        bytes memory bstr = new bytes(len);
        uint k = len;
        while (_num != 0) {
            k = k-1;
            uint8 temp = (48 + uint8(_num % 10)); // Get the last digit as ASCII: _num % 10 is the digit, +48 converts it to ASCII char
            bytes1 b1 = bytes1(temp);
            bstr[k] = b1;
            _num /= 10;
        }
        return string(bstr);
    }


    // --- External Functions ---
    // Function called by the bot's off-chain logic to initiate a Uniswap V3 flash loan
    function initiateUniswapV3FlashLoan(
        CallbackType _callbackType, // Type of trade path (e.g., TWO_HOP, TRIANGULAR)
        address _poolAddress,      // The Uniswap V3 pool to borrow from
        uint _amount0,             // Amount of token0 to borrow (can be 0)
        uint _amount1,             // Amount of token1 to borrow (can be 0)
        bytes calldata _params     // Abi-encoded parameters specific to the callbackType
    ) external onlyOwner {
        // Fetch pool details to construct callback data
        IUniswapV3Pool pool = IUniswapV3Pool(_poolAddress);
        address token0 = pool.token0();
        address token1 = pool.token1();
        uint24 fee = pool.fee();

        // Encode data that will be passed to uniswapV3FlashCallback
        bytes memory data = abi.encode(
            FlashCallbackData({
                callbackType: _callbackType,
                amount0Borrowed: _amount0,
                amount1Borrowed: _amount1,
                caller: msg.sender, // The address that initiated this function call (the bot)
                poolBorrowedFrom: _poolAddress, // The specific V3 pool the loan came from
                token0: token0,
                token1: token1,
                fee: fee, // The fee tier of the pool
                params: _params // The specific trade path params encoded earlier by the bot
            })
        );

        emit FlashSwapInitiated(msg.sender, _poolAddress, _callbackType, _amount0, _amount1);

        // Execute the flash loan. This calls uniswapV3FlashCallback on this contract.
        // The amounts _amount0 and _amount1 are instantly available to this contract.
        pool.flash(address(this), _amount0, _amount1, data);
    }

    // Function called by the bot's off-chain logic to initiate an Aave V3 flash loan
    function initiateAaveFlashLoan(
        address _asset,         // The address of the asset to borrow
        uint _amount,          // The amount of the asset to borrow
        SwapStep[] calldata _path // The array of swap steps to execute for the arbitrage
    ) external onlyOwner {
        // Aave requires arrays for assets, amounts, and interest rate modes, even for a single asset loan
        address[] memory assets = new address[](1);
        assets[0] = _asset;

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = _amount;

        uint256[] memory modes = new uint256[](1);
        modes[0] = 0; // 0 = Stable interest rate mode (though for flash loans, interest is paid immediately)

        // Encode the swap path details to be passed to executeOperation
        bytes memory params = abi.encode(ArbParams({
            path: _path,
            initiator: msg.sender // The address that initiated this function call (the bot)
        }));

        emit AaveFlashLoanInitiated(msg.sender, _asset, _amount);

        // Execute the flash loan. This calls executeOperation on this contract.
        // The borrowed _amount of _asset is instantly available to this contract within executeOperation.
        AAVE_POOL.flashLoan(
            address(this), // receiverAddress: This contract
            assets,        // assets: Array containing the borrowed asset
            amounts,       // amounts: Array containing the borrowed amount
            modes,         // interestRateModes: 0 for stable (irrelevant for flashloan repayment)
            address(this), // onBehalfOf: This contract (the one taking the temporary debt)
            params,        // params: Arbitrary data (the encoded swap path)
            0              // referralCode
        );
    }

    // --- Emergency Functions ---
    // Allows the owner to withdraw any stranded ERC20 tokens from the contract.
    // Useful if tokens are accidentally sent directly or somehow remain after a failed trade.
    function emergencyWithdraw(address _token) external onlyOwner {
        uint balance = IERC20(_token).balanceOf(address(this));
        require(balance > 0, "FS:NW"); // Nothing to withdraw
        IERC20(_token).safeTransfer(owner, balance);
        emit EmergencyWithdrawal(_token, owner, balance);
    }

    // Allows the owner to withdraw any stranded Ether from the contract.
    // Useful if ETH is accidentally sent directly.
    function emergencyWithdrawETH() external onlyOwner {
        uint balance = address(this).balance;
        require(balance > 0, "FS:NWE"); // Nothing to withdraw
        owner.transfer(balance);
        emit EmergencyWithdrawal(address(0), owner, balance); // Use address(0) for ETH token address
    }

    // --- Fallback ---
    // Receive function: Allows the contract to receive Ether.
    // Needed if the owner uses emergencyWithdrawETH or if ETH is sent directly.
    receive() external payable {}
}
