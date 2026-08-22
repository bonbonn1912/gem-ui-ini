import { Icon, type IconName } from "../../components/Icon";
import { For, type Accessor } from "solid-js";

/**
 * The right-hand panels used to sit as six labelled buttons in the chat header,
 * which grew unreadable as panels were added. They live in a rail instead: one
 * fixed column at the edge of the workspace where a new panel costs one icon
 * rather than another word in an already full line.
 */
export type PanelRailItem = {
  id: string;
  icon: IconName;
  /** Shown in the tooltip. */
  label: string;
  /**
   * The name used in the accessible label, which is not always the visible one:
   * the tooltip says "GitLab" where the screen reader says "GitLab Review".
   */
  name?: string;
  /** Extra detail for the accessible label, e.g. "2 Anhänge, 1 im Kontext". */
  detail?: string;
  badge?: number;
  /** A count worth showing even when the panel is closed, e.g. included attachments. */
  subBadge?: number;
};

type PanelRailProps = {
  items: Accessor<PanelRailItem[]>;
  activeId: Accessor<string>;
  onToggle: (id: string) => void;
};

function cap(value: number, limit: number): string {
  return value > limit ? `${limit}+` : String(value);
}

export function PanelRail(props: PanelRailProps) {
  return (
    <nav class="panel-rail" aria-label="Panels" data-tauri-drag-region>
      <For each={props.items()}>{(item) => {
        const open = props.activeId() === item.id;
        const name = item.name ?? item.label;
        return (
          <button

            class={`panel-rail-button ${open ? "panel-rail-button--active" : ""}`}
            type="button"
            aria-pressed={open}
            aria-label={`${name} ${open ? "schließen" : "öffnen"}${item.detail ? `, ${item.detail}` : ""}`}
            title={item.label}
            onClick={() => props.onToggle(item.id)}
          >
            <Icon name={item.icon} size={18} />
            <span class="panel-rail-label" aria-hidden="true">{item.label}</span>
            {Boolean(item.badge) && <i>{cap(item.badge!, 99)}</i>}
            {Boolean(item.subBadge) && <em>{cap(item.subBadge!, 99)}</em>}
          </button>
        );
      }}</For>
    </nav>
  );
}
