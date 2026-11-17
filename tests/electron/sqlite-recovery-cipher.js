// Fixture-only authenticated encryption. Never accesses the developer's keychain.
const { randomBytes, createCipheriv, createDecipheriv } = require("node:crypto");
module.exports = function recoveryCipher() {
  const key = randomBytes(32);
  return {
    supported: () => true,
    available: () => true,
    encrypt(text) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const bytes = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decrypt(bytes) {
      const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
    },
  };
};
