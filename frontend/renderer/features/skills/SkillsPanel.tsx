import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import { Icon } from "../../components/Icon";
import type { GeminiSkill, GeminiSkillList } from "../../types";

type SkillsPanelProps = {
  projectId: string | null;
  onClose: () => void;
};

const SEARCH_THRESHOLD = 8;

function scopeLabel(skill: GeminiSkill): string {
  switch (skill.scope) {
    case "project":
      return skill.scopeLabel ? `Projekt · ${skill.scopeLabel}` : "Projekt";
    case "builtin":
      return "Integriert";
    case "system":
      return "System";
    default:
      return "Nutzer";
  }
}

function messageFrom(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Die Skills konnten nicht gelesen werden.";
}

export function SkillsPanel({ projectId, onClose }: SkillsPanelProps) {
  const [list, setList] = createSignal<GeminiSkillList | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [query, setQuery] = createSignal("");
  const [reloadToken, setReloadToken] = createSignal(0);

  createEffect(() => {
    let current = true;
    setLoading(true);
    window.gemUi.agentExtensions
      .listSkills({ projectId })
      .then((next) => {
        if (!current) return;
        setList(next);
        setError(null);
      })
      .catch((cause) => {
        if (!current) return;
        setList(null);
        setError(messageFrom(cause));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    onCleanup(() => {
      current = false;
    });
  });

  const refresh = () => setReloadToken((token) => token + 1);

  const skills = list()?.skills ?? [];
  const filtered = createMemo(() => {
    const needle = query().trim().toLocaleLowerCase("de");
    if (!needle) return skills;
    return skills.filter((skill) =>
      `${skill.name} ${skill.description} ${skill.path}`
        .toLocaleLowerCase("de")
        .includes(needle),
    );
  });

  const subtitle = loading() && !list()
    ? "Skills werden gelesen …"
    : skills.length === 1
      ? "1 Skill"
      : `${skills.length} Skills`;

  return (
    <aside class="extension-panel skills-panel" aria-label="Gemini-Skills">
      <header class="extension-panel-header skills-panel-header" data-tauri-drag-region>
        <div>
          <span class="extension-panel-icon skills-panel-icon">
            <Icon name="skill" size={17} />
          </span>
          <div>
            <strong>Skills</strong>
            <span>{subtitle}</span>
          </div>
        </div>
        <button
          class="icon-button"
          type="button"
          onClick={refresh}
          disabled={loading()}
          title="Skills aktualisieren"
          aria-label="Skills aktualisieren"
        >
          {loading() ? <span class="mini-spinner" /> : <Icon name="refresh" size={16} />}
        </button>
        <button
          class="icon-button"
          type="button"
          onClick={onClose}
          title="Panel schließen"
          aria-label="Skills schließen"
        >
          <Icon name="x" size={16} />
        </button>
      </header>

      <div class="extension-panel-body">
        {skills.length > SEARCH_THRESHOLD && (
          <div class="extension-search">
            <Icon name="search" size={14} />
            <input
              type="search"
              value={query()}
              placeholder="Skills durchsuchen"
              aria-label="Skills durchsuchen"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        )}

        <div class="extension-panel-scroll">
          {error() && (
            <div class="extension-error" role="alert">
              <Icon name="warning" size={17} />
              <p>
                <strong>Skills konnten nicht gelesen werden</strong>
                <span>{error()}</span>
              </p>
              <button type="button" onClick={refresh}>Erneut</button>
            </div>
          )}

          {loading() && !list() && (
            <div class="extension-loading">
              <span class="mini-spinner" /> Skills werden gelesen …
            </div>
          )}

          {list() && skills.length === 0 && !error() && (
            <div class="extension-empty">
              <span><Icon name="skill" size={20} /></span>
              <strong>Keine Skills installiert</strong>
              <p>
                Gemini CLI liest Skills aus <code>~/.gemini/skills</code> und aus
                <code>.gemini/skills</code> in den Projektordnern. Lege dort einen
                Ordner mit einer <code>SKILL.md</code> an oder installiere einen
                Skill mit <code>gemini skills install</code>.
              </p>
            </div>
          )}

          {list() && skills.length > 0 && filtered.length === 0 && (
            <div class="extension-empty">
              <span><Icon name="search" size={20} /></span>
              <strong>Kein Treffer</strong>
              <p>Für „{query().trim()}“ wurde kein Skill gefunden.</p>
            </div>
          )}

          {filtered().map((skill) => (
            <article
              class={`extension-row ${skill.enabled ? "" : "extension-row--off"}`}

            >
              <header>
                <strong title={skill.name}>{skill.name}</strong>
                <span class={`extension-badge extension-badge--${skill.scope}`}>
                  {scopeLabel(skill)}
                </span>
                {!skill.enabled && (
                  <span class="extension-badge extension-badge--off">Deaktiviert</span>
                )}
              </header>
              {skill.description && <p>{skill.description}</p>}
              <code title={skill.path}>{skill.path}</code>
            </article>
          ))}
        </div>

        {list() && list().truncated && (
          <p class="extension-footnote">
            Es wurden nicht alle gefundenen Skills übernommen.
          </p>
        )}
      </div>
    </aside>
  );
}
