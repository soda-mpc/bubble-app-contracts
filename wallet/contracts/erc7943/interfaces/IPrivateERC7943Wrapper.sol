// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@sodalabs/bubble-core-contracts/contracts/bubble/MpcCore.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

interface IPrivateERC7943Wrapper is IERC165 {
    event AgentAdded(address indexed agent);
    event AgentRemoved(address indexed agent);
    event CanSendSet(address indexed account, bool allowed);
    event CanReceiveSet(address indexed account, bool allowed);
    event DefaultEligibilitySet(bool sendAllowed, bool receiveAllowed);
    event ForcedTransfer(address indexed from, address indexed to, uint256 amount);
    event ForcedTransferRequested(
        uint256 indexed requestId,
        address indexed from,
        address indexed to,
        uint256 requestedAmount,
        gtUint256 actualAmount
    );
    event Frozen(address indexed account, uint256 amount);

    error ERC7943CannotSend(address account);
    error ERC7943CannotReceive(address account);
    error ERC7943CanTransferNotImplemented();
    error ERC7943NoFrozenTokens(address account);

    function addAgent(address agent) external;
    function removeAgent(address agent) external;
    function isAgent(address agent) external view returns (bool);
    function setCanSend(address account, bool allowed) external;
    function setCanReceive(address account, bool allowed) external;
    function setUserAllowed(address account, bool sendAllowed, bool receiveAllowed) external;
    function setDefaultEligibility(bool sendAllowed, bool receiveAllowed) external;
    function forcedTransfer(address from, address to, uint256 amount) external returns (bool);
    function setFrozenTokens(address account, uint256 amount) external returns (bool);
    function canSend(address account) external view returns (bool);
    function canReceive(address account) external view returns (bool);
    function canTransfer(address from, address to, uint256 amount) external pure returns (bool);
    function getFrozenTokens(address account) external view returns (uint256);
}
