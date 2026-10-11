/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  ReactFlowProvider,
  type Node,
  type Edge,
  type FitViewOptions,
  type ProOptions,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ChatCardNode } from '../nodes/ChatCardNode';
import { NoteCardNode } from '../nodes/NoteCardNode';
import { withErrorBoundary } from '../ErrorBoundary';
import { NodeActionsContext, readOnlyNodeActions } from '../../context/NodeActionsContext';
import { AuthProvider } from '../../context/AuthContext';
import { ModalProvider } from '../../context/ModalContext';

export interface ReadOnlyCanvasProps {
  nodes: Node[];
  edges: Edge[];
  fitViewPadding?: number;
  minZoom?: number;
  maxZoom?: number;
  className?: string;
  style?: React.CSSProperties;
  backgroundVariant?: BackgroundVariant;
  backgroundGap?: number;
  backgroundSize?: number;
  showBackground?: boolean;
  ensureAuthProvider?: boolean;
  fitView?: boolean;
  fitViewOptions?: FitViewOptions;
  zoomOnDoubleClick?: boolean;
  nodeTypes?: NodeTypes;
  proOptions?: ProOptions;
  children?: React.ReactNode;
}

/**
 * 模块级只读节点定义：防止组件内部声明触发 React Flow 重复渲染告警
 */
export const readOnlyNodeTypes: NodeTypes = {
  chat: withErrorBoundary(ChatCardNode),
  note: withErrorBoundary(NoteCardNode),
};

export const ReadOnlyCanvas: React.FC<ReadOnlyCanvasProps> = ({
  nodes,
  edges,
  fitViewPadding = 0.2,
  minZoom = 0.1,
  maxZoom = 1.5,
  className = 'w-full h-full',
  style,
  backgroundVariant = BackgroundVariant.Dots,
  backgroundGap = 28,
  backgroundSize = 1.5,
  showBackground = true,
  ensureAuthProvider = false,
  fitView = true,
  fitViewOptions,
  zoomOnDoubleClick = false,
  nodeTypes = readOnlyNodeTypes,
  proOptions = { hideAttribution: true },
  children,
}) => {
  const flowContent = (
    <div className={className} style={style}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        edgesFocusable={false}
        zoomOnDoubleClick={zoomOnDoubleClick}
        proOptions={proOptions}
        fitView={fitView}
        fitViewOptions={fitViewOptions ?? { padding: fitViewPadding }}
        minZoom={minZoom}
        maxZoom={maxZoom}
      >
        {showBackground && (
          <Background variant={backgroundVariant} gap={backgroundGap} size={backgroundSize} />
        )}
        {children}
      </ReactFlow>
    </div>
  );

  const contextWrapped = (
    <NodeActionsContext.Provider value={readOnlyNodeActions}>
      <ReactFlowProvider>
        {flowContent}
      </ReactFlowProvider>
    </NodeActionsContext.Provider>
  );

  if (ensureAuthProvider) {
    return (
      <AuthProvider>
        <ModalProvider>{contextWrapped}</ModalProvider>
      </AuthProvider>
    );
  }

  return contextWrapped;
};
