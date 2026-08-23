import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppProject, ProjectFileSearchEntry, ProjectRoot } from "../../types";

export type ExplorerNodeKey = `${string}\0${string}`;

export function makeExplorerKey(rootId: string, relativePath: string = ""): ExplorerNodeKey {
  return `${rootId}\0${relativePath}`;
}

export function parseExplorerKey(key: ExplorerNodeKey): { rootId: string; relativePath: string } {
  const [rootId, relativePath = ""] = key.split("\0");
  return { rootId, relativePath };
}

export type FlatExplorerItem = {
  key: ExplorerNodeKey;
  rootId: string;
  relativePath: string;
  displayName: string;
  kind: "root" | "directory" | "file";
  depth: number;
  entry?: ProjectFileSearchEntry;
  root?: ProjectRoot;
  expanded?: boolean;
  loading?: boolean;
  error?: string;
  hasChildren?: boolean;
};

const STORAGE_PREFIX = "geminui.explorer.expanded.";

function getStoredExpanded(projectId: string, roots: ProjectRoot[] = []): Set<ExplorerNodeKey> {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${projectId}`);
    if (raw !== null) {
      const list = JSON.parse(raw);
      return new Set<ExplorerNodeKey>(Array.isArray(list) ? list : []);
    }
  } catch {
    // Ignore
  }
  // Default: root nodes are expanded
  const defaults = new Set<ExplorerNodeKey>();
  for (const root of roots) {
    defaults.add(makeExplorerKey(root.id, ""));
  }
  return defaults;
}

function saveStoredExpanded(projectId: string, expanded: Set<ExplorerNodeKey>) {
  try {
    localStorage.setItem(
      `${STORAGE_PREFIX}${projectId}`,
      JSON.stringify(Array.from(expanded)),
    );
  } catch {
    // Ignore localStorage errors
  }
}

export function useProjectExplorer(project: AppProject | null) {
  const [expanded, setExpanded] = useState<Set<ExplorerNodeKey>>(() =>
    project ? getStoredExpanded(project.id, project.roots ?? []) : new Set(),
  );
  const [childrenMap, setChildrenMap] = useState<
    Map<ExplorerNodeKey, ProjectFileSearchEntry[] | "loading" | Error>
  >(new Map());
  const [selection, setSelection] = useState<Set<ExplorerNodeKey>>(new Set());
  const [focusedKey, setFocusedKey] = useState<ExplorerNodeKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshIndex, setRefreshIndex] = useState(0);

  const prevProjectIdRef = useRef<string | null>(project?.id ?? null);
  const prevRevisionRef = useRef<number | null>(project?.rootRevision ?? null);

  // When project or rootRevision changes, reset or re-align cache
  useEffect(() => {
    if (!project) {
      setExpanded(new Set());
      setChildrenMap(new Map());
      setSelection(new Set());
      setFocusedKey(null);
      setError(null);
      return;
    }

    const projectChanged = prevProjectIdRef.current !== project.id;
    const revisionChanged = prevRevisionRef.current !== project.rootRevision;

    prevProjectIdRef.current = project.id;
    prevRevisionRef.current = project.rootRevision;

    if (projectChanged) {
      const stored = getStoredExpanded(project.id, project.roots ?? []);
      setExpanded(stored);
      setChildrenMap(new Map());
      setSelection(new Set());
      setFocusedKey(null);
      setError(null);
    } else if (revisionChanged) {
      // Re-fetch all currently expanded nodes
      setChildrenMap(new Map());
      setError(null);
    }
  }, [project?.id, project?.rootRevision, project]);

  // Load children for a given directory
  const loadDirectory = useCallback(
    async (rootId: string, relativePath: string = ""): Promise<void> => {
      if (!project) return;
      const key = makeExplorerKey(rootId, relativePath);

      setChildrenMap((current) => {
        const next = new Map(current);
        next.set(key, "loading");
        return next;
      });

      try {
        const result = await window.gemUi.projectFiles.listDirectory({
          projectId: project.id,
          expectedRootRevision: project.rootRevision,
          rootId,
          relativePath,
        });

        setChildrenMap((current) => {
          const next = new Map(current);
          next.set(key, result.entries);
          return next;
        });
      } catch (err) {
        const errObj = err instanceof Error ? err : new Error(String(err));
        setChildrenMap((current) => {
          const next = new Map(current);
          next.set(key, errObj);
          return next;
        });
      }
    },
    [project],
  );

  // Automatically fetch top-level directories for all roots and expanded directories
  useEffect(() => {
    if (!project) return;

    const allRoots = project.roots ?? [];

    // Load root level for all roots
    for (const root of allRoots) {
      const rootKey = makeExplorerKey(root.id, "");
      const cached = childrenMap.get(rootKey);
      if (!cached) {
        void loadDirectory(root.id, "");
      }
    }

    // Load any expanded sub-directories
    for (const expKey of expanded) {
      const { rootId, relativePath } = parseExplorerKey(expKey);
      if (relativePath && !childrenMap.get(expKey)) {
        void loadDirectory(rootId, relativePath);
      }
    }
  }, [project, expanded, childrenMap, loadDirectory, refreshIndex]);

  // Toggle expanded
  const toggleExpanded = useCallback(
    (rootId: string, relativePath: string = "") => {
      if (!project) return;
      const key = makeExplorerKey(rootId, relativePath);
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
          // If not yet loaded, load it
          if (!childrenMap.get(key)) {
            void loadDirectory(rootId, relativePath);
          }
        }
        saveStoredExpanded(project.id, next);
        return next;
      });
    },
    [project, childrenMap, loadDirectory],
  );

  const expand = useCallback(
    (rootId: string, relativePath: string = "") => {
      if (!project) return;
      const key = makeExplorerKey(rootId, relativePath);
      setExpanded((current) => {
        if (current.has(key)) return current;
        const next = new Set(current);
        next.add(key);
        if (!childrenMap.get(key)) {
          void loadDirectory(rootId, relativePath);
        }
        saveStoredExpanded(project.id, next);
        return next;
      });
    },
    [project, childrenMap, loadDirectory],
  );

  const collapse = useCallback(
    (rootId: string, relativePath: string = "") => {
      if (!project) return;
      const key = makeExplorerKey(rootId, relativePath);
      setExpanded((current) => {
        if (!current.has(key)) return current;
        const next = new Set(current);
        next.delete(key);
        saveStoredExpanded(project.id, next);
        return next;
      });
    },
    [project],
  );

  // Manual refresh
  const refresh = useCallback(() => {
    setChildrenMap(new Map());
    setError(null);
    setRefreshIndex((c) => c + 1);
  }, []);

  // Compute flattened list of visible items
  const visibleItems = useMemo<FlatExplorerItem[]>(() => {
    if (!project) return [];

    const roots = project.roots ?? [];
    const items: FlatExplorerItem[] = [];

    // If multiple roots, show root nodes at depth 0
    const showRootHeaders = roots.length > 1;

    for (const root of roots) {
      const rootKey = makeExplorerKey(root.id, "");
      const isRootExpanded = !showRootHeaders || expanded.has(rootKey);
      const rootChildren = childrenMap.get(rootKey);

      if (showRootHeaders) {
        items.push({
          key: rootKey,
          rootId: root.id,
          relativePath: "",
          displayName: root.label || root.path.split(/[\\/]/).at(-1) || "Projektordner",
          kind: "root",
          depth: 0,
          root,
          expanded: isRootExpanded,
          loading: rootChildren === "loading",
          error: rootChildren instanceof Error ? rootChildren.message : undefined,
          hasChildren: true,
        });
      }

      if (isRootExpanded) {
        const baseDepth = showRootHeaders ? 1 : 0;

        const appendEntries = (
          parentId: string,
          parentRelativePath: string,
          depth: number,
        ) => {
          const parentKey = makeExplorerKey(parentId, parentRelativePath);
          const state = childrenMap.get(parentKey);

          if (state === "loading") {
            return;
          }
          if (state instanceof Error || !Array.isArray(state)) {
            return;
          }

          for (const entry of state) {
            const entryKey = makeExplorerKey(entry.rootId, entry.relativePath);
            const isDir = entry.kind === "directory";
            const isDirExpanded = isDir && expanded.has(entryKey);
            const entryChildren = isDir ? childrenMap.get(entryKey) : undefined;

            items.push({
              key: entryKey,
              rootId: entry.rootId,
              relativePath: entry.relativePath,
              displayName: entry.displayName,
              kind: entry.kind,
              depth,
              entry,
              expanded: isDirExpanded,
              loading: entryChildren === "loading",
              error: entryChildren instanceof Error ? entryChildren.message : undefined,
              hasChildren: isDir,
            });

            if (isDir && isDirExpanded) {
              appendEntries(entry.rootId, entry.relativePath, depth + 1);
            }
          }
        };

        appendEntries(root.id, "", baseDepth);
      }
    }

    return items;
  }, [project, expanded, childrenMap]);

  // Lookup map for fast search
  const visibleItemMap = useMemo(() => {
    const map = new Map<ExplorerNodeKey, FlatExplorerItem>();
    for (const item of visibleItems) {
      map.set(item.key, item);
    }
    return map;
  }, [visibleItems]);

  // Selection handlers
  const selectSingle = useCallback((key: ExplorerNodeKey) => {
    setSelection(new Set([key]));
    setFocusedKey(key);
  }, []);

  const toggleSelection = useCallback(
    (key: ExplorerNodeKey, isMulti: boolean = false, isRange: boolean = false) => {
      if (isRange && focusedKey) {
        // Range selection between focusedKey and key
        const fromIdx = visibleItems.findIndex((i) => i.key === focusedKey);
        const toIdx = visibleItems.findIndex((i) => i.key === key);
        if (fromIdx !== -1 && toIdx !== -1) {
          const start = Math.min(fromIdx, toIdx);
          const end = Math.max(fromIdx, toIdx);
          const rangeKeys = visibleItems.slice(start, end + 1).map((i) => i.key);
          setSelection((current) => {
            const next = isMulti ? new Set(current) : new Set<ExplorerNodeKey>();
            for (const k of rangeKeys) next.add(k);
            return next;
          });
          setFocusedKey(key);
          return;
        }
      }

      if (isMulti) {
        setSelection((current) => {
          const next = new Set(current);
          if (next.has(key)) {
            next.delete(key);
          } else {
            next.add(key);
          }
          return next;
        });
        setFocusedKey(key);
        return;
      }

      // Default single select
      setSelection(new Set([key]));
      setFocusedKey(key);
    },
    [focusedKey, visibleItems],
  );

  const clearSelection = useCallback(() => {
    setSelection(new Set());
  }, []);

  // Return full ProjectFileSearchEntry objects for selected items
  const getSelectedEntries = useCallback((): ProjectFileSearchEntry[] => {
    const result: ProjectFileSearchEntry[] = [];
    for (const key of selection) {
      const item = visibleItemMap.get(key);
      if (item?.entry) {
        result.push(item.entry);
      } else if (item?.kind === "root" && item.root) {
        // Root folder reference
        result.push({
          rootId: item.root.id,
          rootLabel: item.root.label || "Projekt",
          relativePath: "",
          displayName: item.displayName,
          kind: "directory",
          size: 0,
          childCount: 0,
          contextEligible: true,
          contextUnavailableReason: null,
        });
      }
    }
    return result;
  }, [selection, visibleItemMap]);

  return {
    expanded,
    childrenMap,
    selection,
    focusedKey,
    setFocusedKey,
    visibleItems,
    visibleItemMap,
    toggleExpanded,
    expand,
    collapse,
    selectSingle,
    toggleSelection,
    clearSelection,
    getSelectedEntries,
    refresh,
    error,
  };
}
