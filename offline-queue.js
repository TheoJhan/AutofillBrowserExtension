// offline-queue.js - Offline Command Queue Management

class OfflineCommandQueue {
  constructor() {
    this.queue = [];
    this.isOnline = false;
    this.processing = false;
    this.maxRetries = 3;
  }

  // Add command to queue
  async addCommand(command) {
    const queuedCommand = {
      id: this.generateId(),
      command,
      timestamp: Date.now(),
      retries: 0,
      status: 'queued'
    };

    this.queue.push(queuedCommand);
    await this.saveQueue();
    console.log(`📥 Command queued: ${queuedCommand.id}`);
    
    // Try to process if online
    if (this.isOnline) {
      this.processQueue();
    }
  }

  // Process queued commands
  async processQueue() {
    if (this.processing || this.queue.length === 0) return;
    
    this.processing = true;
    console.log(`🔄 Processing ${this.queue.length} queued commands`);

    while (this.queue.length > 0) {
      const queuedCommand = this.queue[0];
      
      try {
        // Attempt to execute command
        const result = await this.executeCommand(queuedCommand.command);
        
        // Remove from queue on success
        this.queue.shift();
        console.log(`✅ Queued command executed: ${queuedCommand.id}`);
        
      } catch (error) {
        console.error(`❌ Queued command failed: ${queuedCommand.id}`, error);
        
        queuedCommand.retries++;
        queuedCommand.lastError = error.message;
        
        if (queuedCommand.retries >= this.maxRetries) {
          // Remove from queue after max retries
          this.queue.shift();
          console.log(`🗑️ Command removed after max retries: ${queuedCommand.id}`);
        } else {
          // Move to end of queue for retry
          this.queue.push(this.queue.shift());
        }
      }
    }
    
    await this.saveQueue();
    this.processing = false;
  }

  // Execute a single command
  async executeCommand(command) {
    // This would integrate with your existing command execution logic
    // For now, we'll simulate command execution
    return new Promise((resolve, reject) => {
      // Simulate network request
      setTimeout(() => {
        if (Math.random() > 0.1) { // 90% success rate
          resolve({ success: true, commandId: command.id });
        } else {
          reject(new Error('Simulated command failure'));
        }
      }, 1000);
    });
  }

  // Set online status
  setOnlineStatus(online) {
    const wasOffline = !this.isOnline;
    this.isOnline = online;
    
    if (wasOffline && online) {
      console.log("🌐 Back online, processing queued commands");
      this.processQueue();
    }
  }

  // Get queue status
  getQueueStatus() {
    return {
      length: this.queue.length,
      processing: this.processing,
      isOnline: this.isOnline
    };
  }

  // Clear queue
  async clearQueue() {
    this.queue = [];
    await this.saveQueue();
    console.log("🧹 Queue cleared");
  }

  // Save queue to storage
  async saveQueue() {
    return new Promise((resolve) => {
      chrome.storage.local.set({ offlineCommandQueue: this.queue }, resolve);
    });
  }

  // Load queue from storage
  async loadQueue() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['offlineCommandQueue'], (result) => {
        this.queue = result.offlineCommandQueue || [];
        console.log(`📋 Loaded ${this.queue.length} queued commands`);
        resolve();
      });
    });
  }

  // Generate unique ID
  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }
}

// Export for use in other files
if (typeof module !== 'undefined' && module.exports) {
  module.exports = OfflineCommandQueue;
} else {
  window.OfflineCommandQueue = OfflineCommandQueue;
} 