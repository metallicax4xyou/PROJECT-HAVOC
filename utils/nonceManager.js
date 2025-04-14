// utils/nonceManager.js
// Simple Nonce Manager (can be enhanced with locking, pending tracking)

const { ethers } = require('ethers');

class NonceManager {
    constructor(signer) {
        if (!signer || !signer.provider || typeof signer.getAddress !== 'function') {
            throw new Error("NonceManager requires a valid Ethers Signer instance.");
        }
        this.signer = signer;
        this.address = signer.address; // Store address for clarity
        this.provider = signer.provider;
        this.currentNonce = -1; // Initialize as unset
        this.lock = false; // Simple lock mechanism
    }

    async initialize() {
        console.log(`[NonceManager] Initializing for address: ${this.address}`);
        try {
            // Get the nonce for the latest *committed* transaction
            this.currentNonce = await this.provider.getTransactionCount(this.address, 'latest');
            console.log(`[NonceManager] Initial nonce set to: ${this.currentNonce}`);
        } catch (error) {
            console.error(`[NonceManager] CRITICAL: Failed to initialize nonce for ${this.address}`, error);
            throw new Error(`Nonce initialization failed: ${error.message}`); // Re-throw as critical
        }
    }

    // Gets the next nonce, simple increment approach
    // WARNING: Does not handle concurrent requests well without external locking
    async getNextNonce() {
        // Ensure initialized
        if (this.currentNonce < 0) {
            console.warn("[NonceManager] Nonce not initialized. Attempting initialization...");
            await this.initialize();
            if (this.currentNonce < 0) { // Still failed
                 throw new Error("NonceManager failed to initialize nonce.");
            }
        }

        // Very basic lock to prevent immediate concurrent calls fetching the same nonce
        // A more robust solution (e.g., using async-mutex) is needed for true concurrency
        while (this.lock) {
            console.log("[NonceManager] Waiting for lock release...");
            await new Promise(resolve => setTimeout(resolve, 50)); // Simple wait
        }

        this.lock = true;
        try {
            // Fetch the 'pending' count to see if external txs increased the nonce
            const pendingNonce = await this.provider.getTransactionCount(this.address, 'pending');
            if (pendingNonce > this.currentNonce) {
                 console.log(`[NonceManager] Pending nonce (${pendingNonce}) is higher than current (${this.currentNonce}). Updating.`);
                 this.currentNonce = pendingNonce;
            }

            const nonceToUse = this.currentNonce;
            this.currentNonce++; // Increment for the *next* call
            console.log(`[NonceManager] Providing nonce: ${nonceToUse}, next will be: ${this.currentNonce}`);
            return nonceToUse;
        } catch (error) {
             console.error("[NonceManager] Error getting transaction count:", error);
             // Re-throw or handle? For now, re-throw as it affects tx sending.
             throw new Error(`Failed to get transaction count: ${error.message}`);
        } finally {
             this.lock = false; // Release lock
        }
    }

     // Call this if a transaction fails due to nonce issues to try and resync
     async resyncNonce() {
         console.warn("[NonceManager] Resyncing nonce...");
         this.currentNonce = -1; // Reset
         await this.initialize(); // Re-fetch from provider
     }
}

module.exports = { NonceManager };
