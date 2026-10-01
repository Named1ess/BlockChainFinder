import { expect, it } from 'vitest';
import { isExchangeTag } from '../src/utils/exchangeTag';

it('recognizes the public Bittrex wallet label supplied by Blockscout', () => {
  expect(isExchangeTag('Bittrex: Hot Wallet')).toBe(true);
  expect(isExchangeTag('Uniswap V3: Pool')).toBe(false);
});
