import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { fetchTokenBalances } from '../api/oklink/endpoints';
import type { TokenHolding } from '../api/oklink/schemas';
import { formatAmount, formatUsd, shortAddress } from '../utils/format';

const { Text } = Typography;

interface Props {
  chain: string;
  address: string;
}

function tokenSymbol(h: TokenHolding): string {
  return h.symbol || h.token || '-';
}

export default function TokenHoldingsTable({ chain, address }: Props) {
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [chain, address]);

  const query = useQuery({
    queryKey: ['tokens', chain, address, page],
    queryFn: () => fetchTokenBalances(chain, address, page, 20),
    placeholderData: (prev, previousQuery) =>
      previousQuery?.queryKey[1] === chain && previousQuery.queryKey[2] === address ? prev : undefined,
  });

  const columns: ColumnsType<TokenHolding> = [
    {
      title: '代币',
      render: (_, h) => (
        <Space size={8}>
          <Text strong>{tokenSymbol(h)}</Text>
          {h.tokenContractAddress && (
            <Text type="secondary" className="mono" style={{ fontSize: 12 }}>
              {shortAddress(h.tokenContractAddress, 6, 4)}
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: '持有量',
      align: 'right',
      render: (_, h) => formatAmount(h.holdingAmount),
    },
    { title: '单价 (USD)', align: 'right', render: (_, h) => formatUsd(h.priceUsd) },
    { title: '价值 (USD)', align: 'right', render: (_, h) => formatUsd(h.valueUsd) },
  ];

  return (
    <div>
      {query.data?.dataSource && <Text type="secondary">数据来源：{query.data.dataSource}</Text>}
      {!!query.data?.warnings?.length && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="持仓信息提示"
          description={query.data.warnings.join('；')}
        />
      )}
      {query.isError && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="代币持仓加载失败"
          description={String(query.error)}
        />
      )}
      <Table
        rowKey={(h) => `${tokenSymbol(h)}-${h.tokenContractAddress ?? ''}`}
        columns={columns}
        dataSource={query.data?.list ?? []}
        loading={query.isPending || query.isFetching}
        size="small"
        pagination={{
          current: page,
          pageSize: 20,
          total: (query.data?.totalPage ?? 1) * 20,
          showSizeChanger: false,
          onChange: setPage,
        }}
      />
    </div>
  );
}
