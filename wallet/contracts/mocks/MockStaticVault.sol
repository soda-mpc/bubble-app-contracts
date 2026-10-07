// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice 1:1 non-rebasing vault used as a stand-in for a static aToken.
/// @dev `deposit` pulls `asset` and mints the same number of share tokens to `receiver`.
///      Share balances do not rebase, so they can be the underlying of a private token.
contract MockStaticVault is ERC20 {
    IERC20 public immutable asset;

    constructor(IERC20 asset_, string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        asset = asset_;
    }

    /// @notice Pull `assets` from the caller and mint the same amount of shares to `receiver`.
    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        require(assets > 0, "Amount must be greater than 0");
        require(receiver != address(0), "Receiver cannot be zero address");
        require(asset.transferFrom(msg.sender, address(this), assets), "Transfer failed");
        shares = assets;
        _mint(receiver, shares);
    }
}
