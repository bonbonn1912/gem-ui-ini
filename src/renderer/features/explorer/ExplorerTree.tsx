import React, { useCallback, useRef, type CSSProperties, type DragEvent, type KeyboardEvent } from "react";
import { Icon } from "../../components/Icon";
import type { ProjectFileSearchEntry } from "../../types";
import {
  makeExplorerKey,
  type FlatExplorerItem,
  type useProjectExplorer,
} from "./useProjectExplorer";

type ExplorerTreeProps = {
  explorer: ReturnType<typeof useProjectExplorer>;
  onAddFilesToContext?: (entries: ProjectFileSearchEntry[]) => void;
  onOpenFile?: (entry: ProjectFileSearchEntry) => void;
};

export function ExplorerTree({
  explorer,
  onAddFilesToContext,
  onOpenFile,
}: ExplorerTreeProps) {
  const {
    visibleItems,
    visibleItemMap,
    selection,
    focusedKey,
    setFocusedKey,
    toggleExpanded,
    expand,
    collapse,
    selectSingle,
    toggleSelection,
    getSelectedEntries,
  } = explorer;

  const treeRef = useRef<HTMLDivElement>(null);

  // Drag start handler
  const handleDragStart = useCallback(
    (event: DragEvent<HTMLDivElement>, item: FlatExplorerItem) => {
      // If dragging an item not currently in selection, select only this item
      let activeEntries: ProjectFileSearchEntry[] = [];
      if (!selection.has(item.key)) {
        selectSingle(item.key);
        if (item.entry) {
          activeEntries = [item.entry];
        } else if (item.kind === "root" && item.root) {
          activeEntries = [
            {
              rootId: item.root.id,
              rootLabel: item.root.label || "Projekt",
              relativePath: "",
              displayName: item.displayName,
              kind: "directory",
              size: 0,
              childCount: 0,
              contextEligible: true,
              contextUnavailableReason: null,
            },
          ];
        }
      } else {
        activeEntries = getSelectedEntries();
      }

      if (activeEntries.length === 0) return;

      event.dataTransfer.setData(
        "application/x-geminui-project-file-refs",
        JSON.stringify(activeEntries),
      );

      const plainText = activeEntries
        .map(
          (entry) =>
            `@${entry.relativePath ? entry.relativePath : entry.displayName}${entry.kind === "directory" ? "/" : ""}`,
        )
        .join(" ");

      event.dataTransfer.setData("text/plain", plainText);
      event.dataTransfer.effectAllowed = "copy";
    },
    [selection, selectSingle, getSelectedEntries],
  );

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (visibleItems.length === 0) return;

      const currentIndex = visibleItems.findIndex(
        (item) => item.key === focusedKey,
      );
      const currentItem =
        currentIndex >= 0 ? visibleItems[currentIndex] : visibleItems[0];

      switch (event.key) {
        case "ArrowDown": {
          event.preventDefault();
          const nextIndex = Math.min(
            visibleItems.length - 1,
            (currentIndex >= 0 ? currentIndex : -1) + 1,
          );
          const nextItem = visibleItems[nextIndex];
          if (nextItem) {
            setFocusedKey(nextItem.key);
            if (!event.shiftKey) {
              selectSingle(nextItem.key);
            } else {
              toggleSelection(nextItem.key, false, true);
            }
          }
          break;
        }

        case "ArrowUp": {
          event.preventDefault();
          const prevIndex = Math.max(0, currentIndex - 1);
          const prevItem = visibleItems[prevIndex];
          if (prevItem) {
            setFocusedKey(prevItem.key);
            if (!event.shiftKey) {
              selectSingle(prevItem.key);
            } else {
              toggleSelection(prevItem.key, false, true);
            }
          }
          break;
        }

        case "ArrowRight": {
          event.preventDefault();
          if (!currentItem) break;
          if (currentItem.kind === "root" || currentItem.kind === "directory") {
            if (!currentItem.expanded) {
              expand(currentItem.rootId, currentItem.relativePath);
            } else if (currentIndex + 1 < visibleItems.length) {
              const child = visibleItems[currentIndex + 1];
              if (child && child.depth > currentItem.depth) {
                setFocusedKey(child.key);
                selectSingle(child.key);
              }
            }
          }
          break;
        }

        case "ArrowLeft": {
          event.preventDefault();
          if (!currentItem) break;
          if (
            (currentItem.kind === "root" || currentItem.kind === "directory") &&
            currentItem.expanded
          ) {
            collapse(currentItem.rootId, currentItem.relativePath);
          } else if (currentItem.depth > 0) {
            // Find parent item
            for (let i = currentIndex - 1; i >= 0; i--) {
              const candidate = visibleItems[i]!;
              if (candidate.depth < currentItem.depth) {
                setFocusedKey(candidate.key);
                selectSingle(candidate.key);
                break;
              }
            }
          }
          break;
        }

        case " ": {
          event.preventDefault();
          if (currentItem) {
            toggleSelection(currentItem.key, true);
          }
          break;
        }

        case "Enter": {
          event.preventDefault();
          if (currentItem) {
            if (currentItem.kind === "root" || currentItem.kind === "directory") {
              toggleExpanded(currentItem.rootId, currentItem.relativePath);
            } else if (onOpenFile && currentItem.entry) {
              onOpenFile(currentItem.entry);
            } else if (onAddFilesToContext) {
              if (currentItem.entry) {
                onAddFilesToContext([currentItem.entry]);
              }
            }
          }
          break;
        }
      }
    },
    [
      visibleItems,
      focusedKey,
      setFocusedKey,
      toggleSelection,
      selectSingle,
      expand,
      collapse,
      toggleExpanded,
      onOpenFile,
      onAddFilesToContext,
      getSelectedEntries,
    ],
  );

  return (
    <div
      ref={treeRef}
      className="explorer-tree"
      role="tree"
      aria-label="Dateibaum"
      aria-multiselectable="true"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {visibleItems.map((item) => {
        const isSelected = selection.has(item.key);
        const isFocused = focusedKey === item.key;
        const isFolder = item.kind === "root" || item.kind === "directory";
        const isEligible = item.entry ? item.entry.contextEligible : true;

        return (
          <div
            key={item.key}
            className={`explorer-tree-item ${
              isSelected ? "explorer-tree-item--selected" : ""
            } ${isFocused ? "explorer-tree-item--focused" : ""} ${
              !isEligible ? "explorer-tree-item--ineligible" : ""
            }`}
            role="treeitem"
            aria-level={item.depth + 1}
            aria-selected={isSelected}
            aria-expanded={isFolder ? Boolean(item.expanded) : undefined}
            aria-label={item.displayName}
            style={{ "--depth": item.depth } as CSSProperties}
            draggable={true}
            onDragStart={(e) => handleDragStart(e, item)}
            onClick={(e) => {
              if (e.shiftKey) {
                toggleSelection(item.key, false, true);
              } else if (e.metaKey || e.ctrlKey) {
                toggleSelection(item.key, true);
              } else {
                selectSingle(item.key);
                if (isFolder) {
                  toggleExpanded(item.rootId, item.relativePath);
                } else if (onOpenFile && item.entry) {
                  onOpenFile(item.entry);
                }
              }
            }}
            onDoubleClick={() => {
              if (isFolder) {
                toggleExpanded(item.rootId, item.relativePath);
              } else if (onOpenFile && item.entry) {
                onOpenFile(item.entry);
              }
            }}
          >
            <div
              className="explorer-indent-guide"
              style={{ width: `${item.depth * 16}px` }}
              aria-hidden="true"
            />

            {/* Chevron toggle button for folders */}
            <span
              className={`explorer-chevron ${
                item.expanded ? "explorer-chevron--expanded" : ""
              } ${!isFolder ? "explorer-chevron--hidden" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                if (isFolder) {
                  toggleExpanded(item.rootId, item.relativePath);
                }
              }}
              title={
                isFolder
                  ? item.expanded
                    ? "Ordner einklappen"
                    : "Ordner aufklappen"
                  : undefined
              }
            >
              {item.loading ? (
                <span className="mini-spinner" />
              ) : isFolder ? (
                <Icon name="chevron-right" size={14} />
              ) : null}
            </span>

            {/* Icon */}
            <span
              className={`explorer-item-icon ${
                isFolder ? "explorer-item-icon--folder" : "explorer-item-icon--file"
              }`}
            >
              <Icon
                name={isFolder ? (item.expanded ? "folder" : "folder") : "file-text"}
                size={15}
              />
            </span>

            {/* Display Name */}
            <span className="explorer-item-label" title={item.relativePath || item.displayName}>
              {item.displayName}
            </span>

            {/* Ineligible tag or badge */}
            {!isEligible && item.entry?.contextUnavailableReason && (
              <span
                className="explorer-item-ineligible-badge"
                title={item.entry.contextUnavailableReason}
              >
                nicht lesbar
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
