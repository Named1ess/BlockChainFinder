import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Alert, Segmented, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { CheckCircleFilled, CloseCircleFilled } from '@ant-design/icons';
import { fetchAddressTransactions, txListSupported, type TxProtocolType } from '../api/oklink/endpoints';
import { getChain } from '../api/oklink/chains';
import { txTokenSymbol, type TxItem } from '../api/oklink/schemas';
import { formatAmount, formatTime, shortAddress } from '../utils/format';
import { canonicalIdentity } from '../trace/engine';

const { Text } = Typography;

interface Props {
  chain: string;
  address: string;
}

const PROTOCOL_OPTIONS: Array<{ label: string; value: TxProtocolType; disabled?: boolean }> = [
  { label: '普通转账', value: 'transaction' },
  { label: '代币转账', value: 'token_20' },
  { label: '内部调用', value: 'internal' },
];

function sameAddr(a: string, b: string): boolean {
  return canonicalIdentity(a) === canonicalIdentity(b);
}

export default function TxTable({ chain, address }: Props) {
  const [page, setPage] = useState(1);
  const [protocolType, setProtocolType] = useState<TxProtocolType>(() =>
    PROTOCOL_OPTIONS.find((option) => txListSupported(chain, option.value))?.value ?? 'transaction',
  );
  const chainInfo = getChain(chain);
  const protocolSupported = txListSupported(chain, protocolType);

  // 切换链后只选择当前数据源已支持的交易类型。
  useEffect(() => {
    if (!txListSupported(chain, protocolType)) {
      const supported = PROTOCOL_OPTIONS.find((option) => txListSupported(chain, option.value));
      if (supported) setProtocolType(supported.value);
    }
  }, [chain, protocolType]);

  useEffect(() => {
    setPage(1);
  }, [chain, address]);

  const query = useQuery({
    queryKey: ['txs', chain, address, page, protocolType],
    queryFn: () => fetchAddressTransactions(chain, address, page, 20, protocolType),
    enabled: protocolSupported,
    placeholderData: (prev, previousQuery) =>
      previousQuery?.queryKey[1] === chain && previousQuery.queryKey[2] === address && previousQuery.queryKey[4] === protocolType
        ? prev
        : undefined,
  });

  const columns: ColumnsType<TxItem> = [
    { title: '时间', width: 170, render: (_, tx) => formatTime(tx.transactionTime) },
    {
      title: '方向',
      width: 80,
      render: (_, tx) =>
        sameAddr(tx.from, address) ? <Tag color="orange">转出</Tag> : <Tag color="green">转入</Tag>,
    },
    {
      title: '对手方地址',
      render: (_, tx) => {
        const cp = sameAddr(tx.from, address) ? tx.to : tx.from;
        if (!cp) return '-';
        return <Link to={`/address/${chain}/${cp}`}>{shortAddress(cp)}</Link>;
      },
    },
    {
      title: '金额',
      align: 'right',
      render: (_, tx) => (
        <Text strong>
          {formatAmount(tx.amount)} {txTokenSymbol(tx)}
        </Text>
      ),
    },
    {
      title: '代币合约',
      render: (_, tx) =>
        tx.tokenContractAddress ? (
          <Text type="secondary" className="mono" style={{ fontSize: 12 }}>
            {shortAddress(tx.tokenContractAddress, 6, 4)}
          </Text>
        ) : (
          '-'
        ),
    },
    { title: '手续费', width: 100, align: 'right', render: (_, tx) => formatAmount(tx.txFee, 6) },
    {
      title: '状态',
      width: 80,
      render: (_, tx) =>
        tx.state === 'pending' ? (
          <Tag>待确认</Tag>
        ) : tx.state === 'success' ? (
          <CheckCircleFilled style={{ color: '#52c41a' }} />
        ) : tx.state === 'fail' ? (
          <CloseCircleFilled style={{ color: '#ff4d4f' }} />
        ) : (
          <Tag>未知</Tag>
        ),
    },
    {
      title: '交易哈希',
      width: 130,
      render: (_, tx) => <Link to={`/tx/${chain}/${tx.txId}`}>{shortAddress(tx.txId, 8, 6)}</Link>,
    },
  ];

  const empty = (query.data?.transactions.length ?? 0) === 0;

  return (
    <div>
      <SpaceBetween
        left={
          <Segmented
            options={PROTOCOL_OPTIONS.map((o) => ({
              ...o,
              disabled: o.disabled ?? !txListSupported(chain, o.value),
            }))}
            value={protocolType}
            onChange={(v) => {
              setProtocolType(v as TxProtocolType);
              setPage(1);
            }}
          />
        }
        right={
          <Text type="secondary" style={{ fontSize: 12 }}>
            共 {query.data?.totalPage ?? '-'} 页
          </Text>
        }
      />
      {!protocolSupported && (
        <Alert type="warning" showIcon style={{ margin: '12px 0' }} message="当前数据源不支持该交易类型" />
      )}
      {query.isError && (
        <Alert
          type="error"
          showIcon
          style={{ margin: '12px 0' }}
          message="交易记录加载失败"
          description={String(query.error)}
        />
      )}
      <Table
        style={{ marginTop: 12 }}
        rowKey="key"
        columns={columns}
        dataSource={(query.data?.transactions ?? []).map((tx, index) => ({
          ...tx, key: `${protocolType}:${tx.txId}:${tx.eventIndex ?? ''}:${index}`,
        }))}
        loading={protocolSupported && (query.isPending || query.isFetching)}
        size="small"
        scroll={{ x: 980 }}
        locale={{ emptyText: !protocolSupported ? '当前交易类型暂不支持' : empty && !query.isError ? '该类型下暂无交易' : '暂无数据' }}
        pagination={{
          current: page,
          pageSize: 20,
          total: (query.data?.totalPage ?? 1) * 20,
          showSizeChanger: false,
          onChange: setPage,
        }}
        footer={() =>
          query.data?.dataSource ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              数据来源：{query.data.dataSource}（{chainInfo?.name ?? chain}）
            </Text>
          ) : null
        }
      />
    </div>
  );
}

function SpaceBetween({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      {left}
      {right}
    </div>
  );
}
