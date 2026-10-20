// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test wrapped-native token. With `stipendOnly`, `withdraw` pays out like WETH9 (`transfer`, 2300 gas),
///         which cannot reach a proxy; otherwise it pays with a plain `call`.
contract WrappedNativeMock is ERC20 {
    bool public immutable stipendOnly;

    constructor(bool stipendOnly_) ERC20("Wrapped Native Mock", "WNM") {
        stipendOnly = stipendOnly_;
    }

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 wad) external {
        _burn(msg.sender, wad);
        if (stipendOnly) {
            payable(msg.sender).transfer(wad);
        } else {
            (bool ok, ) = payable(msg.sender).call{value: wad}("");
            require(ok, "Native send failed");
        }
    }
}
