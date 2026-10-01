import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { App, Button, Input, Select } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { CHAINS, parseSearchInput } from '../api/oklink/chains';

export default function SearchBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const { message } = App.useApp();

  const routeChain = location.pathname.startsWith('/address/') ? params.chain : undefined;
  const [chain, setChain] = useState(routeChain ?? 'ETH');
  const [value, setValue] = useState('');

  useEffect(() => {
    if (routeChain) setChain(routeChain);
  }, [routeChain]);

  const onSearch = (raw: string) => {
    const parsed = parseSearchInput(raw, chain);
    if (!parsed) {
      message.warning('请输入合约地址、钱包地址或交易哈希');
      return;
    }
    if (parsed.kind === 'address') {
      navigate(`/address/${parsed.chain}/${parsed.address}`);
    } else {
      navigate(`/tx/${parsed.chain}/${parsed.txid}`);
    }
    setValue('');
  };

  return (
    <div className="search-bar">
      <Select
        value={chain}
        onChange={setChain}
        style={{ width: 140 }}
        options={CHAINS.map((c) => ({
          value: c.key,
          label: `${c.name} (${c.key})${c.dataSource ? '' : ' · 暂未接入'}`,
          disabled: !c.dataSource || (__APP_MOCK__ && c.key !== 'ETH' && c.key !== 'POLYGON'),
        }))}
      />
      <Input
        placeholder="输入钱包地址 / 合约地址 / 交易哈希"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onPressEnter={() => onSearch(value)}
        allowClear
      />
      <Button type="primary" icon={<SearchOutlined />} onClick={() => onSearch(value)}>
        查询
      </Button>
    </div>
  );
}
