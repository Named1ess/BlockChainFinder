/** 演示模式的固定地址网络，Mock 中间件与前端页面共用 */

/** 由十六进制前缀 + 序号生成合法格式的演示地址（40 位 hex） */
export function makeAddr(prefixHex: string, seq: number): string {
  const body = `${prefixHex}${seq}`;
  return `0x${(body + '0'.repeat(64)).slice(0, 40)}`;
}

export const DEMO_A = makeAddr('a11ce', 1); // 演示种子地址
export const DEMO_B = makeAddr('b0b', 2);
export const DEMO_C = makeAddr('c0ffee', 3);
export const DEMO_D = makeAddr('d00d', 4);
export const DEMO_E = makeAddr('e', 5);
export const DEMO_F = makeAddr('face', 6);

/** 演示资金网络：A→B, A→C, B→D, C→D, D→E, E→F, C→A */
export const DEMO_EDGES: Array<[string, string]> = [
  [DEMO_A, DEMO_B],
  [DEMO_A, DEMO_C],
  [DEMO_B, DEMO_D],
  [DEMO_C, DEMO_D],
  [DEMO_D, DEMO_E],
  [DEMO_E, DEMO_F],
  [DEMO_C, DEMO_A],
];
