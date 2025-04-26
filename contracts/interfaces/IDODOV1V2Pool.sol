// contracts/interfaces/IDODOV1V2Pool.sol
// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.7.0;

interface IDODOV1V2Pool {
    // --- Swap Functions Needed ---
    function sellBaseToken(uint256 amount, uint256 minReceiveQuote, bytes calldata data) external returns (uint256 receiveQuoteAmount);
    // Add buyBaseToken if you implement selling quote token later
    // function buyBaseToken(uint256 amount, uint256 maxPayQuote, bytes calldata data) external returns (uint256 payQuoteAmount);

    // --- View Functions Needed ---
    function _BASE_TOKEN_() external view returns (address);
    // Add _QUOTE_TOKEN_ if needed for logic later
    // function _QUOTE_TOKEN_() external view returns (address);
}
