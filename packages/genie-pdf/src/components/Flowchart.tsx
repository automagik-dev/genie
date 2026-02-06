import React from "react";
import { View, Text, StyleSheet, Svg, Line, Rect, G, Path } from "@react-pdf/renderer";
import type { ThemeConfig } from "../themes/index.js";

// Flowchart node types
type NodeType = "start" | "end" | "process" | "decision" | "data" | "connector";

interface FlowNode {
  id: string;
  type: NodeType;
  label: string;
  x?: number;
  y?: number;
}

interface FlowEdge {
  from: string;
  to: string;
  label?: string;
}

interface FlowchartProps {
  nodes: FlowNode[];
  edges: FlowEdge[];
  theme: ThemeConfig;
  title?: string;
  direction?: "vertical" | "horizontal";
}

// Simple text-based flowchart parser
// Syntax:
// [Start] --> (Process) --> {Decision}
// {Decision} --Yes--> [End]
// {Decision} --No--> (Another Process)
export function parseFlowchart(text: string): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const nodeMap = new Map<string, FlowNode>();

  const lines = text.trim().split('\n');
  
  for (const line of lines) {
    // Match patterns: [text], (text), {text}, ((text))
    const nodePattern = /(\[([^\]]+)\]|\(([^)]+)\)|\{([^}]+)\}|\(\(([^)]+)\)\))/g;
    const arrowPattern = /--([^>]*)?-->/g;
    
    let match;
    const lineNodes: string[] = [];
    const lineLabels: string[] = [];
    
    // Extract all nodes from line
    const cleanLine = line;
    let lastIndex = 0;
    
    while ((match = nodePattern.exec(cleanLine)) !== null) {
      const fullMatch = match[0];
      const content = match[2] || match[3] || match[4] || match[5];
      
      if (content && !nodeMap.has(content)) {
        let type: NodeType = "process";
        if (fullMatch.startsWith('[')) type = content.toLowerCase().includes('start') ? "start" : content.toLowerCase().includes('end') ? "end" : "process";
        else if (fullMatch.startsWith('{')) type = "decision";
        else if (fullMatch.startsWith('((')) type = "connector";
        else if (fullMatch.startsWith('(')) type = "data";
        
        const node: FlowNode = { id: content, type, label: content };
        nodes.push(node);
        nodeMap.set(content, node);
      }
      lineNodes.push(content);
    }
    
    // Extract edge labels
    while ((match = arrowPattern.exec(cleanLine)) !== null) {
      lineLabels.push(match[1]?.trim() || '');
    }
    
    // Create edges between consecutive nodes
    for (let i = 0; i < lineNodes.length - 1; i++) {
      edges.push({
        from: lineNodes[i],
        to: lineNodes[i + 1],
        label: lineLabels[i] || undefined,
      });
    }
  }
  
  return { nodes, edges };
}

export function Flowchart({ nodes, edges, theme, title, direction = "vertical" }: FlowchartProps) {
  const isGlass = theme.name === "glass";
  const isVertical = direction === "vertical";
  
  // Layout constants
  const nodeWidth = 100;
  const nodeHeight = 36;
  const spacingX = 40;
  const spacingY = 50;
  const padding = 20;
  
  // Calculate positions
  const positionedNodes = nodes.map((node, index) => ({
    ...node,
    x: isVertical ? padding + nodeWidth / 2 : padding + index * (nodeWidth + spacingX) + nodeWidth / 2,
    y: isVertical ? padding + index * (nodeHeight + spacingY) + nodeHeight / 2 : padding + nodeHeight / 2,
  }));
  
  const nodeById = new Map(positionedNodes.map(n => [n.id, n]));
  
  // Calculate SVG dimensions
  const width = isVertical 
    ? nodeWidth + padding * 2 + 60
    : nodes.length * (nodeWidth + spacingX) + padding * 2;
  const height = isVertical 
    ? nodes.length * (nodeHeight + spacingY) + padding * 2
    : nodeHeight + padding * 2 + 40;

  const styles = StyleSheet.create({
    container: {
      marginVertical: 16,
      padding: 12,
      backgroundColor: isGlass ? "rgba(241, 245, 249, 0.6)" : "#f8fafc",
      borderRadius: 8,
      borderWidth: 1,
      borderColor: isGlass ? "rgba(99, 102, 241, 0.2)" : theme.colors.border,
    },
    title: {
      fontSize: 11,
      fontFamily: theme.fonts.heading,
      color: isGlass ? "#4338ca" : theme.colors.heading,
      marginBottom: 10,
      textAlign: "center",
    },
    svgContainer: {
      alignItems: "center",
    },
  });

  const getNodeColor = (type: NodeType) => {
    switch (type) {
      case "start": return isGlass ? "#22c55e" : "#16a34a";
      case "end": return isGlass ? "#ef4444" : "#dc2626";
      case "decision": return isGlass ? "#f59e0b" : "#d97706";
      case "data": return isGlass ? "#8b5cf6" : "#7c3aed";
      case "connector": return isGlass ? "#64748b" : "#475569";
      default: return isGlass ? "#6366f1" : "#4f46e5";
    }
  };

  const renderNode = (node: FlowNode & { x: number; y: number }) => {
    const color = getNodeColor(node.type);
    const x = node.x - nodeWidth / 2;
    const y = node.y - nodeHeight / 2;
    
    // Decision diamond path
    if (node.type === "decision") {
      const cx = node.x;
      const cy = node.y;
      const hw = nodeWidth / 2;
      const hh = nodeHeight / 2;
      return (
        <G key={node.id}>
          <Path
            d={`M ${cx} ${cy - hh} L ${cx + hw} ${cy} L ${cx} ${cy + hh} L ${cx - hw} ${cy} Z`}
            fill={color}
            opacity={0.15}
            stroke={color}
            strokeWidth={1.5}
          />
          <Text
            x={cx}
            y={cy + 3}
            style={{
              fontSize: 7,
              fontFamily: theme.fonts.body,
              color: color,
              textAlign: "center",
            }}
          >
            {node.label.length > 12 ? node.label.slice(0, 12) + '…' : node.label}
          </Text>
        </G>
      );
    }
    
    // Start/End rounded rectangle
    const radius = (node.type === "start" || node.type === "end") ? 18 : 4;
    
    return (
      <G key={node.id}>
        <Rect
          x={x}
          y={y}
          width={nodeWidth}
          height={nodeHeight}
          rx={radius}
          fill={color}
          opacity={0.15}
          stroke={color}
          strokeWidth={1.5}
        />
        <Text
          x={node.x}
          y={node.y + 3}
          style={{
            fontSize: 8,
            fontFamily: theme.fonts.body,
            color: color,
            textAlign: "center",
          }}
        >
          {node.label.length > 14 ? node.label.slice(0, 14) + '…' : node.label}
        </Text>
      </G>
    );
  };

  const renderEdge = (edge: FlowEdge, index: number) => {
    const fromNode = nodeById.get(edge.from);
    const toNode = nodeById.get(edge.to);
    if (!fromNode || !toNode) return null;
    
    const x1 = fromNode.x!;
    const y1 = fromNode.y! + nodeHeight / 2;
    const x2 = toNode.x!;
    const y2 = toNode.y! - nodeHeight / 2;
    
    return (
      <G key={`edge-${index}`}>
        <Line
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke={isGlass ? "rgba(99, 102, 241, 0.5)" : theme.colors.border}
          strokeWidth={1.5}
        />
        {/* Arrow head */}
        <Path
          d={`M ${x2 - 4} ${y2 - 6} L ${x2} ${y2} L ${x2 + 4} ${y2 - 6}`}
          fill="none"
          stroke={isGlass ? "rgba(99, 102, 241, 0.5)" : theme.colors.border}
          strokeWidth={1.5}
        />
        {/* Edge label */}
        {edge.label && (
          <Text
            x={(x1 + x2) / 2 + 8}
            y={(y1 + y2) / 2}
            style={{
              fontSize: 6,
              color: isGlass ? "#6366f1" : theme.colors.text,
              opacity: 0.8,
            }}
          >
            {edge.label}
          </Text>
        )}
      </G>
    );
  };

  return (
    <View style={styles.container}>
      {title && <Text style={styles.title}>{title}</Text>}
      <View style={styles.svgContainer}>
        <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
          {/* Render edges first (behind nodes) */}
          {edges.map((edge, i) => renderEdge(edge, i))}
          {/* Render nodes */}
          {positionedNodes.map(renderNode)}
        </Svg>
      </View>
    </View>
  );
}

// Simple box-based flowchart (works better with react-pdf limitations)
interface SimpleFlowProps {
  steps: string[];
  theme: ThemeConfig;
  title?: string;
  direction?: "vertical" | "horizontal";
}

export function SimpleFlow({ steps, theme, title, direction = "vertical" }: SimpleFlowProps) {
  const isGlass = theme.name === "glass";
  const isVertical = direction === "vertical";

  const styles = StyleSheet.create({
    container: {
      marginVertical: 14,
      padding: 14,
      backgroundColor: isGlass ? "rgba(241, 245, 249, 0.5)" : "#fafafa",
      borderRadius: 8,
      borderWidth: 1,
      borderColor: isGlass ? "rgba(99, 102, 241, 0.2)" : theme.colors.border,
    },
    title: {
      fontSize: 11,
      fontFamily: theme.fonts.heading,
      color: isGlass ? "#4338ca" : theme.colors.heading,
      marginBottom: 12,
    },
    flowContainer: {
      flexDirection: isVertical ? "column" : "row",
      alignItems: "center",
    },
    step: {
      backgroundColor: isGlass ? "rgba(99, 102, 241, 0.1)" : "#e0e7ff",
      borderRadius: 6,
      paddingVertical: 8,
      paddingHorizontal: 14,
      borderWidth: 1,
      borderColor: isGlass ? "rgba(99, 102, 241, 0.3)" : "#a5b4fc",
      minWidth: isVertical ? "80%" : 80,
      alignItems: "center",
    },
    stepFirst: {
      backgroundColor: isGlass ? "rgba(34, 197, 94, 0.15)" : "#dcfce7",
      borderColor: isGlass ? "rgba(34, 197, 94, 0.4)" : "#86efac",
    },
    stepLast: {
      backgroundColor: isGlass ? "rgba(239, 68, 68, 0.1)" : "#fee2e2",
      borderColor: isGlass ? "rgba(239, 68, 68, 0.3)" : "#fca5a5",
    },
    stepDecision: {
      backgroundColor: isGlass ? "rgba(245, 158, 11, 0.1)" : "#fef3c7",
      borderColor: isGlass ? "rgba(245, 158, 11, 0.4)" : "#fcd34d",
    },
    stepText: {
      fontSize: 9,
      color: theme.colors.text,
      textAlign: "center",
    },
    arrow: {
      marginVertical: isVertical ? 6 : 0,
      marginHorizontal: isVertical ? 0 : 6,
    },
    arrowText: {
      fontSize: 12,
      color: isGlass ? "#6366f1" : "#94a3b8",
    },
  });

  const getStepStyle = (step: string, index: number, total: number) => {
    const baseStyle = [styles.step];
    if (index === 0) baseStyle.push(styles.stepFirst);
    else if (index === total - 1) baseStyle.push(styles.stepLast);
    else if (step.includes('?') || step.toLowerCase().includes('decision')) {
      baseStyle.push(styles.stepDecision);
    }
    return baseStyle;
  };

  return (
    <View style={styles.container}>
      {title && <Text style={styles.title}>{title}</Text>}
      <View style={styles.flowContainer}>
        {steps.map((step, index) => (
          <React.Fragment key={index}>
            <View style={getStepStyle(step, index, steps.length)}>
              <Text style={styles.stepText}>{step}</Text>
            </View>
            {index < steps.length - 1 && (
              <View style={styles.arrow}>
                <Text style={styles.arrowText}>{isVertical ? "↓" : "→"}</Text>
              </View>
            )}
          </React.Fragment>
        ))}
      </View>
    </View>
  );
}

export default Flowchart;
