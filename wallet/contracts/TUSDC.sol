// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Test USDC with the gasless surfaces Circle USDC exposes, plus a signed mint for the test stand.
///         EIP-2612 `permit` sets an allowance. EIP-3009 moves tokens with no allowance.
///         `mintWithAuthorization` mints to the signer; a facilitator submits it and pays gas.
///         The EIP-712 domain version is "1" (OpenZeppelin ERC20Permit). USDC mainnet uses "2";
///         the typehashes match, so signers must use version "1" for this token.
contract TUSDC is ERC20, ERC20Permit {
    bytes32 public constant MINT_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "MintWithAuthorization(address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH = keccak256(
        "CancelAuthorization(address authorizer,bytes32 nonce)"
    );

    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    uint8 private _decimals = 18;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) ERC20Permit(name_) {
        _mint(msg.sender, 1000000 * 10 ** _decimals);
    }

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    /// @notice Mints `value` to `to`. `to` signs the authorization; anyone may submit it and pay gas.
    /// @dev Uses the same nonce set as EIP-3009, so `cancelAuthorization` from `to` invalidates an unused mint.
    function mintWithAuthorization(
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(block.timestamp > validAfter, "Auth not yet valid");
        require(block.timestamp < validBefore, "Auth expired");
        require(!authorizationState[to][nonce], "Auth used");

        bytes32 structHash = keccak256(
            abi.encode(MINT_WITH_AUTHORIZATION_TYPEHASH, to, value, validAfter, validBefore, nonce)
        );
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), v, r, s);
        require(signer == to, "Invalid signature");

        authorizationState[to][nonce] = true;
        _mint(to, value);
    }

    function burn(address account, uint256 amount) external {
        _burn(account, amount);
    }

    function setDecimals(uint8 decimals_) external {
        _decimals = decimals_;
    }

    function decimals() public view virtual override returns (uint8) {
        return _decimals;
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _requireValidAuthorization(from, to, value, validAfter, validBefore, nonce, TRANSFER_WITH_AUTHORIZATION_TYPEHASH, v, r, s);
        _transfer(from, to, value);
    }

    /// @dev The payee submits this. `to` must be the caller, matching FiatToken.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(to == msg.sender, "Caller must be the payee");
        _requireValidAuthorization(from, to, value, validAfter, validBefore, nonce, RECEIVE_WITH_AUTHORIZATION_TYPEHASH, v, r, s);
        _transfer(from, to, value);
    }

    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        require(!authorizationState[authorizer][nonce], "Auth used");
        bytes32 structHash = keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce));
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), v, r, s);
        require(signer == authorizer, "Invalid signature");
        authorizationState[authorizer][nonce] = true;
    }

    function _requireValidAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes32 typeHash,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) private {
        require(block.timestamp > validAfter, "Auth not yet valid");
        require(block.timestamp < validBefore, "Auth expired");
        require(!authorizationState[from][nonce], "Auth used");

        bytes32 structHash = keccak256(abi.encode(typeHash, from, to, value, validAfter, validBefore, nonce));
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), v, r, s);
        require(signer == from, "Invalid signature");

        authorizationState[from][nonce] = true;
    }
}
