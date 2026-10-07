// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Vault that pulls an underlying asset and mints its own share token 1:1 or via ERC-4626.
interface IDepositVault {
    function asset() external view returns (address);

    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
}

/// @notice Private token that escrows share tokens and mints an OPRF note to `recipient`.
interface IShieldAndMint {
    function shieldAndMint(uint256 amount, address recipient) external;
}

/// @title VaultDepositBatcher
/// @notice One call deposits vault assets and mints the resulting shares as a private note.
/// @dev The private token's underlying must be the vault's share token. For `MockStaticVault` and
///      ERC-4626 vaults, that share token is the vault contract itself.
contract VaultDepositBatcher {
    using SafeERC20 for IERC20;

    struct Permit {
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @notice Pull `assets` from the caller, deposit them, and mint a note for the shares to the caller.
    /// @dev A non-zero `permit.deadline` submits an EIP-2612 permit for `assets` before the pull.
    ///      The note is permitted to `msg.sender`, not to this contract.
    /// @param vault Deposit vault whose token is the share token.
    /// @param pShare Private token whose underlying is `vault`.
    /// @param assets Amount of the vault asset to deposit.
    /// @param permit EIP-2612 permit. Ignored when `deadline` is zero; the caller must already have approved this contract.
    /// @return shares Share tokens minted by the vault and wrapped into the note.
    function depositAndMint(
        IDepositVault vault,
        address pShare,
        uint256 assets,
        Permit calldata permit
    ) external returns (uint256 shares) {
        require(assets > 0, "Amount must be greater than 0");
        require(pShare != address(0), "pShare cannot be zero address");

        IERC20 asset = IERC20(vault.asset());
        if (permit.deadline != 0) {
            IERC20Permit(address(asset)).permit(
                msg.sender,
                address(this),
                assets,
                permit.deadline,
                permit.v,
                permit.r,
                permit.s
            );
        }

        asset.safeTransferFrom(msg.sender, address(this), assets);
        asset.forceApprove(address(vault), assets);
        shares = vault.deposit(assets, address(this));

        IERC20(address(vault)).forceApprove(pShare, shares);
        IShieldAndMint(pShare).shieldAndMint(shares, msg.sender);
    }
}
