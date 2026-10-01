import { useNavigate } from 'react-router-dom';
import { Button, Card, Col, Row, Space, Tag, Typography } from 'antd';
import { NodeIndexOutlined, PartitionOutlined, SearchOutlined, SendOutlined } from '@ant-design/icons';
import { CHAINS } from '../api/oklink/chains';
import { DEMO_A } from '../demo';
import { getEntityLabelSource } from '../api/oklink/entity';

const { Title, Paragraph } = Typography;

const FEATURES = [
  {
    icon: <SearchOutlined />,
    title: '地址画像',
    desc: '查询地址的原生币余额、代币持仓与交易记录，缺失信息会明确提示。',
  },
  {
    icon: <PartitionOutlined />,
    title: '资金溯源',
    desc: '从种子地址出发，自动多跳展开资金流向图，支持追来源 / 追去向 / 双向追踪。',
  },
  {
    icon: <NodeIndexOutlined />,
    title: '剪枝控制',
    desc: '通过深度、最小金额、邻居数上限等条件控制展开规模，避免交易所热钱包导致图爆炸。',
  },
  {
    icon: <SendOutlined />,
    title: '多链支持',
    desc: '已接入 Ethereum / Polygon / Tron；BNB Chain 暂未接入可用数据源。',
  },
];

export default function HomePage() {
  const navigate = useNavigate();

  return (
    <div style={{ maxWidth: 960, margin: '0 auto' }}>
      <div style={{ textAlign: 'center', padding: '48px 0 32px' }}>
        <Title level={2}>区块链资金溯源工具</Title>
        <Paragraph type="secondary" style={{ fontSize: 16 }}>
          多链地址查询与资金流分析可视化
          {__APP_MOCK__ && (
            <Tag color="orange" style={{ marginLeft: 8 }}>
              演示模式（Mock 数据）
            </Tag>
          )}
        </Paragraph>
        <Space>
          <Button
            type="primary"
            size="large"
            icon={<SearchOutlined />}
            onClick={() => document.querySelector<HTMLInputElement>('.search-bar input')?.focus()}
          >
            在上方搜索框输入地址开始
          </Button>
          {__APP_MOCK__ && (
            <Button size="large" onClick={() => navigate(`/address/ETH/${DEMO_A}`)}>
              试试演示地址 →
            </Button>
          )}
        </Space>
      </div>

      <Row gutter={[16, 16]}>
        {FEATURES.map((f) => (
          <Col xs={24} sm={12} key={f.title}>
            <Card>
              <Card.Meta avatar={<span style={{ fontSize: 28 }}>{f.icon}</span>} title={f.title} description={f.desc} />
            </Card>
          </Col>
        ))}
      </Row>

      <Card style={{ marginTop: 16 }} title="数据源与链支持">
        {getEntityLabelSource('ETH') === 'OKLink' && (
          <Paragraph>地址与盒武器搜索的标签来源：OKLink 网页搜索。首次查询需要等待官网加载，重复地址会使用短期缓存。</Paragraph>
        )}
        <Space wrap>
          {CHAINS.map((c) => (
            <Tag key={c.key} color={c.dataSource ? 'blue' : 'default'}>
              {c.name} ({c.key}) · {c.dataSource ?? '暂未接入'}
            </Tag>
          ))}
        </Space>
        <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          {__APP_MOCK__
            ? '当前为演示模式，Ethereum / Polygon 使用内置离线数据，其他链不提供演示数据。'
            : 'Ethereum 和 Polygon 使用 Blockscout。Tron 使用 TronScan，TRX 余额与 TRC20 持仓查询遇到授权失败时使用 TronGrid。TronGrid 匿名查询可能受到限流或访问限制，可在服务端配置独立的 TronGrid API Key。BNB Chain 暂不支持应用内查询，可通过 BscScan 查看。'}
        </Paragraph>
      </Card>
    </div>
  );
}
