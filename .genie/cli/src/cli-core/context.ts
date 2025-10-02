import type BackgroundManager from '../background-manager';
import type { Executor } from '../executors/types';
import type { SessionService } from './session-service';
import type { ConfigPaths, GenieConfig, CLIOptions, ParsedCommand } from './types';
import type { ViewEnvelope } from '../view';

export type EmitViewFn = (
  envelope: ViewEnvelope,
  options: CLIOptions,
  opts?: { stream?: NodeJS.WriteStream; forceJson?: boolean }
) => Promise<void>;

export interface HandlerContext {
  config: GenieConfig;
  defaultConfig: GenieConfig;
  paths: Required<ConfigPaths>;
  sessionService: SessionService;
  backgroundManager: BackgroundManager;
  emitView: EmitViewFn;
  recordRuntimeWarning: (message: string) => void;
  recordStartupWarning: (message: string) => void;
  executors: Record<string, Executor>;
  defaultExecutorKey: string;
}

export type Handler = (parsed: ParsedCommand) => Promise<void | any>;
