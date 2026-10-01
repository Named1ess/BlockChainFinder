import { describe, expect, it } from 'vitest';
import { getExplorerUrl, parseSearchInput } from '../src/api/oklink/chains';

describe('parseSearchInput', () => {
  const evmAddress = '0x1111111111111111111111111111111111111111';

  it.each(['ETH', 'BSC', 'POLYGON'])('preserves the selected %s chain for an EVM address', (chain) => {
    expect(parseSearchInput(evmAddress, chain)).toEqual({
      kind: 'address',
      chain,
      address: evmAddress,
    });
  });

  it('trims whitespace around an EVM address while preserving the selected chain', () => {
    expect(parseSearchInput(`  ${evmAddress}\n`, 'POLYGON')).toEqual({
      kind: 'address',
      chain: 'POLYGON',
      address: evmAddress,
    });
  });

  it('autodetects a TRON base58 address', () => {
    const address = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8';

    expect(parseSearchInput(address, 'ETH')).toEqual({ kind: 'address', chain: 'TRON', address });
  });

  it('falls back to ETH when a TRON selection receives an EVM address', () => {
    expect(parseSearchInput(evmAddress, 'TRON')).toEqual({
      kind: 'address',
      chain: 'ETH',
      address: evmAddress,
    });
  });

  it('keeps the selected chain for an EVM transaction hash', () => {
    const txid = `0x${'a'.repeat(64)}`;

    expect(parseSearchInput(txid, 'BSC')).toEqual({ kind: 'tx', chain: 'BSC', txid });
  });

  it.each(['', '   \n\t'])('returns null for empty input %j', (input) => {
    expect(parseSearchInput(input, 'ETH')).toBeNull();
  });
});

describe('provider explorer links', () => {
  it('uses the Ethereum Blockscout explorer for transactions', () => {
    expect(getExplorerUrl('ETH', 'tx', '0xabc')).toBe('https://eth.blockscout.com/tx/0xabc');
  });
  it('uses TronScan hash routes and its transaction path', () => {
    expect(getExplorerUrl('TRON', 'tx', 'abc')).toBe('https://tronscan.org/#/transaction/abc');
    expect(getExplorerUrl('TRON', 'address', 'TExample')).toBe('https://tronscan.org/#/address/TExample');
  });
  it('does not create a link to an unknown chain', () => {
    expect(getExplorerUrl('unknown', 'address', 'x')).toBeUndefined();
  });
});
