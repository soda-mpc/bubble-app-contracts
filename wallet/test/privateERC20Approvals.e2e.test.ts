import { expect } from "chai";
import hre from "hardhat";
import dotenv from "dotenv";

import { decryptBalanceViaProxy, getUserKeyViaProxy } from "./helpers/bubbleCryptoTransport";
import {
  buildSignedItUint256,
  createRandomWalletsAndFund,
  deployMockToken,
  deployPrivateToken,
} from "./helpers/testHelpers";

dotenv.config();

const ARBITRUM_SEPOLIA_CHAIN_ID = 421614n;
const PROXY_URL = process.env.PROXY_URL || "https://proxy.bubble.sodalabs.net";
const APPROVE_IT_UINT256_SIGNATURE = "approve(address,(address,(uint256,uint256)))";

async function decryptHandle(handle: bigint, signer: any, aesKey: Buffer) {
  if (handle === 0n) {
    return 0n;
  }
  return decryptBalanceViaProxy(handle, signer, aesKey, PROXY_URL);
}

describe("PrivateERC20Contract256 approvals E2E", function () {
  this.timeout(300000);

  let owner: any;
  let spender: any;
  let master: any;
  let ownerAesKey: Buffer;
  let privateToken: any;

  before(async function () {
    if ((!process.env.QUICKNODE_ARBITRUM_SEPOLIA_URL && !process.env.ALCHEMY_API_KEY) || !process.env.MNEMONIC) {
      this.skip();
    }

    const network = await hre.ethers.provider.getNetwork();
    if (network.chainId !== ARBITRUM_SEPOLIA_CHAIN_ID) {
      this.skip();
    }

    [owner] = await hre.ethers.getSigners();
    [spender, master] = await createRandomWalletsAndFund({
      hre,
      sender: owner,
      count: 2,
      amountWei: hre.ethers.parseEther("0.01"),
    });

    ownerAesKey = await getUserKeyViaProxy(owner as any, PROXY_URL);

    const mockToken = await deployMockToken(hre, owner);
    privateToken = await deployPrivateToken(hre, owner, {
      underlyingAddress: await mockToken.getAddress(),
      ownerAddress: owner.address,
      masterAddress: master.address,
    });
  });

  it("stores and exposes clear and encrypted approvals", async function () {
    const clearAmount = 11n * 10n ** 18n;
    const encryptedAmount = 7n * 10n ** 18n;
    const privateTokenAddress = await privateToken.getAddress();

    await (await privateToken["approve(address,uint256)"](spender.address, clearAmount)).wait();
    const clearAllowanceHandle = await privateToken.allowance(owner.address, spender.address);
    expect(await decryptHandle(clearAllowanceHandle, owner, ownerAesKey))
      .to.equal(clearAmount);

    const encryptedApproval = await buildSignedItUint256({
      value: encryptedAmount,
      userAddress: owner.address,
      userAesKeyHex: ownerAesKey.toString("hex"),
      contractAddress: privateTokenAddress,
      signer: owner,
    });

    await (await privateToken[APPROVE_IT_UINT256_SIGNATURE](spender.address, encryptedApproval)).wait();
    const encryptedAllowanceHandle = await privateToken.allowance(owner.address, spender.address);
    expect(encryptedAllowanceHandle).to.not.equal(clearAllowanceHandle);
    expect(await decryptHandle(encryptedAllowanceHandle, owner, ownerAesKey))
      .to.equal(encryptedAmount);
  });
});
