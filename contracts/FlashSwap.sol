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
interface IPool { function flashLoan( address receiverAddress, address[] calldata assets, uint256[] calldata amounts, uint256[] caldata interestRateModes, address onBehalfOf, bytes calldata params, uint16 referralCode ) external; }
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
                // Sushiswap uses a path array [tokenIn, tokenOut] for simple swaps
                address[] memory path = new address[](2);
                path[0] = step.tokenIn;
                path[1] = step.tokenOut;

                // Use try/catch for better error messages on swap failure
                try SUSHI_ROUTER.swapExactTokensForTokens(
                    amountIn,
                    step.minOut,
                    path,
                    address(this), // Send output tokens to this contract
                    block.timestamp + DEADLINE_OFFSET
                ) returns (uint[] memory amounts) {
                    // The last element in amounts is the amount of the output token received
                    amountOut = amounts[amounts.length - 1];
                    emit SwapExecuted(i+1, DEX_TYPE_SUSHISWAP, step.tokenIn, step.tokenOut, amountIn, amountOut);
                } catch Error(string memory reason) {
                    revert(string(abi.encodePacked("FS:S", _numToString(i+1), "F:", reason)));
                } catch {
                    revert(string(abi.encodePacked("FS:S", _numToString(i+1), "FL"))); // Fallback for non-string errors
                }
            } else if (step.dexType == DEX_TYPE_DODO) {
                // --- DODO Swaps (Currently Disabled) ---
                // Integrate DODO swap logic here if enabling. It typically involves calling
                // a buy/sell function directly on the DODO pool contract (step.pool).
                // Example (replace with actual DODO pool interface calls):
                // IDODOV1V2Pool dodoPool = IDODOV1V2Pool(step.pool);
                // // Determine buy or sell based on tokenIn/tokenOut relative to base/quote
                // // Need logic here to figure out if it's a buy or sell operation and call the right function.
                // // This requires knowing the base and quote tokens of the DODO pool and the
