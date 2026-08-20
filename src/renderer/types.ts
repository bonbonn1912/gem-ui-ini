import type {
  AgentEvent as ContractAgentEvent,
  AppCapabilities as ContractAppCapabilities,
  AppSession as ContractAppSession,
  Attachment as ContractAttachment,
  GemUiDesktopApi as ContractGemUiDesktopApi,
  PermissionOption as ContractPermissionOption,
  ProjectRoot as ContractProjectRoot,
  ProjectRootCandidate as ContractProjectRootCandidate,
  ProjectApprovalPolicy as ContractProjectApprovalPolicy,
  ProjectWithRoots,
  StreamEnvelope as ContractStreamEnvelope,
} from "../shared/contracts";

export type AppCapabilities = ContractAppCapabilities;
export type AppProject = ProjectWithRoots;
export type ProjectRoot = ContractProjectRoot;
export type ProjectRootCandidate = ContractProjectRootCandidate;
export type ProjectApprovalPolicy = ContractProjectApprovalPolicy;
export type Attachment = ContractAttachment;
export type PermissionOption = ContractPermissionOption;
export type AgentEvent = ContractAgentEvent;
export type StreamEnvelope = ContractStreamEnvelope;

export type SessionStatus = ContractAppSession["status"] | "queued";

export interface SessionMode {
  id: string;
  name: string;
  description?: string;
}

export type AppSession = Omit<ContractAppSession, "status"> & {
  status: SessionStatus;
  /** Filled from the session.ready stream event for presentation only. */
  availableModes?: SessionMode[];
};

/**
 * The production bridge is the shared contract. The optional alias lets a
 * newer preload expose the wording used in the onboarding UI without making
 * the renderer depend on it.
 */
export type GemUiDesktopApi = ContractGemUiDesktopApi & {
  settings: ContractGemUiDesktopApi["settings"] & {
    pickGeminiBinary?: () => Promise<AppCapabilities | void>;
  };
};

export type UiError = {
  title: string;
  message: string;
  retry?: () => void;
};
