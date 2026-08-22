import { defineConfig, loadEnv, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { oklinkMockPlugin } from './mock/oklinkMock';

/**
 * 部分网络环境下访问 www.oklink.com 必须走系统代理（HTTP_PROXY / HTTPS_PROXY）。
 * Vite 内置代理不会读取这些环境变量，这里显式接入；未配置代理环境变量时直连。
 */
function upstreamProxyAgent(): ProxyOptions['agent'] | undefined {
  const upstream =
    process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  return upstream ? (new HttpsProxyAgent(upstream) as unknown as ProxyOptions['agent']) : undefined;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const useMock = env.OKLINK_MOCK === '1';
  const agent = upstreamProxyAgent();

  return {
    plugins: [react(), ...(useMock ? [oklinkMockPlugin()] : [])],
    server: {
      port: 5173,
      proxy:
        useMock
          ? undefined
          : {
              // 浏览器统一请求 /okapi/explorer/...，由 dev server 转发到 OKLink 网页端数据接口。
              // 网页端接口无需 API Key（x-apiKey 由前端按页面端算法动态生成），代理只用于规避跨域。
              '/okapi': {
                target: 'https://www.oklink.com',
                changeOrigin: true,
                rewrite: (p) => p.replace(/^\/okapi/, '/api'),
                headers: {
                  // 补充网页端常见的来源信息，降低被风控拦截的概率
                  Origin: 'https://www.oklink.com',
                  Referer: 'https://www.oklink.com/',
                },
                ...(agent ? { agent } : {}),
              },
              // TronScan（波场官方浏览器页面端接口）：TRON 的普通/代币转账列表数据源
              '/tronscan': {
                target: 'https://apilist.tronscanapi.com',
                changeOrigin: true,
                rewrite: (p) => p.replace(/^\/tronscan/, ''),
                ...(agent ? { agent } : {}),
              },
              // OKLink 站点页本身：用于抓取地址页 SSR HTML 中的交易所实体标签
              '/oksite': {
                target: 'https://www.oklink.com',
                changeOrigin: true,
                rewrite: (p) => p.replace(/^\/oksite/, ''),
                headers: { Accept: 'text/html' },
                ...(agent ? { agent } : {}),
              },
            },
    },
    define: {
      __OKLINK_MOCK__: JSON.stringify(useMock),
    },
  };
});

