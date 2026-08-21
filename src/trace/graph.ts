/** 溯源图的数据模型：节点 = 地址，边 = 聚合后的转账关系 */

export type TraceDirection = 'in' | 'out' | 'both';

export interface AddressNode {
  address: string;
  /** 距种子地址的跳数，种子为 0 */
  depth: number;
  /** 是否已展开过（拉取过交易并解析邻居） */
  expanded: boolean;
  position: { x: number; y: number };
}

export interface EdgeTransfer {
  token: string;
  contract: string;
  amount: number;
  /** 单笔聚合金额的 USD 估值；价格未知时为 null */
  usdValue: number | null;
  count: number;
  lastTime: number | null;
}

export interface TransferEdge {
  /** `${from}->${to}` */
  id: string;
  from: string;
  to: string;
  transfers: EdgeTransfer[];
  txCount: number;
  /** 已知 USD 合计（价格未知的转账不计入） */
  totalUsd: number;
}

export interface TraceGraph {
  nodes: Map<string, AddressNode>;
  edges: Map<string, TransferEdge>;
}

export function edgeId(from: string, to: string): string {
  return `${from}->${to}`;
}

export function createEmptyGraph(): TraceGraph {
  return { nodes: new Map(), edges: new Map() };
}
