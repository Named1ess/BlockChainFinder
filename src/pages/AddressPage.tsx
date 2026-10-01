import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Skeleton, Space, Statistic, Tag, Tabs, Typography } from 'antd';
import { CopyOutlined, LinkOutlined } from '@ant-design/icons';
import { fetchAddressAsset } from '../api/oklink/endpoints';
import { fetchAddressEntityLabel, getEntityLabelSource } from '../api/oklink/entity';
import { getChain, getExplorerUrl } from '../api/oklink/chains';
import { copyText, formatAmount, formatTime, formatUsd } from '../utils/format';
import { exchangeTagColor } from '../utils/exchangeTag';
import { useTraceEngine } from '../trace/useTraceEngine';
import TxTable from '../components/TxTable';
import TokenHoldingsTable from '../components/TokenHoldingsTable';
import ExchangeHuntPanel from '../components/ExchangeHuntPanel';
import FlowGraph from '../components/graph/FlowGraph';
import { App } from 'antd';

const { Text } = Typography;

export default function AddressPage() {
  const { chain = 'ETH', address = '' } = useParams();
  const chainInfo = getChain(chain);
  const chainSupported = Boolean(chainInfo?.dataSource) && (!__APP_MOCK__ || chain === 'ETH' || chain === 'POLYGON');
  const { engine } = useTraceEngine();
  const { message } = App.useApp();

  // 路由变化时清空上一条溯源结果
  useEffect(() => {
    engine.reset();
  }, [engine, chain, address]);

  const assetQuery = useQuery({
    queryKey: ['asset', chain, address],
    queryFn: () => fetchAddressAsset(chain, address),
    enabled: chainSupported,
  });

  // 公开地址标签覆盖有限；未返回标签不代表地址不属于交易所。
  const tagQuery = useQuery({
    queryKey: ['entity-tag', getEntityLabelSource(chain), chain, address],
    queryFn: () => fetchAddressEntityLabel(chain, address),
    staleTime: 30 * 60 * 1000,
    enabled: chainSupported,
  });

  const asset = chainSupported ? assetQuery.data : undefined;
  const entityTag = chainSupported ? tagQuery.data ?? null : null;

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
                href={getExplorerUrl(chain, 'address', address)}
                target="_blank"
              >
                在 {chainInfo.explorerName} 查看
              </Button>
            )}
          </Space>

          {!chainSupported && (
            <Alert
              type="warning"
              showIcon
              message={__APP_MOCK__ ? '离线演示目前仅支持 Ethereum / Polygon' : `${chainInfo?.name ?? chain} 暂未接入可用的数据源`}
              description={chainInfo
                ? '暂不支持应用内地址查询与资金溯源，可通过上方区块浏览器查看链上信息。'
                : '请在搜索框中选择已接入的链。'}
            />
          )}
          {chainSupported && (
            <Text type="secondary">标签来源：{getEntityLabelSource(chain)}{tagQuery.isFetching ? ' · 查询中…' : ''}。公开标签覆盖有限；未查询到标签不代表该地址不属于交易所。</Text>
          )}
          {chainSupported && tagQuery.isError && (
            <Alert
              type="warning"
              showIcon
              message="地址标签查询失败，暂时无法判断交易所归属"
              description={String(tagQuery.error)}
              action={(
                <Button size="small" loading={tagQuery.isFetching} onClick={() => { void tagQuery.refetch(); }}>
                  重试
                </Button>
              )}
            />
          )}
          {chainSupported && assetQuery.isPending && <Skeleton.Input active style={{ width: 480 }} />}
          {chainSupported && assetQuery.isError && (
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
          {asset?.dataSource && (
            <Text type="secondary">数据来源：{asset.dataSource}</Text>
          )}
          {!!asset?.warnings?.length && (
            <Alert type="warning" showIcon message="地址信息不完整" description={asset.warnings.join('；')} />
          )}
        </Space>
      </Card>

      {chainSupported && (
        <Card variant="borderless">
          <Tabs
            defaultActiveKey="trace"
            items={[
              { key: 'trace', label: '资金溯源', children: <FlowGraph chain={chain} address={address} /> },
              { key: 'hunt', label: '盒武器搜索', children: <ExchangeHuntPanel chain={chain} address={address} /> },
              { key: 'txs', label: '交易记录', children: <TxTable chain={chain} address={address} /> },
              { key: 'tokens', label: '代币持仓', children: <TokenHoldingsTable chain={chain} address={address} /> },
            ]}
          />
        </Card>
      )}
    </Space>
  );
}
