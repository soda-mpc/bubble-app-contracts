// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@sodalabs/bubble-core-contracts/contracts/bubble/MpcCore.sol";

interface IPrivateSecurityTokenCompliance {
    event TokenBound(address token);
    event TokenUnbound(address token);

    function bindToken(address token) external;
    function unbindToken(address token) external;
    function transferred(address from, address to, gtUint256 amount) external;
    function created(address to, gtUint256 amount) external;
    function destroyed(address from, gtUint256 amount) external;
    function canCreate(address to, gtUint256 amount) external returns (gtBool);
    function canTransfer(address from, address to, gtUint256 amount) external returns (gtBool);
    function getTokenBound() external view returns (address);
}
