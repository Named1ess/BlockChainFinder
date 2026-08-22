import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, InputNumber, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlayCircleOutlined, ScissorOutlined, ClearOutlined, ThunderboltFilled } from '@ant-design/icons';
import { DEFAULT_HUNT_OPTIONS, type HuntHit } from '../trace/exchangeHunt';
import { useExchangeHunt } from '../trace/useExchangeHunt';
import { exchangeTagColor } from '../utils/exchangeTag';
import { shortAddress } from '../utils/format';

const { Text, Paragraph } = Typography;

interface Props {
  chain: string;
  address: string;
}

/**
 * 盒武器搜索面板：
 * 逐层递增深度扫描资金对手方，直到发现带交易所标签的钱包；
 * 命中后仍会把该层全部钱包检查完才结束，深度指标 = 命中的交易所钱包个数。
 */
export default function ExchangeHuntPanel({ chain, address }: Props) {
  const { engine, snapshot } = useExchangeHunt();
  const queryClient = useQueryClient();
  const [maxWallets, setMaxWallets] = useState(DEFAULT_HUNT_OPTIONS.maxWallets);
  const [maxNeighbors, setMaxNeighbors] = useState(DEFAULT_HUNT_OPTIONS.maxNeighbors);

  // 切换地址时清空上一次结果
  const handleStart = () => {
    engine.reset();
    void engine.start(chain, address, { maxWallets, maxNeighbors });
  };

  const hits = snapshot.hits;
  const hitLayerDone = snapshot.finished || (!snapshot.running && snapshot.hitDepth !== null);

  const columns: ColumnsType<HuntHit> = [
    {
      title: '交易所标签',
      width: 240,
      render: (_, h) => (
        <span>
          <ThunderboltFilled style={{ color: '#faad14', marginRight: 6 }} />
          <Tag color={exchangeTagColor(h.label)} style={{ marginRight: 0 }}>
            {h.label}
          </Tag>
        </span>
      ),
    },
    {
      title: '命中钱包',
      render: (_, h) => (
        <Link to={`/address/${chain}/${h.address}`} title={h.address}>
          <Text code className="mono" style={{ fontSize: 12 }}>{shortAddress(h.address, 10, 8)}</Text>
        </Link>
      ),
    },
    { title: '跳数', width: 70, align: 'right', render: (_, h) => h.depth },
    {
      title: '资金路径（种子 → 交易所）',
      render: (_, h) => (
        <Space size={4} wrap>
          {h.path.map((addr, i) => (
            <span key={`${addr}-${i}`}>
              {i > 0 && <Text type="secondary"> → </Text>}
              <Link
                to={`/address/${chain}/${addr}`}
                title={addr}
                style={{ fontWeight: i === 0 || i === h.path.length - 1 ? 600 : 400 }}
              >
                {shortAddress(addr, i === 0 || i === h.path.length - 1 ? 8 : 6, i === 0 || i === h.path.length - 1 ? 6 : 4)}
              </Link>
            </span>
          ))}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Paragraph type="secondary" style={{ marginBottom: 12 }}>
        从当前地址出发逐层加深扫描对手方钱包并逐一检查交易所标签，<b>跳数不设上限</b>——
        一路找到带交易所标签的钱包为止；一旦某层发现交易所钱包，会把<b>该层全部钱包</b>检查完才停止。
        仅当全部对手方搜索完毕（或触达钱包上限）仍未发现时才结束。深度指标 = 命中的交易所钱包个数。
      </Paragraph>

      <Space wrap size={16} style={{ marginBottom: 12 }} align="center">
        <Space size={6}>
          <Text type="secondary">钱包上限</Text>
          <InputNumber min={10} max={2000} step={10} value={maxWallets} onChange={(v) => setMaxWallets(v ?? 120)} disabled={snapshot.running} />
        </Space>
        <Space size={6}>
          <Text type="secondary">每层邻居上限</Text>
          <InputNumber min={1} max={30} value={maxNeighbors} onChange={(v) => setMaxNeighbors(v ?? 10)} disabled={snapshot.running} />
        </Space>

        {snapshot.running ? (
          <Button danger icon={<ScissorOutlined />} onClick={() => engine.stop()}>
            停止
          </Button>
        ) : (
          <Button type="primary" icon={<PlayCircleOutlined />} onClick={handleStart}>
            开始盒武器搜索
          </Button>
        )}
        {!snapshot.running && (hits.length > 0 || snapshot.scanned > 0) && (
          <Button icon={<ClearOutlined />} onClick={() => { engine.reset(); queryClient.removeQueries({ queryKey: ['entity-tag'] }); }}>
            清空
          </Button>
        )}
      </Space>

      <Card size="small" style={{ marginBottom: 12, background: '#fafafa' }}>
        <Space wrap size={24}>
          <StatisticInline label="当前跳数" value={snapshot.running || snapshot.depth > 0 ? `${snapshot.depth}` : '-'} />
          <StatisticInline label="已展开钱包" value={`${snapshot.scanned}`} />
          <StatisticInline label="已查标签" value={`${snapshot.tagChecked}`} />
          <StatisticInline label="队列剩余" value={`${snapshot.pending}`} />
          <StatisticInline
            label="命中交易所"
            value={
              <Text strong type={hits.length > 0 ? 'success' : undefined} style={{ fontSize: 18 }}>
                {hits.length}
              </Text>
            }
          />
        </Space>
      </Card>

      {snapshot.running && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={`正在第 ${snapshot.depth} 跳扫描中：已展开 ${snapshot.scanned} 个钱包、检查 ${snapshot.tagChecked} 个标签${
            hits.length > 0 ? `，本层已确认 ${hits.length} 个交易所钱包（整层查完后结束）` : ''
          }`}
        />
      )}
      {!snapshot.running && snapshot.error && (
        <Alert
          type={hitLayerDone ? 'success' : 'warning'}
          showIcon
          style={{ marginBottom: 12 }}
          message={hitLayerDone ? `搜索完成：第 ${snapshot.hitDepth} 跳命中 ${hits.length} 个交易所钱包` : '搜索结束'}
          description={snapshot.error}
        />
      )}

      <Table
        rowKey={(h) => `${h.address}`}
        columns={columns}
        dataSource={hits}
        loading={snapshot.running && hits.length === 0}
        size="small"
        locale={{
          emptyText: snapshot.running ? '正在扫描，命中后会实时显示…' : '尚未开始或未发现交易所钱包',
        }}
        pagination={false}
      />

      {!snapshot.running && snapshot.tagChecked > 0 && hits.length === 0 && !snapshot.error && (
        <Alert type="info" showIcon style={{ marginTop: 12 }} message={`已检查 ${snapshot.tagChecked} 个钱包，均无交易所标签。`} />
      )}
    </div>
  );
}

function StatisticInline({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>{label}</Text>
      <Text strong style={{ fontSize: 18 }}>{value}</Text>
    </div>
  );
}
