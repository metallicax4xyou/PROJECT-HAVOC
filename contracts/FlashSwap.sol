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
import "./interfaces/IDODOV1V2Pool.sol"; // Import your DODO interface

// --- Aave Imports ---
// Standard Aave Pool interface for flash loans
interface IPool {
    function flashLoan(
        address receiverAddress,
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata interestRateModes,
        address onBehalfOf,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

// Standard Aave Flash Loan Receiver interface
// NOTE: We need to implement ADDRESSES_PROVIDER and POOL functions
interface IFlashLoanReceiver {
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external returns (bool);

    // These two functions are required by the interface but not used in our logic.
    // We will add minimal implementations returning our state variables.
    function ADDRESSES_PROVIDER() external view returns (address);
    function POOL() external view returns (address);
}


// --- Contract Definition ---
// --- VERSION v3.13 --- Fixed Aave interface methods, temporarily disabled DODO execution for compile
contract FlashSwap is IUniswapV3FlashCallback, IFlashLoanReceiver, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;

    // --- State Variables ---
    ISwapRouter public immutable SWAP_ROUTER; // Uniswap V3 Swap Router
    IUniswapV2Router02 public immutable SUSHI_ROUTER; // SushiSwap Router (V2 compatible)
    address payable public immutable owner; // The contract deployer/owner
    address public immutable V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984; // Uniswap V3 Factory Address (Arbitrum Mainnet)
    IPool public immutable AAVE_POOL; // Aave V3 Pool contract instance
    address public immutable AAVE_ADDRESSES_PROVIDER; // Aave Addresses Provider address
    uint constant DEADLINE_OFFSET = 60; // Swap deadline in seconds from block.timestamp (e.g., 60 seconds)
    // Address to receive 30% of net profit (the "tithe")
    address public constant TREASURY = 0x50d3414C549a0A9Df8d29eD5872FDaEf97d6748d;


    // --- DEX Type Constants ---
    uint8 constant DEX_TYPE_UNISWAP_V3 = 0;
    uint8 constant DEX_TYPE_SUSHISWAP = 1;
    uint8 constant DEX_TYPE_DODO = 2; // Kept for code structure

    // --- Structs ---
    enum CallbackType { TWO_HOP, TRIANGULAR } // Types of UniV3-specific flash loan paths
    struct FlashCallbackData { CallbackType callbackType; uint amount0Borrowed; uint amount1Borrowed; address caller; address poolBorrowedFrom; address token0; address token1; uint24 fee; bytes params; }
    struct TwoHopParams { address tokenIntermediate; uint24 feeA; uint24 feeB; uint amountOutMinimum1; uint amountOutMinimum2; }
    struct TriangularPathParams { address tokenA; address tokenB; address tokenC; uint24 fee1; uint24 fee2; uint24 fee3; uint amountOutMinimumFinal; }
    // SwapStep definition for generic Aave flash loan paths
    // 'pool' is the specific pool address for DODO steps, not used for Router-based swaps (UniV3, Sushi)
    // 'fee' is only relevant for UniV3 steps
    struct SwapStep { address pool; address tokenIn; address tokenOut; uint24 fee; uint256 minOut; uint8 dexType; }
    struct ArbParams { SwapStep[] path; address initiator; } // Parameters passed to Aave's executeOperation

    // --- Events ---
    event FlashSwapInitiated(address indexed caller, address indexed pool, CallbackType tradeType, uint amount0, uint amount1);
    event AaveFlashLoanInitiated(address indexed caller, address indexed asset, uint amount);
    event AaveArbitrageExecution(address indexed tokenBorrowed, uint amountBorrowed, uint feePaid);
    event ArbitrageExecution(CallbackType indexed tradeType, address indexed tokenBorrowed, uint amountBorrowed, uint feePaid);
    event SwapExecuted(uint swapNumber, uint8 dexType, address indexed tokenIn, address indexed tokenOut, uint amountIn, uint amountOut);
    event RepaymentSuccess(address indexed token, uint amountRepaid);
    event ProfitTransferred(address indexed token, address indexed recipient, uint amount); // Emits amount sent to owner
    event EmergencyWithdrawal(address indexed token, address indexed recipient, uint amount);
    event TradeProfit(bytes32 indexed pathHash, address indexed token, uint grossProfit, uint feesPaid, uint netProfit);
    event TithePaid(address indexed token, uint amount); // Emits amount sent to treasury


    // --- Modifiers ---
    modifier onlyOwner() { require(msg.sender == owner || tx.origin == owner, "FS:NA"); _; } // Only owner or tx.origin can call


    // --- Constructor ---
    // Initializes immutable state variables upon contract deployment
    constructor(
        address _uniswapV3Router,
        address _sushiRouter,
        address _aavePoolAddress,
        address _aaveAddressesProvider // Aave addresses provider needed for IFlashLoanReceiver interface requirement
    ) {
        require(_uniswapV3Router != address(0), "FS:IUR"); // Invalid Uniswap V3 Router address
        require(_sushiRouter != address(0), "FS:ISR"); // Invalid SushiSwap Router address
        require(_aavePoolAddress != address(0), "FS:IAP"); // Invalid Aave Pool address
        require(_aaveAddressesProvider != address(0), "FS:IAAP"); // Invalid Aave Addresses Provider address

        SWAP_ROUTER = ISwapRouter(_uniswapV3Router);
        SUSHI_ROUTER = IUniswapV2Router02(_sushiRouter);
        AAVE_POOL = IPool(_aavePoolAddress);
        AAVE_ADDRESSES_PROVIDER = _aaveAddressesProvider; // Store this to satisfy IFlashLoanReceiver interface
        owner = payable(msg.sender);
    }

    // --- Aave IFlashLoanReceiver Interface Implementations ---
    // These functions are required by the IFlashLoanReceiver interface
    // but aren't logically used by the Aave V3 pool calling executeOperation.
    // We implement them minimally to satisfy the interface requirements.

    function ADDRESSES_PROVIDER() external view override returns (address) {
        return AAVE_ADDRESSES_PROVIDER;
    }

    function POOL() external view override returns (address) {
        return address(AAVE_POOL);
    }


    // --- Uniswap V3 Flash Callback ---
    // Called by Uniswap V3 pool after successful flash loan
    // msg.sender is the Uniswap V3 pool contract
    function uniswapV3FlashCallback( uint256 fee0, uint256 fee1, bytes calldata data ) external override nonReentrant {
        FlashCallbackData memory decodedData = abi.decode(data, (FlashCallbackData));

        // Validate callback: Ensure the call came from the expected pool and is a valid callback.
        PoolAddress.PoolKey memory poolKey = PoolAddress.PoolKey({ token0: decodedData.token0, token1: decodedData.token1, fee: decodedData.fee });
        require(msg.sender == decodedData.poolBorrowedFrom, "FS:CBW"); // Callback from wrong pool
        CallbackValidation.verifyCallback(V3_FACTORY, poolKey); // Verify the call is valid from a V3 pool factory perspective

        address tokenBorrowed;
        uint amountBorrowed;
        uint totalAmountToRepay;
        uint feePaid;

        // Determine which token was borrowed and calculate repayment amount (borrowed amount + fee)
        // UniV3 flash loans can borrow either token0 or token1, but not both simultaneously.
        if (decodedData.amount1Borrowed > 0) {
            require(decodedData.amount0Borrowed == 0, "FS:BTB"); // Cannot borrow both tokens
            tokenBorrowed = decodedData.token1;
            amountBorrowed = decodedData.amount1Borrowed;
            feePaid = fee1; // fee1 is the fee amount for borrowing token1
            totalAmountToRepay = amountBorrowed.add(feePaid);
        } else { // decodedData.amount0Borrowed > 0
            require(decodedData.amount1Borrowed == 0 && decodedData.amount0Borrowed > 0, "FS:BNA"); // Cannot borrow both tokens
            tokenBorrowed = decodedData.token0;
            amountBorrowed = decodedData.amount0Borrowed;
            feePaid = fee0; // fee0 is the fee amount for borrowing token0
            totalAmountToRepay = amountBorrowed.add(feePaid);
        }

        emit ArbitrageExecution(decodedData.callbackType, tokenBorrowed, amountBorrowed, feePaid);

        // --- Execute Swaps ---
        // The core arbitrage logic happens here using the borrowed funds
        uint finalAmountReceived;
        if (decodedData.callbackType == CallbackType.TRIANGULAR) {
            // Execute a 3-hop triangular path within UniV3
            finalAmountReceived = _executeTriangularSwaps(tokenBorrowed, amountBorrowed, decodedData.params);
        } else if (decodedData.callbackType == CallbackType.TWO_HOP) {
            // Execute a 2-hop UniV3 path (borrow -> intermediate -> borrow)
            finalAmountReceived = _executeTwoHopSwaps(tokenBorrowed, amountBorrowed, decodedData.params);
        } else {
            revert("FS:UCT"); // Unknown callback type provided in data
        }

        // --- Repay Loan and Handle Profit ---
        // Get the current balance of the borrowed token after all swaps are complete
        uint currentBalanceBorrowedToken = IERC20(tokenBorrowed).balanceOf(address(this));
        require(currentBalanceBorrowedToken >= totalAmountToRepay, "FS:IFR"); // Insufficient funds to repay the flash loan

        // Calculate gross and net profit
        uint grossProfit = currentBalanceBorrowedToken > amountBorrowed ? currentBalanceBorrowedToken.sub(amountBorrowed) : 0;
        uint netProfit = currentBalanceBorrowedToken > totalAmountToRepay ? currentBalanceBorrowedToken.sub(totalAmountToRepay) : 0;

        // Repay the loan by transferring the required amount back to the Uniswap V3 pool (msg.sender)
        IERC20(tokenBorrowed).safeTransfer(msg.sender, totalAmountToRepay);
        emit RepaymentSuccess(tokenBorrowed, totalAmountToRepay);

        // Emit trade profit details for off-chain logging/analysis
        bytes32 pathHash = keccak256(decodedData.params); // Use params hash to uniquely identify the path
        emit TradeProfit(pathHash, tokenBorrowed, grossProfit, feePaid, netProfit);

        // Distribute Net Profit: 30% to Treasury, 70% to Owner (if net profit > 0)
        if (netProfit > 0) {
            uint titheAmount = (netProfit * 30) / 100; // Calculate 30% tithe
            uint ownerAmount = netProfit - titheAmount; // Remaining 70% for the owner

            // Send tithe amount to the predefined treasury address
            IERC20(tokenBorrowed).safeTransfer(TREASURY, titheAmount);
            emit TithePaid(tokenBorrowed, titheAmount); // Log the tithe payment

            // Send the remaining profit to the contract owner
            IERC20(tokenBorrowed).safeTransfer(owner, ownerAmount);
            emit ProfitTransferred(tokenBorrowed, owner, ownerAmount); // Log the owner profit payment
        }
    }

    // --- AAVE V3 Flash Loan Callback ---
    // Called by Aave Pool after successful flash loan
    // msg.sender is the Aave Pool contract
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external override nonReentrant returns (bool) {
        // Validate callback: Ensure the call is from the Aave Pool and initiated by this contract.
        require(msg.sender == address(AAVE_POOL), "FS:CBA"); // Must be called by the Aave Pool
        require(initiator == address(this), "FS:IFI"); // The 'initiator' must be this contract (passed in flashLoan call)
        require(assets.length == 1, "FS:MA"); // Currently supports flash loans of only one asset for simplicity
        require(assets.length == amounts.length && amounts.length == premiums.length, "FS:ALA"); // Array lengths must match

        ArbParams memory decodedParams = abi.decode(params, (ArbParams));

        address tokenBorrowed = assets[0];
        uint amountBorrowed = amounts[0];
        uint feePaid = premiums[0]; // Aave V3 premium (fee) for the flash loan

        emit AaveArbitrageExecution(tokenBorrowed, amountBorrowed, feePaid);

        // --- Execute Swaps ---
        // Execute the generic swap path defined in the ArbParams
        uint finalAmountReceived = _executeSwapPath(decodedParams.path);
        require(finalAmountReceived > 0, "FS:AZA"); // Should receive a positive amount after swaps

        // --- Repay Loan and Handle Profit ---
        // Get the current balance of the borrowed token after all swaps are complete
        uint totalAmountToRepay = amountBorrowed.add(feePaid);
        uint currentBalanceBorrowedTokenAfterSwaps = IERC20(tokenBorrowed).balanceOf(address(this));

        require(currentBalanceBorrowedTokenAfterSwaps >= totalAmountToRepay, "FS:IFR"); // Insufficient funds to repay the flash loan

        // Approve Aave Pool to pull the repayment amount.
        // Aave handles the actual transfer of funds for repayment after executeOperation returns true.
        _approveSpenderIfNeeded(tokenBorrowed, address(AAVE_POOL), totalAmountToRepay);
        emit RepaymentSuccess(tokenBorrowed, totalAmountToRepay); // Event indicating funds are available/approved for repayment

        // Emit trade profit details for off-chain logging/analysis
        bytes32 pathHash = keccak256(params); // Use params hash to uniquely identify the path
        emit TradeProfit(pathHash, tokenBorrowed, grossProfit, feePaid, netProfit);

        // Distribute Net Profit: 30% to Treasury, 70% to Owner (if net profit > 0)
        if (netProfit > 0) {
            uint titheAmount = (netProfit * 30) / 100; // Calculate 30% tithe
            uint ownerAmount = netProfit - titheAmount; // Remaining 70% for the owner

             // Send tithe amount to the predefined treasury address
            IERC20(tokenBorrowed).safeTransfer(TREASURY, titheAmount);
            emit TithePaid(tokenBorrowed, titheAmount); // Log the tithe payment

            // Send the remaining profit to the contract owner
            IERC20(tokenBorrowed).safeTransfer(owner, ownerAmount);
            emit ProfitTransferred(tokenBorrowed, owner, ownerAmount); // Log the owner profit payment
        }

        return true; // Signal successful operation to Aave Pool
    }

// --- END OF PART 1 ---
    // --- Internal functions for UniV3 Flash Loan Flow ---
    // Executes a 2-hop swap sequence: BorrowedToken -> IntermediateToken -> BorrowedToken
    function _executeTwoHopSwaps( address _tokenBorrowed, uint _amountBorrowed, bytes memory _params ) internal returns (uint finalAmount) {
        TwoHopParams memory arbParams = abi.decode(_params, (TwoHopParams));

        // Swap 1: Borrowed Token -> Intermediate Token
        // Approve Router for the first swap
        _approveSpenderIfNeeded(_tokenBorrowed, address(SWAP_ROUTER), _amountBorrowed);
        uint amountIntermediateReceived = _executeSingleV3Swap(
            1, // Swap number 1
            _tokenBorrowed,
            arbParams.tokenIntermediate,
            arbParams.feeA,
            _amountBorrowed,
            arbParams.amountOutMinimum1 // Apply minOut from params
        );
        require(amountIntermediateReceived > 0, "FS:S1Z"); // First swap output zero

        // Swap 2: Intermediate Token -> Borrowed Token (Repayment Token)
        // Approve Router for the second swap
        _approveSpenderIfNeeded(arbParams.tokenIntermediate, address(SWAP_ROUTER), amountIntermediateReceived);
        finalAmount = _executeSingleV3Swap(
            2, // Swap number 2
            arbParams.tokenIntermediate,
            _tokenBorrowed, // Swap back to the original borrowed token
            arbParams.feeB,
            amountIntermediateReceived,
            arbParams.amountOutMinimum2 // Apply minOut from params
        );
         require(finalAmount > 0, "FS:S2Z"); // Second swap output zero

         // The contract now holds 'finalAmount' of the borrowed token, plus any initial balance.
         // The total balance is checked against totalAmountToRepay in uniswapV3FlashCallback.
    }

    // Executes a 3-hop swap sequence: TokenA -> TokenB -> TokenC -> TokenA (where TokenA is the borrowed token)
    function _executeTriangularSwaps( address _tokenA, uint _amountA, bytes memory _params ) internal returns (uint finalAmount) {
        TriangularPathParams memory pathParams = abi.decode(_params, (TriangularPathParams));
        require(pathParams.tokenA == _tokenA, "FS:TPA"); // Ensure the first token in the path is the borrowed token

        // Swap 1: Token A -> Token B
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

        // Swap 2: Token B -> Token C
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

        // Swap 3: Token C -> Token A (Borrowed Token)
        _approveSpenderIfNeeded(pathParams.tokenC, address(SWAP_ROUTER), amountC);
        finalAmount = _executeSingleV3Swap(
            3, // Swap number 3
            pathParams.tokenC,
            _tokenA, // Swap back to the original borrowed token
            pathParams.fee3,
            amountC,
            pathParams.amountOutMinimumFinal // Apply minOut to the final swap
        );
         require(finalAmount > 0, "FS:TS3Z"); // Final swap output zero

        // The contract now holds 'finalAmount' of the borrowed token, plus any initial balance.
        // The total balance is checked against totalAmountToRepay in uniswapV3FlashCallback.
    }

    // Executes a single swap using Uniswap V3's exactInputSingle function
    function _executeSingleV3Swap( uint _swapNumber, address _tokenIn, address _tokenOut, uint24 _fee, uint _amountIn, uint _amountOutMinimum ) internal returns (uint amountOut) {
        // Prepare parameters for the Uniswap V3 router call
        ISwapRouter.ExactInputSingleParams memory swapParams = ISwapRouter.ExactInputSingleParams({
            tokenIn: _tokenIn,
            tokenOut: _tokenOut,
            fee: _fee, // The fee tier of the pool
            recipient: address(this), // Send output tokens to this contract
            deadline: block.timestamp + DEADLINE_OFFSET, // Transaction deadline
            amountIn: _amountIn, // The exact amount of tokenIn to swap
            amountOutMinimum: _amountOutMinimum, // The minimum amount of tokenOut to receive
            sqrtPriceLimitX96: 0 // No price limit (accept current price execution)
        });

        // Use try/catch to provide better error messages on swap failure
        // This helps in debugging specific swap issues.
        try SWAP_ROUTER.exactInputSingle(swapParams) returns (uint _amountOut) {
            amountOut = _amountOut; // Store the actual received amount
            emit SwapExecuted(_swapNumber, DEX_TYPE_UNISWAP_V3, _tokenIn, _tokenOut, _amountIn, amountOut); // Log successful swap
        } catch Error(string memory reason) {
            // Revert with a specific error message indicating swap number and the reason
            revert(string(abi.encodePacked("FS:S", _numToString(_swapNumber) ,"F:", reason))); // Swap Failed (string error)
        } catch {
            // Revert with a generic error message if the catch doesn't provide a string reason
            revert(string(abi.encodePacked("FS:S", _numToString(_swapNumber), "FL"))); // Swap Failed (Fallback)
        }
    }

    // --- _executeSwapPath (General path executor for Aave flash loans - supports DODO, Sushi, UniV3, Camelot) ---
    // Executes a sequence of swaps defined by the _path array.
    function _executeSwapPath(SwapStep[] memory _path) internal returns (uint finalAmount) {
        // The initial amount is the balance of the first token in the path, which was borrowed via Aave.
        // This balance is available *during* the executeOperation callback.
        uint amountIn = IERC20(_path[0].tokenIn).balanceOf(address(this));
        require(amountIn > 0, "FS:PSA0"); // Amount in must be positive to start the path

        for (uint i = 0; i < _path.length; i++) {
            SwapStep memory step = _path[i];
            uint amountOut;

            // Approve the spender needed for this step's DEX
            // UniV3 uses the router for single swaps, Sushi uses its router, DODO/Camelot need the pool address
            address spender;
            if (step.dexType == DEX_TYPE_UNISWAP_V3) {
                spender = address(SWAP_ROUTER);
            } else if (step.dexType == DEX_TYPE_SUSHISWAP) {
                 spender = address(SUSHI_ROUTER);
            }
            // Add condition for Camelot if it uses a router vs direct pool interaction
            // else if (step.dexType == DEX_TYPE_CAMELOT) { ... }
             else if (step.dexType == DEX_TYPE_DODO) {
                 spender = step.pool; // DODO uses the pool address as spender
             }
             else {
                 revert("FS:IDT_APPROVE"); // Invalid DEX Type for approval
             }

            // Approve max uint256 to the spender. This is safe during a flashloan
            // because our balance of amountIn is exactly what was borrowed (or received from the previous swap).
            _approveSpenderIfNeeded(step.tokenIn, spender, amountIn);


            // Execute the swap based on the DEX type
            if (step.dexType == DEX_TYPE_UNISWAP_V3) {
                 // Note: fee from SwapStep struct is used by _executeSingleV3Swap
                amountOut = _executeSingleV3Swap(
                    i+1, // Swap number
                    step.tokenIn,
                    step.tokenOut,
                    step.fee, // V3 Fee from SwapStep struct
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
                    amountIn,            // amountIn: The exact amount of tokenIn to swap
                    step.minOut,         // amountOutMin: The minimum amount of tokenOut to receive
                    path,                // path: The swap path [tokenIn, tokenOut]
                    address(this),       // to: The recipient of the output tokens
                    block.timestamp + DEADLINE_OFFSET // deadline
                ) returns (uint[] memory amounts) {
                    // The amounts array contains the amounts at each step of the path.
                    // For a 2-token path, amounts[0] is amountIn, amounts[1] is amountOut.
                    amountOut = amounts[amounts.length - 1]; // Get the last amount (the output)
                    emit SwapExecuted(i+1, DEX_TYPE_SUSHISWAP, step.tokenIn, step.tokenOut, amountIn, amountOut); // Log successful swap
                } catch Error(string memory reason) {
                    revert(string(abi.encodePacked("FS:S", _numToString(i+1), "SF:", reason))); // Sushi Swap Failed (string error)
                } catch {
                    revert(string(abi.encodePacked("FS:S", _numToString(i+1), "SFL"))); // Sushi Swap Failed (Fallback)
                }
            } else if (step.dexType == DEX_TYPE_DODO) {
                // --- DODO Swaps (V1/V2 Pool Interaction) ---
                // Temporarily disabled DODO functionality due to interface mismatch error.
                // To enable, update the IDODOV1V2Pool interface in ./interfaces/IDODOV1V2Pool.sol
                // to match the specific DODO pool type you are using, or implement an
                // alternative method to determine base/quote tokens for the pool address (step.pool).
                revert("FS:DODO_TEMP_DISABLED"); // Re-added temporary disable for compilation
                /*
                // Instantiate the DODO pool interface using the pool address from the SwapStep
                IDODOV1V2Pool dodoPool = IDODOV1V2Pool(step.pool);

                 // --- IMPORTANT: VERIFY DODO POOL INTERFACE ---
                 // The following calls assume IDODOV1V2Pool has `baseToken()` and `quoteToken()`
                 // view functions returning the base and quote token addresses.
                 // If your DODO pools use different function names or structure,
                 // you must update the IDODOV1V2Pool.sol interface file accordingly.
                 // Example: If base token is called `tokenA` and quote is `tokenB`:
                 // address baseToken = dodoPool.tokenA();
                 // address quoteToken = dodoPool.tokenB();
                 // ------------------------------------------
                 // Placeholder - Replace with actual function calls if they are different!
                 // For now, assuming standard baseToken() and quoteToken() exist:
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
                        emit SwapExecuted(i+1, DEX_TYPE_DODO, step.tokenIn, step.tokenOut, amountIn, amountOut); // Log successful swap
                    } catch Error(string memory reason) {
                        revert(string(abi.encodePacked("FS:D", _numToString(i+1), "SF:", reason))); // DODO Sell Failed (string error)
                    } catch {
                        revert(string(abi.encodePacked("FS:D", _numToString(i+1), "SFL"))); // DODO Sell Failed (Fallback)
                    }
                } else if (step.tokenIn == quoteToken && step.tokenOut == baseToken) {
                    // Buying Base token (step.tokenout) with Quote token (step.tokenIn)
                    // The amountIn is the amount of quoteToken we have to use for buying base.
                     try dodoPool.buyBase(
                        amountIn,           // quoteBuyAmount: The exact amount of quote token to spend
                        step.minOut,        // minBaseReceive: Minimum amount of base token to receive
                        address(this),      // beneficiary: Recipient of the base tokens
                        block.timestamp + DEADLINE_OFFSET // deadline
                    ) returns (uint256 receivedAmount) {
                        amountOut = receivedAmount; // The amount of base token received
                        emit SwapExecuted(i+1, DEX_TYPE_DODO, step.tokenIn, step.tokenOut, amountIn, amountOut); // Log successful swap
                    } catch Error(string memory reason) {
                         revert(string(abi.encodePacked("FS:D", _numToString(i+1), "BF:", reason))); // DODO Buy Failed (string error)
                    } catch {
                         revert(string(abi.encodePacked("FS:D", _numToString(i+1), "BFL"))); // DODO Buy Failed (Fallback)
                    }
                } else {
                    // The tokenIn/tokenOut pair provided in the SwapStep does not match the
                    // baseToken/quoteToken pair of the specified DODO pool address.
                    revert("FS:DODO_INVALID_PAIR"); // Mismatch between swap step tokens and DODO pool base/quote
                }
                */
            } else {
                revert("FS:IDT_EXEC"); // Invalid DEX Type provided in SwapStep for execution
            }

            // After the swap, the amountIn for the *next* step is the amountOut received from *this* step.
            // The balance of step.tokenOut (which is the next step's tokenIn) is now amountOut.
            amountIn = amountOut;
            // Crucially, ensure we received a non-zero amount from the swap for the path to continue.
            require(amountIn > 0, string(abi.encodePacked("FS:PS", _numToString(i+1), "Z"))); // Path Step X output zero - swap failed to produce output
        }

        // After the loop finishes, the final amount received is the output of the last swap.
        finalAmount = amountIn;
    }


    // --- Helper Functions ---
    // Checks current allowance and approves spender if it's less than max uint256.
    // Approves max uint256 to minimize approval transactions for frequent spenders (like routers).
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
             // safeApprove handles the check for zero allowance first internally for compatibility with older tokens.
             // Most modern tokens and routers/pools are fine with approving max directly.
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
        // Fetch pool details from the V3 pool contract to construct callback data
        IUniswapV3Pool pool = IUniswapV3Pool(_poolAddress);
        address token0 = pool.token0();
        address token1 = pool.token1();
        uint24 fee = pool.fee();

        // Encode data that will be passed back to the uniswapV3FlashCallback function
        bytes memory data = abi.encode(
            FlashCallbackData({
                callbackType: _callbackType,
                amount0Borrowed: _amount0,
                amount1Borrowed: _amount1,
                caller: msg.sender, // The address that initiated this function call (the bot's EOA or a relay)
                poolBorrowedFrom: _poolAddress, // The specific V3 pool the loan came from
                token0: token0,
                token1: token1,
                fee: fee, // The fee tier of the pool
                params: _params // The specific trade path params encoded earlier by the bot (e.g., TwoHopParams)
            })
        );

        emit FlashSwapInitiated(msg.sender, _poolAddress, _callbackType, _amount0, _amount1);

        // Execute the flash loan. The V3 pool calls uniswapV3FlashCallback on this contract,
        // providing the borrowed amounts and the 'data'.
        pool.flash(address(this), _amount0, _amount1, data);
    }

    // Function called by the bot's off-chain logic to initiate an Aave V3 flash loan
    function initiateAaveFlashLoan(
        address _asset,         // The address of the asset to borrow from Aave
        uint _amount,          // The amount of the asset to borrow
        SwapStep[] calldata _path // The array of swap steps to execute for the arbitrage using the borrowed asset
    ) external onlyOwner {
                // Aave V3 flashLoan requires arrays for assets, amounts, and interest rate modes,
        // even if you're only borrowing a single asset.
        address[] memory assets = new address[](1);
        assets[0] = _asset;

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = _amount;

        uint256[] memory modes = new uint256[](1);
        modes[0] = 0; // 0 = Stable interest rate mode. For flash loans, interest is paid in the same transaction, so this mode is effectively irrelevant for the borrowing.

        // Encode the swap path details and the initiator's address to be passed to executeOperation
        bytes memory params = abi.encode(ArbParams({
            path: _path,
            initiator: msg.sender // The address that initiated this function call (the bot's EOA or a relay)
        }));

        emit AaveFlashLoanInitiated(msg.sender, _asset, _amount);

        // Execute the flash loan. The Aave Pool calls executeOperation on this contract,
        // providing the borrowed asset(s), amount(s), premium(s), initiator, and params.
        AAVE_POOL.flashLoan(
            address(this), // receiverAddress: The contract that will receive the borrowed funds and execute operations (this contract)
            assets,        // assets: Array containing the borrowed asset address
            amounts,       // amounts: Array containing the borrowed amount
            modes,         // interestRateModes: 0 for stable (standard for flashloans)
            address(this), // onBehalfOf: The address that will ultimately repay the loan (this contract)
            params,        // params: Arbitrary data (the encoded swap path + initiator)
            0              // referralCode: Optional referral code
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
    // Useful if ETH is accidentally sent directly to the contract address.
    function emergencyWithdrawETH() external onlyOwner {
        uint balance = address(this).balance;
        require(balance > 0, "FS:NWE"); // Nothing to withdraw
        // Transfer ETH to the owner's address
        // owner is declared as payable(msg.sender) in the constructor, so it can receive ETH.
        owner.transfer(balance);
        emit EmergencyWithdrawal(address(0), owner, balance); // Use address(0) convention for ETH
    }

    // --- Fallback ---
    // Receive function: Allows the contract to receive Ether.
    // It's important for emergencyWithdrawETH to work and allows receiving accidental ETH sends.
    receive() external payable {}
} 
