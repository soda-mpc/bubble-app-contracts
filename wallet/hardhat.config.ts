import {HardhatUserConfig} from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || "";
const QUICKNODE_ARBITRUM_SEPOLIA_URL = process.env.QUICKNODE_ARBITRUM_SEPOLIA_URL || "";
const QUICKNODE_ARBITRUM_MAINNET_URL = process.env.QUICKNODE_ARBITRUM_MAINNET_URL || "";
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
        kurtosis: {
            chainId: 50505070,
            url: "https://kurtosis.node.sodalabs.net",
            accounts: { mnemonic: process.env.MNEMONIC || "" },
            gas: 3_000_000,
            gasMultiplier: 1.0
        },
        "sepolia-base": {
            chainId: 84532,
            url: `https://base-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
            accounts: {
                mnemonic: process.env.MNEMONIC || ""
            },
            gas: "auto",
            gasPrice: "auto",
            gasMultiplier: 1.2,
            timeout: 300000 // 5 minutes - increased for MPC operations
        },
        "sepolia-arbitrum": {
            chainId: 421614,
            url: QUICKNODE_ARBITRUM_SEPOLIA_URL,
            accounts: {
                mnemonic: process.env.MNEMONIC || ""
            },
            gas: "auto",
            gasPrice: "auto",
            gasMultiplier: 1.2
        },
        "arbitrum": {
            chainId: 42161,
            url: QUICKNODE_ARBITRUM_MAINNET_URL,
            accounts: {
                mnemonic: process.env.MNEMONIC || ""
            },
            gas: "auto",
            gasPrice: "auto",
            gasMultiplier: 1.2
        },
        "polygon": {
            chainId: 137,
            url: `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
            accounts: {
                mnemonic: process.env.MNEMONIC || ""
            },
            gas: "auto",
            gasPrice: "auto",
            gasMultiplier: 1.2
        },
        "ethereum": {
            chainId: 1,
            url: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
            accounts: {
                mnemonic: process.env.MNEMONIC || ""
            },
            gas: "auto",
            gasPrice: "auto",
            gasMultiplier: 1.2
        },
        "sepolia": {
            chainId: 11155111,
            url: `https://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
            accounts: {
                mnemonic: process.env.MNEMONIC || ""
            },
            gas: "auto",
            gasPrice: "auto",
            gasMultiplier: 1.2
        },
        "world-mobile-testnet": {
            chainId: 323432,
            url: `https://worldmobile-testnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
            accounts: {
                mnemonic: process.env.MNEMONIC || ""
            },
            gas: "auto",
            gasPrice: "auto",
            gasMultiplier: 1.2
        },
        "sepolia-world": {
            chainId: 4801,
            url: "https://worldchain-sepolia.g.alchemy.com/public",
            accounts: {
                mnemonic: process.env.MNEMONIC || ""
            },
            gas: 3000000,
            gasPrice: 20000000000, // 20 gwei (much higher)
            timeout: 120000 // 2 minutes timeout
        },
        "arc-testnet": {
            chainId: 5042002,
            url: `https://arc-testnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
            accounts: {
                mnemonic: process.env.MNEMONIC || ""
            },
            gas: "auto",
            gasPrice: "auto",
            gasMultiplier: 1.2
        },
    },
    etherscan: {
        apiKey: ETHERSCAN_API_KEY,
        customChains: [
            {
                network: "sepolia-world",
                chainId: 4801,
                urls: {
                    apiURL: "https://sepolia.worldscan.org/api/",
                    browserURL: "https://sepolia.worldscan.org"
                }
            }
        ]
    }, sourcify: {
        enabled: false,
    }
};

export default config;
