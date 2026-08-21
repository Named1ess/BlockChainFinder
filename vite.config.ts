import { defineConfig, loadEnv, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { oklinkMockPlugin } from './mock/oklinkMock';

/**
 * 部分网络环境下访问 www.oklink.com 必须走系统代理（HTTP_PROXY / HTTPS_PROXY）。
 * Vite 内置代理不会读取这些环境变量，这里显式接入；未配置代理环境变量时直连。
 */
function oklinkProxyOptions(): ProxyOptions {
  const upstream =
    process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  return {
    target: 'https://www.oklink.com',
    changeOrigin: true,
    rewrite: (p) => p.replace(/^\/okapi/, '/api'),
    headers: {
      // 补充网页端常见的来源信息，降低被风控拦截的概率
      Origin: 'https://www.oklink.com',
      Referer: 'https://www.oklink.com/',
    },
    ...(upstream ? { agent: new HttpsProxyAgent(upstream) as unknown as ProxyOptions['agent'] } : {}),
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const useMock = env.OKLINK_MOCK === '1';

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
              '/okapi': oklinkProxyOptions(),
            },
    },
    define: {
      __OKLINK_MOCK__: JSON.stringify(useMock),
    },
  };
});

