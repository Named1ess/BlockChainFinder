import { chromium, type Browser, type Page } from 'playwright-core';
import { z } from 'zod';
import type { Connect, Plugin } from 'vite';

const SITE = 'https://www.oklink.com';
const HOME = `${SITE}/zh-hans/`;
const SLUGS: Record<string, string> = { ETH: 'ethereum', BSC: 'bsc', POLYGON: 'polygon', TRON: 'tron' };
export interface EntityRequest { chain: string; address: string }

export class OklinkWebError extends Error {
  constructor(public code: number | string, message: string) { super(message); }
}

export function parseEntityRequest(url: URL): EntityRequest {
  const chain = url.searchParams.get('chain') ?? '';
  const address = url.searchParams.get('address') ?? '';
  const pattern = chain === 'TRON' ? /^T[1-9A-HJ-NP-Za-km-z]{33}$/ : /^0x[a-fA-F0-9]{40}$/;
  if (!Object.prototype.hasOwnProperty.call(SLUGS, chain) || !pattern.test(address)) {
    throw new OklinkWebError(400, '不支持的链或无效地址。');
  }
  return { chain, address };
}

const searchSchema = z.object({
  code: z.union([z.literal(0), z.literal('0')]),
  data: z.object({ addressVoList: z.array(z.object({
    blockChain: z.string(), address: z.string(),
    newAddressTagsVo: z.object({ entityTags: z.array(z.string()).optional() }).nullish(),
  }).passthrough()) }),
});

export function findSearchEntry(body: unknown, request: EntityRequest) {
  if (body && typeof body === 'object' && 'code' in body && (body.code === 401 || body.code === 403)) {
    throw new OklinkWebError(body.code, 'OKLink 未接受当前网页会话，请稍后重试。');
  }
  const result = searchSchema.safeParse(body);
  if (!result.success) throw new OklinkWebError('RESPONSE', 'OKLink 搜索返回了无法识别的数据。');
  const normalize = (value: string) => request.chain === 'TRON' ? value : value.toLowerCase();
  return result.data.data.addressVoList.find(row => row.blockChain === request.chain && normalize(row.address) === normalize(request.address)) ?? null;
}

/** One browser input is shared: serialize distinct searches and merge identical ones. */
export function createEntityLookup(run: (request: EntityRequest) => Promise<string | null>) {
  let tail: Promise<unknown> = Promise.resolve();
  const pending = new Map<string, Promise<string | null>>();
  const cache = new Map<string, { label: string | null; expires: number }>();
  return (request: EntityRequest): Promise<string | null> => {
    const key = `${request.chain}:${request.chain === 'TRON' ? request.address : request.address.toLowerCase()}`;
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached.label);
    const existing = pending.get(key);
    if (existing) return existing;
    if (pending.size >= 8) return Promise.reject(new OklinkWebError(503, 'OKLink 查询队列已满，请稍后重试。'));
    const queuedAt = Date.now();
    const job = tail.then(async () => {
      if (Date.now() - queuedAt > 15_000) throw new OklinkWebError(503, 'OKLink 查询排队超时，请稍后重试。');
      const label = await run(request);
      if (cache.size >= 300) cache.delete(cache.keys().next().value!);
      cache.set(key, { label, expires: Date.now() + 10 * 60_000 });
      return label;
    }).finally(() => { pending.delete(key); });
    pending.set(key, job);
    tail = job.catch(() => undefined);
    return job;
  };
}

export class OklinkBrowser {
  private browser?: Browser;
  private page?: Page;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private searched = false;
  constructor(private channel = 'chrome') {}

  async close() {
    clearTimeout(this.idleTimer);
    const browser = this.browser;
    this.page = undefined;
    this.browser = undefined;
    this.searched = false;
    await browser?.close().catch(() => undefined);
  }

  async dispose() {
    this.disposed = true;
    await this.close();
  }

  private async ready(): Promise<Page> {
    if (this.disposed) throw new OklinkWebError(503, '本地查询服务已停止。');
    if (this.page && !this.page.isClosed() && this.browser?.isConnected()) return this.page;
    let launched: Browser;
    try {
      launched = await chromium.launch({ channel: this.channel, headless: true, timeout: 10_000 });
    } catch {
      throw new OklinkWebError('BROWSER', '无法启动浏览器。请安装 Chrome，或配置 OKLINK_BROWSER_CHANNEL=msedge 使用 Edge。');
    }
    if (this.disposed) {
      await launched.close();
      throw new OklinkWebError(503, '本地查询服务已停止。');
    }
    this.browser = launched;
    this.page = await this.browser.newPage({ locale: 'zh-CN' });
    this.page.setDefaultTimeout(10_000);
    // The official page initializes its own session. Searching before this finishes
    // reproduces "device risk check failed" even in a fresh, ordinary browser.
    // No saved user profile, copied tokens, injected signing code or request replay.
    const initialized = this.page.waitForResponse(response =>
      response.url().startsWith(`${SITE}/priapi/v1/dis/did`) && response.status() === 200,
    { timeout: 25_000 });
    await Promise.all([
      initialized,
      this.page.goto(HOME, { waitUntil: 'load', timeout: 25_000 }),
    ]);
    return this.page;
  }

  async search(request: EntityRequest): Promise<string | null> {
    clearTimeout(this.idleTimer);
    try {
      const page = await this.ready();
      // A fresh search component avoids the website's in-memory suggestion cache:
      // repeated text (including a different chain) otherwise emits no HTTP event.
      // Reuse the initialized browser session, but reload the normal homepage.
      if (this.searched) await page.goto(HOME, { waitUntil: 'load', timeout: 10_000 });
      this.searched = true;
      const input = page.locator('input[placeholder="搜索地址 / 交易 / 区块 / 代币"]');
      await input.fill('');
      const reply = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.origin === SITE && url.pathname === '/api/explorer/v1/search/aggregate'
          && url.searchParams.get('searchContent') === request.address;
      }, { timeout: 12_000 });
      const [, response] = await Promise.all([input.fill(request.address), reply]);
      if (!response.ok()) throw new OklinkWebError(response.status(), `OKLink 网页搜索返回 HTTP ${response.status()}，请稍后重试。`);
      const entry = findSearchEntry(await response.json(), request);
      if (!entry?.newAddressTagsVo?.entityTags?.length) return null;
      // Labels in the response are encoded. Read the official UI's rendered label,
      // scoped to the exact chain/address link, never another address's tag.
      const row = page.locator(`a[href="/zh-hans/${SLUGS[request.chain]}/address/${entry.address}"]`).first();
      const tags = row.locator('[class*="tagText-"]');
      await tags.first().waitFor({ state: 'visible', timeout: 8_000 });
      const labels = (await tags.allTextContents()).map(value => value.trim()).filter(Boolean);
      if (!labels.length || labels.some(label => label.length > 500)) throw new OklinkWebError('RESPONSE', 'OKLink 标签未能正常显示。');
      return [...new Set(labels)].join(' · ');
    } catch (error) {
      await this.close();
      if (error instanceof OklinkWebError) throw error;
      throw new OklinkWebError('BROWSER_QUERY', 'OKLink 网页查询未完成，请稍后重试；若官网需要人工验证，请先在官网完成查询。');
    } finally {
      if (this.browser) {
        this.idleTimer = setTimeout(() => { void this.close(); }, 5 * 60_000);
        this.idleTimer.unref();
      }
    }
  }
}

export function oklinkWebPlugin(channel?: string): Plugin {
  const browser = new OklinkBrowser(channel);
  const lookup = createEntityLookup(request => browser.search(request));
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/oklink-web/')) return next();
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(body));
    };
    // This helper is for the local app, not a public browser proxy.
    const remote = req.socket.remoteAddress;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? '') || req.headers['sec-fetch-site'] === 'cross-site') {
      return send(403, { error: { code: 403, message: 'OKLink 网页查询仅供本地应用使用。' } });
    }
    if (req.method !== 'GET') return send(405, { error: { code: 405, message: '仅支持 GET。' } });
    if (url.pathname !== '/oklink-web/entity') return send(404, { error: { code: 404, message: '未知接口。' } });
    let request: EntityRequest;
    try { request = parseEntityRequest(url); }
    catch { return send(400, { error: { code: 400, message: '不支持的链或无效地址。' } }); }
    void lookup(request).then(label => {
      send(200, { ...request, source: 'OKLink', label });
    }).catch((error: OklinkWebError) => {
      send(typeof error.code === 'number' ? error.code : 502, { error: { code: error.code, message: error.message } });
    });
  };
  return {
    name: 'oklink-web-entity',
    configureServer(server) {
      server.middlewares.use(middleware);
      server.httpServer?.once('close', () => { void browser.dispose(); });
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
      server.httpServer.once('close', () => { void browser.dispose(); });
    },
  };
}
