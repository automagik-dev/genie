declare module '../../../src/lib/forge-client.js' {
  export class ForgeClient {
    constructor(baseUrl: string, token?: string);
    getNormalizedLogsStreamUrl(processId: string): string;
    listExecutionProcesses(attemptId: string): Promise<any[]>;
    getTaskAttempt(attemptId: string): Promise<any>;
  }
}
