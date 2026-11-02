const { createMemoryStore } = require("./memoryStore");
const { createMongoStore } = require("./mongoStore");

// STORAGE=memory forces the in-memory store. Otherwise MONGO_URI is required.
async function createStore({ mongoUri, storage = process.env.STORAGE } = {}) {
  if (storage === "memory") return createMemoryStore();
  if (!mongoUri) {
    throw new Error("MONGO_URI is not set. Set it, or run with STORAGE=memory for a quick local try.");
  }
  return createMongoStore(mongoUri);
}

module.exports = { createStore, createMemoryStore };
