import { useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Alert, App, Button, Descriptions, Drawer, Space, Spin, Table, Tag, Typography } from 'antd';
import { CopyOutlined, LinkOutlined } from '@ant-design/icons';
import { Link as RouterLink } from 'react-router-dom';
import type { TraceOptions } from '../../trace/engine';
import type { TransferEdge } from '../../trace/graph';
import { useTraceEngine } from '../../trace/useTraceEngine';
import { getChain } from '../../api/oklink/chains';
import { copyText, formatAmount, formatTime, formatUsd, shortAddress } from '../../utils/format';
import TraceControls from './TraceControls';

const { Text } = Typography;

interface TraceNodeData extends Record<string, unknown> {
  address: string;
  depth: number;
  expanded: boolean;
}

type TraceFlowNode = Node<TraceNodeData, 'trace'>;

function TraceNodeCard({ data, selected }: NodeProps<TraceFlowNode>) {
  return (
    <div className={`trace-node${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div>
        <Tag color={data.depth === 0 ? 'blue' : 'default'} style={{ marginRight: 4 }}>
          {data.depth === 0 ? '起点' : `深度 ${data.depth}`}
        </Tag>
        {data.expanded && <Tag color="green">已展开</Tag>}
      </div>
      <div className="addr">{shortAddress(data.address)}</div>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}

const nodeTypes = { trace: TraceNodeCard };

function edgeLabel(e: TransferEdge): string {
  const top = [...e.transfers].sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0))[0];
  if (!top) return `${e.txCount} 笔`;
  const base = `${formatAmount(top.amount, 4)} ${top.token}`;
  return e.txCount > 1 ? `${base} · 共${e.txCount}笔` : base;
}

function buildEdge(e: TransferEdge): Edge {
  return {
    id: e.id,
    source: e.from,
    target: e.to,
    label: edgeLabel(e),
    labelShowBg: true,
    labelBgPadding: [6, 2],
    labelBgBorderRadius: 4,
    labelBgStyle: { fill: '#fff', fillOpacity: 0.9 },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#8c8c8c' },
    style: { stroke: '#8c8c8c' },
  };
}

type Selection = { kind: 'node'; id: string } | { kind: 'edge'; id: string } | null;

function FlowGraphInner({ chain, address }: { chain: string; address: string }) {
  const { engine, snapshot } = useTraceEngine();
  const { message } = App.useApp();
  const { fitView } = useReactFlow();
  const [options, setOptions] = useState<TraceOptions>({
    direction: 'out',
    maxDepth: 2,
    maxNodes: 60,
    minUsd: 0,
    maxNeighbors: 8,
    pagesPerNode: 1,
  });
  const [selection, setSelection] = useState<Selection>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<TraceFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // 图数据变化时重建节点/边；保留用户拖拽过的位置
  useEffect(() => {
    setNodes((prev) => {
      const posById = new Map(prev.map((n) => [n.id, n.position]));
      return snapshot.nodes.map((n) => ({
        id: n.address,
        type: 'trace' as const,
        position: posById.get(n.address) ?? n.position,
        selected: selection?.kind === 'node' && selection.id === n.address,
        data: { address: n.address, depth: n.depth, expanded: n.expanded },
      }));
    });
    setEdges(snapshot.edges.map(buildEdge));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.version, selection]);

  const selectedNode = useMemo(
    () => (selection?.kind === 'node' ? snapshot.nodes.find((n) => n.address === selection.id) ?? null : null),
    [selection, snapshot],
  );
  const selectedEdge = useMemo(
    () => (selection?.kind === 'edge' ? snapshot.edges.find((e) => e.id === selection.id) ?? null : null),
    [selection, snapshot],
  );

  const chainInfo = getChain(chain);

  return (
    <div>
      <TraceControls
        options={options}
        onChange={setOptions}
        running={snapshot.running}
        hasGraph={snapshot.nodes.length > 0}
        onStart={() => void engine.start(chain, address, options)}
        onStop={() => engine.stop()}
        onClear={() => {
          engine.reset();
          setSelection(null);
        }}
      />

      {snapshot.running && (
        <Alert
          style={{ marginBottom: 8 }}
          type="info"
          icon={<Spin size="small" />}
          showIcon
          message={`正在溯源：已展开 ${snapshot.done} 个地址，队列剩余 ${snapshot.queued} 个（受 API 限流影响，速度约 2 地址/秒）`}
        />
      )}
      {snapshot.error && (
        <Alert style={{ marginBottom: 8 }} type="warning" showIcon message={snapshot.error} closable />
      )}
      {!snapshot.running && snapshot.nodes.length === 0 && (
        <Alert
          style={{ marginBottom: 8 }}
          type="info"
          showIcon
          message={`点击「开始溯源」从当前地址 ${shortAddress(address)} 出发追踪${options.direction === 'in' ? '资金来源' : options.direction === 'out' ? '资金去向' : '双向资金流'}`}
        />
      )}

      <div className="flow-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.2}
          onNodeClick={(_, node) => setSelection({ kind: 'node', id: node.id })}
          onEdgeClick={(_, edge) => setSelection({ kind: 'edge', id: edge.id })}
          onPaneClick={() => setSelection(null)}
          onNodeDoubleClick={(_, node) => {
            void engine.expandNode(node.id, options);
            message.info(`正在展开 ${shortAddress(node.id)} 的直接对手方…`);
          }}
        >
          <Background gap={20} />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>

      <Space style={{ marginTop: 8 }}>
        <Button size="small" onClick={() => fitView({ padding: 0.2, duration: 300 })}>
          适应画布
        </Button>
        <Text type="secondary" style={{ fontSize: 12 }}>
          节点 {snapshot.nodes.length} · 边 {snapshot.edges.length}
        </Text>
      </Space>

      <Drawer
        open={selection !== null}
        onClose={() => setSelection(null)}
        width={440}
        title={selection?.kind === 'edge' ? '转账关系明细' : '地址详情'}
      >
        {selectedNode && (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="地址">
                <Text code className="mono" copyable>
                  {selectedNode.address}
                </Text>
              </Descriptions.Item>
              <Descriptions.Item label="深度">{selectedNode.depth}</Descriptions.Item>
              <Descriptions.Item label="展开状态">
                {selectedNode.expanded ? '已展开' : '未展开（双击节点或点下方按钮展开）'}
              </Descriptions.Item>
            </Descriptions>
            <Space wrap>
              <Button
                type="primary"
                disabled={snapshot.running || selectedNode.expanded}
                onClick={() => void engine.expandNode(selectedNode.address, options)}
              >
                展开此地址
              </Button>
              <Button
                disabled={snapshot.running}
                onClick={() => void engine.start(chain, selectedNode.address, options)}
              >
                以此为起点重新溯源
              </Button>
              {chainInfo && (
                <Button
                  icon={<LinkOutlined />}
                  href={`${chainInfo.explorerBase}/address/${selectedNode.address}`}
                  target="_blank"
                >
                  OKLink 查看
                </Button>
              )}
              <Button
                icon={<CopyOutlined />}
                onClick={async () => {
                  await copyText(selectedNode.address);
                  message.success('已复制');
                }}
              />
            </Space>
          </Space>
        )}

        {selectedEdge && (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="付款方">
                <RouterLink to={`/address/${chain}/${selectedEdge.from}`} onClick={() => setSelection(null)}>
                  {shortAddress(selectedEdge.from, 10, 8)}
                </RouterLink>
              </Descriptions.Item>
              <Descriptions.Item label="收款方">
                <RouterLink to={`/address/${chain}/${selectedEdge.to}`} onClick={() => setSelection(null)}>
                  {shortAddress(selectedEdge.to, 10, 8)}
                </RouterLink>
              </Descriptions.Item>
              <Descriptions.Item label="合计">
                {selectedEdge.txCount} 笔 · {formatUsd(selectedEdge.totalUsd)}
              </Descriptions.Item>
            </Descriptions>
            <Table
              rowKey={(t) => `${t.token}-${t.contract}`}
              size="small"
              pagination={false}
              dataSource={selectedEdge.transfers}
              columns={[
                { title: '代币', dataIndex: 'token' },
                {
                  title: '累计金额',
                  align: 'right',
                  render: (_, t) => formatAmount(t.amount, 4),
                },
                { title: '笔数', dataIndex: 'count', align: 'right', width: 70 },
                {
                  title: '价值 (USD)',
                  align: 'right',
                  render: (_, t) => (t.usdValue === null ? '-' : formatUsd(t.usdValue)),
                },
                { title: '最近转账', render: (_, t) => formatTime(t.lastTime) },
              ]}
            />
          </Space>
        )}
      </Drawer>
    </div>
  );
}

export default function FlowGraph({ chain, address }: { chain: string; address: string }) {
  return (
    <ReactFlowProvider>
      <FlowGraphInner chain={chain} address={address} />
    </ReactFlowProvider>
  );
}
