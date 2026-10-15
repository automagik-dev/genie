/**
 * The injected native-adapter map. Empty until a harness adapter lands (G7 adds `omp`);
 * the supervisor takes this map as an argument, so later imports always resolve.
 */
import type { AdapterMap } from '../contracts';
import { ompAdapter } from './omp';

export const ADAPTERS: AdapterMap = { omp: ompAdapter };
