declare module "@0gfoundation/0g-storage-ts-sdk" {
  export class Indexer {
    constructor(rpcUrl: string);
    upload(file: ZgFile, evmRpc: string, signer: unknown): Promise<[unknown, unknown]>;
  }

  export class ZgFile {
    static fromFilePath(filePath: string): Promise<ZgFile>;
    merkleTree(): Promise<[{ rootHash(): string | null } | null, unknown]>;
    close(): Promise<void>;
  }
}
