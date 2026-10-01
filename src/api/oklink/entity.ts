import { getChain } from './chains';
import { UnsupportedEndpointError } from './client';
import { fetchBlockscoutEntityLabel } from '../blockscout';
import { fetchTronscanEntityLabel } from '../tronscan';
import { fetchOklinkWebEntityLabel } from './webEntity';

export type EntityLabelSource = 'Blockscout' | 'TronScan' | 'OKLink';

/** Label selection is separate from the chain's asset and transaction provider. */
export function getEntityLabelSource(chain: string): EntityLabelSource | null {
  const info = getChain(chain);
  if (!info) return null;
  const mock = typeof __APP_MOCK__ !== 'undefined' && __APP_MOCK__;
  if (!mock && import.meta.env.VITE_ENTITY_LABEL_SOURCE === 'oklink') return 'OKLink';
  return info.dataSource;
}

/** Only provider-published labels are used; failed lookups remain errors. */
export async function fetchAddressEntityLabel(chain: string, address: string): Promise<string | null> {
  const provider = getEntityLabelSource(chain);
  if (provider === 'OKLink') return fetchOklinkWebEntityLabel(chain, address);
  if (provider === 'Blockscout') return fetchBlockscoutEntityLabel(chain, address);
  if (provider === 'TronScan') return fetchTronscanEntityLabel(address);
  throw new UnsupportedEndpointError(`${chain} 暂未接入地址标签数据源。`);
}
