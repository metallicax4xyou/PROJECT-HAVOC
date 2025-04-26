// SPDX-License-Identifier: MIT
pragma solidity =0.7.6; // Match periphery library version
pragma abicoder v2;

// --- Imports ---
// ... (imports remain the same) ...
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
import "./interfaces/IDODOV1V2Pool.sol";
// ... (Aave imports remain the same) ...
interface IPool { function flashLoan( address receiverAddress, address[] calldata assets, uint256[] calldata amounts, uint256[] calldata interestRateModes, address onBehalfOf, bytes calldata params, uint16 referralCode ) external; }
interface IFlashLoanReceiver { function executeOperation( address[] calldata assets, uint256[] calldata amounts, uint256[] calldata premiums, address initiator, bytes calldata params ) external returns (bool); function ADDRESSES_PROVIDER() external view returns (address); function POOL() external view returns (address); }


// --- Contract Definition ---
// --- VERSION v3.9 --- Corrects approval logic placement
contract FlashSwap is IUniswapV3FlashCallback, IFlashLoanReceiver, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;

    // --- State Variables (Unchanged) ---
    ISwapRouter public immutable SWAP_ROUTER;
    IUniswapV2Router02 public immutable SUSHI_ROUTER;
    address payable public immutable owner;
    address public immutable V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    IPool public immutable AAVE_POOL;
    address public immutable AAVE_ADDRESSES_PROVIDER;
    uint constant DEADLINE_OFFSET = 60;

    // --- DEX Type Constants (Unchanged) ---
    uint8 constant DEX_TYPE_UNISWAP_V3 = 0;
    uint8 constant DEX_TYPE_SUSHISWAP = 1;
    uint8 constant DEX_TYPE_DODO = 2;

    // --- Structs (Unchanged) ---
    enum CallbackType { TWO_HOP, TRIANGULAR }
    struct FlashCallbackData { CallbackType callbackType; uint amount0Borrowed; uint amount1Borrowed; address caller; address poolBorrowedFrom; address token0; address token1; uint24 fee; bytes params; }
    struct TwoHopParams { address tokenIntermediate; uint24 feeA; uint24 feeB; uint amountOutMinimum1; uint amountOutMinimum2; }
    struct TriangularPathParams { address tokenA; address tokenB; address tokenC; uint24 fee1; uint24 fee2; uint24 fee3; uint amountOutMinimumFinal; }
    struct SwapStep { address pool; address tokenIn; address tokenOut; uint24 fee; uint256 minOut; uint8 dexType; }
    struct ArbParams { SwapStep[] path; address initiator; }

    // --- Events (Unchanged) ---
    event FlashSwapInitiated(address indexed caller, address indexed pool, CallbackType tradeType, uint amount0, uint amount1);
    event AaveFlashLoanInitiated(address indexed caller, address indexed asset, uint amount);
    event AaveArbitrageExecution(address indexed tokenBorrowed, uint amountBorrowed, uint feePaid);
    event ArbitrageExecution(CallbackType indexed tradeType, address indexed tokenBorrowed, uint amountBorrowed, uint feePaid);
    event SwapExecuted(uint swapNumber, uint8 dexType, address indexed tokenIn, address indexed tokenOut, uint amountIn, uint amountOut);
    event RepaymentSuccess(address indexed token, uint amountRepaid);
    event ProfitTransferred(address indexed token, address indexed recipient, uint amount);
    event EmergencyWithdrawal(address indexed token, address indexed recipient, uint amount);

    // --- Modifiers (Unchanged) ---
    modifier onlyOwner() { require(msg.sender == owner || tx.origin == owner, "FS:NA"); _; }

    // --- Constructor (Unchanged) ---
    constructor( address _uniswapV3Router, address _sushiRouter, address _aavePoolAddress, address _aaveAddressesProvider ) { require(_uniswapV3Router != address(0), "FS:IUR"); require(_sushiRouter != address(0), "FS:ISR"); require(_aavePoolAddress != address(0), "FS:IAP"); require(_aaveAddressesProvider != address(0), "FS:IAAP"); SWAP_ROUTER = ISwapRouter(_uniswapV3Router); SUSHI_ROUTER = IUniswapV2Router02(_sushiRouter); AAVE_POOL = IPool(_aavePoolAddress); AAVE_ADDRESSES_PROVIDER = _aaveAddressesProvider; owner = payable(msg.sender); }

    // --- Uniswap V3 Flash Callback (Unchanged) ---
    function uniswapV3FlashCallback( uint256 fee0, uint256 fee1, bytes calldata data ) external override nonReentrant { FlashCallbackData memory decodedData = abi.decode(data, (FlashCallbackData)); PoolAddress.PoolKey memory poolKey = PoolAddress.PoolKey({ token0: decodedData.token0, token1: decodedData.token1, fee: decodedData.fee }); require(msg.sender == decodedData.poolBorrowedFrom, "FS:CBW"); CallbackValidation.verifyCallback(V3_FACTORY, poolKey); address tokenBorrowed; uint amountBorrowed; uint totalAmountToRepay; uint feePaid; if (decodedData.amount1Borrowed > 0) { require(decodedData.amount0Borrowed == 0, "FS:BTB"); tokenBorrowed = decodedData.token1; amountBorrowed = decodedData.amount1Borrowed; feePaid = fee1; totalAmountToRepay = amountBorrowed.add(feePaid); } else { require(decodedData.amount1Borrowed == 0 && decodedData.amount0Borrowed > 0, "FS:BNA"); tokenBorrowed = decodedData.token0; amountBorrowed = decodedData.amount0Borrowed; feePaid = fee0; totalAmountToRepay = amountBorrowed.add(feePaid); } emit ArbitrageExecution(decodedData.callbackType, tokenBorrowed, amountBorrowed, feePaid); uint finalAmountReceived; if (decodedData.callbackType == CallbackType.TRIANGULAR) { finalAmountReceived = _executeTriangularSwaps(tokenBorrowed, amountBorrowed, decodedData.params); } else if (decodedData.callbackType == CallbackType.TWO_HOP) { finalAmountReceived = _executeTwoHopSwaps(tokenBorrowed, amountBorrowed, decodedData.params); } else { revert("FS:UCT"); } uint currentBalanceBorrowedToken = IERC20(tokenBorrowed).balanceOf(address(this)); require(currentBalanceBorrowedToken >= totalAmountToRepay, "FS:IFR"); IERC20(tokenBorrowed).safeTransfer(msg.sender, totalAmountToRepay); emit RepaymentSuccess(tokenBorrowed, totalAmountToRepay); uint profit = currentBalanceBorrowedToken.sub(totalAmountToRepay); if (profit > 0) { emit ProfitTransferred(tokenBorrowed, owner, profit); IERC20(tokenBorrowed).safeTransfer(owner, profit); } }

    // --- AAVE V3 Flash Loan Callback (MODIFIED: Removed Approval Loop) ---
    function executeOperation( address[] calldata assets, uint256[] calldata amounts, uint256[] calldata premiums, address initiator, bytes calldata params ) external override nonReentrant returns (bool) {
        require(msg.sender == address(AAVE_POOL), "FS:CBA");
        require(initiator == address(this), "FS:IFI");
        require(assets.length == 1, "FS:MA");
        require(assets.length == amounts.length && amounts.length == premiums.length, "FS:ALA");

        ArbParams memory decodedParams = abi.decode(params, (ArbParams));
        address tokenBorrowed = assets[0];
        uint amountBorrowed = amounts[0];
        uint feePaid = premiums[0];
        emit AaveArbitrageExecution(tokenBorrowed, amountBorrowed, feePaid);

        // --- REMOVED Approval Loop ---
        // Approvals will now happen inside _executeSwapPath before each step

        // --- Execute Arbitrage Path ---
        uint finalAmountReceived = _executeSwapPath(decodedParams.path);
        require(finalAmountReceived > 0, "FS:AZA");

        // --- Repayment & Profit ---
        uint totalAmountToRepay = amountBorrowed.add(feePaid);
        uint currentBalanceBorrowedTokenAfterSwaps = IERC20(tokenBorrowed).balanceOf(address(this));
        require(currentBalanceBorrowedTokenAfterSwaps >= totalAmountToRepay, "FS:IFR");

        // Approve Aave pool just before returning true
        _approveSpenderIfNeeded(tokenBorrowed, address(AAVE_POOL), totalAmountToRepay);
        emit RepaymentSuccess(tokenBorrowed, totalAmountToRepay);

        uint profit = currentBalanceBorrowedTokenAfterSwaps.sub(totalAmountToRepay);
        if (profit > 0) {
            emit ProfitTransferred(tokenBorrowed, owner, profit);
            IERC20(tokenBorrowed).safeTransfer(owner, profit);
        }
        return true;
    }
    // --- End AAVE V3 Callback ---


    // --- Internal functions for UniV3 Flow (Unchanged) ---
    function _executeTwoHopSwaps( address _tokenBorrowed, uint _amountBorrowed, bytes memory _params ) internal returns (uint finalAmount) { TwoHopParams memory arbParams = abi.decode(_params, (TwoHopParams)); _approveSpenderIfNeeded(_tokenBorrowed, address(SWAP_ROUTER), _amountBorrowed); uint amountIntermediateReceived = _executeSingleV3Swap( 1, _tokenBorrowed, arbParams.tokenIntermediate, arbParams.feeA, _amountBorrowed, arbParams.amountOutMinimum1 ); require(amountIntermediateReceived > 0, "FS:S1Z"); _approveSpenderIfNeeded(arbParams.tokenIntermediate, address(SWAP_ROUTER), amountIntermediateReceived); finalAmount = _executeSingleV3Swap( 2, arbParams.tokenIntermediate, _tokenBorrowed, arbParams.feeB, amountIntermediateReceived, arbParams.amountOutMinimum2 ); }
    function _executeTriangularSwaps( address _tokenA, uint _amountA, bytes memory _params ) internal returns (uint finalAmount) { TriangularPathParams memory pathParams = abi.decode(_params, (TriangularPathParams)); require(pathParams.tokenA == _tokenA, "FS:TPA"); _approveSpenderIfNeeded(_tokenA, address(SWAP_ROUTER), _amountA); uint amountB = _executeSingleV3Swap( 1, _tokenA, pathParams.tokenB, pathParams.fee1, _amountA, 0 ); require(amountB > 0, "FS:TS1Z"); _approveSpenderIfNeeded(pathParams.tokenB, address(SWAP_ROUTER), amountB); uint amountC = _executeSingleV3Swap( 2, pathParams.tokenB, pathParams.tokenC, pathParams.fee2, amountB, 0 ); require(amountC > 0, "FS:TS2Z"); _approveSpenderIfNeeded(pathParams.tokenC, address(SWAP_ROUTER), amountC); finalAmount = _executeSingleV3Swap( 3, pathParams.tokenC, _tokenA, pathParams.fee3, amountC, pathParams.amountOutMinimumFinal ); }
    function _executeSingleV3Swap( uint _swapNumber, address _tokenIn, address _tokenOut, uint24 _fee, uint _amountIn, uint _amountOutMinimum ) internal returns (uint amountOut) { ISwapRouter.ExactInputSingleParams memory swapParams = ISwapRouter.ExactInputSingleParams({ tokenIn: _tokenIn, tokenOut: _tokenOut, fee: _fee, recipient: address(this), deadline: block.timestamp + DEADLINE_OFFSET, amountIn: _amountIn, amountOutMinimum: _amountOutMinimum, sqrtPriceLimitX96: 0 }); try SWAP_ROUTER.exactInputSingle(swapParams) returns (uint _amountOut) { amountOut = _amountOut; emit SwapExecuted(_swapNumber, DEX_TYPE_UNISWAP_V3, _tokenIn, _tokenOut, _amountIn, amountOut); } catch Error(string memory reason) { revert(string(abi.encodePacked("FS:S", _numToString(_swapNumber) ,"F:", reason))); } catch { revert(string(abi.encodePacked("FS:S", _numToString(_swapNumber), "FL"))); } }
        // --- _executeSwapPath (MODIFIED: Moved Approvals Inside Loop) ---
    function _executeSwapPath(SwapStep[] memory path) internal returns (uint finalAmount) {
        require(path.length > 0, "FS:ESP");
        uint currentAmount = IERC20(path[0].tokenIn).balanceOf(address(this)); // Start with balance from flash loan

        for(uint i = 0; i < path.length; i++) {
            SwapStep memory step = path[i];
            require(currentAmount > 0, "FS:AZS"); // Amount Zero before Swap

            // --- Determine Spender & Approve ---
            address spender;
             if (step.dexType == DEX_TYPE_UNISWAP_V3) {
                 spender = address(SWAP_ROUTER);
             } else if (step.dexType == DEX_TYPE_SUSHISWAP) {
                 spender = address(SUSHI_ROUTER);
             } else if (step.dexType == DEX_TYPE_DODO) {
                 spender = step.pool; // DODO needs approval for the pool
             } else {
                  revert("FS:UDA"); // Unknown Dex for Approval
             }
             _approveSpenderIfNeeded(step.tokenIn, spender, currentAmount); // Approve before swap
            // --- End Approval ---

            uint amountOut;
            if (step.dexType == DEX_TYPE_UNISWAP_V3) { // Uniswap V3
                 amountOut = _executeSingleV3Swap(
                     i + 1, step.tokenIn, step.tokenOut, step.fee,
                     currentAmount, step.minOut
                 );
                 require(amountOut > 0, "FS:V3SZ");
            }
            else if (step.dexType == DEX_TYPE_SUSHISWAP) { // SushiSwap
                 address[] memory sushiPath = new address[](2);
                 sushiPath[0] = step.tokenIn;
                 sushiPath[1] = step.tokenOut;
                 uint deadline = block.timestamp.add(DEADLINE_OFFSET);
                 try SUSHI_ROUTER.swapExactTokensForTokens(
                     currentAmount, step.minOut, sushiPath, address(this), deadline
                 ) returns (uint[] memory amounts) {
                     require(amounts.length == 2, "FS:SLA");
                     amountOut = amounts[1];
                     emit SwapExecuted(i + 1, DEX_TYPE_SUSHISWAP, step.tokenIn, step.tokenOut, currentAmount, amountOut);
                 } catch Error(string memory reason) { revert(string(abi.encodePacked("FS:SS", _numToString(i+1) ,"F:", reason))); } catch { revert(string(abi.encodePacked("FS:SS", _numToString(i+1), "FL"))); }
                 require(amountOut > 0, "FS:SSZ");
            }
            else if (step.dexType == DEX_TYPE_DODO) { // DODO
                 IDODOV1V2Pool dodoPool = IDODOV1V2Pool(step.pool);
                 address baseToken = dodoPool._BASE_TOKEN_();

                 if (step.tokenIn == baseToken) {
                     // Selling the Base Token
                     try dodoPool.sellBaseToken(currentAmount, step.minOut, "") returns (uint quoteReceived) {
                         amountOut = quoteReceived;
                         emit SwapExecuted(i + 1, DEX_TYPE_DODO, step.tokenIn, step.tokenOut, currentAmount, amountOut);
                     } catch Error(string memory reason) { revert(string(abi.encodePacked("FS:DSB", _numToString(i+1) ,"F:", reason))); } catch { revert(string(abi.encodePacked("FS:DSB", _numToString(i+1), "FL"))); }
                 } else {
                     // Selling the Quote Token (Using buyBaseToken)
                     // Removed require(step.minOut > 0, "FS:DQA");
                     uint quotePaid;
                     try dodoPool.buyBaseToken(
                         step.minOut, currentAmount, ""
                     ) returns (uint _quotePaid) {
                         quotePaid = _quotePaid;
                         // Assume success means we received at least step.minOut
                         amountOut = step.minOut;
                         emit SwapExecuted(i + 1, DEX_TYPE_DODO, step.tokenIn, step.tokenOut, quotePaid, amountOut);
                     } catch Error(string memory reason) { revert(string(abi.encodePacked("FS:DQB", _numToString(i+1) ,"F:", reason))); } catch { revert(string(abi.encodePacked("FS:DQB", _numToString(i+1), "FL"))); }
                 }
                 require(amountOut > 0, "FS:DSZ");
            }
             else {
                 revert("FS:UDT"); // Unknown DEX Type in path
             }

             currentAmount = amountOut; // Update amount for next step
        }
        finalAmount = currentAmount;
    }
    // --- End MODIFIED Internal function ---


    // --- Internal Helpers ---
    function _approveSpenderIfNeeded(address _token, address _spender, uint _amount) internal { if (IERC20(_token).allowance(address(this), _spender) < _amount) { if (IERC20(_token).allowance(address(this), _spender) > 0) { IERC20(_token).safeApprove(_spender, 0); } IERC20(_token).safeApprove(_spender, _amount); } }
    function _numToString(uint _i) internal pure returns (string memory _uintAsString) { if (_i == 0) { return "0"; } uint j = _i; uint len; while (j != 0) { len++; j /= 10; } bytes memory bstr = new bytes(len); uint k = len; while (_i != 0) { k = k-1; uint8 temp = (48 + uint8(_i - _i / 10 * 10)); bytes1 b1 = bytes1(temp); bstr[k] = b1; _i /= 10; } return string(bstr); }

    // --- Initiate Flash Swap Functions ---
    function initiateFlashSwap( address _poolAddress, uint _amount0, uint _amount1, bytes calldata _params ) external onlyOwner { require(_poolAddress != address(0), "FS:IP"); require((_amount0 > 0 && _amount1 == 0) || (_amount1 > 0 && _amount0 == 0), "FS:BAO"); require(_params.length > 0, "FS:EP"); IUniswapV3Pool pool = IUniswapV3Pool(_poolAddress); address token0 = pool.token0(); address token1 = pool.token1(); uint24 fee = pool.fee(); emit FlashSwapInitiated(msg.sender, _poolAddress, CallbackType.TWO_HOP, _amount0, _amount1); FlashCallbackData memory callbackData = FlashCallbackData({ callbackType: CallbackType.TWO_HOP, amount0Borrowed: _amount0, amount1Borrowed: _amount1, caller: msg.sender, poolBorrowedFrom: _poolAddress, token0: token0, token1: token1, fee: fee, params: _params }); pool.flash( address(this), _amount0, _amount1, abi.encode(callbackData) ); }
    function initiateTriangularFlashSwap( address _poolAddress, uint _amount0, uint _amount1, bytes calldata _params ) external onlyOwner { require(_poolAddress != address(0), "FS:IP"); require((_amount0 > 0 && _amount1 == 0) || (_amount1 > 0 && _amount0 == 0), "FS:BAO"); require(_params.length > 0, "FS:EP"); IUniswapV3Pool pool = IUniswapV3Pool(_poolAddress); address token0 = pool.token0(); address token1 = pool.token1(); uint24 fee = pool.fee(); emit FlashSwapInitiated(msg.sender, _poolAddress, CallbackType.TRIANGULAR, _amount0, _amount1); FlashCallbackData memory callbackData = FlashCallbackData({ callbackType: CallbackType.TRIANGULAR, amount0Borrowed: _amount0, amount1Borrowed: _amount1, caller: msg.sender, poolBorrowedFrom: _poolAddress, token0: token0, token1: token1, fee: fee, params: _params }); pool.flash( address(this), _amount0, _amount1, abi.encode(callbackData) ); }
    function initiateAaveFlashLoan( address[] memory assets, uint256[] memory amounts, bytes calldata params ) external onlyOwner { require(assets.length == 1 && amounts.length == 1, "FS:SAA"); require(amounts[0] > 0, "FS:AZA"); require(params.length > 0, "FS:EP"); emit AaveFlashLoanInitiated(msg.sender, assets[0], amounts[0]); uint256[] memory modes = new uint256[](1); modes[0] = 0; AAVE_POOL.flashLoan( address(this), assets, amounts, modes, address(this), params, 0 ); }

    // --- Emergency Withdrawal & Fallback ---
    function withdrawEther() external onlyOwner { uint balance = address(this).balance; require(balance > 0, "FS:NEF"); (bool success, ) = owner.call{value: balance}(""); require(success, "FS:ETF"); emit EmergencyWithdrawal(address(0), owner, balance); }
    function withdrawToken(address tokenAddress) external onlyOwner { require(tokenAddress != address(0), "FS:ZTA"); uint balance = IERC20(tokenAddress).balanceOf(address(this)); if (balance > 0) { IERC20(tokenAddress).safeTransfer(owner, balance); emit EmergencyWithdrawal(tokenAddress, owner, balance); } }
    receive() external payable {}

    // --- IFlashLoanReceiver Implementation ---
    function ADDRESSES_PROVIDER() external view override returns (address) { return AAVE_ADDRESSES_PROVIDER; }
    function POOL() external view override returns (address) { return address(AAVE_POOL); }
} // ****** END OF CONTRACT ******
