import React from "react";
import { Icon } from "../../components/Icon";
import type { AppProject, ProjectFileSearchEntry } from "../../types";
import { ExplorerTree } from "./ExplorerTree";
import { useProjectExplorer } from "./useProjectExplorer";

type ExplorerPanelProps = {
  open?: boolean;
  project: AppProject | null;
  onClose: () => void;
  onAddProjectFileReferences?: (entries: ProjectFileSearchEntry[]) => void;
  onOpenFile?: (entry: ProjectFileSearchEntry) => void;
};

export function ExplorerPanel({
  open = true,
  project,
  onClose,
  onAddProjectFileReferences,
  onOpenFile,
}: ExplorerPanelProps) {
  const explorer = useProjectExplorer(project);

  const selectedCount = explorer.selection.size;
  const selectedEntries = explorer.getSelectedEntries();

  const handleAddSelection = () => {
    if (onAddProjectFileReferences && selectedEntries.length > 0) {
      onAddProjectFileReferences(selectedEntries);
    }
  };

  return (
    <aside
      className={`explorer-panel ${open ? "explorer-panel--open" : ""}`}
      aria-label="Projekt-Explorer"
      aria-hidden={!open}
    >
      <header className="explorer-panel-header">
        <div className="explorer-panel-title-area">
          <span className="explorer-panel-icon">
            <Icon name="folder" size={17} />
          </span>
          <div className="explorer-panel-titles">
            <strong>Explorer</strong>
            <span>{project?.name || "Projektbaum"}</span>
          </div>
        </div>

        <div className="explorer-panel-header-actions">
          <button
            className="icon-button"
            type="button"
            onClick={explorer.refresh}
            aria-label="Projekt-Explorer aktualisieren"
            title="Dateibaum neu laden"
          >
            <Icon name="refresh" size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Explorer schließen"
            title="Explorer schließen"
          >
            <Icon name="x" size={16} />
          </button>
        </div>
      </header>

      <div className="explorer-panel-body">
        {explorer.error && (
          <div className="explorer-error" role="alert">
            <Icon name="warning" size={17} />
            <p>{explorer.error}</p>
            <button type="button" onClick={explorer.refresh}>
              Erneut versuchen
            </button>
          </div>
        )}

        {!project ? (
          <div className="explorer-empty">
            <Icon name="folder" size={24} />
            <p>Kein aktives Projekt ausgewählt</p>
          </div>
        ) : (
          <ExplorerTree
            explorer={explorer}
            onAddFilesToContext={onAddProjectFileReferences}
            onOpenFile={onOpenFile}
          />
        )}
      </div>

      {selectedCount > 0 && onAddProjectFileReferences && (
        <footer className="explorer-panel-footer">
          <div className="explorer-selection-summary">
            <span>
              {selectedCount} {selectedCount === 1 ? "Eintrag" : "Einträge"} ausgewählt
            </span>
            <button
              type="button"
              className="explorer-clear-selection-btn"
              onClick={explorer.clearSelection}
            >
              Abwählen
            </button>
          </div>
          <button
            type="button"
            className="primary-button explorer-add-to-chat-btn"
            onClick={handleAddSelection}
            title="Ausgewählte Dateien und Ordner als Kontext an die nächste Nachricht anhängen"
          >
            <Icon name="plus" size={14} />
            <span>In Chat übernehmen</span>
          </button>
        </footer>
      )}
    </aside>
  );
}
