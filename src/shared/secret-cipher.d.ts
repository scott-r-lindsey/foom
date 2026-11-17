/** OS-backed encryption for secret values (Electron `safeStorage` in the app). */
export interface SecretCipher {
  /** Reports platform support without accessing the keychain. */
  supported(): boolean;
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}
