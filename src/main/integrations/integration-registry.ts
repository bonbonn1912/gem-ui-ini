import type {
  IntegrationDescriptor,
  IntegrationKind,
  ProjectIntegrationStatus,
} from "../../shared/contracts";
import type { GitLabRepository, JiraRepository } from "../storage";

export class IntegrationRegistry {
  readonly #gitlabRepository: GitLabRepository;
  readonly #jiraRepository: JiraRepository;
  readonly #descriptors = new Map<IntegrationKind, IntegrationDescriptor>();

  constructor(gitlabRepository: GitLabRepository, jiraRepository: JiraRepository) {
    this.#gitlabRepository = gitlabRepository;
    this.#jiraRepository = jiraRepository;

    this.register({
      kind: "gitlab",
      name: "GitLab",
      description: "Merge Requests, Review-Threads und Kommentare pro Repository verbinden",
      icon: "gitlab",
      scope: "repository",
      defaultEnabled: false,
    });

    this.register({
      kind: "jira",
      name: "Jira",
      description: "Issues aus dem Session-Namen erkennen, anzeigen und anhängen",
      icon: "jira",
      scope: "project",
      defaultEnabled: false,
    });
  }

  register(descriptor: IntegrationDescriptor): void {
    this.#descriptors.set(descriptor.kind, descriptor);
  }

  listDescriptors(): IntegrationDescriptor[] {
    return Array.from(this.#descriptors.values());
  }

  getDescriptor(kind: IntegrationKind): IntegrationDescriptor | undefined {
    return this.#descriptors.get(kind);
  }

  listProjectIntegrations(projectId: string): ProjectIntegrationStatus[] {
    const statuses: ProjectIntegrationStatus[] = [];

    const gitlabDescriptor = this.#descriptors.get("gitlab");
    if (gitlabDescriptor) {
      const bindings = this.#gitlabRepository.listBindingsByProject(projectId);
      const activeBindings = bindings.filter((b) => b.enabled);
      statuses.push({
        kind: "gitlab",
        enabled: activeBindings.length > 0,
        activeBindingsCount: activeBindings.length,
        totalBindingsCount: bindings.length,
      });
    }

    const jiraDescriptor = this.#descriptors.get("jira");
    if (jiraDescriptor) {
      // Jira binds to the project as a whole, so "active" is one or nothing.
      // The total counts the saved configurations, because those are what the
      // integrations tab can offer this project.
      const active = this.#jiraRepository.getProjectIntegration(projectId);
      statuses.push({
        kind: "jira",
        enabled: active !== null,
        activeBindingsCount: active === null ? 0 : 1,
        totalBindingsCount: this.#jiraRepository.listConfigs().length,
      });
    }

    return statuses;
  }
}
