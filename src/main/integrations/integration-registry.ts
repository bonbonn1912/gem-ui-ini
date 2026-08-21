import type {
  IntegrationDescriptor,
  IntegrationKind,
  ProjectIntegrationStatus,
} from "../../shared/contracts";
import type { GitLabRepository } from "../storage";

export class IntegrationRegistry {
  readonly #gitlabRepository: GitLabRepository;
  readonly #descriptors = new Map<IntegrationKind, IntegrationDescriptor>();

  constructor(gitlabRepository: GitLabRepository) {
    this.#gitlabRepository = gitlabRepository;

    this.register({
      kind: "gitlab",
      name: "GitLab",
      description: "Merge Requests, Review-Threads und Kommentare pro Repository verbinden",
      icon: "gitlab",
      scope: "repository",
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

    return statuses;
  }
}
