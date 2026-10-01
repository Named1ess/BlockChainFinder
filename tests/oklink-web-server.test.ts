import { afterEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import { findSearchEntry, parseEntityRequest, createEntityLookup, OklinkWebError, OklinkBrowser } from '../server/oklinkWeb';

const address = '0xFBb1b73C4f0BDa4f67dcA266ce6Ef42f520fBB98';
const request = { chain: 'ETH', address };
const envelope = (rows: unknown[]) => ({ code: 0, data: { addressVoList: rows } });
afterEach(() => vi.restoreAllMocks());

describe('OKLink normal browser search', () => {
  it('validates inputs before opening a browser; rejects arbitrary destinations', () => {
    expect(parseEntityRequest(new URL(`http://localhost/oklink-web/entity?chain=ETH&address=${address}`))).toEqual(request);
    for (const qs of ['chain=ETH&address=https://internal/', 'chain=BTC&address=123', 'chain=TRON&address='+address]) {
      expect(() => parseEntityRequest(new URL('http://localhost/oklink-web/entity?'+qs))).toThrow();
    }
  });
  it('matches both chain and address, preserving TRON case', () => {
    const eth = { blockChain: 'ETH', address: address.toLowerCase(), newAddressTagsVo: { entityTags: ['encrypted'] } };
    expect(findSearchEntry(envelope([{...eth,blockChain:'BSC'},eth]), request)).toEqual(eth);
    expect(findSearchEntry(envelope([{...eth,blockChain:'BSC'}]),request)).toBeNull();
    const tron = {chain:'TRON',address:'TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb'};
    expect(findSearchEntry(envelope([{blockChain:'TRON',address:tron.address.toLowerCase()}]),tron)).toBeNull();
  });
  it.each([{code:403,msg:'device risk check failed'}, {code:0,data:{}}, '<html>challenge</html>', {code:0,data:{addressVoList:[{}]}}])('does not turn rejection or invalid responses into no label', body => {
    expect(() => findSearchEntry(body,request)).toThrow(OklinkWebError);
  });
  it('coalesces same-address requests and caches only confirmed results', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release=resolve; });
    const run = vi.fn(async () => { await gate; return 'Exchange: Bittrex Global'; });
    const lookup = createEntityLookup(run);
    const first = lookup(request);
    const same = lookup({...request,address:address.toLowerCase()});
    release();
    expect(await first).toBe('Exchange: Bittrex Global');
    expect(await same).toBe('Exchange: Bittrex Global');
    await lookup(request);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('serializes browser operations and allows recovery after a rejected lookup', async () => {
    let active=0;
    let peak=0;
    const run=vi.fn(async () => {
      active++; peak=Math.max(peak,active);
      await Promise.resolve(); active--;
      if(run.mock.calls.length===1) throw new OklinkWebError(403,'rejected');
      return null;
    });
    const lookup=createEntityLookup(run);
    await expect(lookup(request)).rejects.toMatchObject({code:403});
    await Promise.all([lookup(request),lookup({...request,chain:'BSC'})]);
    expect(peak).toBe(1);
    expect(run).toHaveBeenCalledTimes(3);
  });
  it('does not start queued browser work after service shutdown', async () => {
    const launch=vi.spyOn(chromium,'launch');
    const browser=new OklinkBrowser();
    await browser.dispose();
    await expect(browser.search(request)).rejects.toMatchObject({code:503});
    expect(launch).not.toHaveBeenCalled();
  });
  it('closes a browser whose pending launch finishes after service shutdown', async () => {
    let release!: (browser: Browser) => void;
    vi.spyOn(chromium,'launch').mockImplementation(() => new Promise(resolve => { release=resolve; }));
    const browser=new OklinkBrowser();
    const pending=expect(browser.search(request)).rejects.toMatchObject({code:503});
    await browser.dispose();
    const close=vi.fn().mockResolvedValue(undefined);
    release({close} as unknown as Browser);
    await pending;
    expect(close).toHaveBeenCalledTimes(1);
  });
});
