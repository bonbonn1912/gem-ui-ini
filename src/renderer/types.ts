import type {
  AgentEvent as ContractAgentEvent,
  AppCapabilities as ContractAppCapabilities,
  AppSession as ContractAppSession,
  Attachment as ContractAttachment,
  ContextAttachment as ContractContextAttachment,
  ContextAttachmentList as ContractContextAttachmentList,
  GemUiDesktopApi as ContractGemUiDesktopApi,
  GitFileChange as ContractGitFileChange,
  GitDiffLine as ContractGitDiffLine,
  GitFileDiff as ContractGitFileDiff,
  GitProjectStatus as ContractGitProjectStatus,
  GitRepositorySummary as ContractGitRepositorySummary,
  GitLabAccessMode as ContractGitLabAccessMode,
  GitLabUserSummary as ContractGitLabUserSummary,
  GitLabConnectionSummary as ContractGitLabConnectionSummary,
  GitLabRepositoryBinding as ContractGitLabRepositoryBinding,
  GitLabRepositoryCandidate as ContractGitLabRepositoryCandidate,
  GitLabMergeRequestSummary as ContractGitLabMergeRequestSummary,
  GitLabLineRange as ContractGitLabLineRange,
  GitLabDiffPosition as ContractGitLabDiffPosition,
  GitLabDiscussionNote as ContractGitLabDiscussionNote,
  GitLabDiscussion as ContractGitLabDiscussion,
  GitLabReviewState as ContractGitLabReviewState,
  ExternalPromptContextRef as ContractExternalPromptContextRef,
  ExternalPromptContextSnapshot as ContractExternalPromptContextSnapshot,
  PreparedExternalContext as ContractPreparedExternalContext,
  IntegrationDescriptor as ContractIntegrationDescriptor,
  ProjectIntegrationStatus as ContractProjectIntegrationStatus,
  PermissionOption as ContractPermissionOption,
  ProjectRoot as ContractProjectRoot,
  ProjectRootCandidate as ContractProjectRootCandidate,
  ProjectApprovalPolicy as ContractProjectApprovalPolicy,
  ProjectWithRoots,
  StreamEnvelope as ContractStreamEnvelope,
  TokenCounters as ContractTokenCounters,
  UsageSnapshot as ContractUsageSnapshot,
} from "../shared/contracts";

export type ExternalPromptContextRef = ContractExternalPromptContextRef;
export type ExternalPromptContextSnapshot = ContractExternalPromptContextSnapshot;
export type AppCapabilities = ContractAppCapabilities;
export type AppProject = ProjectWithRoots;
export type ProjectRoot = ContractProjectRoot;
export type ProjectRootCandidate = ContractProjectRootCandidate;
export type ProjectApprovalPolicy = ContractProjectApprovalPolicy;
export type Attachment = ContractAttachment;
export type ContextAttachment = ContractContextAttachment;
export type ContextAttachmentList = ContractContextAttachmentList;
export type PermissionOption = ContractPermissionOption;
export type AgentEvent = ContractAgentEvent;
export type StreamEnvelope = ContractStreamEnvelope;
export type UsageSnapshot = ContractUsageSnapshot;
export type TokenCounters = ContractTokenCounters;
export type GitFileChange = ContractGitFileChange;
export type GitDiffLine = ContractGitDiffLine;
export type GitFileDiff = ContractGitFileDiff;
export type GitProjectStatus = ContractGitProjectStatus;
export type GitRepositorySummary = ContractGitRepositorySummary;
export type GitLabAccessMode = ContractGitLabAccessMode;
export type GitLabUserSummary = ContractGitLabUserSummary;
export type GitLabConnectionSummary = ContractGitLabConnectionSummary;
export type GitLabRepositoryBinding = ContractGitLabRepositoryBinding;
export type GitLabRepositoryCandidate = ContractGitLabRepositoryCandidate;
export type GitLabMergeRequestSummary = ContractGitLabMergeRequestSummary;
export type GitLabLineRange = ContractGitLabLineRange;
export type GitLabDiffPosition = ContractGitLabDiffPosition;
export type GitLabDiscussionNote = ContractGitLabDiscussionNote;
export type GitLabDiscussion = ContractGitLabDiscussion;
export type GitLabReviewState = ContractGitLabReviewState;
export type PreparedExternalContext = ContractPreparedExternalContext;
export type IntegrationDescriptor = ContractIntegrationDescriptor;
export type ProjectIntegrationStatus = ContractProjectIntegrationStatus;

export type SessionStatus = ContractAppSession["status"] | "queued";

/**
 * One choice in a session picker. Structurally the contract's SessionOption;
 * the local name stays because the header talks about modes.
 */
export interface SessionMode {
  id: string;
  name: string;
  description?: string;
}

/**
 * `availableModels` / `availableModes` now come from the contract: the main
 * process caches the last lists the agent reported, so the pickers are filled
 * before any stream event arrives.
 */
export type AppSession = Omit<ContractAppSession, "status"> & {
  status: SessionStatus;
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
