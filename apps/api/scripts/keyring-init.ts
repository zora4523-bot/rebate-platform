// B1-01zd / BR-ID-33: initialize a local WrappedKeyring from an existing master key file.
// Usage: node apps/api/scripts/keyring-init.ts <master-key-file> <output-file>
// Master format: exactly 64 lowercase hex characters, optionally followed by one LF,
// as specified by config/keyring-startup.ts. The generated key_id is `local`.
// Create a fresh data key and blind-index key; create output exclusively, mode 0o600.
// Never overwrite an existing output or print master/data/blind-index key material.
// Importing this module must not run the command or inspect process arguments.

/** Resolves after creating the file; rejects on invalid input or an existing output. */
export async function initLocalKeyring(masterKeyFile: string, outputFile: string): Promise<void> {
  void masterKeyFile;
  void outputFile;
  throw new Error('NotImplemented: initLocalKeyring');
}

/** CLI arguments exclude node and script paths; returns 0 on success, 1 on failure. */
export async function main(args: readonly string[]): Promise<number> {
  void args;
  throw new Error('NotImplemented: main');
}

// TODO(规划/11 §2.3): wire direct execution to main(process.argv.slice(2)) and its exit code
// — blocked on implementation phase; test-phase skeletons forbid top-level calls/branches.
