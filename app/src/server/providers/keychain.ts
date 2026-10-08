// OS-backed credential encryption for the Sign in with ChatGPT DevKit. The
// DevKit refuses to persist tokens without one. A random AES-256-GCM key lives in
// the macOS login Keychain; the encrypted token file lives in the data dir.
import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface CredentialEncryption {
  id: string;
  isAvailable(): boolean | Promise<boolean>;
  encrypt(plaintext: string): Uint8Array | Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array): string | Promise<string>;
}

export function keychainEncryption(service = "learn-app", account = "chatgpt-credential-key"): CredentialEncryption {
  let cached: Buffer | null = null;

  const read = (): Buffer | null => {
    const r = spawnSync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], { encoding: "utf8" });
    return r.status === 0 ? Buffer.from(r.stdout.trim(), "base64") : null;
  };

  const key = (): Buffer => {
    if (cached) return cached;
    let k = read();
    if (!k) {
      const fresh = randomBytes(32).toString("base64");
      // `security -i` takes the command on stdin, so the key never appears in argv / `ps`.
      const w = spawnSync("security", ["-i"], { input: `add-generic-password -s ${service} -a ${account} -w ${fresh} -U\n`, encoding: "utf8" });
      if (w.status !== 0) throw new Error("Could not store the encryption key in the macOS Keychain");
      k = read();
    }
    if (!k || k.length !== 32) throw new Error("macOS Keychain did not return a valid encryption key");
    cached = k;
    return k;
  };

  return {
    id: "learn-macos-keychain-aes256gcm-v1",
    isAvailable: () => process.platform === "darwin" && spawnSync("security", ["help"], { encoding: "utf8" }).error === undefined,
    encrypt(plaintext) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key(), iv);
      const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
      return new Uint8Array(Buffer.concat([iv, c.getAuthTag(), body]));
    },
    decrypt(ciphertext) {
      const b = Buffer.from(ciphertext);
      const d = createDecipheriv("aes-256-gcm", key(), b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
    },
  };
}

/** In-memory key for tests only; never used by the running app. */
export function testEncryption(): CredentialEncryption {
  const k = randomBytes(32);
  return {
    id: "test-only",
    isAvailable: () => true,
    encrypt(p) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", k, iv);
      const body = Buffer.concat([c.update(p, "utf8"), c.final()]);
      return new Uint8Array(Buffer.concat([iv, c.getAuthTag(), body]));
    },
    decrypt(x) {
      const b = Buffer.from(x);
      const d = createDecipheriv("aes-256-gcm", k, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
    },
  };
}
