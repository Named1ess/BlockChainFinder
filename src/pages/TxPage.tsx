import { useParams } from 'react-router-dom';
import { Alert, Button, Card, Descriptions, Space, Typography } from 'antd';
import { LinkOutlined } from '@ant-design/icons';
import { getChain, getExplorerUrl } from '../api/oklink/chains';

const { Text } = Typography;

export default function TxPage() {
  const { chain = 'ETH', txid = '' } = useParams();
  const chainInfo = getChain(chain);

  return (
    <Card title="交易详情">
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="交易哈希">
            <Text code className="mono" copyable>
              {txid}
            </Text>
          </Descriptions.Item>
          <Descriptions.Item label="所属链">{chainInfo?.name ?? chain}</Descriptions.Item>
        </Descriptions>
        {chainInfo && (
          <Button icon={<LinkOutlined />} href={getExplorerUrl(chain, 'tx', txid)} target="_blank">
            在 {chainInfo.explorerName} 查看完整交易详情
          </Button>
        )}
        <Alert
          type="info"
          showIcon
          message="应用内交易详情开发中"
          description={chainInfo
            ? `当前版本可点击上方按钮在 ${chainInfo.explorerName} 查看该交易的完整信息；已接入链可从地址页的交易记录中继续追踪对手方地址。`
            : '当前链未接入区块浏览器，请选择已支持的链查询。'}
        />
      </Space>
    </Card>
  );
}
