# ERC-7943 Private ERC20 Wrapper Implementation Plan

## Goal

Create an ERC-7943-aware private ERC20 wrapper variant that reuses the reduced `PrivateERC20Wrapper256Base` shield/unshield model while exposing the ERC-7943 fungible RWA interface primitives.

The implementation should be a sibling of the ERC-3643 wrapper, not a replacement. ERC-7943 is intentionally smaller and less opinionated: it standardizes eligibility checks, frozen-token accounting, and forced-transfer enforcement without mandating identity registry or modular compliance architecture.

## Current Context

- Shared wrapper base: `wallet/contracts/base/PrivateERC20Wrapper256Base.sol`
- ERC-3643 wrapper: `wallet/contracts/erc3643/PrivateERC3643ERC20Contract256.sol`
- ERC-3643 factory: `wallet/contracts/erc3643/PrivateERC3643ERC20Factory256.sol`
- ERC-3643 plan: `wallet/docs/ERC3643_PRIVATE_ERC20_PLAN.md`
- ERC-7943 specification: `https://eips.ethereum.org/EIPS/eip-7943`

The ERC-7943 fungible interface includes:

- `forcedTransfer(address from, address to, uint256 amount)`
- `setFrozenTokens(address account, uint256 amount)`
- `canSend(address account)`
- `canReceive(address account)`
- `canTransfer(address from, address to, uint256 amount)`
- `getFrozenTokens(address account)`
- `ForcedTransfer(address indexed from, address indexed to, uint256 amount)`
- `Frozen(address indexed account, uint256 amount)`
- ERC-165 support for fungible interface id `0x3edbb4c4` only after all required functions have compliant semantics

## Scope

### In Scope

- Add a new contract:
  - `wallet/contracts/erc7943/PrivateERC7943ERC20Contract256.sol`
- Add a new factory:
  - `wallet/contracts/erc7943/PrivateERC7943ERC20Factory256.sol`
- Add a wrapper-specific interface:
  - `wallet/contracts/erc7943/interfaces/IPrivateERC7943Wrapper.sol`
- Extend `PrivateERC20Wrapper256Base`.
- Keep UUPS proxy deployment pattern.
- Keep ERC-7201 namespaced storage for ERC-7943-specific state.
- Implement ERC-165 `supportsInterface`, but do not advertise ERC-7943 support while `canTransfer` is not implemented.
- Implement fungible ERC-7943 view functions:
  - `canSend`
  - `canReceive`
  - `getFrozenTokens`
- Add a `canTransfer(address from, address to, uint256 amount)` placeholder that reverts with `ERC7943CanTransferNotImplemented`.
- Implement ERC-7943 enforcement/admin functions:
  - `setFrozenTokens`
  - `forcedTransfer`
- Reuse the same async forced-transfer semantics agreed for ERC-3643:
  - requested amount is public
  - actual amount is private `min(balance, requestedAmount)`
  - `ForcedTransferRequested` emits the encrypted actual amount handle
  - callback decrypts and emits the ERC-7943 `ForcedTransfer(from, to, actualAmount)`
- Add owner/agent style access control for sensitive functions:
  - owner manages agents
  - agents can set eligibility, freeze amounts, pause/unpause, and forced-transfer
- Add a deployment/setup script or extend `setup-erc3643-environment.ts` only after the contract shape is stable.
- Add live Arbitrum Sepolia E2E with real MPC, mirroring ERC-3643 test style.

### Out of Scope

- OPRF flows.
- Issuer mint/burn.
- ERC-3643 identity registry integration unless added as an optional extension later.
- Modular compliance contracts unless added as an optional extension later.
- Full TREX/3643 suite integration.
- Legal proof/document URI events for forced transfers; defer this to a later extension.
- Fee-on-transfer/rebasing/elastic/reflection underlyings.
- ERC-721/ERC-1155/ERC-6909 ERC-7943 variants.

## Assumptions

- This remains an underlying-backed private wrapper:
  - shield creates private supply
  - unshield destroys private supply and releases underlying
  - total supply should match underlying backing after successful callbacks
- Underlying token must be a standard non-rebasing ERC20 with exact transfers.
- ERC-7943 account eligibility is local to this wrapper variant unless/until we add an external registry.
- ERC-7943 frozen amounts are **clear `uint256` values** for strict fungible interface compatibility.
- Private transfer operations can still resolve to zero internally when private balance/free-balance checks fail.
- No amount-bearing `Transfer(from, to, requestedAmount)` events should be emitted by the private wrapper because actual amount can differ privately.
- Frozen/free-balance violations in transfer and unshield should resolve to zero/no-op instead of reverting with `ERC7943InsufficientUnfrozenBalance`. This preserves the existing private wrapper semantics where the encrypted result determines whether value moves.
- Forced transfer should finalize with the actual moved amount. If the requested amount exceeds the forceable frozen/private amount, the callback emits `ForcedTransfer(from, to, actualAmount)` rather than reverting the already accepted async request.

## Main Design Decisions

### canTransfer Is Not Implemented In V1

ERC-7943 defines:

```solidity
function canTransfer(address from, address to, uint256 amount) external view returns (bool allowed);
```

Parameters:

- `from`: account that would send tokens
- `to`: account that would receive tokens
- `amount`: clear public amount to check

For this private wrapper, a truthful transferability answer depends on encrypted balance and encrypted free-balance checks. A `view` function cannot run the required MPC operations or resolve whether the sender has enough private unfrozen balance.

Therefore v1 should not pretend that `canTransfer` can fully predict runtime behavior. The plan is:

- enforce transfer policy inside actual transfer execution
- expose `canSend` and `canReceive` as view eligibility checks
- expose `getFrozenTokens` as clear frozen amount
- leave `canTransfer` not implemented for v1
- do not return `true` for ERC-7943 ERC-165 interface id `0x3edbb4c4` until `canTransfer` has an agreed compliant implementation

If ABI compatibility is useful, add:

```solidity
error ERC7943CanTransferNotImplemented();

function canTransfer(address, address, uint256) external pure returns (bool) {
    revert ERC7943CanTransferNotImplemented();
}
```

This keeps behavior honest for integrators.

### Strict ERC-7943 Frozen Amounts

Use clear frozen amounts:

```solidity
mapping(address => uint256) frozenTokens;
```

This allows exact ERC-7943 compatibility for:

```solidity
function getFrozenTokens(address account) external view returns (uint256);
function setFrozenTokens(address account, uint256 amount) external returns (bool);
event Frozen(address indexed account, uint256 amount);
```

During private transfer checks, convert the clear frozen amount into a public MPC handle:

```solidity
gtUint256 frozen = MpcCore.setPublic256(frozenTokens[account]);
```

### Eligibility Model

Start with simple local eligibility:

```solidity
mapping(address => bool) sendAllowed;
mapping(address => bool) receiveAllowed;
bool defaultSendAllowed;
bool defaultReceiveAllowed;
```

Recommended defaults:

- ERC-7943 does not prescribe defaults.
- The initializer must make defaults explicit with `defaultSendAllowed` and `defaultReceiveAllowed`.
- For regulated/scratch deployments that should match the ERC-3643-style test posture, use deny-all defaults:
  - `defaultSendAllowed = false`
  - `defaultReceiveAllowed = false`

This makes the wrapper permissioned by default. Agents can explicitly allow accounts.

Optional admin functions:

```solidity
function setCanSend(address account, bool allowed) external onlyAgent;
function setCanReceive(address account, bool allowed) external onlyAgent;
function setUserAllowed(address account, bool sendAllowed, bool receiveAllowed) external onlyAgent;
function setDefaultEligibility(bool sendAllowed, bool receiveAllowed) external onlyOwner;
```

Events:

```solidity
event CanSendSet(address indexed account, bool allowed);
event CanReceiveSet(address indexed account, bool allowed);
event DefaultEligibilitySet(bool sendAllowed, bool receiveAllowed);
```

### Access Control

Use the same owner/agent model as ERC-3643:

- Owner:
  - add/remove agents
  - set defaults
  - set metadata/admin config
  - authorize upgrades
- Agent:
  - pause/unpause
  - set account eligibility
  - set frozen tokens
  - forced transfer

ERC-7943 does not mandate a specific access-control mechanism, only that sensitive functions are restricted.

Keep the ERC-7943 agent-role implementation isolated from ERC-3643 for v1. The logic is intentionally small, and duplicating the minimal owner/agent checks gives better bytecode-size control than introducing a shared inheritance layer.

## Contract Shape

```solidity
contract PrivateERC7943ERC20Contract256 is
    PrivateERC20Wrapper256Base,
    IPrivateERC7943Wrapper,
    ERC165Upgradeable
{
    // ERC-7943 state and enforcement.
}
```

If adding `ERC165Upgradeable` increases size too much, implement `supportsInterface` directly:

```solidity
function supportsInterface(bytes4 interfaceId) public view returns (bool) {
    return interfaceId == type(IERC165).interfaceId;
}
```

## Storage

Use a new namespace:

```solidity
/// @custom:storage-location erc7201:bubble.storage.PrivateERC7943ERC20Contract256
struct PrivateERC7943ERC20Contract256Storage {
    mapping(address => bool) agents;
    mapping(address => bool) sendAllowed;
    mapping(address => bool) receiveAllowed;
    mapping(address => uint256) frozenTokens;
    bool defaultSendAllowed;
    bool defaultReceiveAllowed;
    mapping(uint256 => ForcedTransferRequest) forcedTransferRequests;
}

struct ForcedTransferRequest {
    address from;
    address to;
    uint256 requestedAmount;
}
```

Do not add ERC-7943 fields to `PrivateERC20Wrapper256Base` storage.

## Function Behavior

### Shield

Requirements:

- contract not paused
- `canReceive(msg.sender) == true`
- underlying transfer succeeds and exact-transfer underlying is assumed

Effects:

- underlying is transferred into wrapper
- private balance increases
- total supply increases
- `Shield(msg.sender, amount)` is emitted

### Transfer

Runtime private transfer checks:

- sender must be allowed to send
- recipient must be allowed to receive
- requested amount must be within encrypted balance minus clear frozen amount
- effective private amount becomes zero when private checks fail
- compliance-style result is represented by balance changes and no-amount `Transfer(from, to)` event

`canTransfer(from, to, amount)` is not implemented in v1 because it cannot honestly evaluate encrypted balance/free-balance constraints in a `view` function.

Intentional private-wrapper deviation: when the requested amount exceeds the encrypted free balance, the transfer resolves to a zero/no-op private transfer rather than reverting with `ERC7943InsufficientUnfrozenBalance`.

### Unshield

Requirements:

- contract not paused
- `canSend(msg.sender) == true`
- requested amount is greater than zero
- requested amount is within private balance minus frozen amount

The shared wrapper base does not expose `unshieldForMaster`. ERC-7943 does not define a master payout role, and keeping that path would make the wrapper API harder to reason about for integrators.

Intentional private-wrapper deviation: when the requested amount exceeds the encrypted free balance, the unshield request resolves through the async callback as `UnshieldFailed` with zero effective amount instead of reverting with `ERC7943InsufficientUnfrozenBalance`.

Effects:

- private balance is debited by effective amount
- unshield callback releases underlying
- total supply decreases by actual decrypted amount

Freeze timing semantics should match ERC-3643:

- freeze/eligibility blocks new unshield requests
- already accepted async callbacks are allowed to settle

### setFrozenTokens

ERC-7943 semantics:

- overwrites frozen amount, like `approve`
- can set frozen amount greater than current balance
- must be access restricted
- must emit `Frozen(account, amount)`

Implementation:

```solidity
function setFrozenTokens(address account, uint256 amount)
    external
    onlyAgent
    returns (bool)
```

No encrypted math is needed when setting the clear frozen value.

### forcedTransfer

Use async audited semantics:

```solidity
function forcedTransfer(address from, address to, uint256 requestedAmount)
    external
    onlyAgent
    returns (bool)
```

Requirements:

- contract not paused
- from/to non-zero and distinct
- requested amount greater than zero
- `canReceive(to) == true`

Recovery-destination handling should match the ERC-3643 implementation: the destination must pass the normal recipient eligibility check, and there is no separate recovery-address exception path in v1.

Semantics:

- source `canSend(from)` is not required; forced transfer is an enforcement action
- source must have a nonzero clear frozen amount
- forced transfer can move frozen funds only
- private requested amount is capped to `min(requestedAmount, getFrozenTokens(from))`
- actual moved amount is private `min(balanceOf(from), min(requestedAmount, getFrozenTokens(from)))`
- source frozen amount is reduced by the decrypted actual moved amount in the callback, floored at zero
- emit no-amount wrapper `Transfer(from, to)`
- emit wrapper-specific `ForcedTransferRequested(requestId, from, to, requestedAmount, actualAmountHandle)`
- request decryption of actual moved amount
- callback emits ERC-7943 `ForcedTransfer(from, to, actualAmount)`

This preserves ERC-7943’s public final `ForcedTransfer` event without lying when the requested amount exceeds the forceable frozen/private amount. The accepted private-wrapper extension is to emit the actual moved amount instead of reverting.

Legal proof/document URI events are intentionally deferred. They can be added later as an extension once the base forced-transfer flow is stable.

## Interface Plan

Add a fungible-focused interface:

```solidity
interface IPrivateERC7943Wrapper is IERC165 {
    event ForcedTransfer(address indexed from, address indexed to, uint256 amount);
    event Frozen(address indexed account, uint256 amount);
    event ForcedTransferRequested(
        uint256 indexed requestId,
        address indexed from,
        address indexed to,
        uint256 requestedAmount,
        gtUint256 actualAmount
    );

    error ERC7943CannotSend(address account);
    error ERC7943CannotReceive(address account);
    error ERC7943CannotTransfer(address from, address to, uint256 amount);
    error ERC7943CanTransferNotImplemented();
    error ERC7943InsufficientUnfrozenBalance(address account, uint256 amount, uint256 unfrozen);

    function forcedTransfer(address from, address to, uint256 amount) external returns (bool);
    function setFrozenTokens(address account, uint256 amount) external returns (bool);
    function canSend(address account) external view returns (bool);
    function canReceive(address account) external view returns (bool);
    function canTransfer(address from, address to, uint256 amount) external pure returns (bool);
    function getFrozenTokens(address account) external view returns (uint256);
}
```

Note: `canTransfer` is included for ABI discoverability only and must revert with `ERC7943CanTransferNotImplemented` in v1. Wrapper-specific admin methods should stay outside this ERC-7943-shaped interface block.

## Factory Plan

Create:

```solidity
PrivateERC7943ERC20Factory256
```

Mirror ERC-3643 factory decisions:

- immutable implementation address
- `createToken(...)` overloads
- explicit `master`
- optional wrapped-native flag
- event includes token, underlying, creator, master, defaults
- `isTokenFromFactory`
- `totalTokensCreated`

Factory should pass defaults into initializer:

```solidity
initialize(
    name,
    symbol,
    underlying,
    owner,
    master,
    underlyingIsWrappedNative,
    defaultSendAllowed,
    defaultReceiveAllowed
)
```

## Testing Plan

### Local Tests

- factory rejects zero implementation
- factory rejects zero underlying/master
- factory deploys proxy with expected owner/master/defaults where supported
- ERC-7943 fungible interface id constant matches `0x3edbb4c4`
- `supportsInterface(0x3edbb4c4)` is false while `canTransfer` is not implemented
- `canTransfer(from, to, amount)` reverts with `ERC7943CanTransferNotImplemented`
- owner can add/remove agents
- non-agent cannot set eligibility/frozen/forced transfer

Local proxy creation may be limited by unsupported local MPC chain, so tests that initialize `MpcCore.setPublic256` may need to be live-network E2E only.

### Arbitrum Sepolia E2E

Use real MPC, like ERC-3643 tests:

- deploy implementation + factory
- create wrapper token through factory
- default-denied user cannot shield
- agent enables receive and user can shield
- disabled receiver cannot receive transfer
- disabled sender cannot transfer/unshield
- `setFrozenTokens` emits `Frozen`
- transfer under frozen amount succeeds
- transfer above unfrozen amount resolves to zero/no-op
- unshield above unfrozen amount resolves to zero/failed callback
- forced transfer from blocked/frozen source succeeds as enforcement action
- forced transfer requested above forceable frozen/private amount finalizes with actual available amount
- `ForcedTransfer(from, to, actualAmount)` final event is emitted after callback
- no amount-bearing ERC20 `Transfer(from, to, requestedAmount)` events are emitted
- backing invariant holds after unshield callbacks

## Implementation Phases

1. Add this plan document.
2. Add `IPrivateERC7943Wrapper`.
3. Add `PrivateERC7943ERC20Contract256` with ERC-7201 storage, ERC-7943-shaped views/admin methods, and explicit `canTransfer` not-implemented behavior.
4. Add factory.
5. Add local factory/interface tests.
6. Add live E2E with real MPC on Arbitrum Sepolia.
7. Review contract size; if near 24KB, convert revert strings to custom errors and avoid batch helpers.

## Open Questions

- None for v1 planning.
