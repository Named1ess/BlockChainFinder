import { useSyncExternalStore } from 'react';
import { TraceEngine } from './engine';

/** 全局单例：同一时间只进行一条溯源任务 */
export const traceEngine = new TraceEngine();

export function useTraceEngine(): {
  engine: TraceEngine;
  snapshot: ReturnType<TraceEngine['getSnapshot']>;
} {
  const snapshot = useSyncExternalStore(traceEngine.subscribe, traceEngine.getSnapshot);
  return { engine: traceEngine, snapshot };
}
