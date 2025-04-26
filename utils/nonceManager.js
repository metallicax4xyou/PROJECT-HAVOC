// utils/nonceManager.js
// --- VERSION v1.1 --- Uses async-mutex for proper locking

const { ethers } = require('ethers');
const logger = require('./logger');
const { Mutex } = require('async-mutex'); // Import Mutex

class NonceManager {
    constructor(signer) {
        if (!signer || !signer.provider || typeof signer.getAddress !== 'function' || !signer.address) {
            throw new Error("NonceManager requires a valid Ethers Signer instance with an associated address.");
        }
        this.signer = signer;
        this.address = signer.address;
        this.provider = signer.provider;
        this.currentNonce = -1; // Initialize as unset
        this.mutex = new Mutex(); // Initialize the mutex
        logger.debug(`[NonceManager v1.1] Instance created for address: ${this.address} (using async-mutex)`);
    }

    async initialize() {
        // No locking needed here as it's typically called once at startup or during resync (which is locked)
        logger.info(`[NonceManager] Initializing nonce for address: ${this.address}`);
        try {
            this.currentNonce = await this.provider.getTransactionCount(this.address, 'latest');
            logger.info(`[NonceManager] Initial nonce set to: ${this.currentNonce}`);
        } catch (error) {
            logger.error(`[NonceManager] CRITICAL: Failed to initialize nonce for ${this.address}: ${error.message}`);
            throw new Error(`Nonce initialization failed: ${error.message}`);
        }
    }

    /**
     * Gets the next available nonce, ensuring atomicity with a mutex.
     * @returns {Promise<number>} The next nonce to use.
     */
    async getNextNonce() {
        const functionSig = `[NonceManager Address: ${this.address}]`;
        // Acquire lock via mutex. This returns a release function.
        const release = await this.mutex.acquire();
        logger.debug(`${functionSig} Mutex acquired for getNextNonce.`);
        try {
            // Ensure initialized (lazy initialization)
            if (this.currentNonce < 0) {
                logger.warn(`${functionSig} Nonce not initialized. Attempting initialization within lock...`);
                // Call initialize directly, it will throw if it fails
                await this.initialize();
            }

            // Fetch the 'pending' count to check for external nonce increments
            let pendingNonce;
            try {
                 pendingNonce = await this.provider.getTransactionCount(this.address, 'pending');
            } catch (fetchError) {
                 logger.error(`${functionSig} Error fetching pending transaction count: ${fetchError.message}`);
                 // Re-throw as this is critical for determining the correct nonce
                 throw new Error(`Failed to fetch pending nonce: ${fetchError.message}`);
            }

            if (pendingNonce > this.currentNonce) {
                 logger.info(`${functionSig} Pending nonce (${pendingNonce}) is higher than current internal nonce (${this.currentNonce}). Updating internal nonce.`);
                 this.currentNonce = pendingNonce;
            }

            // Use the current internal nonce and then increment it for the next call
            const nonceToUse = this.currentNonce;
            this.currentNonce++; // Increment *after* assigning nonceToUse
            logger.info(`${functionSig} Providing nonce: ${nonceToUse}, next internal nonce will be: ${this.currentNonce}`);
            return nonceToUse;

        } finally {
            // Ensure the lock is always released, even if errors occur
            release();
            logger.debug(`${functionSig} Mutex released for getNextNonce.`);
        }
    }

     /**
      * Resynchronizes the internal nonce count with the blockchain ('latest').
      * Uses mutex to prevent conflicts with getNextNonce.
      */
     async resyncNonce() {
         const functionSig = `[NonceManager Address: ${this.address}]`;
         const release = await this.mutex.acquire(); // Acquire lock before resyncing
         logger.warn(`${functionSig} Mutex acquired for resyncNonce...`);
         try {
             logger.warn(`${functionSig} Resyncing nonce... Resetting internal count and fetching latest.`);
             this.currentNonce = -1; // Reset internal state first
             await this.initialize(); // Re-fetch 'latest' nonce (initialization logic)
             logger.info(`${functionSig} Nonce resync completed. New internal nonce: ${this.currentNonce}`);
         } catch (error) {
              logger.error(`${functionSig} Failed to resync nonce: ${error.message}`);
              // Decide if this should re-throw or allow the bot to potentially continue with an unknown nonce state
              // Re-throwing might be safer to halt operations if nonce state is critical and uncertain.
              throw new Error(`Nonce resynchronization failed: ${error.message}`);
         } finally {
             release(); // Release lock
             logger.debug(`${functionSig} Mutex released for resyncNonce.`);
         }
     }

     // Expose the signer address directly if needed
     getAddress() {
        return this.address;
     }

     // Provide access to the underlying signer if needed for signing messages etc.
     // Note: Transactions should generally go through this manager's methods or use the manager as the signer directly.
     getSigner() {
         return this.signer;
     }

} // End NonceManager class

module.exports = NonceManager; // Export class directly
