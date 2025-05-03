// scripts/log_private_key.js
const { ethers } = require("hardhat");

async function main() {
  const [signer] = await ethers.getSigners(); // Get the first default signer
  console.log("Hardhat Node Default Signer Address:", signer.address);
  console.log("Hardhat Node Default Signer Private Key:", signer.privateKey);
  console.log("^^^ COPY THE PRIVATE KEY ABOVE ^^^");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
