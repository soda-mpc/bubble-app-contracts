# ERC-3643 Private Security Token Implementation Plan

## Goal

Create a private ERC-3643/T-REX-style security token that keeps the original ERC-3643 product lifecycle as closely as possible while adding private encrypted balances and private transfer amounts.

The target audience is T-REX/ERC-3643 customers. For that audience, the token should behave like an ownership register for a regulated security or fund:

- issuer/agent mints after subscription
- issuer/agent burns after redemption
- identity and compliance remain first-class controls
- issuer/custodian/fund accounts handle cash or assets outside the token contract
- the token contract does not custody the subscribed asset

This is intentionally different from the wrapper model where users deposit an underlying ERC20 into the token contract with `shield` and withdraw with `unshield`.

## Product Decision

### Chosen Model: Issuer Mint / Burn

For a private ERC-3643 security-token demo, use an issuer-controlled mint/burn lifecycle.

```text
Subscribe:
  investor sends fiat/USDC to issuer, fund, custodian, or SPV off-chain
  agent verifies subscription and compliance
  agent mints a private encrypted amount to the verified wallet
  compliance is notified with private amount semantics

Redeem:
  investor requests redemption
  agent requests burn of a private encrypted amount from the investor
  fund/custodian pays cash off-chain
  compliance is notified with the private actual burned amount

Invest:
  manager uses the fund/custodian account
  no on-chain wrapper withdrawal path is needed
```

This model maps naturally to T-REX and avoids the wrapper-specific invariant:

```text
totalSupply == underlying.balanceOf(tokenContract)
```

That invariant is correct for a private wrapped ERC20, but it is not how a regulated fund/security token normally works.

### Rejected Model For ERC-3643: Shield / Unshield Wrapper

The current wrapper approach is useful for a different product:

```text
User deposits underlying ERC20 into token contract -> private wrapped balance
User burns private wrapped balance -> underlying ERC20 leaves token contract
```

That is a privacy deposit wrapper, not a T-REX-like security token. It creates product confusion for fund managers because the manager cannot cleanly use subscribed assets without special withdrawal paths or emergency-style recovery functions.

For ERC-3643/T-REX customers, do not use shield/unshield as the main lifecycle.

### Do Not Mix Lifecycles

Do not put `mint`/`burn` and `shield`/`unshield` on the same ERC-3643 token.

Two independent supply paths create avoidable risks:

- double-counted supply
- unclear accounting
- broken or irrelevant backing invariant
- ambiguous compliance semantics around `created` and `destroyed`
- confusing product behavior for issuers, managers, and investors

Pick one lifecycle per contract.

## Current Context

- Existing generic wrapper base: `wallet/contracts/base/PrivateERC20Wrapper256Base.sol`
- Current ERC-3643 wrapper prototype: `wallet/contracts/erc3643/PrivateERC3643ERC20Contract256.sol`
- Current ERC-3643 wrapper factory: `wallet/contracts/erc3643/PrivateERC3643ERC20Factory256.sol`
- ERC-3643 private example: `wallet/tmp/contracts/token/PrivateToken.sol`
- ERC-3643 private interface: `wallet/tmp/contracts/token/IPrivateToken.sol`
- Identity registry interface: `wallet/tmp/contracts/registry/interface/IPrivateIdentityRegistry.sol`
- Compliance interface: `wallet/tmp/contracts/compliance/modular/IPrivateModularCompliance.sol`

The current `PrivateERC3643ERC20Contract256` wrapper prototype proves that identity, compliance, freezing, forced transfer, and private balances can be combined. It should now be treated as a wrapper primitive or prototype, not as the target T-REX-like security-token product.

The target ERC-3643 implementation should be a new contract shape, not a small tweak to the wrapper.

## Scope

### In Scope

- Add a new ERC-3643 private security-token contract, likely:
  - `wallet/contracts/erc3643/PrivateERC3643SecurityToken256.sol`
- Keep UUPS proxy pattern.
- Keep ERC-7201 namespaced storage.
- Keep private encrypted balances and encrypted transfer amounts.
- Remove underlying custody from the ERC-3643 security-token lifecycle:
  - no `underlying`
  - no `shield`
  - no `unshield`
  - no `master`
- Add agent-controlled issuance and redemption operations:
  - `mint(address to, itUint256 calldata amount)` or equivalent private encrypted amount input
  - `burn(address from, itUint256 calldata amount)` or equivalent private encrypted amount input
  - optional batch mint/burn only after single-account flows are stable
- Add ERC-3643 controls:
  - identity registry
  - modular compliance
  - agent role
  - pause/unpause
  - full wallet freeze
  - partial token freeze
  - forced transfer
  - recovery flow if needed for T-REX parity
- Keep compliance hooks aligned with original ERC-3643 semantics:
  - private create check before mint
  - private created notification after mint
  - `canTransfer(from, to, amount)` before/effective private transfer
  - `transferred(from, to, amount)` after transfer
  - private destroyed notification after burn
- Add factory support for deploying this security-token variant.
- Add live MPC E2E tests on `sepolia-arbitrum`.

### Out of Scope

- Shield/unshield lifecycle for this ERC-3643 security token.
- Underlying-backed supply invariant for this ERC-3643 security token.
- `unshieldForMaster`.
- OPRF mint/split/merge/burn/redeem flows.
- Generic private wrapped ERC20 behavior.
- Fee-on-transfer/rebasing underlying-token concerns, because the security token should not custody an underlying ERC20.
- TREX factory/gateway integration until the core token behavior is stable.
- Migration of existing deployed wrapper proxies.

## Assumptions

- This token is an ownership register, not an asset vault.
- Subscription/redemption cash movement happens off-chain or in a separate subscription/redemption system.
- Mint amounts, burn requested amounts, actual burned amounts, transfer amounts, balances, and total supply are encrypted handles.
- Public `totalSupply()` is not meaningful without leaking privacy. The private security token should expose encrypted supply semantics instead.
- Compliance modules must support private amount hooks or amount-independent policy checks. Clear ERC-3643 `created/destroyed` hooks are not sufficient for fully private issuance/redemption.
- Owner, agent, affected user, and the token contract should receive permissions to decrypt mint/burn handles where appropriate.
- Auditor/viewing-key support is a later extension. The v1 design should not hard-code public supply or public mint/burn events just to satisfy auditability.
- Agents are the operational actors for issuance, burn/redemption, freeze, pause, forced transfer, and recovery.
- Owner/governance manages agents, registry/compliance configuration, metadata, and upgrades.
- The identity registry and compliance contracts are deployed and managed externally.
- The ERC-3643 interfaces copied from `wallet/tmp` can be adapted for this project by fixing imports and compiler pragmas.
- Licensing for importing or deriving from the ERC-3643 example/interface is acceptable for this repository.

## Proposed Contract Design

### Storage Layout

Use ERC-7201 namespaced storage as the single storage strategy for this implementation and for future private ERC20 variants.

Do not inherit the PoC storage layout directly:

- Do not inherit `PrivateTokenStorage`.
- Do not inherit the PoC `AgentRoleUpgradeable`.
- Do not copy direct storage gaps from the PoC.
- Put security-token state in a dedicated ERC-7201 namespace.

Recommended security-token storage:

```solidity
/// @custom:storage-location erc7201:bubble.storage.PrivateERC3643SecurityToken256
struct PrivateERC3643SecurityToken256Storage {
    string name;
    string symbol;
    uint8 decimals;
    gtUint256 totalSupply;
    gtUint256 zero;
    mapping(address => gtUint256) balances;
    mapping(address => mapping(address => gtUint256)) allowances;
    IPrivateIdentityRegistry identityRegistry;
    IPrivateModularCompliance compliance;
    address onchainID;
    mapping(address => bool) agents;
    mapping(address => bool) frozen;
    mapping(address => gtUint256) frozenTokens;
    mapping(uint256 => ForcedTransferRequest) forcedTransferRequests;
    mapping(uint256 => BurnRequest) burnRequests;
}
```

`DecryptionCaller` currently uses direct inherited storage for `decryptCounter` and `decryptHandles`. That is already part of the existing production inheritance model and can remain as an accepted exception unless we later introduce a namespaced replacement.

### Contract Shape

The target contract should not inherit `PrivateERC20Wrapper256Base`, because that base is intentionally shield/unshield and underlying-backed.

Recommended shape:

```solidity
contract PrivateERC3643SecurityToken256 is
    DecryptionCaller,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    IPrivateERC3643SecurityToken
{
    // Private balances, ERC-3643 controls, mint/burn lifecycle.
}
```

If duplication with `PrivateERC20Wrapper256Base` becomes significant, extract a smaller shared encrypted-balance base that contains only:

- metadata
- total supply
- encrypted balances
- encrypted allowances
- private transfer/approval mechanics
- pause/ownership/upgrade hooks

That shared base must not include underlying custody, shield, or unshield.

### Interface Plan

The target interface should be close to T-REX/ERC-3643 expectations.

Use a new interface name, for example:

- `IPrivateERC3643SecurityToken`

Include:

- metadata getters and setters
- `onchainID`
- identity registry getter/setter
- compliance getter/setter
- agent management
- pause/unpause
- full freeze
- partial freeze
- forced transfer
- recovery if accepted
- `mint`
- `burn`
- transfer/approval functions supported by the private token

Do not include:

- `shield`
- `unshield`
- `unshieldForMaster`
- underlying getters
- wrapper factory assumptions

## Function Behavior

### Private Supply And Viewing Permissions

The ERC-3643 security-token variant should keep supply private:

- `totalSupply` is stored as a `gtUint256` handle.
- public `totalSupply()` should be omitted, reverted, or explicitly marked unsupported unless a non-leaking interface is agreed.
- mint/burn changes update encrypted total supply.
- mint/burn/supply handles should be permitted to:
  - the token contract
  - owner
  - acting agent
  - affected user where applicable
- future auditor support should be implemented as an explicit viewing-key or permission-granting mechanism.

Do not emit public amount-bearing mint/burn events such as `Transfer(address(0), to, amount)` or `Transfer(from, address(0), amount)` if mint/burn privacy is required.

### Mint

Agent-only issuance after off-chain subscription.

Requirements:

- contract not paused
- caller is agent
- recipient is non-zero
- recipient is not frozen
- recipient identity is verified
- encrypted amount is valid and greater than zero
- private compliance create check passes, or the configured compliance policy does not depend on amount

Effects:

- recipient encrypted balance increases by encrypted amount
- encrypted total supply increases by encrypted amount
- new balance handle is permitted to the contract and recipient
- amount handle is permitted to owner, acting agent, recipient, and contract
- private created notification is called if supported by compliance
- private mint event emits an encrypted amount handle, not a clear amount

Recommended event shape:

```solidity
event PrivateMint(address indexed to, gtUint256 amount);
event PrivateTotalSupplyUpdated(gtUint256 totalSupply);
```

### Burn

Agent-only redemption after off-chain redemption workflow.

Requirements:

- contract not paused
- caller is agent
- source is non-zero
- encrypted requested amount is valid and greater than zero

Effects:

- compute encrypted free balance from balance minus frozen amount
- compute encrypted `realBurned` using all-or-zero semantics:

```text
realBurned = requestedAmount <= freeBalance ? requestedAmount : 0
```

- source encrypted balance is debited by `realBurned`
- encrypted total supply decreases by `realBurned`
- `realBurned` handle is permitted to owner, acting agent, source user, and contract
- private destroyed notification is called if supported by compliance
- private burn event emits encrypted handles, not clear amounts

Recommended event shape:

```solidity
event PrivateBurn(
    address indexed from,
    gtUint256 requestedAmount,
    gtUint256 realBurned
);
event PrivateTotalSupplyUpdated(gtUint256 totalSupply);
```

If an async burn finalization marker is needed for off-chain systems, emit only encrypted handles:

```solidity
event PrivateBurnFinalized(
    uint256 indexed requestId,
    address indexed from,
    gtUint256 realBurned
);
```

Do not emit public `realBurned` unless a future product requirement explicitly chooses auditability over burn-amount privacy.

### Transfers

Requirements:

- contract not paused
- sender not frozen
- recipient not frozen
- recipient identity is verified
- amount is within sender free balance after partial freeze
- compliance allows transfer

Effects:

- if policy allows, transfer encrypted amount
- if policy denies due to encrypted checks, transfer zero where privacy semantics require non-reverting behavior
- call private `compliance.transferred(from, to, effectiveAmount)` where supported
- emit no-amount `Transfer(from, to)` for private transfer entrypoints
- do not emit `Transfer(from, to, requestedAmount)` when the effective amount can privately become zero

### Forced Transfers

Forced transfers are agent-only enforcement operations intended for legal/compliance situations, such as a court order.

Requirements:

- contract not paused
- caller is agent
- `from` and `to` are non-zero and distinct
- requested amount is greater than zero
- recipient wallet is not frozen
- recipient identity is verified

Semantics:

- the requested amount is public
- the actual moved amount is computed privately as `min(balanceOf(from), requestedAmount)`
- source full-freeze does not block forced transfer
- source partial-frozen accounting is capped down if the forced transfer leaves source balance below the previous frozen amount
- compliance is notified with the encrypted actual amount where supported
- no-amount `Transfer(from, to)` event is emitted
- `ForcedTransferRequested(requestId, from, to, requestedAmount, actualAmountHandle)` is emitted immediately
- MPC decrypts the actual moved amount asynchronously
- `ForcedTransferFinalized(requestId, from, to, actualAmountHandle)` or equivalent emits the encrypted actual result

This intentionally avoids emitting the requested amount as if it were the actual moved amount. If the source wallet has less than requested, the finalized event should expose only an encrypted actual amount handle unless a future audit mode explicitly permits public disclosure.

### Approvals

Requirements:

- contract not paused
- owner/caller not frozen
- spender not frozen

Effects:

- preserve encrypted allowance behavior
- emit compatible approval events

Approvals do not call compliance directly unless a compliance module explicitly requires approval-time checks.

### Pause

Recommended behavior:

- `pause()` and `unpause()` are agent-only.
- upgrade authorization remains owner-only.

This matches the ERC-3643 operational model while keeping UUPS governance separate.

### Full Freeze

Agent-only:

```solidity
function setAddressFrozen(address user, bool frozen) external onlyAgent
```

Frozen addresses cannot:

- receive mints
- burn/redeem
- send
- receive
- approve
- be used as transfer source or destination

Forced transfer remains an enforcement exception for the source wallet.

### Partial Freeze

Agent-only:

```solidity
function freezePartialTokens(address user, itUint256 calldata amount) external onlyAgent
function unfreezePartialTokens(address user, itUint256 calldata amount) external onlyAgent
```

Partial freeze is tracked as encrypted handles.

Spendable balance:

```text
freeBalance = balance - frozenTokens
```

Transfer and burn checks use free balance.

### Recovery

Original ERC-3643/T-REX uses recovery flows. For a T-REX customer demo, recovery is likely more relevant than it was for the wrapper product.

Decision needed before implementation:

- add recovery in v1 for closer T-REX parity, or
- defer recovery to v2 to keep first implementation smaller

If included, recovery should be agent-controlled and should preserve compliance/identity constraints on the destination wallet.

## Factory Plan

Add a dedicated security-token factory only after the contract compiles and tests pass:

- `wallet/contracts/erc3643/PrivateERC3643SecurityTokenFactory256.sol`

Factory parameters:

- implementation address
- name
- symbol
- decimals
- owner
- identity registry
- compliance
- onchain ID
- initial agent if different from owner

The factory should not accept:

- underlying
- master
- wrapped-native flag

Those belong to wrapper contracts, not a T-REX-style security token.

## Testing Plan

Runtime tests that execute `MpcCore` operations must run against a real MPC-enabled network. The intended target is `sepolia-arbitrum`.

Add tests for:

- deployment initializes metadata, owner, identity registry, compliance, onchain ID, and initial agent
- owner can add/remove agents
- non-agent cannot mint, burn, pause, freeze, or force transfer
- verified investor can receive mint
- unverified investor cannot receive mint
- frozen investor cannot receive mint
- mint updates encrypted balance and encrypted total supply
- mint emits encrypted amount handle and permits owner, agent, user, and contract
- mint calls private compliance create/created hooks where supported
- burn reduces private balance and encrypted total supply by encrypted `realBurned`
- burn emits encrypted `realBurned` handle and permits owner, agent, user, and contract
- burn above free balance burns zero and emits encrypted zero `realBurned`
- burn calls private compliance destroyed hook where supported
- verified recipient can receive encrypted transfer
- unverified recipient cannot receive encrypted transfer
- frozen sender cannot send
- frozen recipient cannot receive
- partial freeze limits transfer amount
- partial freeze limits burn amount
- compliance-denied transfer does not move value
- successful transfer calls `compliance.transferred`
- forced transfer finalizes with actual amount
- public `totalSupply()` is absent, unsupported, or non-leaking
- encrypted total supply handle updates after mint and burn
- auditor/viewing-key functionality is deferred and not hard-coded through public amount events
- recovery if included
- owner-only upgrade authorization
- storage layout validation for UUPS upgrade safety

Test doubles needed:

- mock private identity registry
- mock private modular compliance with configurable allow/deny behavior and event/log tracking

## Task List

### Phase 1: Finalize Product Split

1. Treat the current ERC-3643 wrapper as a wrapper prototype, not the T-REX target.
2. Decide whether to keep, rename, or remove the wrapper prototype from the branch.
3. Confirm the target contract name, recommended:
   - `PrivateERC3643SecurityToken256`
4. Confirm recovery scope for v1.

### Phase 2: Extract Shared Encrypted Token Base If Needed

Goal: avoid duplicating private balance/allowance mechanics without inheriting wrapper custody behavior.

Tasks:

1. Identify reusable logic from `PrivateERC20Wrapper256Base`.
2. Extract only generic encrypted-token mechanics if it meaningfully reduces duplication:
   - metadata
   - encrypted total supply
   - encrypted balances
   - encrypted allowances
   - private transfer/approval internals
   - ownership/pause/upgrade hooks
3. Exclude:
   - underlying
   - shield
   - unshield
   - master
   - wrapped-native behavior
4. Keep ERC-7201 storage namespaces stable and separated.

### Phase 3: Define ERC-3643 Security Token Interfaces

1. Create `IPrivateERC3643SecurityToken`.
2. Add adapted identity and compliance interfaces with imports fixed for this repo and `pragma ^0.8.26`.
3. Include T-REX-like methods:
   - metadata getters/setters
   - `onchainID`
   - identity registry getter/setter
   - compliance getter/setter
   - agent management
   - pause/unpause
   - full freeze
   - partial freeze
   - forced transfer
   - mint
   - burn
   - recovery if included
4. Explicitly omit shield/unshield/underlying/master methods.

### Phase 4: Implement Security Token State And Admin

1. Create `wallet/contracts/erc3643/PrivateERC3643SecurityToken256.sol`.
2. Add ERC-7201 namespace for security-token state.
3. Add initializer parameters for metadata, owner, identity registry, compliance, onchain ID, and initial agent.
4. Add owner-only metadata/admin setters.
5. Add owner-only agent add/remove functions.
6. Make pause/unpause, freeze, mint, burn, forced transfer, and recovery agent-only.
7. Bind/unbind compliance where required by the compliance implementation.

### Phase 5: Implement Runtime Checks

1. Add mint checks:
   - recipient not frozen
   - recipient identity verified
   - encrypted amount is valid and greater than zero
   - private compliance create check passes where supported
   - update encrypted total supply
   - permit mint and supply handles to owner, agent, user, and contract
   - notify private `created` hook where supported
2. Add burn checks:
   - source not frozen unless agent policy says otherwise
   - encrypted requested amount is valid and greater than zero
   - compute `realBurned = requestedAmount <= freeBalance ? requestedAmount : 0`
   - update encrypted total supply by `realBurned`
   - permit burn and supply handles to owner, agent, user, and contract
   - notify private `destroyed` hook where supported
3. Add transfer checks:
   - sender not frozen
   - recipient not frozen
   - recipient identity verified
   - amount within free balance after partial freeze
   - compliance allows transfer
   - notify `compliance.transferred`
4. Add approval checks:
   - owner/caller not frozen
   - spender not frozen
5. Add partial freeze/unfreeze encrypted balance logic.
6. Add forced transfer and async actual-amount finalization.
7. Add recovery if included.

### Phase 6: Add Factory And Scripts

1. Create `PrivateERC3643SecurityTokenFactory256`.
2. Mirror existing proxy factory deployment style.
3. Add setup/deployment script for the security-token variant.
4. Add verification notes for implementation and factory.

### Phase 7: Final Verification

1. Run compile.
2. Run security-token live MPC tests on `sepolia-arbitrum`.
3. Run existing wrapper tests if wrapper contracts remain in the branch.
4. Check ABI to confirm shield/unshield/underlying/master methods are absent.
5. Check ABI to confirm private mint/burn methods are present and agent-restricted.
6. Check contract size.

## Risks And Notes

- This is a meaningful redesign from the wrapper prototype, not a rename.
- The private security token should not inherit wrapper custody behavior accidentally.
- Existing clear-amount ERC-3643 compliance modules are not enough for fully private mint/burn and private total supply. Private amount hooks or amount-independent policy modules are required.
- Event semantics must avoid publicly claiming a requested amount moved when the actual private amount may be lower.
- Public ERC20/T-REX compatibility is intentionally reduced where it conflicts with privacy, especially public total supply and public mint/burn `Transfer` events.
- Auditor visibility should be added later through explicit viewing-key or handle-permission mechanics.
- Any direct use of the ERC-3643 example code may carry GPL obligations. Confirm licensing before copying non-interface implementation logic.
- Full ERC-3643/T-REX parity may require recovery and more exact event compatibility than the first private prototype.

## Acceptance Criteria

- The new security-token contract compiles with Solidity `0.8.26`.
- The new security-token ABI has no shield/unshield/underlying/master methods.
- Agent-only private mint and private burn exist.
- Mint gates identity and private compliance, updates encrypted total supply, and emits an encrypted amount handle.
- Burn uses all-or-zero semantics, updates encrypted total supply by encrypted `realBurned`, and emits encrypted `realBurned`.
- Public `totalSupply()` and public amount-bearing mint/burn events are absent, unsupported, or explicitly non-leaking.
- Transfers keep identity, compliance, freeze, and partial-freeze checks.
- Forced transfer emits/finalizes encrypted actual moved amount unless a future audit mode explicitly permits public disclosure.
- OPRF methods are absent.
- Live MPC tests cover private mint, private burn, encrypted total supply, transfer, freeze, forced transfer, and private compliance notifications.
