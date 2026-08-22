import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Skeleton, Space, Statistic, Tag, Tabs, Typography } from 'antd';
import { CopyOutlined, LinkOutlined } from '@ant-design/icons';
import { fetchAddressAsset } from '../api/oklink/endpoints';
import { fetchAddressEntityLabel } from '../api/oklink/entity';
import { getChain } from '../api/oklink/chains';
import { copyText, formatAmount, formatTime, formatUsd } from '../utils/format';
import { useTraceEngine } from '../trace/useTraceEngine';
import TxTable from '../components/TxTable';
import TokenHoldingsTable from '../components/TokenHoldingsTable';
import FlowGraph from '../components/graph/FlowGraph';
import { App } from 'antd';

const { Text } = Typography;

/** 按交易所名称给标签配色，便于一眼区分 Gate / OKX / Binance 等 */
function exchangeTagColor(label: string): string {
  const l = label.toLowerCase();
  if (l.includes('binance') || l.includes('bnb')) return 'gold';
  if (l.includes('okx') || l.includes('okb')) return 'black';
  if (l.includes('gate')) return 'volcano';
  if (l.includes('bybit')) return 'purple';
  if (l.includes('bitget')) return 'cyan';
  if (l.includes('upbit')) return 'blue';
  if (l.includes('bithumb')) return 'red';
  if (l.includes('kucoin') || l.includes('kucoin')) return 'green';
  if (l.includes('mexc')) return 'magenta';
  if (l.includes('huobi') || l.includes('htx')) return 'orange';
  return 'geekblue';
}

export default function AddressPage() {
  const { chain = 'ETH', address = '' } = useParams();
  const chainInfo = getChain(chain);
  const { engine } = useTraceEngine();
  const { message } = App.useApp();

  // 路由变化时清空上一条溯源结果
  useEffect(() => {
    engine.reset();
  }, [engine, chain, address]);

  const assetQuery = useQuery({
    queryKey: ['asset', chain, address],
    queryFn: () => fetchAddressAsset(chain, address),
  });

  // 交易所实体标签（SSR 抓取）：如「Binance. DepositAndWithdraw_10」「Gate.io. Hot wallet」
  const tagQuery = useQuery({
    queryKey: ['entity-tag', chain, address],
    queryFn: () => fetchAddressEntityLabel(chain, address),
    staleTime: 30 * 60 * 1000,
  });

  const asset = assetQuery.data;
  const entityTag = tagQuery.data ?? null;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card>
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Space wrap>
            <Text strong>地址</Text>
            <Text code className="mono" style={{ fontSize: 14 }}>
              {address}
            </Text>
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={async () => {
                await copyText(address);
                message.success('已复制');
              }}
            />
            {entityTag && (
              <Tag color={exchangeTagColor(entityTag)} style={{ fontSize: 13 }}>
                🏷 {entityTag}
              </Tag>
            )}
            {chainInfo && (
              <Button
                size="small"
                icon={<LinkOutlined />}
                href={`${chainInfo.explorerBase}/address/${address}`}
                target="_blank"
              >
                在 OKLink 查看
              </Button>
            )}
          </Space>

          {assetQuery.isPending && <Skeleton.Input active style={{ width: 480 }} />}
          {assetQuery.isError && (
            <Alert
              type="error"
              showIcon
              message="资产信息加载失败"
              description={String(assetQuery.error)}
            />
          )}
          {asset && (
            <Space size={48} wrap>
              <Statistic title="总价值 (USD)" value={formatUsd(asset.totalTokenValue)} />
              <Statistic
                title={`原生币余额${asset.balanceSymbol ? ` (${asset.balanceSymbol})` : ''}`}
                value={formatAmount(asset.balance)}
              />
              <Statistic title="交易笔数" value={formatAmount(asset.transactionCount, 0)} />
              <Statistic title="最近交易" value={formatTime(asset.lastTransactionTime)} />
            </Space>
          )}
        </Space>
      </Card>

      <Card variant="borderless">
        <Tabs
          defaultActiveKey="trace"
          items={[
            { key: 'trace', label: '资金溯源', children: <FlowGraph chain={chain} address={address} /> },
            { key: 'txs', label: '交易记录', children: <TxTable chain={chain} address={address} /> },
            { key: 'tokens', label: '代币持仓', children: <TokenHoldingsTable chain={chain} address={address} /> },
          ]}
        />
      </Card>
    </Space>
  );
}
