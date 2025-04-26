// utils/nonceManager.js
// --- VERSION v1.2 --- Implements Signer interface for sending transactions.

const { ethers, AbstractSigner } = require('ethers'); // Import AbstractSigner
const logger = require('./logger');
const { Mutex } = require('async-mutex'); // Import Mutex

// Extend AbstractSigner to make it a fully functional Signer
class NonceManager extends AbstractSigner {
    constructor(signer) {
        // Call the AbstractSigner constructor
        // Pass the provider from the underlying signer
        super(signer.provider);

        if (!signer || !signer.provider || typeof signer.getAddress !== 'function' || !signer.address) {
            throw new Error("NonceManager requires a valid Ethers Signer instance with an associated address.");
        }
        this.signer = signer; // The actual underlying wallet (e.g., ethers.Wallet)
        this.address = signer.address; // Store address for easy access
        // this.provider is inherited from AbstractSigner and set by super(signer.provider)
        this.currentNonce = -1; // Initialize as unset
        this.mutex = new Mutex(); // Initialize the mutex
        logger.debug(`[NonceManager v1.2] Instance created for address: ${this.address} (implements Signer)`);
    }

    // Required by AbstractSigner: Returns the signer's address
    async getAddress() {
        // We stored it in the constructor for synchronous access if needed elsewhere,
        // but AbstractSigner requires an async method.
        return Promise.resolve(this.address);
    }

    // Required by AbstractSigner: Returns a new instance connected to a different provider
    // If provider is null, it should return a signer connected to the same provider.
    connect(provider) {
        const currentProvider = this.provider; // Get provider from inherited property
        const newProvider = (provider === null) ? currentProvider : provider;
        if (newProvider === currentProvider) {
            return this; // Return self if provider hasn't changed
        }
        // Create a new NonceManager with the underlying signer connected to the new provider
        logger.debug(`[NonceManager] connect() called, creating new instance with new provider`);
        const newSigner = this.signer.connect(newProvider);
        // NOTE: The nonce state is NOT carried over to the new instance.
        // This is generally expected behavior for connect(). The new instance
        // should likely re-initialize its nonce if used for sending.
        return new NonceManager(newSigner);
    }


    /**
     * Initializes the internal nonce count by fetching the 'latest' transaction count.
     * Should be called before the first transaction or during resync.
     */
    async initialize() {
        // No locking needed here as it's typically called once at startup or during resync (which is locked)
        const functionSig = `[NonceManager Address: ${this.address}]`;
        logger.info(`${functionSig} Initializing nonce...`);
        try {
            // Ensure provider is available (inherited from AbstractSigner)
            if (!this.provider) throw new Error("Provider not available for nonce initialization.");
            this.currentNonce = await this.provider.getTransactionCount(this.address, 'latest');
            logger.info(`${functionSig} Initial nonce set to: ${this.currentNonce}`);
        } catch (error) {
            logger.error(`${functionSig} CRITICAL: Failed to initialize nonce: ${error.message}`);
            throw new Error(`Nonce initialization failed: ${error.message}`);
        }
    }

    /**
     * Gets the next available nonce, ensuring atomicity with a mutex.
     * @returns {Promise<number>} The next nonce to use.
     */
    async getNextNonce() {
        const functionSig = `[NonceManager Address: ${this.address}]`;
        const release = await this.mutex.acquire();
        logger.debug(`${functionSig} Mutex acquired for getNextNonce.`);
        try {
            // Ensure initialized (lazy initialization)
            if (this.currentNonce < 0) {
                logger.warn(`${functionSig} Nonce not initialized. Attempting initialization within lock...`);
                await this.initialize(); // Call initialize to fetch starting nonce
            }

            // Fetch the 'pending' count to check for external nonce increments
            let pendingNonce;
            try {
                 if (!this.provider) throw new Error("Provider not available for fetching pending nonce.");
                 pendingNonce = await this.provider.getTransactionCount(this.address, 'pending');
            } catch (fetchError) {
                 logger.error(`${functionSig} Error fetching pending transaction count: ${fetchError.message}`);
                 throw new Error(`Failed to fetch pending nonce: ${fetchError.message}`);
            }

            // If pending nonce is higher, update internal nonce
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
            // Ensure the lock is always released
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
             await this.initialize(); // Re-fetch 'latest' nonce
             logger.info(`${functionSig} Nonce resync completed. New internal nonce: ${this.currentNonce}`);
         } catch (error) {
              logger.error(`${functionSig} Failed to resync nonce: ${error.message}`);
              throw new Error(`Nonce resynchronization failed: ${error.message}`);
         } finally {
             release(); // Release lock
             logger.debug(`${functionSig} Mutex released for resyncNonce.`);
         }
     }

    // --- IMPLEMENT sendTransaction ---
    /**
     * Sends a transaction, acquiring the next available nonce first.
     * @param {ethers.TransactionRequest} tx - The transaction request object.
     * @returns {Promise<ethers.TransactionResponse>}
     */
    async sendTransaction(tx) {
        const functionSig = `[NonceManager Address: ${this.address}]`;
        logger.debug(`${functionSig} sendTransaction called...`);

        // Ensure the underlying signer can actually send transactions
        if (typeof this.signer.sendTransaction !== 'function') {
             throw new Error("Underlying signer does not support sendTransaction");
        }

        // Get the next nonce using the mutex-protected method
        const nonce = await this.getNextNonce();

        // Populate the transaction with the managed nonce
        // Create a copy to avoid modifying the original tx object
        const populatedTx = { ...tx, nonce: nonce };
        // Ethers V6 requires chainId often, ensure it's present
        if (populatedTx.chainId === undefined) {
             const network = await this.provider?.getNetwork();
             if (network) {
                  populatedTx.chainId = network.chainId;
             } else {
                  logger.warn(`${functionSig} Could not determine chainId for transaction.`);
                  // Consider throwing an error if chainId is strictly required
             }
        }
        logger.debug(`${functionSig} Populated transaction with nonce ${nonce} and chainId ${populatedTx.chainId}`);

        // Delegate the actual sending to the underlying signer (e.g., Wallet)
        try {
            logger.debug(`${functionSig} Delegating sendTransaction to underlying signer...`);
            const txResponse = await this.signer.sendTransaction(populatedTx);
            logger.info(`${functionSig} Underlying signer submitted transaction. Hash: ${txResponse.hash}`);
            return txResponse;
        } catch (error) {
            logger.error(`${functionSig} Error sending transaction via underlying signer: ${error.message}`);
            // Handle potential nonce errors by trying to resync
            const message = error.message?.toLowerCase() || '';
            const code = error.code;
            // Use standard ethers v6 error codes if available
            if (code === 'NONCE_EXPIRED' || (ethers.ErrorCode && code === ethers.ErrorCode.NONCE_EXPIRED) || message.includes('nonce too low') || message.includes('invalid nonce')) {
                 logger.warn(`${functionSig} Nonce error detected during send, attempting resync...`);
                 // Don't await resync here, just trigger it and let the error propagate up
                 this.resyncNonce().catch(resyncErr => logger.error(`${functionSig} Background resync failed: ${resyncErr.message}`));
            }
            // Re-throw the error for upstream handling (e.g., by TxExecutor)
            throw error;
        }
    }
    // --- END sendTransaction ---


    // Provide access to the underlying signer if needed
    getSigner() {
        return this.signer;
    }

} // End NonceManager class

module.exports = NonceManager; // Export class directly
