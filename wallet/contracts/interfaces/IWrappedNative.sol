// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Wrapped native token (WETH / WPOL style) used as an underlying that can unwrap to native.
interface IWrappedNative is IERC20 {
    function withdraw(uint256 wad) external;
    function deposit() external payable;
}
