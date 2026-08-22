import { useSyncExternalStore } from 'react';
import { ExchangeHuntEngine } from './exchangeHunt';

/** 全局单例：同一时间只进行一次盒武器搜索 */
export const exchangeHuntEngine = new ExchangeHuntEngine();

export function useExchangeHunt(): {
  engine: ExchangeHuntEngine;
  snapshot: ReturnType<ExchangeHuntEngine['getSnapshot']>;
} {
  const snapshot = useSyncExternalStore(exchangeHuntEngine.subscribe, exchangeHuntEngine.getSnapshot);
  return { engine: exchangeHuntEngine, snapshot };
}
