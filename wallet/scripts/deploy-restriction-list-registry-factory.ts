import { deployFactory } from "./deploy-factory-common";

async function main() {
  await deployFactory("RestrictionListRegistryFactory", "RestrictionListRegistryFactory");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  }); 