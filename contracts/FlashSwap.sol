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
import "./interfaces/IDODOV1V2Pool.sol";
// --- Aave Imports ---
interface IPool { function flashLoan( address receiverAddress, address[] calldata assets, uint256[] calldata amounts, uint256[] calldata interestRateModes, address onBehalfOf, bytes calldata params, uint16 referralCode ) external; }
interface IFlashLoanReceiver { function executeOperation( address[] calldata assets, uint256[] calldata amounts, uint256[] calldata premiums, address initiator, bytes calldata params ) external returns (bool); function ADDRESSES_PROVIDER() external view returns (address); function POOL() external view returns (address); }


// --- Contract Definition ---
// --- VERSION v3.11 --- Temporarily disable DODO Quote Sell path
contract FlashSwap is IUniswapV3FlashCallback, IFlashLoanReceiver, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;

    // --- State Variables ---
    ISwapRouter public immutable SWAP_ROUTER;
    IUniswapV2Router02 public immutable SUSHI_ROUTER;
    address payable public immutable owner;
    address public immutable V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    IPool public immutable AAVE_POOL;
    address public immutable AAVE_ADDRESSES_PROVIDER;
    uint constant DEADLINE_OFFSET = 60;
    address public constant TREASURY = 0x50d3414C549a0A9Df8d29eD5872FDaEf97d6748d

    // --- DEX Type Constants ---
    uint8 constant DEX_TYPE_UNISWAP_V3 = 0;
    uint8 constant DEX_TYPE_SUSHISWAP = 1;
    uint8 constant DEX_TYPE_DODO = 2;

    // --- Structs ---
    enum CallbackType { TWO_HOP, TRIANGULAR }
    struct FlashCallbackData { CallbackType callbackType; uint amount0Borrowed; uint amount1Borrowed; address caller; address poolBorrowedFrom; address token0; address token1; uint24 fee; bytes params; }
    struct TwoHopParams { address tokenIntermediate; uint24 feeA; uint24 feeB; uint amountOutMinimum1; uint amountOutMinimum2; }
    struct TriangularPathParams { address tokenA; address tokenB; address tokenC; uint24 fee1; uint24 fee2; uint24 fee3; uint amountOutMinimumFinal; }
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
    function uniswapV3FlashCallback( uint256 fee0, uint256 fee1, bytes calldata data ) external override nonReentrant { FlashCallbackData memory decodedData = abi.decode(data, (FlashCallbackData)); PoolAddress.PoolKey memory poolKey = PoolAddress.PoolKey({ token0: decodedData.token0, token1: decodedData.token1, fee: decodedData.fee }); require(msg.sender == decodedData.poolBorrowedFrom, "FS:CBW"); CallbackValidation.verifyCallback(V3_FACTORY, poolKey); address tokenBorrowed; uint amountBorrowed; uint totalAmountToRepay; uint feePaid; if (decodedData.amount1Borrowed > 0) { require(decodedData.amount0Borrowed == 0, "FS:BTB"); tokenBorrowed = decodedData.token1; amountBorrowed = decodedData.amount1Borrowed; feePaid = fee1; totalAmountToRepay = amountBorrowed.add(feePaid); } else { require(decodedData.amount1Borrowed == 0 && decodedData.amount0Borrowed > 0, "FS:BNA"); tokenBorrowed = decodedData.token0; amountBorrowed = decodedData.amount0Borrowed; feePaid = fee0; totalAmountToRepay = amountBorrowed.add(feePaid); } emit ArbitrageExecution(decodedData.callbackType, tokenBorrowed, amountBorrowed, feePaid); uint finalAmountReceived; if (decodedData.callbackType == CallbackType.TRIANGULAR) { finalAmountReceived = _executeTriangularSwaps(tokenBorrowed, amountBorrowed, decodedData.params); } else if (decodedData.callbackType == CallbackType.TWO_HOP) { finalAmountReceived = _executeTwoHopSwaps(tokenBorrowed, amountBorrowed, decodedData.params); } else { revert("FS:UCT"); } uint currentBalanceBorrowedToken = IERC20(tokenBorrowed).balanceOf(address(this)); require(currentBalanceBorrowedToken >= totalAmountToRepay, "FS:IFR"); uint grossProfit = currentBalanceBorrowedToken > amountBorrowed ? currentBalanceBorrowedToken.sub(amountBorrowed) : 0; uint netProfit = currentBalanceBorrowedToken > totalAmountToRepay ? currentBalanceBorrowedToken.sub(totalAmountToRepay) : 0; IERC20(tokenBorrowed).safeTransfer(msg.sender, totalAmountToRepay); emit RepaymentSuccess(tokenBorrowed, totalAmountToRepay); bytes32 pathHash = keccak256(decodedData.params); emit TradeProfit(pathHash, tokenBorrowed, grossProfit, feePaid, netProfit); if (netProfit > 0) { uint titheAmount = (netProfit * 30) / 100; uint ownerAmount = netProfit - titheAmount; IERC20(tokenBorrowed).safeTransfer(TREASURY, titheAmount); IERC20(tokenBorrowed).safeTransfer(owner, ownerAmount); emit TithePaid(tokenBorrowed, titheAmount); emit ProfitTransferred(tokenBorrowed, owner, ownerAmount); } }

    // --- AAVE V3 Flash Loan Callback ---
    function executeOperation( address[] calldata assets, uint256[] calldata amounts, uint256[] calldata premiums, address initiator, bytes calldata params ) external override nonReentrant returns (bool) { require(msg.sender == address(AAVE_POOL), "FS:CBA"); require(initiator == address(this), "FS:IFI"); require(assets.length == 1, "FS:MA"); require(assets.length == amounts.length && amounts.length == premiums.length, "FS:ALA"); ArbParams memory decodedParams = abi.decode(params, (ArbParams)); address tokenBorrowed = assets[0]; uint amountBorrowed = amounts[0]; uint feePaid = premiums[0]; emit AaveArbitrageExecution(tokenBorrowed, amountBorrowed, feePaid); uint finalAmountReceived = _executeSwapPath(decodedParams.path); require(finalAmountReceived > 0, "FS:AZA"); uint totalAmountToRepay = amountBorrowed.add(feePaid); uint currentBalanceBorrowedTokenAfterSwaps = IERC20(tokenBorrowed).balanceOf(address(this)); require(currentBalanceBorrowedTokenAfterSwaps >= totalAmountToRepay, "FS:IFR"); uint grossProfit = currentBalanceBorrowedTokenAfterSwaps > amountBorrowed ? currentBalanceBorrowedTokenAfterSwaps.sub(amountBorrowed) : 0; uint netProfit = currentBalanceBorrowedTokenAfterSwaps > totalAmountToRepay ? currentBalanceBorrowedTokenAfterSwaps.sub(totalAmountToRepay) : 0; _approveSpenderIfNeeded(tokenBorrowed, address(AAVE_POOL), totalAmountToRepay); emit RepaymentSuccess(tokenBorrowed, totalAmountToRepay); bytes32 pathHash = keccak256(params); emit TradeProfit(pathHash, tokenBorrowed, grossProfit, feePaid, netProfit); if (netProfit > 0) { uint titheAmount = (netProfit * 30) / 100; uint ownerAmount = netProfit - titheAmount; IERC20(tokenBorrowed).safeTransfer(TREASURY, titheAmount); IERC20(tokenBorrowed).safeTransfer(owner, ownerAmount); emit TithePaid(tokenBorrowed, titheAmount); emit ProfitTransferred(tokenBorrowed, owner, ownerAmount); } return true; }

    // --- Internal functions for UniV3 Flow ---
    function _executeTwoHopSwaps( address _tokenBorrowed, uint _amountBorrowed, bytes memory _params ) internal returns (uint finalAmount) { TwoHopParams memory arbParams = abi.decode(_params, (TwoHopParams)); _approveSpenderIfNeeded(_tokenBorrowed, address(SWAP_ROUTER), _amountBorrowed); uint amountIntermediateReceived = _executeSingleV3Swap( 1, _tokenBorrowed, arbParams.tokenIntermediate, arbParams.feeA, _amountBorrowed, arbParams.amountOutMinimum1 ); require(amountIntermediateReceived > 0, "FS:S1Z"); _approveSpenderIfNeeded(arbParams.tokenIntermediate, address(SWAP_ROUTER), amountIntermediateReceived); finalAmount = _executeSingleV3Swap( 2, arbParams.tokenIntermediate, _tokenBorrowed, arbParams.feeB, amountIntermediateReceived, arbParams.amountOutMinimum2 ); }
    function _executeTriangularSwaps( address _tokenA, uint _amountA, bytes memory _params ) internal returns (uint finalAmount) { TriangularPathParams memory pathParams = abi.decode(_params, (TriangularPathParams)); require(pathParams.tokenA == _tokenA, "FS:TPA"); _approveSpenderIfNeeded(_tokenA, address(SWAP_ROUTER), _amountA); uint amountB = _executeSingleV3Swap( 1, _tokenA, pathParams.tokenB, pathParams.fee1, _amountA, 0 ); require(amountB > 0, "FS:TS1Z"); _approveSpenderIfNeeded(pathParams.tokenB, address(SWAP_ROUTER), amountB); uint amountC = _executeSingleV3Swap( 2, pathParams.tokenB, pathParams.tokenC, pathParams.fee2, amountB, 0 ); require(amountC > 0, "FS:TS2Z"); _approveSpenderIfNeeded(pathParams.tokenC, address(SWAP_ROUTER), amountC); finalAmount = _executeSingleV3Swap( 3, pathParams.tokenC, _tokenA, pathParams.fee3, amountC, pathParams.amountOutMinimumFinal ); }
    function _executeSingleV3Swap( uint _swapNumber, address _tokenIn, address _tokenOut, uint24 _fee, uint _amountIn, uint _amountOutMinimum ) internal returns (uint amountOut) { ISwapRouter.ExactInputSingleParams memory swapParams = ISwapRouter.ExactInputSingleParams({ tokenIn: _tokenIn, tokenOut: _tokenOut, fee: _fee, recipient: address(this), deadline: block.timestamp + DEADLINE_OFFSET, amountIn: _amountIn, amountOutMinimum: _amountOutMinimum, sqrtPriceLimitX96: 0 }); try SWAP_ROUTER.exactInputSingle(swapParams) returns (uint _amountOut) { amountOut = _amountOut; emit SwapExecuted(_swapNumber, DEX_TYPE_UNISWAP_V3, _tokenIn, _tokenOut, _amountIn, amountOut); } catch Error(string memory reason) { revert(string(abi.encodePacked("FS:S", _numToString(_swapNumber) ,"F:", reason))); } catch { revert(string(abi.encodePacked("FS:S", _numToString(_swapNumber), "FL"))); } }
    
        // --- _executeSwapPath (DODO, Sushi, UniV3) ---
    function _executeSwapPath(SwapStep[] memory _path) internal returns (uint finalAmount) {
        uint amountIn = IERC20(_path[0].tokenIn).balanceOf(address(this));
        
        for (uint i = 0; i < _path.length; i++) {
            SwapStep memory step = _path[i];
            uint amountOut;
            
            _approveSpenderIfNeeded(step.tokenIn, 
                step.dexType == DEX_TYPE_UNISWAP_V3 ? address(SWAP_ROUTER) : 
                step.dexType == DEX_TYPE_SUSHISWAP ? address(SUSHI_ROUTER) : 
                step.pool, 
                amountIn);

            if (step.dexType == DEX_TYPE_UNISWAP_V3) {
                amountOut = _executeSingleV3Swap(
                    i+1,
                    step.tokenIn,
                    step.tokenOut,
                    step.fee,
                    amountIn,
                    step.minOut
                );
            } else if (step.dexType == DEX_TYPE_SUSHISWAP) {
                address[] memory path = new address[](2);
                path[0] = step.tokenIn;
                path[1] = step.tokenOut;
                
                try SUSHI_ROUTER.swapExactTokensForTokens(
                    amountIn,
                    step.minOut,
                    path,
                    address(this),
                    block.timestamp + DEADLINE_OFFSET
                ) returns (uint[] memory amounts) {
                    amountOut = amounts[amounts.length - 1];
                    emit SwapExecuted(i+1, DEX_TYPE_SUSHISWAP, step.tokenIn, step.tokenOut, amountIn, amountOut);
                } catch Error(string memory reason) {
                    revert(string(abi.encodePacked("FS:S", _numToString(i+1), "F:", reason)));
                } catch {
                    revert(string(abi.encodePacked("FS:S", _numToString(i+1), "FL")));
                }
            } else if (step.dexType == DEX_TYPE_DODO) {
                // Temporarily disabled DODO functionality
                revert("FS:DODO_TEMP_DISABLED");
            } else {
                revert("FS:IDT");
            }
            
            amountIn = amountOut;
        }
        
        finalAmount = amountIn;
    }

    // --- Helper Functions ---
    function _approveSpenderIfNeeded(address _token, address _spender, uint _amount) internal {
        if (IERC20(_token).allowance(address(this), _spender) < _amount) {
            IERC20(_token).safeApprove(_spender, type(uint256).max);
        }
    }
    
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
            uint8 temp = (48 + uint8(_num - _num / 10 * 10));
            bytes1 b1 = bytes1(temp);
            bstr[k] = b1;
            _num /= 10;
        }
        return string(bstr);
    }

    // --- External Functions ---
    function initiateUniswapV3FlashLoan(
        CallbackType _callbackType,
        address _poolAddress,
        uint _amount0,
        uint _amount1,
        bytes calldata _params
    ) external onlyOwner {
        IUniswapV3Pool pool = IUniswapV3Pool(_poolAddress);
        address token0 = pool.token0();
        address token1 = pool.token1();
        uint24 fee = pool.fee();
        
        bytes memory data = abi.encode(
            FlashCallbackData({
                callbackType: _callbackType,
                amount0Borrowed: _amount0,
                amount1Borrowed: _amount1,
                caller: msg.sender,
                poolBorrowedFrom: _poolAddress,
                token0: token0,
                token1: token1,
                fee: fee,
                params: _params
            })
        );
        
        emit FlashSwapInitiated(msg.sender, _poolAddress, _callbackType, _amount0, _amount1);
        pool.flash(address(this), _amount0, _amount1, data);
    }

    function initiateAaveFlashLoan(
        address _asset,
        uint _amount,
        SwapStep[] calldata _path
    ) external onlyOwner {
        address[] memory assets = new address[](1);
        assets[0] = _asset;
        
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = _amount;
        
        uint256[] memory modes = new uint256[](1);
        modes[0] = 0; // No debt
        
        bytes memory params = abi.encode(ArbParams({
            path: _path,
            initiator: msg.sender
        }));
        
        emit AaveFlashLoanInitiated(msg.sender, _asset, _amount);
        AAVE_POOL.flashLoan(
            address(this),
            assets,
            amounts,
            modes,
            address(this),
            params,
            0
        );
    }

    // --- Emergency Functions ---
    function emergencyWithdraw(address _token) external onlyOwner {
        uint balance = IERC20(_token).balanceOf(address(this));
        IERC20(_token).safeTransfer(owner, balance);
        emit EmergencyWithdrawal(_token, owner, balance);
    }

    function emergencyWithdrawETH() external onlyOwner {
        uint balance = address(this).balance;
        owner.transfer(balance);
        emit EmergencyWithdrawal(address(0), owner, balance);
    }

    // --- Fallback ---
    receive() external payable {}
}
