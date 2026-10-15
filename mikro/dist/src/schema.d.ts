export interface CliFlagSchema {
    name: string;
    aliases?: string[];
    type: "boolean" | "string" | "number" | "list";
    default?: string | number | boolean | string[] | null;
    choices?: string[];
    description: string;
    appliesTo?: string[];
}
export interface ExitCodeSchema {
    code: number;
    meaning: string;
}
export interface JsonSchema {
    $schema?: string;
    type: string;
    description?: string;
    required?: string[];
    properties: Record<string, unknown>;
    additionalProperties?: boolean;
}
export interface MikroCliSchema {
    schemaVersion: 1;
    command: "mikro";
    flags: CliFlagSchema[];
    output: JsonSchema;
    exitCodes: ExitCodeSchema[];
}
export declare const MIKRO_CLI_SCHEMA: MikroCliSchema;
export declare function printMikroCliSchema(): void;
//# sourceMappingURL=schema.d.ts.map