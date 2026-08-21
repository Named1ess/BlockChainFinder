import { Button, Card, Col, Form, InputNumber, Radio, Row, Space, Tag } from 'antd';
import { ClearOutlined, PlayCircleFilled, ScissorOutlined } from '@ant-design/icons';
import type { TraceDirection, TraceOptions } from '../../trace/engine';

interface Props {
  options: TraceOptions;
  onChange: (opts: TraceOptions) => void;
  running: boolean;
  hasGraph: boolean;
  onStart: () => void;
  onStop: () => void;
  onClear: () => void;
}

export default function TraceControls({ options, onChange, running, hasGraph, onStart, onStop, onClear }: Props) {
  const set = <K extends keyof TraceOptions>(key: K, value: TraceOptions[K]) => onChange({ ...options, [key]: value });

  return (
    <Card size="small" style={{ marginBottom: 12 }}>
      <Row gutter={[16, 8]} align="middle">
        <Col>
          <Form.Item label="方向" style={{ marginBottom: 0 }}>
            <Radio.Group
              value={options.direction}
              onChange={(e) => set('direction', e.target.value as TraceDirection)}
              disabled={running}
              optionType="button"
              buttonStyle="solid"
              size="small"
              options={[
                { value: 'in', label: '追资金来源' },
                { value: 'out', label: '追资金去向' },
                { value: 'both', label: '双向' },
              ]}
            />
          </Form.Item>
        </Col>
        <Col>
          <Space size={4}>
            <span>深度</span>
            <InputNumber
              size="small"
              min={1}
              max={4}
              value={options.maxDepth}
              onChange={(v) => v && set('maxDepth', v)}
              disabled={running}
            />
          </Space>
        </Col>
        <Col>
          <Space size={4}>
            <span>最小金额($)</span>
            <InputNumber
              size="small"
              min={0}
              step={100}
              value={options.minUsd}
              onChange={(v) => v !== null && set('minUsd', v)}
              disabled={running}
            />
          </Space>
        </Col>
        <Col>
          <Space size={4}>
            <span>邻居上限</span>
            <InputNumber
              size="small"
              min={1}
              max={30}
              value={options.maxNeighbors}
              onChange={(v) => v && set('maxNeighbors', v)}
              disabled={running}
            />
          </Space>
        </Col>
        <Col>
          <Space size={4}>
            <span>抓取页数</span>
            <InputNumber
              size="small"
              min={1}
              max={10}
              value={options.pagesPerNode}
              onChange={(v) => v && set('pagesPerNode', v)}
              disabled={running}
            />
          </Space>
        </Col>
        <Col flex="auto" style={{ textAlign: 'right' }}>
          <Space>
            {running ? (
              <Button danger icon={<ScissorOutlined />} onClick={onStop}>
                停止
              </Button>
            ) : (
              <Button type="primary" icon={<PlayCircleFilled />} onClick={onStart} disabled={running}>
                开始溯源
              </Button>
            )}
            <Button icon={<ClearOutlined />} onClick={onClear} disabled={running || !hasGraph}>
              清空
            </Button>
          </Space>
        </Col>
      </Row>
      <div style={{ marginTop: 8 }}>
        <Tag color="blue">深度 = 距种子地址的跳数</Tag>
        <Tag>价格未知的转账不受最小金额过滤</Tag>
        <Tag>双击节点可手动展开</Tag>
      </div>
    </Card>
  );
}
