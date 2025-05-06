// scripts/checkEthers.js

console.log("Attempting to require hardhat and ethers...");
try {
  const { ethers } = require("hardhat");
  console.log("Successfully required hardhat.");
  console.log("Ethers object obtained from hardhat:", ethers);
  console.log("Type of ethers object:", typeof ethers);
  console.log("Does ethers have .utils property?", ethers.hasOwnProperty('utils'));
  console.log("Value of ethers.utils:", ethers.utils);
  console.log("Does ethers have .constants property?", ethers.hasOwnProperty('constants'));
  console.log("Value of ethers.constants:", ethers.constants);
  console.log("Minimal ethers check complete.");

} catch (error) {
    console.error("Error requiring hardhat:", error);
}
