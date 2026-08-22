import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, InputNumber, Select, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlayCircleOutlined, ScissorOutlined, ClearOutlined, ThunderboltFilled } from '@ant-design/icons';
import { DEFAULT_HUNT_OPTIONS } from '../trace/exchangeHunt';
import { useExchangeHunt } from '../trace/useExchangeHunt';
import { exchangeTagColor } from '../utils/exchangeTag';
import { shortAddress } from '../utils/format';
import { getChain } from '../api/oklink/chains';
import {
  deleteHuntRunData,
  getHuntRun,
  getStorageEstimate,
  listHuntHitPage,
  listHuntRuns,
  type HuntRunRow,
  type HuntWalletRow,
} from '../api/db/huntStore';

const { Text, Paragraph } = Typography;

interface Props {
  chain: string;
  address: string;
}

const PAGE_SIZE = 10;

const STATUS_TEXT: Record<HuntRunRow['status'], string> = {
  running: '运行中',
  'hit-target': '已达标',
  stopped: '手动停止',
  exhausted: '全部搜完',
  'wallet-cap': '触达钱包上限',
  'seed-is-exchange': '种子即交易所',
};

/**
 * 盒武器搜索面板：
 * 搜索过程流式写入 IndexedDB，界面按页查询命中结果，支持回看历史搜索。
 */
export default function ExchangeHuntPanel({ chain, address }: Props) {
  const { engine, snapshot } = useExchangeHunt();
  const queryClient = useQueryClient();
  const [maxWallets, setMaxWallets] = useState(DEFAULT_HUNT_OPTIONS.maxWallets);
  const [maxNeighbors, setMaxNeighbors] = useState(DEFAULT_HUNT_OPTIONS.maxNeighbors);
  const [hitLimit, setHitLimit] = useState(DEFAULT_HUNT_OPTIONS.hitLimit);
  const [tokenFilter, setTokenFilter] = useState<string[]>([]);
  /** 正在查看的历史 run；null = 当前运行 */
  const [viewRunId, setContentViewRunId] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  // 切链后清空币种过滤（不同链的币种体系不同）
  useEffect(() => {
    setTokenFilter([]);
    setPage(0);
  }, [chain]);

  const chainInfo = getChain(chain);

  const handleStart = () => {
    engine.reset();
    setContentViewRunId(null);
    setPage(0);
    void engine.start(chain, address, { maxWallets, maxNeighbors, hitLimit, tokenFilter });
  };

  const activeRunId = viewRunId ?? snapshot.runId;

  // 历史列表：运行状态切换时刷新
  const runsQuery = useQuery({
    queryKey: ['hunt-runs', snapshot.runId, snapshot.running],
    queryFn: () => listHuntRuns(30),
  });

  // 本地存储占用（跨搜索累积，供用户感知与清理）
  const storageQuery = useQuery({
    queryKey: ['hunt-storage', snapshot.runId, snapshot.running, viewRunId],
    queryFn: () => getStorageEstimate(),
    staleTime: 30_000,
  });

  // 当前查看的 run 元信息（历史时用于展示统计）
  const runRowQuery = useQuery({
    queryKey: ['hunt-run-row', activeRunId],
    queryFn: () => (activeRunId ? getHuntRun(activeRunId) : Promise.resolve(undefined)),
    enabled: !!activeRunId,
  });

  // 命中结果分页：数据版本变化（流式写入）自动刷新
  const hitsQuery = useQuery({
    queryKey: ['hunt-hits', activeRunId, page, PAGE_SIZE, viewRunId ? 'static' : snapshot.version],
    queryFn: () => listHuntHitPage(activeRunId!, page * PAGE_SIZE, PAGE_SIZE),
    enabled: !!activeRunId,
    placeholderData: (prev) => prev,
    staleTime: 200,
  });

  const rows: HuntWalletRow[] = hitsQuery.data?.rows ?? [];
  const total = hitsQuery.data?.total ?? 0;
  const statsSource: Pick<
    HuntRunRow,
    'scanned' | 'tagChecked' | 'depth' | 'hitCount' | 'firstHitDepth' | 'status'
  > =
    viewRunId && runRowQuery.data
      ? runRowQuery.data
      : {
          scanned: snapshot.scanned,
          tagChecked: snapshot.tagChecked,
          depth: snapshot.depth,
          hitCount: snapshot.hitCount,
          firstHitDepth: snapshot.firstHitDepth,
          status: snapshot.running ? 'running' : snapshot.finished ? 'hit-target' : 'stopped',
        };
  const hitLimitShown = viewRunId ? runRowQuery.data?.hitLimit ?? 0 : hitLimit;

  const columns: ColumnsType<HuntWalletRow> = [
    {
      title: '交易所标签',
      width: 260,
      render: (_, h) => (
        <span>
          <ThunderboltFilled style={{ color: '#faad14', marginRight: 6 }} />
          <Tag color={exchangeTagColor(h.tag ?? '')} style={{ marginRight: 0 }}>
            {h.tag}
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
    { title: '跳数', width: 70, align: 'right', dataIndex: 'depth' },
    {
      title: '资金路径（种子 → 交易所）',
      render: (_, h) => (
        <Space size={4} wrap>
          {(h.path ?? []).map((addr, i) => {
            const end = i === 0 || i === (h.path?.length ?? 0) - 1;
            return (
              <span key={`${addr}-${i}`}>
                {i > 0 && <Text type="secondary"> → </Text>}
                <Link to={`/address/${chain}/${addr}`} title={addr} style={{ fontWeight: end ? 600 : 400 }}>
                  {shortAddress(addr, end ? 8 : 6, end ? 6 : 4)}
                </Link>
              </span>
            );
          })}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Paragraph type="secondary" style={{ marginBottom: 12 }}>
        从当前地址出发逐层加深扫描对手方钱包并逐一检查交易所标签，<b>跳数不设上限</b>——
        一路挖到命中目标个数为止；即使达标，也会把<b>当前层全部钱包</b>检查完才停止。
        未达目标时某层有命中会继续向更深挖掘。仅当全部对手方搜索完毕（或触达钱包上限）仍未达标才结束。
        深度指标 = 命中的交易所钱包个数。所有钱包与命中结果流式写入本地数据库（IndexedDB），可随时回看历史搜索。
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
        <Space size={6}>
          <Text type="secondary">命中上限</Text>
          <InputNumber min={0} max={500} value={hitLimit} onChange={(v) => setHitLimit(v ?? 0)} disabled={snapshot.running} />
          <Text type="secondary" style={{ fontSize: 12 }}>个（0 = 不限）</Text>
        </Space>
        <Space size={6}>
          <Text type="secondary">币种过滤</Text>
          <Select
            mode="tags"
            style={{ minWidth: 220 }}
            placeholder="输入符号后回车，可连续添加多个"
            value={tokenFilter}
            onChange={(v) => setTokenFilter(v.map((s) => s.trim().toUpperCase()).filter(Boolean))}
            options={(chainInfo?.commonTokens ?? [])
              .filter((t) => !tokenFilter.includes(t))
              .map((t) => ({ value: t, label: t }))}
            tokenSeparators={[',', ' ']}
            disabled={snapshot.running}
            maxTagCount={4}
            suffixIcon={null}
            open={undefined}
          />
        </Space>

        {snapshot.running ? (
          <Button danger icon={<ScissorOutlined />} onClick={() => engine.stop()}>
            停止
          </Button>
        ) : (
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            onClick={handleStart}
          >
            开始盒武器搜索
          </Button>
        )}
        {!snapshot.running && (total > 0 || statsSource.scanned > 0) && (
          <Button
            icon={<ClearOutlined />}
            onClick={() => {
              engine.reset();
              setContentViewRunId(null);
              setPage(0);
              queryClient.removeQueries({ queryKey: ['hunt-hits'] });
              queryClient.removeQueries({ queryKey: ['entity-tag'] });
            }}
          >
            清空
          </Button>
        )}

        {(runsQuery.data?.length ?? 0) > 0 && (
          <Select
            style={{ minWidth: 320 }}
            placeholder="回看历史搜索"
            value={viewRunId ?? (snapshot.runId ? '__current__' : undefined)}
            onChange={(v) => {
              setContentViewRunId(v === '__current__' ? null : v);
              setPage(0);
            }}
            options={[
              { value: '__current__', label: '当前搜索' },
              ...(runsQuery.data ?? [])
                .filter((r) => r.id !== snapshot.runId)
                .map((r) => ({
                  value: r.id,
                  label: `${r.chain} ${shortAddress(r.seed, 6, 4)} · ${new Date(r.startedAt).toLocaleString()} · ${
                    STATUS_TEXT[r.status]
                  } · 命中${r.hitCount}`,
                })),
            ]}
          />
        )}
      </Space>

      <Card size="small" style={{ marginBottom: 12, background: '#fafafa' }}>
        <Space wrap size={24}>
          <StatInline label="当前跳数" value={statsSource.depth > 0 || snapshot.running ? `${statsSource.depth}` : '-'} />
          <StatInline label="已展开钱包" value={`${statsSource.scanned}`} />
          <StatInline label="已查标签" value={`${statsSource.tagChecked}`} />
          <StatInline label="队列剩余" value={`${snapshot.running ? snapshot.pending : 0}`} />
          <StatInline
            label={hitLimitShown > 0 ? `命中交易所 / 目标 ${hitLimitShown}` : '命中交易所'}
            value={
              <Text strong type={statsSource.hitCount > 0 ? 'success' : undefined} style={{ fontSize: 18 }}>
                {hitLimitShown > 0 ? `${statsSource.hitCount} / ${hitLimitShown}` : statsSource.hitCount}
              </Text>
            }
          />
          {statsSource.firstHitDepth !== null && (
            <StatInline label="首次命中跳数" value={`${statsSource.firstHitDepth}`} />
          )}
        </Space>
      </Card>

      {snapshot.running && !viewRunId && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={`正在第 ${snapshot.depth} 跳扫描中：已展开 ${snapshot.scanned} 个钱包、检查 ${snapshot.tagChecked} 个标签，命中 ${
            snapshot.hitCount
          }${hitLimit > 0 ? ` / 目标 ${hitLimit}` : ''}${
            tokenFilter.length > 0 ? ` · 仅追踪 ${tokenFilter.join('/')}` : ''
          }${
            snapshot.hitCount > 0
              ? `（本层查完后${hitLimit > 0 && snapshot.hitCount >= hitLimit ? '停止' : '继续更深'}）`
              : ''
          }`}
        />
      )}
      {!snapshot.running && snapshot.error && !viewRunId && (
        <Alert
          type={snapshot.finished ? 'success' : 'warning'}
          showIcon
          style={{ marginBottom: 12 }}
          message={
            snapshot.finished
              ? `搜索完成：累计命中 ${snapshot.hitCount} 个交易所钱包${
                  snapshot.firstHitDepth !== null ? `（首次命中于第 ${snapshot.firstHitDepth} 跳）` : ''
                }`
              : '搜索结束'
          }
          description={snapshot.error}
        />
      )}
      {!snapshot.running && viewRunId && runRowQuery.data && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={`正在回看历史搜索：${STATUS_TEXT[runRowQuery.data.status]} · 命中 ${runRowQuery.data.hitCount} 个`}
          description={
            <Space>
              <Button
                danger
                size="small"
                onClick={async () => {
                  if (!viewRunId) return;
                  await deleteHuntRunData(viewRunId);
                  setContentViewRunId(null);
                  setPage(0);
                  queryClient.invalidateQueries({ queryKey: ['hunt-runs'] });
                  queryClient.invalidateQueries({ queryKey: ['hunt-storage'] });
                }}
              >
                删除此记录（含全部钱包数据）
              </Button>
            </Space>
          }
        />
      )}

      {storageQuery.data && (
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
          本地数据库占用约 {(storageQuery.data.usage / 1024 / 1024).toFixed(1)} MB
          {storageQuery.data.quota > 0 && ` / 配额 ${(storageQuery.data.quota / 1024 / 1024 / 1024).toFixed(1)} GB`}
          （可在历史搜索中删除不需要的记录）
        </Text>
      )}

      <Table
        rowKey={(h) => h.key}
        columns={columns}
        dataSource={rows}
        loading={(snapshot.running && !viewRunId && total === 0 && page === 0) || hitsQuery.isPending}
        size="small"
        locale={{ emptyText: snapshot.running && !viewRunId ? '正在扫描，命中后会实时显示…' : '暂无命中记录' }}
        pagination={{
          current: page + 1,
          pageSize: PAGE_SIZE,
          total,
          showSizeChanger: false,
          showTotal: (t) => `共 ${t} 条命中`,
          onChange: (p) => setPage(p - 1),
        }}
      />

      {!snapshot.running && !viewRunId && snapshot.tagChecked > 0 && total === 0 && !snapshot.error && (
        <Alert type="info" showIcon style={{ marginTop: 12 }} message={`已检查 ${snapshot.tagChecked} 个钱包，均无交易所标签。`} />
      )}
    </div>
  );
}

function StatInline({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>{label}</Text>
      <Text strong style={{ fontSize: 18 }}>{value}</Text>
    </div>
  );
}
