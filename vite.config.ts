import { defineConfig, loadEnv, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { providerMockPlugin } from './mock/providerMock';
import { oklinkWebPlugin } from './server/oklinkWeb';

function upstreamProxyAgent(): ProxyOptions['agent'] | undefined {
  const upstream = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  return upstream ? (new HttpsProxyAgent(upstream) as unknown as ProxyOptions['agent']) : undefined;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const useMock = env.APP_MOCK === '1';
  const agent = upstreamProxyAgent();
  const tronScanKey = env.TRONSCAN_API_KEY?.trim();
  const tronGridKey = env.TRONGRID_API_KEY?.trim();
  // Keys stay in the Node proxy, never in VITE_* or frontend define values.
  const proxy: Record<string, ProxyOptions> = {
    '/blockscout/ETH': {
      target: 'https://eth.blockscout.com', changeOrigin: true,
      rewrite: p => p.replace(/^\/blockscout\/ETH/, ''),
      ...(agent ? { agent } : {}),
    },
    '/blockscout/POLYGON': {
      target: 'https://polygon.blockscout.com', changeOrigin: true,
      rewrite: p => p.replace(/^\/blockscout\/POLYGON/, ''),
      ...(agent ? { agent } : {}),
    },
    '/tronscan': {
      target: 'https://apilist.tronscanapi.com', changeOrigin: true,
      rewrite: p => p.replace(/^\/tronscan/, ''),
      ...(tronScanKey ? { headers: { 'TRON-PRO-API-KEY': tronScanKey } } : {}),
      ...(agent ? { agent } : {}),
    },
    '/trongrid': {
      target: 'https://api.trongrid.io', changeOrigin: true,
      rewrite: p => p.replace(/^\/trongrid/, ''),
      ...(tronGridKey ? { headers: { 'TRON-PRO-API-KEY': tronGridKey } } : {}),
      ...(agent ? { agent } : {}),
    },
  };
  return {
    plugins: [react(), ...(useMock ? [providerMockPlugin()] : [oklinkWebPlugin(env.OKLINK_BROWSER_CHANNEL)])],
    server: { port: 5173, proxy: useMock ? undefined : proxy },
    preview: { proxy: useMock ? undefined : proxy },
    define: { __APP_MOCK__: JSON.stringify(useMock) },
  };
});
