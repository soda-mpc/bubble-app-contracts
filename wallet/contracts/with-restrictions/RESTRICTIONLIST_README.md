# Restriction List System Documentation

## Overview

The restriction list system provides a modular, standardized way to manage address restriction lists across smart contracts. It uses a **single event approach** for maximum simplicity and supports **multiple registries** for complex compliance scenarios. The system consists of an interface, implementations, and integration helpers that allow both first-party and third-party restriction list management.

## Architecture

### Core Components

1. **IRestrictionList Interface** (`IRestrictionList.sol`)
   - Standard interface for all restriction list implementations
   - Ensures compatibility across different restriction list providers
   - Defines consistent events and core functions

2. **RestrictionListRegistry Contract** (`RestrictionListRegistry.sol`)
   - Reference implementation using OpenZeppelin's Ownable
   - Owner-controlled restriction list management
   - Gas-efficient operations with EnumerableSet

3. **RestrictionListIntegration Helper** (`RestrictionListIntegration.sol`)
   - Abstract contract for easy integration
   - Provides modifiers and utility functions
   - Handles registry updates and enforcement

4. **Example Implementations**
   - `PrivateERC20WithRestrictionList256.sol` - Shows integration with existing contracts
   - `RestrictionListExample.sol` - Advanced third-party implementation with roles

## Event Design Philosophy

### Single Event Approach

This system uses **individual events for all operations** rather than separate batch events. This design choice prioritizes:

✅ **Simplicity**: Only one event type to handle  
✅ **Consistency**: All restrictions logged identically  
✅ **Integration**: Easier for third-party indexing  
✅ **Analytics**: Uniform data structure for analysis  
✅ **Standardization**: Follows common ERC patterns  

```solidity
// All operations emit the same event type:
event AddedToRestrictionList(address indexed account, address indexed admin);
event RemovedFromRestrictionList(address indexed account, address indexed admin);

// Whether adding individually or in batch:
addToRestrictionList(account);        // → 1 event
addMultipleToRestrictionList([a,b]);  // → 2 individual events
```

## Multiple Registry Support

### Key Features

The system supports **multiple restriction list registries** simultaneously, enabling complex compliance scenarios:

✅ **Company Registry**: Managed by the company for internal policies  
✅ **Government Registry**: Managed by regulatory authorities  
✅ **Third-Party Registries**: Managed by external compliance providers  
✅ **Dynamic Management**: Add/remove registries without redeploying contracts  
✅ **Fail-Safe Design**: Registry failures don't break the entire system  

### How It Works

```solidity
// Multiple registries check (ANY registry restricts = address is restricted)
function isRestricted(address account) returns (bool) {
    // Check all active registries
    // Return true if ANY registry restricts the address
}

// Get which registry restricts an address
function getRestrictingRegistry(address account) returns (address) {
    // Returns the first registry that restricts the address
}

// Get ALL registries that restrict an address
function getDetailedRestrictionInfo(address account) returns (address[] memory) {
    // Returns array of all registries that restrict the address
}
```

### Example Scenario

```solidity
// Deploy multiple registries with descriptive names
RestrictionListRegistry companyRegistry = new RestrictionListRegistry(companyAdmin, "Company Compliance List");
RestrictionListRegistry govRegistry = new RestrictionListRegistry(govAdmin, "Government Sanctions List");

// Deploy token with multiple registries via PrivateERC20WithRestrictionListFactory256
address[] memory registries = [address(companyRegistry), address(govRegistry)];
address token = factory.createToken("Private Token", "PTKN", underlyingToken, registries, owner);

// Company restricts address A
companyRegistry.addToRestrictionList(addressA);

// Government restricts address B  
govRegistry.addToRestrictionList(addressB);

// Both addresses are now restricted in the token
bool aRestricted = token.isRestricted(addressA); // true
bool bRestricted = token.isRestricted(addressB); // true

// Add a third registry dynamically
token.addRestrictionListRegistry(thirdPartyRegistry);

// Remove company registry if needed
token.removeRestrictionListRegistry(address(companyRegistry));
// Now addressA is no longer restricted (unless restricted by other registries)
```

## Interface Specification

### Core Functions

```solidity
interface IRestrictionList {
    // Events - Simple and consistent
    event AddedToRestrictionList(address indexed account, address indexed admin);
    event RemovedFromRestrictionList(address indexed account, address indexed admin);
    
    // Query functions
    function name() external view returns (string memory);
    function isRestricted(address account) external view returns (bool);
    function restrictionListCount() external view returns (uint256);
    
    // Management functions (restricted access)
    function addToRestrictionList(address account) external;
    function removeFromRestrictionList(address account) external;
    function addMultipleToRestrictionList(address[] calldata accounts) external;
    function removeMultipleFromRestrictionList(address[] calldata accounts) external;
}
```

## Usage Examples

### 1. Deploying a Restriction List Registry

```solidity
// Deploy the restriction list registry with a descriptive name
RestrictionListRegistry registry = new RestrictionListRegistry(owner, "Company Compliance List");

// Check the registry name
string memory registryName = registry.name(); // "Company Compliance List"

// Add addresses to restriction list
registry.addToRestrictionList(0x...);
// → Emits: AddedToRestrictionList(0x..., owner)

// Batch operations emit individual events
address[] memory addresses = [0xAAA..., 0xBBB..., 0xCCC...];
registry.addMultipleToRestrictionList(addresses);
// → Emits: AddedToRestrictionList(0xAAA..., owner)
// → Emits: AddedToRestrictionList(0xBBB..., owner)  
// → Emits: AddedToRestrictionList(0xCCC..., owner)

// Check if address is restricted
bool isRestricted = registry.isRestricted(address);
```

### 2. Event Listening (Simple!)

```javascript
// Only need to listen to one event type!
const filter = contract.filters.AddedToRestrictionList();
const events = await contract.queryFilter(filter);

// All restrictions captured uniformly:
events.forEach(event => {
    console.log(`Address ${event.args.account} restricted by ${event.args.admin}`);
});

// Real-time listening
contract.on("AddedToRestrictionList", (account, admin) => {
    console.log(`New restriction: ${account}`);
});
```

### 3. Integrating with Existing Contracts

```solidity
contract MyToken is ERC20, RestrictionListIntegration {
    constructor(address restrictionListRegistry) 
        ERC20("MyToken", "MTK")
        RestrictionListIntegration(restrictionListRegistry) 
    {}
    
    function transfer(address to, uint256 amount) 
        public 
        override 
        notRestrictedTransfer(msg.sender, to) 
        returns (bool) 
    {
        return super.transfer(to, amount);
    }
}
```

### 4. Third-Party Implementation

```solidity
contract CustomRestrictionList is IRestrictionList, AccessControl {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    
    mapping(address => bool) private _restricted;
    mapping(address => string) private _reasons;
    
    function addToRestrictionListWithReason(address account, string memory reason) 
        external 
        onlyRole(ADMIN_ROLE) 
    {
        _restricted[account] = true;
        _reasons[account] = reason;
        
        // Always emit the standard event
        emit AddedToRestrictionList(account, msg.sender);
    }
}
```

## Integration Patterns

### Pattern 1: Inheritance (Recommended)

```solidity
contract MyContract is RestrictionListIntegration {
    constructor(address restrictionListRegistry) 
        RestrictionListIntegration(restrictionListRegistry) 
    {}
    
    function restrictedFunction() public notRestricted(msg.sender) {
        // Function logic
    }
}
```

### Pattern 2: Composition

```solidity
contract MyContract {
    IRestrictionList public restrictionListRegistry;
    
    modifier notRestricted(address account) {
        require(
            address(restrictionListRegistry) == address(0) || 
            !restrictionListRegistry.isRestricted(account),
            "Address is restricted"
        );
        _;
    }
}
```

## Available Modifiers

The `RestrictionListIntegration` contract provides several useful modifiers:

- `notRestricted(address account)` - Single address check
- `notRestrictedMultiple(address[] accounts)` - Multiple address check
- `notRestrictedTransfer(address from, address to)` - Transfer validation

## Gas Cost Analysis

### Individual vs Batch Events

```solidity
// Single address restriction
addToRestrictionList(account);
// Gas: ~25,000 (including 1 event)

// Batch restriction (10 addresses)
addMultipleToRestrictionList([...10 addresses]);
// Gas: ~45,000 (including 10 events)
// Additional cost per event: ~2,000 gas
```

**Cost-Benefit Analysis:**
- **Additional Gas**: ~2,000 per extra event (~$0.10-0.50 typical cost)
- **Benefits**: Massive simplification for indexing, analytics, and integration
- **Recommendation**: The simplicity benefits far outweigh the small gas cost

## Security Considerations

### 1. Access Control
- Restriction list management should be restricted to authorized accounts
- Consider using OpenZeppelin's AccessControl for multi-role management
- Implement emergency mechanisms to disable restriction list enforcement

### 2. Registry Updates
- Allow registry updates for flexibility
- Implement proper validation when changing registries
- Consider timelock mechanisms for sensitive operations

### 3. Gas Optimization
- Batch operations still save gas on transaction costs
- Use efficient data structures (mappings for O(1) lookups)
- Limit batch sizes to prevent gas limit issues

### 4. Event Reliability
- Individual events ensure no restrictions are missed in indexing
- Atomic transaction failures won't cause partial event emission
- Better fault tolerance for monitoring systems

## Deployment Guide

### 1. Deploy Restriction List Registry
```javascript
const RestrictionListRegistry = await ethers.getContractFactory("RestrictionListRegistry");
const registry = await RestrictionListRegistry.deploy(ownerAddress);
```

### 2. Deploy Token with Multiple Restriction Lists
```javascript
// Use PrivateERC20WithRestrictionListFactory256 for upgradeable deployment (proxy + initialize).
// Deploy implementation, then factory, then call factory.createToken(...) with registries.
const factory = await ethers.getContractAt("PrivateERC20WithRestrictionListFactory256", factoryAddress);
const tx = await factory.createToken(
    "Private Token",
    "PTKN",
    underlyingTokenAddress,
    [companyRegistry.address, govRegistry.address], // Array of registries
    ownerAddress
);
// Token address is in the TokenCreated event.
```

### 3. Configure Restriction Lists
```javascript
// Add addresses to different registries
await companyRegistry.addToRestrictionList(suspiciousAddress);
await govRegistry.addToRestrictionList(sanctionedAddress);

// Batch add (emits individual events)
await companyRegistry.addMultipleToRestrictionList([addr1, addr2, addr3]);

// Manage registries dynamically
await token.addRestrictionListRegistry(newRegistryAddress);
await token.removeRestrictionListRegistry(oldRegistryAddress);

// Check registry status
const activeRegistries = await token.getActiveRestrictionListRegistries();
const registryCount = await token.getActiveRegistryCount();

// Simple event listening
companyRegistry.on("AddedToRestrictionList", (account, admin) => {
    console.log(`Address ${account} restricted by company: ${admin}`);
});

govRegistry.on("AddedToRestrictionList", (account, admin) => {
    console.log(`Address ${account} restricted by government: ${admin}`);
});
```

## Frontend-Friendly Features

### Registry Names for UI Display

Each restriction list registry has a human-readable name that can be displayed in frontends instead of showing technical addresses:

```solidity
// Get registry name for display
string memory registryName = registry.name(); // "Company Compliance List"

// Get all active registry names for UI dropdown/list
string[] memory allNames = token.getActiveRegistryNames();
// → ["Company Compliance List", "Government Sanctions List", "Internal Compliance List"]
```

### Detailed Restriction Information with Names

For comprehensive user interfaces, you can get both registry addresses and their human-readable names:

```solidity
// Get detailed restriction info with names
(address[] memory restrictingRegistries, string[] memory registryNames) = 
    token.getDetailedRestrictionInfoWithNames(userAddress);

// Example output:
// restrictingRegistries: [0x123..., 0x456...]
// registryNames: ["Company Compliance List", "Government Sanctions List"]
```

### Frontend Integration Example

```javascript
// JavaScript/TypeScript frontend example
async function displayUserRestrictionStatus(userAddress) {
    const [registries, names] = await token.getDetailedRestrictionInfoWithNames(userAddress);
    
    if (registries.length === 0) {
        return "✅ User is not restricted";
    } else {
        const restrictionList = names.join(", ");
        return `❌ User is restricted by: ${restrictionList}`;
    }
}

// Display all available registries in UI
async function getAvailableRegistries() {
    const names = await token.getActiveRegistryNames();
    return names.map((name, index) => ({
        id: index,
        name: name,
        display: name || "Unnamed Registry"
    }));
}
```

## Testing Considerations

### Unit Tests
- Test all interface functions
- Verify access control mechanisms
- Test batch operations and individual event emission
- Verify gas costs remain reasonable

### Integration Tests
- Test cross-contract restriction list queries
- Verify event emission for both single and batch operations
- Test emergency scenarios
- Test registry updates

### Example Test Cases
```javascript
describe("Restriction List System", function() {
    it("should emit individual events for batch operations", async function() {
        const tx = await registry.addMultipleToRestrictionList([user1.address, user2.address]);
        const receipt = await tx.wait();
        
        // Should have 2 individual events
        const events = receipt.events.filter(e => e.event === "AddedToRestrictionList");
        expect(events).to.have.length(2);
        expect(events[0].args.account).to.equal(user1.address);
        expect(events[1].args.account).to.equal(user2.address);
    });
    
    it("should prevent restricted addresses from transferring", async function() {
        await registry.addToRestrictionList(user1.address);
        await expect(
            token.connect(user1).transfer(user2.address, 100)
        ).to.be.revertedWith("account is restricted");
    });
    
    it("should allow registry updates by owner", async function() {
        const newRegistry = await RestrictionListRegistry.deploy(owner.address);
        await token.updateRestrictionListRegistry(newRegistry.address);
        expect(await token.getRestrictionListRegistry()).to.equal(newRegistry.address);
    });
});
```

## Best Practices

1. **Event Consistency**: Always emit `AddedToRestrictionList` for restrictions
2. **Simple Indexing**: Use single event filters for all monitoring
3. **Gas Awareness**: Understand the small additional cost per event
4. **Batch Smart**: Use batch operations for gas savings on transaction overhead
5. **Testing**: Verify individual event emission in batch operations
6. **Documentation**: Clearly state that individual events are emitted
7. **Integration**: Design systems expecting one event per restriction

## Benefits of Single Event Approach

### For Developers
- **Simpler Code**: Only one event handler needed
- **Consistent Data**: Uniform event structure
- **Easy Analytics**: Straightforward querying and aggregation

### For Third Parties
- **Standard Integration**: Follows common patterns
- **Reliable Indexing**: No missed restrictions
- **Future Proof**: Works with all tooling expecting individual events

### For Monitoring
- **Real-time Alerts**: Each restriction generates an event
- **Audit Trails**: Complete restriction history
- **Compliance**: Easy to prove every restriction was logged 