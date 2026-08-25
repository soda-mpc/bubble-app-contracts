import {HardhatUserConfig} from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || "";

/**
 * RPC endpoint for a network. Set <NETWORK>_RPC_URL (e.g. SEPOLIA_RPC_URL) to use your own
 * endpoint; otherwise the Alchemy URL is used, which needs ALCHEMY_API_KEY.
 */
const rpcUrl = (network: string, alchemyUrl: string): string =>
    process.env[`${network.toUpperCase().replace(/-/g, "_")}_RPC_URL`] || alchemyUrl;
/** Etherscan-compatible API key (World Sepolia / worldscan uses the same pattern). */
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";

const config: HardhatUserConfig = {
    solidity: {
        version: "0.8.26",
        settings: {
            optimizer: {
                enabled: true,
                runs: 8
            },
            evmVersion: "cancun",
            viaIR: true
        }
    },
    networks: {
        hardhat: {
            gas: 30000000,
            blockGasLimit: 30000000
        },
        "sepolia-arbitrum": {
            chainId: 421614,
            url: rpcUrl("sepolia-arbitrum", `https://arb-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`),
            accounts: {
                mnemonic: process.env.MNEMONIC || ""
            },
            gas: "auto",
            gasPrice: "auto",
            gasMultiplier: 1.2
        },
        "arbitrum": {
            chainId: 42161,
            url: rpcUrl("arbitrum", `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`),
            accounts: {
                mnemonic: process.env.MNEMONIC || ""
            },
            gas: "auto",
            gasPrice: "auto",
            gasMultiplier: 1.2
        },
        "polygon": {
            chainId: 137,
            url: rpcUrl("polygon", `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`),
            accounts: {
                mnemonic: process.env.MNEMONIC || ""
            },
            gas: "auto",
            gasPrice: "auto",
            gasMultiplier: 1.2
        },
        "ethereum": {
            chainId: 1,
            url: rpcUrl("ethereum", `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`),
            accounts: {
                mnemonic: process.env.MNEMONIC || ""
            },
            gas: "auto",
            gasPrice: "auto",
            gasMultiplier: 1.2
        },
        "sepolia": {
            chainId: 11155111,
            url: rpcUrl("sepolia", `https://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`),
            accounts: {
                mnemonic: process.env.MNEMONIC || ""
            },
            gas: "auto",
            gasPrice: "auto",
            gasMultiplier: 1.2
        },
    },
    etherscan: {
        apiKey: ETHERSCAN_API_KEY
    }, sourcify: {
        enabled: false,
    }
};

export default config;
