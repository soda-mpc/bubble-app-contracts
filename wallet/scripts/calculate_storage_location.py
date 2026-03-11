#!/usr/bin/env python3
"""
Calculate ERC-7201 storage location for PrivateERC20Contract256.

This script calculates the storage location using the ERC-7201 standard formula:
keccak256(abi.encode(uint256(keccak256("bubble.storage.NAME")) - 1)) & ~bytes32(uint256(0xff))

Usage:
    python3 bubble/scripts/calculate_storage_location.py

Requirements:
    pip install web3
"""

from web3 import Web3

def calculate_storage_location(name: str) -> str:
    """
    Calculate the ERC-7201 storage location for a given name.
    
    Args:
        name: The storage location name (e.g., "bubble.storage.PrivateERC20Contract256")
    
    Returns:
        The storage location as a hex string (0x...)
    """
    # Step 1: keccak256("bubble.storage.NAME")
    inner_hash = Web3.keccak(text=name)
    
    # Step 2: uint256(keccak256(...)) - 1
    inner_hash_uint = int.from_bytes(inner_hash, byteorder='big')
    inner_hash_uint_minus_one = inner_hash_uint - 1
    
    # Step 3: abi.encode(uint256(...) - 1)
    # abi.encode(uint256) pads to 32 bytes
    encoded = inner_hash_uint_minus_one.to_bytes(32, byteorder='big')
    
    # Step 4: keccak256(abi.encode(...))
    outer_hash = Web3.keccak(encoded)
    
    # Step 5: & ~bytes32(uint256(0xff))
    # This clears the last byte (sets it to 0)
    # Simply set the last byte to 0
    result = bytearray(outer_hash)
    result[31] = 0
    result = bytes(result)
    
    return Web3.to_hex(result)

def main():
    """Calculate and print the storage location for PrivateERC20Contract256."""
    
    location_name = "bubble.storage.PrivateERC20Contract256"
    address = calculate_storage_location(location_name)
    
    print("=" * 80)
    print("ERC-7201 Storage Location for PrivateERC20Contract256")
    print("=" * 80)
    print()
    print(f"Location Name: {location_name}")
    print(f"Address: {address}")
    print(f"Address (no 0x): {address[2:]}")
    print()
    print("=" * 80)
    print("Usage in Solidity:")
    print("=" * 80)
    print()
    print(f'bytes32 private constant PrivateERC20Contract256StorageLocation = {address};')
    print()
    print("=" * 80)

if __name__ == "__main__":
    main()

