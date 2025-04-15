// utils/nonceManager.js
// Simple Nonce Manager (can be enhanced with locking, pending tracking)

const { ethers } = require('ethers');
const logger = require('./logger'); // Use standard logger

class NonceManager {
    constructor(signer) {
        if (!signer || !signer.provider || typeof signer.getAddress !== 'function' || !signer.address) {
            // Added check for signer.address as it's used immediately
            throw new Error("NonceManager requires a valid Ethers Signer instance with an associated address.");
        }
        this.signer = signer;
        this.address = signer.address; // Store address for clarity
        this.provider = signer.provider;
        this.currentNonce = -1; // Initialize as unset
        this.lock = false; // Simple lock mechanism
        logger.debug(`[NonceManager] Instance created for address: ${this.address}`);
    }

    async initialize() {
        logger.info(`[NonceManager] Initializing for address: ${this.address}`);
        try {
            // Get the nonce for the latest *committed* transaction
            this.currentNonce = await this.provider.getTransactionCount(this.address, 'latest');
            logger.info(`[NonceManager] Initial nonce set to: ${this.currentNonce}`);
        } catch (error) {
            logger.error(`[NonceManager] CRITICAL: Failed to initialize nonce for ${this.address}: ${error.message}`);
            // Re-throw as critical, initialization failure is serious
            throw new Error(`Nonce initialization failed: ${error.message}`);
        }
    }

    // Gets the next nonce, simple increment approach
    // WARNING: Does not handle concurrent requests well without external locking
    async getNextNonce() {
        const functionSig = `[NonceManager Address: ${this.address}]`;
        // Ensure initialized
        if (this.currentNonce < 0) {
            logger.warn(`${functionSig} Nonce not initialized. Attempting initialization...`);
            await this.initialize(); // This will throw if it fails again
        }

        // Very basic lock to prevent immediate concurrent calls fetching the same nonce
        // A more robust solution (e.g., using async-mutex) is needed for true concurrency
        if (this.lock) {
            logger.warn(`${functionSig} Lock is active. Waiting...`);
            // Add a timeout to prevent infinite loops?
            const startTime = Date.now();
            while (this.lock && (Date.now() - startTime < 5000)) { // Wait up to 5 seconds
                await new Promise(resolve => setTimeout(resolve, 50)); // Simple wait
            }
            if (this.lock) { // Still locked after timeout
                 this.lock = false; // Force release lock
                 logger.error(`${functionSig} Lock wait timed out! Forcing release. Nonce might be incorrect.`);
                 throw new Error("NonceManager lock timeout");
            }
        }

        this.lock = true;
        logger.debug(`${functionSig} Lock acquired.`);
        try {
            // Fetch the 'pending' count to see if external txs increased the nonce
            const pendingNonce = await this.provider.getTransactionCount(this.address, 'pending');
            if (pendingNonce > this.currentNonce) {
                 logger.info(`${functionSig} Pending nonce (${pendingNonce}) is higher than current (${this.currentNonce}). Updating.`);
                 this.currentNonce = pendingNonce;
            }

            const nonceToUse = this.currentNonce;
            this.currentNonce++; // Increment for the *next* call
            logger.info(`${functionSig} Providing nonce: ${nonceToUse}, next internal nonce will be: ${this.currentNonce}`);
            return nonceToUse;
        } catch (error) {
             logger.error(`${functionSig} Error getting transaction count: ${error.message}`);
             // Re-throw as it affects tx sending.
             throw new Error(`Failed to get transaction count: ${error.message}`);
        } finally {
             this.lock = false; // Release lock
             logger.debug(`${functionSig} Lock released.`);
        }
    }

     // Call this if a transaction fails due to nonce issues to try and resync
     async resyncNonce() {
         const functionSig = `[NonceManager Address: ${this.address}]`;
         logger.warn(`${functionSig} Resyncing nonce...`);
         this.lock = false; // Ensure lock is released before trying to re-init
         this.currentNonce = -1; // Reset
         try {
             await this.initialize(); // Re-fetch from provider
         } catch (error) {
              logger.error(`${functionSig} Failed to resync nonce: ${error.message}`);
              // What should happen here? Bot might need to stop if nonce is unreliable.
         }
     }
}

// --- CORRECT EXPORT ---
// Export the class directly
module.exports = NonceManager;
