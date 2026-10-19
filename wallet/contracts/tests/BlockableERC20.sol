// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test underlying whose transfers to a blocked address revert, like a stablecoin blocklist.
///         Used to force an unshield payout to fail and be parked.
contract BlockableERC20 is ERC20 {
    mapping(address => bool) public blocked;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to], "Recipient blocked");
        super._update(from, to, value);
    }
}
