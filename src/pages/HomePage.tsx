import { useNavigate } from 'react-router-dom';
import { Button, Card, Col, Row, Space, Tag, Typography } from 'antd';
import { NodeIndexOutlined, PartitionOutlined, SearchOutlined, SendOutlined } from '@ant-design/icons';
import { CHAINS } from '../api/oklink/chains';
import { DEMO_A } from '../demo';

const { Title, Paragraph, Text } = Typography;

const FEATURES = [
  {
    icon: <SearchOutlined />,
    title: '地址画像',
    desc: '查询任意地址的原生币余额、代币持仓与完整交易记录。',
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
    desc: '基于 OKLink 网页端数据接口，支持 Ethereum、BNB Chain、Polygon、Tron 等主流公链。',
  },
];

export default function HomePage() {
  const navigate = useNavigate();

  return (
    <div style={{ maxWidth: 960, margin: '0 auto' }}>
      <div style={{ textAlign: 'center', padding: '48px 0 32px' }}>
        <Title level={2}>区块链资金溯源工具</Title>
        <Paragraph type="secondary" style={{ fontSize: 16 }}>
          基于 OKLink 网页端数据接口的链上资金流分析与可视化（无需 API Key）
          {__OKLINK_MOCK__ && (
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
          {__OKLINK_MOCK__ && (
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

      <Card style={{ marginTop: 16 }} title="支持的链">
        <Space wrap>
          {CHAINS.map((c) => (
            <Tag key={c.key} color="blue">
              {c.name} ({c.key})
            </Tag>
          ))}
        </Space>
        <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          直接使用 <Text code>npm run dev</Text> 启动即可抓取 OKLink 网页端真实数据，无需配置任何
          Key；当前演示模式（Mock）使用内置离线数据。
        </Paragraph>
      </Card>
    </div>
  );
}
