// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "../PrivateERC20Contract256.sol";

/// @title PrivateERC20Contract256V2
/// @notice Version 2 of PrivateERC20Contract256 with additional functionality used for testing upgradeability
/// @dev This contract extends PrivateERC20Contract256 to test upgradeability
///      It adds a dummy function to verify that upgrades work correctly
contract PrivateERC20Contract256V2 is PrivateERC20Contract256 {
    /// @notice Dummy value stored in V2 to test state preservation
    uint256 private _v2DummyValue;
    
    /// @notice Event emitted when dummy value is set
    event V2DummyValueSet(uint256 oldValue, uint256 newValue);
    
    /// @notice Dummy function to test that V2 functionality works after upgrade
    /// @return A constant value to verify the function exists and works
    function getV2Version() public pure returns (string memory) {
        return "V2.0.0";
    }
    
    /// @notice Sets a dummy value (for testing state in V2)
    /// @param value The value to set
    /// @dev Only owner can set this value
    function setV2DummyValue(uint256 value) external onlyOwner {
        uint256 oldValue = _v2DummyValue;
        _v2DummyValue = value;
        emit V2DummyValueSet(oldValue, value);
    }
    
    /// @notice Gets the dummy value
    /// @return The current dummy value
    function getV2DummyValue() external view returns (uint256) {
        return _v2DummyValue;
    }
    
    /// @notice A simple calculation function to test V2 functionality
    /// @param a First number
    /// @param b Second number
    /// @return The sum of a and b
    function v2Add(uint256 a, uint256 b) public pure returns (uint256) {
        return a + b;
    }
}

