import { useNats } from '@khal-os/sdk/app';
import { useCallback, useEffect, useState } from 'react';
import { GENIE_SUBJECTS } from '../../../../lib/subjects';
import { theme } from '../../../../lib/theme';

// ============================================================================
// Types
// ============================================================================

export interface FsEntry {
  name: string;
  isDirectory: boolean;
  path: string;
}

interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: TreeNode[];
  expanded?: boolean;
  loading?: boolean;
}

interface FileTreeProps {
  rootPath: string;
  selectedPath: string;
  onNavigate: (path: string) => void;
}

// ============================================================================
// Constants
// ============================================================================

const ORG_ID = 'default';

// ============================================================================
// Styles
// ============================================================================

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    overflow: 'auto',
    backgroundColor: theme.bgCard,
    borderRight: `1px solid ${theme.border}`,
  },
  header: {
    padding: '8px 12px',
    fontSize: '11px',
    fontWeight: 600,
    color: theme.textMuted,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    borderBottom: `1px solid ${theme.border}`,
    flexShrink: 0,
  },
  treeRoot: {
    flex: 1,
    overflow: 'auto',
    padding: '4px 0',
  },
  nodeRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '2px 4px',
    cursor: 'pointer',
    border: 'none',
    width: '100%',
    textAlign: 'left' as const,
    backgroundColor: 'transparent',
    fontFamily: theme.fontFamily,
    fontSize: '12px',
    color: theme.textDim,
    borderRadius: '3px',
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    transition: 'background-color 0.1s ease, color 0.1s ease',
  },
  chevron: {
    display: 'inline-block',
    width: '12px',
    flexShrink: 0,
    fontSize: '10px',
    color: theme.textMuted,
  },
  icon: {
    flexShrink: 0,
    fontSize: '12px',
  },
  label: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    flex: 1,
  },
} as const;

// ============================================================================
// TreeNode Component
// ============================================================================

interface TreeNodeItemProps {
  node: TreeNode;
  depth: number;
  selectedPath: string;
  onToggle: (path: string) => void;
  onNavigate: (path: string) => void;
}

function TreeNodeItem({ node, depth, selectedPath, onToggle, onNavigate }: TreeNodeItemProps) {
  const isSelected = selectedPath === node.path || selectedPath.startsWith(`${node.path}/`);

  const handleClick = useCallback(() => {
    if (node.isDirectory) {
      onToggle(node.path);
      onNavigate(node.path);
    } else {
      onNavigate(node.path);
    }
  }, [node, onToggle, onNavigate]);

  return (
    <>
      <button
        type="button"
        style={{
          ...styles.nodeRow,
          paddingLeft: `${8 + depth * 14}px`,
          backgroundColor: isSelected ? `${theme.violet}22` : 'transparent',
          color: isSelected ? theme.text : theme.textDim,
          borderLeft: isSelected ? `2px solid ${theme.violet}` : '2px solid transparent',
        }}
        onClick={handleClick}
        onMouseEnter={(e) => {
          if (!isSelected) {
            e.currentTarget.style.backgroundColor = `${theme.bgCardHover}`;
            e.currentTarget.style.color = theme.text;
          }
        }}
        onMouseLeave={(e) => {
          if (!isSelected) {
            e.currentTarget.style.backgroundColor = 'transparent';
            e.currentTarget.style.color = theme.textDim;
          }
        }}
        title={node.path}
      >
        {node.isDirectory && (
          <span style={styles.chevron}>{node.loading ? '\u22ef' : node.expanded ? '\u25be' : '\u25b8'}</span>
        )}
        {!node.isDirectory && <span style={styles.chevron} />}
        <span style={styles.icon}>
          {node.isDirectory ? (node.expanded ? '\ud83d\udcc2' : '\ud83d\udcc1') : '\ud83d\udcc4'}
        </span>
        <span style={styles.label}>{node.name}</span>
      </button>

      {node.isDirectory && node.expanded && node.children && (
        <>
          {node.children.map((child) => (
            <TreeNodeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onToggle={onToggle}
              onNavigate={onNavigate}
            />
          ))}
          {node.children.length === 0 && !node.loading && (
            <div
              style={{
                paddingLeft: `${8 + (depth + 1) * 14}px`,
                paddingTop: '2px',
                paddingBottom: '2px',
                fontSize: '11px',
                color: theme.textMuted,
                fontFamily: theme.fontFamily,
                fontStyle: 'italic',
              }}
            >
              empty
            </div>
          )}
        </>
      )}
    </>
  );
}

// ============================================================================
// FileTree (Main Export)
// ============================================================================

export function FileTree({ rootPath, selectedPath, onNavigate }: FileTreeProps) {
  const { request } = useNats();
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [childrenMap, setChildrenMap] = useState<Map<string, TreeNode[]>>(new Map());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());

  // Load the root contents
  useEffect(() => {
    let cancelled = false;

    async function loadRoot() {
      try {
        const result = await request<FsEntry[] | { error: string }>(GENIE_SUBJECTS.fs.list(ORG_ID), { path: rootPath });

        if (cancelled) return;

        if (!Array.isArray(result)) return;

        const rootNodes: TreeNode[] = result.map((e) => ({
          name: e.name,
          path: e.path,
          isDirectory: e.isDirectory,
          expanded: false,
          children: e.isDirectory ? undefined : [],
        }));

        // Sort: dirs first, then alphabetical
        rootNodes.sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });

        setNodes(rootNodes);
      } catch {
        // Ignore load errors for tree
      }
    }

    loadRoot();
    return () => {
      cancelled = true;
    };
  }, [rootPath, request]);

  // Load children for a directory
  const loadChildren = useCallback(
    async (dirPath: string) => {
      if (loadingPaths.has(dirPath)) return;

      setLoadingPaths((prev) => new Set([...prev, dirPath]));

      try {
        const result = await request<FsEntry[] | { error: string }>(GENIE_SUBJECTS.fs.list(ORG_ID), { path: dirPath });

        if (!Array.isArray(result)) {
          setChildrenMap((prev) => new Map([...prev, [dirPath, []]]));
          return;
        }

        const children: TreeNode[] = result.map((e) => ({
          name: e.name,
          path: e.path,
          isDirectory: e.isDirectory,
          expanded: false,
        }));

        children.sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });

        setChildrenMap((prev) => new Map([...prev, [dirPath, children]]));
      } catch {
        setChildrenMap((prev) => new Map([...prev, [dirPath, []]]));
      } finally {
        setLoadingPaths((prev) => {
          const next = new Set(prev);
          next.delete(dirPath);
          return next;
        });
      }
    },
    [loadingPaths, request],
  );

  // Toggle expand/collapse
  const handleToggle = useCallback(
    (path: string) => {
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          // Load children if not yet loaded
          if (!childrenMap.has(path)) {
            loadChildren(path);
          }
        }
        return next;
      });
    },
    [childrenMap, loadChildren],
  );

  // Build tree nodes with expansion state and children merged in
  function buildDisplayNodes(baseNodes: TreeNode[]): TreeNode[] {
    return baseNodes.map((node) => {
      if (!node.isDirectory) return node;

      const isExpanded = expandedPaths.has(node.path);
      const isLoading = loadingPaths.has(node.path);
      const children = childrenMap.get(node.path);

      return {
        ...node,
        expanded: isExpanded,
        loading: isLoading,
        children: isExpanded ? (children ? buildDisplayNodes(children) : undefined) : undefined,
      };
    });
  }

  const displayNodes = buildDisplayNodes(nodes);

  return (
    <div style={styles.container}>
      <div style={styles.header}>Brain Files</div>
      <div style={styles.treeRoot}>
        {displayNodes.map((node) => (
          <TreeNodeItem
            key={node.path}
            node={node}
            depth={0}
            selectedPath={selectedPath}
            onToggle={handleToggle}
            onNavigate={onNavigate}
          />
        ))}
        {displayNodes.length === 0 && (
          <div
            style={{
              padding: '16px',
              fontSize: '12px',
              color: theme.textMuted,
              fontFamily: theme.fontFamily,
              textAlign: 'center',
            }}
          >
            Loading...
          </div>
        )}
      </div>
    </div>
  );
}
