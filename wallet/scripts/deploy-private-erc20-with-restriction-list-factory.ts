import { deployFactory } from "./deploy-factory-common";

async function main() {
  await deployFactory(
    "PrivateERC20WithRestrictionListFactory256",
    "PrivateERC20WithRestrictionListFactory256"
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  }); 