# ERC-3643 Private ERC20 Wrapper Implementation Plan

## Goal

Create an ERC-3643-aware version of `PrivateERC20Contract256` that keeps the existing shield/unshield wrapper model while adding identity, compliance, agent, and freeze controls from the private ERC-3643 example.

The new contract should be a smaller, focused implementation. It should not include the OPRF token flows from `PrivateERC20Contract256`, and it should not expose arbitrary issuer mint or burn operations.

## Current Context

- Base wrapper: `wallet/contracts/PrivateERC20Contract256.sol`
- Existing extension pattern: `wallet/contracts/with-restrictions/PrivateERC20WithRestrictionList256.sol`
- ERC-3643 private example: `wallet/tmp/contracts/token/PrivateToken.sol`
- ERC-3643 private interface: `wallet/tmp/contracts/token/IPrivateToken.sol`
- Identity registry interface: `wallet/tmp/contracts/registry/interface/IPrivateIdentityRegistry.sol`
- Compliance interface: `wallet/tmp/contracts/compliance/modular/IPrivateModularCompliance.sol`

`PrivateERC20Contract256` is an underlying-backed wrapper:

- `shield(amount)` transfers underlying ERC20 into the contract and credits encrypted private balance.
- `unshield(amount)` debits encrypted private balance and asynchronously releases underlying ERC20 after MPC decryption.
- `totalSupply` tracks the shielded private supply backed by underlying held by the contract.

`PrivateToken` is an issuer/security-token model:

- identity registry
- modular compliance
- agent role
- full wallet freeze
- partial token freeze
- forced transfer
- mint/burn/recovery flows

The implementation should reuse the useful ERC-3643 controls without changing the wrapper backing invariant.

## Scope

### In Scope

- Add a new contract, likely:
  - `wallet/contracts/erc3643/PrivateERC3643ERC20Contract256.sol`
- Keep the UUPS proxy pattern.
- Keep ERC-7201 namespaced storage for new state.
- Use the existing `PrivateERC20Contract256` shield/unshield accounting model.
- Add ERC-3643 controls around:
  - `shield`
  - `unshield`
  - private transfers
  - private approvals where applicable
  - `transferFrom`
  - pause/unpause
- Add identity registry integration:
  - recipient must be verified before receiving private balances
  - shielder must be verified before shielding
- Add modular compliance integration:
  - `canCreate(address to, uint256 amount)` gates shield/create before underlying is pulled
  - `canTransfer(address from, address to, gtUint256 amount)` gates encrypted transfers
  - `transferred(from, to, effectiveAmount)` is called after private transfers
  - `created(to, clearAmount)` is called after successful shield
  - `destroyed(from, clearAmount)` is called after successful unshield callback
- Add agent role behavior:
  - owner can add/remove agents
  - agents can pause/unpause and manage freezing
  - agents can perform auditable forced transfers for legal/compliance enforcement
- Add factory support for explicit wrapper `master` configuration:
  - existing create overloads may default `master` to the creator for compatibility
  - master-aware overloads must pass the requested `master` into the proxy initializer
  - zero master is rejected
- Add freeze behavior:
  - full wallet freeze blocks sending, receiving, shielding, and new unshield requests
  - partial freeze limits spendable encrypted balance
- Add batch helpers only if they are low-risk wrappers around single-account operations.
- Add tests for identity, compliance, freezing, backing, and upgrade/storage behavior.

### Out of Scope

- OPRF mint/split/merge/burn/redeem flows.
- Arbitrary ERC-3643 issuer `mint`.
- Arbitrary ERC-3643 issuer `burn`.
- `recoveryAddress` unless a specific recovery policy is later agreed.
- TREX factory/gateway integration.
- Migration of existing deployed `PrivateERC20Contract256` proxies unless separately planned.
- Rewriting the base `PrivateERC20Contract256` unless needed for a small internal hook.
- Supporting fee-on-transfer, rebasing, elastic-supply, reflection, or otherwise balance-mutating underlying tokens.
- Canceling, quarantining, or blocking an unshield request that was already accepted before the wallet was frozen.

## Assumptions

- This token remains fully underlying-backed. Private supply must correspond to underlying ERC20 held by the contract.
- The underlying token is a standard, non-rebasing ERC20 that transfers exact requested amounts.
- Fee-on-transfer, rebasing, elastic-supply, reflection, and upgradeable tokens that can later introduce those behaviors are not supported.
- Shielding is the only way to create private wrapper supply.
- Unshielding is the only way to destroy private wrapper supply and release underlying.
- A full wallet freeze blocks new unshield requests. It does not retroactively cancel an already accepted asynchronous unshield request.
- Compliance modules can handle the wrapper model:
  - clear `canCreate(user, amount)` checks for shield/create, because shield amount is public
  - `user -> address(0)` for unshield/destroy
  - `user -> user` for private transfers
- The identity registry and compliance contracts are already deployed and managed externally.
- The ERC-3643 interfaces copied from `wallet/tmp` can be adapted for this project by fixing imports and compiler pragmas.
- Licensing for importing or deriving from the ERC-3643 example/interface is acceptable for this repository.

## Proposed Contract Design

### Storage Layout Decision

Use ERC-7201 namespaced storage as the single storage strategy for this implementation and for future private ERC20 variants.

The current production contract already mostly follows this model:

- OpenZeppelin v5 upgradeable bases use ERC-7201 storage namespaces.
- `PrivateERC20Contract256` stores token state in `bubble.storage.PrivateERC20Contract256`.
- Existing feature extensions, such as `PrivateERC20WithRestrictionList256`, add their own ERC-7201 namespace.

The ERC-3643 PoC uses a different model:

- `PrivateTokenStorage` stores token state directly in inherited storage slots and reserves a `__gap`.
- `AgentRoleUpgradeable` stores role data directly through inherited storage.
- The PoC combines token balances, metadata, freezing, identity registry, compliance, and mint/burn request state in one inherited storage contract.

Do not mix these two approaches. For this repository, the ERC-3643 implementation should use ERC-7201 consistently:

- Do not inherit `PrivateTokenStorage`.
- Do not inherit the PoC `AgentRoleUpgradeable`.
- Do not copy the PoC storage layout.
- Put shared wrapper state in a wrapper ERC-7201 namespace.
- Put ERC-3643 feature state in a separate ERC-7201 namespace.
- Treat any direct-storage parent as an explicit exception that must be kept stable.

`DecryptionCaller` currently uses direct inherited storage for `decryptCounter` and `decryptHandles`. That is already part of the existing production inheritance model and can remain as an accepted exception unless we later introduce a namespaced replacement.

### Underlying Token Policy

The ERC-3643 wrapper is intended for standard ERC20 underlyings that preserve a one-to-one backing invariant:

```text
private totalSupply == underlying.balanceOf(wrapper)
```

within the normal timing limits of pending asynchronous unshield callbacks.

Fee-on-transfer tokens are not supported because `transferFrom(account, wrapper, amount)` can move less than `amount` while the wrapper would otherwise credit `amount` of private balance. Rebasing, elastic-supply, and reflection tokens are also not supported because `underlying.balanceOf(wrapper)` can change without any shield or unshield action, which can make the wrapper undercollateralized or overcollateralized after deployment.

This cannot be fully verified upfront onchain for arbitrary ERC20s. A shield-time balance-delta check can detect many fee-on-transfer cases, but it cannot prove that a token will not rebase or change behavior later. Treat this as an integration and deployment requirement: only approved, exact-transfer, non-rebasing underlyings should be used.

### OPRF And Base Contract Implication

Inheriting `PrivateERC20Contract256` does not truly remove OPRF. Even if the ERC-3643 wrapper ABI does not expose OPRF methods, the inherited bytecode and the `_oprfKey` storage field remain.

To reduce code size and complexity for the ERC-3643 wrapper, prefer creating a reduced shared wrapper base rather than inheriting the current OPRF-heavy base directly.

Recommended shape:

```solidity
contract PrivateERC20Wrapper256Base is
    DecryptionCaller,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable
{
    // Shield/unshield, balances, allowances, underlying backing, no OPRF.
}

contract PrivateERC3643ERC20Contract256 is
    PrivateERC20Wrapper256Base,
    IPrivateERC3643Wrapper
{
    // Identity, compliance, agents, freezing.
}
```

This creates one consistent storage model for:

- the reduced wrapper base
- the ERC-3643 extension
- future private ERC20 variants

### Contract Shape

Create a sibling ERC-3643 contract rather than modifying the current `PrivateERC20Contract256`. Prefer a reduced wrapper base without OPRF, then layer ERC-3643 state on top:

```solidity
contract PrivateERC3643ERC20Contract256 is PrivateERC20Wrapper256Base, IPrivateERC3643Wrapper
```

The final interface name can be one of:

- `IPrivateToken`, if we can cleanly implement the copied ERC-3643 interface.
- `IPrivateERC3643Wrapper`, if the original `IPrivateToken` requires unsupported mint/burn/recovery methods.

Preferred approach: define `IPrivateERC3643Wrapper` as the wrapper-specific interface that is compatible with the ERC-3643 parts we support, and explicitly exclude mint/burn/recovery. The interface name should include `ERC3643` so future private ERC20 variants can define their own purpose-specific interfaces without overloading a generic `IPrivateTokenLike` name.

### Storage

Use a new ERC-7201 storage namespace for ERC-3643-specific state:

```solidity
/// @custom:storage-location erc7201:bubble.storage.PrivateERC3643ERC20Contract256
struct PrivateERC3643ERC20Contract256Storage {
    IPrivateIdentityRegistry identityRegistry;
    IPrivateModularCompliance compliance;
    address onchainID;
    mapping(address => bool) agents;
    mapping(address => bool) frozen;
    mapping(address => gtUint256) frozenTokens;
}
```

Do not add ERC-3643 fields to the shared wrapper-base storage namespace unless they are truly generic wrapper fields. Keep feature state separate.

If unshield callback needs to notify compliance with the original sender, extend the existing unshield request data in the new contract namespace rather than changing the base namespace.

### Initializer

Add an initializer that includes the wrapper and ERC-3643 dependencies:

```solidity
function initialize(
    string memory name_,
    string memory symbol_,
    address underlying_,
    address owner_,
    address master_,
    bool underlyingIsWrappedNative_,
    address identityRegistry_,
    address compliance_,
    address onchainID_
) public initializer
```

Initializer responsibilities:

- initialize `PrivateERC20Wrapper256Base`
- validate non-zero identity registry and compliance
- store identity registry, compliance, onchain ID
- bind compliance to the token, if required by the compliance implementation
- add the owner as the initial agent
- emit ERC-3643-style metadata, identity, compliance, and agent events

## Function Behavior

### Shield

Requirements:

- contract not paused
- caller not frozen
- caller identity is verified
- clear compliance `canCreate(caller, amount)` allows the shield amount before underlying is pulled
- underlying transfer succeeds and the underlying token is assumed to transfer the exact requested amount

Effects:

- underlying is transferred into the wrapper
- encrypted balance increases
- total supply increases by clear shield amount
- `compliance.created(caller, amount)` is called
- existing `Shield(caller, amount)` event remains

### Unshield

Requirements:

- contract not paused
- caller not frozen
- requested amount is greater than zero
- requested amount is within free encrypted balance after partial freeze

Effects:

- encrypted balance is debited by the effective amount
- unshield request stores recipient and original user
- callback decrypts effective amount
- callback releases underlying
- callback decrements total supply by actual decrypted amount
- callback calls `compliance.destroyed(user, actualAmount)`
- existing `Unshield` / `UnshieldFailed` events remain

Freeze timing semantics:

- A wallet must be unfrozen when it submits an unshield request.
- If the wallet is frozen after the request is accepted but before the MPC callback arrives, the callback is still allowed to settle the already-debited request.
- Stronger behavior, such as callback-time freeze re-checks, request cancellation, or quarantined releases, is intentionally out of scope for this iteration.

Open implementation detail: the base contract currently stores unshield request metadata privately. The ERC-3643 variant may need to override unshield request/callback logic or introduce a new callback path to retain the original user for compliance notification.

### Transfers

Requirements:

- contract not paused
- sender not frozen
- recipient not frozen
- recipient identity is verified
- amount is within sender free balance after partial freeze
- compliance allows the transfer

Effects:

- if policy allows, transfer the encrypted amount
- if policy denies due to encrypted checks, transfer zero where privacy semantics require non-reverting behavior
- call `compliance.transferred(from, to, effectiveAmount)`
- emit the no-amount `Transfer(from, to)` event for both clear and encrypted transfer entrypoints
- do not emit `Transfer(from, to, requestedAmount)` because compliance and partial-freeze checks can turn the effective transfer into zero without a synchronous clear result

### Forced Transfers

Forced transfers are agent-only enforcement operations intended for legal/compliance situations, such as a court order.

Requirements:

- contract not paused
- caller is an agent
- `from` and `to` are non-zero and distinct
- requested amount is greater than zero
- recipient wallet is not frozen
- recipient identity is verified

Semantics:

- the requested amount is public
- the actual moved amount is computed privately as `min(balanceOf(from), requestedAmount)`
- source full-freeze does not block forced transfer
- source partial-frozen accounting is capped down if the forced transfer leaves source balance below the previous frozen amount
- compliance is notified with the encrypted actual amount
- a no-amount `Transfer(from, to)` event is emitted
- `ForcedTransferRequested(requestId, from, to, requestedAmount, actualAmountHandle)` is emitted immediately
- MPC decrypts the actual moved amount asynchronously
- `ForcedTransferFinalized(requestId, from, to, actualAmount)` emits the public final result

This intentionally avoids emitting the requested amount as if it were the actual moved amount. If the source wallet has less than requested, the finalized event reveals the actual amount moved.

### Approvals

Requirements:

- contract not paused
- owner/caller not frozen
- spender not frozen

Effects:

- preserve current encrypted allowance behavior
- emit compatible approval events

Approvals do not call compliance directly unless a compliance module explicitly requires approval-time checks.

### Pause

Recommended behavior:

- `pause()` and `unpause()` become agent-only in the ERC-3643 wrapper.
- upgrade authorization remains owner-only.

This matches the ERC-3643 operational model while keeping UUPS governance separate.

### Full Freeze

Agent-only:

```solidity
function setAddressFrozen(address user, bool frozen) external onlyAgent
```

Frozen addresses cannot:

- shield
- unshield
- send
- receive
- approve
- be used as transfer source or destination

### Partial Freeze

Agent-only:

```solidity
function freezePartialTokens(address user, itUint256 calldata amount) external onlyAgent
function unfreezePartialTokens(address user, itUint256 calldata amount) external onlyAgent
```

Partial freeze is tracked as encrypted handles. Transfer and unshield checks use:

```text
freeBalance = balance - frozenTokens
```

If the requested operation exceeds free balance, the operation should either:

- resolve to zero effective amount for privacy-preserving transfer paths, or
- fail before request creation for clear unshield paths where the amount is public.

The exact behavior should be covered by tests.

## Interface Plan

The existing `IPrivateToken` includes methods that are intentionally out of scope:

- `mint`
- `burn`
- `batchMint`
- `batchBurn`
- `recoveryAddress`

Recommended interface approach:

1. Create `IPrivateERC3643Wrapper`.
2. Include the ERC-3643-compatible subset:
   - metadata getters
   - identity/compliance getters and setters
   - pause/unpause
   - agent management
   - freeze management
   - auditable forced transfer
   - transfer/approval functions already supported by the wrapper
3. Do not claim full `IPrivateToken` compatibility until unsupported methods have an agreed policy.

This keeps the ABI honest and avoids no-op or misleading methods.

## Factory Plan

Add a dedicated factory only after the contract compiles and tests pass:

- `wallet/contracts/erc3643/PrivateERC3643ERC20Factory256.sol`

Factory parameters:

- implementation address
- name
- symbol
- underlying
- owner
- master
- wrapped-native flag
- identity registry
- compliance
- onchain ID

The factory should mirror the existing `PrivateERC20Factory` and `PrivateERC20WithRestrictionListFactory256` patterns.

## Testing Plan

Add focused tests under `wallet/test/`:

- deployment initializes wrapper metadata, owner, master, identity registry, compliance, and initial agent
- verified user can shield
- unverified user cannot shield
- frozen user cannot shield
- shield calls `compliance.created`
- verified recipient can receive encrypted transfer
- unverified recipient cannot receive encrypted transfer
- frozen sender cannot send
- frozen recipient cannot receive
- partial freeze limits transfer amount
- partial freeze limits unshield amount
- compliance-denied transfer does not move value
- successful transfer calls `compliance.transferred`
- successful unshield callback calls `compliance.destroyed`
- unshield callback preserves 1:1 backing and total supply
- owner can add/remove agents
- non-agent cannot pause or freeze
- owner-only upgrade authorization still works
- storage layout validation for UUPS upgrade safety

Test doubles needed:

- mock private identity registry
- mock private modular compliance with configurable allow/deny behavior
- existing mock ERC20/underlying token

Runtime test target:

- Static ABI and artifact checks can run on the default local Hardhat network.
- Any test that executes `MpcCore` operations must run against a real MPC-enabled network.
- The intended runtime target is `sepolia-arbitrum` from `hardhat.config.ts`.
- Runtime tests should follow the existing live-MPC test style:
  - use the real proxy/encryption helpers
  - use encrypted inputs for private operations
  - wait for MPC processing/decryption where callbacks are involved
  - avoid local-only assumptions about mocked MPC precompiles

## Task List

### Phase 1: Extract Reduced Wrapper Base

Goal: create and prove a smaller private ERC20 wrapper base before adding ERC-3643.

Tasks:

1. Create `wallet/contracts/base/PrivateERC20Wrapper256Base.sol`.
2. Move the non-OPRF wrapper functionality from `PrivateERC20Contract256` into the base:
   - metadata
   - total supply
   - encrypted balances
   - encrypted allowances
   - underlying token configuration
   - wrapped-native configuration
   - shield
   - unshield
   - unshield callback
   - pause support
   - owner-controlled upgrade authorization
   - emergency underlying/native recovery if still required
3. Exclude all OPRF-specific state, structs, events, and functions.
4. Use a new ERC-7201 storage namespace for the reduced base.
5. Make extension points `internal` or `virtual` where ERC-3643 will need hooks:
   - transfer policy evaluation
   - balance debit for unshield
   - unshield request metadata
   - post-shield notification
   - post-transfer notification
   - post-unshield notification
6. Add or adapt tests proving the reduced base matches current wrapper behavior for shield, unshield, transfer, approval, pausing, wrapped-native unshield, and upgrade authorization.
7. Compile and run the focused base test suite before starting ERC-3643.

### Phase 2: Define ERC-3643 Wrapper Interfaces

Goal: define the ABI honestly for the supported ERC-3643 wrapper subset.

Tasks:

1. Create `IPrivateERC3643Wrapper`.
2. Add adapted identity and compliance interfaces with imports fixed for this repo and `pragma ^0.8.26`.
3. Include only supported wrapper methods:
   - metadata getters
   - `onchainID`
   - identity registry getter/setter
   - compliance getter/setter
   - agent management
   - pause/unpause
   - full freeze
   - partial freeze
   - existing encrypted balance/transfer/approval methods
   - shield/unshield methods
4. Explicitly omit arbitrary issuer mint, burn, and recovery methods.

### Phase 3: Implement ERC-3643 State And Admin

Goal: layer ERC-3643 configuration and permissions on top of the reduced wrapper base.

Tasks:

1. Create `wallet/contracts/erc3643/PrivateERC3643ERC20Contract256.sol`.
2. Add an ERC-7201 namespace for ERC-3643 state:
   - identity registry
   - compliance
   - onchain ID
   - agents
   - frozen wallets
   - partially frozen encrypted balances
3. Add initializer parameters for identity registry, compliance, and onchain ID.
4. Add owner-only metadata/admin setters.
5. Add owner-only agent add/remove functions.
6. Make pause/unpause and freeze functions agent-only.
7. Bind/unbind compliance where required by the compliance implementation.

### Phase 4: Implement ERC-3643 Runtime Checks

Goal: enforce identity, compliance, and freezing around wrapper operations.

Tasks:

1. Add shield checks:
   - caller not frozen
   - caller identity verified
   - compliance allows create-style flow
   - notify `compliance.created` after successful shield
2. Add transfer checks:
   - sender not frozen
   - recipient not frozen
   - recipient identity verified
   - amount within free balance after partial freeze
   - compliance allows transfer
   - notify `compliance.transferred` with effective encrypted amount
3. Add approval checks:
   - owner/caller not frozen
   - spender not frozen
4. Add unshield checks:
   - caller not frozen
   - amount within free balance after partial freeze
   - store enough request metadata to notify compliance in callback
   - notify `compliance.destroyed` after successful callback
5. Add partial freeze and unfreeze encrypted balance logic.

### Phase 5: Test ERC-3643 Behavior

Goal: cover the scoped ERC-3643 wrapper behavior before adding deployment helpers.

Tasks:

1. Add mock identity registry.
2. Add mock modular compliance with configurable allow/deny behavior and event/log tracking.
3. Test initialization and admin behavior.
4. Test verified/unverified shield behavior.
5. Test frozen wallet behavior.
6. Test partial freeze transfer and unshield limits.
7. Test compliance-denied transfers.
8. Test compliance notifications for shield, transfer, and unshield.
9. Test backing invariant: underlying held by the contract matches private supply after successful callbacks.
10. Test upgrade/storage behavior.

### Phase 6: Add Factory And Scripts

Goal: add deployment support only after the contract behavior is stable.

Tasks:

1. Create `PrivateERC3643ERC20Factory256`.
2. Mirror the existing factory deployment style.
3. Add deployment script only if needed for the target environment.
4. Add verification notes for the new implementation and factory.

### Phase 7: Final Verification

Goal: confirm the new implementation is isolated and does not regress existing contracts.

Tasks:

1. Run `npm run compile`.
2. Run focused base-wrapper tests.
3. Run ERC-3643 wrapper tests.
4. Run existing `PrivateERC20Contract256` tests to confirm no regression.
5. Check generated ABI to confirm OPRF methods are absent from the new ERC-3643 wrapper.
6. Check generated ABI to confirm arbitrary mint/burn methods are absent unless an unsupported-interface policy is explicitly added.

## Risks And Notes

- Code size should improve by excluding OPRF. This requires a reduced wrapper base; inheriting the current `PrivateERC20Contract256` would still include OPRF bytecode and storage.
- The current base contract has some private helpers and private unshield request storage. If they block clean overrides, we should extract protected hooks or create a reduced wrapper base rather than duplicate too much logic.
- The original `IPrivateToken` event signatures may not be directly compatible with the base wrapper events. A wrapper-specific interface avoids event conflicts.
- Compliance notification on unshield requires knowing the original user at callback time. This likely needs custom request metadata in the ERC-3643 variant.
- Any direct use of the ERC-3643 example code may carry GPL obligations. Confirm licensing before copying non-interface implementation logic.

## Acceptance Criteria

- The new contract compiles with Solidity `0.8.26`.
- Existing `PrivateERC20Contract256` tests continue to pass.
- New ERC-3643 wrapper tests cover identity, compliance, freezing, shield, transfer, and unshield behavior.
- The wrapper never creates private supply except via successful `shield`.
- The wrapper never releases underlying except via successful `unshield`.
- OPRF methods are absent from the new contract ABI.
- Arbitrary issuer mint/burn methods are absent from the new contract ABI or explicitly unsupported by the chosen wrapper interface.
