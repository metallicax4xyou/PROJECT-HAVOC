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

// --- AAVE V3 Imports ---
// Minimal interface for IPool:
interface IPool {
    function flashLoan(
        address receiverAddress,
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata interestRateModes, // 0: none, 1: stable, 2: variable
        address onBehalfOf,
        bytes calldata params,
        uint16 referralCode
    ) external;
}
// Minimal interface for IFlashLoanReceiver:
interface IFlashLoanReceiver {
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums, // Fee amounts
        address initiator,
        bytes calldata params
    ) external returns (bool);

    function ADDRESSES_PROVIDER() external view returns (address);
    function POOL() external view returns (address);
}
// --- End AAVE V3 Imports ---


// --- UPDATED CONTRACT DEFINITION ---
contract FlashSwap is IUniswapV3FlashCallback, IFlashLoanReceiver, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;

    // --- State Variables ---
    ISwapRouter public immutable SWAP_ROUTER; // Assumed to be UniV3 Router
    address public immutable owner;
    address public immutable V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    IPool public immutable AAVE_POOL; // <<< ADDED
    uint constant DEADLINE_OFFSET = 60; // Seconds

    // --- Structs for UniV3 Flow ---
    enum CallbackType { TWO_HOP, TRIANGULAR } // May become obsolete if unifying flow
    struct FlashCallbackData { CallbackType callbackType; uint amount0Borrowed; uint amount1Borrowed; address caller; address poolBorrowedFrom; address token0; address token1; uint24 fee; bytes params; }
    struct TwoHopParams { address tokenIntermediate; address poolA; uint24 feeA; address poolB; uint24 feeB; uint amountOutMinimum1; uint amountOutMinimum2; }
    struct TriangularPathParams { address pool1; address pool2; address pool3; address tokenA; address tokenB; address tokenC; uint24 fee1; uint24 fee2; uint24 fee3; uint amountOutMinimumFinal; }

    // --- NEW Structs for Generic Path Encoding (used by Aave flow) ---
    struct SwapStep {
        // address dex; // Router/Pool address - determine based on dexType?
        address pool; // Pool address for the hop
        address tokenIn;
        address tokenOut;
        uint24 fee; // Optional; only relevant to UniV3
        uint256 minOut; // Slippage protection for this step
        uint8 dexType; // 0 = UniV3, 1 = Sushi, 2 = DODO, etc.
    }
    struct ArbParams {
        SwapStep[] path; // The sequence of swaps to execute
        address initiator; // Original EOA caller (passed from JS)
    }
    // ****** START OF PART 2 ******

    // --- Events ---
    event FlashSwapInitiated(address indexed caller, address indexed pool, CallbackType tradeType, uint amount0, uint amount1);
    // Added Aave specific events
    event AaveFlashLoanInitiated(address indexed caller, address indexed asset, uint amount);
    event AaveArbitrageExecution(address indexed tokenBorrowed, uint amountBorrowed, uint feePaid);
    // Generic events (reused)
    event ArbitrageExecution(CallbackType indexed tradeType, address indexed tokenBorrowed, uint amountBorrowed, uint feePaid); // Used by UniV3 callback
    event SwapExecuted(uint indexed swapNumber, address indexed tokenIn, address indexed tokenOut, uint amountIn, uint amountOut);
    event RepaymentSuccess(address indexed token, uint amountRepaid);
    event ProfitTransferred(address indexed token, address indexed recipient, uint amount);
    event EmergencyWithdrawal(address indexed token, address indexed recipient, uint amount);

    // --- MODIFIED onlyOwner Modifier (Unchanged from previous version) ---
    modifier onlyOwner() {
        require(msg.sender == owner || tx.origin == owner, "FS:NA"); // FS: Not Authorized
        _;
    }
    // --- END MODIFICATION ---

    // --- UPDATED CONSTRUCTOR ---
    constructor(address _swapRouter, address _aavePoolAddress) {
        require(_swapRouter != address(0), "FS:ISR");
        require(_aavePoolAddress != address(0), "FS:IAP"); // Invalid Aave Pool
        SWAP_ROUTER = ISwapRouter(_swapRouter);
        AAVE_POOL = IPool(_aavePoolAddress); // Store Aave Pool instance
        owner = msg.sender; // Set owner during deployment
    }
    // --- END UPDATED CONSTRUCTOR ---

    // --- Uniswap V3 Flash Callback (Existing Logic - Unchanged for now) ---
    // This handles callbacks specifically from Uniswap V3 pools initiated via initiateFlashSwap/initiateTriangularFlashSwap
    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data // Contains encoded FlashCallbackData
    ) external override nonReentrant {
        FlashCallbackData memory decodedData = abi.decode(data, (FlashCallbackData));

        // Security Checks
        PoolAddress.PoolKey memory poolKey = PoolAddress.PoolKey({ token0: decodedData.token0, token1: decodedData.token1, fee: decodedData.fee });
        require(msg.sender == decodedData.poolBorrowedFrom, "FS:CBW"); // Check callback origin is the pool we called
        CallbackValidation.verifyCallback(V3_FACTORY, poolKey); // Check pool exists via factory

        // Determine Borrowed Amount & Fee (UniV3 fees are passed in)
        address tokenBorrowed; uint amountBorrowed; uint totalAmountToRepay; uint feePaid;
        if (decodedData.amount1Borrowed > 0) {
            require(decodedData.amount0Borrowed == 0, "FS:BTB"); // Borrowed two tokens?
            tokenBorrowed = decodedData.token1; amountBorrowed = decodedData.amount1Borrowed; feePaid = fee1; totalAmountToRepay = amountBorrowed.add(feePaid);
        } else {
            require(decodedData.amount1Borrowed == 0 && decodedData.amount0Borrowed > 0, "FS:BNA"); // Borrowed zero tokens?
            tokenBorrowed = decodedData.token0; amountBorrowed = decodedData.amount0Borrowed; feePaid = fee0; totalAmountToRepay = amountBorrowed.add(feePaid);
        }
        emit ArbitrageExecution(decodedData.callbackType, tokenBorrowed, amountBorrowed, feePaid);

        // Execute Arbitrage based on the type encoded in the callback data
        uint finalAmountReceived;
        if (decodedData.callbackType == CallbackType.TRIANGULAR) {
            finalAmountReceived = _executeTriangularSwaps(tokenBorrowed, amountBorrowed, decodedData.params);
        } else if (decodedData.callbackType == CallbackType.TWO_HOP) {
            finalAmountReceived = _executeTwoHopSwaps(tokenBorrowed, amountBorrowed, decodedData.params);
        } else {
            revert("FS:UCT"); // Unknown Callback Type
        }

        // Repayment & Profit
        uint currentBalanceBorrowedToken = IERC20(tokenBorrowed).balanceOf(address(this));
        require(currentBalanceBorrowedToken >= totalAmountToRepay, "FS:IFR"); // Insufficient funds for repayment
        IERC20(tokenBorrowed).safeTransfer(msg.sender, totalAmountToRepay); // Repay UniV3 pool directly
        emit RepaymentSuccess(tokenBorrowed, totalAmountToRepay);

        uint profit = currentBalanceBorrowedToken.sub(totalAmountToRepay);
        if (profit > 0) {
            emit ProfitTransferred(tokenBorrowed, owner, profit);
            IERC20(tokenBorrowed).safeTransfer(owner, profit); // Send profit to owner
        }
    }
    // ****** START OF PART 3 ******

    // --- NEW AAVE V3 Flash Loan Callback ---
    /**
     * @dev Callback function for Aave V3 flash loans. Conforms to IFlashLoanReceiver.
     * Executes arbitrage path encoded in `params` and repays the loan + premium.
     */
    function executeOperation(
        address[] calldata assets,    // Token(s) borrowed
        uint256[] calldata amounts,   // Amount(s) borrowed
        uint256[] calldata premiums,  // Fee(s) (0.09% of amounts)
        address initiator,         // Initiator of the flash loan (this contract)
        bytes calldata params        // Custom data (encoded ArbParams struct)
    ) external override nonReentrant returns (bool) { // Added nonReentrant
        require(msg.sender == address(AAVE_POOL), "FS:CBA"); // Callback must come from Aave Pool
        require(initiator == address(this), "FS:IFI"); // Initiator must be this contract
        require(assets.length == 1, "FS:MA"); // Enforce single asset borrow for now
        require(assets.length == amounts.length && amounts.length == premiums.length, "FS:ALA"); // Array length assertion

        // Decode the arbitrage path parameters
        // Assumes `params` is abi.encode(ArbParams)
        ArbParams memory decodedParams = abi.decode(params, (ArbParams));

        address tokenBorrowed = assets[0];
        uint amountBorrowed = amounts[0];
        uint feePaid = premiums[0]; // Aave fee (premium)

        emit AaveArbitrageExecution(tokenBorrowed, amountBorrowed, feePaid);

        // --- Execute Arbitrage using the generic path executor ---
        // This function needs to handle the sequence of swaps based on decodedParams.path
        uint finalAmountReceived = _executeSwapPath(decodedParams.path);
        require(finalAmountReceived > 0, "FS:AZA"); // Ensure swaps returned some amount

        // --- Repayment & Profit ---
        uint totalAmountToRepay = amountBorrowed.add(feePaid);
        uint currentBalanceBorrowedToken = IERC20(tokenBorrowed).balanceOf(address(this));
        require(currentBalanceBorrowedToken >= totalAmountToRepay, "FS:IFR"); // Check balance covers repayment + fee

        // Approve the Aave pool to pull the repayment amount
        _approveSpenderIfNeeded(tokenBorrowed, address(AAVE_POOL), totalAmountToRepay);
        emit RepaymentSuccess(tokenBorrowed, totalAmountToRepay); // Emit before potential profit transfer

        // Note: Aave automatically pulls the approved amount after this function returns true.
        // No explicit transfer needed here for repayment.

        uint profit = currentBalanceBorrowedToken.sub(totalAmountToRepay);
        if (profit > 0) {
            emit ProfitTransferred(tokenBorrowed, owner, profit);
            IERC20(tokenBorrowed).safeTransfer(owner, profit); // Send profit to owner
        }

        return true; // Signal successful execution to Aave
    }
    // --- End AAVE V3 Flash Loan Callback ---


    // --- Internal functions for UniV3 Flow (Existing Logic - Unchanged for now) ---
    // These are called by uniswapV3FlashCallback and decode UniV3 specific param structs.
    function _executeTwoHopSwaps( address _tokenBorrowed, uint _amountBorrowed, bytes memory _params ) internal returns (uint finalAmount) {
        TwoHopParams memory arbParams = abi.decode(_params, (TwoHopParams));
        // Use generic approval helper
        _approveSpenderIfNeeded(_tokenBorrowed, address(SWAP_ROUTER), _amountBorrowed);
        uint amountIntermediateReceived = _executeSingleSwap( 1, _tokenBorrowed, arbParams.tokenIntermediate, arbParams.feeA, _amountBorrowed, arbParams.amountOutMinimum1 );
        require(amountIntermediateReceived > 0, "FS:S1Z");
        _approveSpenderIfNeeded(arbParams.tokenIntermediate, address(SWAP_ROUTER), amountIntermediateReceived);
        finalAmount = _executeSingleSwap( 2, arbParams.tokenIntermediate, _tokenBorrowed, arbParams.feeB, amountIntermediateReceived, arbParams.amountOutMinimum2 );
    }

    function _executeTriangularSwaps( address _tokenA, uint _amountA, bytes memory _params ) internal returns (uint finalAmount) {
        TriangularPathParams memory pathParams = abi.decode(_params, (TriangularPathParams));
        require(pathParams.tokenA == _tokenA, "FS:TPA");
        _approveSpenderIfNeeded(_tokenA, address(SWAP_ROUTER), _amountA);
        uint amountB = _executeSingleSwap( 1, _tokenA, pathParams.tokenB, pathParams.fee1, _amountA, 0 );
        require(amountB > 0, "FS:TS1Z");
        _approveSpenderIfNeeded(pathParams.tokenB, address(SWAP_ROUTER), amountB);
        uint amountC = _executeSingleSwap( 2, pathParams.tokenB, pathParams.tokenC, pathParams.fee2, amountB, 0 );
        require(amountC > 0, "FS:TS2Z");
        _approveSpenderIfNeeded(pathParams.tokenC, address(SWAP_ROUTER), amountC);
        finalAmount = _executeSingleSwap( 3, pathParams.tokenC, _tokenA, pathParams.fee3, amountC, pathParams.amountOutMinimumFinal );
    }

    // Assumes swaps are via UniV3 router for now
    function _executeSingleSwap( uint _swapNumber, address _tokenIn, address _tokenOut, uint24 _fee, uint _amountIn, uint _amountOutMinimum ) internal returns (uint amountOut) {
        ISwapRouter.ExactInputSingleParams memory swapParams = ISwapRouter.ExactInputSingleParams({ tokenIn: _tokenIn, tokenOut: _tokenOut, fee: _fee, recipient: address(this), deadline: block.timestamp + DEADLINE_OFFSET, amountIn: _amountIn, amountOutMinimum: _amountOutMinimum, sqrtPriceLimitX96: 0 });
        try SWAP_ROUTER.exactInputSingle(swapParams) returns (uint _amountOut) {
            amountOut = _amountOut;
            emit SwapExecuted(_swapNumber, _tokenIn, _tokenOut, _amountIn, amountOut);
        } catch Error(string memory reason) {
            revert(string(abi.encodePacked("FS:S", _numToString(_swapNumber) ,"F:", reason)));
        } catch {
            revert(string(abi.encodePacked("FS:S", _numToString(_swapNumber), "FL")));
        }
    }
    // --- End Internal functions for UniV3 Flow ---

    // --- NEW Internal function for executing generic swap paths ---
    /**
     * @dev Executes a sequence of swaps defined by the path.
     * Called by the Aave callback `executeOperation`.
     * IMPORTANT: Currently only supports UniV3 swaps (dexType 0). Needs expansion for Sushi/DODO.
     */
    function _executeSwapPath(SwapStep[] memory path) internal returns (uint finalAmount) {
        require(path.length > 0, "FS:ESP"); // Empty Swap Path

        // We assume the flash-loaned amount is already in the contract.
        // The first step uses this contract's balance of the input token.
        uint amountIn = IERC20(path[0].tokenIn).balanceOf(address(this));
        uint currentAmount = amountIn; // Track amount available for next step

        for(uint i = 0; i < path.length; i++) {
            SwapStep memory step = path[i];
            require(currentAmount > 0, "FS:AZS"); // Amount Zero before Swap

            // Approve the correct spender for this step's DEX type
            // TODO: Determine spender based on step.dexType
            address spender = address(SWAP_ROUTER); // Default to UniV3 router
            // if (step.dexType == 1) { spender = SUSHI_ROUTER_ADDRESS; } // Example
            // else if (step.dexType == 2) { spender = step.pool; } // Example: DODO needs approval for pool? Verify.

            _approveSpenderIfNeeded(step.tokenIn, spender, currentAmount);

            // --- Execute Swap based on DEX Type ---
            if (step.dexType == 0) { // Uniswap V3
                 currentAmount = _executeSingleSwap( // Reuse existing UniV3 swap helper
                     i + 1, // Use path index as swap number
                     step.tokenIn,
                     step.tokenOut,
                     step.fee, // V3 fee from SwapStep struct
                     currentAmount, // Use amount from previous step
                     step.minOut // Slippage protection for this step
                 );
                 require(currentAmount > 0, "FS:V3SZ"); // V3 Swap returned zero
            }
            // --- TODO: Add logic for other dexTypes ---
            // else if (step.dexType == 1) { // SushiSwap
            //     currentAmount = _executeSushiSwap(step.tokenIn, step.tokenOut, currentAmount, step.minOut);
            //     require(currentAmount > 0, "FS:SSZ");
            // }
            // else if (step.dexType == 2) { // DODO
            //     currentAmount = _executeDodoSwap(step.pool, step.tokenIn, step.tokenOut, currentAmount, step.minOut);
            //     require(currentAmount > 0, "FS:DSZ");
            // }
             else {
                 revert("FS:UDT"); // Unknown DEX Type in path
             }
             // --- End TODO ---
        }
        finalAmount = currentAmount; // Amount received after the last swap
    }
    // --- End NEW Internal function ---


    // --- Internal Helper for Approvals (Slightly modified name) ---
    function _approveSpenderIfNeeded(address _token, address _spender, uint _amount) internal {
        uint allowance = IERC20(_token).allowance(address(this), _spender);
        if (allowance < _amount) {
            // Reset allowance to 0 first if it's non-zero, to prevent potential issues with some tokens
            if (allowance > 0) {
                 IERC20(_token).safeApprove(_spender, 0);
            }
             IERC20(_token).safeApprove(_spender, _amount);
        }
    }

    // ****** START OF PART 4 (Revised Start) ******

    // --- Internal Helper to convert uint to string (Unchanged) ---
    function _numToString(uint _i) internal pure returns (string memory _uintAsString) {
        if (_i == 0) { return "0"; }
        uint j = _i; uint len;
        while (j != 0) { len++; j /= 10; }
        bytes memory bstr = new bytes(len);
        uint k = len;
        while (_i != 0) {
            k = k-1;
            uint8 temp = (48 + uint8(_i - _i / 10 * 10));
            bytes1 b1 = bytes1(temp);
            bstr[k] = b1;
            _i /= 10;
        }
        return string(bstr);
    }
    // --- End Internal Helper ---


    // --- Initiate Flash Swap (UniV3 specific - Unchanged) ---
    // Initiates a flash loan from a Uniswap V3 Pool, expecting TwoHopParams
    function initiateFlashSwap(
        address _poolAddress,
        uint _amount0,
        uint _amount1,
        bytes calldata _params // Expects encoded TwoHopParams
    ) external /* override */ onlyOwner { // Removed override if not needed, added onlyOwner back
        require(_poolAddress != address(0), "FS:IP");
        require((_amount0 > 0 && _amount1 == 0) || (_amount1 > 0 && _amount0 == 0), "FS:BAO"); // Borrow amount one token only
        require(_params.length > 0, "FS:EP"); // Encoded params required

        IUniswapV3Pool pool = IUniswapV3Pool(_poolAddress);
        address token0 = pool.token0();
        address token1 = pool.token1();
        uint24 fee = pool.fee();

        emit FlashSwapInitiated(msg.sender, _poolAddress, CallbackType.TWO_HOP, _amount0, _amount1);

        // Prepare data for the uniswapV3FlashCallback
        FlashCallbackData memory callbackData = FlashCallbackData({
            callbackType: CallbackType.TWO_HOP,
            amount0Borrowed: _amount0,
            amount1Borrowed: _amount1,
            caller: msg.sender,
            poolBorrowedFrom: _poolAddress,
            token0: token0,
            token1: token1,
            fee: fee,
            params: _params // Pass through the encoded TwoHopParams
        });

        // Call Uniswap V3 flash loan
        pool.flash(
            address(this), // callback recipient is this contract
            _amount0,
            _amount1,
            abi.encode(callbackData) // Encode the FlashCallbackData struct for the callback
        );
    }

    // --- Initiate Triangular Flash Swap (UniV3 specific - Unchanged) ---
    // Initiates a flash loan from a Uniswap V3 Pool, expecting TriangularPathParams
    function initiateTriangularFlashSwap(
        address _poolAddress,
        uint _amount0,
        uint _amount1,
        bytes calldata _params // Expects encoded TriangularPathParams
    ) external /* override */ onlyOwner { // Removed override if not needed, added onlyOwner back
        require(_poolAddress != address(0), "FS:IP");
        require((_amount0 > 0 && _amount1 == 0) || (_amount1 > 0 && _amount0 == 0), "FS:BAO");
        require(_params.length > 0, "FS:EP");

        IUniswapV3Pool pool = IUniswapV3Pool(_poolAddress);
        address token0 = pool.token0();
        address token1 = pool.token1();
        uint24 fee = pool.fee();

        emit FlashSwapInitiated(msg.sender, _poolAddress, CallbackType.TRIANGULAR, _amount0, _amount1);

        // Prepare data for the uniswapV3FlashCallback
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

        // Call Uniswap V3 flash loan
        pool.flash(
            address(this), // callback recipient
            _amount0,
            _amount1,
            abi.encode(callbackData)
        );
    }

    // --- NEW Initiate Aave Flash Loan Function ---
    /**
     * @notice Initiates a flash loan from Aave V3 pool.
     * @param assets Array containing the single token address to borrow.
     * @param amounts Array containing the amount of the token to borrow.
     * @param params Custom bytes data containing encoded ArbParams struct (SwapStep[] path).
     */
    function initiateAaveFlashLoan(
        address[] memory assets,    // Array should contain ONE asset for now
        uint256[] memory amounts,   // Array should contain ONE amount
        bytes calldata params       // Abi-encoded ArbParams struct
    ) external onlyOwner { // Ensure only owner/bot can call
        require(assets.length == 1 && amounts.length == 1, "FS:SAA"); // Enforce single asset for now
        require(amounts[0] > 0, "FS:AZA"); // Amount must be > 0
        require(params.length > 0, "FS:EP"); // Params required

        emit AaveFlashLoanInitiated(msg.sender, assets[0], amounts[0]);

        // Define modes array for flashLoan: [0] means no debt opening, repay immediately
        uint256[] memory modes = new uint256[](1);
        modes[0] = 0; // 0 = FlashLoan.InterestRateMode.None

        // Call Aave V3 Pool flashLoan function
        AAVE_POOL.flashLoan(
            address(this),      // receiverAddress (this contract)
            assets,             // assets[]
            amounts,            // amounts[]
            modes,              // interestRateModes[] (0 = None)
            address(this),      // onBehalfOf (loan is for this contract)
            params,             // Custom data (encoded ArbParams) passed to executeOperation
            0                   // referralCode (0 = no referral)
        );
    }
    // --- END NEW Function ---


    // --- Emergency Withdrawal Functions (Unchanged) ---
    function withdrawEther() external onlyOwner {
        payable(owner).transfer(address(this).balance);
        emit EmergencyWithdrawal(address(0), owner, address(this).balance);
    }
    function withdrawToken(address tokenAddress) external onlyOwner {
        require(tokenAddress != address(0), "FS:ZAT"); // Zero Address Token
        uint balance = IERC20(tokenAddress).balanceOf(address(this));
        if (balance > 0) {
            IERC20(tokenAddress).safeTransfer(owner, balance);
            emit EmergencyWithdrawal(tokenAddress, owner, balance);
        }
    }

    // --- Fallback Function (Unchanged) ---
    receive() external payable {}

    // --- Required by IFlashLoanReceiver Interface ---
    // These need to return the correct addresses for Aave's security model.
    function ADDRESSES_PROVIDER() external view override returns (address) {
        // Return actual Arbitrum V3 AddressesProvider if needed for more complex interactions,
        // otherwise return the Pool address itself might suffice for basic flash loan receiving.
        // Let's return the known Arbitrum V3 Addresses Provider for correctness.
        return 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb; // Arbitrum V3 Addresses Provider (Checksum Corrected)
    }
    function POOL() external view override returns (address) {
        // This MUST return the address of the Aave Pool contract.
        return address(AAVE_POOL);
    }

} // ****** END OF CONTRACT ******

// ****** END OF PART 4 (Revised Start) ******
