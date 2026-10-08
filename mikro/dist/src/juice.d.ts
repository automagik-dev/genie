/** Reference-only project identity. Never serialize a resolved credential. */
export interface JuiceProjectConfig {
    origin: string;
    project: string;
    keyAlias: string;
    keyEpoch: string;
    keyFile: string;
}
export declare class JuiceError extends Error {
    readonly code: "config" | "credential" | "permissions" | "transport" | "http" | "response";
    readonly status?: number | undefined;
    constructor(code: "config" | "credential" | "permissions" | "transport" | "http" | "response", status?: number | undefined);
}
export declare function juiceOrigin(value: string): string;
export declare function parseJuiceProject(value: unknown): JuiceProjectConfig | undefined;
export declare function readPrivateKeyFile(path: string, signal?: AbortSignal): Promise<string>;
/** One atomic PATCH. A failed call retains the private key for an idempotent explicit rerun. */
export declare function provisionJuiceProject(project: JuiceProjectConfig, management: {
    keyFile?: string;
    keyEnv?: string;
}, signal?: AbortSignal): Promise<{
    project: string;
    keyAlias: string;
    keyEpoch: string;
    keyFile: string;
}>;
export declare function resolveKeyReference(reference: {
    keyFile?: string;
    keyEnv?: string;
}, signal?: AbortSignal): Promise<string>;
export interface JuiceCatalog {
    version: 1;
    project: string;
    keyAlias: string;
    keyEpoch: string;
    url: string;
    fetchedAt: string;
    contentSha256: string;
    models: {
        id: string;
        ownedBy: string | null;
    }[];
}
export declare function fetchJuiceCatalog(project: JuiceProjectConfig, signal?: AbortSignal): Promise<JuiceCatalog>;
export interface KeeperQuery {
    range: string;
    unit?: "hour" | "day";
    start?: string;
    end?: string;
}
type SafeJson = null | string | number | boolean | SafeJson[] | {
    [key: string]: SafeJson;
};
export interface KeeperSnapshot {
    version: 1;
    project: string;
    keyAlias: string;
    keyEpoch: string;
    fetchedAt: string;
    keeperVersion: string;
    capabilities: {
        aggregateUsage: true;
        requestEvents: false;
        payloadExport: false;
        canonicalBilling: false;
    };
    query: KeeperQuery;
    sources: {
        url: string;
        fetchedAt: string;
        timezone: string | null;
        rangeStart: string | null;
        rangeEnd: string | null;
        contentSha256: string;
        data: SafeJson;
    }[];
    contentSha256: string;
}
export declare function fetchKeeperSnapshot(project: JuiceProjectConfig, query: KeeperQuery, analyze: boolean, signal?: AbortSignal): Promise<KeeperSnapshot>;
export {};
//# sourceMappingURL=juice.d.ts.map